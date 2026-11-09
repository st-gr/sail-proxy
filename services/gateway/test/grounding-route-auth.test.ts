/**
 * The grounding route group with the REAL service-key middleware (spec 2026-10-01 §4.2):
 * not mounted standalone, closed to every caller but the admin service key, and the acting
 * headers decide whose data the handlers see.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

let mockStandalone = false;
jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: () => mockStandalone,
  shouldEnableDistributedCaching: () => false,
  getCachedUnifiedAuthConfig: () => ({})
}));

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

const validateApiKey = jest.fn<any>();
jest.mock('../src/services/unifiedApiKeyValidationService', () => ({
  __esModule: true,
  unifiedApiKeyValidationService: { validateApiKey: (...a: any[]) => validateApiKey(...a) }
}));

const fileSearchState = { enabled: true, pool: true, available: true };
let mockChunking: any = { strategy: 'structure', maxChunkSizeTokens: 600, chunkOverlapTokens: 0, contextual: true };
let mockVisionDefault: string | undefined;
jest.mock('../src/fileSearch/db', () => ({
  __esModule: true,
  isFileSearchAvailable: () => fileSearchState.available,
  getPool: () => (fileSearchState.pool ? { query: jest.fn() } : null)
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {},
  getTrustForwardedFor: () => false,
  getFileSearchConfig: () => ({
    enabled: fileSearchState.enabled,
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: 1536,
    limits: { maxFileBytes: 33554432, maxTokensPerFile: 5000000, maxFilesPerStore: 10000 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    chunking: mockChunking,
    ...(mockVisionDefault ? { parsing: { vision: { defaultMode: mockVisionDefault } } } : {}),
  })
}));

// Probes instead of the real tables: they answer with the owner the real handlers would read.
jest.mock('../src/routes/fileRouteTable', () => ({
  __esModule: true,
  registerFileRoutes: (router: any, prefix: string) => {
    router.get(prefix, (req: any, res: any) => res.json({ table: 'files', owner: req.apiKeyInfo?.email ?? null }));
  }
}));
jest.mock('../src/routes/vectorStoreRouteTable', () => ({
  __esModule: true,
  registerVectorStoreRoutes: (router: any, prefix: string) => {
    router.get(prefix, (req: any, res: any) => res.json({ table: 'stores', owner: req.apiKeyInfo?.email ?? null }));
    router.get(`${prefix}/:id`, (_req: any, res: any) => res.json({ table: 'stores' }));
    router.get(`${prefix}/:id/files`, (req: any, res: any) => res.json({ table: 'stores', owner: req.apiKeyInfo?.email ?? null }));
    // A table route the job routes must win against.
    router.post(`${prefix}/:id/files/:file_id/retry`, (_req: any, res: any) => res.json({ table: 'stores' }));
  }
}));
const listVisibleStores = jest.fn<any>();
jest.mock('../src/fileSearch/repository', () => ({
  __esModule: true,
  deleteStoreFile: jest.fn(),
  listVisibleStores: (...a: any[]) => listVisibleStores(...a),
  readVisibleStore: jest.fn(async () => null),
  setStoreShared: jest.fn(async () => null),
  shareStoreWithTeam: jest.fn(async () => null),
  unshareStoreFromTeam: jest.fn(async () => undefined),
  readStoreRow: jest.fn(async () => null),
  deleteTeamShares: jest.fn(async () => 0),
  teamIdsOfStores: jest.fn(async () => new Map()),
  deleteStoreCascade: jest.fn(async () => ({ deleted: false })),
  deleteFileDetachingEverywhere: jest.fn(),
  VALID_FILE_STATUSES: ['in_progress', 'completed', 'failed', 'cancelled']
}));
const storageOfOwner = jest.fn<any>();
jest.mock('../src/fileSearch/groundingQueries', () => ({
  __esModule: true,
  listAttachmentsForFiles: jest.fn(),
  storageOfOwner: (...a: any[]) => storageOfOwner(...a)
}));
// Every admin read answers an empty result; the tests below are about who reaches the handlers.
const adminCalls: string[] = [];
jest.mock('../src/fileSearch/admin', () => {
  const actual = jest.requireActual('../src/fileSearch/admin') as any;
  const record = (name: string, value: unknown) => async (...args: any[]) => { adminCalls.push(name); (adminArgs as any)[name] = args; return value; };
  return {
    __esModule: true,
    ...actual,
    overview: record('overview', { stores: 0 }),
    listAllStores: record('listAllStores', []),
    listAllFiles: record('listAllFiles', []),
    listFailedAttachments: record('listFailedAttachments', []),
    storageByOwner: record('storageByOwner', []),
    listAllJobs: record('listAllJobs', []),
    ownerOfStore: record('ownerOfStore', null),
    ownerOfFile: record('ownerOfFile', null)
  };
});
const adminArgs: Record<string, any[]> = {};
// The re-embed engine: recorded like the admin reads, so "no handler ran" covers it too.
jest.mock('../src/fileSearch/reembed', () => {
  const record = (name: string, value: unknown) => async (...args: any[]) => { adminCalls.push(name); (adminArgs as any)[name] = args; return value; };
  return {
    __esModule: true,
    estimateStore: record('estimateStore', null),
    startReembed: record('startReembed', { ok: false, error: 'not_found' }),
    estimateOutdated: record('estimateOutdated', { stores: 0, files: 0, chunks: 0, estimated_tokens: 0, skipped: [] }),
    startBulkReembed: record('startBulkReembed', { ok: false, error: 'nothing_to_reembed' }),
    cancelReembed: record('cancelReembed', { ok: false, error: 'not_found' }),
    retryReembed: record('retryReembed', { ok: false, error: 'not_found' }),
    unfinishedReembedJobs: async () => new Map()
  };
});
// Blob storage administration: recorded like the admin reads.
jest.mock('../src/fileSearch/blob/blobAdmin', () => {
  const record = (name: string, value: unknown) => async (...args: any[]) => { adminCalls.push(name); (adminArgs as any)[name] = args; return value; };
  return {
    __esModule: true,
    blobStorageOverview: record('blobStorageOverview', { configured_backend: 'db', storages: [] }),
    testS3Connection: record('testS3Connection', { ok: false, error: { reason: 'not_configured' } })
  };
});
jest.mock('../src/fileSearch/blob/blobMigration', () => {
  const actual = jest.requireActual('../src/fileSearch/blob/blobMigration') as any;
  const record = (name: string, value: unknown) => async (...args: any[]) => { adminCalls.push(name); (adminArgs as any)[name] = args; return value; };
  return { __esModule: true, ...actual, startBlobMigration: record('startBlobMigration', { ok: false, error: 'nothing_to_migrate' }) };
});
jest.mock('../src/controllers/filesController', () => ({ __esModule: true, deleteFile: jest.fn() }));

const listJobs = jest.fn<any>();
const jobSummary = jest.fn<any>();
const retryFile = jest.fn<any>();
jest.mock('../src/fileSearch/jobs', () => ({
  __esModule: true,
  listJobs: (...a: any[]) => listJobs(...a),
  jobSummary: (...a: any[]) => jobSummary(...a),
  jobSummaryAnyOwner: jest.fn(async () => null),
  retryJob: jest.fn(),
  retryFile: (...a: any[]) => retryFile(...a)
}));
jest.mock('../src/fileSearch/batches', () => ({ __esModule: true, requestBatchCancel: jest.fn() }));

import { mountGroundingRoutes, GROUNDING_PATH } from '../src/routes/groundingRoutes';
import { groundingActingUser } from '../src/middlewares/groundingActingUser';
import { setUnavailableCause } from '../src/fileSearch/unavailableCause';
import { SERVICE_KEYS } from '@libs/service-auth';

const SERVICE_KEY = 'sk-' + 'a1'.repeat(24);
const USER_KEY = 'sk-' + 'b2'.repeat(24);
const ACTING = { 'X-Grounding-Acting-Email': 'user@test.com', 'X-Grounding-Acting-Role': 'user' };

function appWith(): express.Application {
  const app = express();
  app.use(express.json());
  mountGroundingRoutes(app);
  return app;
}

function asService(): void {
  validateApiKey.mockResolvedValue({
    valid: true,
    data: { keyId: 'k-svc', name: SERVICE_KEYS.ADMIN_TO_GATEWAY.NAME, email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL, permissions: [] }
  });
}

beforeEach(() => {
  mockStandalone = false;
  validateApiKey.mockReset();
  fileSearchState.enabled = true; fileSearchState.pool = true; fileSearchState.available = true;
});

describe('the grounding routes are not mounted in standalone mode', () => {
  it('reports the decision and the paths 404', async () => {
    mockStandalone = true;
    expect(mountGroundingRoutes(express())).toBe(false);
    expect((await request(appWith()).get(`${GROUNDING_PATH}/status`).set(ACTING)).status).toBe(404);
    mockStandalone = false;
    expect(mountGroundingRoutes(express())).toBe(true);
  });
});

describe('only the admin service key gets in', () => {
  it('401s a request with no key', async () => {
    expect((await request(appWith()).get(`${GROUNDING_PATH}/files`).set(ACTING)).status).toBe(401);
  });

  it('403s an ordinary API key even when it sends the acting headers', async () => {
    validateApiKey.mockResolvedValue({ valid: true, data: { keyId: 'k-user', name: 'someone', email: 'attacker@test.com', permissions: ['grounding:user', 'grounding:admin'] } });
    const r = await request(appWith()).get(`${GROUNDING_PATH}/files`).set('X-API-Key', USER_KEY).set(ACTING);
    expect(r.status).toBe(403);
    expect(r.body.table).toBeUndefined();
  });

  it('refuses a key the admin service rejects, and the handlers do not run', async () => {
    validateApiKey.mockResolvedValue({ valid: false, data: null });
    const r = await request(appWith()).get(`${GROUNDING_PATH}/stores`).set('X-API-Key', USER_KEY).set(ACTING);
    expect([401, 403]).toContain(r.status);
    expect(r.body.table).toBeUndefined();
  });

  it('400s the service key without acting headers: the gateway never guesses a user', async () => {
    asService();
    const r = await request(appWith()).get(`${GROUNDING_PATH}/files`).set('X-API-Key', SERVICE_KEY);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_acting_user');
  });
});

describe('the acting user is the owner the existing handlers see', () => {
  it('files and stores handlers run as the acting e-mail, although the stored key carries no permissions', async () => {
    asService();
    const files = await request(appWith()).get(`${GROUNDING_PATH}/files`).set('X-API-Key', SERVICE_KEY).set(ACTING);
    expect(files.status).toBe(200);
    expect(files.body).toEqual({ table: 'files', owner: 'user@test.com' });
    const stores = await request(appWith()).get(`${GROUNDING_PATH}/stores/vs_1/files`).set('X-API-Key', SERVICE_KEY)
      .set({ 'X-Grounding-Acting-Email': 'other@test.com', 'X-Grounding-Acting-Role': 'admin' });
    expect(stores.body).toEqual({ table: 'stores', owner: 'other@test.com' });
  });
});

describe('acting teams (spec 2026-10-14 §8)', () => {
  const A = '0b6c2f0e-1111-4c4c-9a9a-000000000001';
  const B = '0b6c2f0e-1111-4c4c-9a9a-000000000002';
  /** groundingActingUser on a request carrying the admin service key and the acting user headers. */
  function actorFor(extraHeaders: Record<string, unknown>): { status: number; actor: any; error?: string } {
    const req: any = {
      headers: { 'x-grounding-acting-email': 'u@test.com', 'x-grounding-acting-role': 'user', ...extraHeaders },
      serviceAuth: { authType: 'service-key', serviceKey: { email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL } },
    };
    const out: any = { status: 200 };
    const res: any = { status: (code: number) => { out.status = code; return res; }, json: (body: any) => { out.error = body.error; return res; } };
    groundingActingUser(req, res, () => undefined);
    return { status: out.status, actor: req.groundingActor, error: out.error };
  }

  it('parses the two team headers into the actor; absent means none', async () => {
    expect((await actorFor({ 'x-grounding-acting-teams': `${A},${B}`, 'x-grounding-acting-admin-teams': A })).actor).toMatchObject({ teamIds: [A, B], adminTeamIds: [A] });
    expect((await actorFor({})).actor).toMatchObject({ teamIds: [], adminTeamIds: [] });
    // Empty headers, spaces, upper case and repeats normalise.
    expect(actorFor({ 'x-grounding-acting-teams': '', 'x-grounding-acting-admin-teams': '' }).actor).toMatchObject({ teamIds: [], adminTeamIds: [] });
    expect(actorFor({ 'x-grounding-acting-teams': ` ${A.toUpperCase()} , ${B},${A}` }).actor).toMatchObject({ teamIds: [A, B], adminTeamIds: [] });
  });

  it('refuses a malformed list and an admin team that is not one of the teams', async () => {
    expect((await actorFor({ 'x-grounding-acting-teams': 'not-a-uuid' })).status).toBe(400);
    expect((await actorFor({ 'x-grounding-acting-teams': A, 'x-grounding-acting-admin-teams': B })).status).toBe(400);
    expect(actorFor({ 'x-grounding-acting-teams': A, 'x-grounding-acting-admin-teams': B }).error).toBe('invalid_acting_teams');
    expect(actorFor({ 'x-grounding-acting-teams': `${A},` }).status).toBe(400);
    expect(actorFor({ 'x-grounding-acting-teams': [A, B] }).status).toBe(400);
    expect(actorFor({ 'x-grounding-acting-admin-teams': A }).status).toBe(400);
  });

  it('accepts 200 teams and refuses 201', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `0b6c2f0e-1111-4c4c-9a9a-${String(i).padStart(12, '0')}`).join(',');
    expect(actorFor({ 'x-grounding-acting-teams': ids(200) }).actor.teamIds).toHaveLength(200);
    expect(actorFor({ 'x-grounding-acting-teams': ids(201) }).status).toBe(400);
  });

  it('POST /stores/:id/share-team and /unshare-team reach the team-share handlers', async () => {
    asService();
    const share = await request(appWith()).post(`${GROUNDING_PATH}/stores/vs_1/share-team`).set('X-API-Key', SERVICE_KEY)
      .set({ ...ACTING, 'X-Grounding-Acting-Teams': A }).send({ teamId: A });
    expect(share.status).toBe(403);
    expect(share.body.error.code).toBe('team_admin_required');
    const unshare = await request(appWith()).post(`${GROUNDING_PATH}/stores/vs_1/unshare-team`).set('X-API-Key', SERVICE_KEY)
      .set(ACTING).send({ teamId: A });
    expect(unshare.status).toBe(404);
    expect(unshare.body.error.code).toBe('vector_store_not_found');
    const bad = await request(appWith()).post(`${GROUNDING_PATH}/stores/vs_1/share-team`).set('X-API-Key', SERVICE_KEY)
      .set(ACTING).send({ teamId: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_team_id');
  });
});

describe('GET /status', () => {
  const get = async () => { asService(); return request(appWith()).get(`${GROUNDING_PATH}/status`).set('X-API-Key', SERVICE_KEY).set(ACTING); };

  it('reports an available file_search with its model, backend and limits', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      available: true, reason: null, embeddingModel: 'text-embedding-3-large', embeddingDimensions: 1536,
      blobBackend: 'db', limits: { maxFileBytes: 33554432, maxFilesPerStore: 10000 },
      chunking: { type: 'structure', max_tokens: 600, overlap_tokens: 0, contextual: true },
      vision: { available: true, model: 'gemini-3.5-flash-lite', unmaskedWarning: false },
    });
  });

  it('a configured vision default reaches the default chunking; where vision is switched off it is neither available nor default', async () => {
    mockVisionDefault = 'auto';
    try {
      expect((await get()).body.chunking).toEqual({ type: 'structure', max_tokens: 600, overlap_tokens: 0, contextual: true, vision: 'auto' });
      process.env.FILE_SEARCH_VISION = 'off';
      const off = await get();
      expect(off.body.chunking).toEqual({ type: 'structure', max_tokens: 600, overlap_tokens: 0, contextual: true });
      expect(off.body.vision).toMatchObject({ available: false });
    } finally {
      mockVisionDefault = undefined;
      delete process.env.FILE_SEARCH_VISION;
    }
  });

  it('reports static 800/400 as the default chunking when the configured one is invalid', async () => {
    const saved = mockChunking;
    mockChunking = { strategy: 'static', maxChunkSizeTokens: 50, chunkOverlapTokens: 0, contextual: false };
    try {
      const r = await get();
      expect(r.body.chunking).toEqual({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
    } finally {
      mockChunking = saved;
    }
  });

  it.each([
    ['disabled', () => { fileSearchState.enabled = false; fileSearchState.available = false; }],
    ['no_database', () => { fileSearchState.pool = false; fileSearchState.available = false; }],
    ['not_migrated', () => { fileSearchState.available = false; setUnavailableCause(null); }],
    ['embedding_dimensions', () => { fileSearchState.available = false; setUnavailableCause('embedding_dimensions'); }],
    ['schema_not_provisioned', () => { fileSearchState.available = false; setUnavailableCause('schema_not_provisioned'); }],
    ['schema_outdated', () => { fileSearchState.available = false; setUnavailableCause('schema_outdated'); }],
    ['migration_failed', () => { fileSearchState.available = false; setUnavailableCause('migration_failed'); }],
  ])('answers 200 with reason %s instead of a 503', async (reason, arrange) => {
    arrange();
    try {
      const r = await get();
      expect(r.status).toBe(200);
      expect(r.body.available).toBe(false);
      expect(r.body.reason).toBe(reason);
    } finally {
      setUnavailableCause(null);
    }
  });
});

describe('job routes', () => {
  beforeEach(() => { listJobs.mockReset(); jobSummary.mockReset(); retryFile.mockReset(); });
  const authed = (r: request.Test) => r.set('X-API-Key', SERVICE_KEY).set(ACTING);

  it('GET /jobs scopes to the acting e-mail', async () => {
    asService(); listJobs.mockResolvedValue([]);
    const r = await authed(request(appWith()).get(`${GROUNDING_PATH}/jobs?limit=5`));
    expect(r.status).toBe(200);
    expect(listJobs).toHaveBeenCalledWith('user@test.com', { limit: 5, after: null, state: null });
  });

  it('answers a bracketed query (?state[x]=1) as no filter instead of hanging (express 4.22)', async () => {
    asService(); listJobs.mockResolvedValue([]);
    const r = await authed(request(appWith()).get(`${GROUNDING_PATH}/jobs?state[x]=1&limit[a]=2`));
    expect(r.status).toBe(200);
    expect(listJobs).toHaveBeenCalledWith('user@test.com', { limit: 20, after: null, state: null });
  });

  it('GET /jobs/:job_id 404s an unknown job and rejects a NUL in the id', async () => {
    asService(); jobSummary.mockResolvedValue(null);
    const missing = await authed(request(appWith()).get(`${GROUNDING_PATH}/jobs/job_x`));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
    const nul = await authed(request(appWith()).get(`${GROUNDING_PATH}/jobs/job_%00x`));
    expect(nul.status).toBe(400);
  });

  it('POST /stores/:id/files/:file_id/retry reaches the job handler, not the store table', async () => {
    asService(); retryFile.mockResolvedValue({ ok: true, job_id: null, retried: 1 });
    const r = await authed(request(appWith()).post(`${GROUNDING_PATH}/stores/vs_1/files/file-a/retry`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ job_id: null, job: null, retried: 1 });
    expect(retryFile).toHaveBeenCalledWith('vs_1', 'file-a', 'user@test.com');
  });

  it('is closed to a non-service key', async () => {
    validateApiKey.mockResolvedValue({ valid: true, data: { keyId: 'k-u', name: 'user', email: 'u@test.com', permissions: [] } });
    const r = await request(appWith()).get(`${GROUNDING_PATH}/jobs`).set('X-API-Key', USER_KEY).set(ACTING);
    expect(r.status).toBe(403);
  });

  it('503s while file_search is unavailable, saying why', async () => {
    asService(); fileSearchState.available = false; setUnavailableCause('schema_outdated');
    try {
      const r = await authed(request(appWith()).get(`${GROUNDING_PATH}/jobs`));
      expect(r.status).toBe(503);
      expect(r.body.error).toMatchObject({ code: 'file_search_unavailable', message: expect.stringMatching(/older than this gateway/) });
    } finally {
      setUnavailableCause(null);
    }
  });
});

const ADMIN_ROUTES: [string, string][] = [
  ['get', '/admin/overview'],
  ['get', '/admin/stores'],
  ['get', '/admin/files'],
  ['get', '/admin/failed'],
  ['get', '/admin/storage'],
  ['get', '/admin/jobs'],
  ['get', '/admin/jobs/job_1'],
  ['delete', '/admin/stores/vs_1'],
  ['delete', '/admin/files/file-1'],
  ['post', '/admin/stores/vs_1/files/file-1/retry'],
  ['post', '/admin/stores/vs_1/share'],
  ['post', '/admin/stores/vs_1/unshare'],
  ['delete', '/admin/teams/0b6c2f0e-1111-4c4c-9a9a-000000000001/shares'],
  ['get', '/admin/stores/vs_1/reembed/estimate'],
  ['post', '/admin/stores/vs_1/reembed'],
  ['get', '/admin/reembed-outdated/estimate'],
  ['post', '/admin/reembed-outdated'],
  ['post', '/admin/jobs/job_1/cancel'],
  ['post', '/admin/jobs/job_1/retry'],
  ['get', '/admin/jobs/job_1/failures'],
  ['get', '/admin/blob-storage'],
  ['post', '/admin/blob-storage/test'],
  ['post', '/admin/blob-storage/migrate'],
  ['get', '/admin/not-a-route'],
];
const AS_ADMIN = { 'X-Grounding-Acting-Email': 'admin@test.com', 'X-Grounding-Acting-Role': 'admin' };

describe('the /admin routes need the acting role admin (plan decision 7)', () => {
  beforeEach(() => { adminCalls.length = 0; });
  const send = (method: string, path: string) => (request(appWith()) as any)[method](`${GROUNDING_PATH}${path}`).set('X-API-Key', SERVICE_KEY);

  it.each(ADMIN_ROUTES)('403s the role user on %s %s, and no handler runs', async (method, path) => {
    asService();
    const r = await send(method, path).set(ACTING);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: { message: 'This operation requires a grounding administrator.', type: 'permission_error', code: 'grounding_admin_required' }
    });
    expect(adminCalls).toEqual([]);
  });

  it.each(ADMIN_ROUTES.filter(([, path]) => path !== '/admin/not-a-route'))('lets the role admin reach %s %s', async (method, path) => {
    asService();
    const r = await send(method, path).set(AS_ADMIN);
    // 200, or the handler's own JSON 404/409 (unknown store/file/job, nothing to re-embed) — never
    // express's HTML 404 or the guard's 403.
    expect([200, 404, 409]).toContain(r.status);
    if (r.status === 404) expect(r.body.error.code).toMatch(/not_found$/);
    if (r.status === 409) expect(r.body.error.code).toBe('nothing_to_reembed');
  });

  it('the admin re-embed routes reach the engine across owners: owner resolved first, admin as the actor', async () => {
    asService();
    const start = await send('post', '/admin/stores/vs_1/reembed').set(AS_ADMIN);
    expect(start.status).toBe(404); // ownerOfStore answers null in this harness
    expect(adminCalls).toEqual(['ownerOfStore']);
    adminCalls.length = 0;
    const estimate = await send('get', '/admin/stores/vs_1/reembed/estimate?x[a]=1').set(AS_ADMIN);
    expect(estimate.status).toBe(404);
    expect(estimate.body.error.code).toBe('vector_store_not_found');
    expect(adminCalls).toEqual(['ownerOfStore']);
    await send('post', '/admin/reembed-outdated').set(AS_ADMIN);
    expect(adminArgs.startBulkReembed).toEqual([{ email: 'admin@test.com', credentialId: 'k-svc', authType: 'api_key' }]);
    const cancel = await send('post', '/admin/jobs/job_1/cancel').set(AS_ADMIN);
    expect(cancel.status).toBe(404);
    expect(adminArgs.cancelReembed).toEqual([null, 'job_1']);
    await send('post', '/admin/jobs/job_1/retry').set(AS_ADMIN);
    expect(adminArgs.retryReembed).toEqual([null, 'job_1']);
  });

  it('the blob storage routes reach their handlers for the role admin', async () => {
    asService();
    const overview = await send('get', '/admin/blob-storage').set(AS_ADMIN);
    expect(overview.status).toBe(200);
    expect(overview.body).toEqual({ configured_backend: 'db', storages: [] });
    const test = await send('post', '/admin/blob-storage/test').set(AS_ADMIN);
    expect(test.body).toEqual({ ok: false, error: { reason: 'not_configured' } });
    const migrate = await send('post', '/admin/blob-storage/migrate').set(AS_ADMIN).send({ target: 's3' });
    expect(migrate.status).toBe(200);
    expect(migrate.body).toEqual({ job: null });
    expect(adminArgs.startBlobMigration).toEqual(['s3', { email: 'admin@test.com', credentialId: 'k-svc', authType: 'api_key' }]);
    expect(adminCalls).toEqual(['blobStorageOverview', 'testS3Connection', 'startBlobMigration']);
  });

  it('a forged admin role on an ordinary API key is refused before the admin guard', async () => {
    validateApiKey.mockResolvedValue({ valid: true, data: { keyId: 'k-u', name: 'user', email: 'attacker@test.com', permissions: ['grounding:admin'] } });
    const r = await request(appWith()).get(`${GROUNDING_PATH}/admin/overview`).set('X-API-Key', USER_KEY).set(AS_ADMIN);
    expect(r.status).toBe(403);
    expect(r.body.stores).toBeUndefined();
    expect(adminCalls).toEqual([]);
  });

  it('reads bracketed admin query parameters as absent instead of hanging (express 4.22)', async () => {
    asService();
    const r = await send('get', '/admin/stores?owner[a]=1&status[a]=1&shared[a]=1&embedding_state[a]=1&limit[a]=2').set(AS_ADMIN);
    expect(r.status).toBe(200);
    expect(adminArgs.listAllStores).toEqual([{ owner: null, status: null, shared: null, embeddingState: null, after: null, limit: 20 }]);
  });
});

describe('the user-level re-embed routes (owner only)', () => {
  beforeEach(() => { adminCalls.length = 0; });
  const authed = (r: request.Test) => r.set('X-API-Key', SERVICE_KEY).set(ACTING);

  it('GET /stores/:id/reembed/estimate runs as the acting user and 404s a store the user does not own', async () => {
    asService();
    const r = await authed(request(appWith()).get(`${GROUNDING_PATH}/stores/vs_1/reembed/estimate?x[a]=1`));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('vector_store_not_found');
    expect(adminArgs.estimateStore).toEqual(['user@test.com', 'vs_1']);
  });

  it('POST /stores/:id/reembed reaches the re-embed handler (not the store table) as the acting user', async () => {
    asService();
    const r = await authed(request(appWith()).post(`${GROUNDING_PATH}/stores/vs_1/reembed`));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('vector_store_not_found');
    expect(adminArgs.startReembed).toEqual(['user@test.com', 'vs_1', { email: 'user@test.com', credentialId: 'k-svc', authType: 'api_key' }]);
  });

  it('is closed to a non-service key', async () => {
    validateApiKey.mockResolvedValue({ valid: true, data: { keyId: 'k-u', name: 'user', email: 'u@test.com', permissions: [] } });
    const r = await request(appWith()).post(`${GROUNDING_PATH}/stores/vs_1/reembed`).set('X-API-Key', USER_KEY).set(ACTING);
    expect(r.status).toBe(403);
    expect(adminCalls).toEqual([]);
  });
});

describe('the user-level store reads and storage', () => {
  beforeEach(() => { listVisibleStores.mockReset(); storageOfOwner.mockReset(); });
  const authed = (r: request.Test) => r.set('X-API-Key', SERVICE_KEY).set(ACTING);

  it('GET /stores is the shared-aware handler, not the table', async () => {
    asService(); listVisibleStores.mockResolvedValue([]);
    const r = await authed(request(appWith()).get(`${GROUNDING_PATH}/stores?limit[a]=1`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
    expect(listVisibleStores).toHaveBeenCalledWith('user@test.com', { limit: 20, after: null, teamIds: [] });
  });

  it('GET /stores/:id is the shared-aware handler; GET /stores/:id/files stays the table', async () => {
    asService();
    const read = await authed(request(appWith()).get(`${GROUNDING_PATH}/stores/vs_1`));
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('vector_store_not_found');
    const files = await authed(request(appWith()).get(`${GROUNDING_PATH}/stores/vs_1/files`));
    expect(files.body).toEqual({ table: 'stores', owner: 'user@test.com' });
  });

  it('GET /storage answers the acting user\'s storage, also for the role user', async () => {
    asService(); storageOfOwner.mockResolvedValue({ owner_email: 'user@test.com', file_count: 0, logical_bytes: 0 });
    const r = await authed(request(appWith()).get(`${GROUNDING_PATH}/storage`));
    expect(r.status).toBe(200);
    expect(storageOfOwner).toHaveBeenCalledWith('user@test.com');
  });
});
