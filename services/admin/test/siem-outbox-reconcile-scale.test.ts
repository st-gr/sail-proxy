import { join } from 'path';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');

import { writeToOutbox, readUndelivered, reconcileOutbox, RECONCILE_CHUNK_SIZE } from '../src/siem/outbox';
import { toSiemEvent } from '../src/siem/siemEvent';

const sample = () => toSiemEvent({
  eventId: `evt-${Math.random().toString(36).slice(2)}`,
  eventType: 'failed_auth', severity: 'high',
  timestamp: '2026-08-17T10:00:00.000Z', credentialId: 'missing',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

// NH1: reconcileOutbox previously read every SiemOutbox.ID with no limit, then issued one
// SiemDelivery `event_ID in (...)` query sized to the ENTIRE backlog -- 12,002 rows fetched
// against a 3000-row backlog, and it hard-fails once a real backlog passes Postgres's
// ~65535-parameter cap (`bind message has N parameter formats but 0 parameters`).
// Reproducing that failure directly needs ~73k rows, too slow for this suite, so this proves
// the bound structurally instead: every query issued during a real multi-thousand-row
// reconcile is captured, and each one's row count / IN-list size must stay within
// RECONCILE_CHUNK_SIZE regardless of the backlog's total size. This test FAILS against the
// pre-fix code: the unbounded version issues one SiemOutbox scan of the whole table and one
// SiemDelivery `IN (...)` sized to the whole table, both far exceeding RECONCILE_CHUNK_SIZE.
//
// Isolated in its own file (own in-memory DB) rather than sharing siem-outbox.test.ts's DB,
// because reconcileOutbox scans the whole SiemOutbox table unconditionally (unlike
// readUndelivered, which is filtered by sink) -- exact "rows created" assertions need a
// backlog whose full size is known, which a shared DB across many test files' rows would not
// give us.
describe('reconcileOutbox at scale (isolated backlog)', () => {
  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' },
    };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);
  });

  it('bounds rows fetched and IN-list size per query, heals the whole backlog, and is idempotent', async () => {
    const db = await cds.connect.to('db');
    const originalRun = db.run.bind(db);
    const outboxScanSizes: number[] = [];
    const deliveryInListSizes: number[] = [];

    const runSpy = jest.spyOn(db, 'run').mockImplementation((query: any, ...rest: any[]) => {
      const from = query?.SELECT?.from?.ref?.[0];
      if (from === 'sap.llm.gateway.admin.SiemOutbox' && query.SELECT.limit) {
        outboxScanSizes.push(query.SELECT.limit.rows?.val ?? Infinity);
      }
      if (from === 'sap.llm.gateway.admin.SiemDelivery' && Array.isArray(query.SELECT.where)) {
        for (const token of query.SELECT.where) {
          if (token && Array.isArray(token.list)) deliveryInListSizes.push(token.list.length);
        }
      }
      return originalRun(query, ...rest);
    });

    const BACKLOG = 3000; // 6x RECONCILE_CHUNK_SIZE -- forces multiple chunk passes
    let firstEventId = '';
    let lastEventId = '';
    try {
      for (let i = 0; i < BACKLOG; i++) {
        const e = sample();
        if (i === 0) firstEventId = e.event_id;
        if (i === BACKLOG - 1) lastEventId = e.event_id;
        await writeToOutbox(e, []); // orphan: no sinks, exactly reconcileOutbox's job to heal
      }

      const created = await reconcileOutbox(['scale-sink-a', 'scale-sink-b']);
      expect(created).toBe(BACKLOG * 2);

      // Paging actually happened (more than one scan), and no single scan/lookup exceeded
      // the chunk constant -- this is the property that keeps the Postgres parameter cap out
      // of reach regardless of how large the backlog grows.
      expect(outboxScanSizes.length).toBeGreaterThan(1);
      for (const rows of outboxScanSizes) expect(rows).toBeLessThanOrEqual(RECONCILE_CHUNK_SIZE);

      expect(deliveryInListSizes.length).toBeGreaterThan(1);
      for (const size of deliveryInListSizes) expect(size).toBeLessThanOrEqual(RECONCILE_CHUNK_SIZE);

      // Idempotency: re-running over the now-healed backlog creates nothing further.
      const secondRun = await reconcileOutbox(['scale-sink-a', 'scale-sink-b']);
      expect(secondRun).toBe(0);

      // The whole backlog actually healed, first and last row of it alike.
      const undelivered = await readUndelivered('scale-sink-a', BACKLOG + 10);
      expect(undelivered.some(r => r.payload.event_id === firstEventId)).toBe(true);
      expect(undelivered.some(r => r.payload.event_id === lastEventId)).toBe(true);
    } finally {
      runSpy.mockRestore();
    }
  }, 120000);

  // A chunk that fails (a transient DB error mid-pass) must not silently disable
  // reconciliation for the rest of the backlog, and must be logged loudly enough that an
  // operator would notice -- not the tick-level 'warn' this replaces. Runs after the test
  // above, so ~3000 already-healed rows exist ahead of this test's own 600 -- meaning any of
  // this test's rows fall many chunks past the one made to fail, proving the pass actually
  // continued rather than stopping after the first chunk.
  it('logs at error and continues with remaining chunks when one chunk fails', async () => {
    const db = await cds.connect.to('db');
    const originalRun = db.run.bind(db);
    const errorSpy = jest.spyOn(getDefaultLogger(), 'error').mockImplementation(() => {});

    let deliverySelectsSeen = 0;
    const runSpy = jest.spyOn(db, 'run').mockImplementation((query: any, ...rest: any[]) => {
      const from = query?.SELECT?.from?.ref?.[0];
      if (from === 'sap.llm.gateway.admin.SiemDelivery' && Array.isArray(query.SELECT.where)) {
        deliverySelectsSeen++;
        if (deliverySelectsSeen === 1) {
          return Promise.reject(new Error('simulated chunk failure'));
        }
      }
      return originalRun(query, ...rest);
    });

    const EXTRA = 600; // > RECONCILE_CHUNK_SIZE, and chronologically after the 3000 rows above
    let firstNewEventId = '';
    let lastNewEventId = '';
    try {
      for (let i = 0; i < EXTRA; i++) {
        const e = sample();
        if (i === 0) firstNewEventId = e.event_id;
        if (i === EXTRA - 1) lastNewEventId = e.event_id;
        await writeToOutbox(e, []);
      }

      const created = await reconcileOutbox(['continue-sink']); // must not throw
      expect(created).toBeGreaterThan(0); // chunks after the failing one still healed rows

      expect(errorSpy).toHaveBeenCalledWith(
        'SiemOutboxReconcile',
        expect.stringContaining('continuing with remaining chunks'),
        expect.any(Error),
        expect.any(Object)
      );

      // Both of this test's own rows sit well past the first (failing) chunk, since ~3000
      // older rows precede them -- their presence proves the pass reached later chunks.
      const undelivered = await readUndelivered('continue-sink', 10000);
      expect(undelivered.some(r => r.payload.event_id === firstNewEventId)).toBe(true);
      expect(undelivered.some(r => r.payload.event_id === lastNewEventId)).toBe(true);
    } finally {
      runSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }, 120000);
});
