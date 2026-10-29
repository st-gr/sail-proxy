// The blob migration's HTTP side, hermetic (engine mocked): the admin start handler's answers,
// and the job handlers (owner and admin cancel/retry/failures) dispatching a blob_migration job to
// the migration engine, admins only.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const dbState = { available: true };
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  isFileSearchAvailable: () => dbState.available,
  getPool: () => ({ query: jest.fn() })
}));
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({ enabled: true, embeddingModel: 'm', embeddingDimensions: 3, limits: { maxFileBytes: 1, maxFilesPerStore: 1 }, blobStorage: { backend: 'db' } })
}));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

const engine = {
  startBlobMigration: jest.fn<any>(), cancelBlobMigration: jest.fn<any>(), retryBlobMigration: jest.fn<any>(),
  listBlobMigrationFailures: jest.fn<any>()
};
jest.mock('../../src/fileSearch/blob/blobMigration', () => {
  const actual = jest.requireActual('../../src/fileSearch/blob/blobMigration') as any;
  const wrap = (name: keyof typeof engine) => (...a: any[]) => (engine[name] as any)(...a);
  return {
    __esModule: true, MIGRATION_TARGETS: actual.MIGRATION_TARGETS,
    startBlobMigration: wrap('startBlobMigration'), cancelBlobMigration: wrap('cancelBlobMigration'),
    retryBlobMigration: wrap('retryBlobMigration'), listBlobMigrationFailures: wrap('listBlobMigrationFailures')
  };
});
const panel = { blobStorageOverview: jest.fn<any>(), testS3Connection: jest.fn<any>() };
jest.mock('../../src/fileSearch/blob/blobAdmin', () => ({
  __esModule: true,
  blobStorageOverview: (...a: any[]) => panel.blobStorageOverview(...a),
  testS3Connection: (...a: any[]) => panel.testS3Connection(...a)
}));
const cancelReembed = jest.fn<any>();
const retryReembed = jest.fn<any>();
jest.mock('../../src/fileSearch/reembed', () => ({
  __esModule: true,
  cancelReembed: (...a: any[]) => cancelReembed(...a), retryReembed: (...a: any[]) => retryReembed(...a)
}));
const jobSummary = jest.fn<any>();
const jobSummaryAnyOwner = jest.fn<any>();
jest.mock('../../src/fileSearch/jobs', () => {
  const actual = jest.requireActual('../../src/fileSearch/jobs') as any;
  return {
    __esModule: true, ...actual,
    jobSummary: (...a: any[]) => jobSummary(...a),
    jobSummaryAnyOwner: (...a: any[]) => jobSummaryAnyOwner(...a)
  };
});
const listReembedFailures = jest.fn<any>();
jest.mock('../../src/fileSearch/reembedFailures', () => ({
  __esModule: true, listReembedFailures: (...a: any[]) => listReembedFailures(...a)
}));

import { adminStartBlobMigration, adminBlobStorage, adminTestBlobStorage } from '../../src/controllers/groundingBlobMigrationController';
import * as reembedCtrl from '../../src/controllers/groundingReembedController';
import * as groundingController from '../../src/controllers/groundingController';

const ADMIN = 'admin@test.com';
const USER = 'user@test.com';
const SHA = 'a'.repeat(64);

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}
async function call(handler: (req: any, res: any, next: any) => Promise<void>, email: string, overrides: Record<string, any> = {}) {
  const res = makeRes();
  const next = jest.fn();
  await handler({
    headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email },
    groundingActor: { email, role: email === ADMIN ? 'admin' : 'user' },
    serviceAuth: { authType: 'service-key', serviceKey: { id: 'svc-key-1', email: 'admin-service@test.com' } },
    ...overrides
  }, res, next);
  return { res, next };
}
const migrationJob = (extra: Record<string, unknown> = {}): any =>
  ({ id: 'job_m', kind: 'blob_migration', store_id: null, state: 'queued', total: 3, done: 0, failed: 0, cancelled: 0, in_progress: 3, ...extra });

beforeEach(() => {
  dbState.available = true;
  for (const fn of [...Object.values(engine), ...Object.values(panel), cancelReembed, retryReembed, jobSummary, jobSummaryAnyOwner, listReembedFailures]) fn.mockReset();
});

describe('adminStartBlobMigration (POST /admin/blob-storage/migrate)', () => {
  it('starts with the acting admin and the service key, and answers the job', async () => {
    engine.startBlobMigration.mockResolvedValue({ ok: true, job: migrationJob({ target_storage: 's3' }) });
    const { res } = await call(adminStartBlobMigration, ADMIN, { body: { target: 's3' } });
    expect(engine.startBlobMigration).toHaveBeenCalledWith('s3', { email: ADMIN, credentialId: 'svc-key-1', authType: 'api_key' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ job: migrationJob({ target_storage: 's3' }) });
  });

  it('answers job null when nothing is to be moved', async () => {
    engine.startBlobMigration.mockResolvedValue({ ok: false, error: 'nothing_to_migrate' });
    const { res } = await call(adminStartBlobMigration, ADMIN, { body: { target: 'db' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ job: null });
  });

  it.each([
    [{ ok: false, error: 'invalid_target' }, 400, {}],
    [{ ok: false, error: 'migration_running', job_id: 'job_m' }, 409, { job_id: 'job_m' }],
    [{ ok: false, error: 'target_unavailable', detail: { reason: 'request_failed', op: 'PutObject', status: 403 } }, 409,
      { detail: { reason: 'request_failed', op: 'PutObject', status: 403 } }],
  ])('maps the refusal %j to %i', async (refusal: any, status, extra) => {
    engine.startBlobMigration.mockResolvedValue(refusal);
    const { res } = await call(adminStartBlobMigration, ADMIN, { body: { target: 's3' } });
    expect(res.statusCode).toBe(status);
    expect(res.body).toMatchObject({ error: { code: refusal.error, type: 'invalid_request_error' }, ...extra });
  });

  it('a missing or non-string target reaches the engine as "" (invalid_target)', async () => {
    engine.startBlobMigration.mockResolvedValue({ ok: false, error: 'invalid_target' });
    await call(adminStartBlobMigration, ADMIN, { body: { target: ['s3'] } });
    expect(engine.startBlobMigration).toHaveBeenCalledWith('', expect.anything());
  });

  it('503 while file_search is unavailable, without calling the engine', async () => {
    dbState.available = false;
    const { res } = await call(adminStartBlobMigration, ADMIN, { body: { target: 's3' } });
    expect(res.statusCode).toBe(503);
    expect(engine.startBlobMigration).not.toHaveBeenCalled();
  });
});

describe('the blob storage panel handlers (GET /admin/blob-storage, POST /admin/blob-storage/test)', () => {
  it('answer the overview and the connection test as the engine returns them', async () => {
    panel.blobStorageOverview.mockResolvedValue({ configured_backend: 'db', storages: [] });
    const overview = await call(adminBlobStorage, ADMIN);
    expect(overview.res.statusCode).toBe(200);
    expect(overview.res.body).toEqual({ configured_backend: 'db', storages: [] });
    panel.testS3Connection.mockResolvedValue({ ok: false, error: { reason: 'request_failed', op: 'PutObject', status: 403 } });
    const test = await call(adminTestBlobStorage, ADMIN);
    expect(test.res.statusCode).toBe(200);
    expect(test.res.body).toEqual({ ok: false, error: { reason: 'request_failed', op: 'PutObject', status: 403 } });
  });

  it('503 while file_search is unavailable, without reading anything', async () => {
    dbState.available = false;
    expect((await call(adminBlobStorage, ADMIN)).res.statusCode).toBe(503);
    expect((await call(adminTestBlobStorage, ADMIN)).res.statusCode).toBe(503);
    expect(panel.blobStorageOverview).not.toHaveBeenCalled();
    expect(panel.testS3Connection).not.toHaveBeenCalled();
  });

  it('a failing read goes to the error handler', async () => {
    panel.blobStorageOverview.mockRejectedValue(new Error('boom'));
    const { next } = await call(adminBlobStorage, ADMIN);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('job handlers dispatch a blob_migration job to the migration engine', () => {
  it('admin cancel and retry', async () => {
    jobSummaryAnyOwner.mockResolvedValue(migrationJob());
    engine.cancelBlobMigration.mockResolvedValue({ ok: true, job: migrationJob({ state: 'cancelled' }) });
    const cancel = await call(reembedCtrl.adminCancelJob, ADMIN, { params: { job_id: 'job_m' } });
    expect(engine.cancelBlobMigration).toHaveBeenCalledWith('job_m');
    expect(cancelReembed).not.toHaveBeenCalled();
    expect(cancel.res.body.state).toBe('cancelled');

    engine.retryBlobMigration.mockResolvedValue({ ok: true, job_id: 'job_m', retried: 2 });
    const retry = await call(reembedCtrl.adminRetryJob, ADMIN, { params: { job_id: 'job_m' } });
    expect(engine.retryBlobMigration).toHaveBeenCalledWith('job_m');
    expect(retryReembed).not.toHaveBeenCalled();
    expect(retry.res.body).toMatchObject({ id: 'job_m', retried: 2 });

    engine.retryBlobMigration.mockResolvedValue({ ok: false, error: 'job_running' });
    const refused = await call(reembedCtrl.adminRetryJob, ADMIN, { params: { job_id: 'job_m' } });
    expect(refused.res.statusCode).toBe(409);
  });

  it('admin failures list the failed blobs', async () => {
    jobSummaryAnyOwner.mockResolvedValue(migrationJob());
    engine.listBlobMigrationFailures.mockResolvedValue([{ id: SHA, sha256: SHA, source_storage: 'db', size_bytes: 3, attempts: 1, last_error: { message: 'x' } }]);
    const { res } = await call(reembedCtrl.adminJobFailures, ADMIN, { params: { job_id: 'job_m' }, query: { limit: '5' } });
    expect(engine.listBlobMigrationFailures).toHaveBeenCalledWith('job_m', { limit: 5, after: null });
    expect(listReembedFailures).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ object: 'list', data: [{ id: SHA }], has_more: false });
  });

  it('owner GET /jobs/:id/failures: a non-admin gets the unknown-job 404 for a blob migration', async () => {
    jobSummary.mockResolvedValue(migrationJob());
    const { res } = await call(reembedCtrl.jobFailures, USER, { params: { job_id: 'job_m' } });
    expect(res.statusCode).toBe(404);
    expect(engine.listBlobMigrationFailures).not.toHaveBeenCalled();
    engine.listBlobMigrationFailures.mockResolvedValue([]);
    const admin = await call(reembedCtrl.jobFailures, ADMIN, { params: { job_id: 'job_m' } });
    expect(admin.res.statusCode).toBe(200);
    expect(engine.listBlobMigrationFailures).toHaveBeenCalledWith('job_m', { limit: 20, after: null });
  });

  it('a superseded retry is a 409 with its own code', async () => {
    jobSummaryAnyOwner.mockResolvedValue(migrationJob());
    engine.retryBlobMigration.mockResolvedValue({ ok: false, error: 'superseded' });
    const { res } = await call(reembedCtrl.adminRetryJob, ADMIN, { params: { job_id: 'job_m' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('superseded');
  });

  it('the owner routes: an admin cancels and retries own migration; a non-admin gets the unknown-job 404', async () => {
    jobSummary.mockResolvedValue(migrationJob());
    engine.cancelBlobMigration.mockResolvedValue({ ok: true, job: migrationJob({ state: 'cancelled' }) });
    const cancel = await call(groundingController.cancelJob, ADMIN, { params: { job_id: 'job_m' } });
    expect(engine.cancelBlobMigration).toHaveBeenCalledWith('job_m');
    expect(cancel.res.statusCode).toBe(200);
    engine.retryBlobMigration.mockResolvedValue({ ok: false, error: 'nothing_to_retry' });
    const retry = await call(groundingController.retryJob, ADMIN, { params: { job_id: 'job_m' } });
    expect(engine.retryBlobMigration).toHaveBeenCalledWith('job_m');
    expect(retry.res.statusCode).toBe(409);

    engine.cancelBlobMigration.mockClear();
    engine.retryBlobMigration.mockClear();
    const foreignCancel = await call(groundingController.cancelJob, USER, { params: { job_id: 'job_m' } });
    const foreignRetry = await call(groundingController.retryJob, USER, { params: { job_id: 'job_m' } });
    expect(foreignCancel.res.statusCode).toBe(404);
    expect(foreignRetry.res.statusCode).toBe(404);
    expect(engine.cancelBlobMigration).not.toHaveBeenCalled();
    expect(engine.retryBlobMigration).not.toHaveBeenCalled();
  });
});
