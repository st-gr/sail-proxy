export type Summary = { p50: number; p95: number; mean: number };

// Nearest-rank percentile on the sorted samples: the value at rank ceil(p/100 * n).
function nearestRank(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function summarize(samplesMs: number[]): Summary {
  if (samplesMs.length === 0) throw new Error('summarize needs at least one sample');
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { p50: nearestRank(sorted, 50), p95: nearestRank(sorted, 95), mean };
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);

// Noise is the spread (max - min) of the baseline runs; the deltas compare the median of the
// candidate runs with the median of the baseline runs. A faster candidate (negative delta) is always ok; only a slower one is held to the noise.
export function withinNoise(baselineRuns: Summary[], candidateRuns: Summary[]): {
  ok: boolean; p50Delta: number; p95Delta: number; noiseP50: number; noiseP95: number;
} {
  const noiseP50 = spread(baselineRuns.map((r) => r.p50));
  const noiseP95 = spread(baselineRuns.map((r) => r.p95));
  const p50Delta = median(candidateRuns.map((r) => r.p50)) - median(baselineRuns.map((r) => r.p50));
  const p95Delta = median(candidateRuns.map((r) => r.p95)) - median(baselineRuns.map((r) => r.p95));
  return { ok: p50Delta <= noiseP50 && p95Delta <= noiseP95, p50Delta, p95Delta, noiseP50, noiseP95 };
}
