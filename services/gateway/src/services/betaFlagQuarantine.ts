/**
 * In-memory quarantine for anthropic_beta flags rejected by SAP AI Core.
 *
 * When SAP (AWS Bedrock behind it) rejects a request with HTTP 400
 * "invalid beta flag", the flags that were sent are quarantined for that
 * model so subsequent requests omit them and succeed. Keyed by modelId
 * because Bedrock's flag acceptance differs per model version.
 *
 * Process-local and reset on restart — a self-healing stopgap, not
 * configuration. Entries also auto-expire after 30 minutes so a
 * false-positive detection can't silently degrade capabilities forever.
 * Operators should promote quarantined flags to
 * anthropic.excluded_beta_headers (admin UI, hot-reloaded) permanently.
 */
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// False positives happen: an unrelated 400 whose body merely mentions
// "anthropic_beta" would otherwise quarantine valid flags forever (until
// pod restart), silently degrading capabilities like the 1M context window.
// A 30-minute TTL bounds the blast radius of any single misdetection. The
// permanent mechanism for genuinely unsupported flags is the config
// denylist (anthropic.excluded_beta_headers), not this in-memory cache.
const QUARANTINE_TTL_MS = 30 * 60 * 1000;

const quarantinedByModel = new Map<string, Map<string, number>>();

export function getQuarantinedFlags(modelId: string): string[] {
  const flags = quarantinedByModel.get(modelId);
  if (!flags) {
    return [];
  }
  const now = Date.now();
  const live: string[] = [];
  for (const [flag, quarantinedAt] of flags) {
    if (now - quarantinedAt >= QUARANTINE_TTL_MS) {
      flags.delete(flag);
    } else {
      live.push(flag);
    }
  }
  if (flags.size === 0) {
    quarantinedByModel.delete(modelId);
  }
  return live;
}

export function quarantineFlags(modelId: string, flags: string[]): void {
  if (flags.length === 0) {
    return;
  }
  const now = Date.now();
  const map = quarantinedByModel.get(modelId) ?? new Map<string, number>();
  for (const flag of flags) {
    map.set(flag, now);
  }
  quarantinedByModel.set(modelId, map);
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
  const serialized = serializeErrorData(errorData);
  const named = sentFlags.filter(flag => serialized.includes(flag));
  return named.length > 0 ? named : [...sentFlags];
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
    `Subsequent requests omit them (in-memory, resets on restart or after 30 minutes). ` +
    `Add them to anthropic.excluded_beta_headers via the admin UI to make this permanent.`);
  return rejected;
}
