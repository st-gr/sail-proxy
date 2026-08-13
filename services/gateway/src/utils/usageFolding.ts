import { updateTokenCounts } from './usageTracker';

/**
 * Cache-WRITE count out of a Responses `input_tokens_details` (or equivalent)
 * object, real-API-name first.
 *
 * The real OpenAI/ChatGPT Responses API names this field `cache_write_tokens`
 * — measured on real codex traffic
 * (`test/fixtures/codex-custom-tools/responses-api-compliance-capture.json`)
 * and independently on our own deployed path
 * (`gateway/logs/payloads/…_03_responses_stream_from_deployment.json`,
 * SAP's deployed gpt-5.3-codex via `/openai/v1/responses`). Our own bridge
 * emitted `cache_creation_tokens` in that position until this fix, so a
 * replayed history or an upstream that has not caught up yet may still send
 * the old name — checked second, never first, so a payload carrying BOTH
 * (should that ever happen) counts the real API's name.
 */
export function readCacheWriteTokens(details: any): number {
  if (!details) return 0;
  if (typeof details.cache_write_tokens === 'number') return details.cache_write_tokens;
  if (typeof details.cache_creation_tokens === 'number') return details.cache_creation_tokens;
  return 0;
}

/**
 * Fold already-normalized token counts into the usage metrics, subtracting
 * BOTH cache-read and cache-creation tokens from the full-rate input count
 * before recording it — admin's cost SQL
 * (`costRecalculationService.ts`'s `buildUpdateSQL`) prices all four
 * categories separately and ADDS them: `inputTokens*inputCost +
 * outputTokens*outputCost + cacheReadInputTokens*cacheReadCost +
 * cacheCreationInputTokens*cacheCreationCost`. So `inputTokens` must contain
 * NEITHER cache category, on either write turns or read turns, or those
 * tokens get billed twice.
 *
 * Used by `applyResponsesUsage` (the NATIVE Responses path), whose upstream
 * genuinely counts cached input inside `input_tokens`. It always passes 0 for
 * `cacheCreationTokens` — the native Responses path reports no separate
 * cache-write count.
 *
 * `recordOrchestrationUsage` (the orchestration bridge) used to share this,
 * back when that endpoint measured inclusive; it no longer does, and folds with
 * `foldExclusiveUsage` instead. Its doc comment carries the era split and the
 * live numbers. The lesson worth keeping here: which regime applies is a
 * property of the specific source, established by measurement at the call site
 * — never a default this function's existence implies.
 */
export function foldInclusiveUsage(
  usageMetrics: any,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): void {
  const fullRateInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
  updateTokenCounts(usageMetrics, fullRateInput, outputTokens, cacheCreationTokens, cacheReadTokens);
}

/**
 * Fold already-normalized token counts into the usage metrics for an
 * EXCLUSIVE source — one whose `prompt_tokens` (or equivalent) counts ONLY
 * full-rate tokens, with cache read/write reported as separate line items
 * that are never part of that total. A thin wrapper over the 5-arg
 * `updateTokenCounts` (`usageTracker.ts:58`): it ADDS all four categories
 * with NO arithmetic on `promptTokens` — unlike `foldInclusiveUsage`, it
 * must never subtract.
 *
 * Regime confirmed on a live capture, `/openai/v1/chat/completions`
 * (test/fixtures/orchestration/cache-probe-result.md), 2026-08-07: across
 * two identical calls `prompt_tokens` stayed flat at 14 while `cached_tokens`
 * went 0 -> 29004 / 0 -> 32004 for the same ~29-32k-token prefix. The same SAP
 * orchestration service's `/openai/v1/responses` bridge measured the opposite
 * (INCLUSIVE) that same day, which is why this comment used to call the regime
 * a property of the endpoint. It was not: that reading was an artifact of the
 * bridge duplicating its system message, and once the duplicate was removed the
 * bridge measured EXCLUSIVE too — prompt_tokens flat at 14, cache field
 * 0 -> 17692 (arm A2, test/fixtures/orchestration/bridge-cache-probe-result.md).
 * Both known SAP endpoints are exclusive today, and `recordOrchestrationUsage`
 * is this function's first and only caller. The regime is still chosen by
 * call site, from a measurement, never guessed from the shape of a usage
 * object.
 *
 * On an exclusive source, subtracting is the bug: it was written once and
 * caught in review before it merged, computing `max(0, 14 − 29004) = 0` and
 * erasing real tokens that were actually consumed. (An earlier version of this
 * comment said it "was shipped once"; a git-log review established that the
 * subtraction never ran live at this call site.) Do not "fix" this function to
 * subtract.
 */
export function foldExclusiveUsage(
  usageMetrics: any,
  promptTokens: number,
  completionTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): void {
  updateTokenCounts(usageMetrics, promptTokens, completionTokens, cacheCreationTokens, cacheReadTokens);
}

/**
 * Accumulate ONE continuation round's usage onto `req.__responsesExtraUsage`
 * — the per-request accumulator the hosted-tool engine's continuation loop
 * feeds (native Responses path and orchestration bridge alike) and
 * `responsesController` later folds into the request's billing metrics via
 * plain `updateTokenCounts`.
 *
 * Every usage object that reaches this function is OpenAI-INCLUSIVE: native
 * deployment frames are inclusive by OpenAI's own `usage` semantics, and
 * bridge continuation frames are always the OUTPUT of `translateUsage`
 * (`responses/orchestrationBridge/responseTranslator.ts`), which normalizes
 * SAP's exclusive counting into the same inclusive shape
 * (`input_tokens = prompt + cached + creation`) before the engine ever sees
 * it. So one normalization here is correct for both callers — there is no
 * "which regime" branch the way there is in `foldInclusiveUsage` /
 * `foldExclusiveUsage` above.
 *
 * The subtraction is PER ROUND, not on the running sum: `input_tokens`
 * accumulates each round's full-rate remainder
 * `max(0, raw - cached - creation)`, while `cache_creation_tokens` and
 * `cache_read_tokens` accumulate the raw per-round cache counts. Clamping
 * the sum instead would be wrong whenever one round's cache count exceeds
 * that SAME round's raw input (the steady state once a prefix is fully
 * cached) but a LATER round writes a large fresh block — see the two-round
 * test in usage-folding.test.ts for a worked example of the two arithmetics
 * disagreeing.
 *
 * The cache-WRITE figure is read via `readCacheWriteTokens` above — real
 * `cache_write_tokens` first, legacy `cache_creation_tokens` fallback — but
 * the ACCUMULATOR FIELD this function writes stays named `cache_creation_tokens`
 * on purpose. That key is `responsesWebSearchPlugin.md`'s documented plugin
 * contract (`acc.cache_creation_tokens += n`), and traced end to end it is
 * purely internal: every reader (`responsesController.ts`) feeds it straight
 * into `updateTokenCounts`/`usageMetrics`, which only ever reaches
 * `emitUsageEvent`'s internal usage-events channel, never a client-visible
 * JSON body. Renaming it would break the plugin contract for zero externally
 * visible benefit, so this is the one field in the whole fix that keeps its
 * old name.
 *
 * `req.__responsesExtraUsage` is allocated by `responsesController` before
 * the after-plugin chain / continuation loop can run, seeded
 * `{ input_tokens: 0, output_tokens: 0 }` so a plugin's own `acc.input_tokens
 * += n` never throws on a missing property. This function does not require
 * the two new fields to already be present on that object — it adds them
 * with `?? 0` on first use — so a caller that still allocates the 2-field
 * literal keeps working, and a plugin that replaces the accumulator with its
 * own 2-field object degrades to today's (pre-split) behaviour instead of
 * throwing.
 */
export function noteExtraUsage(req: any, usage: any): void {
  if (!usage) return;
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  const creationTokens = readCacheWriteTokens(usage.input_tokens_details);
  const fullRateInput = Math.max(0, (usage.input_tokens || 0) - cachedTokens - creationTokens);

  const acc = (req as any).__responsesExtraUsage
    || { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
  acc.input_tokens = (acc.input_tokens || 0) + fullRateInput;
  acc.output_tokens = (acc.output_tokens || 0) + (usage.output_tokens || 0);
  acc.cache_creation_tokens = (acc.cache_creation_tokens || 0) + creationTokens;
  acc.cache_read_tokens = (acc.cache_read_tokens || 0) + cachedTokens;
  (req as any).__responsesExtraUsage = acc;
}
