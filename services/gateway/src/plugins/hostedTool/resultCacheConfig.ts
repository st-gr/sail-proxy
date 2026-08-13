/**
 * Bounds for the hosted-tool result cache. Co-located with the feature, pure and
 * unit-testable, mirroring plugins/webSearch/searchCap.ts.
 */
export const DEFAULT_RESULT_CACHE_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

export const DEFAULT_RESULT_CACHE_MAX_ENTRIES = 500;
const MIN_MAX_ENTRIES = 10;
const MAX_MAX_ENTRIES = 10000;

export function resolveResultCacheTtlSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_RESULT_CACHE_TTL_SECONDS;
  if (value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) return DEFAULT_RESULT_CACHE_TTL_SECONDS;
  return value;
}

export function resolveResultCacheMaxEntries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_RESULT_CACHE_MAX_ENTRIES;
  if (value < MIN_MAX_ENTRIES || value > MAX_MAX_ENTRIES) return DEFAULT_RESULT_CACHE_MAX_ENTRIES;
  return value;
}
