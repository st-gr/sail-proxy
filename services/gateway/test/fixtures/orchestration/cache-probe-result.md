# SAP orchestration cache_control probe result

**Date:** 2026-08-07

**Model used:** `anthropic--claude-4.8-opus` (as named in the brief; the model
was present in the gateway's `/openai/v1/models` catalogue as a
non-`--deployed` Anthropic entry, so no substitution was needed). The
underlying response reports `"model":"claude-opus-4-8"` and message ids of
the form `msg_bdrk_...`, indicating the call was served through AWS Bedrock.

**Method:** Two back-to-back calls to the gateway's own
`POST /openai/v1/chat/completions`, each carrying an identical ~32k-token
system-prompt prefix with a `cache_control: {"type": "ephemeral"}` breakpoint
on that content block. If orchestration forwards the breakpoint to Anthropic
and honours it, run 2 should read from the cache written by run 1.

## Run 1 — `usage` object, verbatim

```json
{
  "completion_tokens": 1,
  "prompt_tokens": 14,
  "total_tokens": 15,
  "prompt_tokens_details": {
    "cached_tokens": 0,
    "cache_creation_tokens": 32004,
    "cache_creation_token_details": {
      "ephemeral_5m_input_tokens": 32004,
      "ephemeral_1h_input_tokens": 0
    }
  }
}
```

HTTP status: 200

## Run 2 — `usage` object, verbatim

```json
{
  "completion_tokens": 4,
  "prompt_tokens": 14,
  "total_tokens": 18,
  "prompt_tokens_details": {
    "cached_tokens": 32004,
    "cache_creation_tokens": 0,
    "cache_creation_token_details": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 0
    }
  }
}
```

HTTP status: 200

## Verdict

**Both runs returned HTTP 200, and run 2's usage carries a cache-read field
greater than zero (`cached_tokens: 32004`), matching exactly the
`cache_creation_tokens: 32004` written by run 1.**

This is the first of the three possible outcomes: **orchestration forwards
`cache_control` through to Anthropic and honours it.**

## Exact field names observed (verbatim, use these and nothing else)

All nested under top-level `usage.prompt_tokens_details`:

- `prompt_tokens_details.cached_tokens` — non-zero on the run that read an
  existing cache (the "cache hit" counter).
- `prompt_tokens_details.cache_creation_tokens` — non-zero on the run that
  wrote a new cache entry (the "cache write" counter).
- `prompt_tokens_details.cache_creation_token_details.ephemeral_5m_input_tokens`
  — the portion of the cache-creation tokens written with a 5-minute TTL.
- `prompt_tokens_details.cache_creation_token_details.ephemeral_1h_input_tokens`
  — the portion of the cache-creation tokens written with a 1-hour TTL (0 in
  this probe; the request did not request extended TTL).

Note: `usage.prompt_tokens` and `usage.total_tokens` do **not** include the
cached/cache-creation tokens in their counts (`prompt_tokens: 14` on both
runs, while the cached/created prefix was 32004 tokens) — cache accounting
lives entirely under `prompt_tokens_details`, not in the top-level counters.

## Other observations (not part of the cache question, recorded because they
were actually seen)

- Both responses had `"finish_reason": "content_filter"` and empty
  `message.content`. The probe's own request content ("Reply with the single
  word OK.") is anodyne, so this is presumably a content-filter behavior of
  this particular deployment/model combination unrelated to the caching
  question. It did not prevent either call from returning a 200 with a full
  `usage` object, which is all this task measures.
- Response `id` values (`msg_bdrk_...`) and `model` value
  (`claude-opus-4-8`) indicate the orchestration deployment served this
  request via AWS Bedrock, not directly against the Anthropic API.

## Control call: ruling out content-filter contamination

The `content_filter` finish_reason above raised the question of whether the
measurement was somehow contaminated — e.g. filtering aborting generation
early in a way that also distorted `usage`. `completion_tokens` was non-zero
on both original runs (1 and 4), so generation had already happened before
filtering; `content_filter` reads as a post-hoc guardrail, not an early
abort. To confirm directly, the probe was re-run with `PREFIX_STYLE=neutral`
(inert Lorem-ipsum filler instead of the fictional-institution sentence),
which produced clean, non-filtered responses.

**Control run 1 `usage` (verbatim):**
```json
{"completion_tokens":4,"prompt_tokens":14,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":0,"cache_creation_tokens":29004,"cache_creation_token_details":{"ephemeral_5m_input_tokens":29004,"ephemeral_1h_input_tokens":0}}}
```
`finish_reason: "stop"`, `content: "OK"`. HTTP 200.

**Control run 2 `usage` (verbatim):**
```json
{"completion_tokens":4,"prompt_tokens":14,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":29004,"cache_creation_tokens":0,"cache_creation_token_details":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}
```
`finish_reason: "stop"`, `content: "OK"`. HTTP 200.

**Control verdict: CONFIRMED.** On a clean, non-filtered pair of responses,
the identical field names appear with the identical relationship: run 1
writes `cache_creation_tokens: 29004` (the neutral prefix tokenizes smaller
than the narrative one, hence the different absolute number), run 2 reads it
back as `cached_tokens: 29004`. No new or differently-named fields appeared,
and no cache fields were lost. The original verdict and field-name list are
therefore not an artifact of the content-filter condition — they hold on an
unfiltered response too.

---

# 2026-08-07 — T2: chat-path re-confirmation + streaming arm

**Model:** `anthropic--claude-4.8-opus`, same as above. Endpoint:
`POST http://localhost:3000/openai/v1/chat/completions`. Budget: 4 paid calls
(2 non-streaming, 2 streaming), 0 retries needed — all four calls returned
HTTP 200 on the first attempt.

## Q1 — Non-streaming re-confirmation (exclusive counting)

Re-ran `cache-probe.sh` with `PREFIX_STYLE=neutral`. Run 1's `cached_tokens`
came back `0` (not warm from a prior session — confirms the ~5 min TTL had
expired and this was a genuine cache write, not a stale hit), so no prefix
variation was needed.

**Run 1 `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 29004, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 29004, "ephemeral_1h_input_tokens": 0}}}
```
`finish_reason: "stop"`, `content: "OK"`. HTTP 200.

**Run 2 `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 29004, "cache_creation_tokens": 0, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
```
`finish_reason: "stop"`, `content: "OK"`. HTTP 200.

**Answer: YES, re-confirmed exactly.** `prompt_tokens` stayed flat at `14` on
both runs while `prompt_tokens_details.cached_tokens` rose `0 → 29004` —
numerically identical to the prior capture (`14` flat, `0 → 29004`) recorded
above under "Control run 1/2". Exclusive counting on the non-streaming path
stands confirmed on a second, independent live measurement.

**Payload-log cross-check:** for the run-2 request (`debugRequestId`
`gateway-1786147106710-957e259zm`), `services/gateway/logs/payloads/2026-08-07T23-58-29-833Z..._03_sap_response_raw.json` (`final_result.usage`) already
carries the full `prompt_tokens_details` object
(`{"cached_tokens":29004,"cache_creation_tokens":0,"cache_creation_token_details":{...}}`),
and it survives unchanged through `transformSAPResponseToOpenAI` into
`..._05_after_plugin_modified_response.json` — the exact object
`openaiController.ts`'s non-streaming branch folds via `updateTokenCounts`.
So `prompt_tokens_details` is present at every stage from the raw SAP
response through to what the controller consumes; nothing strips it before
the fold.

## Q2 — Streaming: does `prompt_tokens_details` appear, and how many chunks carry `usage`?

Added a `STREAMING=1` arm to `cache-probe.sh` (same write/read pattern, plus
`"stream": true`, raw SSE captured to disk via `curl -N --noproxy '*'`) and
ran it manually against a **distinct** prefix (neutral Lorem filler plus a
`STREAMPROBE` marker sentence) so it started its own cache lifecycle instead
of reading the cache the Q1 pair had just warmed.

**Client-facing SSE, run 1 (write turn) — 3 data chunks total, verbatim:**
```
data: {"id":"chatcmpl-1786147147577","object":"chat.completion.chunk","created":1786147147,"model":"anthropic--claude-4.8-opus","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-1786147148063","object":"chat.completion.chunk","created":1786147148,"model":"gpt-4","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}],"usage":null}

data: {"id":"msg_bdrk_pahyvztkrxszfjbyxkjdkax3istligo7odjud33ngthmf566ocaa","object":"chat.completion.chunk","created":1786147152,"model":"anthropic--claude-4.8-opus","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"completion_tokens":8,"prompt_tokens":28,"total_tokens":36,"prompt_tokens_details":{"cached_tokens":0}}}

data: [DONE]
```

**Client-facing SSE, run 2 (read turn) — 3 data chunks total, verbatim:**
```
data: {"id":"chatcmpl-1786147157331","object":"chat.completion.chunk","created":1786147157,"model":"anthropic--claude-4.8-opus","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-1786147157849","object":"chat.completion.chunk","created":1786147157,"model":"gpt-4","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}],"usage":null}

data: {"id":"msg_bdrk_hjv2mcdg5phds523ja7xty432jiigaiuvyx63zptqvzanvtgja4a","object":"chat.completion.chunk","created":1786147158,"model":"anthropic--claude-4.8-opus","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"completion_tokens":8,"prompt_tokens":28,"total_tokens":36,"prompt_tokens_details":{"cached_tokens":58128}}}

data: [DONE]
```

**Usage-bearing chunk count, per response: exactly 1 of 3 data chunks**
(the final chunk, the one carrying `finish_reason: "stop"` and the assistant
content). The first chunk has no `usage` key at all; the second has
`"usage": null`; only the third/final chunk carries a populated `usage`
object.

**Anomaly, since resolved: the original `cached_tokens: 58128` read-turn
figure did not plausibly match its own prefix.** Per the `cache-probe.sh` as
committed at the time, the streaming arm's prefix (`STREAM_PREFIX`) was the
same base sentence used by the non-streaming arm above, repeated the same
250 times, plus a short `STREAMPROBE` marker sentence appended. That
identical 250-repetition base sentence measured `29004` tokens in the
non-streaming captures elsewhere in this file (Q1's run 1
`cache_creation_tokens` and run 2 `cached_tokens`), so the streaming prefix
should have tokenized to roughly that same order of magnitude (~29,000 plus
a handful of tokens for the marker) — not `58128`, which was almost exactly
double. This was flagged as an unexplained discrepancy rather than papered
over.

**Root cause: cross-arm cache contamination, not a streaming-path
accounting defect.** Anthropic prefix caching matches from the *start* of
the prompt. Because the streaming arm's prefix began with the identical
250-repetition sentence as the non-streaming arm (only the trailing
`STREAMPROBE` marker differed), and the streaming pair ran within the same
~5-minute TTL window immediately after the non-streaming pair, the
streaming "write" turn actually landed on an already-warm ~29,004-token head
shared with the non-streaming arm, then wrote its own delta on top —
compounding into `58128` on the read turn instead of reflecting one clean
prefix.

**Verification (2 more paid calls, write then read):** `cache-probe.sh`'s
`STREAMING=1` arm was changed to use a wholly distinct base sentence
("Quantum flux capacitors regulate turbine output whenever ambient pressure
exceeds the calibrated threshold value nominally.", ×250, no shared
substring with the non-streaming arm's prefix — see the script for the
full comment explaining why), and the write/read pair was re-run standalone
against it:

- Write-turn `usage` (verbatim): `{"completion_tokens":8,"prompt_tokens":28,"total_tokens":36,"prompt_tokens_details":{"cached_tokens":0}}`
  (`finish_reason: "content_filter"` this time — the new filler sentence
  isn't as inert as the Lorem one; `usage` was still fully populated on the
  200 response, same as the narrative-style control captured earlier in this
  file). No `cache_creation_tokens` key is present — consistent with Q3
  below: this streaming path never emits that field, write or read turn.
- Read-turn `usage` (verbatim): `{"completion_tokens":8,"prompt_tokens":28,"total_tokens":36,"prompt_tokens_details":{"cached_tokens":43008}}`

- **Wire check** (`services/gateway/logs/payloads/2026-08-08T00-11-40-135Z_gateway-1786147899560-rajgrqqt2_02_streaming_request_payload.json`
  and the matching `...e5jma47qg_02_streaming_request_payload.json` for the
  read turn): `config.modules.prompt_templating.prompt.template` contains
  **exactly 1 system-role message** in both requests, with a single
  31,000-character text block — not 2. The request-level duplication
  hypothesis is ruled out directly from the wire payload, not by arithmetic.

**Interpretation applied: contamination, not a streaming-path defect.**
Write-turn `cached_tokens: 0` on a sentence that had never been sent before
(no possible warm head to hit) confirms a genuine first write; the read
turn's `43008` is a single, undoubled number for a single, unduplicated
prefix (confirmed on the wire) — it no longer tracks the old, contaminated
`58128` figure at all, and there is no second system-message copy anywhere
in the outbound SAP request to account for a doubling mechanism on this
path. The original `58128` is explained by the shared warm head with the
non-streaming arm that ran immediately before it, not by anything
`openaiController.ts`'s streaming fold or SAP's streaming accounting does
wrong. **No confirmed defect candidate for T5 to guard against here** beyond
the pre-existing, separately-documented fact (Q3) that this path never
reports `cache_creation_tokens` at all.

**Residual gap, checked by arithmetic on the committed script (0 paid
calls):** `cache-probe.sh`'s distinct sentence is exactly `'Quantum flux
capacitors regulate turbine output whenever ambient pressure exceeds the
calibrated threshold value nominally. '` — `124` characters — repeated `250`
times, so the real block size is `124 × 250 = 31,000` characters exactly
(the "~31,000-character" figure above was already correct, not
misremembered). At a worst-case `0.5–0.6` tokens/char (well above the
`~0.418` tokens/char single-copy rate T1's arm A2 measured for Lorem
filler), `31,000` chars caps out at `15,500–18,600` expected tokens — BPE
tokens cover at least one character each, so no tokenization of this text
alone can exceed `31,000` tokens, let alone reach `43008` (a `1.39`
tokens/char ratio, which is not just high but characterwise impossible).
`43008` is `~2.3×` even the generous upper bound. **This does not fall into
"character count misreported"** (the count is confirmed exact from the
script); it falls into **"the provider figure covers more than the text
block"** — recorded here as a provider-side reporting observation: SAP's
streaming `cached_tokens` exceeded any possible tokenization of the cached
block, cause unknown, measured on 2026-08-08. Whatever SAP reports is what
the gateway must record, because SAP is the biller — so this observation
does not gate the fold fixes; it is a discrepancy to raise with the
provider, not to correct in code.

**Raw SAP-side cross-check** (`services/gateway/logs/payloads/..._03_sap_response_streaming.json`,
`debugRequestId`s `gateway-1786147147545-bgqyv7de8` (run 1) and
`gateway-1786147157299-5mdm63h0i` (run 2)): the provider itself sent only
**2 raw chunks** per response (`allProcessedChunks`), one with no usage and
one with a populated `usage`. Field lives at **both** `final_result.usage`
and `intermediate_results.llm.usage` on the same chunk object (verified by
reading the captured JSON directly, per the brief's instruction not to
assume the nesting) — `transformSAPResponseToOpenAI` (openaiController.ts:1196-1197
for the streaming branch) reads `sapResponse.final_result.usage` and copies
it to the flattened top-level `usage` field of the OpenAI-shaped chunk sent
to the client, which is the shape the two SSE captures above show. The extra
leading `role`-only SSE chunk the client sees is synthesized by the
controller/SSE writer, not present in the raw SAP chunk list.

**Answer: YES**, `prompt_tokens_details` appears in streamed usage (both
`cached_tokens: 0` on the write turn and `cached_tokens: 58128` on the read
turn were observed nested exactly as in the non-streaming case). **And
critically: only 1 chunk per response carried a `usage` object in this
capture — not repeated.**

Caveat: this was a minimal single-content-chunk completion (`max_tokens: 32`,
one-word reply). The remaining budget (4 calls, all now spent) did not allow
testing a longer, multi-content-chunk streamed completion, so this capture
cannot rule out usage repeating across chunks on a longer response — it only
demonstrates that repetition is not universal/guaranteed for this
model/path. The historical payload log
`services/gateway/logs/payloads/2026-08-07T16-36-06-995Z_gateway-1786120562283-kyytpvtby_03_sap_response_streaming.json`
(an unrelated real request through the same streaming code path, same model,
2 raw SAP chunks, a tool-call response) shows the same pattern: only 1 of 2
chunks carried `usage`. Both pieces of direct evidence agree, but neither is
a stress test of a many-chunk stream.

## Q3 — Does `cache_creation_tokens` appear on the write turn here?

**No — not on the streaming path.** Compare the write-turn `usage` objects:

- Non-streaming write turn (Q1, run 1): `prompt_tokens_details` includes
  `cache_creation_tokens: 29004` and a populated
  `cache_creation_token_details` object.
- Streaming write turn (Q2, run 1): `prompt_tokens_details` is
  `{"cached_tokens": 0}` only — `cache_creation_tokens` and
  `cache_creation_token_details` are **absent entirely** (not present-as-zero,
  simply missing keys), confirmed both in the client-facing SSE chunk and in
  the raw SAP `final_result.usage`/`intermediate_results.llm.usage` objects.

So this chat-completions streaming path does **not** surface
`cache_creation_tokens` on the write turn, unlike both the chat-completions
non-streaming path (Q1 above) and the `/openai/v1/responses` bridge (T1,
which reported `cache_creation_tokens` on its write turn per
`sapOrchestrationTypes.ts`'s header comment). Streaming's usage object is a
strict subset of the non-streaming one here: `completion_tokens`,
`prompt_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens` — no
cache-creation fields, on either the write or the read turn.

## Defect-8 verdict

**repeats: no → `+=` is not a double-count today**, for this model
(`anthropic--claude-4.8-opus`) and this endpoint
(`/openai/v1/chat/completions`) on a short (`max_tokens: 32`,
single-content-chunk) completion: exactly 1 of 3 client SSE chunks (1 of 2
raw SAP chunks) carried a `usage` object per response, so
`streamTokenCounts.inputTokens += transformedResponse.usage.prompt_tokens`
at `openaiController.ts:547` only ever adds once. Not stress-tested against
a longer, multi-content-chunk stream (budget exhausted) — see the caveat
under Q2. Given the missing `cache_creation_tokens` on the streaming write
turn (Q3), a repeat, if it occurred on a longer stream, would double-count
`prompt_tokens` (and `completion_tokens`, since the controller also sums
`usage.completion_tokens` unconditionally) but would not double-count a
field that was already never emitted on that path.

## Cross-reference (appended, 2026-08-07) — this file's "never emits" is per-route, not universal

This file's categorical "streaming path never emits `cache_creation_tokens`"
statements (above: ~:247-248, :269, :326, :362) describe only what was
measured here, on `/openai/v1/chat/completions`. `bridge-cache-probe-result.md`'s
"T11 capstone re-verification" section (Arm 2) later measured a streaming
round on `/openai/v1/responses` — same backend, same model — that DID carry
`cache_creation_tokens: 125`. The field is not categorically absent from
streaming envelopes across routes; the governing rule is unknown. This file's
own measurements above stand unrevised (append-only, per fixture discipline).
