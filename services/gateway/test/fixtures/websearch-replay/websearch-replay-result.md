# Orphan `web_search_call` replay probe — result

**Date:** 2026-08-08
**Model:** `gpt-5.3-codex`, live via `POST http://127.0.0.1:3000/openai/v1/responses`
(streaming), gateway running under nodemon, deployment path (never called
directly). Auth: gateway API key from `~/.zshrc`, never printed. Script:
`websearch-replay-probe.sh` in this directory.

**Method:** All three arms are built from the SAME captured turn-2 Codex
client request (`services/gateway/logs/payloads/2026-08-08T06-45-35-476Z_gateway-1786171535462-d1nfkg7km_00_original_responses_request.json`,
`.payload`) so model, instructions, tools, tool_choice, reasoning, stream,
include, `prompt_cache_key`, and `client_metadata` are byte-identical across
arms. The only variable is `input[6]`, a completed `web_search_call` item
with no matching output:

- **Arm A (control):** payload verbatim, orphan item present (9 items).
- **Arm B (removal):** orphan item deleted (8 items).
- **Arm C (candidate fix shape):** orphan item replaced by a
  `function_call` (`name: web_search`) + matching `function_call_output`
  pair, shapes mirrored from `hostedTool/registry.ts`'s `descriptorForCall`
  (`type === 'function_call' && name === 'web_search'`) and
  `webSearch/continuation.ts`'s `buildFunctionCallOutput`. No real prior
  results exist to hand back, so the output is an honest placeholder:
  `{"results":[],"note":"Prior web_search results were not retained across
  turns (store: false); a new search is required to see results for this
  query."}` (10 items).

**Discriminator (fixed before running):** for each call, whether the
**raw deployment stream** (`*_03_responses_stream_from_deployment.json`,
freshly written by the live gateway for that call — payload logging is on)
carries `response.function_call_arguments.*` events for a `name: "web_search"`
function_call. This is upstream of the hostedTool engine's suppression/
rewrite, so it reflects what the model actually did, independent of what the
client ends up seeing. Cross-checked against the client-facing SSE capture
(my own curl output) for the synthetic `web_search_call` item the engine
injects when a search actually ran.

## Pre-registered interpretation rules (fixed before any call was made)

- A = no-call twice, B = call at least once → orphan item implicated.
- A and B both no-call → the orphan item is **not** the cause; the refusal
  is model behaviour on this conversation shape; say so plainly, do not
  rescue the hypothesis.
- C calling when B calls → the translation fix is viable in principle.
- C not calling while B calls → removal works but the naive translated
  pair doesn't; report what that implies for the fix design.
- Mixed results within an arm (1 of 2) → INCONCLUSIVE for that arm; report
  what further n would settle it; do not round toward the hypothesis.

## Per-call results

All 6 calls returned HTTP 200 on the first attempt — no retries used, no
400s to adjust a shape against.

| Arm | Call | HTTP | `function_call_arguments` events (raw deployment) | function name | client-visible `web_search_call` item |
|---|---|---|---|---|---|
| A | 1 (`gateway-1786172751040-blhlfcd5g`) | 200 | 0 | — | absent |
| A | 2 (`gateway-1786172757595-41ys4jp7q`) | 200 | 0 | — | absent |
| B | 1 (`gateway-1786172801732-icv74qgio`) | 200 | 0 | — | absent |
| B | 2 (`gateway-1786172806719-627g16ogy`) | 200 | 0 | — | absent |
| C | 1 (`gateway-1786172819466-l7ayuxbb0`) | 200 | 20 | web_search | **present** |
| C | 2 (`gateway-1786172833694-i1nu692kt`) | 200 | 18 | web_search | **present** |

**Arm A: 0/2 calls.** No `function_call_arguments` event in either raw
deployment capture; no client-visible `web_search_call` item. The model's
own text differed in style between the two calls but agreed on substance:
call 1 answered with a plausible-looking "news roundup" citing only bare
domain URLs (`https://www.reuters.com/`, `https://www.bbc.com/news`, etc. —
no specific article paths) and only at the very end offered "a strictly
verified version" if asked — i.e. it silently fabricated rather than
disclosed up front. Call 2 refused outright: *"I don't currently have live
browsing results with clickable source URLs in this turn... without another
web pull."*

**Arm B: 0/2 calls.** Same discriminator result as A — no function_call in
either raw deployment capture. Call 2's refusal text: *"I don't currently
have live web results attached in this thread, so I can't reliably provide
verified Reuters/AP/WSJ/BBC links without doing a fresh fetch."* Near-
identical phrasing to Arm A call 2 ("without another web pull" / "without
doing a fresh fetch"), despite the orphan item being entirely absent from
this arm's input.

**Arm C: 2/2 calls.** Both raw deployment captures show 18–20
`response.function_call_arguments.{delta,done}` events for a `name:
"web_search"` function_call, and both client-facing SSE captures carry the
gateway's synthetic `web_search_call` item — the engine ran the search and
spliced a continuation, and the final answer cited real, specific article
URLs (e.g. a `reuters.com/legal/litigation/...` path) rather than bare
domains.

## Verdict, under the pre-registered rules

**A and B both no-call (0/2 each) → the orphan `web_search_call` item is
NOT the cause.** The refusal is model behaviour on this conversation shape,
reproduced whether the malformed item is present (A) or removed entirely
(B). This is stated plainly per the pre-registered rule; the hypothesis is
not rescued by Arm C's result (see caveat below), because the fixed rules
key the "viable fix" branches off "B calls," which did not happen.

**Arm C's 2/2 call result is real but not a clean test of "the wire shape
alone."** The rules anticipated evaluating C only in the world where B
already showed calling; that branch doesn't apply here. Arm C differs from
B in two ways at once, not one: (1) the wire shape is now well-formed
(a paired function_call/function_call_output the deployment's tool set
recognizes) — this is what the experiment intended to isolate — but (2) the
placeholder `function_call_output.output` I had to write also contains the
sentence *"a new search is required to see results for this query,"* which
reads as an explicit instruction, not just a neutral status. Given B alone
already rules out the orphan item as the root cause, the more likely
explanation for C's 2/2 is that this instructional content — not a
structural fix — is what changed the model's behavior. **This is a
confound this experiment cannot separate with its budget spent:** a
follow-up arm with a neutrally-worded placeholder (e.g. "no results
recorded" with no call-to-action) and no other change would be needed to
isolate whether wire-shape correctness alone, independent of any nudge text,
restores calling. Recorded here rather than rounded toward either
conclusion.

## Answers to the two dig questions

**1. Does the turn-2 request's `include` ask for `web_search_call.results`,
and would codex ever replay results if we emitted them?**
No — the captured turn-2 (and turn-1) requests both carry
`"include":["reasoning.encrypted_content"]` only; `web_search_call.results`
is never requested. More importantly, **the gateway could not honor it even
if asked**: `engine.ts`'s `renderOptsFor` builds `includeResults` from the
request's `include` array generically, but `webSearch/descriptor.ts`'s
`renderCallItem` ignores the `opts` parameter entirely (`renderCallItem: (r,
_opts) => buildWebSearchCallItem(...)`), and `responsesAdapter.ts`'s
`buildWebSearchCallItem` has no `results` field in its shape at all —
`includeResults` is only wired up for `file_search`
(`fileSearch/descriptor.ts:575`). So this is unverifiable from codex's own
behavior with current data: the gateway has never emitted a `web_search_call`
item carrying `results`, so there is no capture on disk (or possible one
today) showing whether codex would replay it. A proper fix that wants to
restore real results, not just a placeholder, needs the `web_search`
descriptor to implement `includeResults` first — that is unbuilt today, not
merely unused.

**2. Does the deployment silently ignore the unrecognized `web_search_call`
item type, or is there a sign it processed it?**
Not simply dropped. All calls carrying the orphan item (Arm A, both) came
back HTTP 200 with no error — the deployment does not reject the unknown
item type outright. And the model's own refusal language in both Arm A and
Arm B explicitly reasons about having (or not having) "live browsing
results attached in this thread" / "results ... in this turn" — vocabulary
that tracks the *concept* of a prior search, which in Arm B's case the
model could only be drawing from elsewhere in the conversation transcript
(the visible discussion of wanting AI news), since Arm B's `input` contains
no search-shaped item at all. That undercuts reading the orphan item as
special-cased content the deployment "processes" as such; the simpler
explanation is that the whole `input` array — recognized item types and
not — gets serialized into the model's context as transcript, and the
model reasons over whatever text results, unrecognized `type` fields
included, without a hard parse-level rejection. No `response.output` echo
of the orphan item was observed in any raw deployment capture (input items
are never echoed into Responses `output` regardless), so there is no direct
positive evidence of special handling either way — only the absence of a
rejection and the presence of on-topic reasoning in text form.

## Surprise / anything unanticipated

- **The `seq 1 "$CALLS"` loop bug.** The probe script's first version used
  `for n in $(seq 1 "$CALLS")`. On macOS's BSD `seq`, `seq 1 0` counts DOWN
  and prints `1` then `0` rather than nothing, so a `CALLS=0` dry run of
  the arm-building step actually fired two real, paid Arm A calls before
  the bug was caught (from the "run=1" / "run=0" labels in the transcript).
  Fixed to a C-style `for ((n = 1; n <= CALLS; n++))` before any further
  calls; verified the fix produces zero iterations for `CALLS=0`. The two
  accidental calls used the correct, verbatim Arm A body, so they were kept
  as Arm A's two calls rather than discarded and re-spent — total paid
  calls for the whole experiment stayed at 6, at budget.
- **Arm A's two calls diverged in *style* (silent fabrication vs. explicit
  refusal) while agreeing on the discriminator (0 function_call_arguments
  events in both).** Worth flagging because the fixed discriminator is the
  SSE event, not the prose — a read that only skimmed the prose could
  mistake call 1 for "not a refusal" and miscount the arm.
- **Arm B's refusal phrasing nearly mirrors Arm A's**, word-for-word in
  structure ("I don't currently have live browsing/web results
  attached/in this turn/thread... without another web pull/fresh fetch"),
  despite one arm containing the orphan item and the other not containing
  it at all. That similarity is itself evidence for "this is stable model
  behavior on this conversation shape," independent of the orphan item.
- Prompt caching was active and consistent (`input_tokens_details.
  cached_tokens: 10240` of `10408` on both Arm A calls, same prefix) and
  showed no sign of interfering with the discriminator reading.

---

# Follow-up: deconfounding Arm C (2026-08-08)

Arm C changed two things at once relative to Arm B: (1) it gave the model a
well-formed `function_call`/`function_call_output` **exemplar of its own
prior web_search use**, in the shape its tool list actually uses, where
before it had either the untranslated hosted item (Arm A) or nothing (Arm
B); (2) its placeholder output text said *"a new search is required,"*
which reads as an instruction. Budget: 4 paid calls (Arm D 2, Arm E
conditional on D's result).

Reused `websearch-replay-probe.sh` (`ARM=D`/`ARM=E`), same source capture,
same discriminator. Confirmed the `seq` loop bug from the first run is
fixed: `ARM=D CALLS=0` was run first and fired zero HTTP calls (verified by
the absence of any `=== arm=... run=... ===` line in its output) before any
paid call was made.

## Pre-registered interpretation rules (fixed before Arm D/E were run)

- D calls 2/2 → the wire-shape exemplar drives it, not the instruction; the
  translation fix is genuinely viable.
- D calls 0/2 → Arm C's result was the instructional nudge; translation
  alone won't fix the user's experience; this is model behavior we cannot
  fix by translation.
- D mixed (1/2) → inconclusive; state what n would settle it; do not round
  toward either conclusion.
- Arm E runs only if D is 2/2 or 0/2 (skip if D is mixed): if the model
  still searches with an unrelated (`get_goal`) exemplar in D's place, the
  driver is "there is some tool-call exemplar in history" generically; if
  it doesn't, the driver is specifically a *web_search* exemplar.

## Arm D: byte-identical to Arm C's `function_call`; only `function_call_output.output` changed to strictly neutral text

`function_call` (identical to Arm C): `{"id":"fc_replay0001","type":"function_call","status":"completed","arguments":"{\"query\": \"latest AI news today\"}","call_id":"call_replay0001XXXXXXXXXXXX","name":"web_search"}`

`function_call_output.output` (neutral, no imperative — the only byte
difference from Arm C): `{"results": [], "state": "not_retained_in_conversation_history"}`

| Call | HTTP | `function_call_arguments` events (raw deployment) | function name | client-visible `web_search_call` item |
|---|---|---|---|---|
| 1 (`gateway-1786173307988-zx1wx5o8i`) | 200 | 18 | web_search | **present** |
| 2 (`gateway-1786173321695-4m8el8e2x`) | 200 | 0 | — | absent |

**Arm D: 1/2 — MIXED.** Call 1 called the tool (search executed, real
article URL in the final answer). Call 2 did not call the tool, and its
refusal text is the most direct evidence yet on *why*: *"I need one quick
retry first: the web tool returned an empty result set on the first query
in this environment."* The model read the neutral placeholder
(`{"results": [], "state": "not_retained_in_conversation_history"}`) as **"a
search ran and came back empty"** rather than as the intended "no record of
results" — i.e. even non-imperative, purely factual placeholder content
still gets interpreted as information about what happened, and that
interpretation can go either toward or away from calling the tool again.

## Arm E: skipped

Per the pre-registered rule, Arm E runs only if D comes back 2/2 or 0/2.
D was mixed (1/2), so Arm E was not run. The 2 calls earmarked for it were
not spent — total paid calls for this follow-up: 2 of the 4-call budget.

## Verdict on what actually drives the tool call

**Inconclusive on Arm D's own terms — but informative.** A single mixed
(1/2) result under the pre-registered rules cannot distinguish "the
wire-shape exemplar drives it" from "it's still partly about content," and
per those rules this is reported as INCONCLUSIVE, not rounded toward either
side. What would settle it: at least 4-6 more Arm D calls (n≥6 total) to
see whether the true rate is close to 50/50 (in which case the exemplar
alone is a weak, probabilistic nudge rather than a reliable fix) or clusters
toward one end (in which case n=2 was simply an unlucky/lucky small
sample). That budget was not spent here — the 4-call follow-up budget was
capped, and the pre-registered protocol explicitly gates Arm E on a clean D
result, not on spending down to zero regardless of what D shows.

What Arm D *does* establish, independent of the 2/2-vs-0/2 question: a
strictly neutral, non-imperative placeholder does not reliably suppress
re-searching (call 1) or reliably permit it (call 2) — and, notably, was
apparently read by the model in call 2 as "search executed, zero results,"
not as "no results on record." That is itself evidence against treating
"remove the imperative language" as a sufficient fix in isolation: even
careful neutral wording carries an interpretation the model can run with,
and a translation fix cannot fully control which interpretation lands
without also controlling for that.

## Cap finding (free, no calls)

**Ruled out.** `hostedTool/engine.ts` enforces two caps, both request-
scoped and neither carrying any state across turns:

- `MAX_PENDING_CALLS_PER_TURN = 4` — the before-handler's pending-drain
  cap, a `const` read once per HTTP request.
- Each descriptor's `maxCallsPerRequest()` — for `web_search`,
  `configService.getWebSearchMaxSearches()`, which resolves to
  `config?.api_config?.web_search?.max_searches_per_request` or
  `DEFAULT_MAX_WEB_SEARCHES = 3` (`webSearch/searchCap.ts`). The counter
  that enforces it, `callsRunByType`, is a `Map` declared **inside**
  `installHostedToolInterceptor(req, res, ...)` — i.e. freshly created on
  every incoming HTTP request, not persisted anywhere `store: false`
  reaches. Since Codex replays full history with no `previous_response_id`,
  each turn is its own fresh HTTP request, so this cap resets every turn by
  construction; it cannot accumulate across turns even in principle.
- Nothing in the conversation ever got close to either cap: the whole
  captured conversation contains exactly one real search (turn 1), and
  every `web_search_call` item observed across turns 1-3's captures has
  `status: "completed"`, never `"failed"` — the status a capped-out call's
  synthetic item would carry
  (`hostedTool/engine.ts`'s `failedResult`/`failedPlaceholder` path). So
  there is no signal in what the model can see — no failed call item, no
  cap-adjacent status — from which it could infer a cap was ever hit or
  even exists. Both the mechanism (resets every turn, request-scoped) and
  the observed data (cap never approached, no failure signal ever emitted)

---

# Follow-up: Arm F — faithful, non-empty results (2026-08-08)

Arm D's mixed result exposed a second confound the coordinator flagged:
`results: []` (empty) reads to the model as "the search ran and found
nothing," not as "we have no record" — a placeholder can't express "not
retained" in that field without being misread as a search outcome. Arm F
drops the placeholder entirely and uses the REAL thing: `function_call`
byte-identical to Arm C/D's, paired with a `function_call_output` in
`buildFunctionCallOutput`'s exact shape
(`{type, call_id, output: JSON.stringify({results: [...]})}`), populated
with the actual 5 result entries (`title`, `url`, `snippet`, `content`,
`date`) turn 1's own search returned.

**Source of the real entries:** `searchExecutor.ts` logs the raw Perplexity
response via `savePayload('websearch-direct', '10_perplexity_direct_response', ...)`
— a debugRequestId not tied to the gateway request, so it isn't named after
turn 1's requestId. Identified by timestamp instead:
`2026-08-08T06-44-08-949Z_websearch-direct_10_perplexity_direct_response.json`
falls inside turn 1's own request window (`00` capture 06:44:00.219Z, `03`
capture ends 06:44:13.319Z) and its `query` field is `"latest AI news
today"` — an exact match to the orphan item's recorded query. `payload.rawResponse.choices[0].message.content`
is a JSON string whose `results` array (5 entries) is already in
`searchExecutor.ts`'s `SearchResult` shape (`title`/`url`/`snippet`/`content`/`date`),
so no reshaping was needed beyond wrapping it in `buildFunctionCallOutput`'s
envelope. Confirmed by fidelity check: several of Arm F's actual answers
(below) cite the *same* Reuters URL and headline present in this captured
result set.

Ran with the fixed `seq` loop (`ARM=F CALLS=0` dry run first, verified zero
HTTP calls, before spending any of the budget).

## Pre-registered interpretation rules (fixed before Arm F was run)

- ≥4/6 call → the fix restores tool use against a control of 0/4 (Arms
  A+B); translation-with-retained-results is worth building.
- ≤1/6 call → the fix does not rescue this conversation shape; the refusal
  is model behaviour we cannot translate our way out of; the honest
  recommendation is to stop here.
- 2-3/6 → real but unreliable effect; report the observed rate as such, do
  not round.
- Every no-call classified as (i) answered from the replayed results
  (acceptable product behaviour — a model holding real prior results
  reasonably answering from them instead of re-searching) or (ii) claimed
  inability / promised to search later (the actual failure mode under
  test) — report both the raw call count and this classification, since
  they answer different questions.

## Per-call results

All 6 calls, same Arm F body, HTTP 200 on every call, no retries needed.

| Call | HTTP | `function_call_arguments` events | function name | client-visible `web_search_call` item | Outcome |
|---|---|---|---|---|---|
| 1 (`gateway-1786173677851-0wtefcb46`) | 200 | 0 | — | absent | **no-call** |
| 2 (`gateway-1786173680399-xjaf3aqv9`) | 200 | 20 | web_search | present | call |
| 3 (`gateway-1786173704234-ei0bv6hbj`) | 200 | 18 | web_search | present | call |
| 4 (`gateway-1786173727339-l46i60czl`) | 200 | 18 | web_search | present | call |
| 5 (`gateway-1786173748714-g6pv2327i`) | 200 | 18 | web_search | present | call |
| 6 (`gateway-1786173762257-64wtsj0am`) | 200 | 18 | web_search | present | call |

**5 of 6 calls: call.** Calls 2-6 each re-searched (a fresh search, not a
replay of the injected results — the engine's continuation always runs a
live `execute()`), and their final answers cite the real Reuters headline/
URL that was actually present in the injected result set (call 2, short
fragment: *"Reuters: OpenAI flags possible critical cybersecurity risk in
upcoming model"* — the same headline as entry 1 of the real Arm F results).

## Classifying the one no-call (call 1)

Full text (short enough to quote in full, still a fragment of the overall
exchange): *"Great — I can do that. I'm ready to pull and rank a clean
**Top 5 AI stories** from **Reuters/AP/WSJ/BBC** with direct links and a
one-line 'why it matters' for each."*

**Classification: (ii) — promised to search later, not (i) answered from
the replayed results.** The text contains no headline, URL, or fact drawn
from the 5 real injected results; it reads as queuing up to search rather
than declining ability, and does not answer the user's question at all in
this turn.

## Verdict

**5/6 ≥ the ≥4/6 threshold: the fix restores tool use against a control of
0/4 (Arms A+B, 0 calls in 4 combined attempts).** Translation-with-
retained-results is worth building, per the pre-registered rule. Reported
alongside the classification because it matters to the user experience:
even in the one no-call, the model did not claim inability or fabricate an
unsearched answer (Arm A/B's failure modes) — it visibly intended to search
and, in 5 of 6 identical attempts, did.

## Aggregate finding: has ANY organic conversation on disk ever searched twice? (free, no calls)

Scanned every `*_00_original_responses_request.json` in
`services/gateway/logs/payloads/` (92 files), excluded the 14 this whole
investigation generated (Arms A-F; matched both by their exact requestIds
and, as an independent second check, by the presence of this script's
`call_replay0001` marker — both methods agreed exactly, 92 − 14 = 78
organic requests). Of the 78 organic requests:

- **3** carry a completed `web_search_call` already in their replayed
  `input` history (the same 3 identified at the start of this experiment:
  turns 2 and 3 of the conversation under test, plus one more,
  `gateway-1785290320641-wxawl9sr9`, from a separate, earlier conversation).
- **0 of those 3** searched again — cross-checked against each one's own
  `*_03_responses_stream_from_deployment.json` for `function_call_arguments`
  events, same discriminator used throughout. This reproduces, on the FULL
  organic dataset rather than the single 3-turn conversation this
  experiment started from, the "3/3 no-call with prior search in history"
  observation stated at the outset.
- Of the other 75 organic requests (no prior search in history — including
  39 whose `input` is a bare string, i.e. a first turn with no history at
  all, which by construction cannot carry a prior search), 9 searched, 9
  did not, and 57 have no matching `03` capture on disk to check (mostly
  short non-tool probes like "Reply with the single word OK." that never
  reach the streaming continuation path). The **9 searched / 9 did not**
  split matches the "9 calls with none" figure referenced at the outset.

**Answer: NO — across every organic capture on disk, zero conversations
have ever performed a second web search after a completed one already
appeared in their replayed history.** This is a plain product-level fact,
not an artifact of the one conversation this experiment focused on: it
holds on the full dataset. (This experiment's own Arms C, D, and F DID
produce a second search after an exemplar in history — 2/2, 1/2, and 5/6
respectively — but those are experimenter-constructed function_call/
function_call_output pairs, not anything Codex's own client ever actually
sent; they show it's *possible* under a translated shape, not that it has
ever happened organically.)
  rule this out as a contributing factor to the refusals under test.
