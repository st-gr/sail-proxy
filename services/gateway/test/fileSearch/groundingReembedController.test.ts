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

const ownerOfStore = jest.fn<any>();
jest.mock('../../src/fileSearch/admin', () => {
  const actual = jest.requireActual('../../src/fileSearch/admin') as any;
  return { __esModule: true, ...actual, ownerOfStore: (...a: any[]) => ownerOfStore(...a) };
});

const engine = {
  estimateStore: jest.fn<any>(), estimateOutdated: jest.fn<any>(), startReembed: jest.fn<any>(),
  startBulkReembed: jest.fn<any>(), cancelReembed: jest.fn<any>(), retryReembed: jest.fn<any>(),
  unfinishedReembedJobs: jest.fn<any>()
};
jest.mock('../../src/fileSearch/reembed', () => {
  const wrap = (name: keyof typeof engine) => (...a: any[]) => (engine[name] as any)(...a);
  return {
    __esModule: true,
    estimateStore: wrap('estimateStore'), estimateOutdated: wrap('estimateOutdated'), startReembed: wrap('startReembed'),
    startBulkReembed: wrap('startBulkReembed'), cancelReembed: wrap('cancelReembed'), retryReembed: wrap('retryReembed'),
    unfinishedReembedJobs: wrap('unfinishedReembedJobs')
  };
});

const jobSummary = jest.fn<any>();
const jobSummaryAnyOwner = jest.fn<any>();
const retryJob = jest.fn<any>();
jest.mock('../../src/fileSearch/jobs', () => {
  const actual = jest.requireActual('../../src/fileSearch/jobs') as any;
  return {
    __esModule: true, ...actual,
    jobSummary: (...a: any[]) => jobSummary(...a),
    jobSummaryAnyOwner: (...a: any[]) => jobSummaryAnyOwner(...a),
    retryJob: (...a: any[]) => retryJob(...a)
  };
});
const listReembedFailures = jest.fn<any>();
jest.mock('../../src/fileSearch/reembedFailures', () => ({
  __esModule: true,
  listReembedFailures: (...a: any[]) => listReembedFailures(...a)
}));
const requestBatchCancel = jest.fn<any>();
jest.mock('../../src/fileSearch/batches', () => {
  const actual = jest.requireActual('../../src/fileSearch/batches') as any;
  return { __esModule: true, ...actual, requestBatchCancel: (...a: any[]) => requestBatchCancel(...a) };
});

import * as ctrl from '../../src/controllers/groundingReembedController';
import * as groundingController from '../../src/controllers/groundingController';

const ADMIN = 'admin@test.com';
const OWNER = 'owner@test.com';
const OTHER_USER = 'other@test.com';

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}
function reqAs(email: string, overrides: Record<string, any> = {}): any {
  return {
    headers: {}, params: {}, query: {}, apiKeyInfo: { email }, groundingActor: { email, role: email === ADMIN ? 'admin' : 'user' },
    serviceAuth: { authType: 'service-key', serviceKey: { id: 'svc-key-1', email: 'admin-service@test.com' } },
    ...overrides
  };
}
async function call(handler: (req: any, res: any, next: any) => Promise<void>, email: string, overrides: Record<string, any> = {}): Promise<{ res: any; next: jest.Mock }> {
  const res = makeRes();
  const next = jest.fn();
  await handler(reqAs(email, overrides), res, next);
  return { res, next };
}
function job(extra: Record<string, unknown> = {}): any {
  return { id: 'job_r', kind: 'reembed_store', store_id: 'vs_1', state: 'queued', total: 2, done: 0, failed: 0, cancelled: 0, in_progress: 2, ...extra };
}
const NOT_FOUND_BODY = (id: string) => ({ error: { message: `No such vector store: ${id}`, type: 'invalid_request_error', code: 'vector_store_not_found' } });
/** A null-prototype object, as express 4.22 parses `?x[a]=1`. */
function bracketed(): any {
  const value = Object.create(null); value.a = '1'; return value;
}

beforeEach(() => {
  dbState.available = true;
  for (const fn of Object.values(engine)) fn.mockReset();
  ownerOfStore.mockReset(); listReembedFailures.mockReset(); jobSummary.mockReset(); jobSummaryAnyOwner.mockReset(); retryJob.mockReset(); requestBatchCancel.mockReset();
});

describe('GET /stores/:id/reembed/estimate (owner only)', () => {
  it('answers the owner\'s estimate', async () => {
    engine.estimateStore.mockResolvedValue({ files: 2, chunks: 5, estimated_tokens: 40, state: 'outdated' });
    const { res } = await call(ctrl.estimateStore, OWNER, { params: { id: 'vs_1' } });
    expect(engine.estimateStore).toHaveBeenCalledWith(OWNER, 'vs_1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ files: 2, chunks: 5, estimated_tokens: 40, state: 'outdated' });
  });

  it('404s a store the caller does not own (a shared one included) with the unknown-store body', async () => {
    engine.estimateStore.mockResolvedValue(null);
    const { res } = await call(ctrl.estimateStore, OWNER, { params: { id: 'vs_shared' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY('vs_shared'));
  });

  it('ignores a bracketed query (?x[a]=1) instead of throwing', async () => {
    engine.estimateStore.mockResolvedValue({ files: 0, chunks: 0, estimated_tokens: 0, state: 'current' });
    const { res } = await call(ctrl.estimateStore, OWNER, { params: { id: 'vs_1' }, query: { x: bracketed() } });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /stores/:id/reembed (owner only)', () => {
  it('starts as the owner, stamped with the acting user and the service-key credential, and answers the job', async () => {
    engine.startReembed.mockResolvedValue({ ok: true, job: job() });
    const { res } = await call(ctrl.reembedStore, OWNER, { params: { id: 'vs_1' } });
    expect(engine.startReembed).toHaveBeenCalledWith(OWNER, 'vs_1', { email: OWNER, credentialId: 'svc-key-1', authType: 'api_key' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(job());
  });

  it('404s a non-owner (engine not_found) with the same body as an unknown store', async () => {
    engine.startReembed.mockResolvedValue({ ok: false, error: 'not_found' });
    const { res } = await call(ctrl.reembedStore, OWNER, { params: { id: 'vs_x' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY('vs_x'));
  });

  it.each([['store_dimension_mismatch'], ['store_expired'], ['reembed_running'], ['store_current']])(
    'maps the refusal %s to 409 with the engine\'s code', async (code) => {
      engine.startReembed.mockResolvedValue({ ok: false, error: code });
      const { res } = await call(ctrl.reembedStore, OWNER, { params: { id: 'vs_1' } });
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toMatchObject({ code, type: 'invalid_request_error' });
      expect(typeof res.body.error.message).toBe('string');
    });

  it('answers a deadlock as 409 concurrent_modification, other failures go to next', async () => {
    engine.startReembed.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }));
    const dl = await call(ctrl.reembedStore, OWNER, { params: { id: 'vs_1' } });
    expect(dl.res.statusCode).toBe(409);
    expect(dl.res.body.error.code).toBe('concurrent_modification');
    expect(dl.next).not.toHaveBeenCalled();
    const boom = new Error('boom');
    engine.startReembed.mockRejectedValueOnce(boom);
    const failed = await call(ctrl.reembedStore, OWNER, { params: { id: 'vs_1' } });
    expect(failed.next).toHaveBeenCalledWith(boom);
  });
});

describe('GET /admin/stores/:id/reembed/estimate (ruling R12)', () => {
  it('resolves the owner first and answers that owner\'s estimate', async () => {
    ownerOfStore.mockResolvedValue(OWNER);
    engine.estimateStore.mockResolvedValue({ files: 2, chunks: 5, estimated_tokens: 40, state: 'outdated' });
    const { res } = await call(ctrl.adminEstimateStore, ADMIN, { params: { id: 'vs_1' } });
    expect(ownerOfStore).toHaveBeenCalledWith('vs_1');
    expect(engine.estimateStore).toHaveBeenCalledWith(OWNER, 'vs_1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ files: 2, chunks: 5, estimated_tokens: 40, state: 'outdated' });
  });

  it('404s an unknown store without asking the engine, and a store deleted in between with the same body', async () => {
    ownerOfStore.mockResolvedValue(null);
    const unknown = await call(ctrl.adminEstimateStore, ADMIN, { params: { id: 'vs_gone' } });
    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.res.body).toEqual(NOT_FOUND_BODY('vs_gone'));
    expect(engine.estimateStore).not.toHaveBeenCalled();
    ownerOfStore.mockResolvedValue(OWNER);
    engine.estimateStore.mockResolvedValue(null);
    const vanished = await call(ctrl.adminEstimateStore, ADMIN, { params: { id: 'vs_1' } });
    expect(vanished.res.statusCode).toBe(404);
    expect(vanished.res.body).toEqual(NOT_FOUND_BODY('vs_1'));
  });

  it('ignores a bracketed query (?x[a]=1) instead of throwing; other failures go to next', async () => {
    ownerOfStore.mockResolvedValue(OWNER);
    engine.estimateStore.mockResolvedValue({ files: 0, chunks: 0, estimated_tokens: 0, state: 'outdated' });
    const { res } = await call(ctrl.adminEstimateStore, ADMIN, { params: { id: 'vs_1' }, query: { x: bracketed() } });
    expect(res.statusCode).toBe(200);
    const boom = new Error('boom');
    engine.estimateStore.mockRejectedValueOnce(boom);
    const failed = await call(ctrl.adminEstimateStore, ADMIN, { params: { id: 'vs_1' } });
    expect(failed.next).toHaveBeenCalledWith(boom);
  });
});

describe('POST /admin/stores/:id/reembed', () => {
  it('resolves the owner first and starts as that owner with the admin as the actor', async () => {
    ownerOfStore.mockResolvedValue(OWNER);
    engine.startReembed.mockResolvedValue({ ok: true, job: job() });
    const { res } = await call(ctrl.adminReembedStore, ADMIN, { params: { id: 'vs_1' } });
    expect(ownerOfStore).toHaveBeenCalledWith('vs_1');
    expect(engine.startReembed).toHaveBeenCalledWith(OWNER, 'vs_1', { email: ADMIN, credentialId: 'svc-key-1', authType: 'api_key' });
    expect(res.statusCode).toBe(200);
  });

  it('404s an unknown store without starting anything', async () => {
    ownerOfStore.mockResolvedValue(null);
    const { res } = await call(ctrl.adminReembedStore, ADMIN, { params: { id: 'vs_gone' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY('vs_gone'));
    expect(engine.startReembed).not.toHaveBeenCalled();
  });

  it.each([['store_dimension_mismatch'], ['store_expired'], ['reembed_running'], ['store_current']])(
    'maps the refusal %s to 409', async (code) => {
      ownerOfStore.mockResolvedValue(OWNER);
      engine.startReembed.mockResolvedValue({ ok: false, error: code });
      const { res } = await call(ctrl.adminReembedStore, ADMIN, { params: { id: 'vs_1' } });
      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe(code);
    });

  it('a store deleted between the owner lookup and the start is the same 404', async () => {
    ownerOfStore.mockResolvedValue(OWNER);
    engine.startReembed.mockResolvedValue({ ok: false, error: 'not_found' });
    const { res } = await call(ctrl.adminReembedStore, ADMIN, { params: { id: 'vs_1' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY('vs_1'));
  });

  it('answers a deadlock as 409 concurrent_modification', async () => {
    ownerOfStore.mockResolvedValue(OWNER);
    engine.startReembed.mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    const { res } = await call(ctrl.adminReembedStore, ADMIN, { params: { id: 'vs_1' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('concurrent_modification');
  });
});

describe('the bulk routes', () => {
  it('GET /admin/reembed-outdated/estimate answers the engine\'s estimate', async () => {
    const estimate = { stores: 1, files: 2, chunks: 3, estimated_tokens: 4, skipped: [{ store_id: 'vs_d', owner_email: OWNER, reason: 'dimension_mismatch' }] };
    engine.estimateOutdated.mockResolvedValue(estimate);
    const { res } = await call(ctrl.adminEstimateOutdated, ADMIN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(estimate);
  });

  it('POST /admin/reembed-outdated starts the bulk job as the admin and answers it with the skipped stores', async () => {
    const skipped = [{ store_id: 'vs_e', owner_email: OWNER, reason: 'expired' }];
    engine.startBulkReembed.mockResolvedValue({ ok: true, job: job({ id: 'job_b', kind: 'reembed_bulk', store_id: null }), skipped });
    const { res } = await call(ctrl.adminReembedOutdated, ADMIN);
    expect(engine.startBulkReembed).toHaveBeenCalledWith({ email: ADMIN, credentialId: 'svc-key-1', authType: 'api_key' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ job: job({ id: 'job_b', kind: 'reembed_bulk', store_id: null }), skipped });
  });

  it('POST /admin/reembed-outdated answers 409 nothing_to_reembed when no store qualifies', async () => {
    engine.startBulkReembed.mockResolvedValue({ ok: false, error: 'nothing_to_reembed' });
    const { res } = await call(ctrl.adminReembedOutdated, ADMIN);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('nothing_to_reembed');
  });
});

describe('POST /admin/jobs/:job_id/cancel and /retry (re-embed kinds of any owner)', () => {
  it('cancels a re-embed job of any owner', async () => {
    engine.cancelReembed.mockResolvedValue({ ok: true, job: job({ state: 'cancelled', owner_email: OWNER }) });
    const { res } = await call(ctrl.adminCancelJob, ADMIN, { params: { job_id: 'job_r' } });
    expect(engine.cancelReembed).toHaveBeenCalledWith(null, 'job_r');
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe('cancelled');
  });

  it('404s a file_batch job (the engine finds only re-embed kinds) and never touches the batch', async () => {
    engine.cancelReembed.mockResolvedValue({ ok: false, error: 'not_found' });
    const { res } = await call(ctrl.adminCancelJob, ADMIN, { params: { job_id: 'job_batch' } });
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(requestBatchCancel).not.toHaveBeenCalled();
  });

  it('retries a failed re-embed job of any owner and answers the job with the retried count', async () => {
    engine.retryReembed.mockResolvedValue({ ok: true, job_id: 'job_r', retried: 3 });
    jobSummaryAnyOwner.mockResolvedValue(job({ state: 'queued', owner_email: OWNER }));
    const { res } = await call(ctrl.adminRetryJob, ADMIN, { params: { job_id: 'job_r' } });
    expect(engine.retryReembed).toHaveBeenCalledWith(null, 'job_r');
    expect(jobSummaryAnyOwner).toHaveBeenCalledWith('job_r');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 'job_r', owner_email: OWNER, retried: 3 });
  });

  it.each([
    ['not_found', 404], ['job_running', 409], ['store_expired', 409], ['nothing_to_retry', 409],
  ])('maps the retry refusal %s to %i (a file_batch id is not_found)', async (code, status) => {
    engine.retryReembed.mockResolvedValue({ ok: false, error: code });
    const { res } = await call(ctrl.adminRetryJob, ADMIN, { params: { job_id: 'job_x' } });
    expect(res.statusCode).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(retryJob).not.toHaveBeenCalled();
  });

  it('cancel answers a deadlock as 409 concurrent_modification; retry as 503 retry_conflict like the owner\'s retry', async () => {
    engine.cancelReembed.mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    const cancel = await call(ctrl.adminCancelJob, ADMIN, { params: { job_id: 'job_r' } });
    expect(cancel.res.statusCode).toBe(409);
    expect(cancel.res.body.error.code).toBe('concurrent_modification');
    engine.retryReembed.mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    const retry = await call(ctrl.adminRetryJob, ADMIN, { params: { job_id: 'job_r' } });
    expect(retry.res.statusCode).toBe(503);
    expect(retry.res.body.error.code).toBe('retry_conflict');
  });
});

describe('the owner\'s job routes take re-embed kinds, scoped to the owner', () => {
  it('cancel of the owner\'s re-embed job goes to the engine with the owner, not to the batch latch', async () => {
    jobSummary.mockResolvedValue(job());
    engine.cancelReembed.mockResolvedValue({ ok: true, job: job({ state: 'cancelled' }) });
    const res = makeRes();
    await groundingController.cancelJob(reqAs(OWNER, { params: { job_id: 'job_r' } }), res, jest.fn());
    expect(jobSummary).toHaveBeenCalledWith('job_r', OWNER);
    expect(engine.cancelReembed).toHaveBeenCalledWith(OWNER, 'job_r');
    expect(requestBatchCancel).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe('cancelled');
  });

  it('cancel of a bulk parent (owned by the admin who started it) goes to the engine too', async () => {
    jobSummary.mockResolvedValue(job({ id: 'job_b', kind: 'reembed_bulk', store_id: null }));
    engine.cancelReembed.mockResolvedValue({ ok: true, job: job({ id: 'job_b', kind: 'reembed_bulk', state: 'cancelling' }) });
    const res = makeRes();
    await groundingController.cancelJob(reqAs(ADMIN, { params: { job_id: 'job_b' } }), res, jest.fn());
    expect(engine.cancelReembed).toHaveBeenCalledWith(ADMIN, 'job_b');
    expect(res.body.state).toBe('cancelling');
  });

  it('a bulk parent is 404 on cancel and retry unless the acting role is admin (ruling R10), engine never asked', async () => {
    // A demoted admin still owns the parents it started, but no longer controls them.
    jobSummary.mockResolvedValue(job({ id: 'job_b', kind: 'reembed_bulk', store_id: null, state: 'running' }));
    const asUser = { params: { job_id: 'job_b' }, groundingActor: { email: OWNER, role: 'user' } };
    const cancel = makeRes();
    await groundingController.cancelJob(reqAs(OWNER, asUser), cancel, jest.fn());
    expect(cancel.statusCode).toBe(404);
    expect(cancel.body.error.code).toBe('not_found');
    const retry = makeRes();
    await groundingController.retryJob(reqAs(OWNER, asUser), retry, jest.fn());
    expect(retry.statusCode).toBe(404);
    expect(retry.body.error.code).toBe('not_found');
    const noActor = makeRes();
    await groundingController.cancelJob(reqAs(OWNER, { params: { job_id: 'job_b' }, groundingActor: undefined }), noActor, jest.fn());
    expect(noActor.statusCode).toBe(404);
    expect(engine.cancelReembed).not.toHaveBeenCalled();
    expect(engine.retryReembed).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
    // The owner's own reembed_store job is unaffected by the role.
    jobSummary.mockResolvedValue(job({ state: 'failed' }));
    engine.retryReembed.mockResolvedValue({ ok: true, job_id: 'job_r', retried: 1 });
    const own = makeRes();
    await groundingController.retryJob(reqAs(OWNER, { params: { job_id: 'job_r' } }), own, jest.fn());
    expect(own.statusCode).toBe(200);
  });

  it('an admin retries a bulk parent it started through the owner route', async () => {
    jobSummary.mockResolvedValue(job({ id: 'job_b', kind: 'reembed_bulk', store_id: null, state: 'completed_with_errors' }));
    engine.retryReembed.mockResolvedValue({ ok: true, job_id: 'job_b', retried: 2 });
    const res = makeRes();
    await groundingController.retryJob(reqAs(ADMIN, { params: { job_id: 'job_b' } }), res, jest.fn());
    expect(engine.retryReembed).toHaveBeenCalledWith(ADMIN, 'job_b');
    expect(res.statusCode).toBe(200);
  });

  it('another owner\'s re-embed job is 404 and the engine is never asked', async () => {
    jobSummary.mockResolvedValue(null);
    const res = makeRes();
    await groundingController.cancelJob(reqAs(OWNER, { params: { job_id: 'job_r' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(engine.cancelReembed).not.toHaveBeenCalled();
    const retry = makeRes();
    await groundingController.retryJob(reqAs(OWNER, { params: { job_id: 'job_r' } }), retry, jest.fn());
    expect(retry.statusCode).toBe(404);
    expect(engine.retryReembed).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
  });

  it('retry of the owner\'s re-embed job goes to the engine with the owner and answers the job and count', async () => {
    jobSummary.mockResolvedValue(job({ state: 'failed' }));
    engine.retryReembed.mockResolvedValue({ ok: true, job_id: 'job_r', retried: 1 });
    const res = makeRes();
    await groundingController.retryJob(reqAs(OWNER, { params: { job_id: 'job_r' } }), res, jest.fn());
    expect(engine.retryReembed).toHaveBeenCalledWith(OWNER, 'job_r');
    expect(retryJob).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 'job_r', retried: 1 });
  });

  it('a re-embed retry refusal maps like a batch retry refusal', async () => {
    jobSummary.mockResolvedValue(job({ state: 'running' }));
    engine.retryReembed.mockResolvedValue({ ok: false, error: 'job_running' });
    const res = makeRes();
    await groundingController.retryJob(reqAs(OWNER, { params: { job_id: 'job_r' } }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('job_running');
  });

  it('a file batch still goes to the batch retry', async () => {
    jobSummary.mockResolvedValue(job({ kind: 'file_batch', batch_id: 'vsfb_1' }));
    retryJob.mockResolvedValue({ ok: true, job_id: 'job_r', retried: 2 });
    const res = makeRes();
    await groundingController.retryJob(reqAs(OWNER, { params: { job_id: 'job_r' } }), res, jest.fn());
    expect(retryJob).toHaveBeenCalledWith('job_r', OWNER);
    expect(engine.retryReembed).not.toHaveBeenCalled();
  });
});

describe('every re-embed handler answers 503 while file_search is unavailable and 401 without a user', () => {
  const handlers: [string, any][] = [
    ['estimateStore', ctrl.estimateStore], ['reembedStore', ctrl.reembedStore], ['adminEstimateStore', ctrl.adminEstimateStore],
    ['adminReembedStore', ctrl.adminReembedStore],
    ['adminEstimateOutdated', ctrl.adminEstimateOutdated], ['adminReembedOutdated', ctrl.adminReembedOutdated],
    ['adminCancelJob', ctrl.adminCancelJob], ['adminRetryJob', ctrl.adminRetryJob],
  ];
  it.each(handlers)('%s', async (_name, handler) => {
    dbState.available = false;
    const unavailable = await call(handler, ADMIN, { params: { id: 'vs_1', job_id: 'job_1' } });
    expect(unavailable.res.statusCode).toBe(503);
    expect(unavailable.res.body.error.code).toBe('file_search_unavailable');
    dbState.available = true;
    const anonymous = await call(handler, ADMIN, { apiKeyInfo: undefined, params: { id: 'vs_1', job_id: 'job_1' } });
    expect(anonymous.res.statusCode).toBe(401);
    for (const fn of Object.values(engine)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET /jobs/:job_id/failures and /admin/jobs/:job_id/failures (review focus 5)', () => {
  const FAILURE = {
    id: 'job_r/file-1', job_id: 'job_r', store_id: 'vs_1', store_name: 'Docs', file_id: 'file-1', filename: 'a.txt',
    last_error: { message: 'Embedding failed.' }, attempts: 3
  };
  const JOB_NOT_FOUND = { error: { message: 'No such job.', type: 'invalid_request_error', code: 'not_found' } };

  it('the owner reads a page of the job\'s failures, the job resolved owner-scoped', async () => {
    jobSummary.mockResolvedValue(job({ state: 'failed', failed: 1 }));
    listReembedFailures.mockResolvedValue([FAILURE]);
    const { res } = await call(ctrl.jobFailures, OWNER, { params: { job_id: 'job_r' }, query: { limit: '5', after: 'job_r/file-0' } });
    expect(jobSummary).toHaveBeenCalledWith('job_r', OWNER);
    expect(listReembedFailures).toHaveBeenCalledWith('job_r', { limit: 5, after: 'job_r/file-0' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ object: 'list', data: [FAILURE], has_more: false, first_id: 'job_r/file-1', last_id: 'job_r/file-1' });
  });

  it('trims to the limit and says has_more (default limit 20)', async () => {
    jobSummary.mockResolvedValue(job({ state: 'failed' }));
    listReembedFailures.mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ ...FAILURE, id: `job_r/f${i}` })));
    const { res } = await call(ctrl.jobFailures, OWNER, { params: { job_id: 'job_r' } });
    expect(listReembedFailures).toHaveBeenCalledWith('job_r', { limit: 20, after: null });
    expect(res.body.data).toHaveLength(20);
    expect(res.body).toMatchObject({ has_more: true, last_id: 'job_r/f19' });
  });

  it('another owner\'s job is exactly the unknown-job 404, and nothing is read', async () => {
    jobSummary.mockResolvedValue(null);
    const { res } = await call(ctrl.jobFailures, OTHER_USER, { params: { job_id: 'job_r' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual(JOB_NOT_FOUND);
    expect(listReembedFailures).not.toHaveBeenCalled();
  });

  it('a file batch is the unknown-job 404 on both routes', async () => {
    jobSummary.mockResolvedValue(job({ kind: 'file_batch', batch_id: 'vsfb_1' }));
    jobSummaryAnyOwner.mockResolvedValue(job({ kind: 'file_batch', batch_id: 'vsfb_1', owner_email: OWNER }));
    const own = await call(ctrl.jobFailures, OWNER, { params: { job_id: 'job_f' } });
    const adm = await call(ctrl.adminJobFailures, ADMIN, { params: { job_id: 'job_f' } });
    expect([own.res.statusCode, own.res.body]).toEqual([404, JOB_NOT_FOUND]);
    expect([adm.res.statusCode, adm.res.body]).toEqual([404, JOB_NOT_FOUND]);
    expect(listReembedFailures).not.toHaveBeenCalled();
  });

  it('a bulk parent answers on the user route only while the acting role is admin (ruling R10)', async () => {
    jobSummary.mockResolvedValue(job({ id: 'job_b', kind: 'reembed_bulk', store_id: null, state: 'failed' }));
    listReembedFailures.mockResolvedValue([]);
    const demoted = await call(ctrl.jobFailures, OWNER, { params: { job_id: 'job_b' }, groundingActor: { email: OWNER, role: 'user' } });
    expect([demoted.res.statusCode, demoted.res.body]).toEqual([404, JOB_NOT_FOUND]);
    expect(listReembedFailures).not.toHaveBeenCalled();
    const admin = await call(ctrl.jobFailures, ADMIN, { params: { job_id: 'job_b' } });
    expect(admin.res.statusCode).toBe(200);
    expect(listReembedFailures).toHaveBeenCalledWith('job_b', { limit: 20, after: null });
  });

  it('the admin reads a re-embed job of any owner; an unknown job is the same 404', async () => {
    jobSummaryAnyOwner.mockResolvedValue(job({ owner_email: OWNER, state: 'failed' }));
    listReembedFailures.mockResolvedValue([FAILURE]);
    const { res } = await call(ctrl.adminJobFailures, ADMIN, { params: { job_id: 'job_r' } });
    expect(jobSummaryAnyOwner).toHaveBeenCalledWith('job_r');
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([FAILURE]);
    jobSummaryAnyOwner.mockResolvedValue(null);
    const unknown = await call(ctrl.adminJobFailures, ADMIN, { params: { job_id: 'job_x' } });
    expect([unknown.res.statusCode, unknown.res.body]).toEqual([404, JOB_NOT_FOUND]);
  });

  it.each([['0'], ['101'], ['1.5'], ['x']])('limit=%s is 400 invalid_limit', async (limit) => {
    jobSummary.mockResolvedValue(job());
    const { res } = await call(ctrl.jobFailures, OWNER, { params: { job_id: 'job_r' }, query: { limit } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_limit');
    expect(listReembedFailures).not.toHaveBeenCalled();
  });

  it('a malformed cursor from the data layer is 400 invalid_parameter; a bracketed query is ignored', async () => {
    const { AdminQueryInputError } = jest.requireActual('../../src/fileSearch/admin') as any;
    jobSummary.mockResolvedValue(job());
    listReembedFailures.mockRejectedValueOnce(new AdminQueryInputError('after must be <job_id>/<file_id>.'));
    const bad = await call(ctrl.jobFailures, OWNER, { params: { job_id: 'job_r' }, query: { after: 'nocursor' } });
    expect(bad.res.statusCode).toBe(400);
    expect(bad.res.body.error.code).toBe('invalid_parameter');
    listReembedFailures.mockResolvedValue([]);
    const bracket = await call(ctrl.jobFailures, OWNER, { params: { job_id: 'job_r' }, query: { after: bracketed(), limit: bracketed() } });
    expect(bracket.res.statusCode).toBe(200);
    expect(listReembedFailures).toHaveBeenLastCalledWith('job_r', { limit: 20, after: null });
  });

  it('other failures go to next', async () => {
    const boom = new Error('boom');
    jobSummary.mockRejectedValueOnce(boom);
    const own = await call(ctrl.jobFailures, OWNER, { params: { job_id: 'job_r' } });
    expect(own.next).toHaveBeenCalledWith(boom);
    jobSummaryAnyOwner.mockResolvedValue(job());
    listReembedFailures.mockRejectedValueOnce(boom);
    const adm = await call(ctrl.adminJobFailures, ADMIN, { params: { job_id: 'job_r' } });
    expect(adm.next).toHaveBeenCalledWith(boom);
  });
});
