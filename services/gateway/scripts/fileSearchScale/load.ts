/**
 * Synthetic stores, loaded by generate_series in one table, every chunk index dropped during the load and
 * rebuilt after it (the HNSW index is built later, per configuration). The load is recorded in
 * `fsscale_meta`; a later --keep-db run with the same load spec reuses it.
 *
 * Vectors:
 * - clustered: g + c[a] + c[b]/2 + n[j] + n[k] from a pool of one shared direction g (N(0, 0.7²) per
 *   dimension), 256 centroids c (N(0, 1)) and 4096 noise vectors n (N(0, 0.6²)): chunks of one topic
 *   pair are at cosine ~0.7, of one shared main topic ~0.6, unrelated ~0.2 — clustered like real
 *   embeddings.
 *   Every store draws from every topic (the harder case for a store-filtered ANN scan).
 * - random: independent N(0, 1) per dimension — no structure, the worst case for HNSW.
 * Queries per store: `in` = fresh vectors of the same kind (never stored), `off` = random vectors
 * (off-topic for clustered stores). Besides the measured stores, `--tenants` filler stores of TENANT_CHUNKS
 * chunks give the table the store statistics of a many-store install.
 */
import type { ClientBase } from 'pg';
import { chunkTextSql } from './lexical';
import type { Options } from './options';
import { BenchStore, OWNER, QUERY_SOURCES } from './vectors';

const CENTROIDS = 256;
const NOISE = 4096;
const CHUNKS_PER_FILE = 50;
const BATCH = 20000;
export const INSERT_STORE = 'vs-insert';
/** Chunks of each filler (tenant) store. */
export const TENANT_CHUNKS = 100;
const LOAD_VERSION = 2;

export interface LoadSpec {
  version: number; dims: number; stores: number[]; vectors: string; words: number; queries: number; tenants: number;
}

export const loadSpec = (o: Options): LoadSpec => ({ version: LOAD_VERSION, dims: o.dims, stores: o.stores,
  vectors: o.vectors, words: o.words, queries: o.queries, tenants: o.tenants });

/** Whether a spec read back from jsonb (which reorders keys) is `spec`. */
export function sameSpec(stored: Record<string, unknown> | null, spec: LoadSpec): boolean {
  if (!stored) return false;
  const canonical = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  return canonical(stored) === canonical(spec as unknown as Record<string, unknown>);
}

export const benchStores = (sizes: number[], tenants: number): BenchStore[] => {
  const total = sizes.reduce((s, n) => s + n, 0) + tenants * TENANT_CHUNKS;
  return sizes.map((size, i) => ({ id: `vs-${i}`, size, fraction: size / total }));
};

const gaussianSql = (dims: number, stddev: number, rowRef: string) =>
  `(SELECT array_agg(random_normal(0, ${stddev}))::vector(${dims}) FROM generate_series(1, ${dims} + 0 * ${rowRef}))`;

/** The clustered generator's pool (`fsscale_pool`, in the current schema): the shared direction, the
 *  centroids, their halves and the noise vectors. */
export async function createVectorPool(client: ClientBase, dims: number): Promise<void> {
  await client.query(`CREATE TABLE fsscale_pool (kind text, id int, v vector(${dims}), PRIMARY KEY (kind, id))`);
  await client.query(`INSERT INTO fsscale_pool SELECT 'g', 0, ${gaussianSql(dims, 0.7, 's')} FROM generate_series(0, 0) s`);
  await client.query(`INSERT INTO fsscale_pool SELECT 'c', s, ${gaussianSql(dims, 1, 's')} FROM generate_series(0, ${CENTROIDS - 1}) s`);
  await client.query(`INSERT INTO fsscale_pool SELECT 'h', id, (SELECT array_agg(x / 2) FROM unnest(v::real[]) x)::vector
    FROM fsscale_pool WHERE kind = 'c'`);
  await client.query(`INSERT INTO fsscale_pool SELECT 'n', s, ${gaussianSql(dims, 0.6, 's')} FROM generate_series(0, ${NOISE - 1}) s`);
}

/** INSERT … SELECT of `count` rows numbered from `from`, as picks p(s, a, b, j, k), with vector `v`. */
export function vectorSelect(vectors: string, dims: number, from: number, count: number): { picks: string; joins: string; v: string } {
  const picks = `WITH p AS MATERIALIZED (
  SELECT s, floor(random() * ${CENTROIDS})::int AS a, floor(random() * ${CENTROIDS})::int AS b,
         floor(random() * ${NOISE})::int AS j, floor(random() * ${NOISE})::int AS k
    FROM generate_series(${from}, ${from + count - 1}) s)`;
  if (vectors === 'random') return { picks, joins: '', v: gaussianSql(dims, 1, 'p.s') };
  return {
    picks,
    joins: `JOIN fsscale_pool c ON c.kind = 'c' AND c.id = p.a
  JOIN fsscale_pool h ON h.kind = 'h' AND h.id = p.b
  JOIN fsscale_pool n1 ON n1.kind = 'n' AND n1.id = p.j
  JOIN fsscale_pool n2 ON n2.kind = 'n' AND n2.id = p.k
  JOIN fsscale_pool g ON g.kind = 'g'`,
    v: 'g.v + c.v + h.v + n1.v + n2.v',
  };
}

/** The filler stores t-0 .. t-(n-1), TENANT_CHUNKS chunks each, with their files. */
async function insertTenants(client: ClientBase, opts: Options): Promise<void> {
  if (opts.tenants === 0) return;
  const filesPerTenant = Math.ceil(TENANT_CHUNKS / CHUNKS_PER_FILE);
  const files = opts.tenants * filesPerTenant;
  await client.query(
    `INSERT INTO vector_stores (id, owner_email, name, embedding_model, embedding_dim)
     SELECT 't-' || n, $1, 'tenant', 'bench-model', $2 FROM generate_series(0, $3 - 1) n`,
    [OWNER, opts.dims, opts.tenants]);
  await client.query(
    `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
     SELECT 'ft-' || n, $1, 'tenant-' || n || '.txt', 'assistants', 'scale', 0 FROM generate_series(0, $2 - 1) n`,
    [OWNER, files]);
  await client.query(
    `INSERT INTO vector_store_files (store_id, file_id, status)
     SELECT 't-' || (n / ${filesPerTenant}), 'ft-' || n, 'completed' FROM generate_series(0, $1 - 1) n`, [files]);
  const total = opts.tenants * TENANT_CHUNKS;
  for (let from = 0; from < total; from += BATCH) {
    const s = vectorSelect(opts.vectors, opts.dims, from, Math.min(BATCH, total - from));
    // eslint-disable-next-line no-await-in-loop
    await client.query(`${s.picks}
INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
SELECT 't-' || (p.s / ${TENANT_CHUNKS}), 'ft-' || (p.s / ${CHUNKS_PER_FILE}), p.s % ${CHUNKS_PER_FILE},
       ${chunkTextSql(opts.words, 'p.s')}, ${opts.words}, ${s.v}
  FROM p
  ${s.joins}`);
  }
}

/** Inserts `count` chunks into `storeId` (ords from `from`), in one statement. */
export function chunkInsertSql(storeId: string, storeIndex: string, vectors: string, dims: number, words: number,
  from: number, count: number): string {
  const s = vectorSelect(vectors, dims, from, count);
  return `${s.picks}
INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
SELECT '${storeId}', 'f-${storeIndex}-' || (p.s / ${CHUNKS_PER_FILE}), p.s % ${CHUNKS_PER_FILE},
       ${chunkTextSql(words, 'p.s')}, ${words}, ${s.v}
  FROM p
  ${s.joins}`;
}

export async function insertFiles(client: ClientBase, storeId: string, storeIndex: string, chunks: number): Promise<void> {
  const files = Math.ceil(chunks / CHUNKS_PER_FILE);
  await client.query(
    `INSERT INTO vector_stores (id, owner_email, name, embedding_model, embedding_dim)
     VALUES ($1, $2, $3, 'bench-model', (SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'vector_store_chunks'::regclass AND attname = 'embedding'))`,
    [storeId, OWNER, `${chunks} chunks`]);
  await client.query(
    `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
     SELECT 'f-${storeIndex}-' || n, $1, 'file-' || n || '.txt', 'assistants', 'scale', 0 FROM generate_series(0, $2 - 1) n`,
    [OWNER, files]);
  await client.query(
    `INSERT INTO vector_store_files (store_id, file_id, status)
     SELECT $1, 'f-${storeIndex}-' || n, 'completed' FROM generate_series(0, $2 - 1) n`, [storeId, files]);
}

async function readMeta(client: ClientBase): Promise<{ spec: LoadSpec; summary: any } | null> {
  const { rows } = await client.query("SELECT to_regclass('fsscale_meta') IS NOT NULL AS present");
  if (!rows[0].present) return null;
  const meta = await client.query('SELECT spec, summary FROM fsscale_meta');
  return meta.rows[0] ?? null;
}

export interface LoadSummary {
  reused: boolean;
  loadMs: number;
  chunks: number;
  tableBytes: number;
  postgres: string;
  pgvector: string;
}

/**
 * Loads the spec's stores unless they are already there. `migrate` applies the file_search schema to the
 * (just recreated, empty) `fsscale` schema.
 */
export async function ensureLoaded(
  client: ClientBase, opts: Options, migrate: () => Promise<boolean>, log: (m: string) => void,
): Promise<LoadSummary> {
  const spec = loadSpec(opts);
  const meta = await readMeta(client);
  if (meta && sameSpec(meta.spec as unknown as Record<string, unknown>, spec)) {
    log('reusing the loaded stores (same load spec)');
    return { ...meta.summary, reused: true };
  }
  const started = Date.now();
  await client.query('DROP SCHEMA IF EXISTS fsscale CASCADE');
  await client.query('CREATE SCHEMA fsscale');
  if (!(await migrate())) throw new Error('the file_search schema migration did not apply');
  const { rows: idx } = await client.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'fsscale' AND tablename = 'vector_store_chunks'
        AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid = 'vector_store_chunks'::regclass)`);
  for (const { indexname } of idx) await client.query(`DROP INDEX ${indexname}`); // eslint-disable-line no-await-in-loop

  await createVectorPool(client, opts.dims);
  await client.query(`INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ('scale', 0, 'db')`);

  const stores = benchStores(opts.stores, opts.tenants);
  /* eslint-disable no-await-in-loop */
  for (const [i, store] of stores.entries()) {
    await insertFiles(client, store.id, String(i), store.size);
    for (let from = 0; from < store.size; from += BATCH) {
      await client.query(chunkInsertSql(store.id, String(i), opts.vectors, opts.dims, opts.words, from,
        Math.min(BATCH, store.size - from)));
    }
    log(`loaded ${store.id}: ${store.size} chunks (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
  await insertTenants(client, opts);
  log(`loaded ${opts.tenants} tenant stores of ${TENANT_CHUNKS} chunks`);
  await insertFiles(client, INSERT_STORE, 'ins', Math.max(opts.insert, 1));
  for (const { indexname, indexdef } of idx) {
    if (indexname !== 'idx_chunks_hnsw') await client.query(indexdef);
  }
  /* eslint-enable no-await-in-loop */
  await client.query('ANALYZE');

  await client.query(`CREATE TABLE fsscale_queries (store_id text, source text, qn int, v vector(${opts.dims}),
    PRIMARY KEY (store_id, source, qn))`);
  for (const store of stores) {
    for (const source of QUERY_SOURCES) {
      const s = vectorSelect(source === 'in' ? opts.vectors : 'random', opts.dims, 0, opts.queries);
      // eslint-disable-next-line no-await-in-loop
      await client.query(`${s.picks}
INSERT INTO fsscale_queries SELECT '${store.id}', '${source}', p.s, ${s.v} FROM p ${s.joins}`);
    }
  }
  await client.query(`CREATE TABLE fsscale_truth (store_id text, source text, qn int, ids text[], scores float8[],
    ms float8, PRIMARY KEY (store_id, source, qn))`);

  const { rows: [sizes] } = await client.query(
    `SELECT (SELECT count(*) FROM vector_store_chunks)::bigint AS chunks,
            pg_total_relation_size('vector_store_chunks')::bigint AS bytes,
            current_setting('server_version') AS postgres,
            (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector`);
  const summary: LoadSummary = { reused: false, loadMs: Date.now() - started, chunks: Number(sizes.chunks),
    tableBytes: Number(sizes.bytes), postgres: sizes.postgres, pgvector: sizes.pgvector };
  await client.query('CREATE TABLE fsscale_meta (spec jsonb, summary jsonb)');
  await client.query('INSERT INTO fsscale_meta VALUES ($1, $2)', [JSON.stringify(spec), JSON.stringify(summary)]);
  log(`load done: ${summary.chunks} chunks, ${(summary.tableBytes / 2 ** 30).toFixed(2)} GiB with indexes, `
    + `${(summary.loadMs / 1000).toFixed(0)} s`);
  return summary;
}

/**
 * The cost of ingesting `count` chunks into the insert store, in statements of 100 rows (as ingestion
 * batches them), with whatever HNSW index exists. The rows are deleted and the table vacuumed after.
 */
export async function measureInsert(client: ClientBase, opts: Options): Promise<{ count: number; ms: number; msPer1000: number }> {
  const started = process.hrtime.bigint();
  for (let from = 0; from < opts.insert; from += 100) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(chunkInsertSql(INSERT_STORE, 'ins', opts.vectors, opts.dims, opts.words, from,
      Math.min(100, opts.insert - from)));
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { count: opts.insert, ms, msPer1000: (ms / opts.insert) * 1000 };
}

/** Removes the insert store's chunks; the vacuum runs without the HNSW index (cheap). */
export async function clearInserted(client: ClientBase): Promise<void> {
  await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1', [INSERT_STORE]);
  await client.query('DROP INDEX IF EXISTS idx_chunks_hnsw');
  await client.query('VACUUM vector_store_chunks');
}
