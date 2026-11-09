/**
 * Request-weighted merge of two per-source averages.
 *
 * getUsageStatistics aggregates API-key usage and AWS-credential usage separately (one SQL
 * `avg(responseTime)` each, over `count(*)` rows) and then merges the two per provider, e-mail
 * and model. Each source's average is its sum over its own request count, so weighting by those
 * counts gives the exact average over both sources; "(a + b) / 2" weighted one lone request like
 * a thousand.
 */

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function weightedAverage(averageA: number, countA: number, averageB: number, countB: number): number {
  const a = toNumber(averageA);
  const ca = toNumber(countA);
  const b = toNumber(averageB);
  const cb = toNumber(countB);
  const total = ca + cb;
  if (total <= 0) {
    return 0;
  }
  return (a * ca + b * cb) / total;
}
