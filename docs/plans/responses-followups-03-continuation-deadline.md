# 03 — The continuation loop's deadline is checked only at the top of each round

**Status:** open · **Type:** bounded residual of phase 3 · **Impact:** low, worst-case latency only

## What is wrong

Phase 3 gave `runContinuationLoop` a wall-clock deadline so it could not outlive the controller's idle budget. It works, and it shrank the worst case substantially — but the two clocks still do not coincide, and the code comment claiming they now "agree instead of race" overstates what was achieved. They agree on *value*, not on *moment*.

## Evidence

From the phase-3 whole-branch re-review, which reproduced the timing rather than reasoning about it:

- The deadline is computed once, before the `for(;;)`, and checked only at the **top of each round** (`responsesWebSearchPlugin.ts`, ~`:1020-1029`).
- `upstream.timeoutMs` simultaneously serves as the loop budget, the per-round stream watchdog (~`:966-972`) and the axios POST timeout. So a round that starts one millisecond before the deadline still runs a full watchdog plus its serial Perplexity calls before the next check.
- The loop's deadline is anchored at *loop start*, which is after the first round's search — so it always trails the controller's `awaitResponsesStreamIdle` budget, which started earlier.

Net effect: the stalled-socket window went from roughly 21 minutes to roughly 11–12 minutes at the default cap of 3. It is bounded and much better than before, but it is not the idle budget.

Separately, when the controller's idle budget expires mid-loop it emits the usage event with only round 1's tokens and calls `res.end()` — which hits the patched `end`, sets `endPending` and returns without closing, because `isBusy()` is true. So later rounds' tokens land in an accumulator nobody reads.

Two facts that bound the severity, both verified: the deadline **cannot** truncate a healthy turn (it is computed before the loop, so round 1 never sees it, and it is strictly more generous than the controller wait it mirrors — any turn it stops is one the controller was already abandoning), and usage still emits exactly once on every close path.

## Fix

Options, cheapest first:

1. **Correct the wording only.** Soften the comment at `responsesWebSearchPlugin.ts:~1002-1012` and the matching line in `responsesWebSearchPlugin.md` to say the two clocks share a *value*, not a moment, and state the real ceiling. This is honest and costs nothing — reasonable if the latency is acceptable.
2. **Check the deadline inside the round**, not just at its top: pass it to the per-round stream watchdog so a stalled continuation stream is abandoned at the deadline rather than at its own timeout.
3. **Anchor the loop deadline to the controller's**, by stashing the controller's start time on the request alongside `__responsesUpstream` and deriving the loop deadline from that, so the two genuinely coincide.

If you take 2 or 3, keep the property that a healthy turn is never truncated — the existing test at `responses-websearch-stream.test.ts:~764` pins deadline expiry, and a companion test should pin that a normal multi-round turn completes untouched.

## Verification

- The existing deadline test still passes, and a mutation (`if (false)` on the check) still fails it.
- New: a healthy 2-round continuation completes with no truncation.
- New: a round that stalls past the deadline is abandoned within the intended window rather than at the per-stream watchdog.

## Files

- `services/gateway/src/plugins/responsesWebSearchPlugin.ts` (`runContinuationLoop`, the per-round watchdog)
- `services/gateway/src/utils/responsesStreamIdle.ts` (the comment describing the ceiling)
- `services/gateway/src/plugins/responsesWebSearchPlugin.md`
