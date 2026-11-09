// Chunk generations against a real pgvector database: every reader of chunk
// content (both recall arms, the content endpoint) sees only the store's
// active generation; commitChunks writes and deletes only the generations it
// reads under the store lock; deleting a file or a store removes every generation; and recall runs
// in a transaction carrying its pgvector settings, returning the full
// candidate count from a store that shares the HNSW index with many others.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { recallCandidates, recallEfSearch } from '../../../src/fileSearch/repository';
import * as repo from '../../../src/fileSearch/repository';
import { __commitChunksForTests } from '../../../src/fileSearch/ingestWorker';
import * as ctrl from '../../../src/controllers/vectorStoresController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'gen-owner@example.test';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function freshConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'test-model',
    embeddingDimensions: EMBED_DIM,
    limits: { maxFilesPerStore: 10000 },
    hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

const throwOnError = (e: any) => { throw e; };

d('chunk generations (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = freshConfig();
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
  });

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => { mockConfig = freshConfig(); });

  /** A store with one attached file; returns their ids. */
  async function seedStoreWithFile(status = 'completed'): Promise<{ storeId: string; fileId: string }> {
    const storeId = `vs_${crypto.randomUUID()}`;
    const fileId = `file-${crypto.randomUUID()}`;
    const sha = crypto.createHash('sha256').update(fileId).digest('hex');
    await pool.query(
      `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim) VALUES ($1, $2, 'test-model', $3)`,
      [storeId, OWNER, EMBED_DIM]);
    await pool.query(`INSERT INTO file_blobs (sha256, size_bytes, storage, ref_count) VALUES ($1, 1, 'db', 1)`, [sha]);
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ($1, $2, 'doc.txt', 'assistants', $3, 1)`, [fileId, OWNER, sha]);
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, $3)`, [storeId, fileId, status]);
    return { storeId, fileId };
  }

  async function seedChunk(storeId: string, fileId: string, generation: number, ord: number, text: string,
    embedding: number[]): Promise<void> {
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
      [storeId, fileId, generation, ord, text, `[${embedding.join(',')}]`]);
  }

  async function chunksByGeneration(storeId: string): Promise<Record<number, string[]>> {
    const { rows } = await pool.query<{ generation: number; text: string }>(
      'SELECT generation, text FROM vector_store_chunks WHERE store_id = $1 ORDER BY generation, ord', [storeId]);
    const out: Record<number, string[]> = {};
    for (const r of rows) (out[r.generation] ??= []).push(r.text);
    return out;
  }

  const recall = (storeId: string, queryText: string, queryEmbedding: number[], limit?: number) => recallCandidates({
    storeIds: [storeId], ownerEmail: OWNER, queryText, queryEmbedding, limit,
  });

  describe('readers see only the active generation', () => {
    it('recall (vector and lexical arm) ignores chunks of a generation that is not active', async () => {
      const { storeId, fileId } = await seedStoreWithFile();
      await seedChunk(storeId, fileId, 0, 0, 'harbour pilot schedule', [0, 1, 0]);
      await seedChunk(storeId, fileId, 0, 1, 'harbour tide tables', [0, 0, 1]);
      // Generation 1 is closer to the query vector AND matches the query text:
      // were it visible to either arm it would rank first.
      await seedChunk(storeId, fileId, 1, 0, 'harbour pilot schedule renewed', [1, 0, 0]);
      await seedChunk(storeId, fileId, 1, 1, 'harbour tide tables renewed', [1, 0.01, 0]);

      const active0 = await recall(storeId, 'harbour', [1, 0, 0]);
      expect(active0.map((c) => c.text).sort()).toEqual(['harbour pilot schedule', 'harbour tide tables']);
      // Both arms contributed, so both were filtered (not only the vector arm).
      expect(active0.every((c) => c.vectorRank !== undefined && c.lexicalRank !== undefined)).toBe(true);

      await pool.query('UPDATE vector_stores SET active_generation = 1 WHERE id = $1', [storeId]);
      const active1 = await recall(storeId, 'harbour', [1, 0, 0]);
      expect(active1.map((c) => c.text).sort()).toEqual(['harbour pilot schedule renewed', 'harbour tide tables renewed']);
    });

    it('the lexical arm alone does not surface an inactive generation', async () => {
      const { storeId, fileId } = await seedStoreWithFile();
      await seedChunk(storeId, fileId, 0, 0, 'plain words only', [0, 1, 0]);
      await seedChunk(storeId, fileId, 1, 0, 'quartermaster ledger', [0, 1, 0]);
      const hits = await recall(storeId, 'quartermaster', [0, 1, 0]);
      expect(hits.map((c) => c.text)).toEqual(['plain words only']);
      expect(hits[0].lexicalRank).toBeUndefined();
    });

    it('the content endpoint returns the active generation only', async () => {
      const { storeId, fileId } = await seedStoreWithFile();
      await seedChunk(storeId, fileId, 0, 0, 'first', [0, 1, 0]);
      await seedChunk(storeId, fileId, 0, 1, 'second', [0, 1, 0]);
      await seedChunk(storeId, fileId, 1, 0, 'first again', [1, 0, 0]);
      await seedChunk(storeId, fileId, 1, 1, 'second again', [1, 0, 0]);

      const req = () => ({
        headers: {}, query: {}, body: {}, apiKeyInfo: { email: OWNER }, params: { id: storeId, file_id: fileId },
      }) as any;
      const res0 = makeRes();
      await ctrl.downloadVectorStoreFileContent(req(), res0, throwOnError);
      expect(res0.statusCode).toBe(200);
      expect(res0.body.data[0].text).toBe('first\nsecond');

      await pool.query('UPDATE vector_stores SET active_generation = 1 WHERE id = $1', [storeId]);
      const res1 = makeRes();
      await ctrl.downloadVectorStoreFileContent(req(), res1, throwOnError);
      expect(res1.body.data[0].text).toBe('first again\nsecond again');
    });
  });

  describe('writes are scoped to one generation, deletes are not', () => {
    const chunks = (prefix: string) => [
      { ord: 0, text: `${prefix} zero`, tokens: 2 },
      { ord: 1, text: `${prefix} one`, tokens: 2 },
    ];
    const vectors = [[1, 0, 0], [0, 1, 0]];

    it('commitChunks writes the generations it reads under the store lock: the active one, plus the re-embed target while one runs', async () => {
      const { storeId, fileId } = await seedStoreWithFile('in_progress');
      const both = {
        'test-model': { vectors, tokens: 5 },
        'model-b': { vectors: [[0, 0, 1], [0, 0, 1]], tokens: 7 },
      };
      const setInProgress = () => pool.query(`UPDATE vector_store_files SET status = 'in_progress' WHERE store_id = $1`, [storeId]);

      // No re-embed running: the active generation only.
      expect(await __commitChunksForTests(storeId, fileId, chunks('old'), both)).toBe('committed');
      expect(await chunksByGeneration(storeId)).toEqual({ 0: ['old zero', 'old one'] });

      // A re-embed to model-b runs: both generations, each with its own model's
      // vectors, and the job's item for this file is recorded completed.
      const jobId = `job_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      await pool.query(
        `INSERT INTO fs_jobs (id, kind, owner_email, store_id, target_model, target_dim, target_generation)
         VALUES ($1, 'reembed_store', $2, $3, 'model-b', $4, 1)`, [jobId, OWNER, storeId, EMBED_DIM]);
      await setInProgress();
      expect(await __commitChunksForTests(storeId, fileId, chunks('new'), both)).toBe('committed');
      expect(await chunksByGeneration(storeId)).toEqual({ 0: ['new zero', 'new one'], 1: ['new zero', 'new one'] });
      const { rows: gen1 } = await pool.query(
        `SELECT embedding::text AS e FROM vector_store_chunks WHERE store_id = $1 AND generation = 1`, [storeId]);
      expect(gen1.map((r) => r.e)).toEqual(['[0,0,1]', '[0,0,1]']);
      const { rows: items } = await pool.query(
        'SELECT status, tokens FROM fs_reembed_items WHERE job_id = $1 AND file_id = $2', [jobId, fileId]);
      expect(items).toEqual([{ status: 'completed', tokens: '7' }]);

      // Vectors of the target model missing (the caller read the store before the
      // re-embed started): nothing written, the row stays in_progress.
      await setInProgress();
      expect(await __commitChunksForTests(storeId, fileId, chunks('stale'), { 'test-model': { vectors, tokens: 0 } }))
        .toBe('stale');
      expect(await chunksByGeneration(storeId)).toEqual({ 0: ['new zero', 'new one'], 1: ['new zero', 'new one'] });

      // The re-embed is over without a switch: an ingestion retry replaces the
      // active generation only — generation 1 survives it.
      await pool.query(`UPDATE fs_jobs SET finished_at = now(), error = '{}'::jsonb WHERE id = $1`, [jobId]);
      expect(await __commitChunksForTests(storeId, fileId, chunks('retry'), both)).toBe('committed');
      expect(await chunksByGeneration(storeId)).toEqual({ 0: ['retry zero', 'retry one'], 1: ['new zero', 'new one'] });
    });

    it('detaching a file removes every generation of its chunks', async () => {
      const { storeId, fileId } = await seedStoreWithFile();
      await seedChunk(storeId, fileId, 0, 0, 'a', [1, 0, 0]);
      await seedChunk(storeId, fileId, 1, 0, 'b', [1, 0, 0]);
      expect(await repo.deleteStoreFile(storeId, fileId, OWNER)).toEqual({ deleted: true });
      expect(await chunksByGeneration(storeId)).toEqual({});
    });

    it('deleting a store removes every generation of its chunks', async () => {
      const { storeId, fileId } = await seedStoreWithFile();
      await seedChunk(storeId, fileId, 0, 0, 'a', [1, 0, 0]);
      await seedChunk(storeId, fileId, 1, 0, 'b', [1, 0, 0]);
      expect(await repo.deleteStoreCascade(storeId, OWNER)).toEqual({ deleted: true });
      expect(await chunksByGeneration(storeId)).toEqual({});
    });
  });

  describe('recall pgvector settings on a shared HNSW index', () => {
    it('applies ef_search (and iterative_scan where supported) inside the recall transaction and returns the full candidate count', async () => {
      // 20 other stores whose 400 chunks each sit right on the query vector,
      // all in the one HNSW index the target store also uses; the target
      // store's active chunks are far from the query, and its inactive
      // generation is near it. Recall must return exactly the target's 50
      // nearest ACTIVE chunks.
      const others: string[] = [];
      for (let s = 0; s < 20; s += 1) {
        // eslint-disable-next-line no-await-in-loop
        const { storeId, fileId } = await seedStoreWithFile();
        others.push(storeId);
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding)
           SELECT $1, $2, o, 'other chunk',
                  ('[1,' || (random() * 0.05)::text || ',' || (random() * 0.05)::text || ']')::vector
             FROM generate_series(0, 399) o`, [storeId, fileId]);
      }
      const { storeId, fileId } = await seedStoreWithFile();
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, embedding)
         SELECT $1, $2, g, o, 'target g' || g || ' ' || o,
                CASE WHEN g = 0 THEN ('[' || (o * 0.001)::text || ',1,0]')::vector
                     ELSE ('[1,' || (o * 0.0001)::text || ',0]')::vector END
           FROM generate_series(0, 1) g, generate_series(0, 299) o`, [storeId, fileId]);
      await pool.query('ANALYZE vector_store_chunks');

      // Observe the session settings from inside recall's own transaction:
      // the client recall checks out runs one extra SELECT just before COMMIT.
      const seen: Array<{ ef: string; iterative: string | null }> = [];
      const realConnect = pool.connect.bind(pool);
      const connectSpy = jest.spyOn(pool, 'connect').mockImplementation((async () => {
        const client: any = await realConnect();
        const realQuery = client.query.bind(client);
        client.query = async (sql: any, ...rest: any[]) => {
          if (sql === 'COMMIT') {
            const { rows } = await realQuery(
              "SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan', true) AS iterative");
            seen.push(rows[0]);
          }
          return realQuery(sql, ...rest);
        };
        const realRelease = client.release.bind(client);
        client.release = (...a: any[]) => { client.query = realQuery; return realRelease(...a); };
        return client;
      }) as any);

      let hits;
      try {
        hits = await recall(storeId, 'nothing matches this', [1, 0, 0], 50);
      } finally {
        connectSpy.mockRestore();
      }

      const { rows: ext } = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
      const [major, minor] = String(ext[0].extversion).split('.').map(Number);
      const iterativeSupported = major > 0 || minor >= 8;
      expect(seen).toHaveLength(1);
      expect(seen[0].ef).toBe(String(recallEfSearch(50)));
      if (iterativeSupported) expect(seen[0].iterative).toBe('strict_order');
      else expect(seen[0].iterative).not.toBe('strict_order');

      // The full candidate count, and exactly the exact-search top 50 of the
      // active generation: [ord * 0.001, 1, 0] turns toward [1, 0, 0] as ord
      // grows, so ord 250..299 are nearest by construction.
      expect(hits).toHaveLength(50);
      expect(hits.every((c) => c.storeId === storeId && c.text.startsWith('target g0 '))).toBe(true);
      expect(hits.map((c) => c.ord).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => 250 + i));

      // SET LOCAL ended with the transaction: no pooled connection keeps it.
      const { rows: after } = await pool.query("SELECT current_setting('hnsw.ef_search', true) AS ef");
      expect(after[0].ef).not.toBe(String(recallEfSearch(50)));
      expect(others).toHaveLength(20);
    });
  });
});
