/**
 * Grounding phase 4b, ingest and re-embed usage against a real pgvector: who
 * pays for each embedding request the workers make.
 *
 *  - An attach stamps the paying credential on vector_store_files: the caller's
 *    own key on the OpenAI API, the admin service key on behalf of the store's
 *    owner on a cockpit (grounding) call. Retries keep that stamp.
 *  - A row attached before 4b (null stamp) falls back to its batch job's
 *    credential on behalf of the job's starter, or records nothing.
 *  - Re-embedding is billed to the job's credential on behalf of the store owner,
 *    also when an admin started it.
 *  - One event per embedding request (the embedder's onUsage hook), so a dual
 *    write records two and a file failing mid-way records what was billed.
 *
 * Only embed() (SAP AI Core) and text extraction are stubbed; the usage events
 * are captured at the emitter (services/usageEventEmitter).
 */
import { Pool } from 'pg';
import { getDefaultLogger } from '@libs/logger';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import { EMBED_DIM, vectorOf, seedStore } from './reembedFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const OWNER = 'usage-owner@example.test';
const ADMIN = 'usage-admin@example.test';
const SERVICE_KEY = 'svc-key-usage';
const USER_KEY = 'key-usage-42';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
  default: { getFileSearchConfig: () => mockConfig },
}));

jest.mock('../../../src/fileSearch/extractors/registry', () => {
  const actual = jest.requireActual('../../../src/fileSearch/extractors/registry');
  return { ...actual, extractText: async () => 'lorem ipsum dolor sit amet '.repeat(20) };
});

const embedMock: any = jest.fn();
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: (...a: any[]) => embedMock(...a),
}));

const emitted: any[] = [];
jest.mock('../../../src/services/usageEventEmitter', () => ({
  __esModule: true,
  default: { emit: async (event: any) => { emitted.push(event); } },
}));

// eslint-disable-next-line import/first
import * as ctrl from '../../../src/controllers/vectorStoresController';
// eslint-disable-next-line import/first
import * as repo from '../../../src/fileSearch/repository';
// eslint-disable-next-line import/first
import { processOne } from '../../../src/fileSearch/ingestWorker';
// eslint-disable-next-line import/first
import { retryFile } from '../../../src/fileSearch/jobs';
// eslint-disable-next-line import/first
import { startReembed } from '../../../src/fileSearch/reembed';
// eslint-disable-next-line import/first
import { claimNextReembedItem, processReembedItem } from '../../../src/fileSearch/reembedWorker';

function freshConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'model-a',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: false, candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 2, extractTimeoutMs: 5000, maxRetries: 3 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

/** The fake embedder: one sub-request per call, reporting 10 tokens per text. */
function billingEmbedder() {
  return async (texts: string[], _type: string, target: { model: string }, opts: any = {}) => {
    opts.onUsage?.({ promptTokens: texts.length * 10, totalTokens: texts.length * 10, elapsedMs: 7 });
    return { vectors: texts.map(() => vectorOf(target.model)), usage: { promptTokens: texts.length * 10, totalTokens: texts.length * 10 } };
  };
}

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.set = () => res;
  res.send = (body: any) => { res.body = body; return res; };
  return res;
}

const throwOnError = (e: any) => { throw e; };

/** A cockpit (grounding) request: the admin service key acting for `actor`. */
function groundingReq(actor: string, overrides: Record<string, any>): any {
  return {
    headers: {}, params: {}, query: {}, body: {},
    apiKeyInfo: { active: true, email: actor, authSource: 'grounding' },
    groundingActor: { email: actor, role: actor === ADMIN ? 'admin' : 'user' },
    serviceAuth: { authType: 'service-key', serviceKey: { id: SERVICE_KEY } },
    ...overrides,
  };
}

/** An OpenAI-API request with the caller's own key. */
function apiReq(overrides: Record<string, any>): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email: OWNER, keyId: USER_KEY }, ...overrides };
}

d('usage recording of the ingest and re-embed workers (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = freshConfig();
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
    mockConfig = freshConfig();
    emitted.length = 0;
    embedMock.mockReset();
    embedMock.mockImplementation(billingEmbedder());
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  afterEach(() => jest.restoreAllMocks());

  /** An fs_files row of `owner` with real blob bytes, attached nowhere. */
  async function seedDocument(owner: string): Promise<string> {
    const content = Buffer.from(`usage document ${newFileId()}`);
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ($1, $2, 'doc.txt', 'assistants', $3, $4)`, [fileId, owner, sha, content.length]);
    return fileId;
  }

  async function emptyStore(): Promise<string> {
    return (await seedStore(pool, { owner: OWNER, model: 'model-a' })).storeId;
  }

  async function stampOf(storeId: string, fileId: string): Promise<any> {
    const { rows } = await pool.query(
      `SELECT credential_id, auth_type, on_behalf_of FROM vector_store_files WHERE store_id = $1 AND file_id = $2`,
      [storeId, fileId]);
    return rows[0];
  }

  async function statusOf(storeId: string, fileId: string): Promise<string> {
    const { rows } = await pool.query(
      'SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);
    return rows[0]?.status;
  }

  describe('the attach stamp', () => {
    it('a cockpit attach stamps the service key on behalf of the store\'s owner', async () => {
      const storeId = await emptyStore();
      const fileId = await seedDocument(OWNER);
      const res = makeRes();
      await ctrl.createVectorStoreFile(groundingReq(OWNER, { params: { id: storeId }, body: { file_id: fileId } }), res, throwOnError);
      expect(res.statusCode).toBe(200);
      expect(await stampOf(storeId, fileId)).toEqual({ credential_id: SERVICE_KEY, auth_type: 'api_key', on_behalf_of: OWNER });
    });

    it('an OpenAI-API attach stamps the caller\'s key and no acting user', async () => {
      const storeId = await emptyStore();
      const fileId = await seedDocument(OWNER);
      const res = makeRes();
      await ctrl.createVectorStoreFile(apiReq({ params: { id: storeId }, body: { file_id: fileId } }), res, throwOnError);
      expect(res.statusCode).toBe(200);
      expect(await stampOf(storeId, fileId)).toEqual({ credential_id: USER_KEY, auth_type: 'api_key', on_behalf_of: null });
    });

    it('a store created with file_ids stamps each attached file', async () => {
      const fileId = await seedDocument(OWNER);
      const res = makeRes();
      await ctrl.createVectorStore(apiReq({ body: { name: 's', file_ids: [fileId] } }), res, throwOnError);
      expect(res.statusCode).toBe(200);
      expect(await stampOf(res.body.id, fileId)).toEqual({ credential_id: USER_KEY, auth_type: 'api_key', on_behalf_of: null });
    });

    it('a file batch stamps each member: cockpit with the acting user, API without', async () => {
      const storeId = await emptyStore();
      const cockpitFile = await seedDocument(OWNER);
      const apiFile = await seedDocument(OWNER);
      const cockpit = makeRes();
      await ctrl.createVectorStoreFileBatch(
        groundingReq(OWNER, { params: { id: storeId }, body: { file_ids: [cockpitFile] } }), cockpit, throwOnError);
      expect(cockpit.statusCode).toBe(200);
      const api = makeRes();
      await ctrl.createVectorStoreFileBatch(apiReq({ params: { id: storeId }, body: { file_ids: [apiFile] } }), api, throwOnError);
      expect(api.statusCode).toBe(200);
      expect(await stampOf(storeId, cockpitFile)).toEqual({ credential_id: SERVICE_KEY, auth_type: 'api_key', on_behalf_of: OWNER });
      expect(await stampOf(storeId, apiFile)).toEqual({ credential_id: USER_KEY, auth_type: 'api_key', on_behalf_of: null });
    });

    it('a cockpit admin attaching to a user\'s store stamps the store\'s owner, single and batch', async () => {
      const storeId = await emptyStore();
      const single = await seedDocument(OWNER);
      const member = await seedDocument(OWNER);
      // The owner check reads apiKeyInfo; the acting user is the admin.
      const asAdmin = (overrides: Record<string, any>) => groundingReq(ADMIN, {
        apiKeyInfo: { active: true, email: OWNER, authSource: 'grounding' }, ...overrides,
      });
      const one = makeRes();
      await ctrl.createVectorStoreFile(asAdmin({ params: { id: storeId }, body: { file_id: single } }), one, throwOnError);
      expect(one.statusCode).toBe(200);
      const batch = makeRes();
      await ctrl.createVectorStoreFileBatch(asAdmin({ params: { id: storeId }, body: { file_ids: [member] } }), batch, throwOnError);
      expect(batch.statusCode).toBe(200);
      for (const fileId of [single, member]) {
        // eslint-disable-next-line no-await-in-loop
        expect(await stampOf(storeId, fileId)).toEqual({ credential_id: SERVICE_KEY, auth_type: 'api_key', on_behalf_of: OWNER });
      }
      // The job still records who started it.
      const { rows } = await pool.query('SELECT started_by FROM fs_jobs WHERE batch_id = $1', [batch.body.id]);
      expect(rows).toEqual([{ started_by: ADMIN }]);
    });

    it('a retry keeps the attach stamp', async () => {
      const storeId = await emptyStore();
      const fileId = await seedDocument(OWNER);
      await repo.attachFile(storeId, fileId, null, null, null,
        { credentialId: SERVICE_KEY, authType: 'api_key', onBehalfOf: OWNER });
      await pool.query(`UPDATE vector_store_files SET status = 'failed', attempts = 3 WHERE store_id = $1`, [storeId]);
      const retried = await retryFile(storeId, fileId, OWNER);
      expect(retried).toMatchObject({ ok: true });
      expect(await statusOf(storeId, fileId)).toBe('in_progress');
      expect(await stampOf(storeId, fileId)).toEqual({ credential_id: SERVICE_KEY, auth_type: 'api_key', on_behalf_of: OWNER });
    });
  });

  describe('ingestion', () => {
    it('records one file_search/ingest event per embedding request, billed to the cockpit stamp', async () => {
      const storeId = await emptyStore();
      const fileId = await seedDocument(OWNER);
      await repo.attachFile(storeId, fileId, null, null, null,
        { credentialId: SERVICE_KEY, authType: 'api_key', onBehalfOf: OWNER });

      await processOne(storeId, fileId);

      expect(await statusOf(storeId, fileId)).toBe('completed');
      expect(emitted).toHaveLength(1);
      const [event] = emitted;
      expect(event).toMatchObject({
        authType: 'api_key', credentialId: SERVICE_KEY, onBehalfOf: OWNER,
        endpoint: 'file_search/ingest', model: 'model-a', unit: 'tokens',
        outputTokens: 0, responseTime: 7, statusCode: 200,
      });
      expect(event.inputTokens).toBeGreaterThan(0);
      expect(event.inputTokens).toBe(embedMock.mock.calls[0][0].length * 10);
      expect(event.requestId).toMatch(/^fs-ingest-[0-9a-f-]{36}$/);
    });

    it('an OpenAI-API attach is billed to the caller\'s key with no acting user', async () => {
      const storeId = await emptyStore();
      const fileId = await seedDocument(OWNER);
      await repo.attachFile(storeId, fileId, null, null, null, { credentialId: USER_KEY, authType: 'api_key', onBehalfOf: null });

      await processOne(storeId, fileId);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ credentialId: USER_KEY, authType: 'api_key', endpoint: 'file_search/ingest' });
      expect(emitted[0]).not.toHaveProperty('onBehalfOf');
    });

    it('a dual write during a re-embed records one event per model', async () => {
      const storeId = await emptyStore();
      await pool.query(
        `INSERT INTO fs_jobs (id, kind, owner_email, started_by, credential_id, auth_type, store_id,
                              target_model, target_dim, target_generation)
         VALUES ('job_dual', 'reembed_store', $1, $1, $2, 'api_key', $3, 'model-b', ${EMBED_DIM}, 1)`,
        [OWNER, SERVICE_KEY, storeId]);
      const fileId = await seedDocument(OWNER);
      await repo.attachFile(storeId, fileId, null, null, null, { credentialId: USER_KEY, authType: 'api_key', onBehalfOf: null });

      await processOne(storeId, fileId);

      expect(await statusOf(storeId, fileId)).toBe('completed');
      expect(emitted.map((e) => [e.endpoint, e.model, e.credentialId]).sort()).toEqual([
        ['file_search/ingest', 'model-a', USER_KEY],
        ['file_search/ingest', 'model-b', USER_KEY],
      ]);
      expect(new Set(emitted.map((e) => e.requestId)).size).toBe(2);
    });

    it('a file failing mid-way records the embedding requests already billed', async () => {
      const storeId = await emptyStore();
      const fileId = await seedDocument(OWNER);
      await repo.attachFile(storeId, fileId, null, null, null, { credentialId: USER_KEY, authType: 'api_key', onBehalfOf: null });
      // Two sub-requests succeed (and are billed), the third fails.
      embedMock.mockImplementation(async (_texts: string[], _type: string, _target: any, opts: any = {}) => {
        opts.onUsage?.({ promptTokens: 100, totalTokens: 100, elapsedMs: 3 });
        opts.onUsage?.({ promptTokens: 50, totalTokens: 50, elapsedMs: 4 });
        throw new Error('sub-request 3 failed');
      });
      jest.spyOn(getDefaultLogger(), 'error').mockImplementation(() => {});

      await processOne(storeId, fileId);

      expect(await statusOf(storeId, fileId)).not.toBe('completed');
      expect(emitted.map((e) => [e.inputTokens, e.responseTime])).toEqual([[100, 3], [50, 4]]);
      expect(emitted.every((e) => e.credentialId === USER_KEY && e.endpoint === 'file_search/ingest')).toBe(true);
      expect(emitted[0].requestId).not.toBe(emitted[1].requestId);
    });

    describe('rows attached before usage recording (null stamp)', () => {
      async function legacyBatchMember(job: { startedBy: string; credentialId: string | null }): Promise<{ storeId: string; fileId: string }> {
        const storeId = await emptyStore();
        const fileId = await seedDocument(OWNER);
        await pool.query(`INSERT INTO vector_store_batches (id, store_id, created_at) VALUES ('vsfb_legacy', $1, now())`, [storeId]);
        await pool.query(
          `INSERT INTO fs_jobs (id, kind, owner_email, started_by, credential_id, auth_type, store_id, batch_id)
           VALUES ('job_legacy', 'file_batch', $1, $2, $3, 'api_key', $4, 'vsfb_legacy')`,
          [OWNER, job.startedBy, job.credentialId, storeId]);
        await pool.query(
          `INSERT INTO vector_store_files (store_id, file_id, status, batch_id) VALUES ($1, $2, 'in_progress', 'vsfb_legacy')`,
          [storeId, fileId]);
        return { storeId, fileId };
      }

      // onBehalfOf is the job's owner (the store's owner), always, as for stamped
      // ingestion: the admin honours it only for the admin service key, so on an
      // API key's batch it changes nothing.
      it('a batch member started through the API is billed to its job\'s key, naming its owner', async () => {
        const { storeId, fileId } = await legacyBatchMember({ startedBy: OWNER, credentialId: USER_KEY });
        await processOne(storeId, fileId);
        expect(await statusOf(storeId, fileId)).toBe('completed');
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
          credentialId: USER_KEY, authType: 'api_key', endpoint: 'file_search/ingest', onBehalfOf: OWNER,
        });
      });

      it('a batch member an admin started in the cockpit is billed to the service key on behalf of the store owner', async () => {
        const { storeId, fileId } = await legacyBatchMember({ startedBy: ADMIN, credentialId: SERVICE_KEY });
        await processOne(storeId, fileId);
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({ credentialId: SERVICE_KEY, onBehalfOf: OWNER });
      });

      it('a batch member whose job has no credential records nothing', async () => {
        const { storeId, fileId } = await legacyBatchMember({ startedBy: OWNER, credentialId: null });
        await processOne(storeId, fileId);
        expect(await statusOf(storeId, fileId)).toBe('completed');
        expect(emitted).toHaveLength(0);
      });

      it('a single attach records nothing and says so at debug', async () => {
        const storeId = await emptyStore();
        const fileId = await seedDocument(OWNER);
        await pool.query(`INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, 'in_progress')`, [storeId, fileId]);
        const debug = jest.spyOn(getDefaultLogger(), 'debug');

        await processOne(storeId, fileId);

        expect(await statusOf(storeId, fileId)).toBe('completed');
        expect(emitted).toHaveLength(0);
        expect(debug.mock.calls.some((c) => String(c[1]).includes('usage not recorded'))).toBe(true);
      });
    });
  });

  describe('re-embedding', () => {
    async function runReembed(actorEmail: string): Promise<void> {
      mockConfig.embeddingModel = 'model-b';
      const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 2 });
      const started = await startReembed(OWNER, storeId, { email: actorEmail, credentialId: SERVICE_KEY, authType: 'api_key' });
      expect(started.ok).toBe(true);
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const item = await claimNextReembedItem();
        if (!item) break;
        // eslint-disable-next-line no-await-in-loop
        await processReembedItem(item);
      }
    }

    it('an owner-started re-embed records file_search/reembed per request on behalf of the owner', async () => {
      await runReembed(OWNER);
      expect(emitted).toHaveLength(2);
      for (const e of emitted) {
        expect(e).toMatchObject({
          credentialId: SERVICE_KEY, authType: 'api_key', onBehalfOf: OWNER,
          endpoint: 'file_search/reembed', model: 'model-b', inputTokens: 20, unit: 'tokens', responseTime: 7,
        });
        expect(e.requestId).toMatch(/^fs-reembed-[0-9a-f-]{36}$/);
      }
      expect(emitted[0].requestId).not.toBe(emitted[1].requestId);
    });

    it('an admin-started re-embed is still recorded on behalf of the store owner', async () => {
      await runReembed(ADMIN);
      expect(emitted).toHaveLength(2);
      expect(emitted.every((e) => e.onBehalfOf === OWNER && e.credentialId === SERVICE_KEY)).toBe(true);
    });
  });
});
