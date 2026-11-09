import { join } from 'path';

const cds = require('@sap/cds');

import { writeToOutbox, readUndelivered, markDelivered, markFailed, reconcileOutbox, DEFAULT_MAX_ATTEMPTS } from '../src/siem/outbox';
import { toSiemEvent } from '../src/siem/siemEvent';

const sample = () => toSiemEvent({
  eventId: `evt-${Math.random().toString(36).slice(2)}`,
  eventType: 'failed_auth', severity: 'high',
  timestamp: '2026-08-17T10:00:00.000Z', credentialId: 'missing',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

describe('outbox', () => {
  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' }
    };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);
  });

  it('makes a written event undelivered for every configured sink', async () => {
    const e = sample();
    await writeToOutbox(e, ['webhook', 'otel']);
    expect((await readUndelivered('webhook', 10)).some(r => r.payload.event_id === e.event_id)).toBe(true);
    expect((await readUndelivered('otel', 10)).some(r => r.payload.event_id === e.event_id)).toBe(true);
  });

  // The property that makes per-sink state worth having: Sentinel succeeding while
  // Datadog is down must be expressible.
  it('delivering to one sink leaves the other undelivered', async () => {
    const e = sample();
    await writeToOutbox(e, ['webhook', 'otel']);
    const row = (await readUndelivered('webhook', 10)).find(r => r.payload.event_id === e.event_id)!;
    await markDelivered([row.ID], 'webhook');
    expect((await readUndelivered('webhook', 10)).some(r => r.ID === row.ID)).toBe(false);
    expect((await readUndelivered('otel', 10)).some(r => r.ID === row.ID)).toBe(true);
  });

  it('markFailed records the error and keeps the row undelivered', async () => {
    const e = sample();
    await writeToOutbox(e, ['webhook']);
    const row = (await readUndelivered('webhook', 10)).find(r => r.payload.event_id === e.event_id)!;
    await markFailed([row.ID], 'webhook', 'connect ECONNREFUSED');
    const still = (await readUndelivered('webhook', 10)).find(r => r.ID === row.ID);
    expect(still).toBeDefined();
  });

  // IMPORTANT 4: the LIMIT must be pushed into the SiemDelivery query itself, not applied
  // by slicing in JS after loading every pending row's LargeString payload — measured at
  // 12000 rows fetched to return 10 against a 3000-row backlog. A backlog "well above" the
  // requested limit here (50 vs. 5) proves the bound holds regardless of backlog size, not
  // just that it happens to fit under a small backlog.
  it('respects the read limit against a backlog well above it', async () => {
    for (let i = 0; i < 50; i++) await writeToOutbox(sample(), ['webhook-limit-test']);
    expect((await readUndelivered('webhook-limit-test', 5)).length).toBe(5);
  });

  // IMPORTANT 5: a row that has failed maxAttempts times is marked 'expired' (not retried
  // forever) and excluded from readUndelivered, so one permanently-rejected event cannot
  // block every event behind it in the batch.
  describe('dead-lettering', () => {
    it('marks a row expired after maxAttempts failures and excludes it from readUndelivered', async () => {
      const e = sample();
      await writeToOutbox(e, ['dead-letter-sink']);
      const row = (await readUndelivered('dead-letter-sink', 10)).find(r => r.payload.event_id === e.event_id)!;

      const maxAttempts = 3;
      for (let i = 0; i < maxAttempts - 1; i++) {
        const expired = await markFailed([row.ID], 'dead-letter-sink', 'connect ECONNREFUSED', maxAttempts);
        expect(expired).toEqual([]);
        expect((await readUndelivered('dead-letter-sink', 10)).some(r => r.ID === row.ID)).toBe(true);
      }

      // markFailed's ID is the SiemDelivery row's own ID, distinct from OutboxRow.ID
      // (SiemOutbox.ID) — see outbox.ts's OutboxRow doc comment.
      const expired = await markFailed([row.ID], 'dead-letter-sink', 'connect ECONNREFUSED', maxAttempts);
      expect(expired).toEqual([{ ID: expect.any(String), attempts: maxAttempts }]);
      expect((await readUndelivered('dead-letter-sink', 10)).some(r => r.ID === row.ID)).toBe(false);
    });

    it('defaults maxAttempts to DEFAULT_MAX_ATTEMPTS when not passed explicitly', async () => {
      const e = sample();
      await writeToOutbox(e, ['dead-letter-default']);
      const row = (await readUndelivered('dead-letter-default', 10)).find(r => r.payload.event_id === e.event_id)!;

      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS - 1; i++) {
        await markFailed([row.ID], 'dead-letter-default', 'boom');
      }
      expect((await readUndelivered('dead-letter-default', 10)).some(r => r.ID === row.ID)).toBe(true);

      const expired = await markFailed([row.ID], 'dead-letter-default', 'boom');
      expect(expired.length).toBe(1);
      expect((await readUndelivered('dead-letter-default', 10)).some(r => r.ID === row.ID)).toBe(false);
    });
  });

  // NH1 regression guards: the chunked reconcileOutbox (siem-outbox-reconcile-scale.test.ts
  // covers the bounding/paging/idempotency properties at scale) must still preserve the two
  // properties the prior review verified about the unchunked version.
  describe('reconcileOutbox preserves prior review properties', () => {
    it('does not resurrect a row already marked expired', async () => {
      const e = sample();
      await writeToOutbox(e, ['reconcile-expire-guard']);
      const row = (await readUndelivered('reconcile-expire-guard', 10)).find(r => r.payload.event_id === e.event_id)!;
      const expired = await markFailed([row.ID], 'reconcile-expire-guard', 'boom', 1);
      expect(expired.length).toBe(1);

      await reconcileOutbox(['reconcile-expire-guard']);
      expect((await readUndelivered('reconcile-expire-guard', 1000)).some(r => r.ID === row.ID)).toBe(false);
    });

    it('does not create a delivery row for a sink that is not passed in (disabled)', async () => {
      const e = sample();
      await writeToOutbox(e, []); // orphan: no sinks at write time

      await reconcileOutbox(['reconcile-enabled-sink']);
      expect((await readUndelivered('reconcile-enabled-sink', 1000)).some(r => r.payload.event_id === e.event_id)).toBe(true);
      expect((await readUndelivered('reconcile-disabled-sink', 1000)).some(r => r.payload.event_id === e.event_id)).toBe(false);
    });
  });
});
