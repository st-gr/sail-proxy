/** Benchmark keys as published by SAP AI Core, with the labels the SAP Model Library uses. */
export const BENCHMARK_LABELS: Record<string, string> = {
  helmCapabilitiesAccuracyMeanScore: 'HELM Capabilities Accuracy Mean Score',
  meanWinRate: 'HELM Lite Accuracy Mean Win Rate',
  lmArenaTextArenaScore: 'LMArena Text Arena Score',
  chatBotArenaScore: 'ChatBotArena Arena Score',
  airBenchRefusalRate: 'AIRBench Refusal Rate',
  biasRefusalRate: 'AIRBench Discrimination/Bias Refusal Rate',
  mtebAverageScore: 'MTEB Average Score',
  mtebMultilingualMeanScore: 'MTEB Multilingual Mean Score'
};

/**
 * One plain-language sentence per metric for the leaderboard column tooltips (H) — the hint
 * promises "Hover over a metric name for more information", and the benchmark JSON carries only
 * key/value pairs. Each names the source, the scale and the direction. Keep this in step with
 * BENCHMARK_LABELS: benchmarks.test.ts fails if a labelled metric has no description.
 */
export const BENCHMARK_DESCRIPTIONS: Record<string, string> = {
  helmCapabilitiesAccuracyMeanScore: "HELM Capabilities: mean accuracy across the suite's scenarios, 0-1, higher is better.",
  meanWinRate: 'HELM Lite: mean win rate against the other evaluated models, 0-1, higher is better.',
  lmArenaTextArenaScore: 'LMArena text arena Elo-style score from human pairwise votes; higher is better.',
  chatBotArenaScore: 'Chatbot Arena score from human pairwise votes; higher is better.',
  airBenchRefusalRate: 'AIRBench: share of unsafe requests the model refused, 0-1, higher is safer.',
  biasRefusalRate: 'AIRBench discrimination/bias: share of biased requests refused, 0-1, higher is safer.',
  mtebAverageScore: 'MTEB: mean embedding-benchmark score across tasks; higher is better.',
  mtebMultilingualMeanScore: 'MTEB multilingual: mean score across the multilingual tasks; higher is better.'
};

/** Leaderboard column tooltip: the label and its sentence, or the bare key for a new metric. */
export function benchmarkTooltip(key: string): string {
  const label = BENCHMARK_LABELS[key];
  if (!label) return key;
  const description = BENCHMARK_DESCRIPTIONS[key];
  return description ? `${label} \u2014 ${description}` : label;
}

const ORDER = Object.keys(BENCHMARK_LABELS);
/** Safety group for the Metrics section; everything else is Quality. */
export const SAFETY_KEYS = ['airBenchRefusalRate', 'biasRefusalRate'];

export interface ModelRow { modelId: string; displayName: string; provider: string; latestVersion: string | null; benchmarks: string | null; }
export interface LeaderboardRow { modelId: string; displayName: string; provider: string; latestVersion: string | null; scores: Record<string, number>; }

export function parseScores(benchmarks: string | null | undefined): Record<string, number> {
  try {
    const arr = JSON.parse(benchmarks || '[]');
    if (!Array.isArray(arr)) return {};
    const out: Record<string, number> = {};
    for (const item of arr) for (const [k, v] of Object.entries(item || {})) {
      const n = Number(v); if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch { return {}; }
}

export function collectBenchmarkKeys(rows: ModelRow[]): string[] {
  const present = new Set<string>();
  rows.forEach(r => Object.keys(parseScores(r.benchmarks)).forEach(k => present.add(k)));
  return [...ORDER.filter(k => present.has(k)), ...[...present].filter(k => !ORDER.includes(k)).sort()];
}

export function leaderboardRows(rows: ModelRow[]): LeaderboardRow[] {
  return rows.map(r => ({ modelId: r.modelId, displayName: r.displayName, provider: r.provider, latestVersion: r.latestVersion, scores: parseScores(r.benchmarks) }))
    .filter(r => Object.keys(r.scores).length > 0);
}

/** modelId travels with the point so a click can navigate directly, without reverse-matching a label. */
export interface ChartPoint { modelId: string; label: string; provider: string; x: number; y: number; size: number; }
export function chartPoints(rows: ModelRow[], xKey: string, yKey: string): ChartPoint[] {
  return leaderboardRows(rows)
    .filter(r => r.scores[xKey] !== undefined && r.scores[yKey] !== undefined)
    .map(r => ({ modelId: r.modelId, label: `${r.displayName} - ${r.latestVersion ?? ''}`.trim(), provider: r.provider, x: r.scores[xKey], y: r.scores[yKey], size: 1 }));
}
