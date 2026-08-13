# Responses API compliance capture — what the real endpoint sends

`responses-api-compliance-capture.json` holds shapes from a real codex 0.147.0 session against
`chatgpt.com/backend-api/codex/responses`, intercepted with mitmproxy: 16 turns, 2773 WebSocket
frames, driven through a multi-step coding task (read two files, edit one, run a verification
command), one declined approval, one long free-text answer, and a `/compact`.

Opaque blobs (`encrypted_content`, `prompt_cache_key`, `client_metadata`) are redacted. **Every
field name in the file is real** — the same rule the `orchestration/` fixtures follow.

**Caveat, now largely discharged:** the bulk of this was captured from ChatGPT's Codex backend.
The public `api.openai.com/v1/responses` has since been captured directly with an API key (see the
last section) and **agrees on every shape checked** — same `usage` field names, same error envelope,
same 33 input item types. Anything prefixed `codex.` remains backend-specific.

## The finding that affects us today

The real `usage` object, verbatim:

```json
{
  "input_tokens": 11438,
  "input_tokens_details": { "cache_write_tokens": 0, "cached_tokens": 0 },
  "output_tokens": 0,
  "output_tokens_details": { "reasoning_tokens": 0 },
  "total_tokens": 11438
}
```

The cache-write field is named **`cache_write_tokens`**. Our gateway emitted and read
**`cache_creation_tokens`** in that same position — `hostedTool/engine.ts:713`, `:801`, `:2206`,
`:2379`, plus the bridge translators — and nothing in `src/` mentioned `cache_write_tokens`. So a
client parsing our `/responses` output by the real API's field names saw no cache-write figure at
all. `cached_tokens` matched; only the write side diverged.

That name entered our code during the usage-accounting audit, most likely adapted from Anthropic's
`cache_creation_input_tokens`, and no capture ever justified it. `total_tokens` here equals
`input_tokens + output_tokens`, consistent with the inclusive-input convention the audit settled on.

**Fixed.** Every client-visible `input_tokens_details` emission now writes `cache_write_tokens`,
and every read of an upstream Responses payload's `input_tokens_details` accepts the real name
first, falling back to the legacy `cache_creation_tokens` for a replayed history or an upstream
that has not caught up — `readCacheWriteTokens` in `usageFolding.ts`. SAP orchestration's raw
envelope (`prompt_tokens_details.cache_creation_tokens`, a different, genuinely-named field) and
the `__responsesExtraUsage` accumulator's internal-only key are unaffected; see those files' own
comments for why.

## Items we do not currently produce

- **~~`reasoning`~~ — NOW PRODUCED.** See "Reasoning is now produced" below; this entry is kept so
  the change is visible rather than silently edited away.
- **`compaction`** — `{id: "cmp_…", type: "compaction", encrypted_content: "gAAAAA…"}`, emitted by
  the server as an output item. The client triggers it by sending an input item that is exactly
  `{"type": "compaction_trigger"}`.

Both matter because the bridge's `requestTranslator` throws `UnsupportedInputItemError` on unknown
input item types, so a client replaying a compaction-bearing history would be rejected outright.

**Update — the compaction half of that is fixed.** `compaction` and `compaction_trigger` are now
DROPPED by the bridge rather than throwing, alongside `reasoning`, in
`requestTranslator.ts`'s `DROPPED_ITEM_TYPES`. The deployed route accepts both natively (measured:
`compaction_trigger` returns 200 and answers with a `compaction` output item), so this closed a
real divergence — and, because a `compaction` item once returned is replayed on every later turn,
throwing cost the whole session rather than one turn. See
[`compaction-parity-verification.md`](./compaction-parity-verification.md), which also records
what that change did NOT prove: codex against this gateway compacts client-side and never sends
these items, so the fix is defensive parity rather than a live bug fix.

The bridge still produces no `compaction` OUTPUT item.

## Reasoning is now produced

The orchestration route emits a `reasoning` output item, and carries the client's `reasoning.effort`
upstream. Full measurements in
[`../orchestration/reasoning-probe-results.md`](../orchestration/reasoning-probe-results.md).

**Input side — `reasoning.effort` → SAP's thinking parameter,** via an explicit per-model table
(`utils/reasoningSupport.ts`). The table is explicit rather than a version rule because the measured
boundary is ragged: 4.5 takes `budget_tokens` only, 4.6 takes both shapes, **4.7 accepts the adaptive
shape and never actually thinks**, 4.8 takes adaptive only. The resolver emits nothing — never an
error — in four measured cases where thinking would break a request that works today:
`temperature != 1` or `top_p < 0.95`, `tool_choice: 'required'`, an explicit `max_output_tokens`
below 2048, and any model not measured to think. A decline is logged with its reason at
`responsesController.ts`.

**Output side — `reasoning_content` → a `reasoning` item,** ahead of the message at `output_index 0`,
the same position the deployed route uses. The shape deliberately differs from the deployed route's:

| | deployed | orchestration |
|---|---|---|
| `content` | `[]` always | `[]` |
| `summary` | `[]` always | `[{type:'summary_text', text: <plaintext reasoning>}]` |
| `encrypted_content` | `gAAAAA…`, 908–1272 chars | **absent** |

Every reasoning token on the deployed route lives inside that opaque blob, which is OpenAI's own
envelope format and cannot be manufactured — copying the shape byte for byte would emit an item
carrying nothing. Orchestration uniquely exposes the reasoning in plaintext, so it goes in `summary`.
SAP's Anthropic `signature` is dropped rather than placed in `encrypted_content`, which means
something else.

Streaming emits the incremental frames too — `response.reasoning_summary_part.added`,
`response.reasoning_summary_text.delta` per chunk, `.done`, `response.reasoning_summary_part.done` —
closing the summary before the item that owns it.

**What this does NOT do: make codex display it.** codex 0.147.0 ingests the item (it replays our own
`summary_text` back on the next turn) but renders nothing, sampled throughout a turn as well as
after. Established by positive control rather than assumed: driven against **real
`api.openai.com`** through a proxy, on `gpt-5.5`, codex shows no thinking section either — what looks
like one is the model writing "Reasoning:" inside its own answer. The binary carries the parse-side
event variants but no display label, and every model in its shipped catalogue declares
`default_reasoning_summary: "none"`. This is a client limitation, not a gateway gap.

`reasoning` INPUT items are still dropped, and that is now measured-safe rather than assumed: a
replayed tool history with no thinking block on the assistant turn completes on 4.5-sonnet, 4.6-opus
and 4.8-opus, streaming and not.

## Frame fields we may not emit

A single `response.output_text.delta` carries: `content_index`, `delta`, `item_id`, `logprobs`,
`obfuscation`, `output_index`, `safety_buffering`, `sequence_number`, `type`. Any client validating
strictly against that set will notice omissions in our synthesised frames.

Full server vocabulary observed, with counts, is in the JSON — the streaming events are
`response.created`, `.in_progress`, `.output_item.added/.done`, `.content_part.added/.done`,
`.output_text.delta/.done`, `.custom_tool_call_input.delta/.done`, `.completed`, plus the
backend-specific `codex.rate_limits`, `codex.response.metadata` and `responsesapi.websocket_timing`.

## What the client sets on a request

`response.create` carries `model`, `input`, `tool_choice`, `parallel_tool_calls`, `reasoning`
(`{effort, context}` — note `context: "all_turns"`), `store: false`, `stream: true`, `include`,
`prompt_cache_key`, `text`, `generate`, `client_metadata`. Note `reasoning.effort` **is** sent here
(`"low"`), unlike against our gateway where codex sends only `{summary: "auto"}` — see
`../codex-reasoning/effort-evidence.md`.

## Not captured, and honestly so

- **Errors.** No 4xx/5xx occurred, so the streaming failure shape (a `response.failed` event, an
  `error` event, or a dropped connection) is still unknown.
- **Mid-stream failure.** Every error observed surfaced *before* the stream opened, as an HTTP 400.
  A failure occurring after `response.created` — whether it arrives as a `response.failed` event or
  a dropped connection — is still unobserved.

Those two are the remaining gaps for a future capture, and the streaming failure shape is the one
our error normalisation would most benefit from. Cancellation WAS subsequently captured — see the
section below.

## Cancellation — captured, and it is a non-event on the wire

Previously listed as an open gap; now measured. A human pressed Escape mid-stream (the TUI showed
*"Conversation interrupted — tell the model what to do differently"*), and the capture shows:

- **The client sends nothing.** Across the whole socket the only client frame type is
  `response.create`. There is no `response.cancel` or abort frame.
- **No HTTP side channel.** The only new flows during the cancellation were analytics, OTLP
  metrics, a search call and a models refresh — no cancel endpoint.
- **No terminal server frame.** The stream simply stops mid `response.output_text.delta`. The
  socket carried 11 `response.created` against 10 `response.completed`: exactly one response never
  terminated.
- **The socket stays open** — `close_code`, `close_reason` and `timestamp_end` are all null.

So cancellation is purely client-side: codex stops rendering and abandons the response. The server
is never told.

**Why this matters for the gateway.** An abandoned turn produces generated tokens but **no
terminal frame and therefore no usage report**. Our `/responses` path emits its usage event when
the stream finalises, so a client that disconnects mid-stream — the HTTP equivalent of this — may
produce tokens the gateway never bills, or a usage event assembled from a partial stream. Neither
behaviour has been tested. That is a direct follow-up to the usage-accounting audit and is worth a
deliberate test: abort an HTTP `/responses` request mid-stream and check what
`emitUsageEvent` does.

## Mid-stream abort against OUR gateway — measured

The follow-up the section above called for. Method: subscribe to the `usage-events` Valkey
channel, fire a streaming `POST /openai/v1/responses`, kill the client mid-flight, and watch what
`emitUsageEvent` does. A completed request was run first as a control.

| Run | SSE lines to client | usage event | status | inputTokens | outputTokens |
|---|---|---|---|---|---|
| control (allowed to finish) | 37 | yes | 200 | 19 | 33 |
| **aborted after ~4s** | **240** | **yes** | **499** | **0** | **0** |

**The good news:** the handler does not leak and the event is not lost. The controller's
`res.on('close')` guard fires, the upstream is destroyed, the promise settles via `'close'`, and a
usage event is emitted with status **499** — the gateway already models "client closed request".
The comment at `responsesController.ts:691-697` claiming the disconnect case would otherwise
"silently drop the usage event for the whole request" is accurate, and the guard works.

**The hole:** that event records **zero tokens** for a turn that really generated content. The
aborted stream carried 236 `response.output_text.delta` frames — roughly 1,258 characters, on the
order of 300 output tokens — and none of it is billed.

The cause is structural, not a bug in the fold: on this route usage arrives only in the terminal
`response.completed` frame. The capture confirms it — **0** `response.completed` frames in the
aborted stream. When the client goes away the upstream is destroyed, that frame never arrives, and
there is nothing to record. It is the mirror image of the over-billing defects the 2026-08-07
usage-accounting audit fixed: same route, opposite sign.

Options, none yet chosen:

1. **Accept and document.** Destroying the upstream may also stop generation provider-side, so the
   real unbilled amount may be smaller than what was streamed. Cheapest, and honest if written down.
2. **Let the upstream finish server-side** rather than destroying it, and record usage when the
   terminal frame arrives even though no client is listening. Bills correctly, but deliberately
   keeps paying for a turn nobody wants — and directly contradicts the existing
   `abortResponsesStreamContinuation` design, which exists to *avoid* paid work for abandoned
   requests.
3. **Estimate from the streamed deltas** when a terminal frame never arrives. Approximate, and the
   audit's discipline is that measured numbers beat estimates — an estimated usage row would be the
   first non-measured figure in the pipeline.

Worth noting the client side compounds it: codex cancels without telling the server at all (see
above), so on that path the upstream is not even destroyed — it keeps generating into a socket
nobody reads.

## Error envelopes and the authoritative input-item list

The `/backend-api/codex/responses` endpoint also accepts a plain **HTTP POST with SSE** — it is not
WebSocket-only — which made these probes possible without driving the TUI.

**Two distinct error shapes on the same endpoint:**

- A backend gateway error, bare: `{"detail": "Unsupported parameter: max_output_tokens"}` (HTTP 400),
  also seen as `{"detail": "The 'gpt-9-…' model is not supported when using Codex with a ChatGPT account."}`
- An OpenAI-style validation error: `{"error": {"type": "invalid_request_error", "code": "invalid_value",
  "param": "input[0]", "message": "…"}}` (HTTP 400)

A normaliser that only understands `error.message` will render the first shape as an empty error.

**`max_output_tokens` is rejected outright on this backend** ("Unsupported parameter"), which is why
`response.incomplete` could not be provoked and remains uncaptured.

**The authoritative list of supported input item types (33)**, returned verbatim by the validation
error, is now in the JSON. It matters because the bridge's `requestTranslator` throws
`UnsupportedInputItemError` on anything it does not recognise, and it currently handles a small
subset:

```
additional_tools, agent_message, apply_patch_call, apply_patch_call_output, code_interpreter_call,
compaction, compaction_trigger, computer_call, computer_call_output, custom_tool_call,
custom_tool_call_output, file_search_call, function_call, function_call_output,
image_generation_call, item_reference, local_shell_call, local_shell_call_output,
mcp_approval_request, mcp_approval_response, mcp_call, mcp_list_tools, message, multi_agent_call,
multi_agent_call_output, program, program_output, reasoning, shell_call, shell_call_output,
tool_search_call, tool_search_output, web_search_call
```

## The public API — `api.openai.com/v1/responses`, captured directly

Captured with an API key rather than through the ChatGPT backend, so this is the authoritative
surface. Model `gpt-5.4`.

**It confirms the field name this repo's fix rests on.** Verbatim:

```json
"usage": {
  "input_tokens": 8,
  "input_tokens_details": { "cache_write_tokens": 0, "cached_tokens": 0 },
  "output_tokens": 5,
  "output_tokens_details": { "reasoning_tokens": 0 },
  "total_tokens": 13
}
```

`cache_write_tokens` is used by the public API, by the ChatGPT backend, **and** by SAP's deployed
`gpt-5.3-codex` on our own gateway. Three independent sources, one name. The gateway's former
`cache_creation_tokens` on this route was ours alone.

**`response.incomplete`, finally captured** — the ChatGPT backend rejects `max_output_tokens`
outright, but the public API honours it:

```json
{ "type": "response.incomplete",
  "response": { "status": "incomplete",
                "incomplete_details": { "reason": "max_output_tokens" },
                "usage": { "input_tokens": 19, "output_tokens": 16, "total_tokens": 35, … } } }
```

Note the terminal event is **`response.incomplete`**, not `response.completed` with a different
status — a client switching on the event name alone would miss it. Usage is still reported.

**Error envelopes are a single consistent shape** here, unlike the ChatGPT backend's second bare
`{"detail": …}` form:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "param": "temperature",
             "code": "decimal_above_max_value" } }
```

with `code` varying by cause — `model_not_found` for an unknown model, `invalid_value` with
`param: "input[0]"` for a bad item type. All HTTP 400, all pre-stream.

**The 33 supported input item types are identical** to the ChatGPT backend's list, which makes that
list trustworthy as the real API contract rather than a backend quirk.

A `response.completed` carries 35 top-level keys, including several we never emit —
`prompt_cache_key`, `prompt_cache_retention`, `service_tier`, `tool_usage`, `truncation`,
`safety_identifier`, `max_tool_calls`, `background`. Full list in the JSON.

## `custom` is now translated on both routes — and the asymmetry that motivated it

Both SAP routes now accept a `custom` tool declaration (`apply_patch`, the freeform tool this
file's own captures document above): `responsesCustomToolsPlugin` rewrites it to `function`
outbound and restores `custom_tool_call` shapes inbound. See
`../../../src/plugins/responsesCustomToolsPlugin.md` for the plugin itself; this note records the
measured evidence that motivated it, because the asymmetry it exposes between the two routes is
the thing a future reader is most likely to trip over.

Before translation, both routes rejected the `custom` declaration outright, with different
wording (measured 2026-08-11):

- deployed (`gpt-5.3-codex`): `The following tool is not allowed for model 'gpt-5.3-codex': custom.`
- orchestration (`anthropic--claude-4.8-opus`): `400 - Request Body: 'custom' is not one of ['function'] - 'config.modules.prompt_templating.prompt.tools[4].type'`

The trailing JSON pointer (`tools[4].type`) names the INDEX of the offending entry in the
client's `tools` array for that specific capture, not a constant — it moves with wherever the
`custom` tool sat in the list the client sent that request. The stable, capture-independent part
of the message is `'custom' is not one of ['function']`.

**The asymmetry is on the replay side, not the declaration side.** Codex replays the whole
conversation each turn (`store: false`), so once `apply_patch` has been called once, every later
request in that session also carries `custom_tool_call` / `custom_tool_call_output` items in
`input`. The two routes did not agree there even though they agreed on rejecting the
declaration:

| | replayed `custom_tool_call` history items (before translation) |
|---|---|
| deployed (`gpt-5.3-codex`) | **accepted natively**, `status=completed` — the deployed route never objected to the item type, only to the tool declaration |
| orchestration (`anthropic--claude-4.8-opus`) | rejected: `Unsupported Responses input item type: custom_tool_call` |

So the deployed route's failure mode, pre-translation, was narrower than orchestration's: it
would have accepted a turn with `apply_patch` already called, and only failed on the *next*
turn's tool list (still `custom`). Orchestration failed on both the declaration and any replayed
call in the same way. This is why `translateCustomCallItems` converts replayed history
unconditionally on both routes rather than being gated to orchestration alone — after
translation, the deployed route's own native acceptance of `custom_tool_call` items stops being
usable anyway, because the tool is now declared as `function` and a `custom_tool_call` in
history no longer matches its own declaration.

This section records pre-translation baseline behavior for `custom`, captured the same way the
`custom` and `tool_search` rejections in `../codex-reasoning/effort-evidence.md` were. It has not
been re-measured against the shipped translation with a live Codex session — that is Task 9 of
`docs/superpowers/plans/2026-08-11-custom-tool-translation.md`, not yet run as of this writing.

## The 33-type map — deployed vs orchestration, derived 2026-08-11

Workstream 4 of `docs/superpowers/plans/2026-08-11-parity-workstreams-3-4.md`. Every cell below was
derived by reading the code as it stands on this date, not from earlier notes in this file — the
accounting moved twice in one day, so nothing here is inherited. The 33 types are the list already
recorded above, verbatim from the validation error.

**Sources read for this section**, all current as of this writing:
`src/responses/orchestrationBridge/requestTranslator.ts`,
`src/plugins/customTools/adapter.ts`, `src/plugins/toolSearch/adapter.ts`,
`src/plugins/responsesCustomToolsPlugin.ts` (the plugin that calls both adapters),
`src/plugins/hostedTool/engine.ts` and `registry.ts`, `src/controllers/responsesController.ts`,
`src/responses/orchestrationBridge/responseTranslator.ts`, plus every test file named in the table
and 330 real `*_00_original_responses_request.json` payload-log captures under
`services/gateway/logs/payloads/` (read for item `type` values and field names only — never for
conversation content, per the evidence rule below).

**How to read the Deployed and Orchestration columns.** `responsesController.ts:715`
(`const payload: any = { ...req.body };`) does no item inspection at all — whatever shape `req.body`
has by the time it reaches that line is what goes upstream. But the shared plugin layer
(`executeBeforePlugins`, called at `responsesController.ts:703-706`, **before** the orchestration/
native branch at `:708`) runs identically on both routes. So a type one of those plugins rewrites is
already rewritten by the time either route sees it — "forwarded" on the Deployed side means
"whatever's in `req.body` after the plugin layer has run," **not** "byte-for-byte identical to what
the client sent." That qualifier matters because one of those plugins is pseudonymization, covered
below, and it is active on nearly every real request.

Three plugins rewrite an item's **TYPE** in `body.input` before the bridge or the deployed forward:

| Plugin | Item types neutralised | Condition |
|---|---|---|
| `customTools/adapter.ts` (`translateCustomCallItems`) | `custom_tool_call`, `custom_tool_call_output` → `function_call`/`function_call_output` | **Unconditional.** Called at `responsesCustomToolsPlugin.ts:455`, before the mode check. The `custom_tools.mode` switch (`translate`/`strip`) governs only the tool **declaration** (`translateCustomTools`, mode-gated at `responsesCustomToolsPlugin.ts:471`) — replayed history is converted either way, because a turn can replay a call from an earlier turn when the tool was still declared. Pinned: `responses-custom-tools-plugin.test.ts:102-111` (still converts in strip mode). |
| `toolSearch/adapter.ts` (`translateToolSearchOutputItems`) | `tool_search_call`, `tool_search_output` → `function_call`/`function_call_output` | **Unconditional**, same reasoning. Called at `responsesCustomToolsPlugin.ts:468`, before the mode-gated declaration translation at `:469`. Pinned: `responses-tool-search-plugin.test.ts:102-115`. |
| `hostedTool/engine.ts` (replayed-item loop, `:1978-2027`) | `web_search_call`, `file_search_call` → `function_call`/`function_call_output` | **Conditional — the one that is NOT visible if flattened to "handled."** The entire before-handler returns early at `engine.ts:1916` (`if (!Array.isArray(body.tools) \|\| !body.tools.some(t => descriptorForHostedTool(t))) return { stop: false };`) unless **this turn's own `body.tools`** declares `web_search` or `file_search`. A replay in a turn that no longer declares the hosted tool skips the whole handler, including the replay loop, and the raw item reaches the bridge. No test exercises this specific case (see Task 6 below). |

**A fourth plugin rewrites TEXT, not TYPE — and it is easy to miss because it never changes a row
in the table below.** The pseudonymization plugin runs in the same `executeBeforePlugins` pass
(`responsesController.ts:703-706`), and for a Responses body it is **type-agnostic**: it walks
every item in `body.input` regardless of `item.type` and masks whatever text it finds —
`content[].text`, `content[].refusal`, `arguments`, `output` (both the plain-string and the
array-of-content-parts shapes), `input`, and `summary[].text`
(`src/utils/responsesBodyAdapter.ts:18-87`, `extractResponsesInputTexts`/`setResponsesInputText`,
called from `src/plugins/pseudonymization/index.ts:412-420`). Masking is force-enabled for this
endpoint when configured that way — `responsesController.ts:694-701` returns 503 rather than serve
the route unmasked if the hook is missing — so in a deployment with masking on, essentially every
row's text has already been rewritten, on **both** routes, before the bridge or the deployed
forward ever sees it.

**This does not affect the type-level routing map below.** Masking rewrites the *value* of a text
field in place; it never touches `item.type`, never adds or removes an item, and runs identically
regardless of route. So a `message` item is still a `message` item, a `custom_tool_call` is still
whatever the customTools plugin turned it into, and every Divergence/Evidenced/Pinned cell below is
about item TYPE, which masking cannot change. "Forwarded" in the table means "forwarded with its
type unchanged" — not "forwarded with its text unchanged."

### The table

| Type | Deployed | Orchestration | Divergence lives at | Evidenced (real client)? | Pinned by a test? |
|---|---|---|---|---|---|
| `message` | forwarded | translated to a chat message | `requestTranslator.ts:126-129` | **Yes** — 288/330 gateway payload-log captures; also `responses-api-compliance-capture.json` (19 client-sent occurrences) | Yes — `orchestration-request-translator.test.ts:28-35,54-60` |
| `function_call` | forwarded | translated to an assistant `tool_calls` message | `requestTranslator.ts:131-142` | **Yes** — 112/330 gateway payload-log captures | Yes — `:39-52` |
| `function_call_output` | forwarded | translated to a `role:'tool'` message, content forced to a string | `requestTranslator.ts:144-156` | **Yes** — 112/330 gateway payload-log captures | Yes — `:63-81` |
| `reasoning` | forwarded | INPUT still **dropped** (measured safe: a replayed tool history with no thinking block completes on 4.5-sonnet/4.6-opus/4.8-opus). OUTPUT is now **produced** — `summary_text` carrying plaintext reasoning, at `output_index 0`, plus the streaming `reasoning_summary_*` frames | drop: `requestTranslator.ts` `DROPPED_ITEM_TYPES`; emit: `responseTranslator.ts` `reasoningOutputItem`, `streamTranslator.ts`; effort→thinking: `utils/reasoningSupport.ts` | **Yes** — 635 replayed items in the corpus, always `['encrypted_content','id','summary','type']`; 243/330 requests set `include: ["reasoning.encrypted_content"]` | Yes — drop pinned; emit pinned in `orchestration-response-translator.test.ts` and `orchestration-stream-translator.test.ts` |
| `compaction` | forwarded | **dropped** | `requestTranslator.ts:94-98,124` | **Yes** — 4/330 gateway payload-log captures; the shape itself (`compaction_item` key) is recorded separately in `responses-api-compliance-capture.json`, not the payload logs; also `compaction-parity-verification.md` | Yes (drop pinned) — `:113-134` |
| `compaction_trigger` | forwarded | **dropped** | same as above | **Yes** — 4/330 gateway payload-log captures; also `responses-api-compliance-capture.json` | Yes (drop pinned) — `:96-134` |
| `custom_tool_call` | forwarded as a translated `function_call` (plugin rewrite, unconditional) | never reaches the bridge as this type — arrives already converted | `responsesCustomToolsPlugin.ts:455`; adapter at `customTools/adapter.ts:184-195` | **Yes** — 36/330 gateway payload-log captures (40 occurrences, as replayed history); live turn measured in `apply-patch-translation-verification.md:40` | Yes — `responses-custom-tools-plugin.test.ts:28-34,102-111`; `custom-tools-adapter.test.ts` |
| `custom_tool_call_output` | forwarded as a translated `function_call_output` | same | `customTools/adapter.ts:197-206` | **Yes** — 36/330 gateway payload-log captures (40 occurrences); also `responses-api-compliance-capture.json` (8 occurrences) and `gpt-5.6-sol-custom-tool-capture.json` | Yes — `custom-tools-adapter.test.ts:109-136` |
| `tool_search_call` | forwarded as a translated `function_call` (unconditional) | never reaches the bridge as this type | `responsesCustomToolsPlugin.ts:468`; adapter at `toolSearch/adapter.ts:252-269` | **Yes** — 90/330 gateway payload-log captures (1244 occurrences) | Yes — `responses-tool-search-plugin.test.ts:102-115` |
| `tool_search_output` | forwarded as a translated `function_call_output` | same | `toolSearch/adapter.ts:271-282` | **Yes** — 90/330 gateway payload-log captures (1244 occurrences); also `tool-search-capture.md` | Yes — `responses-tool-search-plugin.test.ts:102-115` |
| `web_search_call` | forwarded as a translated `function_call` **only if this turn's `tools` also declares `web_search`**; otherwise forwarded with its type unchanged | **if declared this turn:** neutralised, reaches the bridge as `function_call`. **if NOT declared this turn (a replay in a turn that dropped the tool):** reaches the bridge unmodified and **throws** `UnsupportedInputItemError` → 400 | `hostedTool/engine.ts:1916` (the gate) | **Yes** — 17/330 gateway payload-log captures (46 occurrences) — all captured turns still declared the tool, so the "not declared" branch is unobserved as well as unpinned | The "declared" path: yes — `hosted-tool-replay-translation.test.ts:9-22,62-73`, `hosted-tool-replay-wiring.test.ts:384-478`. The "not declared this turn" gap: **no test** — open, see Task 6 |
| `file_search_call` | same conditional shape as `web_search_call`, gated on `file_search` | same conditional shape | same | **No** — zero occurrences across 330 gateway payload-log captures; `hosted-tool-item-shapes.md` deliberately did not elicit one (needs a vector store) | Same partial coverage as `web_search_call` (declared path only) |
| `additional_tools` | forwarded | throws `UnsupportedInputItemError` → 400 (not in `DROPPED_ITEM_TYPES`, no special handling) | `requestTranslator.ts:158` | **Yes, but count-only** — 5 occurrences in `responses-api-compliance-capture.json`'s `client_input_item_type_counts`; no field-level shape was recorded there, and it never appears in any of the 330 gateway payload-log captures | No — not individually named in any test |
| `agent_message` | forwarded | throws | `requestTranslator.ts:158` | **No** — no capture anywhere in this repo | No |
| `apply_patch_call` | forwarded | throws | `requestTranslator.ts:158` | **No** | No |
| `apply_patch_call_output` | forwarded | throws | `requestTranslator.ts:158` | **No** | No |
| `code_interpreter_call` | forwarded | throws | `requestTranslator.ts:158` | **Yes, golden shape only** — captured directly from `api.openai.com` by declaring `code_interpreter`, `hosted-tool-item-shapes.md`; never seen from any client of this gateway | No |
| `computer_call` | forwarded | throws | `requestTranslator.ts:158` | **No item shape** — the matching tool declaration (`computer_use_preview`) was refused **by model** ("Tool 'computer_use_preview' is not supported with gpt-5.5.", `hosted-tool-item-shapes.md`), so the item was never produced. Model-gated, not dead — a different model may accept it | No |
| `computer_call_output` | forwarded | throws | `requestTranslator.ts:158` | same as `computer_call` | No |
| `image_generation_call` | forwarded | throws | `requestTranslator.ts:158` | **No** — `image_generation` was accepted as a declaration but the prompt gave the model no reason to generate an image, so no call item was produced; forcing one costs real image generation and was declined (`hosted-tool-item-shapes.md`) | Yes, as the generic "unknown type throws" case — `orchestration-request-translator.test.ts:146-155` |
| `item_reference` | forwarded | throws | `requestTranslator.ts:158` | **No** — requires `store: true`, and none of the 330 gateway payload-log captures ever sets it: 255/330 set `store: false` explicitly, the other 75 omit the field, but `store: true` appears zero times | No |
| `local_shell_call` | forwarded | throws | `requestTranslator.ts:158` | **Proven UNAVAILABLE, not merely unobserved** — declaring `local_shell` was refused outright: "The local_shell tool is no longer supported." (`hosted-tool-item-shapes.md`). Dead on the current API, not model-gated | No |
| `local_shell_call_output` | forwarded | throws | `requestTranslator.ts:158` | same as `local_shell_call` — dead | No |
| `mcp_approval_request` | forwarded | throws | `requestTranslator.ts:158` | **Yes, golden shape** — `hosted-tool-item-shapes.md`, captured against a real `mcp` server declaration with `require_approval: "always"` | No |
| `mcp_approval_response` | forwarded | throws | `requestTranslator.ts:158` | **No** — it is a CLIENT-sent item; eliciting the server-sent `mcp_approval_request` above did not produce one, and hand-authoring a response would be inventing a shape, which `hosted-tool-item-shapes.md` explicitly declined to do | No |
| `mcp_call` | forwarded | throws | `requestTranslator.ts:158` | **Yes, golden shape** — `hosted-tool-item-shapes.md`. Note: `arguments` is a JSON **string** here (unlike `tool_search_call.arguments`, an object) and `output` is a plain string (unlike `custom_tool_call_output.output`, an array of content parts) — see the shape-disagreements note below | No |
| `mcp_list_tools` | forwarded | throws | `requestTranslator.ts:158` | **Yes, golden shape** — `hosted-tool-item-shapes.md` | No |
| `multi_agent_call` | forwarded | throws | `requestTranslator.ts:158` | **No** | No |
| `multi_agent_call_output` | forwarded | throws | `requestTranslator.ts:158` | **No** | No |
| `program` | forwarded | throws | `requestTranslator.ts:158` | **No** | No |
| `program_output` | forwarded | throws | `requestTranslator.ts:158` | **No** | No |
| `shell_call` | forwarded | throws | `requestTranslator.ts:158` | **No** | No |
| `shell_call_output` | forwarded | throws | `requestTranslator.ts:158` | **No** | No |

**Counts.** This table classifies INPUT handling; one type now also has an output counterpart —
`reasoning` is still dropped on the way in, but the bridge now PRODUCES a `reasoning` output item
(see "Reasoning is now produced" above), so its row is no longer symmetric.

Of the 33: 3 are translated by the bridge itself (`message`, `function_call`,
`function_call_output`); 3 are accepted and silently dropped (`reasoning`, `compaction`,
`compaction_trigger`); 4 are neutralised unconditionally by a plugin before the bridge ever sees
them (`custom_tool_call`/`_output`, `tool_search_call`/`_output`); 2 are neutralised only
conditionally, on whether this turn's own `tools` still declares the matching hosted tool
(`web_search_call`, `file_search_call`); the remaining 21 throw `UnsupportedInputItemError` on
orchestration unconditionally. All 33 are forwarded on the deployed route with their type intact —
the controller itself never inspects an item — but not necessarily byte-for-byte: pseudonymization
masking may already have rewritten text inside them, on both routes, before either sees the body.

**Evidenced with a citation: 16 of 33** — `message`, `function_call`, `function_call_output`,
`reasoning`, `compaction`, `compaction_trigger`, `custom_tool_call`, `custom_tool_call_output`,
`tool_search_call`, `tool_search_output`, `web_search_call`, `additional_tools` (count-only, no
shape), `code_interpreter_call`, `mcp_list_tools`, `mcp_call`, `mcp_approval_request`.

**Proven unavailable/model-gated rather than observed: 4** — `local_shell_call`,
`local_shell_call_output` (the `local_shell` tool is dead on the current API), `computer_call`,
`computer_call_output` (the `computer_use_preview` tool is refused for `gpt-5.5` by name, so
model-gated rather than dead). Two findings, four types, because each finding covers a call/output
pair.

**Unobserved — no citation at all: the remaining 13** — `agent_message`, `apply_patch_call`,
`apply_patch_call_output`, `file_search_call`, `image_generation_call`, `item_reference`,
`mcp_approval_response`, `multi_agent_call`, `multi_agent_call_output`, `program`,
`program_output`, `shell_call`, `shell_call_output`. Listed as supported by the API's own
validation-error vocabulary; never seen from any client this repo has captured. (16 + 4 + 13 = 33.)

**Pinned by a test at the type-specific level: 13 of 33** — `message`, `function_call`,
`function_call_output`, `reasoning`, `compaction`, `compaction_trigger`, `custom_tool_call`,
`custom_tool_call_output`, `tool_search_call`, `tool_search_output`, `image_generation_call` (as
the generic-throw stand-in), and `web_search_call`/`file_search_call` for the "declared this turn"
path only — their "not declared" gap is unpinned by any test. The other 20 throw only through the
generic "everything else throws" code path, itself demonstrated (via `image_generation_call` and,
at the bridge-unit level, `tool_search_call`) but not exercised under each of those 20 types' own
name.

### Two shape disagreements a reader would assume from a sibling

Both fell out of the golden-capture pass in `hosted-tool-item-shapes.md` and are easy to get
backwards from intuition:

- **`mcp_call.arguments` is a JSON STRING.** `tool_search_call.arguments` — the other hosted
  mechanism with an `arguments` field — is a plain **object**. The two disagree with each other, so
  neither can be inferred from the other.
- **`mcp_call.output` is a plain string.** `custom_tool_call_output.output` is an **array** of
  content parts. Same warning: a translator written by analogy to one would get the other wrong.

Neither of these is wired into any translation today — the bridge throws on both `mcp_call` and
`mcp_approval_request` unconditionally (see table) — so this is recorded for whoever writes that
translation later, not a live bug.

### Proven unavailable vs merely unobserved

`hosted-tool-item-shapes.md` establishes two distinct negative findings, and the table above keeps
them apart because they mean different things to a future implementer:

- **`local_shell` is DEAD.** Declaring it against `gpt-5.5` on the public API was refused outright:
  "The local_shell tool is no longer supported." No model qualifier — nothing suggests any model
  would accept it. `local_shell_call` / `local_shell_call_output` are therefore proven unavailable
  on the current API, not merely unobserved.
- **`computer_use_preview` is MODEL-GATED, not dead.** The refusal names the model: "Tool
  'computer_use_preview' is not supported with gpt-5.5." That phrasing is a per-model capability
  check, not a retirement notice — a different (likely older or vision-specific) model may still
  accept it. `computer_call` / `computer_call_output` still belong in the proven-unavailable/
  model-gated bucket (the count above, not the flatly-unobserved one) — the refusal IS a real,
  cited finding, not silence — but they are the model-gated instance rather than the dead one:
  the negative result here is about one model, not the type, so a different model may yet produce
  the item.

### ANSWERED — the deployed route accepts an untranslated hosted-tool-call replay

This section previously recorded, as an open question, what the DEPLOYED route does with a
`web_search_call` / `file_search_call` replayed in a turn that no longer declares the matching
hosted tool. **Measured 2026-08-12.** The probe used the exact field set 45 of the 46
`web_search_call` items in the payload-log corpus carry (`action`, `id`, `status`, `type`, with
`action = {query, type:"search"}`) — a real shape, not a hand-written one:

| route | replayed `web_search_call`, hosted tool NOT declared |
|---|---|
| deployed `gpt-5.3-codex` | **accepted**, `status=completed` |
| orchestration `anthropic--claude-4.8-opus` | **rejected** — `Unsupported Responses input item type: web_search_call` |

So this is a real divergence of the same shape as the `custom_tool_call` one that preceded the
customTools translation: the deployed route understands the item natively, the bridge does not, and
`hostedTool/engine.ts:1916`'s early return means the rewrite that would have saved it does not run
when the turn declares no hosted tool. The gap is unclosed — it is recorded in the divergence list
below, not fixed here.

**LATENT, NOT LIVE — read the row above with this attached.** The probe is an artificial
construction: it hand-builds a request that replays a `web_search_call` while *deliberately
omitting* the `web_search` tool. No observed client does that. Codex declares `web_search` on
every turn — 139 occurrences across the payload-log corpus — so the gate at `engine.ts:1916`
passes and the rewrite runs.

Verified in the codex TUI on `gpt-5.5` (orchestration) rather than by `curl`, because the earlier
framing of this row was mistaken for "websearch is broken on orchestration":

| turn | `web_search` declared | replayed `web_search_call` items | dispatched |
|---|---|---|---|
| 1 — the search itself | yes | 0 | yes |
| 2 | yes | 1 | yes |
| 3 | yes | 1 | yes |
| 4 | yes | 1 | yes |

Four stage-00 requests, four stage-02 dispatches, no rejection. The search returned a real answer
with a source link, and every following turn carried the replayed item without trouble.

So the divergence needs a client that drops a hosted tool mid-conversation while still replaying
its calls. That is a plausible future client, not a current one, and describing it as a live
failure — as an earlier draft of this section did — is misleading.


## What Workstream 4 is NOT closing (Task 6)

Recorded so these stop being rediscovered — every line below was re-verified against the code as
it stands today, and two numbers that had drifted since the plan was written are corrected in
place rather than repeated stale.

- **~~`reasoning` input items are dropped on orchestration, and no `reasoning` output item is ever
  produced.~~ HALF CLOSED.** The output half is done — see "Reasoning is now produced" above:
  `reasoning_content` becomes a `reasoning` item with the plaintext in `summary_text`, plus the
  streaming `reasoning_summary_*` frames, and `reasoning.effort` now reaches the model. The input
  half is unchanged BY MEASUREMENT rather than by omission: replayed `reasoning` items are still
  dropped, and a replayed tool history carrying no thinking block completes on 4.5-sonnet, 4.6-opus
  and 4.8-opus, streaming and not. The claim that "the model loses cross-turn thinking context the
  deployed route preserves" was never tested and is now known to cost nothing observable — what the
  deployed route preserves is an opaque blob this route cannot produce anyway.
  **Correction to the plan's number:** the plan states "136/217 captured requests set
  `include: ["reasoning.encrypted_content"]`". Recounted against the 330 payload-log captures
  present today: **243/330** do. The ratio (roughly 3 in 4) is essentially unchanged; only the
  absolute counts grew because more requests have been captured since the plan was written.
- **A replayed `web_search_call` in a turn that no longer declares `web_search` reaches the bridge
  and 400s.** Confirmed above — `hostedTool/engine.ts:1916`'s early return skips the replay-rewrite
  loop entirely when `body.tools` carries no hosted-tool declaration this turn, so an
  unconverted `web_search_call` (or `file_search_call`) reaches `requestTranslator.ts:158` and
  throws. No test in this repo exercises that specific combination. **Latent, not live:** no observed client drops the tool while replaying its calls; codex declares `web_search` on every turn (139 corpus occurrences), verified across a four-turn TUI session. See the ANSWERED section above.
- **Request params `store`, `include`, `parallel_tool_calls`, `prompt_cache_key`,
  `client_metadata`, `text`, `previous_response_id`, `truncation`, `metadata` are silently dropped
  on orchestration and forwarded on deployed.** Still true — `buildOrchestrationPayload`
  (`requestTranslator.ts:193-252`) reads only `input`, `instructions`, `max_output_tokens`,
  `temperature`, `top_p`, and `tool_choice` off `body`; none of the nine params above is referenced
  anywhere in that file. The deployed route forwards all of them via `{...req.body}`
  (`responsesController.ts:715`).
- **The bridge synthesises an 8-key response envelope against the deployed route's 35.** Still
  true, and still exactly 8: `responseTranslator.ts:149-159` builds `{ id, object, created_at,
  model, status, output, usage, error }`, plus a conditional 9th (`incomplete_details`) only when
  the turn ended incomplete. `RESPONSES-API-COMPLIANCE.md`'s own earlier section (above) measured
  35 top-level keys on a real `response.completed` from the public API, including
  `prompt_cache_key`, `prompt_cache_retention`, `service_tier`, `tool_usage`, `truncation`,
  `safety_identifier`, `max_tool_calls`, `background` — none of which the bridge emits.
- **Non-text content parts (`input_image`, `input_file`) throw at the part level
  (`requestTranslator.ts:58-62`) — unexercised, since the corpus contains only
  `input_text`/`output_text`.** Confirmed by direct scan of all 330 gateway payload-log captures:
  every `content` part across every `message` item is `input_text` (1751 occurrences) or
  `output_text` (473 occurrences); zero `input_image` or `input_file` parts appear anywhere. The
  throw at `textBlocks()`'s `:62` remains real but unexercised by any traffic this gateway has
  actually carried.
- **`tool_search` discovery works but discovered tools are exposed only when the client's
  `base_url` is `api.openai.com`; the hoist works around it and is switchable.** Still true and
  unchanged — `toolSearch/adapter.ts`'s header and `hoistDiscoveredTools` (`:178-223`) document the
  measured host-gating, and `tool_search.hoist_discovered_tools` (default `true`, resolved by
  `resolveHoistDiscoveredTools`, `:75-77`) remains the switch to retire the workaround once codex
  stops gating exposure on the provider host.

None of these six is closed by this workstream — Workstream 4 is documentation only, and the plan's
scope boundary excludes closing any of them, probing the unobserved types further, reasoning
round-tripping, and response-envelope enrichment.
