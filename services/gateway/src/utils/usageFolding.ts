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
 * It is also the inclusive half of `foldOrchestrationUsageFor` below: SAP
 * orchestration usage from an OpenAI-family or Gemini model (and any unlisted
 * family) counts the cache inside `prompt_tokens`. `recordOrchestrationUsage`'s doc comment carries
 * the Claude-side era split and the live numbers. The lesson worth keeping here:
 * which regime applies is a property of the specific source, established by
 * measurement — never a default this function's existence implies.
 *
 * `imageInputTokens` passes straight through to `updateTokenCounts` with no
 * arithmetic of its own: SAP's Responses `usage.input_tokens_details.image_tokens`
 * (the only caller that supplies it, `applyResponsesUsage`) is its own separate
 * figure, never folded into `input_tokens` the way cache tokens are.
 */
export function foldInclusiveUsage(
  usageMetrics: any,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  imageInputTokens?: number,
): void {
  const fullRateInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
  updateTokenCounts(usageMetrics, fullRateInput, outputTokens, cacheCreationTokens, cacheReadTokens, imageInputTokens);
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
 * Both of those captures were on anthropic--claude-4.8-opus, and that is what they
 * prove: the regime is a property of the MODEL FAMILY behind orchestration, not of
 * the endpoint. A later probe (2026-09-30, gpt-4.1-nano, both
 * `/openai/v1/chat/completions` and `/anthropic/v1/messages`) measured SAP's
 * `prompt_tokens` INCLUSIVE for an OpenAI-family model — see `cacheRegimeFor`
 * below. So no orchestration call site picks this function directly any more; they
 * all go through `foldOrchestrationUsageFor`, which picks it for Claude and Amazon
 * Nova (and for any usage whose prompt is smaller than its cache).
 * The regime is still chosen from a measurement, never guessed from the shape of a
 * usage object.
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

export type CacheRegime = 'exclusive' | 'inclusive';

/**
 * Whether SAP orchestration's `prompt_tokens` for this model EXCLUDES or INCLUDES the
 * `prompt_tokens_details` cache counts (`cached_tokens`, `cache_creation_tokens`).
 * Orchestration passes each model family's own usage convention through, so the
 * answer depends on the model behind it, not on the gateway endpoint:
 *
 * - Claude: EXCLUSIVE, measured (2026-08-07, anthropic--claude-4.8-opus:
 *   prompt_tokens flat at 14 while cached_tokens went 0 -> 29004; see
 *   `foldExclusiveUsage` above; re-measured 2026-09-30 on anthropic--claude-4.5-haiku:
 *   prompt_tokens 13 with cache_creation_tokens 11266, then 13 with cached_tokens
 *   11266). Anthropic's own `input_tokens` is exclusive too.
 * - Amazon Nova: EXCLUSIVE, measured (2026-09-30, amazon--nova-lite with a
 *   `cache_control` checkpoint: prompt_tokens 7 with cache_creation_tokens 9811,
 *   total_tokens 9822; then prompt_tokens 7 with cached_tokens 9811). Nova caches
 *   only at an explicit checkpoint; SAP passes Bedrock's exclusive usage through.
 * - OpenAI family (gpt-*, o-series): INCLUSIVE, measured (2026-09-30,
 *   gpt-4.1-nano: prompt_tokens 1978 on the cold and the cached call while
 *   cached_tokens went 0 -> 1792; total_tokens 1979 = prompt + 1 completion;
 *   gpt-5-nano: prompt_tokens 1982 flat while cached_tokens went 0 -> 1920).
 *   OpenAI documents `cached_tokens` as a subset of `prompt_tokens`.
 * - Gemini: INCLUSIVE, measured (2026-09-30, gemini-2.5-flash-lite: prompt_tokens
 *   2062 flat while cached_tokens went 0 -> 2034), as Google documents.
 * - Mistral (mistral-small, 2026-09-30): reports no cache details at all, so either
 *   answer bills the same.
 * - Every other family (Llama, …): INCLUSIVE ASSUMED, not measured. A family found
 *   to be exclusive needs a live capture and a line here; `cacheRegimeForUsage`
 *   below catches most such cases in the meantime.
 *
 * Keyed on "claude" or "nova" anywhere in the lower-cased name, so every form a
 * model reaches a call site in is covered: SAP's `anthropic--claude-*` and
 * `amazon--nova-*` names (with or without the `--deployed` suffix), Anthropic's own
 * `claude-*` ids, OpenRouter's `anthropic/claude-*`, Bedrock's `amazon.nova-*` ids.
 * A missing name falls to the inclusive default.
 *
 * This is the name-only answer. Folding and converting go through
 * `cacheRegimeForUsage`, which adds an arithmetic check on the numbers.
 */
export function cacheRegimeFor(modelName: string | null | undefined): CacheRegime {
  if (typeof modelName !== 'string') return 'inclusive';
  const name = modelName.toLowerCase();
  return name.includes('claude') || name.includes('nova') ? 'exclusive' : 'inclusive';
}

/**
 * The regime for one concrete usage: `cacheRegimeFor(modelName)`, overridden to
 * EXCLUSIVE when `promptTokens < cacheReadTokens + cacheCreationTokens`. An inclusive
 * `prompt_tokens` contains both cache counts by definition, so it can never be smaller
 * than their sum; a usage that is must come from an exclusive source, whatever the
 * name says. Folding it inclusive would clamp the full-rate input to 0 and drop the
 * uncached tail (what happened to Nova before it was listed above).
 *
 * What the net catches: an unlisted exclusive family on any turn whose cache is larger
 * than its uncached part, which is the usual cached turn (a big cached prefix, a short
 * new tail). What it cannot catch: an exclusive source whose uncached part is at least
 * as large as its cache — those numbers are valid under both readings, so only the
 * per-family entry in `cacheRegimeFor` can decide them.
 *
 * The one place `foldOrchestrationUsageFor`, `fullRatePromptTokens` and
 * `wholePromptTokens` take their regime from.
 */
export function cacheRegimeForUsage(
  modelName: string | null | undefined,
  promptTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): CacheRegime {
  if (promptTokens < cacheReadTokens + cacheCreationTokens) return 'exclusive';
  return cacheRegimeFor(modelName);
}

/**
 * Fold one SAP orchestration usage (already read into numbers) for `modelName`,
 * picking `foldExclusiveUsage` or `foldInclusiveUsage` by `cacheRegimeForUsage`. The
 * one entry point every orchestration fold site uses, so no call site chooses a
 * regime on its own.
 */
export function foldOrchestrationUsageFor(
  modelName: string | null | undefined,
  usageMetrics: any,
  promptTokens: number,
  completionTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): void {
  if (cacheRegimeForUsage(modelName, promptTokens, cacheCreationTokens, cacheReadTokens) === 'exclusive') {
    foldExclusiveUsage(usageMetrics, promptTokens, completionTokens, cacheCreationTokens, cacheReadTokens);
  } else {
    foldInclusiveUsage(usageMetrics, promptTokens, completionTokens, cacheCreationTokens, cacheReadTokens);
  }
}

/**
 * SAP `prompt_tokens` → the full-rate share only (Anthropic's `input_tokens`
 * convention, where cache read/write are reported beside it). Unchanged for an
 * exclusive source; `max(0, prompt − read − write)` for an inclusive one — the same
 * arithmetic `foldInclusiveUsage` bills.
 */
export function fullRatePromptTokens(
  modelName: string | null | undefined,
  promptTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  return cacheRegimeForUsage(modelName, promptTokens, cacheCreationTokens, cacheReadTokens) === 'exclusive'
    ? promptTokens
    : Math.max(0, promptTokens - cacheReadTokens - cacheCreationTokens);
}

/**
 * SAP `prompt_tokens` → the whole prompt, cache included (the OpenAI Responses
 * `input_tokens` and Gemini `promptTokenCount` convention). Unchanged for an
 * inclusive source; prompt + read + write for an exclusive one.
 */
export function wholePromptTokens(
  modelName: string | null | undefined,
  promptTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  return cacheRegimeForUsage(modelName, promptTokens, cacheCreationTokens, cacheReadTokens) === 'exclusive'
    ? promptTokens + cacheReadTokens + cacheCreationTokens
    : promptTokens;
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
 * SAP's per-model counting into the same inclusive shape (`wholePromptTokens`:
 * `prompt + cached + creation` for an exclusive source such as Claude or Nova,
 * `prompt` as-is otherwise) before the
 * engine ever sees it. So one normalization here is correct for both callers — there is no
 * "which regime" branch the way there is in `foldOrchestrationUsageFor` above.
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
