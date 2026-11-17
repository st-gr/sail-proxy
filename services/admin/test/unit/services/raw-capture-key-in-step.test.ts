/**
 * The Valkey key of the raw capture sessions stays in step with the stored sessions: a start or stop
 * whose write failed is undone before another write reads the sessions, so no unaudited session reaches
 * the gateway; the 30 s check rewrites the key while a session runs (a Valkey restart without persistence
 * loses it); the start-up run writes the key. Valkey is a fake; in-memory SQLite (or TRACE_TEST_POSTGRES).
 */
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { connectTraceTestDb, ownsTraceTestDb } from './trace-test-db';

// plan: how the next writes behave, one entry per SET (a slow write calls onSlowSet when it begins).
// A failed SET delays the transaction that comes next (the undo) by slowTxMs: on SQLite the undo would
// otherwise always take the one connection before a queued write reads; on PostgreSQL both can run at once.
const mockValkey = {
  up: true, plan: [] as Array<{ delayMs?: number; fail?: boolean }>, onSlowSet: (): void => undefined,
  values: new Map<string, any>(), sets: 0, slowTxMs: 0
};
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: {
    initialize: jest.fn(), shutdown: jest.fn(), available: () => mockValkey.up,
    setJson: jest.fn(async (k: string, v: any) => {
      if (!mockValkey.up) return false;
      const { delayMs, fail } = mockValkey.plan.shift() ?? {};
      if (delayMs) { mockValkey.onSlowSet(); await new Promise((resolve) => setTimeout(resolve, delayMs)); }
      if (fail) { mockValkey.slowTxMs = 30; return false; }
      mockValkey.sets += 1;
      mockValkey.values.set(k, JSON.parse(JSON.stringify(v)));
      return true;
    }),
    publish: jest.fn(async () => mockValkey.up), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), del: jest.fn(async () => true)
  }
}));

import {
  startRawCaptureSession, stopRawCaptureSession, publishActiveSessions, startRawCaptureExpiry, RawCaptureError, RAW_CAPTURE_KEY
} from '../../../src/services/rawCaptureSessions';

const cds = require('@sap/cds');
const realTx = cds.tx;
jest.spyOn(cds, 'tx').mockImplementation((...args: any[]) => {
  const ms = mockValkey.slowTxMs;
  if (!ms) return realTx.apply(cds, args);
  mockValkey.slowTxMs = 0;
  return new Promise((resolve) => setTimeout(resolve, ms)).then(() => realTx.apply(cds, args));
});

const SESSIONS = 'sap.llm.gateway.admin.RawCaptureSessions';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const JANE = 'jane.roe@example.org';
const JOHN = 'john.doe@example.org';
const KEY_JANE = uuidv4();
const KEY_JOHN = uuidv4();
const ACTOR = { id: 'admin@example.org' };

const start = (email: string) => startRawCaptureSession({ emails: [email], minutes: 15, reason: 'Jane reports cut answers' }, ACTOR, new Date());
const stored = () => mockValkey.values.get(RAW_CAPTURE_KEY);
const storedIds = (): string[] => (stored()?.sessions ?? []).flatMap((s: any) => s.credentialIds).sort();
const settle = async (p: Promise<unknown>) => p.then(() => null, (e) => e);

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** The writes go as planned; resolves when the first slow one has begun. */
function planWrites(...plan: Array<{ delayMs?: number; fail?: boolean }>): Promise<void> {
  mockValkey.plan = plan;
  return new Promise<void>((resolve) => { mockValkey.onSlowSet = resolve; });
}

function withValkeyUrl<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.VALKEY_URL;
  process.env.VALKEY_URL = 'redis://127.0.0.1:1';
  return fn().finally(() => { if (saved === undefined) delete process.env.VALKEY_URL; else process.env.VALKEY_URL = saved; });
}

beforeAll(async () => {
  await connectTraceTestDb();
});
// The next suite's guard refuses a database that holds API keys (trace-test-db.ts); only one this suite set up is cleaned.
afterAll(async () => { if (ownsTraceTestDb()) await cds.db.run(cds.ql.DELETE.from(KEYS)); });

beforeEach(async () => {
  Object.assign(mockValkey, { up: true, plan: [], onSlowSet: () => undefined, sets: 0, slowTxMs: 0 });
  mockValkey.values.clear();
  for (const e of [SESSIONS, KEYS, AUDIT]) await cds.db.run(cds.ql.DELETE.from(e));
  await cds.db.run(cds.ql.INSERT.into(KEYS).entries([
    { ID: KEY_JANE, key: randomBytes(32).toString('hex'), email: JANE, isActive: true },
    { ID: KEY_JOHN, key: randomBytes(32).toString('hex'), email: JOHN, isActive: true }
  ]));
  await publishActiveSessions(new Date()); // nothing owed from an earlier case
  mockValkey.values.clear();
  mockValkey.sets = 0;
});

describe('a failed write is undone before the next write reads the sessions', () => {
  it('a start whose write failed never reaches the key through a start queued behind it', async () => {
    const writing = planWrites({ delayMs: 50, fail: true });
    const failed = settle(start(JANE));
    await writing; // the first start's write is under way; the second start queues behind it
    const second = await start(JOHN);
    expect(await failed).toBeInstanceOf(RawCaptureError);
    expect(storedIds()).toEqual([KEY_JOHN]);
    expect(stored().sessions.map((s: any) => s.id)).toEqual([second.ID]);
    const audited = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'raw.capture.start' }));
    expect(audited.map((a: any) => a.resourceId)).toEqual([second.ID]);
  });

  it('a stop whose write failed leaves the session in the key written by a start queued behind it', async () => {
    const running = await start(JANE);
    const writing = planWrites({ delayMs: 50, fail: true });
    const failed = settle(stopRawCaptureSession(running.ID, ACTOR, new Date()));
    await writing;
    await start(JOHN);
    expect(await failed).toBeInstanceOf(RawCaptureError);
    expect(storedIds()).toEqual([KEY_JANE, KEY_JOHN].sort());
    expect((await cds.db.run(cds.ql.SELECT.one.from(SESSIONS).where({ ID: running.ID })))).toMatchObject({ endedAt: null, endedBy: null });
  });

  it('owes a rewrite after an undo: a write queued ahead of the start read its row, the next check removes it', async () => {
    // C is under way (slow), D queues behind it, then the start inserts its row and queues behind D.
    const writing = planWrites({ delayMs: 200 }, {}, { fail: true });
    const c = publishActiveSessions(new Date());
    await writing;
    const d = publishActiveSessions(new Date());
    const failed = settle(start(JANE));
    for (let i = 0; i < 100 && !(await cds.db.run(cds.ql.SELECT.from(SESSIONS))).length; i++) await new Promise((r) => setTimeout(r, 2));
    await c;
    await d; // D read the start's row and wrote it
    expect(await failed).toBeInstanceOf(RawCaptureError);
    expect(await cds.db.run(cds.ql.SELECT.from(SESSIONS))).toHaveLength(0);
    expect(storedIds()).toEqual([KEY_JANE]); // the window the undo leaves, until the next check
    await withValkeyUrl(async () => {
      const handle = startRawCaptureExpiry({ allowInTest: true, firstRunMs: 600_000, intervalMs: 20 })!;
      try { await until(() => storedIds().length === 0); } finally { handle.stop(); }
    });
    expect(stored()).toEqual({ sessions: [] });
  });
});

describe('the expiry check keeps the key written', () => {
  it('the start-up run writes the key, also when nothing runs and nothing is owed', async () => {
    await withValkeyUrl(async () => {
      const handle = startRawCaptureExpiry({ allowInTest: true, firstRunMs: 5, intervalMs: 600_000 })!;
      try { await until(() => stored() !== undefined); } finally { handle.stop(); }
    });
    expect(stored()).toEqual({ sessions: [] });
  });

  it('the 30 s run rewrites the key while a session runs (Valkey lost it), and writes nothing while none runs', async () => {
    await withValkeyUrl(async () => {
      let handle = startRawCaptureExpiry({ allowInTest: true, firstRunMs: 600_000, intervalMs: 20 })!;
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(mockValkey.sets).toBe(0);
      } finally { handle.stop(); }

      await start(JANE);
      mockValkey.values.clear(); // a Valkey restart without persistence
      handle = startRawCaptureExpiry({ allowInTest: true, firstRunMs: 600_000, intervalMs: 20 })!;
      try { await until(() => stored() !== undefined); } finally { handle.stop(); }
    });
    expect(storedIds()).toEqual([KEY_JANE]);
  });
});
