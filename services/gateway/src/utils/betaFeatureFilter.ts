/**
 * Pure helpers for assembling and filtering anthropic_beta feature flags
 * before forwarding requests to SAP AI Core Bedrock deployments.
 *
 * Filtering semantics:
 * 1. Allowlist (supported): when non-empty, only listed flags survive.
 *    An empty/absent allowlist means "no allowlist filtering" (legacy behavior).
 * 2. Denylist (excluded): always applied on top of the allowlist result.
 *
 * 0. Renames (beta_header_renames) are applied first, so both lists see the upstream's names.
 *
 * @see api_config.json - providers.anthropic.supported_beta_headers / providers.anthropic.excluded_beta_headers
 */

export interface BetaFilterOptions {
  /** Allowlist from api_config.providers.anthropic.supported_beta_headers; [] disables allowlist filtering */
  supported: string[];
  /** Denylist from api_config.providers.anthropic.excluded_beta_headers */
  excluded: string[];
}

/**
 * Parse the raw anthropic-beta header value into a clean array of flags.
 * Accepts a comma-separated string, an array of values (each possibly
 * comma-separated), or undefined.
 */
export function parseAnthropicBetaHeader(headerValue: string | string[] | undefined): string[] {
  if (!headerValue) {
    return [];
  }
  const rawValues = Array.isArray(headerValue) ? headerValue : [headerValue];
  return rawValues
    .flatMap(value => String(value).split(','))
    .map(flag => flag.trim())
    .filter(Boolean);
}

/**
 * Merge multiple flag lists, preserving first-seen order and deduplicating.
 */
export function mergeBetaFeatures(...lists: string[][]): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const flag of list) {
      if (!merged.includes(flag)) {
        merged.push(flag);
      }
    }
  }
  return merged;
}

/**
 * Replace each flag the map names by the name the upstream knows it by, before the allowlist and
 * the denylist are applied: Anthropic's API and the Bedrock deployments behind SAP AI Core call
 * some betas differently (advanced-tool-use-2025-11-20 is tool-search-tool-2025-10-19 there), and
 * a flag that is merely dropped leaves the request fields it enables without their flag.
 * Order is kept and duplicates are removed.
 *
 * @see api_config.json - providers.anthropic.beta_header_renames
 */
export function renameBetaFeatures(features: string[], renames: Record<string, string>): string[] {
  return mergeBetaFeatures(features.map(flag => (Object.prototype.hasOwnProperty.call(renames, flag) ? renames[flag] : flag)));
}

/**
 * Apply allowlist-then-denylist filtering to a list of beta flags.
 */
export function filterBetaFeatures(features: string[], options: BetaFilterOptions): string[] {
  let result = features;
  if (options.supported.length > 0) {
    result = result.filter(flag => options.supported.includes(flag));
  }
  if (options.excluded.length > 0) {
    result = result.filter(flag => !options.excluded.includes(flag));
  }
  return result;
}
