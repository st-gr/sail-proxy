/**
 * Leaderboard and chart derive from LibraryModels.benchmarks (the latest version's metadata array,
 * e.g. [{lmArenaTextArenaScore:"1410"},{helmCapabilitiesAccuracyMeanScore:"0.717"}]).
 */
import { collectBenchmarkKeys, leaderboardRows, chartPoints, BENCHMARK_LABELS, BENCHMARK_DESCRIPTIONS, benchmarkTooltip } from '../webapp/model/benchmarks';

const rows = [
  { modelId: 'a', displayName: 'A', provider: 'Anthropic', latestVersion: '1', benchmarks: JSON.stringify([{ lmArenaTextArenaScore: '1410' }, { helmCapabilitiesAccuracyMeanScore: '0.717' }]) },
  { modelId: 'b', displayName: 'B', provider: 'OpenAI', latestVersion: '2025-08-07', benchmarks: JSON.stringify([{ lmArenaTextArenaScore: '1400' }, { chatBotArenaScore: '1300' }]) },
  { modelId: 'c', displayName: 'C', provider: 'SAP', latestVersion: '1', benchmarks: null },
  { modelId: 'd', displayName: 'D', provider: 'X', latestVersion: '1', benchmarks: 'not json' }
];

describe('benchmarks', () => {
  it('collects the score keys present, in label order, with SAP labels', () => {
    expect(collectBenchmarkKeys(rows)).toEqual(['helmCapabilitiesAccuracyMeanScore', 'lmArenaTextArenaScore', 'chatBotArenaScore']);
    expect(BENCHMARK_LABELS.lmArenaTextArenaScore).toBe('LMArena Text Arena Score');
    expect(BENCHMARK_LABELS.airBenchRefusalRate).toBe('AIRBench Refusal Rate');
  });
  it('builds leaderboard rows only for models with at least one score, numbers parsed', () => {
    const lb = leaderboardRows(rows);
    expect(lb.map(r => r.modelId)).toEqual(['a', 'b']);
    expect(lb[0].scores.lmArenaTextArenaScore).toBe(1410);
    expect(lb[0].scores.helmCapabilitiesAccuracyMeanScore).toBeCloseTo(0.717);
    expect(lb[1].scores.helmCapabilitiesAccuracyMeanScore).toBeUndefined();
  });
  it('builds chart points only where both axes have a value, each carrying its modelId for navigation', () => {
    expect(chartPoints(rows, 'lmArenaTextArenaScore', 'helmCapabilitiesAccuracyMeanScore')).toEqual([
      { modelId: 'a', label: 'A - 1', provider: 'Anthropic', x: 1410, y: 0.717, size: 1 }
    ]);
    expect(chartPoints(rows, 'lmArenaTextArenaScore', 'chatBotArenaScore')).toEqual([{ modelId: 'b', label: 'B - 2025-08-07', provider: 'OpenAI', x: 1400, y: 1300, size: 1 }]);
    expect(chartPoints(rows, 'nope', 'lmArenaTextArenaScore')).toEqual([]);
  });
});

// H: the leaderboard hint promises "Hover over a metric name for more information", so every
// known metric needs a sentence of its own — a new metric cannot ship without one.
describe('benchmark descriptions', () => {
  it('describes every labelled metric, naming the scale and the direction', () => {
    Object.keys(BENCHMARK_LABELS).forEach(k => {
      expect(typeof BENCHMARK_DESCRIPTIONS[k]).toBe('string');
      expect(BENCHMARK_DESCRIPTIONS[k].length).toBeGreaterThan(20);
      expect(BENCHMARK_DESCRIPTIONS[k]).toMatch(/higher is (better|safer)/);
    });
  });
  it('describes nothing that has no label', () => {
    expect(Object.keys(BENCHMARK_DESCRIPTIONS).sort()).toEqual(Object.keys(BENCHMARK_LABELS).sort());
  });
  it('builds the column tooltip as label followed by the description', () => {
    expect(benchmarkTooltip('meanWinRate')).toBe(`${BENCHMARK_LABELS.meanWinRate} — ${BENCHMARK_DESCRIPTIONS.meanWinRate}`);
  });
  it('falls back to the bare key for a metric it does not know', () => {
    expect(benchmarkTooltip('somethingNew')).toBe('somethingNew');
  });
});
