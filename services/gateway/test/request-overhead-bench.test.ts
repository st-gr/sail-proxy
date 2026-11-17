import { summarize, withinNoise, Summary } from '../scripts/requestOverheadBench/stats';

const run = (p50: number, p95: number): Summary => ({ p50, p95, mean: p50 });

describe('request overhead bench statistics', () => {
  describe('summarize', () => {
    it('takes nearest-rank percentiles of the sorted samples and the mean', () => {
      const samples = Array.from({ length: 100 }, (_, i) => 100 - i); // unsorted: 100 .. 1
      expect(summarize(samples)).toEqual({ p50: 50, p95: 95, mean: 50.5 });
    });

    it('does not reorder the input', () => {
      const samples = [3, 1, 2];
      summarize(samples);
      expect(samples).toEqual([3, 1, 2]);
    });

    it('handles a single sample', () => {
      expect(summarize([7])).toEqual({ p50: 7, p95: 7, mean: 7 });
    });

    it('refuses an empty list', () => {
      expect(() => summarize([])).toThrow();
    });
  });

  describe('withinNoise', () => {
    const baseline = [run(10, 20), run(11, 22), run(10.5, 21), run(12, 24), run(10.2, 20.5)];

    it('is ok when the candidate medians lie inside the baseline spread', () => {
      const r = withinNoise(baseline, [run(10.6, 21), run(11, 22), run(10.8, 21.5)]);
      expect(r.noiseP50).toBeCloseTo(2);
      expect(r.noiseP95).toBeCloseTo(4);
      expect(r.p50Delta).toBeCloseTo(0.3);
      expect(r.p95Delta).toBeCloseTo(0.5);
      expect(r.ok).toBe(true);
    });

    it('is not ok when the candidate is 2 ms outside the spread', () => {
      const r = withinNoise(baseline, [run(14.5, 21), run(14.5, 21), run(14.5, 21)]);
      expect(r.p50Delta).toBeCloseTo(4);
      expect(r.ok).toBe(false);
    });

    it('is not ok when only p95 is outside', () => {
      const r = withinNoise(baseline, [run(10.5, 27), run(10.5, 27), run(10.5, 27)]);
      expect(r.p95Delta).toBeCloseTo(6);
      expect(r.ok).toBe(false);
    });

    it('treats a faster candidate as ok', () => {
      const r = withinNoise(baseline, [run(1, 2), run(1, 2), run(1, 2)]);
      expect(r.p50Delta).toBeLessThan(0);
      expect(r.ok).toBe(true);
    });

    it('compares medians, so one outlying run does not decide', () => {
      const r = withinNoise(baseline, [run(10.5, 21), run(10.5, 21), run(50, 90)]);
      expect(r.ok).toBe(true);
    });
  });
});
