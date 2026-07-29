/**
 * Pure helpers for dropping request parameters a provider/model does not accept
 * before forwarding to SAP AI Core.
 *
 * SAP AI Core's LLM module hard-rejects unknown parameters for some providers,
 * e.g. Perplexity: `400 - LLM Module: perplexity does not support parameters:
 * ['tools'], for model=sonar`. Clients such as OpenWebUI send `tools` /
 * `response_format` unconditionally, so the gateway strips them per config
 * instead of letting the whole request fail.
 *
 * Resolution semantics:
 * - A per-model list REPLACES the provider list (explicit override).
 * - Absent at both levels means nothing is stripped (prior behavior), so
 *   deployments whose api_config.json predates this key are unaffected.
 *
 * @see api_config.json - <provider>.unsupported_params / model_list_changes.<model>.unsupported_params
 */

/**
 * Resolve the effective unsupported-parameter list for a request.
 * The per-model override, when defined, wins over the provider default.
 */
export function resolveUnsupportedParams(
  providerList?: string[] | null,
  modelOverride?: string[] | null
): string[] {
  if (Array.isArray(modelOverride)) {
    return modelOverride.filter(p => typeof p === 'string' && p.length > 0);
  }
  if (Array.isArray(providerList)) {
    return providerList.filter(p => typeof p === 'string' && p.length > 0);
  }
  return [];
}

/**
 * Whether a given parameter must be dropped for this request.
 */
export function isUnsupportedParam(param: string, unsupported: string[]): boolean {
  return unsupported.includes(param);
}

/**
 * Providers whose SAP AI Core deployments speak the OpenAI-compatible
 * `/chat/completions` contract, so the path must be appended to the bare
 * deployment URL. Anthropic deployments use a Bedrock-style contract and are
 * deliberately excluded — they are served by the /anthropic route instead.
 */
export const OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS = ['openai', 'perplexity'];

/**
 * Models on the OpenAI Chat Completions contract that reject `max_tokens` and
 * require `max_completion_tokens`: the GPT-5..9 families (gpt-5, gpt-5.4,
 * gpt-6-turbo, …) and the o-series reasoning models (o1, o3, o4-mini, …).
 * GPT-4 and earlier still take `max_tokens`.
 *
 * The major version must be followed by `.`, `-` or end-of-name. Matching bare
 * digits would misfire on Azure's legacy `gpt-35-turbo` (i.e. GPT-3.5), which
 * still uses `max_tokens`. A future double-digit family (gpt-10+) therefore
 * needs a config `param_renames` entry until this pattern is extended.
 */
export const MAX_COMPLETION_TOKENS_MODELS = /^(?:gpt-[5-9](?:[.\-]|$)|o[1-9])/i;

/**
 * Built-in parameter renames for a deployed model, derived from the model name
 * so newly deployed models work without a config entry. Config `param_renames`
 * overrides these per key (map a key to itself to disable a default).
 *
 * Only OpenAI-contract deployments are affected; SAP's orchestration endpoint
 * normalizes parameters itself, so this is deployment-path only.
 */
export function defaultParamRenames(provider?: string, modelName?: string): Record<string, string> {
  if (provider !== 'openai' || !modelName) {
    return {};
  }
  const baseModel = modelName.replace(/--deployed$/, '');
  return MAX_COMPLETION_TOKENS_MODELS.test(baseModel)
    ? { max_tokens: 'max_completion_tokens' }
    : {};
}

/**
 * Rename parameters a deployment expects under a different name (mutates in
 * place). Newer OpenAI reasoning models (gpt-5.x, o-series) reject `max_tokens`
 * and require `max_completion_tokens`; SAP's orchestration endpoint normalizes
 * this, but the direct-deployment path forwards the raw client body, so the
 * rename has to happen here.
 *
 * An existing destination key is left untouched (the caller's explicit value
 * wins) and the source key is still removed, so both names are never sent.
 * Returns "from->to" pairs actually applied, for logging.
 */
export function applyParamRenames(
  target: Record<string, any> | null | undefined,
  renames: Record<string, string> | null | undefined
): string[] {
  if (!target || typeof target !== 'object' || !renames || typeof renames !== 'object') {
    return [];
  }
  const applied: string[] = [];
  for (const [from, to] of Object.entries(renames)) {
    if (typeof to !== 'string' || !to || from === to) continue;
    if (!Object.prototype.hasOwnProperty.call(target, from)) continue;

    if (!Object.prototype.hasOwnProperty.call(target, to)) {
      target[to] = target[from];
    }
    delete target[from];
    applied.push(`${from}->${to}`);
  }
  return applied;
}

/**
 * Delete every unsupported parameter present on `target` (mutates in place).
 * Returns the names actually dropped, so callers can log precisely what was
 * removed. Exact, case-sensitive key match; a no-op when the list is empty.
 */
export function stripUnsupportedParams(
  target: Record<string, any> | null | undefined,
  unsupported: string[]
): string[] {
  if (!target || typeof target !== 'object' || unsupported.length === 0) {
    return [];
  }
  const dropped: string[] = [];
  for (const param of unsupported) {
    if (Object.prototype.hasOwnProperty.call(target, param)) {
      delete target[param];
      dropped.push(param);
    }
  }
  return dropped;
}
