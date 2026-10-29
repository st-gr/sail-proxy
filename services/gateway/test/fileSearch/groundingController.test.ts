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

const listAttachmentsForFiles = jest.fn<any>();
jest.mock('../../src/fileSearch/groundingQueries', () => ({
  __esModule: true,
  listAttachmentsForFiles: (...a: any[]) => listAttachmentsForFiles(...a)
}));
const deleteFileDetachingEverywhere = jest.fn<any>();
jest.mock('../../src/fileSearch/repository', () => ({ __esModule: true, deleteFileDetachingEverywhere: (...a: any[]) => deleteFileDetachingEverywhere(...a) }));
const filesDeleteFile = jest.fn<any>();
jest.mock('../../src/controllers/filesController', () => ({ __esModule: true, deleteFile: (...a: any[]) => filesDeleteFile(...a) }));

const jobSummary = jest.fn<any>();
const listJobs = jest.fn<any>();
const retryJob = jest.fn<any>();
const retryFile = jest.fn<any>();
jest.mock('../../src/fileSearch/jobs', () => ({
  __esModule: true,
  jobSummary: (...a: any[]) => jobSummary(...a),
  listJobs: (...a: any[]) => listJobs(...a),
  retryJob: (...a: any[]) => retryJob(...a),
  retryFile: (...a: any[]) => retryFile(...a)
}));
const requestBatchCancel = jest.fn<any>();
jest.mock('../../src/fileSearch/batches', () => ({ __esModule: true, requestBatchCancel: (...a: any[]) => requestBatchCancel(...a) }));

import * as groundingController from '../../src/controllers/groundingController';

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}
function baseReq(overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, apiKeyInfo: { email: 'owner@test.com' }, ...overrides };
}

beforeEach(() => {
  dbState.available = true;
  jobSummary.mockReset(); listJobs.mockReset(); retryJob.mockReset(); retryFile.mockReset(); requestBatchCancel.mockReset();
  listAttachmentsForFiles.mockReset(); deleteFileDetachingEverywhere.mockReset(); filesDeleteFile.mockReset();
});

describe('GET /file-attachments', () => {
  it('returns the stores of each requested file, with an empty list for a file that has none', async () => {
    listAttachmentsForFiles.mockResolvedValue({ 'file-a': [{ store_id: 'vs_1', store_name: 'Docs', status: 'completed' }] });
    const res = makeRes();
    await groundingController.fileAttachments(baseReq({ query: { file_ids: 'file-a,file-b' } }), res, jest.fn());
    expect(listAttachmentsForFiles).toHaveBeenCalledWith('owner@test.com', ['file-a', 'file-b']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ data: { 'file-a': [{ store_id: 'vs_1', store_name: 'Docs', status: 'completed' }], 'file-b': [] } });
  });

  it('answers an empty map when no ids are given', async () => {
    const res = makeRes();
    await groundingController.fileAttachments(baseReq(), res, jest.fn());
    expect(res.body).toEqual({ data: {} });
    expect(listAttachmentsForFiles).not.toHaveBeenCalled();
  });

  it('treats a bracketed parameter as absent instead of throwing (express 4.22 null-prototype query)', async () => {
    const nested = Object.create(null); nested.x = '1';
    const res = makeRes();
    await groundingController.fileAttachments(baseReq({ query: { file_ids: nested } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ data: {} });
  });

  it.each([
    ['an id with a path character', 'file-a,../x'],
    ['an id with a NUL', 'file-a\u0000'],
    ['more than 100 ids', Array.from({ length: 101 }, (_v, i) => `file-${i}`).join(',')],
  ])('400s %s', async (_name, value) => {
    const res = makeRes();
    await groundingController.fileAttachments(baseReq({ query: { file_ids: value } }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_file_ids');
    expect(listAttachmentsForFiles).not.toHaveBeenCalled();
  });

  it('503s while file_search is unavailable and 401s without an owner', async () => {
    dbState.available = false;
    const unavailable = makeRes();
    await groundingController.fileAttachments(baseReq({ query: { file_ids: 'file-a' } }), unavailable, jest.fn());
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body.error.code).toBe('file_search_unavailable');
    dbState.available = true;
    const anonymous = makeRes();
    await groundingController.fileAttachments(baseReq({ apiKeyInfo: undefined, query: { file_ids: 'file-a' } }), anonymous, jest.fn());
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('DELETE /files/:id', () => {
  it('without detach=true hands the request to the existing delete untouched', async () => {
    const req = baseReq({ params: { id: 'file-a' } }); const res = makeRes(); const next = jest.fn();
    await groundingController.deleteFile(req, res, next);
    expect(filesDeleteFile).toHaveBeenCalledWith(req, res, next);
  });

  it('with detach=true detaches and deletes in one repository call, answering like the plain delete', async () => {
    deleteFileDetachingEverywhere.mockResolvedValue({ deleted: true, sha256: 'abc' });
    const req = baseReq({ params: { id: 'file-a' }, query: { detach: 'true' } }); const res = makeRes(); const next = jest.fn();
    await groundingController.deleteFile(req, res, next);
    expect(deleteFileDetachingEverywhere).toHaveBeenCalledWith('file-a', 'owner@test.com');
    expect(filesDeleteFile).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'file-a', object: 'file', deleted: true });
  });

  it('answers 404 file_not_found for a missing or foreign file', async () => {
    deleteFileDetachingEverywhere.mockResolvedValue({ deleted: false });
    const res = makeRes();
    await groundingController.deleteFile(baseReq({ params: { id: 'file-a' }, query: { detach: 'true' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toEqual({ message: 'No such file: file-a', type: 'invalid_request_error', code: 'file_not_found' });
  });

  it('answers 409 file_in_use when another owner\'s store still references the file', async () => {
    deleteFileDetachingEverywhere.mockResolvedValue({ deleted: false, inUse: true });
    const res = makeRes();
    await groundingController.deleteFile(baseReq({ params: { id: 'file-a' }, query: { detach: 'true' } }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('file_in_use');
  });

  it('passes a failing detach-and-delete to next', async () => {
    const boom = new Error('deadlock');
    deleteFileDetachingEverywhere.mockRejectedValue(boom);
    const next = jest.fn();
    await groundingController.deleteFile(baseReq({ params: { id: 'file-a' }, query: { detach: 'true' } }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(boom);
    expect(filesDeleteFile).not.toHaveBeenCalled();
  });

  it('answers a deadlock (40P01) as the store delete does: 409 concurrent_modification, not a 500', async () => {
    deleteFileDetachingEverywhere.mockRejectedValue(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    const res = makeRes(); const next = jest.fn();
    await groundingController.deleteFile(baseReq({ params: { id: 'file-a' }, query: { detach: 'true' } }), res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('concurrent_modification');
    expect(next).not.toHaveBeenCalled();
  });

  it('with detach=true still 503s while unavailable and 401s without an owner', async () => {
    dbState.available = false;
    const unavailable = makeRes();
    await groundingController.deleteFile(baseReq({ params: { id: 'file-a' }, query: { detach: 'true' } }), unavailable, jest.fn());
    expect(unavailable.statusCode).toBe(503);
    dbState.available = true;
    const anonymous = makeRes();
    await groundingController.deleteFile(baseReq({ apiKeyInfo: undefined, params: { id: 'file-a' }, query: { detach: 'true' } }), anonymous, jest.fn());
    expect(anonymous.statusCode).toBe(401);
    expect(filesDeleteFile).not.toHaveBeenCalled();
  });
});

const job = (over: Record<string, any> = {}) => ({ id: 'job_1', kind: 'file_batch', store_id: 'vs_1', batch_id: 'vsfb_1', state: 'running', total: 2, done: 1, failed: 0, cancelled: 0, in_progress: 1, ...over });

describe('GET /jobs', () => {
  it('pages the owner\'s jobs: default limit 20, cursor and state passed through', async () => {
    listJobs.mockResolvedValue([job({ id: 'job_3' }), job({ id: 'job_2' })]);
    const res = makeRes();
    await groundingController.listJobs(baseReq({ query: { limit: '1', after: 'job_4', state: 'running' } }), res, jest.fn());
    expect(listJobs).toHaveBeenCalledWith('owner@test.com', { limit: 1, after: 'job_4', state: 'running' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ object: 'list', has_more: true, first_id: 'job_3', last_id: 'job_3' });
    expect(res.body.data).toHaveLength(1);
  });

  it('defaults the limit to 20', async () => {
    listJobs.mockResolvedValue([]);
    await groundingController.listJobs(baseReq(), makeRes(), jest.fn());
    expect(listJobs).toHaveBeenCalledWith('owner@test.com', { limit: 20, after: null, state: null });
  });

  it.each([['0'], ['101'], ['abc'], ['1.5']])('400s limit=%s', async (limit) => {
    const res = makeRes();
    await groundingController.listJobs(baseReq({ query: { limit } }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_limit');
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('400s an unknown state', async () => {
    const res = makeRes();
    await groundingController.listJobs(baseReq({ query: { state: 'bogus' } }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_state');
  });

  it('treats bracketed parameters as absent instead of throwing (express 4.22 null-prototype query)', async () => {
    const nested = Object.create(null); nested.x = '1';
    listJobs.mockResolvedValue([]);
    const next = jest.fn(); const res = makeRes();
    await groundingController.listJobs(baseReq({ query: { state: nested, limit: nested, after: nested } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(listJobs).toHaveBeenCalledWith('owner@test.com', { limit: 20, after: null, state: null });
  });

  it('503s while unavailable, 401s without an owner, passes failures to next', async () => {
    dbState.available = false;
    const unavailable = makeRes();
    await groundingController.listJobs(baseReq(), unavailable, jest.fn());
    expect(unavailable.statusCode).toBe(503);
    dbState.available = true;
    const anonymous = makeRes();
    await groundingController.listJobs(baseReq({ apiKeyInfo: undefined }), anonymous, jest.fn());
    expect(anonymous.statusCode).toBe(401);
    const boom = new Error('x'); listJobs.mockRejectedValue(boom); const next = jest.fn();
    await groundingController.listJobs(baseReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith(boom);
  });
});

describe('GET /jobs/:job_id', () => {
  it('answers the job scoped to the acting e-mail', async () => {
    jobSummary.mockResolvedValue(job());
    const res = makeRes();
    await groundingController.getJob(baseReq({ params: { job_id: 'job_1' } }), res, jest.fn());
    expect(jobSummary).toHaveBeenCalledWith('job_1', 'owner@test.com');
    expect(res.body.id).toBe('job_1');
  });

  it('404s a missing or foreign job', async () => {
    jobSummary.mockResolvedValue(null);
    const res = makeRes();
    await groundingController.getJob(baseReq({ params: { job_id: 'job_9' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('503s while unavailable', async () => {
    dbState.available = false;
    const res = makeRes();
    await groundingController.getJob(baseReq({ params: { job_id: 'job_1' } }), res, jest.fn());
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /jobs/:job_id/cancel', () => {
  it('latches the batch cancel of a live job and answers the job summary', async () => {
    jobSummary.mockResolvedValueOnce(job()).mockResolvedValueOnce(job({ state: 'cancelling' }));
    requestBatchCancel.mockResolvedValue(true);
    const res = makeRes();
    await groundingController.cancelJob(baseReq({ params: { job_id: 'job_1' } }), res, jest.fn());
    expect(requestBatchCancel).toHaveBeenCalledWith('vs_1', 'vsfb_1');
    expect(jobSummary).toHaveBeenNthCalledWith(1, 'job_1', 'owner@test.com');
    expect(jobSummary).toHaveBeenNthCalledWith(2, 'job_1', 'owner@test.com');
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe('cancelling');
  });

  it.each([['completed'], ['completed_with_errors'], ['cancelled'], ['cancelling']])('does not latch a cancel on a %s job', async (state) => {
    jobSummary.mockResolvedValue(job({ state }));
    const res = makeRes();
    await groundingController.cancelJob(baseReq({ params: { job_id: 'job_1' } }), res, jest.fn());
    expect(requestBatchCancel).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe(state);
  });

  it('404s a missing or foreign job and never cancels', async () => {
    jobSummary.mockResolvedValue(null);
    const res = makeRes();
    await groundingController.cancelJob(baseReq({ params: { job_id: 'job_9' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(jobSummary).toHaveBeenCalledWith('job_9', 'owner@test.com');
    expect(requestBatchCancel).not.toHaveBeenCalled();
  });
});

describe('POST /jobs/:job_id/retry and /stores/:id/files/:file_id/retry', () => {
  it('retries a job and answers the refreshed summary with the retried count', async () => {
    retryJob.mockResolvedValue({ ok: true, job_id: 'job_1', retried: 2 });
    jobSummary.mockResolvedValue(job());
    const res = makeRes();
    await groundingController.retryJob(baseReq({ params: { job_id: 'job_1' } }), res, jest.fn());
    expect(retryJob).toHaveBeenCalledWith('job_1', 'owner@test.com');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 'job_1', retried: 2 });
  });

  it.each([
    ['not_found', 404, 'not_found'],
    ['job_running', 409, 'job_running'],
    ['store_expired', 409, 'store_expired'],
    ['nothing_to_retry', 409, 'nothing_to_retry'],
  ])('maps %s to %i', async (error, status, code) => {
    jobSummary.mockResolvedValue(job());
    retryJob.mockResolvedValue({ ok: false, error });
    const res = makeRes();
    await groundingController.retryJob(baseReq({ params: { job_id: 'job_1' } }), res, jest.fn());
    expect(res.statusCode).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('retries one file; a file outside a batch answers no job', async () => {
    retryFile.mockResolvedValue({ ok: true, job_id: null, retried: 1 });
    const res = makeRes();
    await groundingController.retryStoreFile(baseReq({ params: { id: 'vs_1', file_id: 'file-a' } }), res, jest.fn());
    expect(retryFile).toHaveBeenCalledWith('vs_1', 'file-a', 'owner@test.com');
    expect(res.body).toEqual({ job_id: null, job: null, retried: 1 });
  });

  it('a retried file of a batch answers its job summary', async () => {
    retryFile.mockResolvedValue({ ok: true, job_id: 'job_1', retried: 1 });
    jobSummary.mockResolvedValue(job());
    const res = makeRes();
    await groundingController.retryStoreFile(baseReq({ params: { id: 'vs_1', file_id: 'file-a' } }), res, jest.fn());
    expect(res.body).toMatchObject({ job_id: 'job_1', retried: 1, job: { id: 'job_1' } });
  });

  it('says the batch is still running for a file retry refused with job_running', async () => {
    retryFile.mockResolvedValue({ ok: false, error: 'job_running' });
    const res = makeRes();
    await groundingController.retryStoreFile(baseReq({ params: { id: 'vs_1', file_id: 'file-a' } }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('job_running');
    expect(res.body.error.message).toMatch(/batch is still running/);
  });

  it('answers a Postgres deadlock as 503 retry_conflict', async () => {
    jobSummary.mockResolvedValue(job());
    retryJob.mockRejectedValue(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    const res = makeRes(); const next = jest.fn();
    await groundingController.retryJob(baseReq({ params: { job_id: 'job_1' } }), res, next);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'retry_conflict', message: expect.stringContaining('Try again.') });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes other failures to next; 503 unavailable; 401 without an owner', async () => {
    const boom = new Error('x'); retryFile.mockRejectedValue(boom); const next = jest.fn();
    await groundingController.retryStoreFile(baseReq({ params: { id: 'vs_1', file_id: 'f' } }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(boom);
    const anonymous = makeRes();
    await groundingController.retryJob(baseReq({ apiKeyInfo: undefined, params: { job_id: 'j' } }), anonymous, jest.fn());
    expect(anonymous.statusCode).toBe(401);
    dbState.available = false;
    const unavailable = makeRes();
    await groundingController.retryJob(baseReq({ params: { job_id: 'j' } }), unavailable, jest.fn());
    expect(unavailable.statusCode).toBe(503);
  });
});
