/**
 * Quota on the cockpit's paid grounding work (W8 Task 1). The cockpit carries no credential of the
 * user who pays, so the routes that start paid work check the PAYER's state document with the
 * model routes' own admission (createOwnerAdmission): the store owner for store work, the searcher
 * for search. Part one: that admission. Part two: the real grounding router with stub handlers —
 * which routes are guarded, whose quota they read, that a refused request never reaches its
 * handler, and that the admin maintenance routes, reads and cancels are not checked. In-memory
 * Valkey double; no database, no SAP.
 */
import { describe, it, expect, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const emitted: any[] = [];
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: {
  emitQuotaExceeded: jest.fn(async (d: any) => { emitted.push({ kind: 'exceeded', ...d }); }),
  emitQuotaUnenforced: jest.fn(async (d: any) => { emitted.push({ kind: 'unenforced', ...d }); }) } }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {}, getTrustForwardedFor: () => false }));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: () => false,
  shouldEnableDistributedCaching: () => false,
  getCachedUnifiedAuthConfig: () => ({})
}));
const validateApiKey = jest.fn<any>();
jest.mock('../src/services/unifiedApiKeyValidationService', () => ({
  __esModule: true,
  unifiedApiKeyValidationService: { validateApiKey: (...a: any[]) => validateApiKey(...a) }
}));
jest.mock('../src/fileSearch/db', () => ({ __esModule: true, isFileSearchAvailable: () => true, getPool: () => null }));

// Every handler is a stub that records its name: "the handler ran" is "nothing was started" turned around.
const handled: string[] = [];
function stubController(extra: Record<string, unknown> = {}) {
  const cache = new Map<string, any>();
  return new Proxy({ __esModule: true, ...extra } as Record<string | symbol, any>, {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name !== 'string') return undefined;
      if (!cache.has(name)) cache.set(name, (_req: any, res: any) => { handled.push(name); res.status(200).json({ handler: name }); });
      return cache.get(name);
    }
  });
}
jest.mock('../src/controllers/groundingController', () => stubController({
  ADMIN_JOB_KINDS: ['reembed_bulk', 'blob_migration'], REEMBED_KINDS: ['reembed_store', 'reembed_bulk']
}));
jest.mock('../src/controllers/groundingAdminController', () => stubController());
jest.mock('../src/controllers/groundingReembedController', () => stubController());
jest.mock('../src/controllers/groundingBlobMigrationController', () => stubController());
jest.mock('../src/controllers/groundingChunkingController', () => stubController());
jest.mock('../src/controllers/vectorStoresController', () => stubController());
jest.mock('../src/controllers/filesController', () => stubController());

// Store and job lookups the guard makes: who owns a store the acting user can see, and a job's kind.
const stores: Record<string, { owner_email: string; is_shared: boolean }> = {};
jest.mock('../src/fileSearch/repository', () => ({
  __esModule: true,
  readVisibleStore: jest.fn(async (email: string, id: string) => {
    const s = stores[id];
    if (!s || (s.owner_email !== email && !s.is_shared)) return null;
    return { id, owner_email: s.owner_email, is_shared: s.is_shared, owned: s.owner_email === email };
  })
}));
const jobKinds: Record<string, { owner: string; kind: string }> = {};
jest.mock('../src/fileSearch/jobs', () => ({
  __esModule: true,
  jobSummary: jest.fn(async (id: string, owner: string) => (jobKinds[id]?.owner === owner ? { id, kind: jobKinds[id].kind } : null))
}));

import { createOwnerAdmission } from '../src/middlewares/quotaEnforcement';
import { QuotaStateReader, quotaKeyFor } from '../src/services/quotaStateReader';
import { GROUNDING_PATH } from '../src/routes/groundingRoutes';
import { sendQuotaExceeded } from '../src/middlewares/groundingQuota';
import { SERVICE_KEYS } from '@libs/service-auth';

const now = Date.parse('2026-10-12T10:00:00Z');
const clock = () => now;
const OWNER = 'owner@test.com';
const OTHER = 'other@test.com';
const ADMIN = 'admin@test.com';

const limits = (over: any = {}) => ({ requestsPerMinute: null, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null, ...over });
const zero = { requests: 0, tokens: 0, sapCost: 0 };
/** Windows that start at `at`'s UTC day, week and month: a document the admission reads as current. */
function windowsOf(at: number) {
  const d = new Date(at);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const week = day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  return { day: iso(day), week: iso(week), month: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), nextDay: iso(day + 86_400_000) };
}
function doc(email: string, dayTokens: number, tokensPerDay: number | null, at = now): any {
  const { day, week, month } = windowsOf(at);
  return {
    email, status: 'active', limits: limits({ tokensPerDay }),
    used: { day: { requests: 1, tokens: dayTokens, sapCost: 0 }, week: zero, month: zero },
    windowStart: { day, week, month }, quotaResetAt: null, updatedAt: new Date(at).toISOString()
  };
}
function fakeValkey(docs: Record<string, any>, down = false) {
  return { status: down ? 'end' : 'ready', get: async (k: string) => { if (down) throw new Error('ECONNREFUSED'); return docs[k] ? JSON.stringify(docs[k]) : null; } };
}
/** Over quota: today's tokens reached the day limit. Under: far below it. */
function quotas(over: string[], under: string[] = [], at = now): Record<string, any> {
  const docs: Record<string, any> = {};
  for (const e of over) docs[quotaKeyFor(e)] = doc(e, 1000, 1000, at);
  for (const e of under) docs[quotaKeyFor(e)] = doc(e, 10, 1000, at);
  return docs;
}

beforeEach(() => {
  emitted.length = 0;
  handled.length = 0;
});

describe('createOwnerAdmission: the model routes\' spend/token admission keyed on an e-mail', () => {
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' }, originalUrl: '/api/admin/grounding/stores/vs_1/files', method: 'POST',
    get: () => 'jest', serviceAuth: { serviceKey: { id: 'k-svc' } } };
  const admission = (client: any, standalone = false) =>
    createOwnerAdmission({ stateReader: () => new QuotaStateReader(client, clock), clock, standalone: () => standalone });

  it('refuses an owner whose day tokens reached the limit, with the window and its reset, and says so once as a quota_exceeded event', async () => {
    const x = await admission(fakeValkey(quotas([OWNER])))(req, OWNER);
    expect(x).toMatchObject({ type: 'quota_exceeded', scope: 'user', dimension: 'tokens', window: 'day', limit: 1000, used: 1000, resetsAt: Date.parse('2026-10-13T00:00:00Z') });
    expect(emitted).toEqual([expect.objectContaining({ kind: 'exceeded', ownerEmail: OWNER, credentialId: 'k-svc', dimension: 'tokens', window: 'day', clientIP: '203.0.113.9' })]);
  });

  it('admits an owner under the limit and one without a document', async () => {
    const admit = admission(fakeValkey(quotas([], [OWNER])));
    expect(await admit(req, OWNER)).toBeNull();
    expect(await admit(req, 'nobody@test.com')).toBeNull();
    expect(emitted).toEqual([]);
  });

  it('the document\'s limits decide: no wire block is needed (the cockpit has none)', async () => {
    const docs = { [quotaKeyFor(OWNER)]: { ...doc(OWNER, 0, null), limits: limits({ spendPerMonth: 2 }), used: { day: zero, week: zero, month: { requests: 3, tokens: 9, sapCost: 2 } } } };
    expect(await admission(fakeValkey(docs))(req, OWNER)).toMatchObject({ dimension: 'spend', window: 'month', resetsAt: Date.parse('2026-11-01T00:00:00Z') });
  });

  it('fails open when the state cannot be read, with one quota_unenforced event', async () => {
    expect(await admission(fakeValkey({}, true))(req, OWNER)).toBeNull();
    expect(emitted).toEqual([expect.objectContaining({ kind: 'unenforced', reason: 'quota state unavailable' })]);
  });

  it('checks nothing in standalone mode', async () => {
    expect(await admission(fakeValkey(quotas([OWNER])), true)(req, OWNER)).toBeNull();
  });
});

describe('the grounding routes check the store owner\'s quota before paid work starts', () => {
  const SERVICE_KEY = 'sk-' + 'd5'.repeat(24);
  // The process-wide admission, its reader and the 429 take Date.now when their modules load and when a reader is
  // made. A fixed clock for all of them: the router and the enforcement are loaded afresh while only Date is fake
  // (timers stay real for express and supertest), so a run across midnight UTC cannot read today's documents as
  // yesterday's.
  let mountGroundingRoutes: typeof import('../src/routes/groundingRoutes').mountGroundingRoutes;
  let configureQuotaEnforcement: typeof import('../src/middlewares/quotaEnforcement').configureQuotaEnforcement;
  beforeAll(() => {
    jest.useFakeTimers({ now, doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    jest.isolateModules(() => {
      ({ mountGroundingRoutes } = require('../src/routes/groundingRoutes'));
      ({ configureQuotaEnforcement } = require('../src/middlewares/quotaEnforcement'));
    });
  });
  afterAll(() => { jest.useRealTimers(); });
  function app(): express.Application {
    const a = express();
    a.use(express.json());
    mountGroundingRoutes(a);
    return a;
  }
  const as = (email: string, role: 'user' | 'admin', r: request.Test) =>
    r.set('X-API-Key', SERVICE_KEY).set({ 'X-Grounding-Acting-Email': email, 'X-Grounding-Acting-Role': role });
  /** Fresh reader per test (the reader caches each document for ten seconds), documents of `now`'s windows. */
  const setQuotas = (over: string[], under: string[] = []) =>
    configureQuotaEnforcement({ valkeyClient: fakeValkey(quotas(over, under)) });

  beforeEach(() => {
    validateApiKey.mockReset();
    validateApiKey.mockResolvedValue({
      valid: true,
      data: { keyId: 'k-svc', name: SERVICE_KEYS.ADMIN_TO_GATEWAY.NAME, email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL, permissions: [] }
    });
    for (const k of Object.keys(stores)) delete stores[k];
    for (const k of Object.keys(jobKinds)) delete jobKinds[k];
    stores.vs_own = { owner_email: OWNER, is_shared: false };
    stores.vs_shared = { owner_email: OWNER, is_shared: true };
    stores.vs_admin = { owner_email: ADMIN, is_shared: false };
    jobKinds.job_batch = { owner: OWNER, kind: 'file_batch' };
    jobKinds.job_reembed = { owner: OWNER, kind: 'reembed_store' };
    jobKinds.job_bulk = { owner: ADMIN, kind: 'reembed_bulk' };
    jobKinds.job_blob = { owner: ADMIN, kind: 'blob_migration' };
  });

  // [method path, handler the stub table records]
  const PAID: Array<[string, string, any]> = [
    ['/stores/vs_own/files', 'createVectorStoreFile', { file_id: 'file-1' }],
    ['/stores/vs_own/file_batches', 'createVectorStoreFileBatch', { file_ids: ['file-1'] }],
    ['/stores/vs_own/search', 'searchVectorStore', { query: 'q' }],
    ['/stores/vs_own/reembed', 'reembedStore', {}],
    ['/stores/vs_own/chunking', 'startChunking', { chunking: { type: 'static', max_tokens: 400, overlap_tokens: 0 } }],
    ['/stores/vs_own/reextract', 'startReextract', {}],
    ['/stores/vs_own/files/file-1/retry', 'retryStoreFile', {}],
    ['/jobs/job_batch/retry', 'retryJob', {}],
    ['/jobs/job_reembed/retry', 'retryJob', {}],
    ['/stores', 'createStore', { name: 'With files', file_ids: ['file-1'] }],
  ];

  it.each(PAID)('POST %s: an owner over quota gets the 429 and the handler never runs', async (path, _handler, body) => {
    setQuotas([OWNER]);
    const r = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}${path}`).send(body));
    expect(r.status).toBe(429);
    // the model routes' body plus code and message; the figures are the acting user's own
    expect(r.body).toEqual({ error: {
      type: 'quota_exceeded', code: 'quota_exceeded', scope: 'user', dimension: 'tokens', window: 'day', limit: 1000, used: 1000,
      resets_at: '2026-10-13T00:00:00.000Z', message: expect.stringMatching(/^Your usage quota for this day is used up\./)
    } });
    expect(r.headers['retry-after']).toBe(String(14 * 3600)); // 10:00 to midnight UTC
    expect(handled).toEqual([]);
  });

  it.each(PAID)('POST %s: an owner under quota reaches the handler unchanged', async (path, handler, body) => {
    setQuotas([], [OWNER]);
    const r = await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}${path}`).send(body));
    expect(r.status).toBe(200);
    expect(handled).toEqual([handler]);
  });

  it('search is checked against the searcher, who pays: a non-owner over quota is refused on a shared store', async () => {
    setQuotas([OTHER, ADMIN], [OWNER]);
    expect((await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/vs_shared/search`).send({ query: 'q' }))).status).toBe(429);
    // an admin searching through the user route pays for it too
    expect((await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/stores/vs_shared/search`).send({ query: 'q' }))).status).toBe(429);
    expect(handled).toEqual([]);
  });

  it('a non-owner (user or admin) under quota searches a shared store whose owner is over quota', async () => {
    setQuotas([OWNER], [OTHER, ADMIN]);
    expect((await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/stores/vs_shared/search`).send({ query: 'q' }))).status).toBe(200);
    expect((await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/stores/vs_shared/search`).send({ query: 'q' }))).status).toBe(200);
    expect(handled).toEqual(['searchVectorStore', 'searchVectorStore']);
  });

  it('a store the acting user cannot use is not checked: the handler answers its own 404', async () => {
    setQuotas([OWNER, OTHER]);
    // unknown store, another owner's private store, and a shared store on an owner-only route
    for (const [who, path] of [[OWNER, '/stores/vs_unknown/files'], [OTHER, '/stores/vs_own/search'], [OTHER, '/stores/vs_shared/chunking']]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await as(who, 'user', request(app()).post(`${GROUNDING_PATH}${path}`).send({}))).status).toBe(200);
    }
    expect(handled).toEqual(['createVectorStoreFile', 'searchVectorStore', 'startChunking']);
  });

  it('a store create without files, a job of another owner and an admin\'s bulk or blob job are not paid work started here', async () => {
    setQuotas([OWNER, ADMIN]);
    const rs = [
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`).send({ name: 'Empty' })),
      await as(OWNER, 'user', request(app()).post(`${GROUNDING_PATH}/stores`).send({ name: 'Empty list', file_ids: [] })),
      await as(OTHER, 'user', request(app()).post(`${GROUNDING_PATH}/jobs/job_batch/retry`)),
      await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/jobs/job_bulk/retry`)),
      await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}/jobs/job_blob/retry`)),
    ];
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it('the admin maintenance routes are exempt, even with the admin and the owner over quota', async () => {
    setQuotas([OWNER, ADMIN]);
    const exempt: Array<[string, any]> = [
      ['/admin/stores/vs_own/reembed', {}], ['/admin/stores/vs_own/chunking', { chunking: {} }], ['/admin/stores/vs_own/reextract', {}],
      ['/admin/reembed-outdated', {}], ['/admin/stores/vs_own/files/file-1/retry', {}], ['/admin/jobs/job_reembed/retry', {}],
      ['/admin/blob-storage/migrate', { target: 's3' }],
    ];
    for (const [path, body] of exempt) {
      // eslint-disable-next-line no-await-in-loop
      const r = await as(ADMIN, 'admin', request(app()).post(`${GROUNDING_PATH}${path}`).send(body));
      expect([path, r.status]).toEqual([path, 200]);
    }
    expect(handled).toHaveLength(exempt.length);
  });

  it('reads, estimates, cancels, edits, detaches and uploads are not checked', async () => {
    setQuotas([OWNER]);
    const calls: request.Test[] = [
      request(app()).get(`${GROUNDING_PATH}/stores/vs_own`),
      request(app()).get(`${GROUNDING_PATH}/stores/vs_own/files`),
      request(app()).get(`${GROUNDING_PATH}/stores/vs_own/reembed/estimate`),
      request(app()).get(`${GROUNDING_PATH}/stores/vs_own/chunking/estimate`),
      request(app()).get(`${GROUNDING_PATH}/stores/vs_own/reextract/estimate`),
      request(app()).get(`${GROUNDING_PATH}/jobs`),
      request(app()).post(`${GROUNDING_PATH}/jobs/job_batch/cancel`),
      request(app()).post(`${GROUNDING_PATH}/stores/vs_own/file_batches/b1/cancel`),
      request(app()).post(`${GROUNDING_PATH}/stores/vs_own`).send({ name: 'Renamed' }),
      request(app()).post(`${GROUNDING_PATH}/stores/vs_own/files/file-1`).send({ attributes: {} }),
      request(app()).delete(`${GROUNDING_PATH}/stores/vs_own/files/file-1`),
      request(app()).post(`${GROUNDING_PATH}/files`),
    ];
    for (const c of calls) {
      // eslint-disable-next-line no-await-in-loop
      expect((await as(OWNER, 'user', c)).status).toBe(200);
    }
    expect(handled).toHaveLength(calls.length);
  });
});

describe('sendQuotaExceeded on a team pool', () => {
  const capture = () => {
    const out: any = { headers: {} };
    const res: any = { set: (h: any) => { Object.assign(out.headers, h); return res; }, status: (c: number) => { out.status = c; return res; }, json: (b: any) => { out.body = b; return res; } };
    return { res, out };
  };
  const NOW = Date.parse('2026-10-12T10:00:00Z');
  const resetsAt = Date.parse('2026-11-01T00:00:00Z');

  it('names the team and words the message for the team pool', () => {
    const { res, out } = capture();
    sendQuotaExceeded(res, { type: 'quota_exceeded', scope: 'team', team: 'Alpha', dimension: 'spend', window: 'month', limit: 20, used: 20.5, resetsAt }, NOW, true);
    expect(out.status).toBe(429);
    expect(out.body.error).toMatchObject({ scope: 'team', team: 'Alpha', dimension: 'spend', window: 'month' });
    expect(out.body.error.message).toMatch(/^The team Alpha's usage quota for this month is used up\. New processing and searches can start after 2026-11-01T00:00:00\.000Z/);
  });

  it('keeps the user wording and carries no team on a user quota', () => {
    const { res, out } = capture();
    sendQuotaExceeded(res, { type: 'quota_exceeded', scope: 'user', dimension: 'tokens', window: 'day', limit: 1000, used: 1000, resetsAt }, NOW, true);
    expect(out.body.error.message).toMatch(/^Your usage quota for this day is used up\./);
    expect(out.body.error).not.toHaveProperty('team');
  });

  it('words a team document without a name as "The team’s", never "The team undefined’s"', () => {
    const { res, out } = capture();
    sendQuotaExceeded(res, { type: 'quota_exceeded', scope: 'team', dimension: 'tokens', window: 'day', limit: 10, used: 10, resetsAt }, NOW, true);
    expect(out.body.error.message).toMatch(/^The team's usage quota for this day is used up\./);
    expect(out.body.error.message).not.toMatch(/undefined/);
    expect(out.body.error).not.toHaveProperty('team');
  });
});
