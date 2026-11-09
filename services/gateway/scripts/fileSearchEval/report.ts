/**
 * The results file (ci/file-search-eval/results/<UTC timestamp>-<config>.json, gitignored) and the
 * --compare table. A results file carries metrics, per-question ranks, the configuration, the corpus
 * and question hashes and the cost; no chunk text, credentials or hostnames.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EvaluationMetrics, QUESTION_KINDS, Summary } from '../../src/fileSearch/eval/metrics';
import type { CostSnapshot } from './costMeter';
import type { QuestionRecord } from './evaluate';
import type { JudgeRun } from './judge';
import type { EvalConfig } from './options';

export interface ResultsFile {
  version: 1;
  complete: boolean;
  stopReasons: string[];
  startedAt: string;
  finishedAt: string;
  config: { name: string } & EvalConfig;
  pipeline: Record<string, unknown>;
  corpusManifestSha256: string;
  questions: { sha256: string; corpusManifestSha256: string; total: number; evaluated: number; failed: number };
  store: Record<string, unknown>;
  modes: Record<string, number>;
  cost: CostSnapshot;
  metrics: EvaluationMetrics | null;
  /** What a hit is: a chunk, or the parent section the search returned for it (`parent`, where the
   *  metrics count a parent that contains a quote). Absent in results written before W2 = chunk. */
  relevance?: 'chunk' | 'parent';
  /** Mean tokens of the returned texts per question; null before W2 or when nothing was evaluated. */
  returnedTokens?: ReturnedTokens | null;
  judge: JudgeRun | null;
  perQuestion: QuestionRecord[];
}

export interface ReturnedTokens { questions: number; meanTop5: number; meanAll: number }

/** The mean returned token volume over the questions that recorded one. */
export function returnedTokenSummary(records: QuestionRecord[]): ReturnedTokens | null {
  const counted = records.filter((r) => r.returnedTokens);
  if (!counted.length) return null;
  const mean = (f: (t: { top5: number; all: number }) => number) => counted.reduce((a, r) => a + f(r.returnedTokens!), 0) / counted.length;
  return { questions: counted.length, meanTop5: mean((t) => t.top5), meanAll: mean((t) => t.all) };
}

/** `2026-10-08T09-15-02Z-baseline.json`: sortable, no colons. */
export function resultsFileName(startedAt: Date, config: string): string {
  return `${startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}-${config}.json`;
}

export function writeResults(dir: string, results: ResultsFile): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, resultsFileName(new Date(results.startedAt), results.config.name));
  fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  return file;
}

const fmt = (n: number | null | undefined, digits = 3) => (typeof n === 'number' ? n.toFixed(digits) : '-');
const delta = (a: number | null | undefined, b: number | null | undefined, digits = 3) =>
  (typeof a === 'number' && typeof b === 'number' ? `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(digits)}` : '-');

function summaryRows(label: string, a: Summary | null | undefined, b: Summary | null | undefined): string[][] {
  const rows: string[][] = [];
  for (const k of ['5', '10', '20']) rows.push([`${label} recall@${k}`, fmt(a?.recall[k]), fmt(b?.recall[k]), delta(a?.recall[k], b?.recall[k])]);
  rows.push([`${label} MRR`, fmt(a?.mrr), fmt(b?.mrr), delta(a?.mrr, b?.mrr)]);
  rows.push([`${label} nDCG@10`, fmt(a?.ndcg10), fmt(b?.ndcg10), delta(a?.ndcg10, b?.ndcg10)]);
  return rows;
}

/** A plain-text table of every metric of A and B and the change B - A, with warnings first. */
export function compareResults(a: ResultsFile, b: ResultsFile): string {
  const warnings: string[] = [];
  if (a.corpusManifestSha256 !== b.corpusManifestSha256) warnings.push('WARNING: the runs used different corpora');
  if (a.questions.sha256 !== b.questions.sha256) warnings.push('WARNING: the runs used different question sets');
  if (a.pipeline.key !== b.pipeline.key) warnings.push('WARNING: the runs used different pipeline settings (store)');
  if ((a.relevance ?? 'chunk') !== (b.relevance ?? 'chunk')) {
    warnings.push(`WARNING: A counts a ${a.relevance ?? 'chunk'} as a hit, B a ${b.relevance ?? 'chunk'}; `
      + 'a parent section contains more quotes by its size alone');
  }
  for (const [name, r] of [['A', a], ['B', b]] as const) {
    if (!r.complete) warnings.push(`WARNING: ${name} is incomplete: ${r.stopReasons.join('; ')}`);
  }
  const ma = a.metrics;
  const mb = b.metrics;
  const rows: string[][] = [['metric', `A ${a.config.name}`, `B ${b.config.name}`, 'B - A']];
  rows.push(...summaryRows('overall', ma?.overall, mb?.overall));
  for (const kind of QUESTION_KINDS) {
    if (ma?.byKind[kind] || mb?.byKind[kind]) rows.push(...summaryRows(kind, ma?.byKind[kind], mb?.byKind[kind]));
  }
  rows.push(...summaryRows('multihop any-quote', ma?.multihopAnyQuote, mb?.multihopAnyQuote));
  rows.push(['latency p50 ms', fmt(ma?.latencyMs.p50, 0), fmt(mb?.latencyMs.p50, 0), delta(ma?.latencyMs.p50, mb?.latencyMs.p50, 0)]);
  rows.push(['latency p95 ms', fmt(ma?.latencyMs.p95, 0), fmt(mb?.latencyMs.p95, 0), delta(ma?.latencyMs.p95, mb?.latencyMs.p95, 0)]);
  rows.push(['fragment-rule hits', fmt(ma?.fragmentRuleHits, 0), fmt(mb?.fragmentRuleHits, 0), delta(ma?.fragmentRuleHits, mb?.fragmentRuleHits, 0)]);
  if (a.judge?.mean || b.judge?.mean) {
    rows.push(['judge faithfulness', fmt(a.judge?.mean?.faithfulness, 2), fmt(b.judge?.mean?.faithfulness, 2),
      delta(a.judge?.mean?.faithfulness, b.judge?.mean?.faithfulness, 2)]);
    rows.push(['judge correctness', fmt(a.judge?.mean?.correctness, 2), fmt(b.judge?.mean?.correctness, 2),
      delta(a.judge?.mean?.correctness, b.judge?.mean?.correctness, 2)]);
  }
  const ta = a.returnedTokens;
  const tb = b.returnedTokens;
  if (ta || tb) {
    rows.push(['returned tokens top 5 (mean)', fmt(ta?.meanTop5, 0), fmt(tb?.meanTop5, 0), delta(ta?.meanTop5, tb?.meanTop5, 0)]);
    rows.push(['returned tokens all (mean)', fmt(ta?.meanAll, 0), fmt(tb?.meanAll, 0), delta(ta?.meanAll, tb?.meanAll, 0)]);
  }
  const chunks = (r: ResultsFile) => (typeof r.store.chunks === 'number' ? r.store.chunks : null);
  rows.push(['store chunks', fmt(chunks(a), 0), fmt(chunks(b), 0), delta(chunks(a), chunks(b), 0)]);
  const ctx = (r: ResultsFile) => r.store.context as { inputTokens: number; cachedTokens: number } | null | undefined;
  if (ctx(a) || ctx(b)) {
    const prompt = (r: ResultsFile) => (ctx(r) ? ctx(r)!.inputTokens + ctx(r)!.cachedTokens : null);
    rows.push(['context prompt tokens', fmt(prompt(a), 0), fmt(prompt(b), 0), delta(prompt(a), prompt(b), 0)]);
  }
  rows.push(['cost usd', fmt(a.cost.spentUsd, 4), fmt(b.cost.spentUsd, 4), delta(a.cost.spentUsd, b.cost.spentUsd, 4)]);
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  const table = rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  '));
  return [...warnings, ...table].join('\n');
}
