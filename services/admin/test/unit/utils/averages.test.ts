/**
 * Merging two per-source response-time averages (API keys and AWS credentials for one model,
 * provider or e-mail) must weight each by its request count: each source's average is its sum
 * over its own count, so the weighted mean is the exact average over both — "(a + b) / 2" is not.
 */
import { weightedAverage } from '../../../src/utils/averages';

describe('weightedAverage', () => {
  it('weights each average by its request count', () => {
    // one slow request next to ninety-nine fast ones: the true mean is 10.9, not 55
    expect(weightedAverage(100, 1, 10, 99)).toBeCloseTo(10.9, 6);
  });

  it('returns the other side when one side has no requests', () => {
    expect(weightedAverage(0, 0, 42, 7)).toBe(42);
    expect(weightedAverage(42, 7, 0, 0)).toBe(42);
  });

  it('is 0 when neither side has requests', () => {
    expect(weightedAverage(0, 0, 0, 0)).toBe(0);
  });

  it('coerces numeric strings and treats non-numbers as 0 (Postgres returns some aggregates as strings)', () => {
    expect(weightedAverage('100' as unknown as number, '1' as unknown as number, 10, 99)).toBeCloseTo(10.9, 6);
    expect(weightedAverage(undefined as unknown as number, 3, 20, 1)).toBe(5);
  });
});
