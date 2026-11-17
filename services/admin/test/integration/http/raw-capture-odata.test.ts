/**
 * Raw capture sessions over OData (cds.test, in-memory SQLite, mocked users, a fake Valkey; runs bare):
 * startRawCapture, stopRawCapture, activeRawCapture and the RawCaptureSessions entity are admin only;
 * a refused start answers 400 with a translated message, a start without Valkey 503; a weak
 * METADATA_ENCRYPTION_KEY still starts and returns keyWarning; the Valkey key follows starts and stops.
 */
import path from 'path';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

process.env.CDS_TYPESCRIPT = 'true';
process.env.METADATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'rc-admin@test.com': { id: 'rc-admin@test.com', roles: ['admin', 'user'] },
  'rc-user@test.com': { id: 'rc-user@test.com', roles: ['user'] } } };

const mockValkey = { up: true, values: new Map<string, any>() };
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: {
    initialize: jest.fn(), shutdown: jest.fn(), available: () => mockValkey.up,
    setJson: jest.fn(async (k: string, v: any) => { if (!mockValkey.up) return false; mockValkey.values.set(k, JSON.parse(JSON.stringify(v))); return true; }),
    publish: jest.fn(async () => mockValkey.up), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0),
    del: jest.fn(async () => true), scanJson: jest.fn(async () => null)
  }
}));

const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'rc-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'rc-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const message = (r: any): string => String(r?.data?.error?.message ?? '');
const S = '/odata/v4/admin';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const SESSIONS = 'sap.llm.gateway.admin.RawCaptureSessions';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const RAW_KEY = 'sap-llm-gateway:raw-capture';
const JANE = 'jane.roe@example.org';
const KEY_A = uuidv4();
const KEY_B = uuidv4();

const startBody = (over: any = {}) => ({ apiKeyIds: [], emails: [JANE], minutes: 15, reason: 'Jane reports cut answers', ...over });
const startCapture = (over: any = {}, who: any = ADMIN) => ok(POST(`${S}/startRawCapture`, startBody(over), who));
const audits = (action: string) => cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action }));

beforeEach(async () => {
  mockValkey.up = true; mockValkey.values.clear();
  for (const e of [SESSIONS, KEYS, AUDIT]) await cds.db.run(cds.ql.DELETE.from(e));
  await cds.db.run(cds.ql.INSERT.into(KEYS).entries([
    { ID: KEY_A, key: randomBytes(32).toString('hex'), name: 'Jane build key', email: JANE, isActive: true },
    { ID: KEY_B, key: randomBytes(32).toString('hex'), name: 'Other key', email: 'john.doe@example.org', isActive: true }
  ]));
});

describe('raw capture sessions over OData', () => {
  it('refuses a user with 403 on every action, function and the entity, and starts nothing', async () => {
    expect((await startCapture({}, USER)).status).toBe(403);
    expect((await ok(POST(`${S}/stopRawCapture`, { ID: uuidv4() }, USER))).status).toBe(403);
    expect((await ok(GET(`${S}/activeRawCapture()`, USER))).status).toBe(403);
    expect((await ok(GET(`${S}/RawCaptureSessions`, USER))).status).toBe(403);
    expect(await cds.db.run(cds.ql.SELECT.from(SESSIONS))).toHaveLength(0);
    expect(mockValkey.values.size).toBe(0);
  });

  it.each([
    ['no keys and no addresses', { emails: [] }, /at least one/i],
    ['a duration of 30 minutes', { minutes: 30 }, /15, 60 or 240/],
    ['an empty reason', { reason: '' }, /reason/i],
    ['an unknown key', { apiKeyIds: ['not-a-key'] }, /not-a-key/],
    ['an unknown key or AWS credential, naming both kinds', { apiKeyIds: ['not-a-key'] }, /API keys or AWS credentials/],
    ['no duration, without an empty value in the text', { minutes: null }, /^(?!.*"").*15, 60 or 240/]
  ])('answers 400 with a message for %s', async (_name, over, text) => {
    const r = await startCapture(over);
    expect(r.status).toBe(400);
    expect(message(r)).toMatch(text);
  });

  it('answers 400 for a duration above max_duration_minutes of the active configuration', async () => {
    const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
    const active = await cds.db.run(cds.ql.SELECT.from(CONFIGS).columns('ID').where({ isActive: true }));
    await cds.db.run(cds.ql.UPDATE(CONFIGS).set({ isActive: false }).where({ isActive: true }));
    const id = uuidv4();
    await cds.db.run(cds.ql.INSERT.into(CONFIGS).entries([{ ID: id, name: 'short raw', version: '99.0.0', isActive: true,
      configData: JSON.stringify({ api_config: { observability: { payload_capture: { raw: { max_duration_minutes: 60 } } } } }) }]));
    try {
      const r = await startCapture({ minutes: 240 });
      expect(r.status).toBe(400);
      expect(message(r)).toMatch(/60/);
    } finally {
      await cds.db.run(cds.ql.DELETE.from(CONFIGS).where({ ID: id }));
      if (active.length) await cds.db.run(cds.ql.UPDATE(CONFIGS).set({ isActive: true }).where({ ID: { in: active.map((a: any) => a.ID) } }));
    }
  });

  it('starts a session: the Valkey key holds its credentials, raw.capture.start is written, activeRawCapture lists it', async () => {
    const r = await startCapture({ apiKeyIds: [KEY_B] });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ credentialCount: 2, keyWarning: null });
    expect(typeof r.data.ID).toBe('string');
    expect(mockValkey.values.get(RAW_KEY)).toEqual({ sessions: [{ id: r.data.ID, credentialIds: expect.arrayContaining([KEY_A, KEY_B]), endsAt: expect.any(String) }] });
    expect(new Date(mockValkey.values.get(RAW_KEY).sessions[0].endsAt).getTime()).toBe(new Date(r.data.endsAt).getTime());
    const [event] = await audits('raw.capture.start');
    expect(event).toMatchObject({ actorId: 'rc-admin@test.com', severity: 'high', resourceId: r.data.ID });
    expect(JSON.parse(event.details)).toMatchObject({ reason: 'Jane reports cut answers', apiKeyIds: [KEY_B], emails: [JANE] });
    const active = await GET(`${S}/activeRawCapture()`, ADMIN);
    expect(active.data.value).toEqual([{ ID: r.data.ID, endsAt: expect.any(String), startedBy: 'rc-admin@test.com', keyCount: 1, addressCount: 1 }]);
    const listed = await GET(`${S}/RawCaptureSessions`, ADMIN);
    expect(listed.data.value.map((s: any) => s.ID)).toEqual([r.data.ID]);
  });

  it.each([
    ['missing', undefined, /is not set/],
    ['too-short', 'short', /fewer than 32 characters/],
    ['publicly-known', 'dev-key-change-in-production', /published with the product/],
    ['strong', 'x'.repeat(48), null]
  ])('returns the keyWarning of a %s METADATA_ENCRYPTION_KEY', async (_status, value, text) => {
    const saved = process.env.METADATA_ENCRYPTION_KEY;
    try {
      if (value === undefined) delete process.env.METADATA_ENCRYPTION_KEY; else process.env.METADATA_ENCRYPTION_KEY = value;
      const r = await startCapture();
      expect(r.status).toBe(200);
      if (text === null) expect(r.data.keyWarning).toBeNull(); else expect(r.data.keyWarning).toMatch(text);
    } finally {
      if (saved === undefined) delete process.env.METADATA_ENCRYPTION_KEY; else process.env.METADATA_ENCRYPTION_KEY = saved;
    }
  });

  it('starts with a weak METADATA_ENCRYPTION_KEY and returns keyWarning', async () => {
    const saved = process.env.METADATA_ENCRYPTION_KEY;
    process.env.METADATA_ENCRYPTION_KEY = 'short';
    try {
      const r = await startCapture();
      expect(r.status).toBe(200);
      expect(r.data.keyWarning).toMatch(/METADATA_ENCRYPTION_KEY/);
    } finally {
      process.env.METADATA_ENCRYPTION_KEY = saved;
    }
  });

  it('stops a session: it leaves the Valkey key and raw.capture.stop is written; stopping again is refused', async () => {
    const r = await startCapture();
    const stopped = await ok(POST(`${S}/stopRawCapture`, { ID: r.data.ID }, ADMIN));
    expect(stopped.status).toBeLessThan(300);
    expect(mockValkey.values.get(RAW_KEY)).toEqual({ sessions: [] });
    const [event] = await audits('raw.capture.stop');
    expect(event).toMatchObject({ actorId: 'rc-admin@test.com', severity: 'high', resourceId: r.data.ID });
    expect(JSON.parse(event.details)).toMatchObject({ reason: 'Jane reports cut answers', emails: [JANE] });
    expect((await ok(POST(`${S}/stopRawCapture`, { ID: r.data.ID }, ADMIN))).status).toBe(409);
    expect((await ok(POST(`${S}/stopRawCapture`, { ID: uuidv4() }, ADMIN))).status).toBe(404);
    expect((await GET(`${S}/activeRawCapture()`, ADMIN)).data.value).toEqual([]);
  });

  it('refuses a start without Valkey with 503 and a message that says why', async () => {
    mockValkey.up = false;
    const r = await startCapture();
    expect(r.status).toBe(503);
    expect(message(r)).toMatch(/Valkey/);
    expect(await cds.db.run(cds.ql.SELECT.from(SESSIONS))).toHaveLength(0);
  });
});
