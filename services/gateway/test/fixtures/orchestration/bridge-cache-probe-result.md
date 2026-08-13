# Bridge cache probe result — is "inclusive" a duplication artifact? (T1)

**Date:** 2026-08-07

**Model used:** `anthropic--claude-4.8-opus` (`supports_prompt_caching: true` in
`api_config.json`), the same model for all four arms — the same-model control
the earlier chat/completions-vs-responses comparison lacked (that comparison
used `4.6-sonnet` for its caching-off control and `4.8-opus` for its
caching-on runs). All eight calls in this probe report `"model":
"claude-opus-4-8"` and `msg_bdrk_...` response ids in the raw orchestration
envelope, i.e. served through AWS Bedrock, and all eight returned HTTP 200
with `finish_reason: "stop"` and `content: "OK"` (no content-filter noise this
time).

**Method:** `bridge-cache-probe.sh` in this directory, run once per arm
(`ARM=A0|A1|A2|A3 bash bridge-cache-probe.sh`), each doing two back-to-back
`POST /openai/v1/responses` calls with a large `instructions` prefix (a
distinct filler sentence per arm, repeated 300x, so no arm's run 1 could land
as a cache hit against another arm's write — see the script's header for the
full rationale and the exact sentences). Between arms, the relevant temp
source edit was applied, `services/gateway/src/index.ts` was touched, and the
probe was not run until the SAME nodemon-restarted pid answered `/health` 200
three times in a row. Every temp edit was reverted, and the SAME
restart-and-3x-health discipline was applied to the revert, before the next
arm's edit was made. Final state: `git diff --stat services/gateway/src` is
empty.

Wire attribution below was read directly from each call's payload-log
capture: `*_02_responses_request_to_orchestration.json` for the outbound
request (system-copy count and `cache_control` marking) and
`*_03_responses_response_from_orchestration.json` for the raw orchestration
`usage` object (`payload.final_result.usage`), i.e. what
`recordOrchestrationUsage` in `responsesController.ts` actually receives —
not the translated, client-visible response. The client-visible usage
(`payload.usage` in the JSON response body, after `responseTranslator.ts`'s
translation) is recorded separately below each raw object.

All 8 calls: HTTP 200, budget used exactly 8/8, no retries needed.

---

## Arm A0 — today's code, caching on (baseline)

**Wire attribution (both runs, identical):** `prompt.template` carries 1
system message, **unmarked** (`cache_control` absent). `messages_history`
carries 1 system message, **marked** (`cache_control: {"type":"ephemeral"}`).
Two copies of the same ~36600-char instructions text on the wire, one marked,
one not — confirms the structural suspect in `requestTranslator.ts:172-187` /
`cacheBreakpoints.ts` exactly as described.

**Run 1 — raw orchestration `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 15903, "total_tokens": 15907, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 15892, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 15892, "ephemeral_1h_input_tokens": 0}}}
```
**Run 1 — client-visible `usage` (verbatim):**
```json
{"input_tokens": 15903, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 4, "total_tokens": 15907}
```

**Run 2 — raw orchestration `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 15903, "total_tokens": 15907, "prompt_tokens_details": {"cached_tokens": 15892, "cache_creation_tokens": 0, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
```
**Run 2 — client-visible `usage` (verbatim):**
```json
{"input_tokens": 15903, "input_tokens_details": {"cached_tokens": 15892}, "output_tokens": 4, "total_tokens": 15907}
```

15892 + 11 = 15903 on both runs. **INCLUSIVE** — reproduces the 16303-shape
pattern documented in `responsesController.ts`'s `recordOrchestrationUsage`
(different absolute numbers because this probe uses a different, shorter
filler prefix than that original capture; the *shape* — `prompt_tokens` =
cache field + a small constant, on both the write and the read turn — is the
same).

---

## Arm A1 — temp edit: mark BOTH system copies

**Wire attribution (both runs, identical):** `prompt.template` system
message **marked**. `messages_history` system message **marked**. Both
copies of the ~39600-char instructions text now carry `cache_control`.

**Run 1 — raw orchestration `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 34181, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 34181, "ephemeral_1h_input_tokens": 0}}}
```
**Run 1 — client-visible `usage` (verbatim):**
```json
{"input_tokens": 14, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 4, "total_tokens": 18}
```

**Run 2 — raw orchestration `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 34181, "cache_creation_tokens": 0, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
```
**Run 2 — client-visible `usage` (verbatim):**
```json
{"input_tokens": 14, "input_tokens_details": {"cached_tokens": 34181}, "output_tokens": 4, "total_tokens": 18}
```

`prompt_tokens` stayed **flat at 14** on both runs while the cache field went
0 → 34181. **EXCLUSIVE** — the opposite of A0, from marking the second copy
alone. Note also the absolute size: 34181 tokens for a ~39600-char prefix is
consistent with paying for the FULL text TWICE (see cost analysis below) —
marking both copies doesn't just change the accounting shape, it makes the
gateway actually pay to cache both duplicate copies every write.

---

## Arm A2 — temp edit: de-duplicate (system only in template)

**Wire attribution (both runs, identical):** `prompt.template` carries 1
system message, **marked**. `messages_history` carries **0** system
messages (the de-dup edit removed it). Exactly one copy of the ~42300-char
instructions text on the wire.

**Run 1 — raw orchestration `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 17692, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 17692, "ephemeral_1h_input_tokens": 0}}}
```
**Run 1 — client-visible `usage` (verbatim):**
```json
{"input_tokens": 14, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 4, "total_tokens": 18}
```

**Run 2 — raw orchestration `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 17692, "cache_creation_tokens": 0, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
```
**Run 2 — client-visible `usage` (verbatim):**
```json
{"input_tokens": 14, "input_tokens_details": {"cached_tokens": 17692}, "output_tokens": 4, "total_tokens": 18}
```

`prompt_tokens` flat at 14, cache field 0 → 17692. **EXCLUSIVE** — same shape
as A1, produced by the *opposite* fix (removing the duplicate rather than
marking it). This is the decisive result: **de-duplication alone flips the
regime**, independent of which copy ends up marked.

---

## Arm A3 — de-dup + caching forced OFF (same-model control)

**Wire attribution (both runs, identical):** `prompt.template` carries 1
system message, **unmarked** (`applyCacheBreakpoints` short-circuits on
`enabled: false` before marking anything). `messages_history` carries 0
system messages. One copy of the ~41400-char instructions text, no
`cache_control` anywhere in the payload.

**Run 1 — raw orchestration `usage` (verbatim):**
```json
{"completion_tokens": 4, "prompt_tokens": 18006, "total_tokens": 18010, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 0, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
```
**Run 1 — client-visible `usage` (verbatim):**
```json
{"input_tokens": 18006, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 4, "total_tokens": 18010}
```

**Run 2 — raw orchestration `usage` (verbatim, identical to run 1 — no cache means no read):**
```json
{"completion_tokens": 4, "prompt_tokens": 18006, "total_tokens": 18010, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 0, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
```
**Run 2 — client-visible `usage` (verbatim):**
```json
{"input_tokens": 18006, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 4, "total_tokens": 18010}
```

Clean control: with caching off, `prompt_tokens` is simply the whole prompt
(18006, flat and identical on both runs — no write, no read, no cache
activity at all), on the same model as every other arm.

---

## Verdict

**Outcome 2 — artifact of the duplicated/half-marked system block.**
A2 (and A1) flip to exclusive-style accounting the moment the wire stops
carrying one marked and one unmarked copy of the same system block. A0's
"inclusive" shape (`prompt_tokens` = cache field + a small constant, on
*both* the write and the read turn) is not a property of the
`/openai/v1/responses` endpoint in general — it is exactly the artifact the
brief's structural suspect predicted: `requestTranslator.ts` puts the same
system-message object into `prompt.template` (left unmarked) AND
`messages_history` (marked by `applyCacheBreakpoints`'s clone), and once that
duplication is removed (A2) or evened out (A1), the accounting matches the
chat/completions endpoint's exclusive shape (flat `prompt_tokens`, cache
count reported separately).

Concretely: **A0 `prompt_tokens: 15903 = 15892 (cache) + 11 (new)`, both
write and read turn → A2 `prompt_tokens: 14` flat while the cache field goes
`0 → 17692`.** The 16303/16292/11 constants documented in
`responsesController.ts`'s `recordOrchestrationUsage` do not describe a
stable property of the `/responses` endpoint; they describe this specific
duplicated-payload shape and need to be re-derived once T2b's de-dup fix
lands — `foldInclusiveUsage`'s subtraction is the wrong direction for a
de-duplicated payload and would need to become additive (mirroring how
`recordOrchestrationUsage`'s current chat/completions sibling already treats
`cached_tokens` as additive), or be dropped in favor of whatever regime the
de-duplicated wire shape turns out to need after a fresh capture.

## Raw token COST of the duplication (A2 vs A0, caching on)

The four arms necessarily used different-length prefixes (a probe-validity
requirement, not a control), so a literal cost comparison needs a per-char
normalization; here are the raw ingredients, verbatim, with the normalization
shown as arithmetic, not asserted as a new field:

| Arm | prefix chars | reported cache-write tokens | tokens per char |
|---|---|---|---|
| A0 (duplicate, 1 marked) | 36600 | 15892 (`cache_creation_tokens`) | 0.4342 |
| A1 (duplicate, both marked) | 39600 | 34181 (`cache_creation_tokens`) | 0.8632 |
| A2 (de-duplicated) | 42300 | 17692 (`cache_creation_tokens`) | 0.4182 |
| A3 (de-duplicated, no caching) | 41400 | 17995 (`prompt_tokens` 18006 minus the same ~11-token fixed user turn A0 showed as its "new" remainder) | 0.4346 |

A0, A2, and A3's tokens-per-char are all within ~4% of each other
(0.434 / 0.418 / 0.435) despite A0's wire genuinely carrying the system block
**twice** (once marked, once not). A1 — where both copies are marked — comes
in at almost exactly double (0.863, ≈2× the other three), consistent with
Anthropic actually caching (and billing) both copies' worth of tokens once
both are marked.

Read plainly: **A0's reported cache-write cost is statistically
indistinguishable from a SINGLE copy**, even though the payload has two
copies of the text on the wire. This does not by itself prove SAP
orchestration silently collapses the duplicate consecutive system blocks
before forwarding to Anthropic (as opposed to Anthropic genuinely being
billed for one copy while the second, unmarked copy is charged through some
other line item this probe did not capture) — that would need a capture
independent of `usage.prompt_tokens_details` to confirm. What this probe DOES
establish, from `usage` alone: **de-duplicating (A2) does not cost more than
today's duplicated shape (A0) at the reported-usage level, and is
meaningfully cheaper than the alternative fix of marking both copies (A1),
which roughly doubles the reported cache-write size for the same content.**
De-duplication is therefore both the arithmetic fix (flips to a shape
`foldInclusiveUsage`/`recordOrchestrationUsage` can be correctly re-derived
around) and the cheaper of the two viable temp-edit fixes tested here.

## A3's de-duplicated, caching-off baseline

18006 prompt tokens flat, zero on every cache field, identical on both calls
— exactly what a same-model, no-caching, single-copy-system control should
look like. This is the number a future re-derivation of the bridge's fold
arithmetic should sanity-check against: a de-duplicated payload with caching
off must show plain, cache-field-free `prompt_tokens`, and it does.

---

# T2b post-fix live verification — de-duplicated wire, exclusive source, inclusive client usage

**Date:** 2026-08-07 (commit `eac44fd`, hot-reloaded under nodemon)

**Model:** `anthropic--claude-4.8-opus`, same as every arm above. Two paid
calls, the write-then-read pattern, on a FRESH prefix distinct from all four
arms' filler sentences (54000 chars — a reused prefix would have been served as
a warm read inside the ~5-minute ephemeral TTL and the run-1 write numbers would
have been garbage). Same discipline as the arms: after the reload, the SAME
listening pid (82903) answered `/health` 200 three times in a row before the
first call. Both calls HTTP 200.

This is the shipped code, not a temp edit: arm A2's behaviour is now what
`requestTranslator.ts` and `cacheBreakpoints.ts` do by default, and the two
consumers of that usage were flipped in the same commit —
`recordOrchestrationUsage` folds with `foldExclusiveUsage`, and
`responseTranslator.ts`/`streamTranslator.ts` normalize the client-visible
object to the OpenAI-inclusive convention.

## Predictions, recorded before the calls

1. Wire carries **exactly one** system copy, in `prompt.template`, **marked**;
   `messages_history` carries **zero** system messages. (Arm A2's shape, now
   shipped.)
2. Raw SAP `prompt_tokens` **FLAT** across the two runs — EXCLUSIVE — while the
   cache field moves `0` on the write turn to the same number on the read turn.
3. Client-visible `input_tokens` = `prompt_tokens + cached_tokens +
   cache_creation_tokens` — INCLUSIVE — with `cached_tokens` a subset of it, and
   `total_tokens` recomputed as input + output rather than SAP's exclusive total.
4. Emitted metrics = `inputTokens: <prompt_tokens>` unmodified,
   `cacheCreationInputTokens` / `cacheReadInputTokens` carrying the cache counts
   as separate line items. Specifically NOT `max(0, prompt − cache) = 0`, which
   is what the pre-commit `foldInclusiveUsage` would have produced on this source.

## Run 1 — the cache-WRITE turn

**Wire attribution** (`..._02_responses_request_to_orchestration.json`,
requestId `gateway-1786148934108-glj63jhcn`): `prompt.template` — 1 system
message, **marked** (`cache_control` present on its last block).
`messages_history` — **0** system messages, roles `['user']`. Exactly ONE
`cache_control` marker in the entire payload, and exactly one copy of the
instructions text.

**Raw orchestration `usage` (verbatim)** (`..._03_responses_response_from_orchestration.json`):
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 21292, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 21292, "ephemeral_1h_input_tokens": 0}}}
```

**Client-visible `usage` (verbatim)**:
```json
{"input_tokens": 21306, "input_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 21292}, "output_tokens": 4, "total_tokens": 21310}
```

**Emitted metrics — predicted** `inputTokens 14, outputTokens 4,
cacheCreationInputTokens 21292, cacheReadInputTokens 0`.
**Observed** (captured live off the gateway's `usage-events` Valkey channel,
requestId matching the payload logs above), verbatim:
```json
{"requestId": "gateway-1786148934108-glj63jhcn", "model": "anthropic--claude-4.8-opus", "inputTokens": 14, "outputTokens": 4, "cacheCreationInputTokens": 21292, "cacheReadInputTokens": 0, "statusCode": 200, "endpoint": "/openai/v1/responses"}
```
Match.

## Run 2 — the cache-READ turn

**Wire attribution** (requestId `gateway-1786148938083-ao8kpolhm`): identical to
run 1 — 1 marked system copy in the template, 0 in `messages_history`, roles
`['user']`, 1 `cache_control` marker total.

**Raw orchestration `usage` (verbatim)**:
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 21292, "cache_creation_tokens": 0, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
```

**Client-visible `usage` (verbatim)**:
```json
{"input_tokens": 21306, "input_tokens_details": {"cached_tokens": 21292, "cache_creation_tokens": 0}, "output_tokens": 4, "total_tokens": 21310}
```

**Emitted metrics — predicted** `inputTokens 14, outputTokens 4,
cacheCreationInputTokens 0, cacheReadInputTokens 21292`.
**Observed**, verbatim:
```json
{"requestId": "gateway-1786148938083-ao8kpolhm", "model": "anthropic--claude-4.8-opus", "inputTokens": 14, "outputTokens": 4, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 21292, "statusCode": 200, "endpoint": "/openai/v1/responses"}
```
Match.

## Verdict

All four predictions held, verbatim:

- **ONE system copy on the wire**, in `prompt.template`, marked;
  `messages_history` carries none. The duplication arm A0 measured is gone from
  the shipped payload.
- **`prompt_tokens` FLAT at 14** across the write and the read turn while the
  cache field went `0 → 21292`. The source is **EXCLUSIVE**, exactly as arm A2
  predicted and no longer the inclusive `15903 = 15892 + 11` of arm A0.
- **Client-visible `input_tokens` INCLUSIVE**: 21306 = 14 + 21292 on both runs,
  with `input_tokens_details.cached_tokens` a genuine subset of it, and
  `cache_creation_tokens` reported alongside. `total_tokens` 21310 = 21306 + 4,
  i.e. recomputed — SAP's own `total_tokens` of 18 is the exclusive total and
  would have contradicted the inclusive `input_tokens`.
- **Emitted metrics additive, nothing erased**: `inputTokens` 14 on both turns,
  the 21292 recorded once as a cache write and once as a cache read. Had
  `recordOrchestrationUsage` still folded with `foldInclusiveUsage` it would have
  computed `max(0, 14 − 21292) = 0` on both, billing zero full-rate input and
  under-reporting every cached turn on this route.

Cache-write size sanity check against the arms' table: 21292 tokens for 54000
prefix chars is 0.3943 tokens/char, in the same band as A0/A2/A3 (0.4342 /
0.4182 / 0.4346 — the filler sentence differs, so exact agreement was never
expected) and nowhere near arm A1's 0.8632, which is what paying to cache two
marked copies looks like. One copy on the wire, one copy billed.

**Caveat, recorded rather than smoothed over:** both runs came back
`finish_reason: "content_filter"` with empty content, so the client saw
`status: "incomplete"`, `incomplete_details: {"reason": "content_filter"}` and
an empty `output` array rather than the word "OK". This is the same post-hoc
filter behaviour already documented above and in `responseTranslator.ts` —
`completion_tokens: 4` shows the model did generate, and the filter ran
afterwards — and it leaves the usage object fully populated, which is the only
thing this verification measures. The cache write and the cache read both
happened and were both reported. Nothing about the token accounting depends on
the content having survived the filter.

# T11 capstone re-verification — the new measured baseline

**Date:** 2026-08-07 (commit `aa91c97`, hot-reloaded under nodemon).
**Model:** `anthropic--claude-4.8-opus` for both arms below, same as every arm
above. Appended, not substituted: the A0–A3 arms and the T2b section above are
the historical record of how the regime question was settled and stay verbatim.
The numbers HERE are the ones later tests and comments should re-derive against.

The gateway was serving the admin-published (UNPRUNED) config, so every
Anthropic model still carried an explicit `supports_prompt_caching: true`. The
B1–B3 default tier is therefore NOT exercised by these numbers — caching was on
via the explicit model flag, the same way it was for every arm above.

## Arm 1 — NON-streaming single turn (`POST /openai/v1/responses`)

One paid call, HTTP 200, `finish_reason: "stop"` (a clean completion — this
prefix did not trip the post-hoc content filter the earlier probes hit).
requestId `gateway-1786159382926-215z7djsu`. Prefix: a T11-specific filler
sentence (114 chars) × 300 = **34,500 chars**, distinct from every sentence
above so the ~5-minute ephemeral TTL could not serve it warm.

**Wire attribution** (`…_02_responses_request_to_orchestration.json`):
`prompt.template` roles `['system']` — 1 system copy, marked.
`messages_history` roles `['user']` — 0 system copies. **1** `cache_control`
marker in the entire payload.

**Raw orchestration `usage` (verbatim)**:
```json
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 11704, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 11704, "ephemeral_1h_input_tokens": 0}}}
```

**Client-visible `usage` (verbatim)**:
```json
{"input_tokens": 11718, "input_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 11704}, "output_tokens": 4, "total_tokens": 11722}
```

**Emitted metrics (verbatim, off the `usage-events` Valkey channel)**:
```json
{"requestId": "gateway-1786159382926-215z7djsu", "model": "anthropic--claude-4.8-opus", "inputTokens": 14, "outputTokens": 4, "cacheCreationInputTokens": 11704, "cacheReadInputTokens": 0, "statusCode": 200, "endpoint": "/openai/v1/responses"}
```

`prompt_tokens` is **14**, the same flat constant A2 and T2b measured — it did
not move with a prefix a third the size of T2b's, which is what EXCLUSIVE
means. `input_tokens` 11718 = 14 + 0 + 11704 (inclusive), `total_tokens` 11722
= 11718 + 4 (recomputed; SAP's own total is 18).

Cache-write rate: 11704 / 34500 chars = **0.3392 tokens/char**, below the
0.3943–0.4346 band the earlier arms sat in. That band is a property of the
FILLER TEXT, not of the accounting — each arm used a different sentence — so a
future re-capture should predict its own C from its own text and not from this
number.

## Arm 2 — STREAMING continuation, ≥2 rounds (same endpoint)

One paid call, HTTP 200 in 11.6 s, `stream: true`, `tools: [{"type":"web_search"}]`,
requestId `gateway-1786159572742-x3b9u03ez`. Prefix **39,600 chars**. Round 1
emitted a `web_search` call; the engine ran the search and POSTed one
continuation round. Exactly ONE usage event.

**Round-1 raw orchestration `usage` (verbatim)** — last usage-bearing chunk of
`…_03_sap_response_streaming.json`:
```json
{"completion_tokens": 76, "prompt_tokens": 218, "total_tokens": 294, "prompt_tokens_details": {"cached_tokens": 0}}
```

**Emitted metrics (verbatim)**:
```json
{"requestId": "gateway-1786159572742-x3b9u03ez", "model": "anthropic--claude-4.8-opus", "inputTokens": 7189, "outputTokens": 117, "cacheCreationInputTokens": 125, "cacheReadInputTokens": 12937, "statusCode": 200, "endpoint": "/openai/v1/responses"}
```

**Client-visible merged `usage` (verbatim)** — the single `response.completed`
frame:
```json
{"input_tokens": 20251, "input_tokens_details": {"cached_tokens": 12937, "cache_creation_tokens": 125}, "output_tokens": 117, "total_tokens": 20368}
```

The continuation POST is issued by the hosted-tool engine itself and is NOT
payload-logged, so round 2's raw envelope is derived — but it is
over-determined by the event and the client frame together, which agree with no
free parameters:

| | prompt (full-rate) | completion | cached (read) | cache_creation (write) |
|---|---|---|---|---|
| Round 1 (measured) | 218 | 76 | 0 | field ABSENT |
| Round 2 (derived) | 6971 | 41 | 12937 | 125 |
| Sum | **7189** | **117** | **12937** | **125** |

Event `inputTokens` 7189 = 218 + 6971 — the per-round full-rate remainder only.
Client `input_tokens` 20251 = 7189 + 12937 + 125, i.e. the client's inclusive
total is exactly the billed event's three input categories added back up.

### The one thing that did NOT match, recorded rather than smoothed over

Round 1 wrote a ~12,937-token prefix — round 2 read exactly that back — but
round 1's `prompt_tokens_details` **contained no `cache_creation_tokens` key at
all**, and no `cache_creation_token_details` either. Arm 1 above, same model and
same endpoint but NON-streaming, reported both. So ~12,937 cache-write tokens
were consumed on this request and never reported by SAP, hence never billed.

This reproduces on `/openai/v1/responses` the asymmetry Task 2 measured on
streaming `/openai/v1/chat/completions` (`cache-probe-result.md`). It also
REFINES it: T2 recorded the behaviour as "streaming chat never emits
`cache_creation_tokens`", but round 2 of this same request — also streaming,
same route, same model — DID carry `cache_creation_tokens: 125`. The field is
not categorically absent from streaming envelopes. Whatever the real rule is, it
is not known, and "streaming never reports cache writes" is too strong a
statement to keep asserting.

Nothing in the gateway can be changed to fix this: `translateUsage` and
`recordOrchestrationUsage` both read the field with a tolerant guard and would
carry any value SAP sent. The gateway transcribes provider-reported usage; SAP
is the biller. Direction of error is UNDER-record, so no caller is over-charged
by it. Left open as a provider-side observation.

# B4 — proving the DEFAULT tier, not a config flag, engages caching

**Date:** 2026-08-08. Model: `anthropic--claude-4.8-opus`, negative control
`anthropic--claude-3-haiku--deployed`, both via `POST /openai/v1/responses`.
The admin service pruned the published `api_config`: every Anthropic
`model_list_changes` entry except `anthropic--claude-3-haiku--deployed` (still
explicit `false`) now has NO `supports_prompt_caching` key at all. This section
answers whether the gateway still applies a `cache_control` breakpoint to an
unflagged Anthropic model — and if so, proves it comes from
`resolvePromptCachingSupport`'s `provider === 'anthropic'` default tier
(`src/utils/promptCachingSupport.ts:35-39`), not from any surviving config flag.

## Precondition check (before spending anything)

`services/gateway/src/services/configService.ts` loads config from the local
`api_config.json` file only in standalone mode; this gateway instance runs
non-standalone (`GATEWAY_STANDALONE=false`, `VALKEY_URL` and
`ADMIN_SERVICE_URL` both set in `services/gateway/.env`, confirmed live —
`GET /api/admin/api-config` on the gateway returns 401/403 rather than serving
open, which only happens off the `standaloneOrServiceKeyAuth` branch). In this
mode config arrives from the admin service (HTTP fetch / Valkey
`sap-llm-gateway:config-changed` events into `cachedConfig`), so the repo's
`services/gateway/api_config.json` is not authoritative for what the running
process holds.

Two independent, live checks, both run today:

1. **Repo source file** (`services/gateway/api_config.json`,
   `model_list_changes`): `anthropic--claude-4.8-opus` is `{}` — no
   `supports_prompt_caching` key. `anthropic--claude-3-haiku--deployed` carries
   `"supports_prompt_caching": false`. Only 1 total occurrence of the field
   name in the whole file.
2. **Admin service's own active/published config**, queried directly and
   unauthenticated: `curl http://localhost:4004/odata/v4/validation/getConfig()`
   → HTTP 200, `version: 2026.8.62214`, `lastModified: 2026-08-08T04:28:26.245Z`
   (i.e. modified minutes before this probe). Its `model_list_changes` has 24
   entries; every one of the 12 Anthropic keys is flag-absent except
   `anthropic--claude-3-haiku--deployed: false` — matching the repo file
   exactly.
3. `GET /openai/v1/models` on the live gateway (with the probe API key) lists
   both `anthropic--claude-4.8-opus` and `anthropic--claude-3-haiku--deployed`
   as servable — HTTP 200.

**Residual gap, recorded rather than glossed over:** the gateway's own
in-process `cachedConfig` (the thing `resolvePromptCachingSupport` actually
reads at request time) could not be inspected directly — `GET
/api/admin/api-config` needs a "service key" API key
(`unifiedApiKeyValidationService` rejects the probe's Anthropic-shaped gateway
key with `invalid_service_key`, distinct from an ordinary 401), and no such
key was available. `configService.ts` documents this path as event-driven with
no restart required, so a freshly-published admin config is expected to have
already propagated. This is treated as sufficient to proceed — not proof of
the gateway's in-memory state — and the actual wire capture below (a marker
present with no explicit flag anywhere upstream in either source checked) is
the real confirmation. **Verdict: PROCEED, not BLOCKED**, with the gap stated
above.

## Hand-computed prediction (written before any B4 call)

Payload shape identical to arm A0/A2/A3/T11: `POST /openai/v1/responses`,
`{"model": ..., "max_output_tokens": 32, "instructions": <prefix>, "input":
"Reply with the single word OK."}`.

With no `supports_prompt_caching` flag anywhere for `anthropic--claude-4.8-opus`
(neither model-level nor `anthropic` provider-level, per both live checks
above), `getSupportsPromptCaching` returns `undefined` for both `modelFlag` and
`providerFlag`, so `resolvePromptCachingSupport` falls through both `typeof
=== 'boolean'` checks to `opts.provider === 'anthropic'` → `true`. Wired
through `applyCacheBreakpoints(enabled: true)`, the shipped (de-duplicated,
per arm A2's fix) code marks exactly the ONE system copy that lives in
`prompt.template` — none in `messages_history`. **Prediction: exactly 1
`cache_control` marker in the whole payload, on the template copy.**

- **Call 1** (cold, prefix = the "Arm B4 default-tier probe..." sentence × 78 =
  **12,090 chars**, distinct from every prior arm's/T11's filler text so the
  ~5-minute ephemeral TTL cannot serve it warm): raw envelope EXCLUSIVE, as
  every arm since A2's de-dup fix has shown — flat `prompt_tokens` (predicted
  **14**, the same non-prefix scaffolding constant every A2/A3/T11 run
  measured), `cached_tokens: 0`, `cache_creation_tokens` scaling with the
  prefix. Prior same-style-sentence arms (A0/A2/A3) measured 0.4182-0.4346
  tokens/char; predicted **cache_creation_tokens ≈ 4,800-5,400** (12,090 ×
  0.40-0.44) — an order-of-magnitude/band check, not an exact-value claim.
- **Call 2** (identical body, sent immediately after call 1, inside the ~5 min
  TTL): predicted `cached_tokens` ≈ call 1's `cache_creation_tokens` (the
  write read back), `cache_creation_tokens` ≈ 0, `prompt_tokens` flat at the
  same **14**.
- **Emitted `usage-events` metrics**: additive across the two calls per every
  prior arm — `inputTokens` flat at 14 on both, `cacheCreationInputTokens`
  matching call 1's raw creation figure, `cacheReadInputTokens` matching call
  2's raw cached figure, nothing folded/erased.
- **Client-visible `usage`**: INCLUSIVE on both calls, `input_tokens` =
  `prompt_tokens` (14) + `cached_tokens` + `cache_creation_tokens`.
- A `content_filter` finish with populated `usage` (seen on several prior
  arms) is acceptable evidence per this directory's precedent; the numbers are
  what is being measured, not the surviving text.

**Negative control prediction** (`anthropic--claude-3-haiku--deployed`, single
call, distinct prefix — "Arm B4 negative-control..." × 78 = **12,246 chars**):
`getSupportsPromptCaching(undefined, 'anthropic--claude-3-haiku--deployed')`
returns the model-level `false` directly (`typeof false === 'boolean'` short
circuits before the provider default is ever consulted), so
`resolvePromptCachingSupport` returns `false` regardless of provider.
**Prediction: 0 `cache_control` markers anywhere in the wire payload** — the
explicit-`false` exception mechanism still works after the prune.

## Results

Both opus calls: HTTP 200. requestIds `gateway-1786163981579-awfz5ck4f` (run1)
and `gateway-1786163984275-s8r703apc` (run2), payload-log-captured at
`services/gateway/logs/payloads/2026-08-08T04-39-4{1,4}..._02_responses_request_to_orchestration.json`
/ `..._03_responses_response_from_orchestration.json`.

**Wire attribution** (from the `_02_..._to_orchestration.json` request
captures, read back exactly as `bridge-cache-probe.sh` prints them):

```
run1: template system copies: 1  marked: [[True]]   history system copies: 0  marked: []
run2: template system copies: 1  marked: [[True]]   history system copies: 0  marked: []
```

**MATCH** — exactly 1 `cache_control` marker in the payload, on the template
copy, both runs. No config flag is present anywhere upstream (repo file or
admin service's live active config) that could have put it there — this is
the `provider === 'anthropic'` default tier engaging, nothing else.

**Raw orchestration `usage` (verbatim)**:

```json
// run1
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 4294, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 4294, "ephemeral_1h_input_tokens": 0}}}
// run2
{"completion_tokens": 4, "prompt_tokens": 14, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 4294, "cache_creation_tokens": 0, "cache_creation_token_details": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
```

**Client-visible `usage` (verbatim)**:

```json
// run1
{"input_tokens": 4308, "input_tokens_details": {"cached_tokens": 0, "cache_creation_tokens": 4294}, "output_tokens": 4, "total_tokens": 4312}
// run2
{"input_tokens": 4308, "input_tokens_details": {"cached_tokens": 4294, "cache_creation_tokens": 0}, "output_tokens": 4, "total_tokens": 4312}
```

**Persisted billed usage record** (queried read-only from the dev SQLite DB,
`sap_llm_gateway_admin_ApiKeyUsage`, the table `usageEventProcessor.ts`
populates from the same `usage-events` Valkey channel the prior arms quoted
directly — no subscriber was attached before these two calls, so this table
is the durable record used instead):

```
requestId=...awfz5ck4f  model=anthropic--claude-4.8-opus  inputTokens=14  outputTokens=4  cacheCreationInputTokens=4294  cacheReadInputTokens=0     totalTokens=4312
requestId=...s8r703apc  model=anthropic--claude-4.8-opus  inputTokens=14  outputTokens=4  cacheCreationInputTokens=0     cacheReadInputTokens=4294  totalTokens=4312
```

### Prediction vs observed

| Prediction | Observed | Verdict |
|---|---|---|
| 1 marker, template only, both runs | 1 marker, template only, both runs | MATCH |
| `prompt_tokens` flat at 14 | 14, 14 | MATCH |
| run1 raw: `cached_tokens: 0`, `cache_creation_tokens` scaling with prefix | `cached_tokens: 0`, `cache_creation_tokens: 4294` | MATCH (shape) |
| run1 `cache_creation_tokens` ≈ 4,800-5,400 (0.40-0.44 tok/char band from A0/A2/A3) | 4,294 (0.3552 tok/char) | **band miss, not a defect** — see below |
| run2: `cached_tokens` ≈ run1's write, `cache_creation_tokens` ≈ 0 | `cached_tokens: 4294` (exactly run1's write), `cache_creation_tokens: 0` | MATCH exactly |
| Client `usage` inclusive: `input_tokens` = prompt + cached + creation | 4308 = 14 + 0 + 4294 (run1); 4308 = 14 + 4294 + 0 (run2) | MATCH |
| `total_tokens` recomputed (SAP's own total is 18, ignored) | 4312 = 4308 + 4, both runs | MATCH |
| Emitted/persisted event additive, nothing folded/erased | `inputTokens` flat 14 both; the 4294 recorded once as creation, once as read | MATCH |

The one numeric miss: predicted cache-write tokens/char band (0.40-0.44,
from A0/A2/A3's similarly-worded filler sentences) didn't hold — B4's
sentence measured 0.3552 tok/char, closer to T11 arm1's 0.3392 (a
differently-worded sentence). This is exactly the caveat this file already
recorded after T11: *"That band is a property of the FILLER TEXT, not of the
accounting... a future re-capture should predict its own C from its own
text and not from this number."* B4's own prediction said the same
("an order-of-magnitude/band check, not an exact-value claim") but the band
itself was borrowed from the wrong precedent (A0/A2/A3's sentence style)
instead of being freshly derived. Not a defect — a mis-anchored auxiliary
estimate; the structural predictions it was hedging around (flat
`prompt_tokens`, run2 `cached` = run1 `creation`, additive folds, inclusive
client total) all landed exactly.

### Negative control — unrunnable on this route, documented rather than skipped

`ARM=B4NEG MODEL=anthropic--claude-3-haiku--deployed` on
`POST /openai/v1/responses`: **HTTP 400**, no payload-log files written (the
request never reached the orchestration bridge, so this call was not
billed):

```json
{"error":{"message":"Model anthropic--claude-3-haiku--deployed does not support the Responses API. It requires a deployed GPT-5+ or o-series model, e.g. gpt-5.3-codex--deployed. Use /openai/v1/chat/completions for other models.","type":"invalid_request_error","code":"model_not_supported"}}
```

The model-eligibility gate in front of `/openai/v1/responses` rejects
non-GPT-5+/o-series models before the request reaches
`resolvePromptCachingSupport` or `applyCacheBreakpoints` at all — this is a
different gate than caching, and it is unconditional for this model on this
route regardless of the config prune. `/openai/v1/chat/completions` (the
route the error message points to) does NOT go through the same resolver:
`grep` across `src/controllers` and `src/responses` for
`resolvePromptCachingSupport`/`getSupportsPromptCaching`/
`applyCacheBreakpoints` matches only `responsesController.ts` (this bridge)
and `awsBedrockService.ts` (a separate AWS-direct route); `anthropicController.ts`
only has an unrelated `cache_control?: any` type field, not a call site. So
routing the negative control there would not exercise the code this section
is characterizing — it was left unrun rather than reported as evidence for a
different code path.

**Relying on the unit characterization instead** (per the task's own
fallback): `getSupportsPromptCaching(undefined, 'anthropic--claude-3-haiku--deployed')`
(`configService.ts:1221-1234`) reads `model_list_changes['anthropic--claude-3-haiku--deployed'].supports_prompt_caching`,
finds the literal `false` (confirmed present in both the repo file and the
admin service's live active config in the precondition check above), and
`typeof false === 'boolean'` is true — so `resolvePromptCachingSupport`
(`promptCachingSupport.ts:36`) returns `false` on its FIRST branch and never
reaches the `provider === 'anthropic'` default. The explicit-`false`
exception mechanism is untouched by the prune, by construction of the
resolver's branch order, independent of which route can serve the model.

## B4 verdict

- **Precondition**: PASS — not blocked. Independently confirmed via the repo
  source file and the admin service's live, unauthenticated, freshly-modified
  active config (see above); gateway-internal cache state could not be
  queried directly (no service key available) and is noted as a residual gap.
- **Wire-marker verdict**: default engaged — **YES**. Exactly one
  `cache_control` marker on the template system copy, both calls, with no
  `supports_prompt_caching` flag anywhere upstream that could otherwise
  explain it. This is `resolvePromptCachingSupport`'s
  `provider === 'anthropic'` fallback (`promptCachingSupport.ts:38`) firing,
  not a config flag — the config no longer has one to fire from.
- **Negative control**: unrunnable on `/openai/v1/responses` (model-eligibility
  gate, unrelated to caching, rejects the model before the resolver runs);
  not re-routed to `/chat/completions` because that path doesn't call the
  same resolver. Confirmed instead by code inspection: the explicit `false`
  short-circuits on `resolvePromptCachingSupport`'s first branch.
- **No defect found.** The only prediction miss was an auxiliary tokens/char
  magnitude estimate anchored to the wrong precedent sentence style, not a
  structural or accounting error — every structural prediction (marker count,
  flat `prompt_tokens`, write/read symmetry, additive folds, inclusive client
  total) matched exactly.

## B4 addendum — closing the config-staleness gap (post-review)

Review (`task-B4-review.md`, Important #1) correctly identified a real gap:
`anthropic--claude-4.8-opus` carried an **explicit** `supports_prompt_caching: true`
until B3's same-day prune (`task-B3-report.md`, entry 11). `resolvePromptCachingSupport`
returns `true` identically whether that stale explicit flag or the
`provider === 'anthropic'` default fires, and the wire signature is identical
either way. The precondition check above verified the admin service's SOURCE
OF TRUTH was pruned, not the gateway's own in-process `cachedConfig` — the
thing the resolver actually reads. Closing this required proving the serving
process's memory, not just the source it's supposed to mirror.

**Branch 1 (log evidence) — attempted, genuinely unavailable.** Traced
`libs/logger/index.ts`: `enableFileLogging` defaults to `true` and
`./logs` is created, but `writeToFile` (line 401) is only ever invoked for a
transport of type `'file'` in `this.config.transports`, and the default
transports array is `[{ type: 'console' }]` (line 113) — no file transport is
added anywhere in this repo's config (`services/gateway/.env`,
`api_config.json`'s `logging` block only sets `components`/`defaultLevel`/
`log_folder_path`, none of which add a file transport). Confirmed
empirically: `services/gateway/logs/` contains only `payloads/` (a separate,
purpose-built payload-capture mechanism, not this logger), no `app.log` or
any other file. The gateway's structured logs go to its controlling tty
(`ttys017`) only, which cannot be read back non-interactively. **Branch 1
does not apply — no log file exists to check.**

**Branch 2 (read-only live-state endpoint) — succeeded.**
`GET /openai/v1/models/:model_id?refresh=true` (`modelController.getModelById`
→ `modelService.getModelById(modelId, forceRefresh)`) needs only the same
probe API key already in hand (no service key). `forceRefresh=true` bypasses
`modelService`'s own model-list cache and rebuilds it, which calls
`configService.getModelListChanges()` (`configService.ts:1684-1692`) —
`getConfig()` on the **same module-level `cachedConfig` singleton**
`getSupportsPromptCaching` reads (`configService.ts:1223`, same function name,
same variable). `SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES=true`
(`services/gateway/.env:193`) makes `transformModelsToOpenAIFormat`
(`modelService.ts:629-639`) spread every non-excluded key from the
`model_list_changes` change-entry onto the JSON response — so any stale
`supports_prompt_caching` sitting in the live process's memory for this exact
model would appear directly in the response body.

Called (no Anthropic billing — this hits SAP AI Core's foundation-models
catalogue, not the orchestration/Anthropic route; not counted against the
paid-call budget):

```
curl -H "Authorization: Bearer $K" \
  "http://127.0.0.1:3000/openai/v1/models/anthropic--claude-4.8-opus?refresh=true"
```

Response (verbatim, at `2026-08-08T06:30:50Z`, ~1h51m after the probe, same
un-restarted process, pid 69145 unchanged since it started
`2026-08-07T20:58:50 PDT` / `2026-08-08T03:58:50Z`):

```json
{"id":"anthropic--claude-4.8-opus","object":"model","created":184978800,"owned_by":"Anthropic","model":"anthropic--claude-4.8-opus","executableId":"aws-bedrock","description":"Anthropic Claude 4.8 Opus","versions":[{"name":"1","isLatest":true,"deprecated":false,"retirementDate":"","contextLength":1000000,"inputTypes":["text","image"],"capabilities":["text-generation","image-recognition","reasoning"],"cost":[{"inputCost":null},{"outputCost":null},{"cacheReadInputCost":"0.00037"},{"cacheCreationInputCost":"0.00459"}],"streamingSupported":true}],"displayName":"Claude 4.8 Opus","accessType":"foundation","provider":"Anthropic","allowedScenarios":[{"executableId":"aws-bedrock","scenarioId":"foundation-models"},{"executableId":"orchestration","scenarioId":"orchestration"}],"streamingSupported":true,"subpaths_native":[],"subpaths_emulated":[]}
```

**No `supports_prompt_caching` key anywhere in the response.** (The
`cacheReadInputCost`/`cacheCreationInputCost` entries in `cost` are separate —
`changeEntry.cachePricing`, spread in from SAP AI Core's own foundation-model
catalog data per `modelService.ts:467-479`, unrelated to the caching-enabled
flag. The repo's `model_list_changes['anthropic--claude-4.8-opus']` is
confirmed `{}` — no `cachePricing` key either — so that cost data originates
upstream of `api_config.json` entirely, not from a stale config remnant.)

**Timing closure, reasoned from the codebase's own architecture, not just
inferred from probability:** config in this deployment is 100% event-driven —
`getConfig()` never re-polls or re-fetches on its own (the HTTP-fallback
branch in `getConfig()` only runs when `VALKEY_URL` is unset, which it is not
here); `cachedConfig` changes ONLY via a `CONFIG_CHANGE_CHANNEL` Valkey
message (`handleConfigChangeEvent`) or a process restart. Valkey pub/sub is
non-durable — confirmed during the precondition-check investigation, no `SET`
key holds the config for later replay, only the transient `publish` call
(`services/admin/src/srv/config-service.ts:702-745`). Re-queried admin's
`getConfig()` OData endpoint at the same moment as the branch-2 check:
`version: 2026.8.62214`, `lastModified: 2026-08-08T04:28:26.245Z` —
**unchanged** from the precondition check taken before the probe. Therefore:
no restart occurred (same pid throughout) and no second publish occurred
(version/timestamp identical) between the probe and this check, so there is
no OTHER event that could have delivered the pruned config to this process at
some point after the probe — the only publish in the entire observed window
is the one at `04:28:26.245Z`, 11 minutes before the probe. Since the process
demonstrably holds the pruned state now, and non-durable pub/sub with zero
restarts and zero republishes rules out any delivery mechanism other than
that one event, the process necessarily ingested the prune at (or
immediately after) `04:28:26.245Z` — not at some arbitrary later point in the
~1h51m since. **The gap is closed**, not merely argued down: the live process
is confirmed, directly, to have been running on the pruned config before the
probe's `04:39:41Z`/`04:39:44Z` calls.

**Residual doubt:** none identified. The one theoretical edge case — the
Valkey subscriber silently erroring at `04:28:26` (logged, not escalated,
per `configService.ts:336-353`) and the process instead having self-healed
via some other path before `06:30:50` — has no mechanism in this codebase:
there is no reconnect-then-catch-up-on-missed-events logic, no periodic
re-poll, and the only two config-refresh triggers (`handleConfigChangeEvent`,
process restart) are both accounted for above. If the subscriber really had
been down at `04:28:26`, the process would still be holding whatever
pre-prune config it started with — it is not, so the subscriber was not down
at that moment.
