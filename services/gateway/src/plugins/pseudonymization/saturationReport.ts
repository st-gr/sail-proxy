/**
 * The saturation report — REPORT-ONLY, by ruling.
 *
 * How much PII a request carries is worth telling an operator about: a request that masks
 * 200 distinct values is either a data dump heading for a model or a detector running wild,
 * and both are worth seeing. It is NOT evidence about any one value in the request, and the
 * spec's original −0.2 confidence adjustment was removed in task 2's fix round 3 for exactly
 * that reason: a roster of 41 names masked nothing while the same roster of 30 masked all of
 * them. Nothing in this module may reach a score, drop a mask, or change what is detected.
 * It runs AFTER masking is finished and reads the result.
 *
 * Two outputs, from the same counts:
 *
 *   - one WARN line per request, only above the bar, carrying the per-category histogram and
 *     the most common identifier SHAPES;
 *   - a `pseudonymization` block on the SIEM usage event, attached whether or not the bar was
 *     passed, so a saturation trend is visible in a SIEM without anyone reading gateway logs.
 *
 * Neither ever carries a masked VALUE. The histogram is counts, and a shape is the value with
 * every letter replaced by X and every digit by 9 — enough to tell `XXX_XXXX_XXXX_XXXXX`
 * (an object name) from `XXXXXXXX.XXXXXXXX` (a name), which is the question an operator
 * looking at a saturated request is actually asking.
 */

import { EntityMatch } from './types';

/** `pseudonymization.saturation_warn` when the operator sets none. */
export const DEFAULT_SATURATION_WARN = 40;

/** How many distinct shapes the WARN line names. */
const TOP_SHAPES = 5;

/** Longest shape rendered; a longer value is cut and marked, so one huge span cannot flood the log. */
const MAX_SHAPE_LENGTH = 40;

/** The block attached to the SIEM usage event. Counts and a flag — never a value. */
export interface SaturationReport {
  /** Distinct masked values in this request. */
  masked_values: number;
  /** Distinct masked values per category, highest first. */
  categories: Record<string, number>;
  /** Whether `masked_values` passed `saturation_warn`. */
  saturated: boolean;
}

/**
 * `saturation_warn` as the reporter will use it. An integer of at least 1; anything else —
 * a fraction, zero, a negative, a string that reached the gateway around the schema — is
 * IGNORED rather than coerced, the same rule `min_confidence` follows. Coercing 0 to
 * "warn about everything" would flood the log on the strength of a typo.
 */
export function resolveSaturationWarn(configured: unknown): number {
  return typeof configured === 'number' && Number.isInteger(configured) && configured >= 1
    ? configured
    : DEFAULT_SATURATION_WARN;
}

/**
 * The shape of a value: letters → `X`, digits → `9`, `_` and `-` kept because they are what
 * separates the segments of an object name, and EVERY other character → `.`. One output
 * character per input character, so the length is the value's length and nothing else about
 * it survives.
 */
export function identifierShape(value: string): string {
  const cut = value.length > MAX_SHAPE_LENGTH ? value.slice(0, MAX_SHAPE_LENGTH) : value;
  const shape = cut.replace(/\p{L}/gu, 'X').replace(/\p{Nd}/gu, '9').replace(/[^X9_-]/gu, '.');
  return value.length > MAX_SHAPE_LENGTH ? `${shape}…` : shape;
}

/**
 * Count the DISTINCT masked values of a finished request, overall and per category.
 *
 * Distinct, not total: the same name in forty messages is one value the model gets to see
 * once, and counting occurrences would report a long conversation as a data dump. A value
 * detected as two categories is counted once overall and once in each of them, so the
 * histogram can sum to more than `masked_values` — the alternative is picking one category
 * arbitrarily and under-reporting the other.
 */
export function buildSaturationReport(entities: EntityMatch[], saturationWarn: number): SaturationReport {
  const distinct = new Set<string>();
  const perCategory = new Map<string, Set<string>>();

  for (const entity of entities) {
    distinct.add(entity.original);
    let bucket = perCategory.get(entity.type);
    if (!bucket) {
      bucket = new Set<string>();
      perCategory.set(entity.type, bucket);
    }
    bucket.add(entity.original);
  }

  const categories: Record<string, number> = {};
  for (const [type, values] of [...perCategory.entries()].sort((a, b) => b[1].size - a[1].size)) {
    categories[type] = values.size;
  }

  return {
    masked_values: distinct.size,
    categories,
    saturated: distinct.size > saturationWarn,
  };
}

/** The most common shapes among the DISTINCT masked values, as `shape ×count`, highest first. */
export function topShapes(entities: EntityMatch[], limit = TOP_SHAPES): string[] {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const entity of entities) {
    if (seen.has(entity.original)) continue;
    seen.add(entity.original);
    const shape = identifierShape(entity.original);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([shape, count]) => `${shape} x${count}`);
}

/**
 * The single WARN line. Assembled here, not at the call site, so what a saturated request
 * logs is decided in one place and can be asserted in one place — including the property
 * that matters most about it, which is what it does NOT contain.
 */
export function formatSaturationWarning(
  report: SaturationReport,
  shapes: string[],
  saturationWarn: number,
): string {
  const histogram = Object.entries(report.categories).map(([type, count]) => `${type}=${count}`).join(', ')
    || 'none';
  return `Pseudonymization saturation: ${report.masked_values} distinct values masked in one request `
    + `(saturation_warn=${saturationWarn}). By category: ${histogram}. `
    + `Top shapes: ${shapes.join(', ') || 'none'} (letters shown as X, digits as 9 — never the values).`;
}
