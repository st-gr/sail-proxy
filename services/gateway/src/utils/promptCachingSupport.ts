/**
 * Whether a model should receive `cache_control` breakpoints (Anthropic
 * prompt caching).
 *
 * Resolution order: per-model `supports_prompt_caching` → provider flag →
 * default `provider === 'anthropic'`. Unlike responsesEligibility's family
 * heuristic, the Anthropic-default tier has NO version/family check inside
 * this function. The one live measurement taken (gpt-5-mini via SAP
 * orchestration) sent `cache_control` and got back HTTP 200 with
 * `cached_tokens: 0` — SAP silently ignored the block rather than rejecting
 * the request. A wrong `true` was a no-op there, while a wrong `false`
 * costs money every turn, so the code favors staying provider-only and
 * pushing exceptions (e.g. an older Claude model that turns out not to
 * support caching) into config as a `false` override, not a pattern match
 * in code.
 *
 * The default is deliberately asymmetric with the risk, not the base rate:
 * a live probe sending `cache_control` to a model that ignores it (SAP,
 * gpt-5-mini) got back HTTP 200 with `cached_tokens: 0` — the request just
 * did a bit of pointless work. A model that DOES support caching but never
 * receives a breakpoint pays the full uncached input-token price on every
 * turn. So a wrong `true` is free; a wrong `false` costs money continuously.
 * Defaulting to `provider === 'anthropic'` is safe under that asymmetry even
 * though not every Anthropic model necessarily supports caching, because the
 * failure mode for the ones that don't is the same free no-op, not a 400.
 */
export interface PromptCachingSupportInput {
  provider?: string;
  /** api_config.model_list_changes.<model>.supports_prompt_caching */
  modelFlag?: boolean;
  /** api_config.<provider>.supports_prompt_caching */
  providerFlag?: boolean;
}

export function resolvePromptCachingSupport(opts: PromptCachingSupportInput): boolean {
  if (typeof opts.modelFlag === 'boolean') return opts.modelFlag;
  if (typeof opts.providerFlag === 'boolean') return opts.providerFlag;
  return opts.provider === 'anthropic';
}
