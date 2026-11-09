/**
 * The vector arm at scale, with the recall probe's SQL (cli-tools/file-search-recall-probe.js): the exact
 * path (today's) is measured once per load and kept as the truth in `fsscale_truth`; each index
 * configuration is then built, timed and sized, and its ANN path (the B2 shape: distance-only inner
 * ORDER BY, forced index, ef_search clamp(4 x limit, 200, 1000), iterative_scan relaxed_order) is
 * compared with that truth. An ANN answer with fewer than `limit` rows is followed by the exact
 * re-run, as the ANN path will do: its latency is added and its recall becomes 1.
 */
import type { ClientBase } from 'pg';
import { indexDdl, IndexConfig } from './options';
import type { Stat } from './lexical';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const probe = require('../../../../cli-tools/file-search-recall-probe.js') as {
  buildArmSql: (o: { ann: boolean; attribute: null; halfvecDims?: number | null }) => string;
  exactSettings: (limit: number) => string[];
  annSettings: (limit: number) => string[];
  tieAwareRecall: (exact: Row[], ann: Row[]) => number;
  summarize: (values: number[]) => Stat;
  planUsesIndex: (plan: unknown, indexName: string) => boolean;
};

interface Row { id: string; score: number }

export const FAILURE_RECALL = 0.5;

export interface AnnQuery {
  recall: number; exactCount: number; annCount: number; exactMs: number; annMs: number;
  /** distanceGap of the answer: how much farther the ANN rows are than the exact ones, relative. */
  gap: number;
}

/**
 * The relative excess of the mean distance of the ANN rows over the mean distance of as many exact rows
 * (0 = as close as the truth). A miss among near-equidistant candidates (an off-topic query) has a small
 * gap; a dead spot a large one.
 */
export function distanceGap(exact: Row[], ann: Row[]): number {
  const n = Math.min(ann.length, exact.length);
  if (n === 0) return 0;
  const mean = (rows: Row[]) => rows.slice(0, n).reduce((s, r) => s + r.score, 0) / n;
  const truth = mean(exact);
  return truth > 0 ? (mean(ann) - truth) / truth : 0;
}

export interface AnnSummary {
  queries: number;
  recall: Stat;
  recallAfterRerun: Stat;
  failures: number;
  underReturned: number;
  reruns: number;
  annMs: Stat;
  effectiveMs: Stat;
  gap: Stat;
}

export function summarizeAnn(queries: AnnQuery[], limit: number): AnnSummary {
  const rerun = (q: AnnQuery) => q.annCount < limit;
  return {
    queries: queries.length,
    recall: probe.summarize(queries.map((q) => q.recall)),
    recallAfterRerun: probe.summarize(queries.map((q) => (rerun(q) ? 1 : q.recall))),
    failures: queries.filter((q) => q.recall < FAILURE_RECALL).length,
    underReturned: queries.filter((q) => q.annCount < q.exactCount).length,
    reruns: queries.filter(rerun).length,
    annMs: probe.summarize(queries.map((q) => q.annMs)),
    effectiveMs: probe.summarize(queries.map((q) => q.annMs + (rerun(q) ? q.exactMs : 0))),
    gap: probe.summarize(queries.map((q) => q.gap)),
  };
}

export interface BenchStore { id: string; size: number; fraction: number }

export const OWNER = 'scale@bench.invalid';
export const QUERY_SOURCES = ['in', 'off'] as const;

async function runInTx(client: ClientBase, settings: string[], sql: string, params: unknown[]): Promise<{ ms: number; rows: any[] }> {
  await client.query('BEGIN READ ONLY');
  try {
    for (const s of settings) await client.query(s); // eslint-disable-line no-await-in-loop
    const started = process.hrtime.bigint();
    const { rows } = await client.query(sql, params);
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, rows };
  } finally {
    await client.query('ROLLBACK');
  }
}

const toRows = (rows: any[]): Row[] => rows.map((r) => ({ id: `${r.store_id}/${r.file_id}/${r.ord}`, score: Number(r.score) }));

/** Exact top-`limit` of every query, timed; written to fsscale_truth (the ANN runs compare with it). */
export async function measureExact(
  client: ClientBase, stores: BenchStore[], limit: number, log: (m: string) => void,
): Promise<Array<{ store: BenchStore; source: string; ms: Stat }>> {
  const sql = probe.buildArmSql({ ann: false, attribute: null });
  const settings = probe.exactSettings(limit);
  const out: Array<{ store: BenchStore; source: string; ms: Stat }> = [];
  await client.query('TRUNCATE fsscale_truth');
  /* eslint-disable no-await-in-loop */
  for (const store of stores) {
    for (const source of QUERY_SOURCES) {
      const { rows: queries } = await client.query(
        'SELECT qn, v::text AS v FROM fsscale_queries WHERE store_id = $1 AND source = $2 ORDER BY qn', [store.id, source]);
      await runInTx(client, settings, sql, [[store.id], OWNER, queries[0].v, limit]); // warm-up, not measured
      const times: number[] = [];
      for (const q of queries) {
        const r = await runInTx(client, settings, sql, [[store.id], OWNER, q.v, limit]);
        times.push(r.ms);
        const rows = toRows(r.rows);
        await client.query(
          'INSERT INTO fsscale_truth (store_id, source, qn, ids, scores, ms) VALUES ($1, $2, $3, $4, $5, $6)',
          [store.id, source, q.qn, rows.map((x) => x.id), rows.map((x) => x.score), r.ms]);
      }
      const ms = probe.summarize(times);
      out.push({ store, source, ms });
      log(`exact ${store.id} (${store.size}) ${source}: p50 ${ms.p50?.toFixed(1)} ms, p95 ${ms.p95?.toFixed(1)} ms`);
    }
  }
  /* eslint-enable no-await-in-loop */
  return out;
}

/**
 * Builds the configuration's index (any earlier one dropped), timed and sized. pgvector's NOTICEs are
 * kept: it reports when the graph outgrows maintenance_work_mem and the build continues on disk.
 */
export async function buildIndex(
  client: ClientBase, config: IndexConfig, dims: number, maintenanceWorkMem: string,
): Promise<{ buildMs: number; indexBytes: number; workers: number; notices: string[] }> {
  await client.query('DROP INDEX IF EXISTS idx_chunks_hnsw');
  await client.query(`SET maintenance_work_mem = '${maintenanceWorkMem}'`);
  const workers = config.parallel ? 2 : 0;
  await client.query(`SET max_parallel_maintenance_workers = ${workers}`);
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => { notices.push(String(n.message)); };
  client.on('notice', onNotice);
  const started = process.hrtime.bigint();
  try {
    await client.query(indexDdl(config, dims));
  } finally {
    client.removeListener('notice', onNotice);
  }
  const buildMs = Number(process.hrtime.bigint() - started) / 1e6;
  await client.query('RESET max_parallel_maintenance_workers');
  await client.query('RESET maintenance_work_mem');
  const { rows } = await client.query("SELECT pg_relation_size('idx_chunks_hnsw')::bigint AS b");
  return { buildMs, indexBytes: Number(rows[0].b), workers, notices };
}

export interface AnnResult { store: BenchStore; source: string; usesIndex: boolean; summary: AnnSummary }

/** The ANN path of every query against the truth. */
export async function measureAnn(
  client: ClientBase, stores: BenchStore[], config: IndexConfig, dims: number, limit: number, log: (m: string) => void,
): Promise<AnnResult[]> {
  const sql = probe.buildArmSql({ ann: true, attribute: null, halfvecDims: config.kind === 'halfvec' ? dims : null });
  const settings = probe.annSettings(limit);
  const out: AnnResult[] = [];
  /* eslint-disable no-await-in-loop */
  for (const store of stores) {
    for (const source of QUERY_SOURCES) {
      const { rows: queries } = await client.query(
        `SELECT q.qn, q.v::text AS v, t.ids, t.scores, t.ms FROM fsscale_queries q
           JOIN fsscale_truth t USING (store_id, source, qn)
          WHERE q.store_id = $1 AND q.source = $2 ORDER BY q.qn`, [store.id, source]);
      const params = (v: string) => [[store.id], OWNER, v, limit];
      const plan = await runInTx(client, settings, `EXPLAIN (FORMAT JSON) ${sql}`, params(queries[0].v));
      const usesIndex = probe.planUsesIndex(plan.rows[0]['QUERY PLAN'][0].Plan, 'idx_chunks_hnsw');
      await runInTx(client, settings, sql, params(queries[0].v)); // warm-up, not measured
      const results: AnnQuery[] = [];
      for (const q of queries) {
        const r = await runInTx(client, settings, sql, params(q.v));
        const exact: Row[] = q.ids.map((id: string, i: number) => ({ id, score: Number(q.scores[i]) }));
        const ann = toRows(r.rows);
        results.push({ recall: probe.tieAwareRecall(exact, ann), exactCount: exact.length, annCount: ann.length,
          exactMs: Number(q.ms), annMs: r.ms, gap: distanceGap(exact, ann) });
      }
      const summary = summarizeAnn(results, limit);
      out.push({ store, source, usesIndex, summary });
      log(`ann ${store.id} (${store.size}) ${source}: recall ${summary.recall.mean?.toFixed(3)} `
        + `(min ${summary.recall.min?.toFixed(3)}), under ${summary.underReturned}, re-runs ${summary.reruns}, `
        + `gap ${((summary.gap.mean ?? 0) * 100).toFixed(2)} %, p50 ${summary.annMs.p50?.toFixed(1)} ms, effective p95 ${summary.effectiveMs.p95?.toFixed(1)} ms`
        + `${usesIndex ? '' : ' — index NOT used'}`);
    }
  }
  /* eslint-enable no-await-in-loop */
  return out;
}

/** The exact path's latency as measured when the truth was written (a reused load skips re-measuring). */
export async function exactFromTruth(
  client: ClientBase, stores: BenchStore[], queries: number,
): Promise<Array<{ store: BenchStore; source: string; ms: Stat }> | null> {
  const out: Array<{ store: BenchStore; source: string; ms: Stat }> = [];
  for (const store of stores) {
    for (const source of QUERY_SOURCES) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await client.query('SELECT ms FROM fsscale_truth WHERE store_id = $1 AND source = $2',
        [store.id, source]);
      if (rows.length !== queries) return null;
      out.push({ store, source, ms: probe.summarize(rows.map((r) => Number(r.ms))) });
    }
  }
  return out;
}
