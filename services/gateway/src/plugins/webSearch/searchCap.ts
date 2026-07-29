/**
 * How many hosted web searches one request may perform before the gateway stops
 * continuing the turn.
 *
 * Each search costs a Perplexity call plus a full deployment round trip, so this is a
 * cost control as well as the continuation loop's termination guarantee — which is why
 * an out-of-range, zero, negative, fractional or non-numeric value falls back to the
 * default instead of being honoured. The bound must never be configurable away.
 *
 * Pure: no I/O, no config access. configService reads the value and delegates here.
 *
 * @see api_config.json - web_search.max_searches_per_request
 */

export const DEFAULT_MAX_WEB_SEARCHES = 3;
const MIN_MAX_WEB_SEARCHES = 1;
const MAX_MAX_WEB_SEARCHES = 10;

export function resolveMaxWebSearches(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_MAX_WEB_SEARCHES;
  if (value < MIN_MAX_WEB_SEARCHES || value > MAX_MAX_WEB_SEARCHES) return DEFAULT_MAX_WEB_SEARCHES;
  return value;
}
