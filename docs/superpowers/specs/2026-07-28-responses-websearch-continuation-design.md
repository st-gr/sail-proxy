# Web-search continuation + content-type matching — Design

**Status:** approved design, ready for implementation planning
**Scope:** Phase 3 of the Responses API work. Closes the two gaps the phase-2 live gate exposed.

## Context

Phase 2 shipped hosted `web_search` emulation as a gateway plugin and unblocked Codex CLI. The live gate proved the mechanism works — real Perplexity citations, no raw `function_call` frames reaching the client, masked queries outbound — but exposed two defects.

### Gap 1: the model never sees the search results

Both handlers **remove** the model's `function_call` from what the client receives, replacing it with a `web_search_call` item and a `message` item containing a formatted result list. The client therefore has nothing to replay, so the model never takes a second pass. Observed live: Codex was asked to *"search the web for the latest Node.js LTS version, then write just that version string to node-lts.txt"*. It searched, received the dump, and stopped — `node-lts.txt` was never written.

A native hosted `web_search` runs the search *inside* the turn and lets the model answer from the results. The phase-2 design assumed the client would replay the pending call on the next turn, which it cannot, because the call was removed. This is a design defect, not an implementation error.

### Gap 2: `application/json; charset=utf-8` bypasses masking entirely

`matchHeader` compares with strict equality (`pluginLoader.ts:332-333`), so the `header:contentTypeJson` hook does not match a charset-suffixed content type. Clients that send one (OkHttp, .NET `JsonContent`, older axios) get **no pseudonymization on any endpoint** — this predates the web-search work and is not specific to it. Phase 2 raised the stakes by adding a second consumer whose gate is a body regex, so on the Responses route such a client could reach the search plugin with masking switched off. That divergence was contained for the two Responses hook entries, but the underlying matching bug and the other 18 entries remain.

## Decisions

1. **Continue the turn with a second deployment call**, rather than fabricating the answer. The model writes the final answer from the search results, as it would with a native hosted tool.
2. **Streaming uses a second streaming call, spliced into the live stream** — true token streaming for the answer. Chosen over a simpler non-streaming continuation because Codex always streams and the answer is the part the user watches.
3. **Fix `matchHeader` to compare media types**, not raw header values. Strictly more requests get masked and none fewer, so the change is safe in the direction that matters.

## Architecture

| Component | Path | Change |
|---|---|---|
| Continuation builder | `services/gateway/src/plugins/webSearch/continuation.ts` (new) | Pure: builds the follow-up request `input` from the original input, the model's output so far, and the search result |
| Plugin | `services/gateway/src/plugins/responsesWebSearchPlugin.ts` | After handler loops; interceptor splices a second stream |
| Controller | `services/gateway/src/controllers/responsesController.ts` | Stashes the upstream call context on the request; accepts usage from continuation calls |
| Header matching | `services/gateway/src/services/pluginLoader.ts` | `matchHeader` compares media type when `equals` carries no parameters |
| Config | `api_config.json` (3 copies) | New `web_search.max_searches_per_request`; the 18 `webSearchPlugin` entries also gate on `header:contentTypeJson` |
| Config accessor | `services/gateway/src/services/configService.ts` | `getWebSearchMaxSearches()` |

### The upstream context

The plugin cannot call the deployment without the URL, auth headers and timeout the controller resolved. The controller therefore stashes them before its first call, on both paths:

```ts
(req as any).__responsesUpstream = { url, headers, timeoutMs, payload };
```

`payload` is the *outbound* body — model alias already swapped, unsupported params stripped, renames applied — so a continuation is `{...payload, input: <extended>}` and inherits every transformation the first call had. This is the one controller change phase 2 deliberately avoided; it is necessary and is confined to assigning the stash and summing usage.

### Continuation input

The Responses API is stateless here (`store: false`), so a continuation must carry the whole conversation:

1. the original `input`, normalised to an item array — a bare string becomes `[{type:'message', role:'user', content:[{type:'input_text', text}]}]`;
2. every output item the model produced in the call being continued, **including `reasoning` items with their encrypted content** when the request asked for `include: ["reasoning.encrypted_content"]`, so the model keeps its chain of thought;
3. the `function_call` for the search, exactly as the model emitted it;
4. the matching `function_call_output` carrying the Perplexity results.

Search results are public web content and are sent to the deployment unmasked; the *query* remains re-masked as phase 2 established.

### Non-streaming flow

The after handler loops: on a `web_search` `function_call` in `output`, run the search (query re-masked), build the continuation, POST it, and repeat on the new output. The client receives `web_search_call` items for each search performed, followed by the final call's real output. On the cap the loop stops and returns the last response with a `failed` `web_search_call`, so the turn is still well-formed.

### The search cap

Each search costs a Perplexity call plus a full deployment round trip, so the bound is both a termination guarantee and a cost control — and the right value differs per deployment. It is therefore configurable:

```jsonc
"web_search": {
  "max_searches_per_request": 3
}
```

Read through a `configService.getWebSearchMaxSearches()` accessor shaped like the existing `getUnsupportedParams` / `getSupportsResponsesApi`: absent config yields the built-in default of **3**, so installs whose `api_config.json` predates the key are unaffected. The value is clamped to 1–10 — a non-numeric, zero, negative or absurd entry falls back to the default rather than disabling the bound, because the cap is the loop's termination guarantee and must never be configurable away.

### Streaming flow

1. Call #1 streams. `web_search` `function_call` frames are suppressed as they are today, and call #1's `response.completed` is **held**, not forwarded — it is not the final frame.
2. The search runs; a synthetic `web_search_call` item is emitted at the suppressed index.
3. Call #2 opens with the continuation payload, streaming. Its `response.created` and `response.in_progress` are dropped (the client already saw those), and its `output_index` values are offset to continue after the highest index the client has seen.
4. Call #2's frames pass through. If it emits another `web_search` call, the cycle repeats, bounded as above.
5. The final call's `response.completed` becomes the client's, with `response.output` rewritten to include the earlier `web_search_call` items and `usage` summed across every deployment call.

The existing queue-and-defer machinery covers the pause: writes arriving during a continuation are queued and `res.end` deferred, exactly as during a search.

### Usage

Every deployment call's `usage` is summed. The plugin accumulates onto `req.__responsesExtraUsage`, and the controller adds it to the metrics it already emits, so one client request yields one usage event with the true total.

### Header matching

`matchHeader` gains media-type comparison: when `hookDef.equals` contains no `;`, the incoming header is compared on its media type alone — everything before the first `;`, trimmed and lowercased. `application/json; charset=utf-8` then matches `application/json`, while a definition that deliberately specifies parameters keeps exact-match semantics. This affects every endpoint using `header:contentTypeJson`; the effect is that charset-suffixed clients start being masked.

Separately, the 18 `webSearchPlugin` hook entries gain `header:contentTypeJson` alongside `tools:hasWebSearch`, so masking and web search can never diverge again on any endpoint. `match` arrays are AND, so this narrows.

## Error handling

- **Continuation call fails** → emit the `web_search_call` as `failed` and return the response already in hand; never fail the whole turn.
- **Search fails** → unchanged from phase 2: `failed` status, empty results, continuation still runs so the model can say the search was unavailable.
- **Cap reached** → stop looping, return the last real response, log a warning naming the configured limit.
- **Client disconnects mid-continuation** → abort the in-flight continuation call, as the controller already does for the primary stream.

## Testing

**Pure units:** continuation input construction — string input normalised, reasoning items preserved, `function_call`/`function_call_output` paired by `call_id`; media-type matching including exact-match preservation when the definition has parameters; the cap accessor's default, clamping and rejection of non-numeric values.

**Non-streaming:** a search followed by a continuation whose output is the model's answer; the loop cap; a failed continuation.

**Streaming:** frame sequence across the splice — no duplicate `response.created`, offset `output_index`, a single final `response.completed` with summed usage; a second search in the continuation.

**Masking:** the query stays masked across *both* calls, and the continuation payload sent to the deployment carries masked user data.

**Regression:** the phase-2 suites must stay green; Anthropic and Bedrock unaffected by the header change except that charset clients now get masked.

**Acceptance gate — live.** Codex CLI, no shim, must *complete* the task that failed the phase-2 gate: search for the Node.js LTS version and write it to a file. Plus a charset-suffixed `Content-Type` request confirming masking now runs.

## Out of scope

`file_search`; orchestration emulation for non-deployed models; stateful `previous_response_id`; background mode; parallelising the continuation searches.
