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
