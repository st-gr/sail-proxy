/**
 * The chunking routes through HTTP (W2 Task 6) against a real pgvector: the real grounding router
 * with the real service-key, acting-user and admin-guard middleware (only the key validation is
 * stubbed), the real re-chunk engine and SQL. The grounding create writes the body's `chunking`
 * (the /v1 create ignores it); the owner estimates and starts a re-chunk; a second start, the
 * store's own setting and an invalid setting are refused; a non-owner of a shared store gets the
 * unknown-store 404; an admin estimates and re-chunks another owner's store as that owner; the
 * user role is refused on the admin routes.
 */
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import { EMBED_DIM, seedStore, jobRow } from './reembedFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const OWNER = 'chunk-owner@example.test';
const OTHER = 'chunk-other@example.test';
const ADMIN = 'chunk-admin@example.test';
const SERVICE_KEY_ID = 'k-admin-service';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  default: {},
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
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: jest.fn(async () => { throw new Error('no embedding in the route suite'); }),
}));

// eslint-disable-next-line import/first
import { SERVICE_KEYS } from '@libs/service-auth';
// eslint-disable-next-line import/first
import { mountGroundingRoutes, GROUNDING_PATH } from '../../../src/routes/groundingRoutes';
// eslint-disable-next-line import/first
import { registerVectorStoreRoutes } from '../../../src/routes/vectorStoreRouteTable';

const SERVICE_KEY = 'sk-' + 'c4'.repeat(24);
const STRUCTURE = { type: 'structure', max_tokens: 400, overlap_tokens: 0, contextual: true };
const LEGACY = { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false };

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

function groundingApp(): express.Application {
  const app = express();
  app.use(express.json());
  mountGroundingRoutes(app);
  return app;
}

function v1App(email: string): express.Application {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.apiKeyInfo = { email, keyId: 'k-client' }; next(); });
  const router = express.Router();
  registerVectorStoreRoutes(router, '/v1/vector_stores', []);
  app.use(router);
  return app;
}

const estimateQuery = (s: Record<string, unknown>) => new URLSearchParams(
  Object.entries(s).map(([k, v]): [string, string] => [k, String(v)]),
).toString();

d('chunking routes through HTTP (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const app = () => groundingApp();
  const as = (email: string, role: 'user' | 'admin', r: request.Test) =>
    r.set('X-API-Key', SERVICE_KEY).set({ 'X-Grounding-Acting-Email': email, 'X-Grounding-Acting-Role': role });
  const chunkingOf = async (storeId: string) =>
    (await pool.query('SELECT chunking FROM vector_stores WHERE id = $1', [storeId])).rows[0]?.chunking;

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
    for (const table of ['fs_reembed_items', 'fs_jobs', 'vector_store_chunks', 'vector_store_batches', 'vector_store_files',
      'vector_stores', 'fs_files', 'file_blobs']) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`DELETE FROM ${table}`);
    }
  });

  it('the grounding create writes the body\'s chunking and reports it on the store; an invalid one is a 400; /v1 ignores the field', async () => {
    const created = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`).send({ name: 'Docs', chunking: STRUCTURE }));
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ object: 'vector_store', name: 'Docs' });
    expect(created.body).not.toHaveProperty('chunking'); // the create answers the OpenAI store object
    expect(await chunkingOf(created.body.id)).toEqual(STRUCTURE);
    const read = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${created.body.id}`));
    expect(read.body.chunking).toEqual(STRUCTURE);

    // without the field: the installation default
    const plain = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`).send({ name: 'Plain' }));
    expect(await chunkingOf(plain.body.id)).toEqual(LEGACY);

    const invalid = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`)
      .send({ name: 'Bad', chunking: { type: 'structure', max_tokens: 50, overlap_tokens: 0 } }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({ type: 'invalid_request_error', param: 'chunking.max_tokens', code: 'invalid_value' });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM vector_stores WHERE name = 'Bad'`)).rows[0].n).toBe(0);

    const v1 = await request(v1App(OWNER)).post('/v1/vector_stores').send({ name: 'Api', chunking: STRUCTURE });
    expect(v1.status).toBe(200);
    expect(await chunkingOf(v1.body.id)).toEqual(LEGACY);
    const v1Invalid = await request(v1App(OWNER)).post('/v1/vector_stores').send({ name: 'Api2', chunking: { type: 'bogus' } });
    expect(v1Invalid.status).toBe(200); // not an OpenAI field: ignored
  });

  it('the owner estimates and starts a re-chunk; a second start, the store\'s own setting and an invalid setting are refused', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 3, tokensPerChunk: 500 });
    const estimate = await as(OWNER, 'user', request(app())
      .get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?${estimateQuery(STRUCTURE)}`));
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({
      store_id: storeId, current: LEGACY, target: STRUCTURE, unchanged: false, running_job_id: null, files: 2,
      current_chunks: 6, embedding_model: 'model-a', context_model: 'fake-context-model',
    });
    for (const key of ['estimated_chunks', 'estimated_embedding_tokens', 'estimated_context_input_tokens', 'estimated_context_output_tokens']) {
      expect(estimate.body[key]).toBeGreaterThan(0);
    }

    const badQuery = await as(OWNER, 'user', request(app())
      .get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?type=structure&max_tokens=abc&overlap_tokens=0`));
    expect(badQuery.status).toBe(400);
    expect(badQuery.body.error).toMatchObject({ param: 'chunking.max_tokens', code: 'invalid_type' });
    const bracketed = await as(OWNER, 'user', request(app())
      .get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?type[a]=1&max_tokens=400&overlap_tokens=0`));
    expect(bracketed.status).toBe(400);
    const contextualStatic = await as(OWNER, 'user', request(app())
      .get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?type=static&max_tokens=400&overlap_tokens=0&contextual=true`));
    expect(contextualStatic.status).toBe(400);

    const invalid = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`).send({ chunking: 'x' }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({ param: 'chunking', code: 'invalid_type' });
    const same = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`).send({ chunking: LEGACY }));
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('chunking_current');

    const started = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`).send({ chunking: STRUCTURE }));
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ kind: 'reembed_store', store_id: storeId, state: 'queued', total: 2, target_chunking: STRUCTURE });
    expect(await jobRow(pool, started.body.id)).toMatchObject({
      owner_email: OWNER, started_by: OWNER, credential_id: SERVICE_KEY_ID, target_model: 'model-a', target_chunking: STRUCTURE,
    });
    const again = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`)
      .send({ chunking: { ...STRUCTURE, max_tokens: 500 } }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('reembed_running');
    // the store object and the estimate name the running job; the store's setting is unchanged until the switch
    const read = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}`));
    expect(read.body).toMatchObject({ reembed_job_id: started.body.id, chunking: null });
    const during = await as(OWNER, 'user', request(app())
      .get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?${estimateQuery(STRUCTURE)}`));
    expect(during.body.running_job_id).toBe(started.body.id);
    // the owner cancels through the job routes; the setting stays
    const cancelled = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/jobs/${started.body.id}/cancel`));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    expect(await chunkingOf(storeId)).toBeNull();
  });

  it('a non-owner of a shared store gets the unknown-store 404 on estimate and start, and nothing starts', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    await pool.query('UPDATE vector_stores SET is_shared = true WHERE id = $1', [storeId]);
    const q = estimateQuery(STRUCTURE);
    const unknown = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/vs_unknown/chunking/estimate?${q}`));
    const estimate = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?${q}`));
    const start = await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`).send({ chunking: STRUCTURE }));
    expect(unknown.status).toBe(404);
    expect(estimate.status).toBe(404);
    expect(start.status).toBe(404);
    expect(estimate.body).toEqual({ error: { ...unknown.body.error, message: `No such vector store: ${storeId}` } });
    expect(start.body).toEqual(estimate.body);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs')).rows[0].n).toBe(0);
  });

  it('an admin estimates and re-chunks another owner\'s store as that owner; the user role is refused by the guard', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const q = estimateQuery(STRUCTURE);
    const refusedEstimate = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/admin/stores/${storeId}/chunking/estimate?${q}`));
    const refusedStart = await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/admin/stores/${storeId}/chunking`)
      .send({ chunking: STRUCTURE }));
    expect([refusedEstimate.status, refusedStart.status]).toEqual([403, 403]);
    expect(refusedStart.body.error.code).toBe('grounding_admin_required');

    const estimate = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/stores/${storeId}/chunking/estimate?${q}`));
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({ store_id: storeId, files: 1, target: STRUCTURE });
    const started = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/stores/${storeId}/chunking`)
      .send({ chunking: STRUCTURE }));
    expect(started.status).toBe(200);
    expect(await jobRow(pool, started.body.id)).toMatchObject({ owner_email: OWNER, started_by: ADMIN, credential_id: SERVICE_KEY_ID });
    const ownerJobs = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/jobs`));
    expect(ownerJobs.body.data.map((j: any) => [j.id, j.started_by, j.target_chunking])).toEqual([[started.body.id, ADMIN, STRUCTURE]]);

    for (const r of [
      request(app()).get(`${GROUNDING_PATH}/admin/stores/vs_unknown/chunking/estimate?${q}`),
      request(app()).post(`${GROUNDING_PATH}/admin/stores/vs_unknown/chunking`).send({ chunking: STRUCTURE }),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const unknown = await as(ADMIN, 'admin', r);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe('vector_store_not_found');
    }
  });

  it('vision passes through create, estimate and start: validated (400), refused where vision is switched off (400 create, 409 start)', async () => {
    const VISION = { ...STRUCTURE, vision: 'auto' };
    const created = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`).send({ name: 'Scans', chunking: VISION }));
    expect(created.status).toBe(200);
    expect(await chunkingOf(created.body.id)).toEqual(VISION);
    const badCreate = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`)
      .send({ name: 'Bad', chunking: { ...STRUCTURE, vision: 'sometimes' } }));
    expect(badCreate.status).toBe(400);
    expect(badCreate.body.error).toMatchObject({ param: 'chunking.vision', code: 'invalid_value' });

    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1, chunksPerFile: 2, tokensPerChunk: 300 });
    const estimate = await as(OWNER, 'user', request(app())
      .get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?${estimateQuery(VISION)}`));
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({
      target: VISION, unchanged: false, vision_model: 'gemini-3.5-flash-lite', vision_files: 0, estimated_vision_pages: 0,
      vision_switched_off: false, vision_unmasked_warning: false,
    });
    const badEstimate = await as(OWNER, 'user', request(app())
      .get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?${estimateQuery({ ...STRUCTURE, vision: 'everything' })}`));
    expect(badEstimate.status).toBe(400);
    expect(badEstimate.body.error).toMatchObject({ param: 'chunking.vision', code: 'invalid_value' });
    const badStart = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`)
      .send({ chunking: { ...STRUCTURE, vision: 3 } }));
    expect(badStart.status).toBe(400);
    expect(badStart.body.error).toMatchObject({ param: 'chunking.vision', code: 'invalid_type' });

    process.env.FILE_SEARCH_VISION = 'off';
    try {
      const off = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`).send({ chunking: VISION }));
      expect(off.status).toBe(409);
      expect(off.body.error.code).toBe('vision_model_unavailable');
      expect(off.body.error.message).toMatch(/vision/i);
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs')).rows[0].n).toBe(0);
      const switchedOff = await as(OWNER, 'user', request(app())
        .get(`${GROUNDING_PATH}/stores/${storeId}/chunking/estimate?${estimateQuery(VISION)}`));
      expect(switchedOff.body.vision_switched_off).toBe(true);
      const createOff = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`).send({ name: 'Off', chunking: VISION }));
      expect(createOff.status).toBe(400);
      expect(createOff.body.error).toMatchObject({ param: 'chunking.vision', code: 'invalid_value' });
      // without vision the start is not affected by the switch
      const plain = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/chunking`).send({ chunking: STRUCTURE }));
      expect(plain.status).toBe(200);
    } finally {
      delete process.env.FILE_SEARCH_VISION;
    }
  });

  it('re-extract: the owner and an admin estimate and start it; nothing to read is a 409; a non-owner and the user role are refused', async () => {
    const { storeId, fileIds } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 2, tokensPerChunk: 300 });
    // the first file is a PDF read before W3; the second a text file
    await pool.query(`UPDATE fs_files SET filename = 'scan.pdf' WHERE id = $1`, [fileIds[0]]);
    const estimate = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}/reextract/estimate`));
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({
      store_id: storeId, setting: LEGACY, files: 1, kept_files: 1, current_chunks: 2, retry_files: 0, running_job_id: null,
      context_model: null, vision_model: null,
    });
    expect(estimate.body.estimated_embedding_tokens).toBeGreaterThan(0);

    // a non-owner of the shared store: the unknown-store 404, nothing starts
    await pool.query('UPDATE vector_stores SET is_shared = true WHERE id = $1', [storeId]);
    const foreign = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}/reextract/estimate`));
    const foreignStart = await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reextract`));
    expect([foreign.status, foreignStart.status]).toEqual([404, 404]);
    expect(foreignStart.body.error.code).toBe('vector_store_not_found');
    // the user role on the admin routes
    const guarded = await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/admin/stores/${storeId}/reextract`));
    expect(guarded.status).toBe(403);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs')).rows[0].n).toBe(0);

    const started = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reextract`));
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      retried_files: 0, job: { kind: 'reembed_store', store_id: storeId, state: 'queued', total: 2, reextract: true, target_chunking: LEGACY },
    });
    expect(await jobRow(pool, started.body.job.id)).toMatchObject({ owner_email: OWNER, started_by: OWNER, credential_id: SERVICE_KEY_ID, reextract: true });
    const again = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reextract`));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('reembed_running');
    const cancelled = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/jobs/${started.body.job.id}/cancel`));
    expect(cancelled.body.state).toBe('cancelled');

    // the admin, as the owner
    const adminEstimate = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/stores/${storeId}/reextract/estimate`));
    expect(adminEstimate.status).toBe(200);
    expect(adminEstimate.body).toMatchObject({ store_id: storeId, files: 1 });
    const adminStart = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/stores/${storeId}/reextract`));
    expect(adminStart.status).toBe(200);
    expect(await jobRow(pool, adminStart.body.job.id)).toMatchObject({ owner_email: OWNER, started_by: ADMIN, reextract: true });
    const unknown = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/stores/vs_unknown/reextract/estimate`));
    expect(unknown.status).toBe(404);

    // a store with nothing to read again
    const { storeId: plain } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const nothing = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${plain}/reextract`));
    expect(nothing.status).toBe(409);
    expect(nothing.body.error).toMatchObject({ code: 'nothing_to_reextract' });
    expect(nothing.body.error.message).toMatch(/nothing to read again/);
  });

  it('the /v1 routes serve none of the chunking routes', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const estimate = await request(v1App(OWNER)).get(`/v1/vector_stores/${storeId}/chunking/estimate?${estimateQuery(STRUCTURE)}`);
    const start = await request(v1App(OWNER)).post(`/v1/vector_stores/${storeId}/chunking`).send({ chunking: STRUCTURE });
    expect(estimate.status).toBe(404);
    expect(start.status).toBe(404);
    const store = await request(v1App(OWNER)).get(`/v1/vector_stores/${storeId}`);
    expect(store.body).not.toHaveProperty('chunking');
  });
});
