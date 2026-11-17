/**
 * Raw capture sessions in the admin service (D3, D4, D7, D9): a session names API keys and/or e-mail
 * addresses, which are resolved to credentials when it starts; the running sessions are written to the
 * Valkey key `sap-llm-gateway:raw-capture` (announced on `sap-llm-gateway:raw-capture-changed`); a
 * session past its end is ended by `endExpiredSessions` with an audit event by `system`. Valkey is a
 * fake here; in-memory SQLite (TRACE_TEST_POSTGRES runs it against a throwaway PostgreSQL).
 */
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { connectTraceTestDb, ownsTraceTestDb } from './trace-test-db';

const mockValkey = { up: true, failSet: false, delayNextSetMs: 0, onSlowSet: (): void => undefined,
  values: new Map<string, any>(), ttls: new Map<string, number>(), published: [] as Array<[string, string]> };
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: {
    initialize: jest.fn(), shutdown: jest.fn(), available: () => mockValkey.up,
    setJson: jest.fn(async (k: string, v: any, ttl: number) => {
      if (!mockValkey.up || mockValkey.failSet) return false;
      const delay = mockValkey.delayNextSetMs;
      mockValkey.delayNextSetMs = 0;
      if (delay) { mockValkey.onSlowSet(); await new Promise((resolve) => setTimeout(resolve, delay)); }
      mockValkey.values.set(k, JSON.parse(JSON.stringify(v))); mockValkey.ttls.set(k, ttl); return true;
    }),
    publish: jest.fn(async (c: string, m: string) => { if (!mockValkey.up) return false; mockValkey.published.push([c, m]); return true; }),
    getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), del: jest.fn(async () => true)
  }
}));

import {
  startRawCaptureSession, stopRawCaptureSession, activeRawCaptureSessions, publishActiveSessions, endExpiredSessions,
  startRawCaptureExpiry, RawCaptureError, RAW_CAPTURE_KEY, RAW_CAPTURE_CHANNEL
} from '../../../src/services/rawCaptureSessions';

const cds = require('@sap/cds');

const SESSIONS = 'sap.llm.gateway.admin.RawCaptureSessions';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
const JANE = 'jane.roe@example.org';
const JOHN = 'john.doe@example.org';
const KEY_A = uuidv4();
const KEY_B = uuidv4();
const KEY_DELETED = uuidv4();
const KEY_JOHN = uuidv4();
const AWS_JANE = uuidv4();
const ACCESS_JANE = 'TESTACCESSKEY0001';
const ACTOR = { id: 'admin@example.org', clientIP: '127.0.0.1', userAgent: 'jest' };
const NOW = new Date('2026-11-13T10:00:00.000Z');
const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000);

const apiKey = (ID: string, email: string, over: any = {}) => ({ ID, key: randomBytes(32).toString('hex'), name: `key ${ID.slice(0, 4)}`, email, isActive: true, ...over });

async function refusal(p: Promise<unknown>): Promise<RawCaptureError> {
  try { await p; } catch (e) { if (e instanceof RawCaptureError) return e; throw e; }
  throw new Error('expected a refusal');
}
const stored = () => mockValkey.values.get(RAW_CAPTURE_KEY);
const audits = (action: string) => cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action }));
const sessionRows = () => cds.db.run(cds.ql.SELECT.from(SESSIONS));
const start = (over: any = {}, now = NOW) => startRawCaptureSession({ apiKeyIds: [], emails: [JANE], minutes: 15, reason: 'Jane reports cut answers', ...over }, ACTOR, now);

beforeAll(async () => {
  await connectTraceTestDb();
});
// The next suite's guard refuses a database that holds API keys (trace-test-db.ts); only one this suite set up is cleaned.
afterAll(async () => { if (ownsTraceTestDb()) await cds.db.run(cds.ql.DELETE.from(KEYS)); });

beforeEach(async () => {
  mockValkey.up = true; mockValkey.failSet = false; mockValkey.delayNextSetMs = 0; mockValkey.values.clear(); mockValkey.ttls.clear(); mockValkey.published.length = 0;
  for (const e of [SESSIONS, KEYS, AWS, AUDIT, CONFIGS]) await cds.db.run(cds.ql.DELETE.from(e));
  await cds.db.run(cds.ql.INSERT.into(KEYS).entries([
    apiKey(KEY_A, JANE), apiKey(KEY_B, JANE, { isActive: false }), apiKey(KEY_DELETED, JANE, { deletedAt: '2026-11-01T00:00:00.000Z' }), apiKey(KEY_JOHN, JOHN)
  ]));
  await cds.db.run(cds.ql.INSERT.into(AWS).entries([{ ID: AWS_JANE, accessKeyId: ACCESS_JANE, email: JANE, name: 'Jane Bedrock', isActive: true }]));
});

describe('starting a raw capture session', () => {
  it('resolves an e-mail address to every API key and AWS credential it owns now (both ids of an AWS credential)', async () => {
    const result = await start();
    expect(result.credentialCount).toBe(3); // KEY_A, KEY_B, AWS_JANE - not the deleted key
    expect(result.endsAt).toBe(minutesLater(15).toISOString());
    const [row] = await sessionRows();
    expect(JSON.parse(row.credentialIds).sort()).toEqual([KEY_A, KEY_B, AWS_JANE, ACCESS_JANE].sort());
    expect(JSON.parse(row.emails)).toEqual([JANE]);
    expect(JSON.parse(row.apiKeyIds)).toEqual([]);
    expect(row).toMatchObject({ startedBy: ACTOR.id, reason: 'Jane reports cut answers', endedAt: null, endedBy: null });
  });

  it('matches an e-mail address whatever its case, on either side', async () => {
    const result = await start({ emails: ['Jane.Roe@Example.org'] });
    expect(result.credentialCount).toBe(3);
    expect(JSON.parse((await sessionRows())[0].credentialIds).sort()).toEqual([KEY_A, KEY_B, AWS_JANE, ACCESS_JANE].sort());

    await cds.db.run(cds.ql.UPDATE(KEYS).set({ email: 'John.Doe@Example.org' }).where({ ID: KEY_JOHN }));
    expect((await start({ emails: [JOHN] })).credentialCount).toBe(1);
  });

  it('takes API keys and AWS credentials by their ID, and counts a credential named twice once', async () => {
    const result = await start({ apiKeyIds: [KEY_JOHN, AWS_JANE], emails: [JOHN] });
    expect(result.credentialCount).toBe(2);
    expect(JSON.parse((await sessionRows())[0].credentialIds).sort()).toEqual([KEY_JOHN, AWS_JANE, ACCESS_JANE].sort());
  });

  it('writes exactly the running sessions to the Valkey key and announces it on the channel', async () => {
    const first = await start({ emails: [JOHN] });
    const second = await start({ apiKeyIds: [KEY_A], emails: [], minutes: 60 });
    expect(stored()).toEqual({ sessions: [
      { id: first.ID, credentialIds: [KEY_JOHN], endsAt: minutesLater(15).toISOString() },
      { id: second.ID, credentialIds: [KEY_A], endsAt: minutesLater(60).toISOString() }
    ] });
    // Outlives any session (at most 240 minutes); rewritten on every change and at admin start.
    expect(mockValkey.ttls.get(RAW_CAPTURE_KEY)).toBeGreaterThan(240 * 60);
    expect(mockValkey.published.map(([c]) => c)).toEqual([RAW_CAPTURE_CHANNEL, RAW_CAPTURE_CHANNEL]);
  });

  it('writes raw.capture.start with the actor, the reason, the keys and the addresses (severity high)', async () => {
    const result = await start({ apiKeyIds: [KEY_JOHN] });
    const [event] = await audits('raw.capture.start');
    expect(event).toMatchObject({ actorId: ACTOR.id, actorType: 'admin_user', resourceType: 'RawCaptureSession', resourceId: result.ID,
      outcome: 'success', severity: 'high', clientIP: '127.0.0.1' });
    expect(JSON.parse(event.details)).toMatchObject({ reason: 'Jane reports cut answers', apiKeyIds: [KEY_JOHN], emails: [JANE], minutes: 15, credentialCount: 4 });
  });

  it('keeps the audit details within 1,000 characters for long lists and says how many were left out', async () => {
    const emails = Array.from({ length: 60 }, (_, i) => `person.${i}@example.org`);
    await cds.db.run(cds.ql.INSERT.into(KEYS).entries(emails.map((e) => apiKey(uuidv4(), e))));
    await start({ emails, reason: 'x'.repeat(500) });
    const [event] = await audits('raw.capture.start');
    expect(event.details.length).toBeLessThanOrEqual(1000);
    const details = JSON.parse(event.details);
    expect(details.reason).toBe('x'.repeat(500));
    expect(details.emails.length + details.emailsLeftOut).toBe(60);
  });

  it.each([
    ['no keys and no addresses', { apiKeyIds: [], emails: [] }, 'RAW_CAPTURE_NOTHING_SELECTED'],
    ['only blank entries', { apiKeyIds: [' '], emails: [''] }, 'RAW_CAPTURE_NOTHING_SELECTED'],
    ['a duration other than 15, 60 or 240 minutes', { minutes: 30 }, 'RAW_CAPTURE_DURATION_INVALID'],
    ['no duration', { minutes: undefined }, 'RAW_CAPTURE_DURATION_MISSING'],
    ['a null duration', { minutes: null }, 'RAW_CAPTURE_DURATION_MISSING'],
    ['an empty reason', { reason: '   ' }, 'RAW_CAPTURE_REASON_REQUIRED'],
    ['a reason over 500 characters', { reason: 'y'.repeat(501) }, 'RAW_CAPTURE_REASON_TOO_LONG'],
    ['an unknown key', { apiKeyIds: ['not-a-key'] }, 'RAW_CAPTURE_UNKNOWN_KEY'],
    ['a deleted key', { apiKeyIds: [KEY_DELETED] }, 'RAW_CAPTURE_UNKNOWN_KEY'],
    ['an address that owns no credential', { emails: [JANE, 'nobody@example.org'] }, 'RAW_CAPTURE_ADDRESS_WITHOUT_CREDENTIALS']
  ])('refuses %s with 400 and starts nothing', async (_name, over, key) => {
    const e = await refusal(start(over));
    expect({ status: e.status, key: e.key }).toEqual({ status: 400, key });
    expect(await sessionRows()).toHaveLength(0);
    expect(mockValkey.published).toHaveLength(0);
    expect(await audits('raw.capture.start')).toHaveLength(0);
  });

  it('names the unknown keys and the addresses without credentials in the refusal', async () => {
    expect((await refusal(start({ apiKeyIds: [KEY_A, 'not-a-key'] }))).args).toEqual(['not-a-key']);
    expect((await refusal(start({ emails: ['nobody@example.org'] }))).args).toEqual(['nobody@example.org']);
  });

  it('refuses a duration above max_duration_minutes of the active configuration (default 240)', async () => {
    expect((await start({ minutes: 240 })).credentialCount).toBe(3);
    await cds.db.run(cds.ql.INSERT.into(CONFIGS).entries([{ ID: uuidv4(), name: 'now', version: '2.0.0', isActive: true,
      configData: JSON.stringify({ api_config: { observability: { payload_capture: { raw: { max_duration_minutes: 60 } } } } }) }]));
    const e = await refusal(start({ minutes: 240 }));
    expect({ status: e.status, key: e.key, args: e.args }).toEqual({ status: 400, key: 'RAW_CAPTURE_DURATION_TOO_LONG', args: ['60'] });
    expect((await start({ minutes: 60 })).credentialCount).toBe(3);
  });

  it('is refused with 503 without Valkey, before anything is stored', async () => {
    mockValkey.up = false;
    const e = await refusal(start());
    expect({ status: e.status, key: e.key }).toEqual({ status: 503, key: 'RAW_CAPTURE_NO_VALKEY' });
    expect(await sessionRows()).toHaveLength(0);
    expect(await audits('raw.capture.start')).toHaveLength(0);
  });

  it('removes the session again when the gateway cannot be told, and refuses with 503', async () => {
    mockValkey.failSet = true;
    const e = await refusal(start());
    expect({ status: e.status, key: e.key }).toEqual({ status: 503, key: 'RAW_CAPTURE_NO_VALKEY' });
    expect(await sessionRows()).toHaveLength(0);
    expect(await audits('raw.capture.start')).toHaveLength(0);
  });

  it('reports the strength of METADATA_ENCRYPTION_KEY, and starts with a weak one', async () => {
    const saved = process.env.METADATA_ENCRYPTION_KEY;
    try {
      process.env.METADATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
      expect((await start()).keyStatus).toBe('strong');
      process.env.METADATA_ENCRYPTION_KEY = 'short';
      expect((await start()).keyStatus).toBe('too-short');
      delete process.env.METADATA_ENCRYPTION_KEY;
      expect((await start()).keyStatus).toBe('missing');
      expect(await sessionRows()).toHaveLength(3);
    } finally {
      if (saved === undefined) delete process.env.METADATA_ENCRYPTION_KEY; else process.env.METADATA_ENCRYPTION_KEY = saved;
    }
  });
});

describe('stopping and ending sessions', () => {
  it('stop removes the session from the key and writes raw.capture.stop with the start reason, keys and addresses', async () => {
    const keep = await start({ emails: [JOHN] });
    const stop = await start({ apiKeyIds: [KEY_A], emails: [] });
    await stopRawCaptureSession(stop.ID, ACTOR, minutesLater(5));
    expect(stored()).toEqual({ sessions: [{ id: keep.ID, credentialIds: [KEY_JOHN], endsAt: minutesLater(15).toISOString() }] });
    const row = (await sessionRows()).find((r: any) => r.ID === stop.ID);
    expect(row.endedBy).toBe(ACTOR.id);
    expect(new Date(row.endedAt).toISOString()).toBe(minutesLater(5).toISOString());
    const [event] = await audits('raw.capture.stop');
    expect(event).toMatchObject({ actorId: ACTOR.id, actorType: 'admin_user', resourceId: stop.ID, severity: 'high', outcome: 'success' });
    expect(JSON.parse(event.details)).toMatchObject({ reason: 'Jane reports cut answers', apiKeyIds: [KEY_A], emails: [] });
  });

  it('refuses to stop an unknown session (404) and one that has ended (409)', async () => {
    expect((await refusal(stopRawCaptureSession(uuidv4(), ACTOR, NOW))).status).toBe(404);
    const s = await start();
    await stopRawCaptureSession(s.ID, ACTOR, NOW);
    const again = await refusal(stopRawCaptureSession(s.ID, ACTOR, NOW));
    expect({ status: again.status, key: again.key }).toEqual({ status: 409, key: 'RAW_CAPTURE_ALREADY_ENDED' });
    const late = await start();
    expect((await refusal(stopRawCaptureSession(late.ID, ACTOR, minutesLater(16)))).status).toBe(409);
    expect(await audits('raw.capture.stop')).toHaveLength(1);
  });

  it('refuses to stop without Valkey and leaves the session running', async () => {
    const s = await start();
    mockValkey.up = false;
    expect((await refusal(stopRawCaptureSession(s.ID, ACTOR, NOW))).status).toBe(503);
    mockValkey.up = true; mockValkey.failSet = true;
    expect((await refusal(stopRawCaptureSession(s.ID, ACTOR, NOW))).status).toBe(503);
    expect((await sessionRows())[0]).toMatchObject({ endedAt: null, endedBy: null });
    expect(await audits('raw.capture.stop')).toHaveLength(0);
  });

  it('endExpiredSessions ends a session past its end, removes it from the key and writes raw.capture.end by system', async () => {
    const short = await start();
    const long = await start({ emails: [JOHN], minutes: 60 });
    expect(await endExpiredSessions(minutesLater(10))).toBe(0);
    expect(await endExpiredSessions(minutesLater(16))).toBe(1);
    expect(stored()).toEqual({ sessions: [{ id: long.ID, credentialIds: [KEY_JOHN], endsAt: minutesLater(60).toISOString() }] });
    const row = (await sessionRows()).find((r: any) => r.ID === short.ID);
    expect(row.endedBy).toBe('system');
    expect(new Date(row.endedAt).toISOString()).toBe(minutesLater(15).toISOString());
    const [event] = await audits('raw.capture.end');
    expect(event).toMatchObject({ actorId: 'system', actorType: 'system', resourceId: short.ID, severity: 'high', outcome: 'success' });
    expect(JSON.parse(event.details)).toMatchObject({ reason: 'Jane reports cut answers', emails: [JANE] });
    expect(await endExpiredSessions(minutesLater(16))).toBe(0);
    expect(await audits('raw.capture.end')).toHaveLength(1);
  });

  it('activeRawCaptureSessions lists the running sessions with their key and address counts', async () => {
    const a = await start({ apiKeyIds: [KEY_JOHN, KEY_A] });
    const b = await start({ minutes: 60 });
    await stopRawCaptureSession(b.ID, ACTOR, NOW);
    await start({ minutes: 15 }, new Date(NOW.getTime() - 20 * 60_000)); // already past its end
    expect(await activeRawCaptureSessions(NOW)).toEqual([{ ID: a.ID, endsAt: minutesLater(15).toISOString(), startedBy: ACTOR.id, keyCount: 2, addressCount: 1 }]);
  });
});

describe('publishing the running sessions', () => {
  it('writes an empty set as { sessions: [] }', async () => {
    await publishActiveSessions(NOW);
    expect(stored()).toEqual({ sessions: [] });
    expect(mockValkey.published).toEqual([[RAW_CAPTURE_CHANNEL, expect.any(String)]]);
  });

  it('leaves out a stored row that would not be well formed for the gateway, so the others stay captured', async () => {
    const good = await start();
    await cds.db.run(cds.ql.INSERT.into(SESSIONS).entries([{ ID: uuidv4(), startedAt: NOW.toISOString(), endsAt: minutesLater(15).toISOString(),
      startedBy: ACTOR.id, reason: 'r', apiKeyIds: '[]', emails: '[]', credentialIds: 'not json' }]));
    await publishActiveSessions(NOW);
    expect(stored().sessions.map((s: any) => s.id)).toEqual([good.ID]);
  });

  it('keeps both sessions in the key when a second start comes while the first one is still writing', async () => {
    mockValkey.delayNextSetMs = 50;
    const writing = new Promise<void>((resolve) => { mockValkey.onSlowSet = resolve; });
    const first = start();
    await writing; // the first start has read the sessions and its write to Valkey is under way
    const b = await start({ emails: [JOHN] });
    const a = await first;
    expect(stored().sessions.map((s: any) => s.id).sort()).toEqual([a.ID, b.ID].sort());
  });

  it('throws when Valkey cannot be reached', async () => {
    mockValkey.up = false;
    await expect(publishActiveSessions(NOW)).rejects.toBeInstanceOf(RawCaptureError);
  });

  it('starts no expiry timer in a test process', () => {
    expect(startRawCaptureExpiry()).toBeNull();
  });

  it('starts an unref-ed expiry timer when asked to, and stops it', () => {
    const saved = process.env.VALKEY_URL;
    process.env.VALKEY_URL = 'redis://127.0.0.1:1';
    try {
      const handle = startRawCaptureExpiry({ allowInTest: true, intervalMs: 600_000, firstRunMs: 600_000 });
      expect(handle).not.toBeNull();
      expect(handle!.timers.every((t) => t.hasRef() === false)).toBe(true);
      handle!.stop();
    } finally {
      if (saved === undefined) delete process.env.VALKEY_URL; else process.env.VALKEY_URL = saved;
    }
  });
});
