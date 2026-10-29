#!/usr/bin/env node

/**
 * file_search recall probe — read-only, against any file_search database.
 *
 * Measures what an approximate (HNSW) recall path would cost in recall before
 * it is switched on (plan docs/superpowers/plans/2026-10-07-file-search-recall-cost-plan.md,
 * Task 4 / Decision 2). For each probed store it takes stored chunk embeddings
 * as query vectors — no text and no embedding calls — and runs two searches per
 * query, both shaped like recall's vector arm (recallSql.ts `buildArm`):
 *
 *   exact  today's path: chunks-only inner query ordered by distance plus the
 *          tiebreaker (an exact, bounded top-N), `jit = off`, today's
 *          `hnsw.ef_search` / `strict_order` settings. Its rows are the truth.
 *   ann    the B2 candidate: the same predicates, ordered by distance alone so
 *          `idx_chunks_hnsw` can serve it, forced with
 *          `enable_sort/seqscan/bitmapscan = off`, `hnsw.ef_search` =
 *          clamp(4 x limit, 200, 1000), `hnsw.iterative_scan = relaxed_order`;
 *          the outer query re-sorts.
 *
 * Recall@limit is tie-aware: an ANN row counts when its distance is within the
 * exact path's last distance, so chunks at equal distance (duplicate text) are
 * not counted as misses. "Under-returned" means ANN came back with fewer rows
 * than the exact path.
 *
 * Read-only: every statement runs in a READ ONLY transaction that is rolled
 * back; the session also sets default_transaction_read_only. Nothing is
 * written, no index is built.
 *
 * Usage:
 *   node cli-tools/file-search-recall-probe.js [--dsn <url>] [options]
 *     --dsn <url>          default: FILE_SEARCH_DATABASE_URL, then POSTGRES_URL
 *     --stores a,b         store ids to probe (default: every store with chunks)
 *     --min-chunks <n>     only stores with at least n active chunks (default 1)
 *     --queries <n>        query vectors per store (default 20)
 *     --limit <n>          top-N compared (default 50, recall's candidate count)
 *     --source self|other  query vectors from the store itself, or from other
 *                          stores (off-topic queries; default self)
 *     --attribute k=v      add an attribute filter (vsf.attributes ->> k = v)
 *     --seed <s>           sampling seed (default "probe")
 *     --halfvec            the ANN path orders by `embedding::halfvec(N)`, the
 *                          expression a halfvec HNSW index is built on
 *                          (`(embedding::halfvec(N)) halfvec_cosine_ops`); its
 *                          candidates keep the full-precision distance as the
 *                          score. N is read from the embedding column.
 *                          Without the flag the probe reads idx_chunks_hnsw
 *                          and orders by halfvec(N) when it is that kind (the
 *                          only kind the gateway's approximate search serves).
 *     --no-halfvec         the ANN path orders by the full-precision vector
 *     --json               print the results as JSON
 *
 * Exit code: 0 on success, 1 on a usage or database error. The DSN is never
 * printed.
 */

const path = require('path');
const { createRequire } = require('module');

const projectRoot = path.resolve(__dirname, '..');
// `pg` is a gateway dependency, not a root one.
const gatewayRequire = createRequire(path.join(projectRoot, 'services/gateway/package.json'));

const DEFAULTS = { queries: 20, limit: 50, minChunks: 1, source: 'self', seed: 'probe' };
const FAILURE_RECALL = 0.5;

function parseArgs(argv) {
  // halfvec: null detects from the index, true/false force it.
  const opts = { ...DEFAULTS, stores: null, attribute: null, json: false, dsn: null, halfvec: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    const positiveInt = (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${arg} must be a positive integer, got ${value}`);
      return n;
    };
    switch (arg) {
      case '--dsn': opts.dsn = next(); break;
      case '--stores': opts.stores = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--min-chunks': opts.minChunks = positiveInt(next()); break;
      case '--queries': opts.queries = positiveInt(next()); break;
      case '--limit': opts.limit = positiveInt(next()); break;
      case '--source': {
        const v = next();
        if (v !== 'self' && v !== 'other') throw new Error(`--source must be self or other, got ${v}`);
        opts.source = v;
        break;
      }
      case '--attribute': {
        const v = next();
        const eq = v.indexOf('=');
        if (eq < 1) throw new Error(`--attribute must be key=value, got ${v}`);
        opts.attribute = { key: v.slice(0, eq), value: v.slice(eq + 1) };
        break;
      }
      case '--seed': opts.seed = next(); break;
      case '--json': opts.json = true; break;
      case '--halfvec': opts.halfvec = true; break;
      case '--no-halfvec': opts.halfvec = false; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

// A copy of the gateway's HALFVEC_COSINE (services/gateway/src/fileSearch/vectorIndex.ts): this script loads only
// `pg`. test/file-search-recall-probe.test.ts checks both read the same definitions alike.
const QUALIFIER = String.raw`(?:"?[\w$]+"?\.)?`;
const HALFVEC_COSINE = new RegExp(
  String.raw`USING hnsw \(\(\(embedding\)::${QUALIFIER}halfvec\((\d+)\)\) ${QUALIFIER}halfvec_cosine_ops\)`);

/** The width N of a halfvec cosine HNSW index definition (pg_get_indexdef), or null for any other index. */
function detectHalfvecDims(definition) {
  const match = definition ? HALFVEC_COSINE.exec(definition) : null;
  return match ? Number(match[1]) : null;
}

/**
 * The halfvec width the ANN path orders by, or null for the full-precision vector, and how it was chosen:
 * `halfvec` true reads the column's width, false nothing, null (the default) the definition of idx_chunks_hnsw.
 * An INVALID idx_chunks_hnsw (a failed concurrent build) is not used, as in the gateway (annPath.ts): the planner
 * ignores it, so the run measures an exact scan and says so.
 */
async function resolveHalfvecDims(client, halfvec) {
  if (halfvec === false) return { dims: null, how: '--no-halfvec' };
  if (halfvec === true) {
    // For a vector(N) column the type modifier is N.
    const { rows: [{ dims }] } = await client.query(
      `SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid = 'vector_store_chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`);
    return { dims: Number(dims), how: '--halfvec' };
  }
  const { rows } = await client.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = to_regclass('vector_store_chunks') AND ic.relname = 'idx_chunks_hnsw'`);
  if (rows[0] && !rows[0].valid) return { dims: null, how: 'invalid' };
  const dims = detectHalfvecDims(rows[0]?.definition);
  return { dims, how: dims === null ? 'not detected' : 'detected' };
}

function annOrderLabel({ dims, how }) {
  if (dims !== null) return `ANN ordered by halfvec(${dims}) (${how === 'detected' ? 'detected from idx_chunks_hnsw' : how})`;
  if (how === 'invalid') {
    return 'ANN ordered by vector (idx_chunks_hnsw is INVALID: the planner ignores it, so the ann figures are an exact '
      + 'scan, not ANN recall; run rebuild-index)';
  }
  return `ANN ordered by vector (${how === 'not detected' ? 'idx_chunks_hnsw is not the halfvec kind' : how})`;
}

/** Today's recall setting (recallSettings.ts recallEfSearch). */
function exactEfSearch(limit) {
  return Math.min(Math.max(limit * 2, 100), 1000);
}

/** The B2 ANN setting (Decision 2): clamp(4 x limit, 200, 1000). */
function annEfSearch(limit) {
  return Math.min(Math.max(limit * 4, 200), 1000);
}

function exactSettings(limit) {
  return ['SET LOCAL jit = off', `SET LOCAL hnsw.ef_search = ${exactEfSearch(limit)}`,
    "SET LOCAL hnsw.iterative_scan = 'strict_order'"];
}

function annSettings(limit) {
  return ['SET LOCAL jit = off', 'SET LOCAL enable_sort = off', 'SET LOCAL enable_seqscan = off',
    'SET LOCAL enable_bitmapscan = off', `SET LOCAL hnsw.ef_search = ${annEfSearch(limit)}`,
    "SET LOCAL hnsw.iterative_scan = 'relaxed_order'"];
}

/**
 * The query vectors: a seeded, repeatable sample of stored embeddings ($1 store, $2 its active
 * generation, $3 seed, $4 count) — of the store itself or of other stores. Chunks without a
 * vector are never sampled.
 */
function buildSampleSql(source) {
  return `SELECT c.embedding::text AS v
         FROM (SELECT s.store_id, s.file_id, s.generation, s.ord FROM vector_store_chunks s
                WHERE s.embedding IS NOT NULL AND ${source === 'self' ? 's.store_id = $1 AND s.generation = $2'
    : 's.store_id <> $1 AND $2::int IS NOT NULL'}
                ORDER BY md5(s.store_id || s.file_id || s.ord::text || $3) LIMIT $4) pick
         JOIN vector_store_chunks c USING (store_id, file_id, generation, ord)`;
}

/**
 * Recall's vector arm (chunks without a vector — whitespace-only structured chunks — are
 * never candidates, as in recall). $1 store ids, $2 owner, $3 query vector, $4 limit,
 * $5/$6 the optional attribute key/value. `ann` drops the tiebreaker from the
 * inner ORDER BY (the only shape HNSW can serve) and materializes the inner
 * query so the outer re-sort cannot be pushed into it. With `halfvecDims` the
 * ANN inner query orders by the halfvec expression (the one a halfvec index
 * serves) while its score stays the full-precision distance, so the outer
 * query re-sorts the candidates exactly; the exact path is unchanged.
 */
function buildArmSql({ ann, attribute, halfvecDims = null }) {
  if (halfvecDims !== null && (!Number.isInteger(halfvecDims) || halfvecDims < 1)) {
    throw new Error(`halfvec width must be a positive integer, got ${halfvecDims}`);
  }
  const stores = `FROM vector_stores vs
          WHERE vs.id = ANY($1)
            AND (vs.owner_email = $2 OR vs.is_shared = true)`;
  const filter = attribute ? '\n            AND vsf.attributes ->> $5 = $6' : '';
  const annOrder = ann && halfvecDims !== null
    ? `c.embedding::halfvec(${halfvecDims}) <=> $3::halfvec(${halfvecDims})` : 'c.embedding <=> $3::vector';
  const order = ann ? annOrder : 'c.embedding <=> $3::vector, c.store_id, c.file_id, c.ord';
  return `
WITH k AS ${ann ? 'MATERIALIZED ' : ''}(
    SELECT c.store_id, c.file_id, c.ord, c.embedding <=> $3::vector AS score
    FROM vector_store_chunks c
    WHERE c.store_id = ANY($1)
      AND c.store_id = ANY(ARRAY(
          SELECT vs.id ${stores}))
      AND (c.store_id || ':' || c.generation) = ANY(ARRAY(
          SELECT vs.id || ':' || vs.active_generation ${stores}))
      AND EXISTS (
          SELECT 1 FROM vector_store_files vsf
          WHERE vsf.store_id = c.store_id AND vsf.file_id = c.file_id${filter})
      AND c.embedding IS NOT NULL
    ORDER BY ${order}
    LIMIT $4
)
SELECT k.store_id, k.file_id, k.ord, f.filename,
       ROW_NUMBER() OVER (ORDER BY k.score, k.store_id, k.file_id, k.ord) AS rnk,
       k.score
  FROM k
  JOIN vector_store_files vsf ON vsf.store_id = k.store_id AND vsf.file_id = k.file_id
  JOIN fs_files f ON f.id = k.file_id
 ORDER BY rnk`;
}

/**
 * Tie-aware recall of `annRows` against `exactRows` (both [{id, score}]).
 * The truth is the exact top-N; an ANN row is a hit when its distance is not
 * worse than the exact path's last distance (plus `epsilon`), so a chunk tied
 * with the cut-off counts. Returns 1 when the exact path returned nothing.
 */
function tieAwareRecall(exactRows, annRows, epsilon = 1e-6) {
  if (exactRows.length === 0) return 1;
  const cutoff = exactRows[exactRows.length - 1].score + epsilon;
  const seen = new Set();
  let hits = 0;
  for (const row of annRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.score <= cutoff) hits += 1;
  }
  return Math.min(1, hits / exactRows.length);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(values) {
  if (values.length === 0) return { n: 0, mean: null, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

/** Aggregates one store's per-query results. */
function summarizeStore(store, queries) {
  const recalls = queries.map((q) => q.recall);
  return {
    storeId: store.id,
    name: store.name,
    chunks: store.chunks,
    tableFraction: store.tableFraction,
    queries: queries.length,
    recall: summarize(recalls),
    failures: recalls.filter((r) => r < FAILURE_RECALL).length,
    underReturned: queries.filter((q) => q.annCount < q.exactCount).length,
    exactMs: summarize(queries.map((q) => q.exactMs)),
    annMs: summarize(queries.map((q) => q.annMs)),
    annUsesHnsw: queries.length ? queries[0].annUsesHnsw : null,
    exactUsesHnsw: queries.length ? queries[0].exactUsesHnsw : null,
  };
}

function planUsesIndex(plan, indexName) {
  if (!plan || typeof plan !== 'object') return false;
  if (plan['Index Name'] === indexName) return true;
  return (plan.Plans || []).some((child) => planUsesIndex(child, indexName));
}

function fmt(v, digits = 2) {
  return v === null || v === undefined ? '-' : Number(v).toFixed(digits);
}

function formatTable(rows) {
  const header = ['store', 'chunks', 'table%', 'recall mean', 'min', 'fail<0.5', 'under', 'exact p50/p95 ms',
    'ann p50/p95 ms', 'ann hnsw'];
  const lines = rows.map((r) => [
    (r.name || r.storeId).slice(0, 28), String(r.chunks), fmt(r.tableFraction * 100, 3),
    fmt(r.recall.mean, 3), fmt(r.recall.min, 3), `${r.failures}/${r.queries}`, `${r.underReturned}/${r.queries}`,
    `${fmt(r.exactMs.p50, 1)}/${fmt(r.exactMs.p95, 1)}`, `${fmt(r.annMs.p50, 1)}/${fmt(r.annMs.p95, 1)}`,
    r.annUsesHnsw ? 'yes' : 'NO',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const row = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [row(header), row(widths.map((w) => '-'.repeat(w))), ...lines.map(row)].join('\n');
}

async function inReadOnlyTx(client, settings, fn) {
  await client.query('BEGIN READ ONLY');
  try {
    for (const s of settings) await client.query(s); // eslint-disable-line no-await-in-loop
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function runArm(client, sql, settings, params) {
  return inReadOnlyTx(client, settings, async () => {
    const started = process.hrtime.bigint();
    const { rows } = await client.query(sql, params);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      ms,
      rows: rows.map((r) => ({ id: `${r.store_id}/${r.file_id}/${r.ord}`, score: Number(r.score) })),
    };
  });
}

async function explainUses(client, sql, settings, params, indexName) {
  return inReadOnlyTx(client, settings, async () => {
    const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return planUsesIndex(rows[0]['QUERY PLAN'][0].Plan, indexName);
  });
}

async function probe(client, opts) {
  await client.query('SET default_transaction_read_only = on');
  const { rows: [{ total }] } = await client.query(
    `SELECT count(*)::bigint AS total FROM vector_store_chunks c JOIN vector_stores vs ON vs.id = c.store_id
      WHERE c.generation = vs.active_generation`);
  const tableTotal = Number(total);
  const { rows: storeRows } = await client.query(
    `SELECT vs.id, vs.name, vs.owner_email, vs.active_generation, count(c.*)::bigint AS chunks
       FROM vector_stores vs
       JOIN vector_store_chunks c ON c.store_id = vs.id AND c.generation = vs.active_generation
      WHERE ($1::text[] IS NULL OR vs.id = ANY($1))
      GROUP BY vs.id
     HAVING count(c.*) >= $2
      ORDER BY count(c.*) DESC, vs.id`,
    [opts.stores, opts.minChunks]);

  const annOrder = await resolveHalfvecDims(client, opts.halfvec);
  const halfvecDims = annOrder.dims;
  const exactSql = buildArmSql({ ann: false, attribute: opts.attribute });
  const annSql = buildArmSql({ ann: true, attribute: opts.attribute, halfvecDims });
  const results = [];
  for (const s of storeRows) {
    const store = { id: s.id, name: s.name, chunks: Number(s.chunks), tableFraction: Number(s.chunks) / tableTotal };
    // Query vectors: a seeded, repeatable sample of stored embeddings.
    // eslint-disable-next-line no-await-in-loop
    const { rows: qRows } = await client.query(
      buildSampleSql(opts.source),
      [s.id, s.active_generation, opts.seed, opts.queries]);
    const baseParams = (v) => {
      const p = [[s.id], s.owner_email, v, opts.limit];
      if (opts.attribute) p.push(opts.attribute.key, opts.attribute.value);
      return p;
    };
    const queries = [];
    if (qRows.length > 0) {
      const p0 = baseParams(qRows[0].v);
      /* eslint-disable no-await-in-loop */
      const annUsesHnsw = await explainUses(client, annSql, annSettings(opts.limit), p0, 'idx_chunks_hnsw');
      const exactUsesHnsw = await explainUses(client, exactSql, exactSettings(opts.limit), p0, 'idx_chunks_hnsw');
      // Warm-up, not measured.
      await runArm(client, exactSql, exactSettings(opts.limit), p0);
      await runArm(client, annSql, annSettings(opts.limit), p0);
      for (const { v } of qRows) {
        const params = baseParams(v);
        const exact = await runArm(client, exactSql, exactSettings(opts.limit), params);
        const ann = await runArm(client, annSql, annSettings(opts.limit), params);
        queries.push({
          recall: tieAwareRecall(exact.rows, ann.rows),
          exactCount: exact.rows.length,
          annCount: ann.rows.length,
          exactMs: exact.ms,
          annMs: ann.ms,
          annUsesHnsw,
          exactUsesHnsw,
        });
      }
      /* eslint-enable no-await-in-loop */
    }
    results.push(summarizeStore(store, queries));
  }
  return { tableTotal, options: { ...opts, dsn: undefined }, annOrder, stores: results };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`file-search-recall-probe: ${error.message}`);
    process.exit(1);
  }
  if (opts.help) {
    console.log('Usage: node cli-tools/file-search-recall-probe.js [--dsn <url>] [--stores a,b] [--min-chunks n]'
      + ' [--queries n] [--limit n] [--source self|other] [--attribute k=v] [--seed s] [--halfvec | --no-halfvec] [--json]');
    return;
  }
  const dsn = opts.dsn || process.env.FILE_SEARCH_DATABASE_URL || process.env.POSTGRES_URL;
  if (!dsn) {
    console.error('file-search-recall-probe: no database — pass --dsn or set FILE_SEARCH_DATABASE_URL');
    process.exit(1);
  }
  const { Client } = gatewayRequire('pg');
  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    const result = await probe(client, opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`chunks in table (active generations): ${result.tableTotal}; limit ${opts.limit}; `
        + `${opts.queries} queries/store from ${opts.source}${opts.attribute ? `; filter ${opts.attribute.key}` : ''}`
        + `; ${annOrderLabel(result.annOrder)}`);
      console.log(formatTable(result.stores));
      const all = result.stores.filter((s) => s.queries > 0);
      const failures = all.reduce((n, s) => n + s.failures, 0);
      const under = all.reduce((n, s) => n + s.underReturned, 0);
      const total = all.reduce((n, s) => n + s.queries, 0);
      console.log(`\n${all.length} stores, ${total} queries: ${failures} failures (<${FAILURE_RECALL}), `
        + `${under} under-returned`);
    }
  } catch (error) {
    // The driver's message can quote input; the code is enough to diagnose.
    console.error(`file-search-recall-probe: database error ${error.code || error.name}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  parseArgs,
  buildSampleSql,
  exactEfSearch,
  annEfSearch,
  exactSettings,
  annSettings,
  buildArmSql,
  detectHalfvecDims,
  resolveHalfvecDims,
  annOrderLabel,
  tieAwareRecall,
  summarize,
  summarizeStore,
  planUsesIndex,
  formatTable,
};

if (require.main === module) {
  main();
}
