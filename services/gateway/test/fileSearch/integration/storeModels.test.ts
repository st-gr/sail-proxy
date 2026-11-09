/**
 * One model per store (grounding phase 4a, plan Decisions 2, 7 and 13), against a real
 * Postgres: a search over stores pinned to different embedding models embeds the query
 * once per model and compares each vector only with its own stores' chunks, fusing the
 * arms with the same RRF; a store whose model is no longer served refuses the search with
 * `store_model_unavailable`.
 *
 * Only `embed()` and `rerank()` are stubbed (they reach SAP AI Core). The stub answers per
 * MODEL, so a search that embedded a store's query with the wrong model would compare the
 * wrong vector and rank the wrong chunk first — the vectors below are laid out so that
 * happens visibly.
 */
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'store-models@example.com';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
  default: { getFileSearchConfig: () => mockConfig },
}));

const embedMock: any = jest.fn();
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: (...a: any[]) => embedMock(...a),
}));

jest.mock('../../../src/fileSearch/reranker', () => ({
  __esModule: true,
  rerank: async () => null,
}));

// eslint-disable-next-line import/first
import { searchVectorStores, StoreModelUnavailableError } from '../../../src/fileSearch/search';
// eslint-disable-next-line import/first
import { EmbeddingModelUnavailableError } from '../../../src/fileSearch/embedder';

/** The query vector each model returns. Model A's points along x, model B's along y. */
const QUERY_VECTOR: Record<string, number[]> = { 'model-a': [1, 0, 0], 'model-b': [0, 1, 0] };

d('one embedding model per store, against a real Postgres (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'model-config', // neither store's model: the config must not be used
      embeddingDimensions: EMBED_DIM,
      rewriteQuery: false,
      hybrid: { rrfK: 60, lexicalEnabled: false, candidates: 50, rerank: { enabled: false, model: 'unused' } },
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    };
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    embedMock.mockImplementation(async (_texts: string[], _kind: string, target: { model: string }) => ({
      vectors: [QUERY_VECTOR[target.model]],
      usage: { promptTokens: 1, totalTokens: 1 },
    }));
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
  });

  async function seedStore(model: string): Promise<string> {
    const id = `vs_${crypto.randomUUID().replace(/-/g, '')}`;
    await pool.query(
      `INSERT INTO vector_stores (id, owner_email, is_shared, embedding_model, embedding_dim)
       VALUES ($1, $2, false, $3, $4)`,
      [id, OWNER, model, EMBED_DIM],
    );
    return id;
  }

  async function seedChunk(storeId: string, fileId: string, embedding: number[]): Promise<void> {
    const sha256 = crypto.createHash('sha256').update(`${storeId}:${fileId}`).digest('hex');
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ($1, 1, 'inline') ON CONFLICT (sha256) DO NOTHING`,
      [sha256]);
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ($1, $2, $1, 'assistants', $3, 1) ON CONFLICT (id) DO NOTHING`,
      [fileId, OWNER, sha256]);
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, 'completed')`,
      [storeId, fileId]);
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding) VALUES ($1, $2, 0, $2, $3::vector)`,
      [storeId, fileId, `[${embedding.join(',')}]`]);
  }

  /** Store A (model-a) and store B (model-b), each with a chunk near its OWN model's query
   *  vector and a chunk near the OTHER model's. Searched with one vector for both, one of
   *  the two stores would put its "far" chunk first. */
  async function seedTwoStores(): Promise<{ a: string; b: string }> {
    const a = await seedStore('model-a');
    const b = await seedStore('model-b');
    await seedChunk(a, 'file-a-near', [1, 0.05, 0]);
    await seedChunk(a, 'file-a-far', [0, 1, 0]);
    await seedChunk(b, 'file-b-near', [0.05, 1, 0]);
    await seedChunk(b, 'file-b-far', [1, 0, 0]);
    return { a, b };
  }

  it('embeds once per model with that model and ranks each store by its own model\'s vector', async () => {
    const { a, b } = await seedTwoStores();

    const result = await searchVectorStores({ storeIds: [a, b], query: 'q', ownerEmail: OWNER, maxNumResults: 4 });

    expect(embedMock).toHaveBeenCalledTimes(2);
    expect(embedMock.mock.calls.map((c: any[]) => c[2])).toEqual([
      { model: 'model-a', dimensions: EMBED_DIM },
      { model: 'model-b', dimensions: EMBED_DIM },
    ]);
    // RRF over two vector arms: each store's near chunk is first in its own arm, so the
    // two near chunks share the top score and both far chunks follow.
    expect(result.data.map((h) => h.fileId).slice(0, 2).sort()).toEqual(['file-a-near', 'file-b-near']);
    expect(result.data.map((h) => h.fileId).slice(2).sort()).toEqual(['file-a-far', 'file-b-far']);
    expect(result.data[0].score).toBeCloseTo(1 / 61);
    expect(result.data[1].score).toBeCloseTo(1 / 61);
    expect(result.data[2].score).toBeCloseTo(1 / 62);
  });

  it('searches a single store with its own model even when the configuration names another', async () => {
    const { b } = await seedTwoStores();

    const result = await searchVectorStores({ storeIds: [b], query: 'q', ownerEmail: OWNER });

    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock.mock.calls[0][2]).toEqual({ model: 'model-b', dimensions: EMBED_DIM });
    expect(result.data.map((h) => h.fileId)).toEqual(['file-b-near', 'file-b-far']);
  });

  it('refuses with store_model_unavailable, naming the store, when its model is no longer served', async () => {
    const { a, b } = await seedTwoStores();
    embedMock.mockImplementation(async (_t: string[], _k: string, target: { model: string }) => {
      if (target.model === 'model-b') throw new EmbeddingModelUnavailableError('model-b');
      return { vectors: [QUERY_VECTOR[target.model]], usage: { promptTokens: 1, totalTokens: 1 } };
    });
    const { rows: before } = await pool.query('SELECT last_active_at FROM vector_stores WHERE id = $1', [b]);

    const error: any = await searchVectorStores({ storeIds: [a, b], query: 'q', ownerEmail: OWNER }).catch((e) => e);

    expect(error).toBeInstanceOf(StoreModelUnavailableError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('store_model_unavailable');
    expect(error.storeIds).toEqual([b]);
    expect(error.message).toContain(b);
    expect(error.message).not.toContain(a);
    // A refused search is not activity.
    const { rows: after } = await pool.query('SELECT last_active_at FROM vector_stores WHERE id = $1', [b]);
    expect(after[0].last_active_at).toEqual(before[0].last_active_at);
  });
});
