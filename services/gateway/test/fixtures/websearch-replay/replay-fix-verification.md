# Hosted-tool result replay — live verification

Written BEFORE the run, per the plan's Task 7 Step 1. Predictions first; observations are appended
afterwards beside them, including any mismatch, verbatim.

Code under test: commits `c202f44`..`1e9dcfc` on branch `claude` (Tasks 1-6 of
`docs/superpowers/plans/2026-08-10-hosted-tool-result-replay.md`). The gateway runs under nodemon
and hot-reloaded these edits; `/health` answered 200 before the run.

## What was broken

The engine rewrites the hosted `web_search` tool into a plain `function` tool (SAP deployments
reject hosted tool types), then renders the model's function call back into a client-visible
`web_search_call` item. Codex replays that item verbatim on every later turn, and nothing read it
back in — so the model saw a completed call belonging to a tool absent from its tool list, with no
output, and answered by promising to search rather than searching.

Measured on 2026-08-08 (`websearch-replay-result.md`, same directory):

| Arm | Replayed history contained | Searched |
|---|---|---|
| A | the `web_search_call` item, untranslated (the shipped behaviour) | 0 / 2 |
| B | nothing — the item deleted | 0 / 2 |
| C | a `function_call`/`function_call_output` pair, output text saying a new search was required | 2 / 2 |
| D | the same pair, output `{"results": [], "state": "not_retained_in_conversation_history"}` | 1 / 2 |
| F | the same pair, output carrying the REAL results of the original search | 5 / 6 |

Across 78 organic requests on this gateway, 3 carried a completed search in replayed history and
**none of those 3 ever searched again**.

## Predictions for this run

A two-turn codex conversation: turn 1 asks for a web search; turn 2 asks for a fresh second pass.

**Turn 1**
1. The client's request carries the hosted `web_search` tool; the payload sent to the deployment
   carries it rewritten as `{"type": "function", "name": "web_search"}`.
2. The raw deployment stream contains `response.function_call_arguments.*` events — the model
   calls the tool.
3. The client-visible output contains a `web_search_call` item whose `id` begins `ws_` and whose
   `action.query` is the query the model chose.
4. The result is cached under that exact id.

**Turn 2 — the whole point**
5. The client's own request (stage `00_original`) still replays a `web_search_call` item. Nothing
   about the client changes; this is unchanged from the broken behaviour.
6. The payload sent to the deployment (stage `02_..._to_deployment`) contains **no**
   `web_search_call` item at all. In its place: a `function_call` named `web_search` whose
   `call_id` equals the replayed item's `id`, immediately followed by a `function_call_output`
   with the same `call_id`.
7. That `function_call_output`'s `output` parses to `{"results": [...]}` whose entries carry the
   same URLs turn 1's search returned — the cache hit, not a placeholder and not a re-fetch.
8. Because the pair is satisfied, no live search runs for the replayed call: the search executor
   is not invoked for turn 1's query a second time.
9. The raw deployment stream for turn 2 contains `response.function_call_arguments.*` events —
   the model performs a NEW search for the second pass. **This is the discriminator.** The prose
   answer is not evidence; the SSE event is.

**Cache-miss behaviour (not exercised by this run unless the gateway restarted between turns):**
a replayed item whose results are no longer cached still becomes a `function_call`, deliberately
left unsatisfied, so the engine's existing pending-call drain re-executes the recorded query live.
A placeholder output is never emitted — arm D above is why.

## Observations

Run on 2026-08-10 against the live gateway (nodemon, `/health` 200) from the codex TUI
(`codex` v0.146.1, model `gpt-5.3-codex`, `CODEX_HOME` pointed at a scratch config whose
`base_url` is `http://localhost:3000/openai/v1`, `wire_api = "responses"`). Two turns, driven
exactly as the failing conversation was: "Use websearch to get the latest news in AI for today",
then `sure` in reply to the model's own offer of a second pass.

- Turn 1 — `gateway-1786392362800-7bzwlbw1c`
- Turn 2 — `gateway-1786392416850-2lwcojb3c`

| # | Prediction | Observed | |
|---|---|---|---|
| 1 | outbound tool is the rewritten `function` | `('function', 'web_search')` last in the tools array | MATCH |
| 2 | turn 1 calls the tool | `function_call_arguments` events present in the raw deployment stream | MATCH |
| 3 | client sees a `ws_`-prefixed call item | `ws_msnnwbe43ianhm8` | MATCH |
| 4 | result cached under that id | proven transitively by prediction 7 | MATCH |
| 5 | turn 2's client request still replays the hosted item | client input: 6 × `message`, 1 × `web_search_call` | MATCH |
| 6 | no hosted item reaches the deployment; a `function_call`/`function_call_output` pair replaces it, same `call_id` | outbound input: 6 × `message`, 1 × `function_call`, 1 × `function_call_output`, both `call_id = ws_msnnwbe43ianhm8`; hosted-item-survived check `False` | MATCH |
| 7 | that output carries turn 1's real results | `results=27`, urls beginning `https://www.wsj.com/tech/ai`, `https://aiweekly.co/ai-news-today` | MATCH |
| 8 | no re-execution of the replayed call | the replayed pair is satisfied, so the drain skipped it; turn 2's live searches used new queries (below) | MATCH |
| 9 | **the discriminator** — turn 2 performs a NEW search | `function_call_arguments.done` with `{"query":"Reuters AI August 10 2026 artificial intelligence latest"}`, and the TUI shows a second search for `AP News artificial intelligence August 10 2026` | MATCH |

Nine of nine. The replayed call's own query was `latest AI news today`; turn 2's two live searches
used different, second-pass queries, so the new searches are genuinely new work rather than a
re-run of the cached call.

**What the user sees.** Turn 2 rendered `Searched the web for Reuters AI August 10 2026 artificial
intelligence latest`, then `Searched the web for AP News artificial intelligence August 10 2026`,
then the "Top 5 verified (today-focused)" brief with per-item source links — the deliverable the
original conversation promised and never produced. Before this change the same turn answered
"I'm unable to fetch a fresh second web pass right this moment in this turn."

**Cap interaction, observed.** Turn 2 ran two live searches plus one satisfied replay, inside
`web_search`'s cap of 3. The parked finding — that the pending-call drain never consults
`descriptor.maxCallsPerRequest()` — was not exercised here, because the replay was a cache hit and
so never entered the drain. It remains a follow-up.

**Unrelated observation, recorded not chased.** The TUI warned `Model metadata for gpt-5.3-codex
not found. Defaulting to fallback metadata; this can degrade performance and cause issues.` That is
a client-side catalogue lookup against the gateway's model list and is independent of this change —
it appeared identically on the pre-fix runs.

## Predictions for the cap-exhaustion run (Task 3, A1/A2 live check)

Code under test for this section: `webSearchDescriptor.renderOutput` /
`webSearchDescriptor.renderResultMessage` in
`services/gateway/src/plugins/webSearch/descriptor.ts`, both now reading a shared
`failureMessageFor(code)`. For `code === 'cap_reached'` that function returns: *"The web-search
budget for this turn is used up. Answer using the results you already have. Do not tell the user
the search returned nothing."* Before this change, the streaming-path fallback
(`renderResultMessage`) fell through to `buildSearchMessageItem([], query, ...)` for a failed call
— a `results: []` message the model reads as "ran and found nothing", which is false for a call the
cap refused to run at all. `renderOutput` (the function_call_output path, used when a continuation
POST is open) already carried a `cap_reached` code before this session but not this prose; now both
hooks emit the identical sentence, so whichever path this transport actually exercises should carry
the same wording.

`web_search`'s cap is `configService.getWebSearchMaxSearches()`, defaulting to 3
(`DEFAULT_MAX_WEB_SEARCHES` in `services/gateway/src/plugins/webSearch/searchCap.ts`).

**The turn.** One fresh codex session (`/quit` + relaunch, so no prior-turn history), one message
asking for five distinct searches — more than the cap of 3 allows:

> Search the web separately for each of these and give me one line on each: (1) AI regulation news
> today (2) chip export news today (3) LLM benchmark news today (4) AI funding news today (5)
> open-source model news today

1. Exactly 3 `function_call_arguments.done` events land in the new
   `*_03_responses_stream_from_deployment.json` — the cap, not 5.
2. At least one further search attempt is refused; the budget wording above reaches the model
   somewhere in the captures, either as a `function_call_output` (continuation path) or an
   assistant `message` item (streaming-fallback path) — whichever this transport actually takes is
   itself the finding, since unit tests could not observe it.
3. The model's reply to the user either says outright that it used its available searches (e.g.
   naming 3 of 5, or noting a limit) or simply answers the remaining items from general knowledge
   without claiming to have searched for them. It does **not** say a search "found nothing," "returned
   no results," or that searching "failed" for the un-searched topics — that would be the exact
   false claim this change exists to prevent.

## Observations for the cap-exhaustion run

Run on 2026-08-10 against the live gateway (nodemon, hot-reloaded). Fresh codex session — the prior
session (which had two turns of accumulated history) was left to exit on its own; a brand-new
`codex` process was launched with the same `CODEX_HOME`-pointed-at-`localhost:3000` env prefix from
shell history, and the single turn above was sent to it, with the composer confirmed idle first.

- Turn — `gateway-1786412228356-anbsv6i4r`, single request/response (no second client turn).

**Live searches, from the wire.** Only 3 `*_websearch-direct_10_perplexity_direct_response.json`
files landed for this turn's time window (`01:37:21`, `01:37:28`, `01:37:38`), for queries `AI
regulation news today`, `chip export news today`, `LLM benchmark news today` — the first 3 of the 5
requested topics, verbatim. No fourth or fifth live search ran. This is the cap: **MATCH** on
prediction 1, using the actual search-execution log rather than `function_call_arguments.done`
counts (see caveat below for why the latter undercounts on this transport).

**Caveat: `function_call_arguments.done` could not be counted the way the brief assumed.** The
turn produced only ONE `*_02_responses_request_to_deployment.json` / `*_03_...` pair
(`2026-08-11T01-37-08…` / `2026-08-11T01-37-44…`), and that `_03_` capture's raw SSE contains
exactly 1 `response.function_call_arguments.done` event (the first search only). This is not
because only one search was requested of the deployment — the TUI shows four "Searched the web
for…" lines — it is because `forwardStream` in `responsesController.ts` (comment at the call site)
captures only *"the FIRST deployment call's raw bytes"*; the web-search plugin's own internal
continuation POSTs to the deployment (rounds 2, 3, and the cap-hit round) are never passed to
`payloadLogger.savePayload` at all on this streaming transport. So the `_03_` file cannot be used to
count total searches or to grep for the budget wording on this transport — confirmed by grepping
every payload file from the turn's time window for `"web-search budget"`: zero hits, in the `_02_`/
`_03_` capture or anywhere else in `logs/payloads`. This is itself a finding, separate from the
wording question: **live-search counting for streaming requests has to use the search-executor log
(the `websearch-direct` files), not the deployment-stream capture** — the capture only ever shows
round 1.

**Where the budget message actually reached — item type.** Not directly observable from a capture
(per the caveat above), so this is inferred from the TUI rendering plus a read of
`webSearchDescriptor`'s own comment (`services/gateway/src/plugins/webSearch/descriptor.ts:41-49`):
`"a call performCall's cap branch blocks ever reaches, since capReached forecloses every further
continuation for the rest of the turn."` The budget sentence appeared in the TUI as its own
assistant-role chat bubble (prefixed `•`, the same marker as every other assistant message), it is
the EXACT string `failureMessageFor('cap_reached')` produces character-for-character, and — critically
— **no further model-authored text follows it**: the turn ended immediately after (composer returned
to idle) with no per-topic summary, no acknowledgment in the model's own words, nothing. That
pattern — a verbatim engine string, standalone, terminating the turn with no subsequent model round
— is exactly what `renderResultMessage` does (synthesize a `message` item and never reopen a
continuation), and inconsistent with `renderOutput`/`function_call_output`, which would require a
further deployment round for the model to read the output and write its own reply. **Conclusion:
`renderResultMessage` fired on this transport, not `renderOutput`.** This matches the descriptor's
own comment that the cap "forecloses every further continuation," making `renderResultMessage` "the
ONLY path" reachable once the cap trips — confirmed live, not just by the unit tests that pinned it.

**What the model told the user, verbatim (from `tmux capture-pane`):**

> I'll quickly run five separate web searches (one per topic) for today's news, then give you one
> concise line each.
>
> • Searching the web
> • Searched the web for AI regulation news today
> • Searching the web
> • Searched the web for chip export news today
> • Searching the web
> • Searched the web for LLM benchmark news today
> • Searching the web
> • Searched the web for AI funding news today
>
> The web-search budget for this turn is used up. Answer using the results you already have. Do not
> tell the user the search returned nothing.

Then the turn ended — composer back to idle, no further output.

**Verdict on prediction 3 — mixed, recorded plainly rather than softened.**

- The narrow thing this task exists to check — a false claim that a search "found nothing" or
  "failed" — **did not happen**. The exact words above never assert that. **PASS on the specific
  wording bug.**
- But prediction 3 also expected "the model's reply ... says it used its available searches or
  simply answers the remaining items." Neither happened. There is no model-authored reply at all:
  no per-topic one-liners (not even for the 3 topics that DID get live results), no explicit
  statement that 3 of 5 were done, nothing addressed to the user in the user's terms. The literal
  engine string — grammatically imperative and addressed to an assistant ("Answer using the results
  you already have") — is the last thing the user sees, unparaphrased, because no continuation ever
  reopens for the model to act on that instruction. **This is a real mismatch against the
  prediction's spirit**, distinct from a "found nothing" false claim: the user asked for five
  one-line summaries and received zero, plus a sentence that reads like a leaked internal
  instruction rather than a reply.
- **Second mismatch, also worth recording plainly.** The TUI's fourth line — `Searched the web for
  AI funding news today` — is misleading on its own: no live search ran for that query (confirmed
  above; only 3 `websearch-direct` calls exist, for topics 1–3). The capped call still produced a
  `web_search_call` render item (`renderCallItem` runs regardless of `r.status`), and the codex TUI
  renders "Searched the web for `<query>`" off that item without regard to whether the call's status
  was `completed` or `failed`. A user watching this transcript is told, visually, that 4 searches
  ran when only 3 did. This is a client-side (codex TUI) rendering choice, not something
  `services/gateway/src` controls, but it compounds the first mismatch: between the misleading
  fourth "Searched the web for…" line and the terse, unparaphrased budget sentence, nothing in this
  transcript actually tells the user "I only got to 3 of your 5 topics."
- The fifth topic (`open-source model news today`) was never attempted in any form — no call item,
  no search-executor entry. The model's single batch evidently stopped at 4 calls once queued (3
  live + 1 capped), and the turn terminated before a 5th could even be requested.

**Overall: PASS against the letter of the prediction (no false "found nothing"/"failed" claim,
exactly 3 live searches, cap-reached wording did reach the user), but with two findings worth a
follow-up pass, not silently absorbed into "pass":** (1) hitting the cap mid-batch currently ends
the turn with a raw, unparaphrased internal instruction string as the sole user-facing reply rather
than routing back through the model for a natural answer, and (2) the TUI shows a capped call as
having searched, which — even though it's the client's rendering choice — means nothing in the
transcript flags that only 3 of the 4 attempted (and 5 requested) topics were actually searched.

## Removing the re-execution fallback — live verification, 2026-08-11

**What was wrong.** A replayed `web_search_call` whose cached results the gateway no longer held
had its recorded query RE-EXECUTED, consuming the per-tool search budget. Measured on a real codex
session: four replayed items, three re-run with byte-identical historical queries, one
`cap_reached`, and the model left with nothing for new work — so it repeatedly offered "I can do
another pass" and never did.

**Method.** The failing session (`019ff04d-c0d0-78f0-a4f7-436547b9d7f3`, the London-startup/Cosine
conversation) was RESUMED after merging the fix, so the same four replayed items were exercised
against new code. The gateway had restarted on merge, so its process-local result cache was cold —
every replayed item a genuine miss, which is the path under test. The user's request was the same
one that previously looped: ask for the follow-up pass the model kept offering.

**Predictions, written before the run:** every replayed item comes back `not_retained`; no
historical query is executed; the model performs a NEW search.

**Observed** — three consecutive captures, the middle one from before the merge:

| capture | replayed items | outputs sent to the deployment | model searched anew |
|---|---|---|---|
| `…3s5bvoxb9` (BEFORE) | 4 | `results:19`, `results:26` ×2, **`cap_reached`** | **False** |
| `…q5qnqq8xg` (AFTER) | 4 | **`not_retained` ×4** | **True** |

Before, three of the four replayed calls were re-executed and returned real result sets — that is
the budget being spent on history — and the fourth was refused, leaving nothing for new work. After,
all four are answered `not_retained`, nothing is executed, and the model spends its budget on two
genuinely new searches:

```
Searched the web for Cosine AI startup founders funding history London
Searched the web for Cosine London AI startup seed funding founders profile
```

**What the user sees.** The same conversation that had been returning the same three facts and the
same aggregator link now answers with founders (Alistair Pullen, Yang Li), a funding round
($2.5M seed) and two working links. Verification PASSES on all three predictions.

Note the reconstructed `function_call` items still carry their original query strings in both runs —
that is by design, so each pair stays coherent. The distinguishing signal is the OUTPUT: real
result sets mean the query was re-run; `not_retained` means it was not.
