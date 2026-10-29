/**
 * Tokens per second for the Usage app's Models tab.
 *
 * The figure is end-to-end throughput: output tokens over the request's full response time
 * (for a streaming request that includes the wait before the first token; the gateway records
 * no first-token timestamp). It is a ratio of sums over the selected period, so one model's
 * API-key and AWS-credential aggregates merge exactly by adding the sums — a mean of two
 * per-source ratios would weight a single fast request like a thousand slow ones.
 */

/** Sums over the usage rows that have both output tokens and a measured response time. */
export interface ThroughputSums {
  throughputOutputTokens: number;
  throughputResponseTime: number; // milliseconds
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function addThroughput(a: ThroughputSums, b: ThroughputSums): ThroughputSums {
  return {
    throughputOutputTokens: toNumber(a.throughputOutputTokens) + toNumber(b.throughputOutputTokens),
    throughputResponseTime: toNumber(a.throughputResponseTime) + toNumber(b.throughputResponseTime),
  };
}

/** Output tokens per second, one decimal; null when nothing was measured. */
export function tokensPerSecond(outputTokens: number, responseTimeMs: number): number | null {
  const tokens = toNumber(outputTokens);
  const ms = toNumber(responseTimeMs);
  if (tokens <= 0 || ms <= 0) {
    return null;
  }
  return Math.round((tokens * 1000 / ms) * 10) / 10;
}
