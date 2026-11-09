/**
 * Sampling parameters SAP's LLM module refuses per model family — measured live
 * through the orchestration bridge (2026-09-07/08, `/v2/completion`), each error
 * quoted verbatim:
 *
 *   anthropic--* (4.5-haiku and 4.6-sonnet probed, both with (1, 0.95) and (0, 1)):
 *     `temperature` and `top_p` cannot both be specified for this model. Please use only one.
 *   gpt-5-mini (the gpt-5..9 / o-series families, see MAX_COMPLETION_TOKENS_MODELS):
 *     openai does not support parameters: ['top_p'], for model=gpt-5-mini        — top_p alone, or with any temperature
 *     gpt-5 models (including gpt-5-codex) don't support temperature=0.7          — 0 and 0.7 refused, 1 accepted
 *
 * Gemini CLI sends temperature AND topP on every request (0 and 1 by default), and
 * an orchestration 400 comes back INSIDE the SSE stream, which the CLI reports as
 * "Model stream ended without a finish reason". The refused parameter is dropped
 * here, keeping the one the client actually set: temperature is what Gemini
 * clients tune (topP stays at its neutral 1), so it wins over top_p for Claude.
 * Mistral, Gemini and gpt-4.x models accept both — probed the same way.
 */
import { MAX_COMPLETION_TOKENS_MODELS } from './unsupportedParamFilter';

/** Drop the sampling keys `modelName` refuses from `params`; returns the names dropped. */
export function dropUnsupportedSampling(modelName: string, params: Record<string, any>): string[] {
  const base = (modelName || '').replace(/--deployed$/i, '');
  const dropped: string[] = [];
  if (/^anthropic--/i.test(base)) {
    if (params.temperature !== undefined && params.top_p !== undefined) {
      delete params.top_p;
      dropped.push('top_p');
    }
  } else if (MAX_COMPLETION_TOKENS_MODELS.test(base)) {
    if (params.top_p !== undefined) {
      delete params.top_p;
      dropped.push('top_p');
    }
    if (params.temperature !== undefined && params.temperature !== 1) {
      delete params.temperature;
      dropped.push('temperature');
    }
  }
  return dropped;
}
