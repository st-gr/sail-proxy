// The store chunking setting against a real Postgres database (W2 Q4/Q5): a store gets
// the installation default written at creation and keeps it when the configuration
// changes; a NULL (pre-W2) store reports static 800/400; the OpenAI routes refuse an
// unknown chunking_strategy with a 400 and write nothing; file objects report
// `{type: 'other'}` for a structure store.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as ctrl from '../../../src/controllers/vectorStoresController';
import * as repo from '../../../src/fileSearch/repository';
import * as admin from '../../../src/fileSearch/admin';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'owner@example.com';
const STATIC_800 = { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } };

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function config(chunking: unknown): any {
  return {
    enabled: true,
    embeddingModel: 'test-model',
    embeddingDimensions: EMBED_DIM,
    chunking,
    limits: { maxFilesPerStore: 10000 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

const STRUCTURE_CONFIG = { strategy: 'structure', maxChunkSizeTokens: 1000, chunkOverlapTokens: 200, contextual: true };
const STATIC_CONFIG = { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false };
/** The shipped api_config.json's setting since the chunking evaluation of 2026-10-09 (set explicitly there). */
const SHIPPED_CONFIG = { strategy: 'structure', maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true };

function makeRes(): any {
  const res: any = { statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

function req(overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email: OWNER }, ...overrides };
}

async function call(handler: (...a: any[]) => Promise<void>, r: any): Promise<any> {
  const res = makeRes();
  await handler(r, res, (e: any) => { throw e; });
  return res;
}

d('store chunking setting against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = config(STATIC_CONFIG);
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
    mockConfig = config(STATIC_CONFIG);
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
  });

  async function seedFile(): Promise<string> {
    const content = Buffer.from(`hello ${Math.random()}`);
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,'a.txt','assistants',$3,$4, now())`,
      [id, OWNER, sha, content.length],
    );
    return id;
  }

  async function storedChunking(storeId: string): Promise<unknown> {
    const { rows } = await pool.query('SELECT chunking FROM vector_stores WHERE id = $1', [storeId]);
    return rows[0].chunking;
  }

  describe('store creation writes the resolved setting', () => {
    it('the shipped default (structure 800/0 with contexts) is written for a new store', async () => {
      mockConfig = config(SHIPPED_CONFIG);
      const store = await repo.createStore({ ownerEmail: OWNER });
      expect(store.chunking).toEqual({ type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true });
      expect(await storedChunking(store.id)).toEqual(store.chunking);
    });

    it('under the shipped default, a pre-W2 (NULL) store stays static 800/400 and a recorded setting stays as it is', async () => {
      mockConfig = config(STATIC_CONFIG);
      const legacy = await repo.createStore({ ownerEmail: OWNER });
      const plain = await repo.createStore({ ownerEmail: OWNER, chunking: { type: 'structure', max_tokens: 600, overlap_tokens: 0, contextual: false } });
      await pool.query('UPDATE vector_stores SET chunking = NULL WHERE id = $1', [legacy.id]);
      mockConfig = config(SHIPPED_CONFIG);
      const fileId = await seedFile();
      const attached = await call(ctrl.createVectorStoreFile, req({ params: { id: legacy.id }, body: { file_id: fileId } }));
      expect(attached.body.chunking_strategy).toEqual(STATIC_800);
      expect(await storedChunking(legacy.id)).toBeNull();
      expect(await storedChunking(plain.id)).toEqual({ type: 'structure', max_tokens: 600, overlap_tokens: 0, contextual: false });
    });

    it('a static installation default (static 800/400) is written, not left NULL', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER });
      expect(store.chunking).toEqual({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
      expect(await storedChunking(store.id)).toEqual(store.chunking);
    });

    it('a configured structure default is written, and the store keeps it when the configuration changes', async () => {
      mockConfig = config(STRUCTURE_CONFIG);
      const store = await repo.createStore({ ownerEmail: OWNER });
      const written = { type: 'structure', max_tokens: 1000, overlap_tokens: 200, contextual: true };
      expect(await storedChunking(store.id)).toEqual(written);

      mockConfig = config(STATIC_CONFIG);
      expect(await storedChunking(store.id)).toEqual(written);
      const later = await repo.createStore({ ownerEmail: OWNER });
      expect(later.chunking).toEqual({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
    });

    it('an invalid configured default writes static 800/400', async () => {
      mockConfig = config({ ...STATIC_CONFIG, chunkOverlapTokens: 401 });
      const store = await repo.createStore({ ownerEmail: OWNER });
      expect(await storedChunking(store.id)).toEqual({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
    });

    it('an explicit setting is validated and written', async () => {
      const explicit = { type: 'structure' as const, max_tokens: 600, overlap_tokens: 0, contextual: false };
      const store = await repo.createStore({ ownerEmail: OWNER, chunking: explicit });
      expect(await storedChunking(store.id)).toEqual(explicit);
      await expect(repo.createStore({ ownerEmail: OWNER, chunking: { ...explicit, type: 'static', contextual: true } }))
        .rejects.toThrow(/contextual/);
    });

    it('POST /vector_stores writes the installation default; its chunking_strategy goes to the files attached', async () => {
      mockConfig = config(STRUCTURE_CONFIG);
      const fileId = await seedFile();
      const strategy = { type: 'static', static: { max_chunk_size_tokens: 300, chunk_overlap_tokens: 100 } };
      const res = await call(ctrl.createVectorStore, req({ body: { file_ids: [fileId], chunking_strategy: strategy } }));
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toHaveProperty('chunking');
      expect(await storedChunking(res.body.id))
        .toEqual({ type: 'structure', max_tokens: 1000, overlap_tokens: 200, contextual: true });
      const { rows } = await pool.query('SELECT chunking_strategy FROM vector_store_files WHERE store_id = $1', [res.body.id]);
      expect(rows[0].chunking_strategy).toEqual(strategy);
    });

    it('admin store listing carries the setting', async () => {
      const store = await repo.createStore({ ownerEmail: OWNER });
      const rows = await admin.listAllStores({ owner: OWNER, limit: 10 });
      expect(rows.find((r) => r.id === store.id)?.chunking).toEqual(store.chunking);
    });
  });

  describe('OpenAI routes', () => {
    it('an unknown chunking_strategy type is a 400 on create, attach and batch, and nothing is written', async () => {
      const fileId = await seedFile();
      const store = await repo.createStore({ ownerEmail: OWNER });
      const bad = { chunking_strategy: { type: 'structure' } };
      const responses = [
        await call(ctrl.createVectorStore, req({ body: { file_ids: [fileId], ...bad } })),
        await call(ctrl.createVectorStoreFile, req({ params: { id: store.id }, body: { file_id: fileId, ...bad } })),
        await call(ctrl.createVectorStoreFileBatch, req({ params: { id: store.id }, body: { file_ids: [fileId], ...bad } })),
      ];
      for (const res of responses) {
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toEqual({
          message: "Invalid value: 'structure'. Supported values are: 'auto' and 'static'.",
          type: 'invalid_request_error', param: 'chunking_strategy.type', code: 'invalid_value',
        });
      }
      expect((await pool.query('SELECT count(*)::int AS n FROM vector_stores')).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM vector_store_files')).rows[0].n).toBe(0);
    });

    it('a NULL (pre-W2) store reports static 800/400 on every file object', async () => {
      const fileId = await seedFile();
      const store = await repo.createStore({ ownerEmail: OWNER });
      await pool.query('UPDATE vector_stores SET chunking = NULL WHERE id = $1', [store.id]);
      const attached = await call(ctrl.createVectorStoreFile, req({ params: { id: store.id }, body: { file_id: fileId } }));
      expect(attached.body.chunking_strategy).toEqual(STATIC_800);
      const got = await call(ctrl.retrieveVectorStoreFile, req({ params: { id: store.id, file_id: fileId } }));
      expect(got.body.chunking_strategy).toEqual(STATIC_800);
      expect(got.body).not.toHaveProperty('store_chunking');
    });

    it('a structure store reports {type: other} on attach, retrieve, modify, list and batch list', async () => {
      mockConfig = config(STRUCTURE_CONFIG);
      const [a, b] = [await seedFile(), await seedFile()];
      const store = await repo.createStore({ ownerEmail: OWNER });
      const attached = await call(ctrl.createVectorStoreFile, req({ params: { id: store.id }, body: { file_id: a, chunking_strategy: { type: 'auto' } } }));
      expect(attached.body.chunking_strategy).toEqual({ type: 'other' });
      const batch = await call(ctrl.createVectorStoreFileBatch, req({
        params: { id: store.id },
        body: { file_ids: [b], chunking_strategy: { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 0 } } },
      }));
      expect(batch.statusCode).toBe(200);

      const got = await call(ctrl.retrieveVectorStoreFile, req({ params: { id: store.id, file_id: a } }));
      expect(got.body.chunking_strategy).toEqual({ type: 'other' });
      const modified = await call(ctrl.modifyVectorStoreFile, req({ params: { id: store.id, file_id: a }, body: { attributes: { k: 'v' } } }));
      expect(modified.body.chunking_strategy).toEqual({ type: 'other' });
      expect(modified.body).not.toHaveProperty('store_chunking');

      const list = await call(ctrl.listVectorStoreFiles, req({ params: { id: store.id }, query: { order: 'asc' } }));
      const byId = Object.fromEntries(list.body.data.map((f: any) => [f.id, f.chunking_strategy]));
      expect(byId).toEqual({
        [a]: { type: 'other' },
        [b]: { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 0 } },
      });
      const batchList = await call(ctrl.listVectorStoreFileBatchFiles, req({ params: { id: store.id, batch_id: batch.body.id } }));
      expect(batchList.body.data.map((f: any) => f.chunking_strategy))
        .toEqual([{ type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 0 } }]);
    });
  });
});
