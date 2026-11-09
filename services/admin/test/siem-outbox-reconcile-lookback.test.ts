import { join } from 'path';

const cds = require('@sap/cds');

import { writeToOutbox, readUndelivered, reconcileOutbox, RECONCILE_CHUNK_SIZE } from '../src/siem/outbox';
import { toSiemEvent, SiemEvent } from '../src/siem/siemEvent';

const sampleAt = (timestamp: string) => toSiemEvent({
  eventId: `evt-${Math.random().toString(36).slice(2)}`,
  eventType: 'failed_auth', severity: 'high',
  timestamp, credentialId: 'missing',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

/**
 * Backdates SiemOutbox.createdAt for the given events' rows, in one batched UPDATE. `managed`
 * (siem.cds) sets createdAt to "now" at INSERT time and there is no way to override that
 * through writeToOutbox itself, so this is the only way to simulate "a row that landed a while
 * ago" -- exactly the clock reconcileOutbox's lookback filters on (see outbox.ts's doc comment
 * on why createdAt, not occurredAt).
 */
async function backdateCreatedAt(events: SiemEvent[], createdAt: string): Promise<void> {
  const db = await cds.connect.to('db');
  const rows: Array<{ ID: string }> = await db.run(
    cds.ql.SELECT.from('sap.llm.gateway.admin.SiemOutbox')
      .columns('ID')
      .where({ eventId: { in: events.map(e => e.event_id) } })
  );
  await db.run(
    cds.ql.UPDATE('sap.llm.gateway.admin.SiemOutbox')
      .set({ createdAt })
      .where({ ID: { in: rows.map(r => r.ID) } })
  );
}

/** SiemOutbox.ID for a single event, by its business event_id. */
async function outboxIdFor(eventId: string): Promise<string> {
  const [row] = await cds.run(
    cds.ql.SELECT.from('sap.llm.gateway.admin.SiemOutbox').columns('ID').where({ eventId })
  );
  return row.ID;
}

// Part 7A: reconcileOutbox previously scanned/backfilled the ENTIRE retained outbox on every
// call, with no notion of "too old to matter" -- measured at 35ms/2k rows rising to 292ms/10k
// on in-memory sqlite, and a newly enabled sink backfilled 48,000 delivery rows in a single
// measured call, replaying the whole retained history to a SIEM that had never seen it.
// `lookbackMs` bounds both: only SiemOutbox rows that LANDED (createdAt) inside the window are
// scanned or backfilled at all.
//
// Isolated in its own file (own in-memory DB), for the same reason
// siem-outbox-reconcile-scale.test.ts is: reconcileOutbox scans the whole SiemOutbox table
// unconditionally, and this test's exact "rows scanned"/"rows created" assertions need a
// backlog whose full size is known -- a shared DB across many other tests' rows would not
// give us that once every fixture timestamp reads as "now" (see the comment on `sample()` in
// siem-outbox.test.ts and siem-dispatcher.test.ts: they had to switch off a fixed past date
// specifically because reconcileOutbox's default lookback now applies to them too).
describe('reconcileOutbox lookback (isolated backlog)', () => {
  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' },
    };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);
  });

  it('does not scan or backfill rows that landed before the cutoff, regardless of how many retained rows are old', async () => {
    const db = await cds.connect.to('db');
    const originalRun = db.run.bind(db);
    const outboxScanSizes: number[] = [];
    const runSpy = jest.spyOn(db, 'run').mockImplementation((query: any, ...rest: any[]) => {
      const from = query?.SELECT?.from?.ref?.[0];
      if (from === 'sap.llm.gateway.admin.SiemOutbox' && query.SELECT.limit) {
        outboxScanSizes.push(query.SELECT.limit.rows?.val ?? Infinity);
      }
      return originalRun(query, ...rest);
    });

    const LOOKBACK_MS = 60 * 60 * 1000; // 1 hour
    const OLD_CREATED_AT = new Date(Date.now() - 2 * LOOKBACK_MS).toISOString(); // outside the window
    // Well above RECONCILE_CHUNK_SIZE (500): if the old rows were scanned at all -- rather
    // than filtered out at the DB layer -- paging them would force at least two SiemOutbox
    // scan queries (500 + the remainder) on their own, before the new rows are even reached.
    const OLD_COUNT = RECONCILE_CHUNK_SIZE * 2 + 100;
    const NEW_COUNT = 3;

    const oldEvents: SiemEvent[] = [];
    for (let i = 0; i < OLD_COUNT; i++) {
      const e = sampleAt(new Date().toISOString()); // occurredAt is irrelevant to the filter -- see below
      oldEvents.push(e);
      await writeToOutbox(e, []); // orphan: reconcileOutbox's job to backfill
    }
    await backdateCreatedAt(oldEvents, OLD_CREATED_AT); // ...but createdAt (landing time) is old
    const oldIds = oldEvents.map(e => e.event_id);

    const newIds: string[] = [];
    for (let i = 0; i < NEW_COUNT; i++) {
      const e = sampleAt(new Date().toISOString());
      newIds.push(e.event_id);
      await writeToOutbox(e, []);
    }

    try {
      const created = await reconcileOutbox(['lookback-sink'], LOOKBACK_MS);

      // Cost does not grow with total retained rows: only the 3 recently-landed rows matched
      // the filter, so a single chunk covers them regardless of the 1100 old-landed rows also
      // sitting in the table -- the old rows were filtered out at the DB layer (the WHERE
      // clause), never paged through and discarded in JS.
      expect(created).toBe(NEW_COUNT);
      expect(outboxScanSizes.length).toBe(1);

      // The new-sink backfill excludes everything that landed before the cutoff.
      const undelivered = await readUndelivered('lookback-sink', OLD_COUNT + NEW_COUNT + 10);
      const undeliveredIds = new Set(undelivered.map(r => r.payload.event_id));
      for (const id of newIds) expect(undeliveredIds.has(id)).toBe(true);
      for (const id of oldIds) expect(undeliveredIds.has(id)).toBe(false);

      // Directly confirm no SiemDelivery rows exist for the old events at all -- not just
      // that they're absent from readUndelivered's 'pending' filter.
      const oldDeliveryRows = await db.run(
        cds.ql.SELECT.from('sap.llm.gateway.admin.SiemDelivery')
          .columns('ID')
          .where({ sinkName: 'lookback-sink', event_ID: { in: oldIds } })
      );
      expect(oldDeliveryRows.length).toBe(0);
    } finally {
      runSpy.mockRestore();
    }
  }, 60000);

  // Reviewer-reproduced regression (Important 2): a row can land in this table seconds ago
  // while carrying an event timestamp (occurredAt) that is hours or days old -- an unacked
  // stream entry reclaimed by XAUTOCLAIM long after it first arrived, or a gateway with a
  // skewed clock, both do this. If reconcile filtered on occurredAt, such a row would be
  // permanently invisible to it -- exactly the orphan-healing case reconcile exists for.
  it('still heals a row that landed just now even though its own occurredAt is far outside the lookback window', async () => {
    const staleOccurredAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h old
    const e = sampleAt(staleOccurredAt);
    await writeToOutbox(e, []); // createdAt is "now" (real INSERT time); occurredAt is 48h old

    // Not asserting an exact `created` count here: other tests' recently-landed orphan rows
    // in this shared-per-file DB are also legitimate backfill candidates for a brand-new sink
    // name (same as the "defaults to..." test's comment explains) -- what matters is THIS
    // row's own delivery row, checked directly below.
    await reconcileOutbox(['stale-occurredat-sink'], 60 * 60 * 1000); // 1h lookback

    const outboxId = await outboxIdFor(e.event_id);
    const deliveryRows = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.SiemDelivery')
        .columns('ID')
        .where({ sinkName: 'stale-occurredat-sink', event_ID: outboxId })
    );
    expect(deliveryRows.length).toBe(1);
  });

  // The converse: a row that landed long ago is excluded even if its own occurredAt looks
  // recent -- proves the filter is genuinely keyed on createdAt (landing time), not occurredAt.
  it('does not heal a row that landed long ago even when its own occurredAt looks recent', async () => {
    const e = sampleAt(new Date().toISOString()); // occurredAt: now
    await writeToOutbox(e, []);
    await backdateCreatedAt([e], new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()); // landed 48h ago

    // Not asserting `created === 0` here for the same reason as the test above -- other
    // tests' recently-landed rows are legitimate candidates too. THIS row must specifically
    // NOT be among whatever was created, checked directly below.
    await reconcileOutbox(['old-landing-sink'], 60 * 60 * 1000); // 1h lookback

    const outboxId = await outboxIdFor(e.event_id);
    const deliveryRows = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.SiemDelivery')
        .columns('ID')
        .where({ sinkName: 'old-landing-sink', event_ID: outboxId })
    );
    expect(deliveryRows.length).toBe(0);
  });

  // The prior tests' orphaned rows are still sitting in this isolated-but-shared-per-file DB,
  // and (having just landed) are themselves within a 24h lookback -- so they are also
  // legitimate backfill candidates for this new sink name. That is expected (reconcileOutbox
  // heals every matching orphan, not just "this test's own"), so this checks the two rows
  // under test directly by ID rather than through readUndelivered's small, oldest-first
  // `limit`, which the earlier backlog would otherwise push these two out of.
  it('defaults to DEFAULT_RECONCILE_LOOKBACK_MS (24h) when no lookback is passed', async () => {
    const recent = sampleAt(new Date().toISOString());
    const tooOld = sampleAt(new Date().toISOString());
    await writeToOutbox(recent, []);
    await writeToOutbox(tooOld, []);
    await backdateCreatedAt([tooOld], new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()); // landed 25h ago

    await reconcileOutbox(['default-lookback-sink']); // no lookbackMs argument -- uses the default

    const outboxRows: Array<{ ID: string; eventId: string }> = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.SiemOutbox')
        .columns('ID', 'eventId')
        .where({ eventId: { in: [recent.event_id, tooOld.event_id] } })
    );
    const outboxIdByEventId = Object.fromEntries(outboxRows.map(r => [r.eventId, r.ID]));

    const deliveryRows: Array<{ event_ID: string }> = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.SiemDelivery')
        .columns('event_ID')
        .where({ sinkName: 'default-lookback-sink', event_ID: { in: Object.values(outboxIdByEventId) } })
    );
    const deliveredOutboxIds = new Set(deliveryRows.map(r => r.event_ID));

    expect(deliveredOutboxIds.has(outboxIdByEventId[recent.event_id])).toBe(true);
    expect(deliveredOutboxIds.has(outboxIdByEventId[tooOld.event_id])).toBe(false);
  });
});
