# 02 — `openaiController` never maps `cached_tokens`, so cached input bills at the full rate

**Status:** open · **Type:** pre-existing billing inaccuracy, surfaced during phase 1 · **Impact:** medium, costs money

## What is wrong

`modelCostService.calculateCosts` prices four buckets additively — `inputCost + outputCost + cacheCreationInputCost + cacheReadInputCost` — so a request whose input was largely served from cache should be charged mostly at the (much cheaper) cache-read rate. Two of the three controllers feed it the right shape. `openaiController` does not: it reports `prompt_tokens` in full and never reads `prompt_tokens_details.cached_tokens`, so every cached input token on the chat-completions path is billed as fresh input.

## Evidence

Established during the phase-1 whole-branch review, which compared all three controllers:

- **`anthropicController`** passes `input_tokens` straight through, and that is correct *because the Anthropic API already excludes cache-read from it* — the cached count arrives in its own field and is mapped separately.
- **`responsesController`** subtracts cached tokens from `input_tokens` before reporting, because the Responses API counts cached input *inside* `input_tokens`. After that subtraction it feeds `modelCostService` exactly the shape Anthropic does. (This is `applyResponsesUsage`; it was reviewed and upheld as correct.)
- **`openaiController`** does neither. A grep over the file returns no `prompt_tokens_details` and no `cached_tokens` anywhere, across all five `updateTokenCounts` call sites (~`:263`, `:604`, `:626`, `:745`, `:773`).

The phase-1 reviewer's verdict was that chat-completions is "the less accurate outlier, not a convention this route should have copied" — the Responses route was deliberately built the accurate way, leaving this one behind.

Note the OpenAI Chat Completions API reports cached input as `usage.prompt_tokens_details.cached_tokens`, and — like Responses — counts it *inside* `prompt_tokens`. So the fix mirrors `applyResponsesUsage`, not the Anthropic passthrough.

## Fix

1. Read `usage.prompt_tokens_details?.cached_tokens` where each `updateTokenCounts` call is built.
2. Subtract it from `prompt_tokens` and pass it as the cache-read argument, exactly as `applyResponsesUsage` does in `responsesController.ts` — reuse that helper's shape rather than writing a second convention. Extracting it into a shared util is reasonable if it fits cleanly; do not duplicate the arithmetic five times.
3. Guard the subtraction with `Math.max(0, …)`, as the Responses helper does, so a malformed upstream payload cannot produce a negative count.
4. Check each of the five call sites individually — they cover streaming, non-streaming, the deployed branch and the emulated-streaming branch, and not all of them receive the same usage object shape.

## Verification

- Unit: a usage payload with `prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 }` yields `inputTokens: 100` and `cacheReadInputTokens: 900`, and the total is unchanged.
- Regression: a payload with no `prompt_tokens_details` behaves exactly as today.
- Live: a repeated large-prompt request against a caching-enabled deployment, confirming the usage event shows a non-zero cache-read bucket on the second call and that `totalTokens` still matches the upstream total.
- Confirm no double counting: `usageEventProcessor` sums all four buckets for `totalTokens`, so subtracting from input is required, not optional.

## Files

- `services/gateway/src/controllers/openaiController.ts` (five `updateTokenCounts` call sites)
- `services/gateway/src/controllers/responsesController.ts` (`applyResponsesUsage` — the reference shape, and the extraction source if shared)
- `services/gateway/src/utils/usageTracker.ts` (`updateTokenCounts` signature)
