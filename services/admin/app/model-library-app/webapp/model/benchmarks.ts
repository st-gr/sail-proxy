/**
 * Resolves an i18n key — the controller injects the resource bundle; jest passes none and gets the
 * English defaults below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string) => string;

/** Benchmark keys as published by SAP AI Core, in the leaderboard's column order. */
const METRICS = [
  'helmCapabilitiesAccuracyMeanScore', 'meanWinRate', 'lmArenaTextArenaScore', 'chatBotArenaScore',
  'airBenchRefusalRate', 'biasRefusalRate', 'mtebAverageScore', 'mtebMultilingualMeanScore'
];

/**
 * English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold.
 * benchmarkLabel_<metric>: the labels the SAP Model Library uses (the benchmark names - HELM, LMArena,
 * AIRBench, MTEB … - stay untranslated in every language, only the generic words around them move).
 * benchmarkInfo_<metric>: one plain-language sentence per metric for the leaderboard column tooltips
 * (H) — the hint promises "Hover over a metric name for more information", and the benchmark JSON
 * carries only key/value pairs. Each names the source, the scale and the direction.
 */
const EN_TEXTS: Record<string, string> = {
  benchmarkLabel_helmCapabilitiesAccuracyMeanScore: 'HELM Capabilities Accuracy Mean Score',
  benchmarkLabel_meanWinRate: 'HELM Lite Accuracy Mean Win Rate',
  benchmarkLabel_lmArenaTextArenaScore: 'LMArena Text Arena Score',
  benchmarkLabel_chatBotArenaScore: 'ChatBotArena Arena Score',
  benchmarkLabel_airBenchRefusalRate: 'AIRBench Refusal Rate',
  benchmarkLabel_biasRefusalRate: 'AIRBench Discrimination/Bias Refusal Rate',
  benchmarkLabel_mtebAverageScore: 'MTEB Average Score',
  benchmarkLabel_mtebMultilingualMeanScore: 'MTEB Multilingual Mean Score',
  benchmarkInfo_helmCapabilitiesAccuracyMeanScore: "HELM Capabilities: mean accuracy across the suite's scenarios, 0-1, higher is better.",
  benchmarkInfo_meanWinRate: 'HELM Lite: mean win rate against the other evaluated models, 0-1, higher is better.',
  benchmarkInfo_lmArenaTextArenaScore: 'LMArena text arena Elo-style score from human pairwise votes; higher is better.',
  benchmarkInfo_chatBotArenaScore: 'Chatbot Arena score from human pairwise votes; higher is better.',
  benchmarkInfo_airBenchRefusalRate: 'AIRBench: share of unsafe requests the model refused, 0-1, higher is safer.',
  benchmarkInfo_biasRefusalRate: 'AIRBench discrimination/bias: share of biased requests refused, 0-1, higher is safer.',
  benchmarkInfo_mtebAverageScore: 'MTEB: mean embedding-benchmark score across tasks; higher is better.',
  benchmarkInfo_mtebMultilingualMeanScore: 'MTEB multilingual: mean score across the multilingual tasks; higher is better.'
};
const defaultTranslate: Translator = (key) => EN_TEXTS[key] ?? key;

/** A translator without the text (the bundle not loaded yet) falls back to English. */
function textOf(key: string, t: Translator): string {
  const text = typeof t === 'function' ? t(key) : undefined;
  return text && text !== key ? text : defaultTranslate(key);
}

/** Metric -> its English label. Keep in step with BENCHMARK_DESCRIPTIONS: benchmarks.test.ts fails if a labelled metric has no description. */
export const BENCHMARK_LABELS: Record<string, string> = Object.fromEntries(METRICS.map((m) => [m, defaultTranslate(`benchmarkLabel_${m}`)]));

/** Metric -> its English tooltip sentence (see EN_TEXTS). */
export const BENCHMARK_DESCRIPTIONS: Record<string, string> = Object.fromEntries(METRICS.map((m) => [m, defaultTranslate(`benchmarkInfo_${m}`)]));

/** A metric's label in the cockpit's language, or the bare key for a new metric. */
export function benchmarkLabel(metric: string, t: Translator = defaultTranslate): string {
  return BENCHMARK_LABELS[metric] ? textOf(`benchmarkLabel_${metric}`, t) : metric;
}

/** Leaderboard column tooltip: the label and its sentence, or the bare key for a new metric. */
export function benchmarkTooltip(metric: string, t: Translator = defaultTranslate): string {
  if (!BENCHMARK_LABELS[metric]) return metric;
  const label = benchmarkLabel(metric, t);
  return BENCHMARK_DESCRIPTIONS[metric] ? `${label} \u2014 ${textOf(`benchmarkInfo_${metric}`, t)}` : label;
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
