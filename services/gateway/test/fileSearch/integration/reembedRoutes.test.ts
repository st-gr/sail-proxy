/**
 * The re-embed routes through HTTP (grounding phase 4a, Task 4) against a real pgvector: the real
 * grounding router with the real service-key, acting-user and admin-guard middleware (only the
 * key validation itself is stubbed), the real re-embed engine and SQL. Shows that an owner starts
 * a re-embed and sees the job, that a non-owner of a shared store gets the unknown-store 404, that
 * an admin re-embeds another owner's store as that owner, that admin cancel and retry take
 * re-embed jobs only, the store objects' embedding fields, the overview count, and that the
 * OpenAI-shaped /v1 store objects are unchanged.
 */
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import { EMBED_DIM, seedStore, seedFile, jobRow } from './reembedFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const OWNER = 'routes-owner@example.test';
const OTHER = 'routes-other@example.test';
const ADMIN = 'routes-admin@example.test';
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
// eslint-disable-next-line import/first
import { createBatch } from '../../../src/fileSearch/batches';

const SERVICE_KEY = 'sk-' + 'c3'.repeat(24);
const OPENAI_STORE_KEYS = [
  'created_at', 'expires_after', 'expires_at', 'file_counts', 'id', 'last_active_at', 'metadata', 'name', 'object',
  'status', 'usage_bytes',
];

function config(): any {
  return {
    enabled: true,
    embeddingModel: 'model-b',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: false, candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 1, extractTimeoutMs: 5000, maxRetries: 3 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

function groundingApp(): express.Application {
  const app = express();
  app.use(express.json());
  mountGroundingRoutes(app);
  return app;
}

/** The OpenAI-shaped table as /v1 serves it, with the caller's key already resolved. */
function v1App(email: string): express.Application {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.apiKeyInfo = { email, keyId: 'k-client' }; next(); });
  const router = express.Router();
  registerVectorStoreRoutes(router, '/v1/vector_stores', []);
  app.use(router);
  return app;
}

d('re-embed routes through HTTP (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const app = () => groundingApp();
  const as = (email: string, role: 'user' | 'admin', r: request.Test) =>
    r.set('X-API-Key', SERVICE_KEY).set({ 'X-Grounding-Acting-Email': email, 'X-Grounding-Acting-Role': role });

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
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  it('the owner estimates, starts a re-embed, sees the job in Jobs and on the store object', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 3, tokensPerChunk: 5 });

    const estimate = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}/reembed/estimate`));
    expect(estimate.status).toBe(200);
    expect(estimate.body).toEqual({ files: 2, chunks: 6, estimated_tokens: 30, state: 'outdated' });

    const started = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reembed`));
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ kind: 'reembed_store', store_id: storeId, state: 'queued', total: 2, started_by: OWNER });
    const jobId = started.body.id;
    // Stamped like a batch: the acting user and the admin service key's credential (Decision 14).
    expect(await jobRow(pool, jobId)).toMatchObject({ owner_email: OWNER, started_by: OWNER, credential_id: SERVICE_KEY_ID, auth_type: 'api_key' });

    const jobs = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/jobs`));
    expect(jobs.body.data.map((j: any) => [j.id, j.kind])).toEqual([[jobId, 'reembed_store']]);

    const store = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}`));
    expect(store.body).toMatchObject({
      id: storeId, embedding_model: 'model-a', embedding_dim: EMBED_DIM, active_generation: 0,
      embedding_state: 'outdated', reembed_job_id: jobId,
    });

    const again = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reembed`));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('reembed_running');

    // The owner's cancel takes the re-embed kind; the store stays on its old generation.
    const cancelled = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/jobs/${jobId}/cancel`));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    const after = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}`));
    expect(after.body).toMatchObject({ embedding_model: 'model-a', active_generation: 0, reembed_job_id: null });
  });

  it('refuses a current store, a dimension mismatch and an expired store with 409 and the engine\'s code', async () => {
    const current = await seedStore(pool, { owner: OWNER, model: 'model-b' });
    const otherDim = await seedStore(pool, { owner: OWNER, model: 'model-a', dim: 8 });
    const expired = await seedStore(pool, { owner: OWNER, model: 'model-a', status: 'expired' });
    for (const [id, code] of [[current.storeId, 'store_current'], [otherDim.storeId, 'store_dimension_mismatch'], [expired.storeId, 'store_expired']]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${id}/reembed`));
      expect([id, r.status, r.body.error?.code]).toEqual([id, 409, code]);
    }
  });

  it('a non-owner of a shared store gets the unknown-store 404 on estimate and re-embed, and nothing starts', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    await pool.query('UPDATE vector_stores SET is_shared = true WHERE id = $1', [storeId]);

    // The non-owner can read the shared store (with no job id of the owner's)...
    const read = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}`));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ owned: false, embedding_state: 'outdated', reembed_job_id: null });

    const unknown = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/vs_unknown/reembed/estimate`));
    const estimate = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${storeId}/reembed/estimate`));
    const start = await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reembed`));
    expect(unknown.status).toBe(404);
    expect(estimate.status).toBe(404);
    expect(start.status).toBe(404);
    expect(estimate.body).toEqual({ error: { ...unknown.body.error, message: `No such vector store: ${storeId}` } });
    expect(start.body).toEqual(estimate.body);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs')).rows[0].n).toBe(0);
  });

  it('a non-owner of a CURRENT, an EXPIRED and a RUNNING shared store gets exactly the unknown-store 404 (no refusal code leaks)', async () => {
    const current = await seedStore(pool, { owner: OWNER, model: 'model-b', files: 1 });
    const expired = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1, status: 'expired' });
    const running = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    await pool.query('UPDATE vector_stores SET is_shared = true WHERE id = ANY($1::text[])',
      [[current.storeId, expired.storeId, running.storeId]]);
    const started = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${running.storeId}/reembed`));
    expect(started.status).toBe(200);

    const unknown = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/vs_unknown/reembed/estimate`));
    expect(unknown.status).toBe(404);
    const unknownBodyFor = (id: string) => JSON.parse(JSON.stringify(unknown.body).split('vs_unknown').join(id));
    for (const id of [current.storeId, expired.storeId, running.storeId]) {
      // eslint-disable-next-line no-await-in-loop
      const estimate = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/stores/${id}/reembed/estimate`));
      // eslint-disable-next-line no-await-in-loop
      const start = await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${id}/reembed`));
      expect([id, estimate.status, estimate.body]).toEqual([id, 404, unknownBodyFor(id)]);
      expect([id, start.status, start.body]).toEqual([id, 404, unknownBodyFor(id)]);
    }
    // Only the owner's own start exists.
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs')).rows[0].n).toBe(1);
  });

  it('an admin reads the estimate of another owner\'s store; the user role is refused by the guard (ruling R12)', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 3, tokensPerChunk: 5 });
    const estimate = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/stores/${storeId}/reembed/estimate`));
    expect(estimate.status).toBe(200);
    expect(estimate.body).toEqual({ files: 2, chunks: 6, estimated_tokens: 30, state: 'outdated' });
    const unknown = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/stores/vs_unknown/reembed/estimate`));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('vector_store_not_found');
    const refused = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/admin/stores/${storeId}/reembed/estimate`));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('grounding_admin_required');
  });

  it('an admin re-embeds another owner\'s store as that owner; the user role is refused by the guard', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });

    const refused = await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/admin/stores/${storeId}/reembed`));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('grounding_admin_required');
    const refusedEstimate = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/admin/reembed-outdated/estimate`));
    expect(refusedEstimate.status).toBe(403);

    const started = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/stores/${storeId}/reembed`));
    expect(started.status).toBe(200);
    const jobId = started.body.id;
    expect(await jobRow(pool, jobId)).toMatchObject({ owner_email: OWNER, started_by: ADMIN, credential_id: SERVICE_KEY_ID });
    // The job shows in the owner's Jobs, started by the admin.
    const ownerJobs = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/jobs`));
    expect(ownerJobs.body.data.map((j: any) => [j.id, j.started_by])).toEqual([[jobId, ADMIN]]);
    // The admin rows name the job of any owner.
    const rows = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/stores`));
    expect(rows.body.data.find((s: any) => s.id === storeId)).toMatchObject({ owned: false, reembed_job_id: jobId, embedding_state: 'outdated' });

    const unknown = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/stores/vs_unknown/reembed`));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('vector_store_not_found');
  });

  it('admin cancel and retry take re-embed jobs of any owner, and a file_batch job is a 404', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const batchStore = await seedStore(pool, { owner: OWNER, model: 'model-b' });
    const batch = await createBatch(batchStore.storeId, [await seedFile(pool, OWNER)], null, null, {});
    const batchJob = (await pool.query('SELECT id FROM fs_jobs WHERE batch_id = $1', [batch.id])).rows[0].id;

    for (const action of ['cancel', 'retry']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/jobs/${batchJob}/${action}`));
      expect([action, r.status, r.body.error?.code]).toEqual([action, 404, 'not_found']);
    }
    expect((await pool.query('SELECT cancel_requested FROM vector_store_batches WHERE id = $1', [batch.id])).rows[0].cancel_requested).toBe(false);

    const started = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reembed`));
    const jobId = started.body.id;
    const retryRunning = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/jobs/${jobId}/retry`));
    expect(retryRunning.status).toBe(409);
    expect(retryRunning.body.error.code).toBe('job_running');
    const cancelled = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/jobs/${jobId}/cancel`));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id: jobId, state: 'cancelled', owner_email: OWNER });
  });

  it('the bulk estimate and start cover every owner; the parent is the admin\'s; the overview counts outdated stores', async () => {
    const a = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1, chunksPerFile: 2, tokensPerChunk: 4 });
    const b = await seedStore(pool, { owner: OTHER, model: 'model-a', files: 1, chunksPerFile: 1, tokensPerChunk: 4 });
    const mismatch = await seedStore(pool, { owner: OTHER, model: 'model-a', dim: 8 });
    await seedStore(pool, { owner: OTHER, model: 'model-b' });

    const overview = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/overview`));
    expect(overview.body.outdated_stores).toBe(2);

    const estimate = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/reembed-outdated/estimate`));
    expect(estimate.status).toBe(200);
    expect(estimate.body).toEqual({
      stores: 2, files: 2, chunks: 3, estimated_tokens: 12,
      skipped: [{ store_id: mismatch.storeId, owner_email: OTHER, reason: 'dimension_mismatch' }],
    });

    const started = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/reembed-outdated`));
    expect(started.status).toBe(200);
    expect(started.body.job).toMatchObject({ kind: 'reembed_bulk', store_id: null, total: 2 });
    expect(started.body.skipped).toEqual(estimate.body.skipped);
    const adminJobs = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/jobs`));
    expect(adminJobs.body.data.map((j: any) => j.id)).toEqual([started.body.job.id]);
    // Ruling R10: the same e-mail acting as role user (a demoted admin) no longer controls the parent.
    for (const action of ['cancel', 'retry']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await as(ADMIN, 'user', request(app()).post(`${GROUNDING_PATH}/jobs/${started.body.job.id}/${action}`));
      expect([action, r.status, r.body.error?.code]).toEqual([action, 404, 'not_found']);
    }
    expect((await jobRow(pool, started.body.job.id)).cancel_requested).toBe(false);
    const children = await pool.query('SELECT store_id, owner_email FROM fs_jobs WHERE parent_id = $1 ORDER BY store_id', [started.body.job.id]);
    expect(children.rows).toEqual([
      { store_id: a.storeId, owner_email: OWNER }, { store_id: b.storeId, owner_email: OTHER },
    ].sort((x, y) => x.store_id.localeCompare(y.store_id)));

    const nothing = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/reembed-outdated`));
    expect(nothing.status).toBe(409);
    expect(nothing.body.error.code).toBe('nothing_to_reembed');
  });

  /** Fails `fileIds`' items of `jobId` with a stored error that carries more than the sanitised message. */
  async function failItems(jobId: string, fileIds: string[]): Promise<void> {
    await pool.query(
      `UPDATE fs_reembed_items SET status = 'failed', attempts = 3, claimed_at = NULL,
              last_error = jsonb_build_object('message', 'Embedding failed for ' || file_id, 'name', 'EmbeddingError', 'stack', 'at secret.ts:1')
        WHERE job_id = $1 AND file_id = ANY($2::text[])`, [jobId, fileIds]);
  }
  const FAILURE_KEYS = ['attempts', 'file_id', 'filename', 'id', 'job_id', 'last_error', 'store_id', 'store_name'];

  it('failures of a re-embed job: the owner and an admin read them; a non-owner gets the unknown-job 404; paged (review focus 5)', async () => {
    const { storeId, fileIds } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 3 });
    await pool.query("UPDATE vector_stores SET name = 'Owner docs', is_shared = true WHERE id = $1", [storeId]);
    const started = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reembed`));
    const jobId = started.body.id;
    const failed = [...fileIds].sort().slice(0, 2);
    await failItems(jobId, failed);
    const path = `${GROUNDING_PATH}/jobs/${jobId}/failures`;

    const own = await as(OWNER, 'user', request(app()).get(path));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ object: 'list', has_more: false, first_id: `${jobId}/${failed[0]}`, last_id: `${jobId}/${failed[1]}` });
    expect(own.body.data).toEqual(failed.map((fileId) => ({
      id: `${jobId}/${fileId}`, job_id: jobId, store_id: storeId, store_name: 'Owner docs', file_id: fileId, filename: 'doc.txt',
      last_error: { message: `Embedding failed for ${fileId}` }, attempts: 3,
    })));
    for (const row of own.body.data) expect(Object.keys(row).sort()).toEqual(FAILURE_KEYS);
    // Never chunk text (the fixture's chunks read "<file_id> chunk <n>") and never the stored error's other fields.
    expect(JSON.stringify(own.body)).not.toMatch(/chunk|stack|secret|EmbeddingError/);

    // Paging: limit 1, then after the first page's last_id.
    const first = await as(OWNER, 'user', request(app()).get(`${path}?limit=1`));
    expect(first.body).toMatchObject({ has_more: true, last_id: `${jobId}/${failed[0]}` });
    const second = await as(OWNER, 'user', request(app()).get(`${path}?limit=1&after=${encodeURIComponent(first.body.last_id)}`));
    expect(second.body.data.map((r: any) => r.file_id)).toEqual([failed[1]]);
    expect(second.body.has_more).toBe(false);
    const badLimit = await as(OWNER, 'user', request(app()).get(`${path}?limit=101`));
    expect([badLimit.status, badLimit.body.error.code]).toEqual([400, 'invalid_limit']);
    const badCursor = await as(OWNER, 'user', request(app()).get(`${path}?after=nocursor`));
    expect([badCursor.status, badCursor.body.error.code]).toEqual([400, 'invalid_parameter']);
    const bracketed = await as(OWNER, 'user', request(app()).get(`${path}?after[a]=1&limit[b]=2`));
    expect(bracketed.status).toBe(200);

    // A non-owner (the store is even shared): exactly the unknown-job 404.
    const unknown = await as(OTHER, 'user', request(app()).get(`${GROUNDING_PATH}/jobs/job_unknown/failures`));
    const foreign = await as(OTHER, 'user', request(app()).get(path));
    expect(unknown.status).toBe(404);
    expect([foreign.status, foreign.body]).toEqual([404, unknown.body]);

    // The admin route: any owner's re-embed job for an admin, the guard's 403 for a user.
    const admin = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/jobs/${jobId}/failures`));
    expect(admin.status).toBe(200);
    expect(admin.body.data).toEqual(own.body.data);
    const refused = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/admin/jobs/${jobId}/failures`));
    expect([refused.status, refused.body.error.code]).toEqual([403, 'grounding_admin_required']);
  });

  it('failures: a file_batch job is the unknown-job 404 on both routes', async () => {
    const batchStore = await seedStore(pool, { owner: OWNER, model: 'model-b' });
    const batch = await createBatch(batchStore.storeId, [await seedFile(pool, OWNER)], null, null, {});
    const batchJob = (await pool.query('SELECT id FROM fs_jobs WHERE batch_id = $1', [batch.id])).rows[0].id;
    const unknown = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/jobs/job_unknown/failures`));
    const adminBatch = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/jobs/${batchJob}/failures`));
    const ownBatch = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/jobs/${batchJob}/failures`));
    expect(unknown.status).toBe(404);
    expect([adminBatch.status, adminBatch.body]).toEqual([404, unknown.body]);
    expect([ownBatch.status, ownBatch.body]).toEqual([404, unknown.body]);
  });

  it('failures of a bulk parent list its children\'s failed items with their stores; the user route needs the role admin (R10)', async () => {
    const a = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const b = await seedStore(pool, { owner: OTHER, model: 'model-a', files: 2 });
    await pool.query("UPDATE vector_stores SET name = 'Store ' || owner_email WHERE id = ANY($1::text[])", [[a.storeId, b.storeId]]);
    const started = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/admin/reembed-outdated`));
    const parentId = started.body.job.id;
    const children = (await pool.query('SELECT id, store_id FROM fs_jobs WHERE parent_id = $1', [parentId])).rows;
    const childOf = (storeId: string) => children.find((c: any) => c.store_id === storeId).id;
    await failItems(childOf(a.storeId), a.fileIds);
    await failItems(childOf(b.storeId), [b.fileIds[0]]);

    const viaUser = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/jobs/${parentId}/failures`));
    expect(viaUser.status).toBe(200);
    const expected = [
      { job_id: childOf(a.storeId), store_id: a.storeId, store_name: `Store ${OWNER}`, file_id: a.fileIds[0] },
      { job_id: childOf(b.storeId), store_id: b.storeId, store_name: `Store ${OTHER}`, file_id: b.fileIds[0] },
    ].sort((x, y) => x.job_id.localeCompare(y.job_id));
    expect(viaUser.body.data.map((r: any) => ({ job_id: r.job_id, store_id: r.store_id, store_name: r.store_name, file_id: r.file_id })))
      .toEqual(expected);
    const viaAdmin = await as(ADMIN, 'admin', request(app()).get(`${GROUNDING_PATH}/admin/jobs/${parentId}/failures`));
    expect(viaAdmin.body.data).toEqual(viaUser.body.data);

    // The same e-mail acting as role user (a demoted admin): the unknown-job 404.
    const unknown = await as(ADMIN, 'user', request(app()).get(`${GROUNDING_PATH}/jobs/job_unknown/failures`));
    const demoted = await as(ADMIN, 'user', request(app()).get(`${GROUNDING_PATH}/jobs/${parentId}/failures`));
    expect([demoted.status, demoted.body]).toEqual([404, unknown.body]);
    // A child's owner reads their own child's failures only, never the parent's.
    const ownerParent = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/jobs/${parentId}/failures`));
    expect(ownerParent.status).toBe(404);
    const ownerChild = await as(OWNER, 'user', request(app()).get(`${GROUNDING_PATH}/jobs/${childOf(a.storeId)}/failures`));
    expect(ownerChild.body.data.map((r: any) => r.file_id)).toEqual([a.fileIds[0]]);
  });

  it('the OpenAI-shaped /v1 store objects carry none of the new fields, also while a re-embed runs', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/${storeId}/reembed`));

    const one = await request(v1App(OWNER)).get(`/v1/vector_stores/${storeId}`);
    expect(one.status).toBe(200);
    expect(Object.keys(one.body).sort()).toEqual(OPENAI_STORE_KEYS);
    const list = await request(v1App(OWNER)).get('/v1/vector_stores');
    expect(Object.keys(list.body.data[0]).sort()).toEqual(OPENAI_STORE_KEYS);
    const created = await request(v1App(OWNER)).post('/v1/vector_stores').send({ name: 'Fresh' });
    expect(Object.keys(created.body).sort()).toEqual(OPENAI_STORE_KEYS);
  });
});
