# Responses Web Search Plugin

## Overview

The `responsesWebSearchPlugin` emulates OpenAI's hosted `web_search` tool on the `/openai/v1/responses` route. It rewrites the hosted tool into a plain function tool that SAP AI Core deployments accept, executes the search itself via Perplexity's sonar-pro model, and hands the client back the hosted-tool response shape it expects (`web_search_call` + a message with `url_citation` annotations).

It is the Responses-wire-format sibling of [`webSearchPlugin`](./webSearchPlugin.md), which does the equivalent job for the Anthropic Messages format. Both share the Perplexity search core in [`webSearch/searchExecutor.ts`](./webSearch/searchExecutor.ts); this plugin's request/response shaping lives in [`webSearch/responsesAdapter.ts`](./webSearch/responsesAdapter.ts), which contains all the pure Responses-format helpers.

## Where the code lives

`responsesWebSearchPlugin.ts` is a **shim**. The machinery this document describes was extracted into a hosted-tool engine that is generic over the tool being emulated, so a second hosted tool is a second descriptor rather than a second copy of the interceptor:

| Concern | File |
|---|---|
| The `res.write` interceptor, the continuation loop, the pending drain, the caps, usage accounting | [`hostedTool/engine.ts`](./hostedTool/engine.ts) |
| What a hosted tool has to implement (`HostedToolDescriptor`) | [`hostedTool/descriptor.ts`](./hostedTool/descriptor.ts) |
| Lookup by hosted `type` (request side) and function `name` (response side) | [`hostedTool/registry.ts`](./hostedTool/registry.ts) |
| Everything web-search-specific: the rewritten tool, query parsing and re-masking, the `web_search_call` and result-`message` items | [`webSearch/descriptor.ts`](./webSearch/descriptor.ts) |
| Registering `web_search` onto the engine, and the two hook rules | `responsesWebSearchPlugin.ts` |

The behaviour below is unchanged by that extraction, and deliberately so: [`test/responses-websearch-characterization.test.ts`](../../test/responses-websearch-characterization.test.ts) pins the exact bytes written to `res` and the exact continuation POST bodies, and had to stay byte-identical across it.

Names used below that moved: `hasResponsesWebSearchTool` / `transformResponsesWebSearchTool` are now the engine's `rewriteHostedTools` driving `descriptor.rewriteTool`; `findPendingResponsesSearch` is `findPendingHostedToolCall`; `isWebSearchFunctionCall` is `isHostedToolCall` (a registry lookup on the item's `name`); `MAX_PENDING_SEARCHES_PER_TURN` is `MAX_PENDING_CALLS_PER_TURN`; `installResponsesWebSearchInterceptor` is `installHostedToolInterceptor`; `replaceWebSearchCalls` is `replaceHostedToolCalls`. The pure helpers in `responsesAdapter.ts` and `continuation.ts` did not move — the descriptor composes them.

One behaviour did change with the extraction: the continuation loop groups a round's calls **per turn rather than per tool**. Every call whose function name resolves to a registered descriptor is resolved in one batch and answered by one continuation POST carrying one `function_call_output` each, and each tool's `maxCallsPerRequest()` is an independent budget. With only `web_search` registered this is indistinguishable from the previous single-cap behaviour.

## Problem Statement

OpenAI's Responses API `web_search` tool is a **hosted tool**: OpenAI's own infrastructure executes the search server-side. SAP AI Core deployments don't implement it and reject any request that references it outright:

```
The following tool is not allowed for model '<model>': web_search
```

Codex CLI attaches a `{"type": "web_search"}` tool to **every** request it sends and gives the user no way to turn it off. Without this plugin, `/openai/v1/responses` is unusable from Codex CLI whenever a deployment is behind SAP AI Core — every request fails at the tool-validation step before the model ever runs.

## Solution

The plugin implements the same two-phase interception strategy as `webSearchPlugin`, adapted to the Responses wire format's `input`/`output` item arrays instead of Anthropic's `messages`/`content` blocks.

### Phase 1: Before Handler (Request Transformation)

1. **Detect** a hosted `{"type": "web_search"}` entry in `tools` (`hasResponsesWebSearchTool`).
2. **Rewrite** it into a plain function tool the deployment accepts (`transformResponsesWebSearchTool`):
   ```json
   {
     "type": "function",
     "name": "web_search",
     "description": "Search the web for current information...",
     "parameters": {
       "type": "object",
       "properties": { "query": { "type": "string", "description": "..." } },
       "required": ["query"]
     },
     "strict": false
   }
   ```
   An empty resulting `tools` array is removed rather than sent as `[]`, since some deployments reject that.
3. **Drain pending searches.** The client replays the full conversation on every turn (Responses is `store: false` in this gateway), so a `function_call` the model emitted last turn with no matching `function_call_output` this turn is how the plugin recognizes "the model wants to search and hasn't seen results yet." `findPendingResponsesSearch` returns only the single most recent unsatisfied call, so the before handler calls it in a loop — execute, append, repeat — until none remain. This matters because Codex CLI defaults `parallel_tool_calls` to true: the model can emit two or more `web_search` calls in one turn, and every one of them needs a `function_call_output` or the deployment rejects the turn as malformed. The loop is capped at 4 iterations (`MAX_PENDING_SEARCHES_PER_TURN`) purely to guarantee termination; hitting the cap logs a warning.

### Phase 2: After Handler (Response Transformation) — the continuation loop

1. **Detect** every `function_call` item named `web_search` in the deployment's `output` array (`isWebSearchFunctionCall`) — not just the first: Codex CLI defaults `parallel_tool_calls` to true, so a single turn can carry more than one.
2. **Execute** the search via Perplexity for each one.
3. **Continue the turn.** If the request carries an upstream call context (`req.__responsesUpstream`, stashed by `responsesController` before the first deployment call), the plugin POSTs the conversation straight back to the SAME deployment endpoint: the original input, everything the model produced this turn (reasoning items, other tool calls, etc.), and one `function_call_output` per search just run. Opaque, non-text fields on those items — `id`, `call_id`, and a `reasoning` item's `encrypted_content` most notably — are carried through byte-identical; the text-bearing fields on the same items (`content[].text`, `arguments`, `summary[].text`, and so on) ARE rewritten first — see **Masking** below. The deployment's reply to *that* becomes the new "current" response, and the loop repeats if it, too, contains `web_search` calls — bounded by `configService.getWebSearchMaxSearches()`. This is what lets the model actually read the results and write a real answer, rather than the turn ending with a canned summary the model never saw.
4. **Fall back** to a synthetic `web_search_call` + `message` pair — the pre-continuation behavior — only when a continuation genuinely cannot happen: no upstream context was stashed (the plugin was invoked directly, outside a real request), the cap didn't leave enough budget to answer every parallel call in a batch, or the continuation POST itself failed. The synthetic pair is spliced in at the original call's position, so an item that preceded it (a `reasoning` item, most commonly) still precedes it in what the client sees:
   - `web_search_call` — `{ type: 'web_search_call', id, status: 'completed' | 'failed', action: { type: 'search', query } }` — `status` reports whether the SEARCH succeeded, independent of whether a continuation was attempted or how it went.
   - `message` — an assistant message whose `output_text` content carries a human-readable summary and `url_citation` annotations for each result

A search failure never surfaces as a plugin error, in either the continuation or the fallback path: the deployment (or the synthetic message) is handed empty results and a `status: 'failed'` marker, so the client still receives a well-formed turn instead of the whole response failing. Nor does any other failure inside this handler: a raw `web_search` `function_call` reaching the client is the one outcome this plugin exists to prevent, so even an unexpected exception is caught and turned into failed-placeholder pairs rather than passed through.

**Masking.** `pseudonymizationPlugin` runs once, ahead of this plugin, on the deployment's FIRST response only — unmasking the model's `function_call` arguments in place before this handler ever sees them. Every deployment call this loop makes after that one is invisible to `pseudonymizationPlugin`, so the loop redoes both halves of its job itself: the conversation is re-masked (`remaskResponsesItems`, in `webSearch/queryMasking.ts`) immediately before each continuation POST, and each continuation response is unmasked (`unmaskResponsesOutput`) immediately after, before it becomes the turn's new current state. `remaskResponsesItems` is scoped, not a blind walk of every string it finds: it rewrites only the same text-bearing fields `unmaskResponsesOutput` itself unmasks — `content[].text`, `content[].refusal`, a bare string `content`, `arguments`, `output`, and `summary[].text` — and leaves every other field, notably `id`, `call_id`, and a `reasoning` item's `encrypted_content`, passed through untouched. (An earlier, unscoped version of this rewrote those opaque fields too, which could corrupt an `encrypted_content` blob or break the `function_call`/`function_call_output` `call_id` pairing whenever a masked original happened to appear inside one as a substring — fixed before this plugin shipped.) The client-facing `query` on every `web_search_call` item, and the final answer text, are always the unmasked values; only what leaves the process for Perplexity or the deployment is masked.

**What the client actually receives.** Both handlers *remove* the model's `function_call` from the client-facing output. In the normal flow (a request that reached a real deployment call, so an upstream context is always stashed) there is therefore nothing left for the client to replay, and the before handler's pending-search drain never fires: the turn ends with the model's own answer, informed by the search results, exactly as a native hosted `web_search` tool would behave.

Across a multi-round continuation the client receives **every** round's output, concatenated in order, with only the `web_search` `function_call`s substituted in place (`clientVisibleItems`) — the reasoning items each round produced, their `encrypted_content` intact, and any assistant text the model wrote *before* it searched, all keeping their original position relative to the search that followed them. This matters because the route runs `store: false`: clients replay `output` into the next turn's `input`, so dropping an intermediate round's reasoning breaks chain-of-thought continuity *across* turns — the exact property the continuation preserves *inside* one. Both transports build that list with the same helper and hand the client the same array for the same turn.

The drain loop is kept for the case where a `web_search` `function_call` *does* reach the next turn's `input` unanswered anyway — a client that replays it regardless, a continuation that fell back to the synthetic pair, or a call that was never substituted — because the deployment rejects such a turn as malformed.

### Phase 3: Streaming (`responses-stream`) — the same continuation, spliced into the live SSE stream

After plugins do not run per SSE frame, so the streaming path is handled by a `res.write` interceptor the BEFORE handler installs (`installResponsesWebSearchInterceptor`). Codex CLI always streams, so this — not the after handler — is the path that matters in practice. It reproduces the continuation frame by frame:

1. **Suppress** the raw `web_search` `function_call` frames (`output_item.added` / `function_call_arguments.*` / `output_item.done`) and run the search when the item completes. Frames arriving while a search is in flight are queued, so upstream interleaving and a deferred `res.end` are preserved.
2. **Hold** the first call's terminal frame (`response.completed` / `.incomplete` / `.failed`). It is not the client's final frame any more.
3. **Inject** `output_item.added` + `.done` for the synthetic `web_search_call` at the suppressed item's `output_index` — and *only* those: the formatted-result `message` is not emitted, because the model is about to write a real answer.
4. **Open the continuation** with `stream: true` and the whole turn as `input` (original input + everything the model produced, the suppressed `function_call` included + one `function_call_output` per search). From its frames, `response.created` and `response.in_progress` are dropped (the client already has one of each), `output_index` and `sequence_number` are shifted past everything already sent, and the rest pass straight through — so the answer streams token by token.
5. **Merge the terminal frame.** The continuation's becomes the client's, with `response.output` prefixed by every item earlier calls already streamed (each `web_search_call` in place of the `function_call` it replaced, so the array lines up with the `output_index` values the client saw) and `usage` summed across every call.
6. **Repeat** if the continuation itself calls `web_search`, bounded by the same `getWebSearchMaxSearches()` cap.

**Fallback.** No upstream context, no budget left, or a continuation POST that fails all stop the turn where it is: the formatted-result `message` frames are emitted after the fact and the held terminal frame is written with the in-place substitution, i.e. exactly the pre-continuation behavior. A continuation that swallowed a terminal frame and then produced none of its own gets a synthesized `response.completed`, so the client is never left waiting on a terminal frame that will not come — and if it produced *nothing at all*, not one output item either, the result dump withheld for the answer it never delivered is handed over after the fact (`deliverWithheldDumps`) and named in that synthesized terminal. Terminating is right; terminating with an empty response would be worse than the dump this feature replaced.

**One terminal frame, always.** A terminal frame the client is keeping also *closes* the turn (`writeClosingTerminal`). That is what stops a `.incomplete` — the deployment's answer to `max_output_tokens`, which Codex sets on every request — from being written to the client and then continued anyway by the `res.end` that follows it, which would put frames after the client's terminal frame and pay for a deployment call billed to nobody. Any result dump withheld while a continuation still looked likely is streamed first, so the `message` that terminal frame names in `response.output` always has its own `output_item` events.

**Usage and lifecycle.** `responsesController.forwardStream` treats the first stream's `'end'` event as the end of the response, which is wrong here: the continuation is opened *after* that event, and `forwardStream` never runs the after-plugin chain, so there is no other point at which these tokens could be reported. Three hooks on `res` (`utils/responsesStreamIdle.ts`) bridge that gap, all no-ops on a response with no interceptor installed:

- **upstream-end** — signalled by the controller immediately before it waits. It is one of three things that tell the interceptor the turn is finished and a continuation may start (the others being the held terminal frame and a deferred `res.end`). A stream that ends without a terminal frame has neither of those, so without this signal the continuation would start only *after* the usage event had been emitted, and its tokens would go unbilled.
- **idle** — awaited by the controller before it folds `__responsesExtraUsage`, emits the usage event and closes the socket. Each continuation round's usage lands on the accumulator through `noteExtraUsage` (`usageFolding.ts`), which per round subtracts that round's cache-read and cache-creation counts out of `input_tokens` before adding it — a cached-prefix continuation round bills only its full-rate remainder, not the whole prefix again. The accumulator's `input_tokens`/`output_tokens` field names are unchanged, so a plugin doing `acc.input_tokens += n` still works exactly as documented above; `cache_creation_tokens` and `cache_read_tokens` are additions, not a shape change to those two.
- **abort** — called from the controller's `req` `'close'` handler, the same signal it uses to destroy the first upstream stream. It destroys any continuation stream in flight and blocks further rounds: Codex aborts turns routinely, and an abandoned request must neither open nor keep open a deployment call nobody will read.

A stalled continuation degrades to a truncated response rather than a hung request: the per-stream watchdog is the first bound, the controller's wait timeout the last.

**One clock for the whole loop.** The controller allows the entire splice a single `getTimeout(true)` idle budget, and the loop takes the same value — stashed on the upstream context as `timeoutMs` — as one wall-clock deadline, established when it starts and checked at the top of every round; on expiry it stops the turn exactly as the cap does. Without that the two disagreed: the loop's own ceiling is `max_searches_per_request` rounds of (a search + a per-stream watchdog), tens of minutes at the default cap, so the controller's budget expired first, emitted usage counting only the rounds finished by then, and called `res.end()` — which the interceptor defers while it is busy, leaving the client on a stalled-but-open SSE socket while later rounds' tokens landed in an accumulator nobody would read again.

**Masking.** Unlike the after handler, this path needs no re-masking at all. The interceptor is installed *after* `pseudonymizationPlugin`'s own `res.write` interceptor, so it reads frames upstream of the unmasker: the query, the model's items, and the conversation it POSTs back are all still masked exactly as the deployment produced them. Symmetrically, everything it writes goes out *through* the unmasker, so the continuation's answer reaches the client unmasked without this code touching the replacement map. Re-masking here would be actively harmful — it would rewrite masked-looking substrings inside the search results themselves. The asymmetry with the after handler is deliberate and has one visible consequence: a search result containing the literal text of a masked original (realistically a short entity type, e.g. `male` from `profile-gender`) reaches the deployment as a placeholder for a non-streaming caller and verbatim for a streaming one, so the model reads slightly different text depending on transport. Both directions are safe — nothing raw leaves the process either way — and the module docstring in `webSearch/queryMasking.ts` records why the alternatives are worse.

## Hook Configuration

```json
{
  "api_config": {
    "defaultHooks": {
      "openai": {
        "responses": [
          {
            "request": {
              "callback": { "id": "pseudonymizationPlugin" },
              "match": ["header:contentTypeJson"]
            }
          },
          {
            "request": {
              "callback": { "id": "responsesWebSearchPlugin" },
              "match": ["tools:hasWebSearch"]
            }
          }
        ],
        "responses-stream": [
          {
            "request": {
              "callback": { "id": "pseudonymizationPlugin" },
              "match": ["header:contentTypeJson"]
            }
          },
          {
            "request": {
              "callback": { "id": "responsesWebSearchPlugin" },
              "match": ["tools:hasWebSearch"]
            }
          }
        ]
      }
    }
  }
}
```

**`pseudonymizationPlugin` must stay first in both arrays.** Request hooks in an array run in order, and this plugin's before handler is what ultimately hands the search query text to Perplexity — a third-party model outside SAP AI Core. If `pseudonymizationPlugin` ran after this plugin (or were reordered/removed), the query reaching Perplexity would carry unmasked PII straight from the user's request. If you're editing these arrays, keep `pseudonymizationPlugin` first; do not reorder.

**The other two entries are ordered oppositely in the two arrays, on purpose.** `responsesNamespaceToolsPlugin` shares both hook arrays with this plugin, and its position relative to this one differs by subpath:

| Array | Order | Why |
|---|---|---|
| `responses-stream` | pseudonymization → **namespace** → web-search | write interceptors nest inside-out, so the namespace layer must install *first* to sit beneath this one and catch the frames this plugin generates itself |
| `responses` | pseudonymization → web-search → **namespace** | after-handlers chain *in array order*, so the namespace handler must run *last* to see the `output` this plugin's continuation loop produced |

They are meant to disagree. Normalising them to match reintroduces one of two bugs — a sub-agent call emitted during a continuation round reaching the client without its routing `namespace`, on whichever path you broke. `test/responses-tool-plugin-layering.test.ts` fails by name if you do. The full reasoning is in `responsesNamespaceToolsPlugin.md`.

The `tools:hasWebSearch` hook definition already exists under `api_config.hookDefinitions` (shared with `webSearchPlugin`) and is reused as-is:

```json
{
  "hookDefinitions": {
    "tools:hasWebSearch": {
      "desc": "Match requests containing web_search tool",
      "type": "json-path-regex",
      "path": "$.tools",
      "regex": "web_search",
      "flags": "i"
    }
  }
}
```

## Request/Response Shapes

**Request** — client sends a hosted tool:

```json
{
  "model": "gpt-5.3-codex--deployed",
  "input": "What's the weather in Berlin?",
  "tools": [{ "type": "web_search" }]
}
```

**After the before handler**, the deployment sees a function tool instead — no hosted `web_search` type reaches SAP AI Core.

**Client's next turn**, replaying the conversation with the model's `function_call` still unanswered:

```json
{
  "input": [
    { "type": "function_call", "call_id": "call_1", "name": "web_search", "arguments": "{\"query\":\"weather in Berlin\"}" }
  ]
}
```

The before handler executes the search and appends:

```json
{ "type": "function_call_output", "call_id": "call_1", "output": "{\"results\":[{\"title\":\"...\",\"url\":\"...\",\"snippet\":\"...\",\"content\":\"...\"}]}" }
```

**Response, normal case** — a real request always has an upstream call context, so the after handler continues the turn: it runs the search, POSTs the results back to the deployment, and returns the MODEL's own answer alongside a `web_search_call` recording that the search happened:

```json
{
  "output": [
    { "type": "web_search_call", "id": "ws_...", "status": "completed", "action": { "type": "search", "query": "weather in Berlin" } },
    {
      "type": "message",
      "id": "msg_2",
      "role": "assistant",
      "status": "completed",
      "content": [{ "type": "output_text", "text": "It's mild and dry in Berlin right now.", "annotations": [] }]
    }
  ]
}
```

**Response, fallback case** — no upstream context (e.g. the plugin invoked outside a real request), or the continuation POST itself failed: the after handler falls back to a synthetic `web_search_call` + `message` pair spliced in at the original call's position, preserving any item (like `reasoning` here) that preceded it:

```json
{
  "output": [
    { "type": "reasoning", "id": "rs_1", "summary": [] },
    { "type": "web_search_call", "id": "ws_...", "status": "completed", "action": { "type": "search", "query": "weather in Berlin" } },
    {
      "type": "message",
      "id": "msg_...",
      "role": "assistant",
      "status": "completed",
      "content": [{
        "type": "output_text",
        "text": "Web search results for \"weather in Berlin\":\n\n1. Berlin weather — Mild (https://w.example/berlin)",
        "annotations": [{ "type": "url_citation", "url": "https://w.example/berlin", "title": "Berlin weather" }]
      }]
    }
  ]
}
```

## Testing

```bash
curl -X POST http://localhost:3000/openai/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "gpt-5.3-codex--deployed",
    "input": "What is the current weather in Berlin?",
    "tools": [{"type": "web_search"}]
  }'
```

## Limitations

Inherited from the shared `searchExecutor` module (see [`webSearchPlugin.md`](./webSearchPlugin.md#limitations) for the Anthropic-side detail):

1. **Usage accounting**: Perplexity's token usage from the search call is not merged into this route's usage/telemetry event — only the deployment's own usage is reported. (This is separate from — and does not apply to — the continuation loop's own deployment-side token usage, which IS merged: every continuation POST's tokens are added both to the request's internal billing accumulator and to the client-visible `usage` field on the final response.)
2. **Citation fidelity**: when no direct `sonar-pro` deployment is available and the plugin falls back to SAP AI Core orchestration, the orchestration wrapper strips Perplexity's real `citations` / `search_results` fields. In that fallback path, the URLs in `url_citation` annotations are model-generated rather than Perplexity-verified.
3. **Streaming** (see [Phase 3](#phase-3-streaming-responses-stream--the-same-continuation-spliced-into-the-live-sse-stream) above for how it works): the injected `web_search_call` reuses the suppressed item's `output_index` rather than being renumbered onto a fresh one, and on the fallback path the result `message` shares that index too — whether Codex needs distinct indices per injected item is settled by the live acceptance gate. Only a `response.completed` is continued: a first call that ends in `.incomplete` (max output tokens) or `.failed` describes a turn the deployment could not finish, so it falls back rather than asking the deployment to continue from a truncated `function_call`.

## Related Documentation

- [`webSearchPlugin.md`](./webSearchPlugin.md) — the Anthropic sibling; shares the Perplexity integration, environment variables, and error-handling strategy documented there
- [Plugin System](../../../docs/chapter-13-plugin-system.md)
- [SAP AI Core Orchestration](../../../docs/sap-ai-core.md)
