/**
 * Which models may be served on /openai/v1/responses.
 *
 * The SAP deployments for GPT-5+/o-series expose the Responses API natively.
 * Perplexity and Anthropic deployments do not, so they are excluded.
 *
 * Resolution order: per-model `supports_responses_api` → provider flag →
 * built-in family heuristic. This mirrors the pattern-default + config-override
 * shape used by defaultParamRenames, so a newly deployed GPT-5+ model works
 * with no config while exceptions stay fixable without a code change.
 */
import { MAX_COMPLETION_TOKENS_MODELS } from './unsupportedParamFilter';

/** GPT-5+/o-series family check. Tolerates the `--deployed` alias suffix. */
export function isResponsesFamily(modelName: string): boolean {
  if (!modelName) return false;
  return MAX_COMPLETION_TOKENS_MODELS.test(modelName.replace(/--deployed$/, ''));
}

/**
 * The `--deployed` twin of a foundation-model name, or null if there cannot be
 * one. The gateway lists every deployment twice — the foundation entry `X`
 * (orchestration, no deploymentUrl) and `X--deployed`, built in modelService as
 * `${model.name}--deployed` — so the two always share a base name.
 */
export function deployedSiblingName(modelName: string): string | null {
  if (!modelName || modelName.endsWith('--deployed')) return null;
  return `${modelName}--deployed`;
}

export interface ResponsesEligibilityInput {
  modelName: string;
  provider?: string;
  isDeployed: boolean;
  /** api_config model_list_changes.<model>.supports_responses_api */
  modelFlag?: boolean;
  /** api_config.<provider>.supports_responses_api */
  providerFlag?: boolean;
}

export function resolveResponsesEligibility(opts: ResponsesEligibilityInput): boolean {
  if (typeof opts.modelFlag === 'boolean') return opts.modelFlag;
  if (typeof opts.providerFlag === 'boolean') return opts.providerFlag;
  return opts.isDeployed
    && opts.provider === 'openai'
    && isResponsesFamily(opts.modelName);
}

export interface ResponsesRouteInput extends ResponsesEligibilityInput {
  /** The model resolved against the catalogue. False means it does not exist at all. */
  existsInCatalogue: boolean;
}

/**
 * Which path serves this model on /openai/v1/responses.
 *
 * `native` reproduces the pre-bridge behaviour exactly and must not change:
 * a deployment that serves the Responses API itself is forwarded to unchanged.
 * `orchestration` is the new branch — a catalogue model with NO deployment
 * that cannot serve natively now goes through the bridge instead of receiving
 * a 400. A catalogue model that DOES have a deployment but still fails the
 * eligibility check (e.g. a Perplexity deployment: real URL, wrong API) stays
 * `refuse`, exactly as before — orchestration is a fallback for the
 * undeployed case, not a second attempt at a deployment that already exists
 * and simply does not speak the Responses API.
 *
 * A config flag still decides outright in both directions: `false` refuses even
 * a catalogue model. `true` forces the `native` verdict unconditionally — not
 * "native if deployed, else orchestration" — because that flag means "serve
 * this model's OWN deployment on this route," and if that deployment does not
 * exist the caller must see the existing "no deployment URL" 400, not have the
 * request silently redirected to a different serving path it never asked for.
 */
export function resolveResponsesRoute(opts: ResponsesRouteInput): 'native' | 'orchestration' | 'refuse' {
  if (!opts.existsInCatalogue) return 'refuse';

  const flag = typeof opts.modelFlag === 'boolean' ? opts.modelFlag
    : (typeof opts.providerFlag === 'boolean' ? opts.providerFlag : undefined);
  if (flag === false) return 'refuse';
  if (flag === true) return 'native';

  if (resolveResponsesEligibility(opts)) return 'native';
  return opts.isDeployed ? 'refuse' : 'orchestration';
}
