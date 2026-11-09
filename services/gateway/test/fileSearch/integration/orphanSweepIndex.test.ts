// The orphan sweep finds stale generations by index (plan 2026-10-07, B1 Task 2).
//
// dropOrphanedGenerations used to read the whole chunk primary key to list the
// (store, generation) pairs it might delete: 80 ms warm / 305 ms cold per 1M
// chunks in the 2026-10-06 spike. It now walks idx_chunks_store_gen per store —
// one probe per generation the store holds, plus one that finds none — so its
// cost follows the number of stores, not the number of chunks. The same index
// serves the re-embed generation DELETEs.
//
// Here: the candidates and the deletion are right (below and above the active
// generation, protected generations interleaved), and the plans read only
// idx_chunks_store_gen — never the primary key, never the heap.
import { Pool } from 'pg';
import { getPool, __resetForTests } from '../../../src/fileSearch/db';
import { dropOrphanedGenerations, ORPHANED_GENERATIONS_SQL } from '../../../src/fileSearch/jobSweeper';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'orphan-owner@example.test';
const STORES = 60;
const FILES = 10;
const CHUNKS = 50; // 60 stores x 500 chunks = 30,000 chunks in generation 0

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function nodes(plan: any, out: any[] = []): any[] {
  out.push(plan);
  for (const child of plan.Plans ?? []) nodes(child, out);
  return out;
}

const chunkScans = (plan: any) => nodes(plan).filter((n) => n['Relation Name'] === 'vector_store_chunks'
  || (n['Index Name'] ?? '').startsWith('idx_chunks') || (n['Index Name'] ?? '').startsWith('vector_store_chunks'));

d('orphan sweep on (store_id, generation) (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  /** Copies generation 0 of `storeId` into each of `generations`. */
  async function addGenerations(storeId: string, generations: number[]): Promise<void> {
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding)
       SELECT c.store_id, c.file_id, g, c.ord, c.text, c.tokens, c.embedding
         FROM vector_store_chunks c, unnest($2::int[]) AS g
        WHERE c.store_id = $1 AND c.generation = 0`, [storeId, generations]);
  }

  async function reembedJob(id: string, storeId: string, generation: number, opts: { cancelled?: boolean; finished?: boolean }) {
    await pool.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, store_id, target_model, target_dim, target_generation,
                            cancel_requested, finished_at)
       VALUES ($1, 'reembed_store', $2, $3, 'model-b', ${EMBED_DIM}, $4, $5, CASE WHEN $6 THEN now() END)`,
      [id, OWNER, storeId, generation, opts.cancelled ?? false, opts.finished ?? false]);
  }

  async function generations(storeId: string): Promise<Array<{ generation: number; n: number }>> {
    const { rows } = await pool.query(
      `SELECT generation, count(*)::int AS n FROM vector_store_chunks WHERE store_id = $1
        GROUP BY generation ORDER BY generation`, [storeId]);
    return rows;
  }

  beforeAll(async () => {
    mockConfig = { enabled: true, embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM };
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    pool = getPool()!;
    await pool.query('DROP INDEX idx_chunks_hnsw'); // not under test; makes the load fast
    await pool.query(
      `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim)
       SELECT 'vs-' || lpad(s::text, 3, '0'), $2, 'model-a', ${EMBED_DIM} FROM generate_series(0, $1 - 1) s`,
      [STORES, OWNER]);
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
       SELECT 'vs-' || lpad(s::text, 3, '0'), 'file-' || f, o, 'chunk ' || o, 2, '[1,0,0]'
         FROM generate_series(0, $1 - 1) s, generate_series(0, $2 - 1) f, generate_series(0, $3 - 1) o`,
      [STORES, FILES, CHUNKS]);
  }, 120_000);

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  // Each test reseeds its stores' extra generations and jobs.
  beforeEach(async () => {
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM vector_store_chunks WHERE generation <> 0');
    await pool.query('UPDATE vector_stores SET active_generation = 0');
    // vs-001: re-embedded twice. Active 2; generation 1 kept for a failed job's
    // Retry (protected), 0 below it and 3 above it orphaned, 4 being written
    // by a running job (protected).
    await pool.query(`UPDATE vector_stores SET active_generation = 2 WHERE id = 'vs-001'`);
    await addGenerations('vs-001', [1, 2, 3, 4]);
    await reembedJob('job_failed', 'vs-001', 1, { finished: true });
    await reembedJob('job_running', 'vs-001', 4, {});
    // vs-002: active 0; generation 5 targeted only by a cancelled job — orphaned.
    await addGenerations('vs-002', [5]);
    await reembedJob('job_cancelled', 'vs-002', 5, { cancelled: true, finished: true });
    // vs-003: active 7 and nothing else; its generation-0 rows are orphaned
    // while generation 7 stays.
    await pool.query(`UPDATE vector_stores SET active_generation = 7 WHERE id = 'vs-003'`);
    await addGenerations('vs-003', [7]);
    await pool.query('ANALYZE vector_store_chunks');
    await pool.query('ANALYZE vector_stores');
    await pool.query('ANALYZE fs_jobs');
  });

  it('lists exactly the unread generations, below and above the active one, past protected ones', async () => {
    const { rows } = await pool.query(ORPHANED_GENERATIONS_SQL);
    expect(rows).toEqual([
      { store_id: 'vs-001', generation: 0 },
      { store_id: 'vs-001', generation: 3 },
      { store_id: 'vs-002', generation: 5 },
      { store_id: 'vs-003', generation: 0 },
    ]);
  });

  it('deletes them all in batches, and keeps the active and the protected generations', async () => {
    const perStore = FILES * CHUNKS;
    expect(await dropOrphanedGenerations(200)).toBe(4 * perStore);
    expect(await generations('vs-001')).toEqual([
      { generation: 1, n: perStore }, { generation: 2, n: perStore }, { generation: 4, n: perStore }]);
    expect(await generations('vs-002')).toEqual([{ generation: 0, n: perStore }]);
    expect(await generations('vs-003')).toEqual([{ generation: 7, n: perStore }]);
    expect(await generations('vs-000')).toEqual([{ generation: 0, n: perStore }]);
    expect(await dropOrphanedGenerations(200)).toBe(0);
  });

  it('finds the candidates by index probes on idx_chunks_store_gen alone: no scan of the primary key or the heap', async () => {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${ORPHANED_GENERATIONS_SQL}`);
    const plan = rows[0]['QUERY PLAN'][0].Plan;
    const scans = chunkScans(plan);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect({ type: scan['Node Type'], index: scan['Index Name'] })
        .toEqual({ type: 'Index Only Scan', index: 'idx_chunks_store_gen' });
    }
    // Every probe stops at its first entry: a few rows per store, never a store's chunks.
    const read = scans.reduce((sum, s) => sum + s['Actual Rows'] * s['Actual Loops'], 0);
    expect(read).toBeLessThan(STORES * 4);
  });

  // The batch DELETE of the sweep and the re-embed DELETEs of a whole generation
  // (reembed.ts cancel/start, reembedWorker.ts expiry/switch), as they are sent.
  it.each([
    ['the sweep batch', `DELETE FROM vector_store_chunks WHERE (store_id, file_id, generation, ord) IN (
       SELECT store_id, file_id, generation, ord FROM vector_store_chunks
        WHERE store_id = $1 AND generation = $2 LIMIT $3)`, ['vs-001', 3, 5000]],
    ['a cancelled or expired re-embed (generation = $2)',
      'DELETE FROM vector_store_chunks WHERE store_id = $1 AND generation = $2', ['vs-001', 3]],
  ])('%s deletes through idx_chunks_store_gen', async (_label, sql, params) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      const scans = nodes(rows[0]['QUERY PLAN'][0].Plan).filter((n) => n['Relation Name'] === 'vector_store_chunks'
        && n['Node Type'] !== 'ModifyTable');
      const generationScans = scans.filter((n) => n['Index Name'] === 'idx_chunks_store_gen'
        || (n['Node Type'] === 'Bitmap Heap Scan' && nodes(n).some((c) => c['Index Name'] === 'idx_chunks_store_gen')));
      expect(generationScans.length).toBeGreaterThan(0);
      expect(scans.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('a start or a switch (generation <> $2) reads only the store, by index', async () => {
    const { rows } = await pool.query(
      'EXPLAIN (FORMAT JSON) DELETE FROM vector_store_chunks WHERE store_id = $1 AND generation <> $2', ['vs-001', 2]);
    const scans = nodes(rows[0]['QUERY PLAN'][0].Plan).filter((n) => n['Relation Name'] === 'vector_store_chunks'
      && n['Node Type'] !== 'ModifyTable');
    expect(scans.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual([]);
    expect(scans.length).toBeGreaterThan(0);
  });
});
