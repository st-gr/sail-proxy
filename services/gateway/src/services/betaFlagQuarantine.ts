/**
 * In-memory quarantine for anthropic_beta flags rejected by SAP AI Core.
 *
 * When SAP (AWS Bedrock behind it) rejects a request with HTTP 400
 * "invalid beta flag", the flags that were sent are quarantined for that
 * model so subsequent requests omit them and succeed. Keyed by modelId
 * because Bedrock's flag acceptance differs per model version.
 *
 * Process-local and reset on restart — a self-healing stopgap, not
 * configuration. Operators should promote quarantined flags to
 * anthropic.excluded_beta_headers (admin UI, hot-reloaded) permanently.
 */
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

const quarantinedByModel = new Map<string, Set<string>>();

// Matches Anthropic beta flag tokens (name + date suffix) inside an error
// body, e.g. "claude-code-20250219" or "context-1m-2025-08-07".
const FLAG_PATTERN = /[a-z0-9][a-z0-9-]*-20\d{2}(?:-\d{2}){0,2}/g;

export function getQuarantinedFlags(modelId: string): string[] {
  return Array.from(quarantinedByModel.get(modelId) ?? []);
}

export function quarantineFlags(modelId: string, flags: string[]): void {
  if (flags.length === 0) {
    return;
  }
  const set = quarantinedByModel.get(modelId) ?? new Set<string>();
  for (const flag of flags) {
    set.add(flag);
  }
  quarantinedByModel.set(modelId, set);
}

export function clearQuarantine(): void {
  quarantinedByModel.clear();
}

function serializeErrorData(errorData: any): string {
  if (typeof errorData === 'string') {
    return errorData;
  }
  try {
    return JSON.stringify(errorData) ?? '';
  } catch {
    return '';
  }
}

/**
 * Whether an upstream error response is a beta-flag rejection.
 */
export function isInvalidBetaFlagError(status: number | undefined, errorData: any): boolean {
  if (status !== 400) {
    return false;
  }
  return /invalid beta flag|anthropic[-_]beta/i.test(serializeErrorData(errorData));
}

/**
 * Flags to quarantine: those explicitly named in the error body when present
 * (first-party-style errors name them), else all flags that were sent
 * (Bedrock's bare "invalid beta flag" names none).
 */
export function resolveRejectedFlags(errorData: any, sentFlags: string[]): string[] {
  if (sentFlags.length === 0) {
    return [];
  }
  const named = (serializeErrorData(errorData).match(FLAG_PATTERN) ?? [])
    .filter(flag => sentFlags.includes(flag));
  return named.length > 0 ? Array.from(new Set(named)) : [...sentFlags];
}

/**
 * Record a beta-flag rejection so subsequent requests for this model omit
 * the offending flags. Returns the quarantined flags.
 */
export function recordBetaFlagRejection(modelId: string, errorData: any, sentFlags: string[]): string[] {
  const rejected = resolveRejectedFlags(errorData, sentFlags);
  quarantineFlags(modelId, rejected);
  logger.warn('BetaFlagQuarantine',
    `Quarantined ${rejected.length} beta flag(s) for model ${modelId} after upstream 400: ${rejected.join(', ')}. ` +
    `Subsequent requests omit them (in-memory, resets on restart). ` +
    `Add them to anthropic.excluded_beta_headers via the admin UI to make this permanent.`);
  return rejected;
}
