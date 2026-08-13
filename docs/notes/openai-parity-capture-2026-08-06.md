# file_search parity, checked against captured OpenAI responses

**Captured 2026-08-06** through a proxy, using a real platform API key: 27 flows covering every
endpoint the gateway implements. One paid inference call (`gpt-4o-mini`); everything else is
free-tier CRUD. Raw bodies were written to `/tmp/parity/` — regenerate with `/tmp/parity-capture.sh`
rather than trusting this note if anything looks stale.

This replaces "read off the published documentation" as the basis for the parity matrix, for
everything listed below.

## What was wrong, and is now fixed

**`file_citation.index` pointed at the wrong end of the span.** OpenAI returned, verbatim:

```json
{ "type": "file_citation", "file_id": "file-…", "filename": "kestrel.txt", "index": 99 }
```

for an assistant message of length **100** — so `index` is the **last character** of the cited
span, not the first. `citations.ts` set it to the span start, with a comment saying the question was
unverified. It was, and the reading was wrong: a client rendering a footnote from `index` alone put
every file citation at the start of the quotation instead of after it.

Fixed to `start + needle.length - 1` (`citations.ts:266`). Four assertions across three suites
encoded the old assumption and were corrected.

Also confirmed: OpenAI emits exactly four fields — `type`, `file_id`, `filename`, `index`. Our
`start_index`/`end_index` pair remains an extension, and is what makes the span unambiguous however
`index` is interpreted.

## Object shapes — four match exactly, two differ

| Object | Result |
|---|---|
| `vector_store.file` | **identical** — id, object, usage_bytes, created_at, vector_store_id, status, last_error, chunking_strategy, attributes |
| `vector_store.file_batch` | **identical** — id, object, created_at, vector_store_id, status, file_counts |
| search page | **identical** — object, search_query, data, has_more, next_page |
| search hit | **identical** — file_id, filename, score, attributes, content |
| `file` | missing 3 fields (below) |
| `vector_store` | missing 1 field (below) |

### `file` — we omit `status`, `status_details`, `expires_at`

OpenAI returns:

```json
{ "object":"file", "id":"file-…", "purpose":"assistants", "filename":"kestrel.txt",
  "bytes":101, "created_at":1786061753,
  "expires_at":null, "status":"processed", "status_details":null }
```

`status` is a legacy field OpenAI's own docs mark deprecated, but it is still emitted, and an SDK
that models the response strictly may expect it. All three are constant in practice for this
purpose: `"processed"`, `null`, `null`.

### `vector_store` — we omit `description`

Present and `null` in every captured response. Cheap to add; nothing reads it.

## List envelopes — identical

`object`, `data`, `first_id`, `last_id`, `has_more` on all four list endpoints. Key ORDER varies
between OpenAI's own endpoints (`files.list` puts `has_more` third, the rest put it last), so order
is not part of the contract.

## Error envelopes — a real difference

OpenAI's error body:

```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": "id", "code": null } }
```

and on SOME endpoints a second top-level `detail` object repeating message and code — present on
`/v1/files` errors, absent on `/v1/vector_stores` errors. Inconsistent on their side; not worth
copying.

Two differences that ARE worth knowing:

1. **`param` is populated and we never send it.** OpenAI names the offending parameter — `"id"`,
   `"vector_store_id"`, `"purpose"`. Our errors carry `message`/`type`/`code` only. A client doing
   field-level error mapping gets nothing to map.
2. **`code` is usually `null` for them and always populated for us** (`file_not_found`,
   `invalid_purpose`, `file_search_unavailable`). Ours is strictly more informative and does not
   break a client reading `type`; keep it.

## Behavioural findings worth recording

- **`GET /v1/files/{id}/content` → 400 for `assistants` files.** OpenAI refuses:
  `"Not allowed to download files of purpose: assistants"`. We implement `downloadFileContent` and
  serve the bytes. That is a deliberate divergence in our favour (the corpus is the customer's own),
  but it IS a divergence and was previously unrecorded.
- **`GET /v1/vector_stores/{id}/files/{id}/content` → 400 while ingesting**, with
  `code: "file_not_ready"` and the status named in the message. A useful pattern: they use `code`
  where the condition is transient.
- **Ingestion transitions observed**: `in_progress 0/2 → in_progress 1/2 → completed 2/2`,
  ~9 seconds for two small text files. `file_counts` is exactly our shape.
- **`POST /file_batches/{id}/cancel` returned 500** from OpenAI — a server error on their side, not
  a contract we can read anything from. Retry if this matters.
- **`purpose` enum, from their own validation message**: `fine-tune`, `assistants`, `batch`,
  `user_data`, `vision`, `evals`. Note it does NOT include `assistants_output`, `batch_output` or
  `fine-tune-results`, which the spec's "deliberate gaps" section lists as refused — those are
  output-side purposes that `POST /v1/files` never accepted. Our single-purpose restriction to
  `assistants` remains a documented gap, but the list it is measured against was wrong.

---

# Round 2 — streaming, search variants, pagination

A second capture (`/tmp/parity2.sh`, 2 paid calls) reached what round 1 did not.

## Fixed: `search_query` was a string, OpenAI returns an ARRAY

```json
"search_query": ["Kestrel Protocol ratification"]
```

Confirmed on both a plain and a rewritten search. We emitted a bare string, so a client reading
`search_query[0]` — the documented access — got the first **character** of the query. Now
`[result.searchQuery]`. It is an array because one request can expand into several searches; we run
exactly one, so ours is always length 1.

## Confirmed correct: the streaming annotation divergence is real, documented, and NOT fixable cheaply

`descriptor.ts:227-235` records that we do not emit `response.output_text.annotation.added`, and
argues it cannot be fixed without buffering the whole answer. The capture supports that exactly:

```
seq 38  response.output_text.delta
seq 39  response.output_text.annotation.added   <-- interleaved
seq 40  response.output_text.delta              <-- MORE text after it
seq 41  response.output_text.done
```

OpenAI emits the annotation **mid-stream, with deltas still to come** — it knows the citation offset
before the message is finished because it is generating the text. Our engine only learns the
complete text at `response.output_item.done`. Emitting the frame at the right point would mean
withholding deltas until the answer is complete, i.e. trading a cosmetic ordering difference for a
visible latency regression on every turn. The existing decision stands, now on evidence.

Streaming also **independently confirms the `index` semantics**: streamed text length 144,
annotation `index` 143, the final `.`.

## Missing: three `file_search_call` lifecycle frames

OpenAI's stream carries, at `output_index` 0, before the message:

```
response.file_search_call.in_progress   {item_id, output_index, sequence_number}
response.file_search_call.searching
response.file_search_call.completed
```

We emit none of them. Their payload is trivial — three fields we already have at the point the
engine splices the call item — so unlike the annotation frame this one has no latency argument
against it. A client driving a progress indicator off the tool lifecycle sees nothing from us.

## Missing: four attribute-filter operators

OpenAI's own validation message enumerates: `eq, ne, gt, gte, lt, lte, in, nin, contains,
ncontains, containsany, ncontainsany, and, or`.

`filterCompiler.ts` implements: `eq, ne, gt, gte, lt, lte, in, nin, and, or` — **missing
`contains`, `ncontains`, `containsany`, `ncontainsany`.** A filter using one is rejected by us and
accepted by OpenAI, so an SDK client's query silently fails over.

Their error for an unknown operator is worth copying for its precision:

```json
{"error":{"message":"Invalid value: 'nonsense'. Supported values are: 'eq', 'ne', … and 'or'.",
          "type":"invalid_request_error","param":"filters.type","code":"invalid_value"}}
```

Note `param` names the exact path (`filters.type`) and `code` is populated.

## Confirmed correct

- `expires_after` echoes back verbatim with a computed `expires_at`; our shape matches.
- File `attributes` round-trip with mixed types (`{"year":1992,"kind":"accord","active":true}`).
- `chunking_strategy` is returned as `{"type":"static","static":{max_chunk_size_tokens, chunk_overlap_tokens}}` — our shape matches; defaults are 800/400.
- Pagination: `after`, `before`, `order=asc`, `filter=completed` all behave as our keyset builder does, with the same envelope.
- `rewrite_query: true` makes `search_query` carry the REWRITTEN text, not the original — ours does the same.

## Not covered by this capture

Streaming (`stream: true`) response frames, `file_search_call` item shapes beyond what the
non-streaming response carried, and `attributes` filtering on search. Each needs its own call; the
script is parameterised enough to extend.

---

# Round 4 — `tool_choice` with a hosted tool

Captured 2026-08-07, `/tmp/tc-openai.sh`, 3 paid calls (`gpt-4o-mini`), a real
`file_search` tool over a two-line vector store.

| `tool_choice` | output items |
|---|---|
| `"required"` | `['file_search_call', 'message']` |
| `{"type":"file_search"}` | `['file_search_call', 'message']` |
| `"auto"` | `['file_search_call', 'message']` |

**One call, then an answer, in every case.** `required` binds the turn AS THE
CLIENT SEES IT — for OpenAI that is not even a distinction, because their hosted
tools run inside a single generation.

This settles a question the gateway could not answer from its own architecture.
We emulate one hosted-tool turn with SEVERAL deployment round-trips, and the
continuation POST used to carry `tool_choice` forward verbatim — so `required`
re-forced a call every round and the client got three `file_search_call` items
and no message. That was the emulation's accidental semantics leaking out, not
OpenAI's. `relaxForcedToolChoice` (hostedTool/engine.ts) now relaxes a forced
choice to `auto` on continuations only, which reproduces the table above.

Worth noting the alternative that was considered and is now ruled out: rejecting
`tool_choice: "required"` alongside a hosted tool with a 400. OpenAI accepts it
and does something sensible, so refusing it would have been a parity break
invented to avoid a bug.

---

# Anthropic web_search — streaming parity (2026-08-07)

Golden captured through mitmproxy from real `claude` against api.anthropic.com
(`claude-haiku-4-5-20251001`, tool `web_search_20250305`, `max_uses: 8`), then the
same request body replayed against the gateway.

| | golden | gateway before | gateway after |
|---|---|---|---|
| frames | 76 | 14 | 173 |
| content blocks | `server_tool_use`, `web_search_tool_result`, 13 × `text` | 1 × `tool_use` | `server_tool_use` ×3, `web_search_tool_result` ×3, 1 × `text` |
| block indices | 0..14 | [0] | 0..6 |
| `message_start` / `message_stop` | 1 / 1 | 1 / 1 | 1 / 1 |
| `usage.server_tool_use` | `{web_search_requests:1, web_fetch_requests:0}` | absent | `{web_search_requests:3, web_fetch_requests:0}` |
| answer | grounded, cited | **none** | grounded |

**The cause was not the missing usage field.** `usage.server_tool_use.web_search_requests`
is what Claude Code counts, so its absence explains the "0 searches executed" display — but
the search was never running at all on this path. `webSearchPlugin`'s after-handler operates
on the assembled non-streaming object; on `invoke-with-response-stream` the bytes have already
left by the time it fires, so the rewritten `tool_use` reached the client verbatim. Claude Code
always streams.

Fixed by porting what `plugins/hostedTool/engine.ts` does for `/openai/v1/responses`: patch
`res.write`, withhold the tool-call frames, run the search, splice in the real blocks, POST a
continuation so the model answers, report usage. See
`src/plugins/webSearch/anthropicWebSearchStream.ts`.

## Three things only a live run found

Sixteen unit tests, a full CI-equivalent suite and two clean reviews all passed while each of
these was broken. Every one needed a real model and a real deployment.

1. **The cap stranded the turn.** At `max_searches_per_request` the loop dropped the pending
   call and broke without a final continuation, so the model was never asked to answer.
   `finalize` then rewrote `stop_reason` to `end_turn`, which made an empty turn look
   deliberate. Client got 3 searches and no answer.
2. **Prose is not a constraint.** Sending a "search budget exhausted" `tool_result` was not
   enough — the continuation still DECLARED `web_search` in `tools`, so the model asked for a
   fourth search. Fixed by removing that one tool from the cap-reached continuation. `tool_choice:
   {"type":"none"}` was rejected as the lever: nothing captured proves SAP's Bedrock passthrough
   honours it, and no unit test can produce that evidence because the deployment is what it mocks.
3. **An async-listener race.** The `data` handler `await`s stream plugins before `processChunk`,
   and Node does not wait for async listeners — so `end` could fire mid-await and `finalize()`
   run before any frame was written, leaving no search and an un-patched `res.write` leaking the
   raw frames. Intermittent, and it would have read as flakiness.

## Known gaps

- **No citations.** The golden splits its answer into 13 `text` blocks carrying `citations` and
  `citations_delta` with `web_search_result_location`. We emit one plain `text` block. Sources are
  present in the `web_search_tool_result`, so nothing is lost — but a client rendering inline
  footnotes gets none.
- **We search more than Anthropic does.** Anthropic answered this question in one search; we
  take three and hit the cap. Worth investigating whether the `tool_result` we feed back is less
  useful than what their server tool returns.
- **`encrypted_content` is emitted empty.** Anthropic-signed blobs we cannot mint. Untested
  whether any client validates rather than passes it through.
- **Streaming cache hits bypass interception entirely.** `awsBedrockResponseCache` replays stored
  events and returns `{stop: true}`, so `handleNativeStreamingRequest` never runs — and what it
  cached was the raw `tool_use`. A cached web_search turn replays the original bug. Pre-existing
  and asymmetric with the non-streaming path.

## Re-capturing the golden

Run real `claude` in a shell whose `HTTP_PROXY`/`HTTPS_PROXY` point at the mitmproxy, with
`NODE_EXTRA_CA_CERTS=<path-to>/mitmproxy-ca-cert.pem` — the path in that
window's environment (`~/self-signed.pem`) does not exist. Then pull the flow from
`http://<mitmproxy-host>:8081/flows`; `response/content.data` returns the body still gzip-encoded.
Fixture: `services/gateway/test/fixtures/anthropic/websearch-golden.stream.jsonl`, with
`encrypted_content` / `encrypted_index` truncated.

## Open decision: the two paths disagree on what a web_search turn is

Found by the final review, after the section above was written. Not a regression from this
branch — both behaviours predate it on their respective paths — but they cannot both be right
against the golden, and the inconsistency should be decided rather than inherited.

- **Streaming** (`anthropicWebSearchStream.ts`) emits `server_tool_use` +
  `web_search_tool_result` + the model's own prose. This matches api.anthropic.com.
- **Non-streaming** (`webSearchPlugin.ts`) builds those same two blocks and then FILTERS THEM
  OUT (`buildResponseWithSearchResults`, the `filteredContent` return), and substitutes a
  gateway-authored summary with synthetic citations (`formatSearchSummary`) which does reach
  the client.

So one path returns what the model wrote, the other returns what the gateway wrote. Claude Code
always streams, so the corrected path is the one in use; the non-streaming path is the odd one.

Three further divergences exist on the discarded blocks — non-streaming omits
`caller: {type:'direct'}`, reuses the model's `toolu_` id where the golden and the streaming path
mint `srvtoolu_`, and fabricates `encrypted_content` as base64 of the result body where streaming
emits `''`. They are unreachable by a client today precisely because of the filter above, so they
matter only if the filter goes.

Deliberately not changed here: converging them means either building golden-shaped blocks in order
to delete them, or removing a filter whose intent a named test documents — a behaviour change to a
path that was working, made mid-fix-wave, on no evidence that any client wants it.

---

# Responses over SAP orchestration (2026-08-07)

Live verification of the orchestration bridge (Tasks 1-8), run against the real gateway
(`http://localhost:3000`) and real codex, per `task-9-brief.md`. Two real defects — full
`npx jest` + `tsc --noEmit` were both clean going in.

## Which models now serve the route

Any Anthropic model in the SAP AI Core catalogue that has **no `--deployed` sibling able to
serve natively** now routes to `/openai/v1/responses` through the translation bridge instead of
being refused. The native `--deployed` path is untouched — `responses-controller.test.ts` passed
unedited throughout Tasks 1-8, and this task's own runs never exercised it. Live-tested here:
`anthropic--claude-4.8-opus`. The rest of the non-deployed catalogue (claude-4-opus,
claude-4-sonnet, claude-4.5-*, claude-4.6-*, claude-4.7-opus, claude-3.5-sonnet, claude-3-haiku)
goes through the identical code path but was not individually exercised live in this task.

## Before / after for a non-deployed model

**Before** (pre-Task-7 routing, `resolveResponsesRoute`): a catalogue model with no serving
`--deployed` sibling hit the `'refuse'` branch and the controller returned 400.

**After** (live, this task):
```
POST /openai/v1/responses {"model":"anthropic--claude-4.8-opus","input":"Reply with exactly the word: PONG"}
-> 200 { "object": "response", "output": [{ "type": "message", ..., "content": [{"type":"output_text","text":"PONG",...}] }], "usage": {...} }
```
Exact shape the brief specified: `object: "response"`, `output[0].type === "message"`, text `PONG`.

## Codex acceptance result

**First attempt failed, exit 1, no file created.** Root cause was NOT the bridge, but the request
translator — see "Two live-only defects" below. After fixing both and re-running with
`-s workspace-write` (codex's default sandbox for `codex exec` is `read-only`, which the brief's
literal command does not override — needed regardless of the bridge to let codex actually write
`/tmp/zzz.txt`; without it every run fails with `operation not permitted` at the shell level,
independent of gateway correctness):

```
exec /bin/zsh -lc "printf 'HELLO\n' > /tmp/zzz.txt && cat /tmp/zzz.txt" succeeded in 0ms: HELLO
codex: Done. `/tmp/zzz.txt` contains `HELLO` (read back and confirmed).
EXIT: 0
```
Confirmed by reading `/tmp/zzz.txt` directly afterward: `HELLO`. Ran twice more back to back for
the caching step below, both exit 0, same result. Function tools round-trip end to end through
Opus 4.8 over orchestration — the plan's acceptance criterion.

## Two live-only defects (found and fixed this task)

Both were in `services/gateway/src/responses/orchestrationBridge/requestTranslator.ts`'s
`responsesInputToMessages`, both invisible to the 15 existing unit tests because every one of
those tests asserted the exact wrong shape as if it were correct — a textbook instance of "unit
tests prove translation shape; they cannot prove a model answers."

1. **An assistant message carrying only `tool_calls` sent `content: []`.** SAP orchestration
   400s: `"Request Body: [] is not of type 'string'"` — its schema is string-or-array-of-blocks,
   and an empty array satisfies neither branch. This is exactly the shape every `function_call`
   Responses item produces, so it broke on the very first tool call in any conversation, once a
   continuation turn was sent. Fixed: `content: ''` (empty string, not empty array).
2. **A `role: 'tool'` message (`function_call_output`) sent block-array content**
   (`[{type:'text', text:...}]`), matching every other role in this translator. SAP orchestration
   400s: `"Tool message content must be a string for Anthropic harmonization. Received: list."`
   — `tool` is the one role orchestration's Anthropic-harmonization step requires as a plain
   string. Fixed: `content` is now the raw string (JSON-stringified if the output wasn't already
   a string).

Both reproduced directly with `curl` against `/openai/v1/responses` (no codex needed to isolate
them), fixed, covered with new/updated unit tests in
`test/orchestration-request-translator.test.ts` (16 tests, up from 15), verified live via the
same curl repro, then reverified end to end via two fresh codex runs. Full gateway suite after the
fix: 1717 passed / 129 of 154 suites, 0 failures — no regressions. `tsc --noEmit` clean. Neither
defect touches cache-breakpoint or streaming code, which were exercised unchanged.

Tool-role content being a plain string, never blocks, is not a caching-relevant loss:
`cacheBreakpoints.ts` never marks a `tool` message for a breakpoint (see Task 6), so this fix
costs nothing there.

## Caching verdict (Task 1) and this task's measured effect

**Task 1's verdict stands, live and unchanged:** SAP orchestration forwards `cache_control` to
Anthropic and honours it. Two probe pairs (a content-filtered run and a clean control run) each
wrote a cache entry on turn 1 (`cache_creation_tokens`, e.g. 32004 / 29004) and read the identical
count back as `cached_tokens` on turn 2, both under `usage.prompt_tokens_details`.

**What this task could and could not measure live through the Responses bridge itself:**
`applyCacheBreakpoints` is gated by `modelDetails.supports_prompt_caching === true`
(`responsesController.ts:159`), off by default. `anthropic--claude-4.8-opus` had **no**
`model_list_changes` entry in `api_config.json` before this task — confirmed by grepping the file
and independently by grepping the two live codex request payloads
(`services/gateway/logs/payloads/*_02_responses_request_to_orchestration.json`) for
`cache_control`: zero matches in either. So the two codex runs used for the acceptance test show,
correctly, **no** caching — `usage` on both was `{input_tokens: ~42530, output_tokens: ...}` with
no cache fields at all, because no breakpoint was ever inserted.

Declared `supports_prompt_caching: true` for the bare `anthropic--claude-4.8-opus` entry in
`services/gateway/api_config.json` (`model_list_changes`), matching its `--deployed` sibling's
value, and synced — `services/gateway/api_config.json`, `services/admin/api_config.json`,
`npm-dist/sail-proxy/src/templates/api_config.template.json` are md5-identical
(`618ae9159eaf6c63497fad1e02a77c8d`).

**This does not take effect until the admin service's active configuration is republished** — the
gateway runs with `GATEWAY_STANDALONE=false`, `ADMIN_SERVICE_URL` and `VALKEY_URL` set, so
`configService` waits on admin-pushed config rather than reading `api_config.json` off disk at
request time. Publishing is out of this task's scope by the brief's own instruction. **Net
result: the caching capability is declared but NOT live-verified through the Responses bridge in
this session** — that requires the user to publish, then a repeat of the two-codex-run comparison
against the payload logs.

Deliberately scoped to `anthropic--claude-4.8-opus` only, not the other ten non-deployed Anthropic
catalogue entries — the live probe (Task 1) tested exactly one model, and extending the flag to
untested models would be the same kind of unverified guess this plan has repeatedly refused to
make elsewhere (Task 3's hosted-tool shapes, Task 6's tools-breakpoint scope). Their `--deployed`
siblings already carry `supports_prompt_caching` (`true` for all except
`claude-3-haiku--deployed`, which is `false`) — a reasonable basis to extend from once each is
actually exercised, but not done here.

## Gaps left open

- **Reasoning items are omitted, not fabricated** (Task 3, by design) — no golden exists for an
  Anthropic-orchestration reasoning equivalent.
- **`file_search` is not covered by this bridge.** Only function tools and hosted tools that the
  existing plugins rewrite into function tools before the translator runs are handled.
- **`/chat/completions` is still uncached automatically.** `applyCacheBreakpoints` is wired only
  into `responsesController.ts`; a `/chat/completions` caller gets caching only if it sets
  `cache_control` itself (as Task 1's probe script did) — the gateway does not insert breakpoints
  on that path the way it now does for `/openai/v1/responses`.
- **Nine of the eleven non-deployed Anthropic catalogue entries have no `supports_prompt_caching`
  declaration at all** — untested by this task, left for whoever next exercises them live.
- **codex's default sandbox (`read-only`) blocks the brief's literal acceptance command** unless
  `-s workspace-write` is added — unrelated to the bridge, but anyone re-running this test needs
  to know, or it fails at the shell before any gateway code runs.

> The "no live cache hit has been observed through this route yet" gap listed here was closed
> later the same day, and closing it overturned a finding this document had recorded as settled.
> See the next section, which supersedes the caching paragraphs above wherever they disagree.

## Caching IS live on the bridge — and it exposed a double-billing defect

Measured after the admin configuration was published, `anthropic--claude-4.8-opus` over
`/openai/v1/responses`, two identical turns with a large stable prefix:

| | `prompt_tokens` | `cache_creation_tokens` | `cached_tokens` |
|---|---|---|---|
| run 1 (write) | 16303 | 16292 | 0 |
| run 2 (read) | 16303 | 0 | 16292 |

`cache_control` was present in the outbound payload and the flag was live on the model. So
caching works end to end through the bridge, which the section above could only declare.

**`prompt_tokens` is INCLUSIVE here.** 16292 + 11 new tokens = 16303, on the write turn AND the
read turn alike: `prompt_tokens` is the whole prompt whether or not it was cached. Confirmed
against a control — the same body with caching OFF reported `prompt_tokens` 25237 with
`cached_tokens` 0, i.e. it never grows or shrinks with cache state.

### This directly contradicts Task 1, and both observations are real

Task 1's probe went through **`/openai/v1/chat/completions`** and showed the opposite:
`prompt_tokens` flat at 14 across two runs while `cached_tokens` rose 0 → 29004 for the same
~29k-token prefix. EXCLUSIVE. Same SAP orchestration service, same model, different endpoint,
opposite accounting.

**Nobody has established why.** It is deliberately not speculated on here. The operational rule
is: a caller must pick its arithmetic from WHICH endpoint's usage object it is holding, and must
not assume either regime generalises. Both sets of numbers are recorded verbatim in
`recordOrchestrationUsage`'s doc comment in `responsesController.ts` and in the header of
`orchestrationBridge/cacheBreakpoints.ts`.

### The defect this caused

`recordOrchestrationUsage` was built on Task 1's exclusive finding and therefore did **not**
subtract. Against inclusive counting that double-bills: run 2 above would have been recorded as
16303 full-rate input **plus** 16292 cache-read — 32595 tokens billed for a 16303-token turn.

Admin's cost SQL (`costRecalculationService.ts`, `buildUpdateSQL`) prices all four token
categories separately and **adds** them:

```
inputTokens*inputCost + outputTokens*outputCost
  + cacheReadInputTokens*cacheReadCost + cacheCreationInputTokens*cacheCreationCost
```

so `inputTokens` must contain neither cache category. Fixed by folding through a shared
`foldInclusiveUsage(metrics, input, output, cacheCreation, cacheRead)` which subtracts **both**
before recording — `max(0, 16303 - 16292 - 0) = 11`, correct on the read turn, and
`max(0, 16303 - 0 - 16292) = 11` on the write turn.

Subtracting only cache-READ was considered and is wrong: the write turn is as inclusive as the
read turn, so it would have moved the same double-count to the write side (16303 + 16292 again).
Both the native `applyResponsesUsage` and the orchestration path now route through the one
function; the native path passes 0 for cache-creation, so it is a no-op change there.

### New client-visible field: `input_tokens_details.cached_tokens`

Our Responses `usage` object omitted cache information entirely, so a client could not see a
cache hit at all. Real OpenAI reports `usage.input_tokens_details.cached_tokens`, and both bridge
translators now emit it. Verified live: 0 on the write turn, 16292 on the read turn, with
`input_tokens` left inclusive exactly as OpenAI reports it. It is a **breakdown, not an
addition** — the billing subtraction happens on the metrics side and structurally cannot reach
the client-visible shape.

### One negative data point in the config is untestable

`anthropic--claude-3-haiku--deployed` is the only model declaring `supports_prompt_caching:
false`, and it returns 404 — so that declaration cannot be checked and may be stale. Separately,
sending `cache_control` to `gpt-5-mini` returned 200 with `cached_tokens: 0`: **SAP silently
ignores an unsupported `cache_control` rather than rejecting it.** That makes defaulting the flag
on for Anthropic models safe on the evidence available, though it is one model on one path.

---

# Final fix wave — what the whole-branch review found (2026-08-07)

Recorded here because it is the last thing this branch learned and there is no other durable
place for it.

**The hosted-tool continuation over orchestration was half-built.** `buildContinuationPayload`
translated the REQUEST; the reply was still handled as if it were Responses-shaped. Streaming,
orchestration chunks were written verbatim into the client's Responses stream; blocking, the
orchestration envelope replaced the translated response object and the round billed zero. The
live Task 9 codex runs did not catch it because they used ordinary function tools —
`web_search`/`namespace` were declared but never called, so the continuation path never ran.
Fixed with two reply-side hooks on `__responsesUpstream`, symmetric with the request-side
builder, both reusing the translators the first turn already goes through.

**The orchestration streaming branch skipped the continuation lifecycle** the native
`forwardStream` documents as load-bearing: no `awaitResponsesStreamIdle`, no
`__responsesExtraUsage` fold, no abort on client disconnect. The usage event fired before a
continuation existed, and an abandoned request left the loop running and paying.

**Three things a green suite was not proving.** `res.ended` was asserted nowhere, so deleting
`res.end()` left every streaming client on an open socket with the suite green. No streaming
chunk in any test carried `usage`, so the fold could be deleted outright. The one streaming
dispatch test asserted frame TYPES and never the delta text, so a regression dropping every word
of the answer passed. All three are now pinned, and each fix was mutation-verified.

**Two other translation defects.** A `message` item whose content parts were all non-text (an
`input_image`) silently dropped the content and produced `content: []` — the exact shape SAP
rejects — so it 400'd anyway with an error naming nothing; it now refuses with the part type.
And `streamTranslator` never read `finish_reason`, so the same truncated turn reported
`incomplete` unstreamed and `completed` streamed. `content_filter`, seen twice in the Task 1
capture, reached the client as a **successful blank answer** on both paths; it now maps to
`status: 'incomplete'` with `incomplete_details.reason: 'content_filter'`, which is real OpenAI's
own vocabulary for that field.

**`tool_choice: 'required'` was re-forced on every orchestration continuation** — the exact live
failure `relaxForcedToolChoice` was written to fix (Round 4 above), silently reintroduced because
the bridge's builder bypassed it.

## Known defect, shipped deliberately: continuation rounds over-bill cached input

Found by the scoped re-review of this branch's final fix wave, ruled on, and shipped rather
than rushed.

A hosted-tool turn on the orchestration bridge makes a continuation call. That round's usage is
folded with bare `updateTokenCounts`, not `foldInclusiveUsage`, at both fold sites in
`dispatchOrchestration`. Orchestration's `prompt_tokens` is inclusive of the cached prefix on
this path (see the contradiction recorded above), so a continuation over a 16k cached prefix
bills:

```
continuation round   input 16303 full-rate,  cache-read 0      <- wrong
first turn           input 11 full-rate,     cache-read 16292  <- correct
```

Before hosted-tool continuations were completed, that path reported **zero** usage — so this is
under-billing turned into over-billing, not a new class of error.

**Why it was not fixed here.** The engine's `noteUsage` accumulates raw round usage into
`__responsesExtraUsage`, and the native `forwardStream` folds it the same way. A correct fix
therefore changes the native path too, which this branch has kept byte-identical throughout and
which has its own regression gate. Doing that in a fix wave at merge time is how the native path
gets broken.

**Where it goes next.** First item of a wider audit of usage and cost accounting across the
gateway's routes — the same sweep should cover `forwardStream`'s fold, `hostedToolAfterHandler`
spreading only the LAST round's usage object (so `total_tokens` and now `input_tokens_details`
describe that round rather than the sum, long predating this branch), and
`costRecalculationService`'s `inputTokens > 1` backfill gate, which a fully-cached turn now falls
below.
