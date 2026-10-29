/** Markdown tables of a bench run (the JSON written by --out holds the same numbers in full). */
import type { LexicalVariantResult, Stat } from './lexical';
import type { IndexConfig } from './options';
import type { AnnResult, BenchStore } from './vectors';

export interface ConfigResult {
  config: IndexConfig;
  buildMs: number;
  indexBytes: number;
  workers: number;
  notices: string[];
  insert: { count: number; ms: number; msPer1000: number } | null;
  ann: AnnResult[];
}

const f = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '-' : v.toFixed(digits));
const ms = (s: Stat) => `${f(s.p50)} / ${f(s.p95)}`;

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export const configName = (c: IndexConfig) => `${c.kind} ef${c.efConstruction} ${c.parallel ? 'parallel' : 'serial'}`;

export function exactTable(exact: Array<{ store: BenchStore; source: string; ms: Stat }>): string {
  return table(['store chunks', 'table %', 'queries', 'exact p50 / p95 ms'],
    exact.map((e) => [String(e.store.size), f(e.store.fraction * 100, 2), e.source, ms(e.ms)]));
}

export function buildTable(configs: ConfigResult[], baselineInsert: { msPer1000: number } | null): string {
  const rows = configs.map((c) => [configName(c.config), f(c.buildMs / 1000), f(c.indexBytes / 2 ** 20, 0),
    c.insert ? f(c.insert.msPer1000, 0) : '-', c.notices.join('; ') || '-']);
  if (baselineInsert) rows.unshift(['no HNSW index', '-', '-', f(baselineInsert.msPer1000, 0), '-']);
  return table(['index', 'build s', 'index MiB', 'insert ms / 1000 chunks', 'build notices'], rows);
}

export function annTable(configs: ConfigResult[]): string {
  const rows: string[][] = [];
  for (const c of configs) {
    for (const a of c.ann) {
      const s = a.summary;
      rows.push([configName(c.config), String(a.store.size), f(a.store.fraction * 100, 2), a.source,
        f(s.recall.mean, 3), f(s.recall.min, 2), `${f((s.gap.mean ?? 0) * 100, 2)} / ${f((s.gap.max ?? 0) * 100, 2)}`,
        `${s.failures}/${s.queries}`, `${s.underReturned}/${s.queries}`,
        `${s.reruns}/${s.queries}`, ms(s.annMs), ms(s.effectiveMs), a.usesIndex ? 'yes' : 'NO']);
    }
  }
  return table(['index', 'store chunks', 'table %', 'queries', 'recall mean', 'min', 'gap mean / max %', 'fail <0.5',
    'under', 're-runs', 'ANN p50 / p95 ms', 'with re-run p50 / p95 ms', 'index used'], rows);
}

export function lexicalTable(results: LexicalVariantResult[]): string {
  return table(['question', 'variant', 'terms', 'AND enough', 'first ms', 'p50 / p95 ms', 'rows', 'overlap with today'],
    results.map((r) => [r.question, r.variant, String(r.terms), r.andIsEnough ? 'yes' : 'no', f(r.firstMs),
      ms(r.ms), String(r.rows), f(r.agreement, 3)]));
}
