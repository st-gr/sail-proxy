import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const dbState = { available: true };
const poolQuery = jest.fn<any>();
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  isFileSearchAvailable: () => dbState.available,
  getPool: () => ({ query: (...a: any[]) => poolQuery(...a) })
}));
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({ enabled: true, embeddingModel: 'm', embeddingDimensions: 3, limits: { maxFileBytes: 1, maxFilesPerStore: 1 }, blobStorage: { backend: 'db' } })
}));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

const adminFns = {
  overview: jest.fn<any>(), listAllStores: jest.fn<any>(), listAllFiles: jest.fn<any>(), listFailedAttachments: jest.fn<any>(),
  storageByOwner: jest.fn<any>(), listAllJobs: jest.fn<any>(), ownerOfStore: jest.fn<any>(), ownerOfFile: jest.fn<any>()
};
jest.mock('../../src/fileSearch/admin', () => {
  const actual = jest.requireActual('../../src/fileSearch/admin') as any;
  const wrap = (name: keyof typeof adminFns) => (...a: any[]) => (adminFns[name] as any)(...a);
  return {
    __esModule: true,
    ...actual,
    overview: wrap('overview'), listAllStores: wrap('listAllStores'), listAllFiles: wrap('listAllFiles'),
    listFailedAttachments: wrap('listFailedAttachments'), storageByOwner: wrap('storageByOwner'), listAllJobs: wrap('listAllJobs'),
    ownerOfStore: wrap('ownerOfStore'), ownerOfFile: wrap('ownerOfFile')
  };
});

const repoFns = {
  deleteStoreCascade: jest.fn<any>(), listVisibleStores: jest.fn<any>(), readVisibleStore: jest.fn<any>(),
  setStoreShared: jest.fn<any>(), deleteFileDetachingEverywhere: jest.fn<any>()
};
jest.mock('../../src/fileSearch/repository', () => {
  const actual = jest.requireActual('../../src/fileSearch/repository') as any;
  const wrap = (name: keyof typeof repoFns) => (...a: any[]) => (repoFns[name] as any)(...a);
  return {
    __esModule: true,
    ...actual,
    deleteStoreCascade: wrap('deleteStoreCascade'), listVisibleStores: wrap('listVisibleStores'), readVisibleStore: wrap('readVisibleStore'),
    setStoreShared: wrap('setStoreShared'), deleteFileDetachingEverywhere: wrap('deleteFileDetachingEverywhere')
  };
});

const storageOfOwner = jest.fn<any>();
jest.mock('../../src/fileSearch/groundingQueries', () => ({
  __esModule: true,
  listAttachmentsForFiles: jest.fn(),
  storageOfOwner: (...a: any[]) => storageOfOwner(...a)
}));

const unfinishedReembedJobs = jest.fn<any>();
jest.mock('../../src/fileSearch/reembed', () => ({
  __esModule: true,
  unfinishedReembedJobs: (...a: any[]) => unfinishedReembedJobs(...a)
}));

const retryFile = jest.fn<any>();
const jobSummary = jest.fn<any>();
const jobSummaryAnyOwner = jest.fn<any>();
jest.mock('../../src/fileSearch/jobs', () => {
  const actual = jest.requireActual('../../src/fileSearch/jobs') as any;
  return {
    __esModule: true, ...actual, retryFile: (...a: any[]) => retryFile(...a), jobSummary: (...a: any[]) => jobSummary(...a),
    jobSummaryAnyOwner: (...a: any[]) => jobSummaryAnyOwner(...a)
  };
});

import * as ctrl from '../../src/controllers/groundingAdminController';
import { AdminQueryInputError } from '../../src/fileSearch/admin';

const ADMIN = 'admin@test.com';
const OWNER = 'owner@test.com';
const CREATED = new Date('2026-10-01T12:00:00.000Z');
const CREATED_S = Math.floor(CREATED.getTime() / 1000);

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}
function baseReq(overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, apiKeyInfo: { email: ADMIN }, groundingActor: { email: ADMIN, role: 'admin' }, ...overrides };
}
async function call(handler: (req: any, res: any, next: any) => Promise<void>, overrides: Record<string, any> = {}): Promise<{ res: any; next: jest.Mock }> {
  const res = makeRes();
  const next = jest.fn();
  await handler(baseReq(overrides), res, next);
  return { res, next };
}
function storeRow(id: string, owner: string, extra: Record<string, unknown> = {}): any {
  return {
    id, owner_email: owner, is_shared: false, name: `Store ${id}`, status: 'completed', metadata: null,
    embedding_model: 'm', embedding_dim: 3, active_generation: 0, expires_after: null, expires_at: null, last_active_at: CREATED, created_at: CREATED, ...extra
  };
}
/** A null-prototype object, as express 4.22 parses `?x[a]=1`. */
function bracketed(): any {
  const value = Object.create(null); value.a = '1'; return value;
}

beforeEach(() => {
  dbState.available = true;
  poolQuery.mockReset(); poolQuery.mockResolvedValue({ rows: [] });
  for (const fn of [...Object.values(adminFns), ...Object.values(repoFns)]) fn.mockReset();
  storageOfOwner.mockReset(); retryFile.mockReset(); jobSummary.mockReset();
  unfinishedReembedJobs.mockReset(); unfinishedReembedJobs.mockResolvedValue(new Map());
});

describe('user level: GET /stores', () => {
  it('lists own and shared stores as OpenAI store objects with is_shared, owned and owner_email', async () => {
    repoFns.listVisibleStores.mockResolvedValue([
      storeRow('vs_shared', OWNER, { is_shared: true, owned: false }),
      storeRow('vs_mine', ADMIN, { owned: true }),
    ]);
    poolQuery.mockResolvedValue({ rows: [{ store_id: 'vs_shared', status: 'completed', count: '2', bytes: '40' }] });
    const { res } = await call(ctrl.listStores, { query: { limit: '10', order: 'desc' } });
    expect(repoFns.listVisibleStores).toHaveBeenCalledWith(ADMIN, { limit: 10, after: null, teamIds: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ object: 'list', has_more: false, first_id: 'vs_shared', last_id: 'vs_mine' });
    expect(res.body.data[0]).toEqual({
      id: 'vs_shared', object: 'vector_store', created_at: CREATED_S, name: 'Store vs_shared', usage_bytes: 40,
      file_counts: { in_progress: 0, completed: 2, failed: 0, cancelled: 0, total: 2 }, status: 'completed',
      expires_after: null, expires_at: null, last_active_at: CREATED_S, metadata: {},
      is_shared: true, owned: false, owner_email: OWNER,
      embedding_model: 'm', embedding_dim: 3, active_generation: 0, embedding_state: 'current', reembed_job_id: null, chunking: null, team_ids: [],
    });
    expect(res.body.data[1]).toMatchObject({ id: 'vs_mine', is_shared: false, owned: true, owner_email: ADMIN });
  });

  it('pages with after and trims the extra row into has_more', async () => {
    repoFns.listVisibleStores.mockResolvedValue([storeRow('vs_a', ADMIN), storeRow('vs_b', ADMIN)]);
    const { res } = await call(ctrl.listStores, { query: { limit: '1', after: 'vs_x' } });
    expect(repoFns.listVisibleStores).toHaveBeenCalledWith(ADMIN, { limit: 1, after: 'vs_x', teamIds: [] });
    expect(res.body).toMatchObject({ has_more: true, first_id: 'vs_a', last_id: 'vs_a' });
    expect(res.body.data).toHaveLength(1);
  });

  it('reads a bracketed query (?limit[a]=1&after[a]=1) as absent instead of throwing', async () => {
    repoFns.listVisibleStores.mockResolvedValue([]);
    const { res } = await call(ctrl.listStores, { query: { limit: bracketed(), after: bracketed() } });
    expect(res.statusCode).toBe(200);
    expect(repoFns.listVisibleStores).toHaveBeenCalledWith(ADMIN, { limit: 20, after: null, teamIds: [] });
  });

  it.each([[{ order: 'asc' }], [{ before: 'vs_a' }]])('refuses %p: the list pages forwards only', async (query) => {
    const { res } = await call(ctrl.listStores, { query });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('unsupported_parameter');
    expect(repoFns.listVisibleStores).not.toHaveBeenCalled();
  });
});

describe('the embedding fields of grounding store objects', () => {
  it('reports the model, dimension, generation and the state against the configured model (m, 3)', async () => {
    repoFns.listVisibleStores.mockResolvedValue([
      storeRow('vs_cur', ADMIN),
      storeRow('vs_old', ADMIN, { embedding_model: 'old-model', active_generation: 2 }),
      storeRow('vs_dim', ADMIN, { embedding_model: 'old-model', embedding_dim: 8 }),
    ]);
    const { res } = await call(ctrl.listStores);
    expect(res.body.data.map((s: any) => [s.id, s.embedding_model, s.embedding_dim, s.active_generation, s.embedding_state])).toEqual([
      ['vs_cur', 'm', 3, 0, 'current'],
      ['vs_old', 'old-model', 3, 2, 'outdated'],
      ['vs_dim', 'old-model', 8, 0, 'dimension_mismatch'],
    ]);
  });

  it('names the unfinished re-embed job of an owned store, looked up once for the page; never another owner\'s', async () => {
    repoFns.listVisibleStores.mockResolvedValue([
      storeRow('vs_mine', ADMIN), storeRow('vs_idle', ADMIN), storeRow('vs_shared', OWNER, { is_shared: true }),
    ]);
    unfinishedReembedJobs.mockResolvedValue(new Map([['vs_mine', 'job_m'], ['vs_shared', 'job_s']]));
    const { res } = await call(ctrl.listStores);
    expect(unfinishedReembedJobs).toHaveBeenCalledTimes(1);
    expect(unfinishedReembedJobs).toHaveBeenCalledWith(['vs_mine', 'vs_idle', 'vs_shared']);
    expect(res.body.data.map((s: any) => [s.id, s.reembed_job_id])).toEqual([
      ['vs_mine', 'job_m'], ['vs_idle', null], ['vs_shared', null],
    ]);
  });

  it('GET /stores/:id carries the same fields', async () => {
    repoFns.readVisibleStore.mockResolvedValue(storeRow('vs_1', ADMIN, { embedding_model: 'old-model' }));
    unfinishedReembedJobs.mockResolvedValue(new Map([['vs_1', 'job_1']]));
    const { res } = await call(ctrl.readStore, { params: { id: 'vs_1' } });
    expect(res.body).toMatchObject({ embedding_model: 'old-model', embedding_dim: 3, active_generation: 0, embedding_state: 'outdated', reembed_job_id: 'job_1' });
  });

  it('the admin rows name every owner\'s re-embed job', async () => {
    adminFns.listAllStores.mockResolvedValue([storeRow('vs_o', OWNER, { embedding_model: 'old-model' })]);
    unfinishedReembedJobs.mockResolvedValue(new Map([['vs_o', 'job_o']]));
    const { res } = await call(ctrl.listAllStores);
    expect(res.body.data[0]).toMatchObject({ id: 'vs_o', owned: false, embedding_state: 'outdated', reembed_job_id: 'job_o' });
  });
});

describe('user level: GET /stores/:id and GET /storage', () => {
  it('reads a shared store of another owner, flagged', async () => {
    repoFns.readVisibleStore.mockResolvedValue(storeRow('vs_s', OWNER, { is_shared: true }));
    const { res } = await call(ctrl.readStore, { params: { id: 'vs_s' } });
    expect(repoFns.readVisibleStore).toHaveBeenCalledWith(ADMIN, 'vs_s', []);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 'vs_s', object: 'vector_store', is_shared: true, owned: false, owner_email: OWNER });
  });

  it('passes the acting user\'s teams to the store reads (team shares, spec 2026-10-14 §8)', async () => {
    const actor = { email: ADMIN, role: 'admin', teamIds: ['team-1', 'team-2'] };
    repoFns.readVisibleStore.mockResolvedValue(storeRow('vs_t', OWNER));
    await call(ctrl.readStore, { params: { id: 'vs_t' }, groundingActor: actor });
    expect(repoFns.readVisibleStore).toHaveBeenCalledWith(ADMIN, 'vs_t', ['team-1', 'team-2']);
    repoFns.listVisibleStores.mockResolvedValue([]);
    await call(ctrl.listStores, { query: { limit: '5' }, groundingActor: actor });
    expect(repoFns.listVisibleStores).toHaveBeenCalledWith(ADMIN, { limit: 5, after: null, teamIds: ['team-1', 'team-2'] });
  });

  it('404s a store the caller may not read, with the table\'s body', async () => {
    repoFns.readVisibleStore.mockResolvedValue(null);
    const { res } = await call(ctrl.readStore, { params: { id: 'vs_p' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: { message: 'No such vector store: vs_p', type: 'invalid_request_error', code: 'vector_store_not_found' } });
  });

  it('answers the caller\'s storage', async () => {
    storageOfOwner.mockResolvedValue({ owner_email: ADMIN, file_count: 2, logical_bytes: 30 });
    const { res } = await call(ctrl.storage);
    expect(storageOfOwner).toHaveBeenCalledWith(ADMIN);
    expect(res.body).toEqual({ owner_email: ADMIN, file_count: 2, logical_bytes: 30 });
  });
});

describe('admin reads', () => {
  it('GET /admin/overview answers the data layer\'s tiles, outdated stores counted against the configured model', async () => {
    const tiles = { stores: 1, files: 2, logical_bytes: 3, physical_bytes: 2, savings_bytes: 1, failed_ingestions: 0, outdated_stores: 1 };
    adminFns.overview.mockResolvedValue(tiles);
    const { res } = await call(ctrl.overview);
    expect(adminFns.overview).toHaveBeenCalledWith({ embeddingModel: 'm', embeddingDimensions: 3 });
    expect(res.body).toEqual(tiles);
  });

  it('GET /admin/stores passes owner, status, shared, after and limit, and shapes store objects', async () => {
    adminFns.listAllStores.mockResolvedValue([storeRow('vs_o', OWNER, { is_shared: true })]);
    const { res } = await call(ctrl.listAllStores, { query: { owner: OWNER, status: 'completed', shared: 'true', after: 'vs_z', limit: '5' } });
    expect(adminFns.listAllStores).toHaveBeenCalledWith({ owner: OWNER, status: 'completed', shared: true, embeddingState: null, after: 'vs_z', limit: 5 });
    expect(res.body.data[0]).toMatchObject({ id: 'vs_o', object: 'vector_store', is_shared: true, owned: false, owner_email: OWNER });
  });

  it('GET /admin/stores reads bracketed parameters as absent', async () => {
    adminFns.listAllStores.mockResolvedValue([]);
    const { res } = await call(ctrl.listAllStores, { query: { owner: bracketed(), status: bracketed(), shared: bracketed(), embedding_state: bracketed(), limit: bracketed() } });
    expect(res.statusCode).toBe(200);
    expect(adminFns.listAllStores).toHaveBeenCalledWith({ owner: null, status: null, shared: null, embeddingState: null, after: null, limit: 20 });
  });

  it.each(['current', 'outdated', 'dimension_mismatch'])('GET /admin/stores passes embedding_state=%s with the configured target', async (state) => {
    adminFns.listAllStores.mockResolvedValue([]);
    const { res } = await call(ctrl.listAllStores, { query: { embedding_state: state } });
    expect(res.statusCode).toBe(200);
    expect(adminFns.listAllStores).toHaveBeenCalledWith({
      owner: null, status: null, shared: null, embeddingState: { state, target: { embeddingModel: 'm', embeddingDimensions: 3 } }, after: null, limit: 20,
    });
  });

  it.each([
    [{ limit: '0' }, 'invalid_limit'],
    [{ limit: '101' }, 'invalid_limit'],
    [{ limit: '2.5' }, 'invalid_limit'],
    [{ status: 'failed' }, 'invalid_status'],
    [{ shared: 'yes' }, 'invalid_shared'],
    [{ embedding_state: 'stale' }, 'invalid_embedding_state'],
  ])('GET /admin/stores 400s %p', async (query, code) => {
    const { res } = await call(ctrl.listAllStores, { query });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(adminFns.listAllStores).not.toHaveBeenCalled();
  });

  it('maps the data layer\'s input errors to 400 invalid_parameter', async () => {
    adminFns.listAllFiles.mockRejectedValue(new AdminQueryInputError('owner must be a non-empty string of at most 320 characters.'));
    const { res, next } = await call(ctrl.listAllFiles, { query: { owner: 'x'.repeat(400) } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toEqual({ message: 'owner must be a non-empty string of at most 320 characters.', type: 'invalid_request_error', code: 'invalid_parameter' });
    expect(next).not.toHaveBeenCalled();
  });

  it('GET /admin/files answers file objects with owner and attachment count, never a hash', async () => {
    adminFns.listAllFiles.mockResolvedValue([
      { id: 'file-1', owner_email: OWNER, filename: 'a.txt', purpose: 'assistants', size_bytes: 12, created_at: CREATED, attachment_count: 2 },
    ]);
    const { res } = await call(ctrl.listAllFiles, { query: { owner: OWNER } });
    expect(adminFns.listAllFiles).toHaveBeenCalledWith({ owner: OWNER, after: null, limit: 20 });
    expect(res.body).toEqual({
      object: 'list', has_more: false, first_id: 'file-1', last_id: 'file-1',
      data: [{ id: 'file-1', object: 'file', bytes: 12, created_at: CREATED_S, filename: 'a.txt', purpose: 'assistants', owner_email: OWNER, attachment_count: 2 }]
    });
  });

  it('GET /admin/failed answers the sanitised rows with Unix seconds', async () => {
    const row = {
      id: 'vs_1/file-1', store_id: 'vs_1', store_name: 'S', file_id: 'file-1', filename: 'a.txt', owner_email: OWNER,
      last_error: { message: 'unsupported', name: 'E' }, attempts: 3, batch_id: null, created_at: CREATED
    };
    adminFns.listFailedAttachments.mockResolvedValue([row]);
    const { res } = await call(ctrl.listFailed, { query: { after: 'vs_2/file-2', limit: '1' } });
    expect(adminFns.listFailedAttachments).toHaveBeenCalledWith({ owner: null, batchId: null, after: 'vs_2/file-2', limit: 1 });
    expect(res.body.data).toEqual([{ ...row, created_at: CREATED_S }]);
    expect(res.body.last_id).toBe('vs_1/file-1');
  });

  it('GET /admin/failed narrows to one batch with batch_id (the job page of another owner\'s file batch)', async () => {
    adminFns.listFailedAttachments.mockResolvedValue([]);
    await call(ctrl.listFailed, { query: { batch_id: 'vsfb_1' } });
    expect(adminFns.listFailedAttachments).toHaveBeenCalledWith({ owner: null, batchId: 'vsfb_1', after: null, limit: 20 });
  });

  it('GET /admin/jobs/:job_id answers any owner\'s job with its owner, and 404 for an unknown one', async () => {
    const summary = { id: 'job_1', kind: 'file_batch', owner_email: OWNER, state: 'completed_with_errors' };
    jobSummaryAnyOwner.mockResolvedValueOnce(summary);
    const found = await call(ctrl.getJob, { params: { job_id: 'job_1' } });
    expect(jobSummaryAnyOwner).toHaveBeenCalledWith('job_1');
    expect(found.res.statusCode).toBe(200);
    expect(found.res.body).toEqual(summary);
    jobSummaryAnyOwner.mockResolvedValueOnce(null);
    const missing = await call(ctrl.getJob, { params: { job_id: 'job_2' } });
    expect(missing.res.statusCode).toBe(404);
    expect(missing.res.body.error.code).toBe('not_found');
  });

  it('GET /admin/storage pages on owner_email: first_id/last_id are e-mails, rows carry no id', async () => {
    adminFns.storageByOwner.mockResolvedValue([
      { owner_email: 'a@test.com', file_count: 1, logical_bytes: 1 },
      { owner_email: 'b@test.com', file_count: 2, logical_bytes: 5 },
      { owner_email: 'c@test.com', file_count: 1, logical_bytes: 9 },
    ]);
    const { res } = await call(ctrl.listStorage, { query: { limit: '2', after: 'Z@test.com' } });
    expect(adminFns.storageByOwner).toHaveBeenCalledWith({ after: 'Z@test.com', limit: 2 });
    expect(res.body).toEqual({
      object: 'list', has_more: true, first_id: 'a@test.com', last_id: 'b@test.com',
      data: [{ owner_email: 'a@test.com', file_count: 1, logical_bytes: 1 }, { owner_email: 'b@test.com', file_count: 2, logical_bytes: 5 }]
    });
  });

  it('GET /admin/jobs validates state and passes the filters', async () => {
    adminFns.listAllJobs.mockResolvedValue([{ id: 'job_1', owner_email: OWNER }]);
    const ok = await call(ctrl.listAllJobs, { query: { owner: OWNER, state: 'failed' } });
    expect(adminFns.listAllJobs).toHaveBeenCalledWith({ owner: OWNER, state: 'failed', after: null, limit: 20 });
    expect(ok.res.body).toMatchObject({ object: 'list', data: [{ id: 'job_1', owner_email: OWNER }] });
    const bad = await call(ctrl.listAllJobs, { query: { state: 'done' } });
    expect(bad.res.statusCode).toBe(400);
    expect(bad.res.body.error.code).toBe('invalid_state');
  });
});

describe('admin mutations run the owner-scoped functions as the resolved owner (decision 6)', () => {
  it('DELETE /admin/stores/:id deletes as the store owner', async () => {
    adminFns.ownerOfStore.mockResolvedValue(OWNER);
    repoFns.deleteStoreCascade.mockResolvedValue({ deleted: true });
    const { res } = await call(ctrl.deleteStore, { params: { id: 'vs_1' } });
    expect(repoFns.deleteStoreCascade).toHaveBeenCalledWith('vs_1', OWNER);
    expect(res.body).toEqual({ id: 'vs_1', object: 'vector_store.deleted', deleted: true });
  });

  it('DELETE /admin/stores/:id 404s an unknown store and a store gone in between', async () => {
    adminFns.ownerOfStore.mockResolvedValue(null);
    const unknown = await call(ctrl.deleteStore, { params: { id: 'vs_x' } });
    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.res.body.error.code).toBe('vector_store_not_found');
    expect(repoFns.deleteStoreCascade).not.toHaveBeenCalled();

    adminFns.ownerOfStore.mockResolvedValue(OWNER);
    repoFns.deleteStoreCascade.mockResolvedValue({ deleted: false });
    const gone = await call(ctrl.deleteStore, { params: { id: 'vs_1' } });
    expect(gone.res.statusCode).toBe(404);
  });

  it('DELETE /admin/stores/:id answers a deadlock as the owner\'s delete does (409 concurrent_modification)', async () => {
    adminFns.ownerOfStore.mockResolvedValue(OWNER);
    repoFns.deleteStoreCascade.mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    const { res, next } = await call(ctrl.deleteStore, { params: { id: 'vs_1' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('concurrent_modification');
    expect(next).not.toHaveBeenCalled();
  });

  it('DELETE /admin/files/:id detaches everywhere and deletes as the file owner', async () => {
    adminFns.ownerOfFile.mockResolvedValue(OWNER);
    repoFns.deleteFileDetachingEverywhere.mockResolvedValue({ deleted: true, sha256: 'x' });
    const { res } = await call(ctrl.deleteFile, { params: { id: 'file-1' } });
    expect(repoFns.deleteFileDetachingEverywhere).toHaveBeenCalledWith('file-1', OWNER);
    expect(res.body).toEqual({ id: 'file-1', object: 'file', deleted: true });
  });

  it('DELETE /admin/files/:id answers 404 file_not_found and 409 file_in_use like the owner path', async () => {
    adminFns.ownerOfFile.mockResolvedValue(null);
    const unknown = await call(ctrl.deleteFile, { params: { id: 'file-x' } });
    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.res.body).toEqual({ error: { message: 'No such file: file-x', type: 'invalid_request_error', code: 'file_not_found' } });

    adminFns.ownerOfFile.mockResolvedValue(OWNER);
    repoFns.deleteFileDetachingEverywhere.mockResolvedValue({ deleted: false, inUse: true });
    const inUse = await call(ctrl.deleteFile, { params: { id: 'file-1' } });
    expect(inUse.res.statusCode).toBe(409);
    expect(inUse.res.body.error.code).toBe('file_in_use');
  });

  it('DELETE /admin/files/:id answers a deadlock as the owner\'s delete does (409 concurrent_modification)', async () => {
    adminFns.ownerOfFile.mockResolvedValue(OWNER);
    repoFns.deleteFileDetachingEverywhere.mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    const { res, next } = await call(ctrl.deleteFile, { params: { id: 'file-1' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('concurrent_modification');
    expect(next).not.toHaveBeenCalled();
  });

  it('POST /admin/stores/:id/files/:file_id/retry retries and reads the job as the store owner', async () => {
    adminFns.ownerOfStore.mockResolvedValue(OWNER);
    retryFile.mockResolvedValue({ ok: true, job_id: 'job_1', retried: 1 });
    jobSummary.mockResolvedValue({ id: 'job_1', state: 'queued' });
    const { res } = await call(ctrl.retryStoreFile, { params: { id: 'vs_1', file_id: 'file-1' } });
    expect(retryFile).toHaveBeenCalledWith('vs_1', 'file-1', OWNER);
    expect(jobSummary).toHaveBeenCalledWith('job_1', OWNER);
    expect(res.body).toEqual({ job_id: 'job_1', job: { id: 'job_1', state: 'queued' }, retried: 1 });
  });

  it.each([
    ['not_found', 404], ['job_running', 409], ['store_expired', 409], ['nothing_to_retry', 409],
  ])('retry maps the refusal %s to %i', async (error, status) => {
    adminFns.ownerOfStore.mockResolvedValue(OWNER);
    retryFile.mockResolvedValue({ ok: false, error });
    const { res } = await call(ctrl.retryStoreFile, { params: { id: 'vs_1', file_id: 'file-1' } });
    expect(res.statusCode).toBe(status);
    expect(res.body.error.code).toBe(error);
  });

  it('retry 404s an unknown store and answers a deadlock with 503 retry_conflict', async () => {
    adminFns.ownerOfStore.mockResolvedValue(null);
    const unknown = await call(ctrl.retryStoreFile, { params: { id: 'vs_x', file_id: 'file-1' } });
    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.res.body.error.code).toBe('not_found');
    expect(retryFile).not.toHaveBeenCalled();

    adminFns.ownerOfStore.mockResolvedValue(OWNER);
    retryFile.mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    const conflict = await call(ctrl.retryStoreFile, { params: { id: 'vs_1', file_id: 'file-1' } });
    expect(conflict.res.statusCode).toBe(503);
    expect(conflict.res.body.error.code).toBe('retry_conflict');
  });

  it('an id no row can carry resolves to no owner without a query, so the admin routes 404 like the owner\'s', async () => {
    const actual = jest.requireActual('../../src/fileSearch/admin') as typeof import('../../src/fileSearch/admin');
    const overLong = 'vs_'.padEnd(300, 'x');
    await expect(actual.ownerOfStore(overLong)).resolves.toBeNull();
    await expect(actual.ownerOfFile('file-'.padEnd(300, 'x'))).resolves.toBeNull();
    await expect(actual.ownerOfStore(`vs_${String.fromCharCode(0)}`)).resolves.toBeNull();
    expect(poolQuery).not.toHaveBeenCalled();

    adminFns.ownerOfStore.mockImplementation((id: string) => actual.ownerOfStore(id));
    adminFns.ownerOfFile.mockImplementation((id: string) => actual.ownerOfFile(id));
    const retry = await call(ctrl.retryStoreFile, { params: { id: overLong, file_id: 'file-1' } });
    expect(retry.res.statusCode).toBe(404);
    expect(retry.res.body.error.code).toBe('not_found');
    const del = await call(ctrl.deleteStore, { params: { id: overLong } });
    expect(del.res.statusCode).toBe(404);
    const delFile = await call(ctrl.deleteFile, { params: { id: 'file-'.padEnd(300, 'x') } });
    expect(delFile.res.statusCode).toBe(404);
    expect(delFile.res.body.error.code).toBe('file_not_found');
  });
});

describe('sharing (decision 8)', () => {
  it('shares and unshares a store the acting admin owns', async () => {
    repoFns.setStoreShared.mockResolvedValue(storeRow('vs_1', ADMIN, { is_shared: true }));
    const shared = await call(ctrl.shareStore, { params: { id: 'vs_1' } });
    expect(repoFns.setStoreShared).toHaveBeenCalledWith('vs_1', ADMIN, true);
    expect(shared.res.body).toMatchObject({ id: 'vs_1', object: 'vector_store', is_shared: true, owned: true, owner_email: ADMIN });

    repoFns.setStoreShared.mockResolvedValue(storeRow('vs_1', ADMIN, { is_shared: false }));
    const unshared = await call(ctrl.unshareStore, { params: { id: 'vs_1' } });
    expect(repoFns.setStoreShared).toHaveBeenLastCalledWith('vs_1', ADMIN, false);
    expect(unshared.res.body.is_shared).toBe(false);
  });

  it('404s a store the acting admin does not own, indistinguishable from an unknown one', async () => {
    repoFns.setStoreShared.mockResolvedValue(null);
    const { res } = await call(ctrl.shareStore, { params: { id: 'vs_other' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: { message: 'No such vector store: vs_other', type: 'invalid_request_error', code: 'vector_store_not_found' } });
  });
});

describe('every handler answers 503 while file_search is unavailable', () => {
  const handlers: [string, any][] = [
    ['listStores', ctrl.listStores], ['readStore', ctrl.readStore], ['storage', ctrl.storage], ['overview', ctrl.overview],
    ['listAllStores', ctrl.listAllStores], ['listAllFiles', ctrl.listAllFiles], ['listFailed', ctrl.listFailed],
    ['listStorage', ctrl.listStorage], ['listAllJobs', ctrl.listAllJobs], ['deleteStore', ctrl.deleteStore],
    ['deleteFile', ctrl.deleteFile], ['retryStoreFile', ctrl.retryStoreFile], ['shareStore', ctrl.shareStore], ['unshareStore', ctrl.unshareStore],
  ];
  it.each(handlers)('%s', async (_name, handler) => {
    dbState.available = false;
    const { res } = await call(handler, { params: { id: 'vs_1', file_id: 'file-1' } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('file_search_unavailable');
  });
});
