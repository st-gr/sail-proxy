# Responses API hosted tools + OpenRouter mount — Design

**Status:** approved design, ready for implementation planning
**Scope:** Phase 2 of the OpenAI Responses API work. Emulates the hosted `web_search` tool on `/openai/v1/responses` as a gateway plugin, and mounts the route under `/openrouter/api/v1`.

## Context

Phase 1 shipped `/openai/v1/responses` as a native passthrough to deployed GPT-5+/o-series models, with pseudonymization extended to the Responses body shape and its streaming deltas. It is reviewed, merged and live-verified.

The live acceptance gate surfaced one blocker. Codex CLI 0.145 attaches a hosted `web_search` tool to **every** request and the SAP deployment rejects it:

```
400 {"error":"BadRequest","message":"The following tool is not allowed for model 'gpt-5.3-codex': web_search."}
```

Probed against `gpt-5.3-codex--deployed`, none of `tools.web_search = false`, `tools.web_search_mode`, or `models.<name>.experimental_supported_tools` suppresses it client-side. Codex's `multi_agent` feature sends a second rejected tool (`{"type":"namespace","name":"multi_agent_v1"}`), but that one *is* switchable with `--disable multi_agent`. So `web_search` is the only tool that makes Codex unusable through the route without a proxy shim.

The gateway already solves the identical problem for Anthropic. `webSearchPlugin` intercepts Anthropic's server-side `web_search_20250305` / `web_search_20260209` tool, converts it to a regular tool SAP accepts, executes searches through Perplexity `sonar-pro`, and re-frames the result into Anthropic's `server_tool_use` / `web_search_tool_result` shape. Phase 2 ports that pattern to the Responses wire format.

### Decisions taken during design

1. **Plugin, not controller code.** The emulation lives in a plugin registered through `api_config.json` hooks, exactly as the Anthropic one does. `responsesController` is not modified.
2. **`file_search` is out of scope.** It searches OpenAI vector stores; the gateway has no vector store, and a corpus (local folder, HANA vector engine) is its own subsystem. Codex does not send `file_search`, so nothing is blocked.
3. **No in-request re-call of the model.** Search results reach the model on the client's next turn, via the pending-search back-fill. This mirrors `webSearchPlugin` and works because Codex replays the whole conversation under `store: false`.

## Architecture

| Component | Path | Purpose |
|---|---|---|
| Shared search core | `services/gateway/src/plugins/webSearch/searchExecutor.ts` (new) | Perplexity `sonar-pro` execution: deployment auto-discovery, orchestration fallback, system-prompt loading, response parsing, the `SearchResult` type |
| Responses plugin | `services/gateway/src/plugins/responsesWebSearchPlugin.ts` (new) | before + after handlers in the Responses wire format |
| Anthropic plugin | `services/gateway/src/plugins/webSearchPlugin.ts` (modified) | keeps Anthropic-specific formatting; imports the shared core |
| OpenRouter route | `services/gateway/src/routes/openRouterRoutes.ts` (modified) | mounts `handleResponses` at `/openrouter/api/v1/responses` |
| Config | `services/gateway/api_config.json` (+ 2 synced copies) | registers the plugin under `defaultHooks.openai.responses` / `.responses-stream` |

### The shared search core

`executeWebSearch(query, logger): Promise<SearchResult[]>` is currently private to `webSearchPlugin.ts`, which ends in `export = pluginRules` — there is no way to reuse it without moving it. Roughly the first 350 lines (search execution, `SearchResult` / `PerplexityResponse` / `PerplexitySearchResult` / `NormalizedCitation` types, the `WEBSEARCH_FORCE_ORCHESTRATION` env handling, and the cached `webSearchPlugin.system-prompt.txt` loader) move to `searchExecutor.ts` and are imported by both plugins.

This is a pure extraction with no behaviour change, but it touches a live Anthropic path used by Claude Code. It therefore gets its own task, landing before either consumer changes, and its acceptance is an unchanged Anthropic `web_search` round trip.

The system-prompt file stays at `services/gateway/src/plugins/webSearchPlugin.system-prompt.txt` so operators who edit it are unaffected; only the loader's relative path inside `searchExecutor.ts` changes to account for the new subdirectory.

**Untouched:** `responsesController`, the phase-1 masking adapter, `openaiController`, the Anthropic route's behaviour.

### Hook wiring

The existing `hookDefinitions` matcher is reused as-is:

```json
"tools:hasWebSearch": {
  "desc": "Match requests containing web_search tool",
  "type": "json-path-regex",
  "path": "$.tools",
  "regex": "web_search",
  "flags": "i"
}
```

It is registered under `defaultHooks.openai.responses` and `defaultHooks.openai.responses-stream`, alongside the existing `pseudonymizationPlugin` entries, so a request without a `web_search` tool never enters the plugin.

Ordering matters: `pseudonymizationPlugin` must run **before** `responsesWebSearchPlugin` on the request side, so the search query the gateway extracts is the masked one and no raw PII reaches Perplexity. On the response side the reverse holds — search results are injected before unmasking, so any placeholder echoed back by Perplexity is still restored.

### The OpenRouter mount

`/openrouter/api/v1/chat/completions` already funnels into `openaiController`, which tags `(req as any).__endpoint = 'openai'`. Mounting `handleResponses` at `/openrouter/api/v1/responses` therefore resolves hooks against `defaultHooks.openai.responses` with no new config, no schema change, and the phase-1 fail-closed 503 guard behaving identically. It is a route-file change plus a startup log line.

## Data flow

### Before handler

1. Replace every `{"type": "web_search", …}` entry in `tools` with the flat Responses function tool the deployment accepts:

```json
{
  "type": "function",
  "name": "web_search",
  "description": "Search the web for current information",
  "parameters": {
    "type": "object",
    "properties": { "query": { "type": "string", "description": "The search query" } },
    "required": ["query"]
  },
  "strict": false
}
```

2. Walk `input` for a `function_call` item named `web_search` whose `call_id` has no matching `function_call_output`. That is a search left pending from the previous turn: execute it and append a `function_call_output` item carrying the results. This is what lets the model reason over results without a second deployment call inside one request.

3. If `tools` becomes empty, drop the key rather than sending `"tools": []`.

Codex sends `{"type":"web_search","external_web_access":false}`. That flag is read as Codex declining to have *the model provider* browse, not as a prohibition on the gateway, so emulation proceeds regardless. This is deliberate and documented; no config gate is added for it.

### After handler, non-streaming

A `function_call` item named `web_search` in `output` is replaced by two synthetic items:

```json
{ "type": "web_search_call", "id": "ws_<id>", "status": "completed",
  "action": { "type": "search", "query": "<query>" } }
```

followed by a `message` item whose `output_text` content carries the summary, with one `url_citation` annotation per cited result. The client never sees a function call it has no handler for.

### After handler, streaming

The raw `function_call` frames must not reach the client, or Codex will attempt to execute a tool it cannot. The plugin's SSE interceptor tracks items by `output_index` and, for an item identified as a `web_search` function call, **suppresses** its frames: `response.output_item.added`, `response.function_call_arguments.delta`, `response.function_call_arguments.done`, `response.output_item.done`. Every other item streams through untouched.

When the suppressed item completes, the plugin runs the search and emits synthetic frames in its place, at the same `output_index`: `response.output_item.added` / `.done` for the `web_search_call`, then `response.output_item.added`, a single `response.output_text.delta`, `response.output_text.done` and `response.output_item.done` for the message. `sonar-pro` does not stream, so the answer text arrives whole — the same synchronous-search limitation `webSearchPlugin` already documents.

Item identification: the `function_call` name is present on the `response.output_item.added` frame, so suppression starts at the first frame of the item and never mid-item.

## Error handling

Inherited from `webSearchPlugin`, deliberately unchanged:

- **Search failure** → empty results, so the model answers gracefully rather than the request failing.
- **Perplexity timeout** → 30 s, then empty results.
- **Unparseable Perplexity response** → warning, fallback text parsing.
- **SAP AI Core unavailable for the search** → the original request passes through untouched; the deployment then rejects the hosted tool as it does today, which is the pre-phase-2 behaviour and not a regression.
- **Mid-stream search failure** → emit the `web_search_call` item with `"status": "failed"` and continue the stream, rather than tearing it down.

## Known limitations (documented, not solved)

- Perplexity's token usage is not merged into the gateway's usage event — same as the Anthropic plugin.
- Through the orchestration fallback, SAP strips Perplexity's `citations` and `search_results`, so URLs in that mode are model-generated and may be wrong. The direct `sonar-pro` deployment path preserves them and is preferred automatically.
- Codex's `multi_agent` namespace tool remains rejected upstream; `--disable multi_agent` is the documented workaround.

## Testing

**Pure units:** hosted-tool → function-tool rewrite (including the drop-empty-`tools` case); pending-search detection by `call_id`; the non-streaming output transform; the streaming frame classifier.

**Streaming:** the phase-1 SSE harness driving suppress-and-inject, including a `function_call_arguments.delta` split across frames, and asserting that no `function_call` frame for `web_search` reaches the client.

**Masking interaction:** a request with PII in the search query, asserting Perplexity receives the masked query and the client receives unmasked output.

**Regression:** an Anthropic `web_search` request through the unchanged `/anthropic/v1/messages` path, proving the `searchExecutor.ts` extraction is inert.

**Acceptance gate — live, not unit tests.** Codex CLI completing a real task through the gateway **without the diagnostic shim**, with a search actually performed and its results visible in the transcript, and payload logs confirming the query went to Perplexity masked. Phase 1's gate proved the route; this one proves the tool.

## Out of scope (later)

`file_search` and any vector store behind it; orchestration emulation of the Responses API for non-deployed models; stateful `previous_response_id` / `store: true`; background mode; merging Perplexity usage into the gateway's token accounting.
