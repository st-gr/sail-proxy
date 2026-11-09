/**
 * Quota on the cockpit's paid grounding work (W8 Task 1) through HTTP against a real pgvector:
 * the real grounding router and handlers, the real SQL, the real owner admission on a Valkey double
 * holding the quota state documents. Over quota, every route that starts paid work answers 429
 * before any store, attachment, batch, job or embedding exists; under quota nothing changes; work
 * queued before the owner went over still finishes; the admin maintenance routes are exempt; a
 * search is checked against the searcher, who pays for it. No SAP: the embedder is a fake.
 */
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import { EMBED_DIM, seedStore, seedFile, vectorOf, jobRow } from './reembedFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const OWNER = 'quota-owner@example.test';
const OTHER = 'quota-other@example.test';
const ADMIN = 'quota-admin@example.test';
const SERVICE_KEY_ID = 'k-admin-service';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  default: { getFileSearchConfig: () => mockConfig },
  getTrustForwardedFor: () => false,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
}));
jest.mock('../../../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: () => false,
  shouldEnableDistributedCaching: () => false,
  getCachedUnifiedAuthConfig: () => ({}),
}));
const validateApiKey = jest.fn<any, any[]>();
jest.mock('../../../src/services/unifiedApiKeyValidationService', () => ({
  __esModule: true,
  unifiedApiKeyValidationService: { validateApiKey: (...a: any[]) => validateApiKey(...a) },
}));
jest.mock('../../../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitQuotaExceeded: jest.fn(async () => undefined), emitQuotaUnenforced: jest.fn(async () => undefined) },
}));
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: jest.fn(),
}));

// eslint-disable-next-line import/first
import { SERVICE_KEYS } from '@libs/service-auth';
// eslint-disable-next-line import/first
import { mountGroundingRoutes, GROUNDING_PATH } from '../../../src/routes/groundingRoutes';
// eslint-disable-next-line import/first
import { configureQuotaEnforcement } from '../../../src/middlewares/quotaEnforcement';
// eslint-disable-next-line import/first
import { quotaKeyFor } from '../../../src/services/quotaStateReader';
// eslint-disable-next-line import/first
import { processOne } from '../../../src/fileSearch/ingestWorker';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { embed } = require('../../../src/fileSearch/embedder');

const SERVICE_KEY = 'sk-' + 'e6'.repeat(24);
const STRUCTURE = { type: 'structure', max_tokens: 400, overlap_tokens: 0, contextual: false };

function config(): any {
  return {
    enabled: true,
    embeddingModel: 'model-a',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: false, candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 1, extractTimeoutMs: 5000, maxRetries: 3 },
    chunking: { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false },
    contextual: { model: 'fake-context-model', maxDocumentTokens: 32000, maxInputTokensPerFile: 20_000_000 },
    parsing: { ocr: { languages: ['eng'] } },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

/** A state document the admission reads as current: today's tokens against a day limit of 1000. */
function stateDoc(email: string, dayTokens: number): any {
  const n = new Date();
  const day = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  const iso = (t: number) => new Date(t).toISOString();
  const zero = { requests: 0, tokens: 0, sapCost: 0 };
  return {
    email, status: 'active',
    limits: { requestsPerMinute: null, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: 1000, tokensPerWeek: null, tokensPerMonth: null },
    used: { day: { requests: 1, tokens: dayTokens, sapCost: 0 }, week: zero, month: zero },
    windowStart: { day: iso(day), week: iso(day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000), month: iso(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)) },
    quotaResetAt: null, updatedAt: n.toISOString(),
  };
}
/** A fresh reader each time (the reader caches a document for ten seconds). */
function setQuotas(over: string[], under: string[] = []): void {
  const docs: Record<string, string> = {};
  for (const e of over) docs[quotaKeyFor(e)] = JSON.stringify(stateDoc(e, 1000));
  for (const e of under) docs[quotaKeyFor(e)] = JSON.stringify(stateDoc(e, 10));
  configureQuotaEnforcement({ valkeyClient: { status: 'ready', get: async (k: string) => docs[k] ?? null } });
}

function groundingApp(): express.Application {
  const app = express();
  app.use(express.json());
  mountGroundingRoutes(app);
  return app;
}

d('quota on the cockpit\'s paid grounding work (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const app = () => groundingApp();
  const as = (email: string, role: 'user' | 'admin', r: request.Test) =>
    r.set('X-API-Key', SERVICE_KEY).set({ 'X-Grounding-Acting-Email': email, 'X-Grounding-Acting-Role': role });
  const count = async (table: string) => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  const counts = async () => ({
    stores: await count('vector_stores'), attached: await count('vector_store_files'), batches: await count('vector_store_batches'),
    jobs: await count('fs_jobs'), items: await count('fs_reembed_items'), files: await count('fs_files'), blobs: await count('file_blobs'),
  });

  beforeAll(async () => {
    mockConfig = config();
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

  beforeEach(async () => {
    mockConfig = config();
    validateApiKey.mockReset();
    validateApiKey.mockResolvedValue({
      valid: true,
      data: { keyId: SERVICE_KEY_ID, name: SERVICE_KEYS.ADMIN_TO_GATEWAY.NAME, email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL, permissions: [] },
    });
    embed.mockReset();
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map(() => vectorOf('model-a')),
      usage: { promptTokens: texts.length * 10, totalTokens: texts.length * 10 },
    }));
    for (const table of ['fs_reembed_items', 'fs_jobs', 'vector_store_chunks', 'vector_store_batches', 'vector_store_files',
      'vector_stores', 'fs_files', 'file_blobs']) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`DELETE FROM ${table}`);
    }
  });

  it('over quota: every route that starts paid work answers 429 and nothing is created, queued or embedded', async () => {
    const { storeId, fileIds } = await seedStore(pool, { owner: OWNER, model: 'model-b', files: 2 });
    const loose = await seedFile(pool, OWNER);
    // a failed file and a finished file batch, so the retries have something to re-open
    await pool.query(`UPDATE vector_store_files SET status = 'failed' WHERE store_id = $1 AND file_id = $2`, [storeId, fileIds[0]]);
    await pool.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, started_by, store_id) VALUES ('job_failed', 'reembed_store', $1, $1, $2)`, [OWNER, storeId]);
    setQuotas([OWNER]);
    const before = await counts();

    const refused = [
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`).send({ name: 'With files', file_ids: [loose] })),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/files`).send({ file_id: loose })),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/file_batches`).send({ file_ids: [loose] })),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/search`).send({ query: 'anything' })),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reembed`)),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`).send({ chunking: STRUCTURE })),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reextract`)),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/files/${fileIds[0]}/retry`)),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/jobs/job_failed/retry`)),
    ];
    for (const r of refused) {
      expect(r.status).toBe(429);
      expect(r.body.error).toMatchObject({ type: 'quota_exceeded', code: 'quota_exceeded', window: 'day', dimension: 'tokens', limit: 1000, used: 1000 });
    }
    expect(await counts()).toEqual(before);
    expect((await pool.query(`SELECT status FROM vector_store_files WHERE file_id = $1`, [fileIds[0]])).rows[0].status).toBe('failed');
    expect(embed).not.toHaveBeenCalled();

    // the same owner under quota: unchanged behaviour
    setQuotas([], [OWNER]);
    const attached = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/files`).send({ file_id: loose }));
    expect(attached.status).toBe(200);
    expect(attached.body).toMatchObject({ object: 'vector_store.file', status: 'in_progress' });
  });

  it('work queued under quota finishes after the owner goes over it; new work is refused', async () => {
    setQuotas([], [OWNER]);
    const store = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`).send({ name: 'Docs' }));
    expect(store.status).toBe(200);
    const uploaded = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/files`)
      .field('purpose', 'assistants').attach('file', Buffer.from('quota test text '.repeat(40)), 'doc.txt'));
    expect(uploaded.status).toBe(200);
    const attached = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${store.body.id}/files`).send({ file_id: uploaded.body.id }));
    expect(attached.status).toBe(200);

    setQuotas([OWNER]);
    await processOne(store.body.id, uploaded.body.id);
    const row = await pool.query('SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [store.body.id, uploaded.body.id]);
    expect(row.rows[0].status).toBe('completed');
    expect(embed).toHaveBeenCalled();

    const second = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/files`)
      .field('purpose', 'assistants').attach('file', Buffer.from('another text'), 'more.txt'));
    expect(second.status).toBe(200); // an upload is no paid work
    const refused = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${store.body.id}/files`).send({ file_id: second.body.id }));
    expect(refused.status).toBe(429);
  });

  it('the admin maintenance routes are exempt: an admin re-chunks an over-quota owner\'s store while both are over quota', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    setQuotas([OWNER, ADMIN]);
    const started = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/stores/${storeId}/chunking`).send({ chunking: STRUCTURE }));
    expect(started.status).toBe(200);
    expect(await jobRow(pool, started.body.id)).toMatchObject({ owner_email: OWNER, started_by: ADMIN });
  });

  it('search is checked against the searcher: a non-owner over quota is refused, one under quota searches an over-quota owner\'s store', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    await pool.query('UPDATE vector_stores SET is_shared = true WHERE id = $1', [storeId]);

    setQuotas([ADMIN, OTHER], [OWNER]);
    for (const [who, role] of [[ADMIN, 'admin'], [OTHER, 'user']] as const) {
      // eslint-disable-next-line no-await-in-loop
      const r = await as(who, role, request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/search`).send({ query: 'chunk' }));
      expect([who, r.status]).toEqual([who, 429]);
    }
    expect(embed).not.toHaveBeenCalled();

    setQuotas([OWNER], [ADMIN, OTHER]);
    for (const [who, role] of [[ADMIN, 'admin'], [OTHER, 'user']] as const) {
      // eslint-disable-next-line no-await-in-loop
      const r = await as(who, role, request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/search`).send({ query: 'chunk' }));
      expect([who, r.status, r.body.object]).toEqual([who, 200, 'vector_store.search_results.page']);
    }
  });
});
