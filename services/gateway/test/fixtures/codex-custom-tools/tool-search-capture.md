# tool_search — captured round trip

Captured 2026-08-11 from real codex CLI 0.147.0 traffic, intercepted with mitmproxy.
Model `gpt-5.5`, endpoint `chatgpt.com/backend-api/codex/responses` (WebSocket, HTTP 101).
The session had genuine deferred tools available (Codex Document Control, Sites, MCP), and
the model was prompted to search for document tools; it answered *"Found 20 tools."*

**Every field name below is from the wire.** Long `description` strings are trimmed and
`encrypted_content`-style blobs are omitted, following this directory's convention.

## The declaration (client → server)

Unchanged from what the gateway already sees. Four keys, and **no `name`**:

```json
{ "type": "tool_search", "execution": "client",
  "description": "# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.…",
  "parameters": { "type": "object",
    "properties": {
      "limit": { "type": "number", "description": "Maximum number of tools to return. Defaults to 8." },
      "query": { "type": "string", "description": "Search query for deferred tools." } },
    "required": ["query"], "additionalProperties": false } }
```

A second occurrence in the same capture carries no `execution` key, so treat `execution` as
optional rather than guaranteed.

## `tool_search_call` (server → client, an output item)

```json
{ "id": "tsc_09bce91280786095016a7ba41f8b808199aea1283c54dea60d",
  "type": "tool_search_call",
  "status": "completed",
  "arguments": { "query": "documents document control", "limit": 20 },
  "call_id": "call_oLt37dF00SxkanLfJlCoMkFR",
  "execution": "client",
  "internal_chat_message_metadata_passthrough": { "turn_id": "019ff2f9-…" },
  "metadata": { "turn_id": "019ff2f9-…" } }
```

**`arguments` is a JSON OBJECT, not a JSON string.** This is the opposite of `function_call`,
whose `arguments` is a string that must be parsed. Any translation has to convert between the
two, and getting it backwards would hand the client a string where it expects an object.

Id prefix is `tsc_`.

### Streaming

Two frames, and **no argument-delta frames at all**:

```
response.output_item.added   item.status="in_progress"  item.arguments={}          sequence_number 4
response.output_item.done    item.status="completed"    item.arguments={query,limit} sequence_number 5
```

No `response.tool_search_call_arguments.*` or similar exists in the capture. That matters: the
whole suppress-and-resynthesise machinery `custom`/`apply_patch` needed exists only because a
`custom_tool_call` streams raw text while a `function_call` streams JSON fragments. Here the
arguments arrive complete inside `output_item.done`, exactly as the orchestration bridge already
emits function calls — so a translation needs no delta buffering.

## `tool_search_output` (client → server, an input item)

```json
{ "type": "tool_search_output",
  "id": "tso_019ff2f9-1cd4-7010-b7bf-221b2272ab6a",
  "call_id": "call_oLt37dF00SxkanLfJlCoMkFR",
  "status": "completed",
  "execution": "client",
  "tools": [
    { "type": "namespace",
      "name": "mcp__codex_apps__codex_document_control",
      "description": "…",
      "tools": [
        { "type": "function", "name": "_list_document_sessions", "description": "…",
          "strict": false, "defer_loading": true,
          "parameters": { "type": "object", "properties": { … }, "additionalProperties": false } },
        { "type": "function", "name": "_get_docum_83c7f0565c0f", "…": "…" },
        { "type": "function", "name": "_execute_d_7437ad2e4ffa", "…": "…" }
      ] } ] }
```

**There is no `output` string and no content-part array.** The result of a search is a `tools`
array carrying full tool declarations — `namespace` wrappers containing `function` tools, each
marked `defer_loading: true`. Id prefix is `tso_`.

## The finding that corrects the plan

**`additional_tools` is NOT how discovered tools are delivered.** The plan for this work assumed
codex would inject them as an `additional_tools` item on the following turn, and that translating
`tool_search` without also handling `additional_tools` would make discovery succeed and then kill
the next turn.

That is wrong. `additional_tools` appears **zero** times in this capture. The discovered tools
travel inside `tool_search_output.tools` itself, in the same item that answers the call.

(The `additional_tools` item does exist and was observed 5 times in the earlier
`responses-api-compliance-capture.json` session — but that is a different mechanism, not the
tool_search return path.)

## Live verification against THIS gateway, and one gap that is not ours

The translation shipped and was driven with real codex 0.147.0 against the gateway.

**Works, verified live on `gpt-5.5` (orchestration):** the declaration is accepted where it used
to 400, the model issues a search, the call is restored so codex dispatches it, codex executes it
locally, and the results come back — *"Found these document-related tools: capture_list_documents,
capture_search_documents, capture_read_document"*.

**One defect only real codex could find.** The first live run died immediately:

```
Unsupported Responses input item type: tool_search_call
```

Codex replays the CALL item alongside its output on the following turn, and only
`tool_search_output` was being converted. This is the same shape of miss as the apply_patch replay
bug — handling one half of a replayed pair leaves the other half fatal — and no amount of `curl`
probing would have surfaced it, because a single-shot request never replays anything. Fixed;
`translateToolSearchOutputItems` now converts both halves.

**The gap that remains is codex's, not the gateway's.** Discovered tools are never exposed for
invocation: across nine consecutive search round-trips codex sent the same 14 tools every time,
never including the discovered ones. Isolated as follows:

- **Not route-specific.** `gpt-5.3-codex` (deployed) behaves identically to `gpt-5.5`
  (orchestration).
- **Not the id prefix.** Restoring `tsc_`-prefixed ids to match every captured call changed
  nothing. That change was kept anyway because the captured shape really does use `tsc_`, but it
  fixed nothing and should not be read as having done so.
- **It is a known codex bug** — openai/codex#36382, which describes this exact configuration
  (a custom `model_catalog_json` with `supports_search_tool: true` and `tool_mode: null`).
  With `supports_search_tool` true, MCP tools are registered as `ToolExposure::Deferred`;
  `build_model_visible_specs` emits only `ToolExposure::Direct`; and with `tool_mode: null` there
  is no code-mode execution context for deferred tools to be nested into. The issue states
  plainly that *"even after `tool_search` returns deferred tools, they remain unusable without a
  code-mode execution context"*.

**The workaround is verified here.** Setting `supports_search_tool: false` registers MCP tools as
`Direct`, and they become immediately callable through this gateway with no discovery step at all
— confirmed end to end: codex called `capture_list_documents` on `gpt-5.5` through the
orchestration route and received the server's reply.

So for this gateway today: **enabling `tool_search` in a client catalogue makes MCP tools
discoverable but not callable; disabling it makes them callable but not discoverable.** That
trade is entirely client-side. The gateway's job — not 400ing on the tool type, and round-tripping
the call and its replay — is done, and nothing in the gateway can lift the exposure limit.

### Narrowing the exposure gap — four controlled experiments

The open question was why discovered tools ARE exposed against `api.openai.com` but not against
this gateway. Each run below changed exactly one variable, same codex 0.147.0, same MCP server,
same `supports_search_tool: true`. "Exposed" means `capture_*` entries appear in the client's own
`tools[]` on `response.create`, verified from the proxy dump rather than from the TUI.

| # | Endpoint | Catalogue | Provider | Transport | Discovered tools exposed? |
|---|---|---|---|---|---|
| 1 | this gateway | custom | custom (`sailproxy`) | HTTP+SSE | **no** |
| 2 | this gateway, `gpt-5.3-codex` | custom | custom | HTTP+SSE | **no** |
| 3 | api.openai.com | bundled | built-in `openai` | WebSocket (101) | yes |
| 4 | api.openai.com | **custom** | built-in `openai` | WebSocket (101) | yes |
| 5 | api.openai.com | custom | **custom** (`openai_via_custom`) | **HTTP+SSE (POST, 200)** | yes |

What each rules out:

- **Route** — run 2 vs 1: the deployed model behaves exactly like the orchestration model, so the
  bridge is not involved.
- **The custom catalogue** — run 4: the very same `model_catalog_json` that fails against this
  gateway works against `api.openai.com`. This matters because openai/codex#36382 blames custom
  catalogues; that is not the whole story.
- **Provider identity** — run 5: a hand-declared custom provider is not treated differently.
- **Transport** — run 5 again, and this is the one that overturned the standing hypothesis. That
  run went over plain `POST /v1/responses → 200`, i.e. HTTP+SSE, precisely like this gateway, and
  the tools were still exposed and callable. **WebSocket has nothing to do with it.**

So the difference is not codex's configuration, catalogue, provider type, or transport. What is
left is the endpoint itself — something this gateway returns, or fails to return, that leads
codex to keep MCP tools in `ToolExposure::Deferred` instead of promoting them. Note that in the
failing runs codex sent **no `namespace` tool at all** (types were `function`, `custom`,
`tool_search`, `web_search`), while against `api.openai.com` a `namespace` entry carrying the
discovered tools was present — consistent with deferral rather than with the tools being absent.

### Diagnosed: the discriminator is the provider's `base_url`

Two further runs close it.

**Run 6 — `namespace` and `tool_search` are mutually exclusive against this gateway.** Across
every captured codex request in `logs/payloads` going back to 2026-07-28, no request ever carries
both. Either `namespace` tools are present and `tool_search` is absent, or the reverse. The
clearest row is the `supports_search_tool: false` session: **two** namespace tools (multi_agent
plus `mcp__capturedocs`) and no `tool_search` — and in that session the MCP tool was directly
callable.

So the missing `namespace` wrapper is not a missing link the gateway could supply. It is the
MECHANISM by which codex exposes MCP tools, and its absence IS the deferral.

**Run 7 — only the URL changed.** The working run-5 config was copied byte for byte and a single
line altered:

```
- base_url = "https://api.openai.com/v1"
+ base_url = "http://localhost:3000/openai/v1"
```

Same custom provider, same custom catalogue, same MCP server, same `supports_search_tool: true`,
same HTTP+SSE transport, same codex binary. Result:

```
types={'function': 11, 'custom': 1, 'tool_search': 1, 'web_search': 1}  namespaces=[]
```

No namespace entry, no discovered tools. **The provider's `base_url` is the sole discriminator.**
Codex keeps deferred MCP tools exposed when the endpoint is `api.openai.com` and hides them for
any other endpoint, and with `tool_mode: null` there is no code-mode context to reach them
through — which is the mechanism openai/codex#36382 describes, gated on the host.

Note the decision is made BEFORE any response arrives: in the working run the model called the
tool on its first turn, so nothing this gateway returns can influence it. No amount of response
shaping fixes this.

### The one thing the gateway CAN do about it

Hoisting was ruled out earlier on the grounds that codex re-sends discovered tools in its own
`tools[]` from the discovery turn onward. That observation is correct — but only against
`api.openai.com`. Against this gateway codex never re-sends them, so the reasoning does not carry
over, and hoisting becomes the only available lever:

1. on a replayed `tool_search_output`, hoist its `tools` into the request's `tools` array;
2. flatten the `namespace` wrappers as `flattenNamespaceTools` does, since the upstream accepts
   only `function`;
3. merge the resulting name → namespace pairs into the map `responsesNamespaceToolsPlugin`
   already stashes, so the call is re-nested on the way back and codex's router — which does have
   the MCP server — can dispatch it by `(namespace, name)`.

Untried. The ordering matters: the namespace plugin's before handler runs BEFORE this one in both
hook arrays, so its flatten has already happened by the time a hoist could add more, which is why
step 2 has to be done by the hoisting code itself rather than delegated.

### Run 8 — the built-in provider repointed at this gateway

A further variant closes the last configuration gap. `openai_base_url` repoints the BUILT-IN
`openai` provider without a `model_providers` entry — the one shape the earlier runs did not cover:

```
model_provider   = "openai"
openai_base_url  = "http://localhost:3000/openai/v1"
```

Same custom catalogue, same MCP server, `supports_search_tool: true`. Result: codex still sent
**no `namespace` entry and no discovered tools** — `{function: 11, custom: 1, tool_search: 1,
web_search: 1}` on every turn.

The MCP tool WAS callable in that run, but not because codex exposed it: the gateway's hoist was
enabled and did the work. The TUI alone would have suggested `openai_base_url` fixed the gating;
the wire showed it did not. Recorded because the wrong conclusion was one step away.

### What is settled, and what is not

**Settled empirically.** The gating is on the endpoint and is provider-INDEPENDENT: both a custom
`model_providers` entry and the built-in `openai` provider fail to expose deferred tools when
pointed at this gateway, and both succeed against `api.openai.com`. Transport is not it (run 5 was
plain HTTP+SSE), the catalogue is not it (run 4 used this very catalogue), and `openai_base_url`
does not lift it.

**The internal mechanism is documented upstream.** With `supports_search_tool: true` every MCP tool
is registered `ToolExposure::Deferred`, and `build_model_visible_specs` emits only tools whose
exposure `is_direct()`, so deferred tools never reach the model-visible list — see
`codex-rs/core/src/mcp_tool_exposure.rs` and openai/codex#36382.

**NOT established: why the endpoint changes that classification.** The tracking issue explicitly
does not cover the base_url dimension — it attributes the effect to custom catalogues, which run 4
disproves. No source-level explanation was found for why the same catalogue and the same provider
classify tools differently by endpoint. Left as an unexplained observation rather than a guess; the
hoist works around it either way.

## What this implies for translating tool_search

Not yet implemented; recorded so the design rests on evidence.

- **Declaration** → a `function` tool named `tool_search`, reusing `parameters` verbatim. The name
  must be supplied because the wire carries none.
- **The call back to the client** → `function_call.arguments` (a JSON string) must be parsed into
  `tool_search_call.arguments` (an object), with `call_id` preserved and an id minted or omitted.
  Note the `ctco_`/`fc_` prefix lesson from the apply_patch work: a client id whose prefix no
  longer matches its rewritten type gets rejected upstream, so ids need deliberate handling.
- **The output from the client** is the hard part. `tool_search_output` carries `tools`, not text.
  To pair the call for an upstream that knows only function tools it must become a
  `function_call_output`, and for the discovered tools to be usable at all they must additionally
  be hoisted into the request's `tools` array — the same hoist `flattenNamespaceTools` already
  performs, which is convenient since the discovered entries are themselves `namespace` tools.
  Simply stringifying the array would pair the call and silently lose every discovered tool.
- **No streaming interceptor is required** on the evidence above.

## Confirmed on the PUBLIC API — this is not a ChatGPT-backend feature

The first pass was captured against ChatGPT's backend, because codex had a ChatGPT session and
prefers it. Re-captured against `api.openai.com` by running `/logout` in a scratch `CODEX_HOME`
and adding `preferred_auth_method = "apikey"` so codex used the `OPENAI_API_KEY` env var.

Codex connects to **`GET api.openai.com/v1/responses` → HTTP 101**, i.e. WebSocket, on the public
API too — not only against the ChatGPT backend.

`tool_search` **is offered and works there**, with byte-identical item shapes. Model
`gpt-5.5-2026-04-23`:

```json
{ "id": "tsc_04b2930e83ec9e9d016a7ba6d119e4819ba3a0b559971d5fe7",
  "type": "tool_search_call", "status": "completed",
  "arguments": { "query": "documents", "limit": 8 },
  "call_id": "call_TjzTAr0Vbhygn4xbIYWmIuHw",
  "execution": "client",
  "internal_chat_message_metadata_passthrough": { "turn_id": "019ff303-…" },
  "metadata": { "turn_id": "019ff303-…" } }
```

```json
{ "type": "tool_search_output",
  "id": "tso_019ff303-a16a-7f70-9989-14e8b43d5275",
  "call_id": "call_TjzTAr0Vbhygn4xbIYWmIuHw",
  "status": "completed", "execution": "client",
  "tools": [],
  "internal_chat_message_metadata_passthrough": { "turn_id": "019ff303-…" } }
```

`tools` was empty in that first public-API run only because an API-key session has no deferred
tools — no MCP servers and no ChatGPT plugins to discover. `arguments` is an object in both
captures; the `tso_`/`tsc_` id prefixes and `call_id` pairing are identical.

### A populated `tools` array, captured deliberately

To capture a non-empty array, a purpose-built stdio MCP server was registered with
`codex mcp add capturedocs -- node <script>` (the script is scratch, not in this repo; it serves
three distinctively-named document tools so the captured array is unmistakably that server's).
Codex then discovered them:

```json
{ "type": "tool_search_output",
  "id": "tso_019ff30e-f030-70a2-b22f-544e804b5699",
  "call_id": "call_1jyP3Ac7IS5Hnl92l4Kxgc2N",
  "status": "completed", "execution": "client",
  "tools": [
    { "type": "namespace",
      "name": "mcp__capturedocs",
      "description": "Tools in the mcp__capturedocs namespace.",
      "tools": [
        { "type": "function", "name": "capture_read_document", "description": "…",
          "strict": false, "defer_loading": true,
          "parameters": { "type": "object", "properties": { … }, "required": ["document_id"],
                          "additionalProperties": false } },
        { "type": "function", "name": "capture_list_documents", "…": "…" },
        { "type": "function", "name": "capture_search_documents", "…": "…" }
      ] } ],
  "internal_chat_message_metadata_passthrough": { "turn_id": "019ff30e-…" } }
```

So a discovered entry is a **`namespace` wrapper** whose `name` is `mcp__<server>`, containing
ordinary `function` tools carrying `strict`, `parameters`, and `defer_loading: true`. Note
`defer_loading` is not a field `translateTools` reads (`requestTranslator.ts` destructures only
`name`, `parameters`, `description`, `strict`), so it is dropped rather than forwarded — which is
the correct outcome, since it describes a client-side loading policy.

### Calling a discovered tool — already-supported machinery

The chain was driven to completion: the model called one of the discovered tools and received the
stub's reply. The call is an **ordinary `function_call`**:

```json
{ "id": "fc_050f673da75eaca7016a7baa2e6d5c819a8a2b4e1924f4a0ae",
  "type": "function_call", "status": "in_progress", "arguments": "",
  "call_id": "call_dF1urmiNrAFIHWGaD1zCyKfj",
  "name": "capture_list_documents",
  "namespace": "mcp__capturedocs",
  "internal_chat_message_metadata_passthrough": { "turn_id": "…" } }
```

followed by normal `response.function_call_arguments.delta` frames (`{"`, `folder`, …).

**That `namespace` field is exactly what `namespaceTools/adapter.ts`'s `renestFunctionCall`
already restores.** Once tools are discovered, everything downstream — the namespace wrapper on
the way out, the `namespace` field on the call coming back — is machinery this gateway has had
since the multi-agent work. The genuinely new surface is only the `tool_search` declaration and
its call/output pair.

**This matters for whether the work is worth doing.** Unlike server-side compaction — which codex
does not use against this gateway at all, so that fix is purely defensive — `tool_search` is a
live feature of the same public Responses API this gateway emulates. Translating it is enabling,
not defensive.

Also visible on the public API in the same request, none of which the orchestration bridge
currently forwards: `previous_response_id`, `prompt_cache_key`, `prompt_cache_retention: "24h"`,
and `reasoning: {context, effort, mode, summary}`.

Both SAP routes still reject the `tool_search` tool type outright (measured), so the round trip
cannot be observed against this gateway until the translation exists.
