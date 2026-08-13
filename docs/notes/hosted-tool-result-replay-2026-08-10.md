# Hosted-tool result replay — why a second web search never worked, and what fixed it

**Date:** 2026-08-10. **Branch:** `claude`. **Scope:** `services/gateway` hosted-tool engine.

## The symptom

In the codex TUI, the first web search of a conversation worked. Every later turn refused: the
model answered "I'm unable to fetch a fresh second web pass right this moment in this turn" and
offered to search if asked again — then did the same thing when asked again.

This was not a one-off. Across 78 organic requests captured on this gateway, three carried a
completed search in their replayed history, and **none of those three ever searched again**. Every
search that has ever run through this gateway was the first in its conversation.

## Root cause

SAP deployments reject hosted tool types, so the engine rewrites the client's hosted `web_search`
tool into a plain `function` tool, and converts the model's function call back into a client-visible
`web_search_call` item — which is what makes codex render "Searched the web".

Codex replays that item verbatim on every later turn (it sends full history: `store: false`, no
`previous_response_id`). Nothing in the gateway read it back in. So on turn 2 the model received a
history containing a *completed call to a hosted tool it was never given*, with **no output
attached**, while its actual tool list held a `function` named `web_search` it had apparently never
used. It responded by promising to search rather than searching.

## Why the obvious fix was impossible

The tempting design — emit the results inside the client-visible item so codex replays them — cannot
work. Codex's `ResponseItem` is a serde internally-tagged enum whose `web_search_call` variant
carries exactly `id`, `status` and `action` (verified by extracting type strings from the codex
binary at `~/.codex/packages/standalone/current/bin/codex`). An added `results` field is an unknown
field: dropped on the deserialize/re-serialize round trip at best, and the binary contains 44
distinct `unknown field \`` strings — serde's `deny_unknown_fields` error — so a hard client-side
failure was not excluded either.

Recovering the results from the assistant message the engine also emits does not work: codex does
not replay it. Turn 2's captured input held the call item and the model's final answer only, with
no `url_citation` annotation surviving anywhere.

What *does* survive the round trip is the item's `id` and `action.query`. Hence: the id is the cache
key, and the query is what makes a cache miss recoverable.

## What the experiments established

Five arms, measured live on 2026-08-08 (`test/fixtures/websearch-replay/websearch-replay-result.md`):

| Arm | Replayed history contained | Searched |
|---|---|---|
| A | the `web_search_call` item, untranslated (shipped behaviour) | 0 / 2 |
| B | nothing — the item deleted | 0 / 2 |
| C | a `function_call`/`function_call_output` pair, output saying a new search was required | 2 / 2 |
| D | the same pair, output `{"results": [], "state": "not_retained_in_conversation_history"}` | 1 / 2 |
| F | the same pair, output carrying the REAL results | 5 / 6 |

Arm B is the important negative: deleting the stray item changed nothing, so the item's *presence*
was never the cause — the *absence of the model's own tool use in the shape its tool list uses* was.
Arm D is why placeholders are banned: a model reads `{"results": []}` as "the search ran and found
nothing" and asks to retry.

## The fix

1. Hosted-tool results are cached in a **process-local**, TTL'd, bounded store keyed by the rendered
   item's id, written at render time (`plugins/hostedTool/resultCache.ts`).
2. Before the engine's pending-call drain, every replayed `<type>_call` item in `body.input` is
   rewritten into a `function_call`; on a cache hit its matching `function_call_output` is appended
   from the cache. No hosted-shaped item ever reaches the deployment.
3. **On a miss the reconstructed call is deliberately left unsatisfied**, so the existing drain
   re-executes the recorded query live. A miss costs one search and returns real results; it never
   degrades to a placeholder.

**Cache unmasked, present masked.** The cache stores only what the tool retrieved. Masking is a
presentation step re-applied per request through that request's own `ReplacementMap`, via the
`cachePayloadFrom` / `rehydratePayload` descriptor pair. Storing a masked rendering would be wrong,
not merely redundant: under the `anonymization` method placeholders are per-request counters, so one
request's `MASKED_PERSON_3` denotes something else in another's.

Supporting change: `syntheticId` gained six unbiased base36 random characters, because these ids
became cache keys and its timestamp-plus-counter scheme let two processes mint identical ids from a
cold start.

## Verified live

Two-turn codex conversation, 2026-08-10, nine of nine predictions matched
(`test/fixtures/websearch-replay/replay-fix-verification.md`). Turn 2's outbound payload contained
no `web_search_call`, a `function_call`/`function_call_output` pair sharing `call_id
ws_msnnwbe43ianhm8`, and 27 real results from turn 1's search — and the model then ran **two new
searches** and produced the verified top-5 brief the original conversation had only promised.

## The drain, and what the whole-branch review caught

`MAX_PENDING_CALLS_PER_TURN = 4` was written to bound how many tool calls codex issues *in parallel
within one turn*. Feeding replayed calls into the same drain silently changed its input to *the
whole conversation's* calls — a seam no per-task review could see, and the source of two defects the
final review found and reproduced:

- **Orphaned calls.** More than four replayed misses in one turn produced five `function_call` items
  and four outputs, forwarding an unpaired call to the deployment. The engine's own comment says
  such a turn is malformed and gets rejected outright — so a conversation that previously only
  degraded could now hard-fail.
- **The per-tool cap was not enforced** on this path: four replayed misses ran four live searches
  against `web_search`'s cap of three.

Both fixed in `666470c`. Every replayed call that survives the rewrite now always receives a
matching output: up to `descriptor.maxCallsPerRequest()` run live, and everything past the cap or
past the per-turn budget is resolved through the drain's existing failed-result path. The sweep
terminates by construction — each pass resolves exactly one still-pending call, so the unresolved
set strictly shrinks. `MAX_PENDING_CALLS_PER_TURN` itself is unchanged; what changed is that
exceeding it degrades cleanly instead of emitting a malformed turn.

## Open items

- **`web_search`'s failed `renderOutput` emits `{"results": []}`**, which this branch's own evidence
  says a model reads as "the search ran and found nothing" (arm D above). `file_search` instead
  emits an explicit "could not be completed — tell the user you were unable to search their
  documents". The asymmetry is pre-existing — `performCall` has taken this path on cap exhaustion
  since before this branch — but the drain fix makes it fire more often. **Fast-follow: give
  `webSearchDescriptor.renderOutput` explicit failure wording for `status: 'failed'`, mirroring
  `fileSearch/descriptor.ts:553-561`, and apply it at both call sites (`performCall` and the
  drain).** Deliberately out of scope for the narrow drain fix.
- **Only the cache-hit path was verified live.** The miss path — which becomes the normal case on a
  horizontally-scaled or rolling deployment, since the cache is process-local — has unit coverage
  only. A live miss-path run is worth doing before wider rollout.
- `descriptorForReplayedCallItem` matches by stripping a literal `_call` suffix, so `function_call`
  maps to type `function`; it avoids collision only because nothing is registered under that type.
- `rehydratePayload` fails open (emits raw text) when a request carries no replacement map. Not a
  regression — identical to what a first-time call on that request already does.
- The gateway still never emits `web_search_call.results` under `include`; only `file_search`
  implements that, and codex neither asks for it nor would preserve it.
