/**
 * Tokens per second for the Usage app's Models tab: output tokens over the full response time,
 * as a ratio of sums so that merging the API-key and AWS-credential aggregates of one model keeps
 * the figure exact (a mean of per-source ratios would not).
 */
import { addThroughput, tokensPerSecond, ThroughputSums } from '../../../src/utils/throughput';

describe('tokensPerSecond', () => {
  it('divides output tokens by the response time in seconds', () => {
    expect(tokensPerSecond(1000, 2000)).toBe(500);
  });

  it('rounds to one decimal', () => {
    expect(tokensPerSecond(7, 1500)).toBe(4.7);
    expect(tokensPerSecond(1, 3000)).toBe(0.3);
  });

  it('is null when there are no output tokens or no measured time', () => {
    expect(tokensPerSecond(0, 2000)).toBeNull();
    expect(tokensPerSecond(500, 0)).toBeNull();
    expect(tokensPerSecond(undefined as unknown as number, 2000)).toBeNull();
    expect(tokensPerSecond(500, Number.NaN)).toBeNull();
  });
});

describe('addThroughput', () => {
  it('adds the two sums so the merged figure is the ratio of totals, not the mean of ratios', () => {
    const apiKeys: ThroughputSums = { throughputOutputTokens: 1000, throughputResponseTime: 1000 }; // 1000 t/s
    const aws: ThroughputSums = { throughputOutputTokens: 100, throughputResponseTime: 10000 };    // 10 t/s
    const merged = addThroughput(apiKeys, aws);
    expect(merged).toEqual({ throughputOutputTokens: 1100, throughputResponseTime: 11000 });
    expect(tokensPerSecond(merged.throughputOutputTokens, merged.throughputResponseTime)).toBe(100);
  });

  it('treats a missing or non-numeric sum as 0', () => {
    const merged = addThroughput(
      { throughputOutputTokens: '250' as unknown as number, throughputResponseTime: undefined as unknown as number },
      { throughputOutputTokens: 50, throughputResponseTime: 1000 },
    );
    expect(merged).toEqual({ throughputOutputTokens: 300, throughputResponseTime: 1000 });
  });
});
