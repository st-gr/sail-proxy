import { join } from 'path';

const cds = require('@sap/cds');

import { startDispatcher } from '../src/siem/dispatcher';
import { writeToOutbox, readUndelivered } from '../src/siem/outbox';
import { toSiemEvent } from '../src/siem/siemEvent';
import { SinkError, SiemSink } from '../src/siem/sink';
import { getDefaultLogger } from '@libs/logger';

const outboxModule = require('../src/siem/outbox');

const ev = () => toSiemEvent({
  eventId: `evt-${Math.random().toString(36).slice(2)}`, eventType: 'failed_auth',
  severity: 'high', timestamp: '2026-08-17T10:00:00.000Z', credentialId: 'm',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

const okSink = (name: string, seen: any[] = [], includeCredentialMaterial = false): SiemSink => ({
  name, includeCredentialMaterial, includeContent: false, allowUnmaskedContent: false,
  validateConfig: () => [], healthCheck: async () => true,
  send: async (b) => { seen.push(...b); },
});
const failSink = (name: string, retryable: boolean): SiemSink => ({
  name, includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false,
  validateConfig: () => [], healthCheck: async () => false,
  send: async () => { throw new SinkError('boom', retryable, retryable ? 503 : 400); },
});

describe('dispatcher', () => {
  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' }
    };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);
  });

  it('marks delivered after a successful send', async () => {
    const e = ev(); const seen: any[] = [];
    await writeToOutbox(e, ['ok']);
    const d = startDispatcher([okSink('ok', seen)], { batchSize: 10, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 200)); d.stop();
    expect(seen.some(x => x.event_id === e.event_id)).toBe(true);
    expect((await readUndelivered('ok', 50)).some(r => r.payload.event_id === e.event_id)).toBe(false);
  });

  it('leaves rows pending when the sink fails retryably', async () => {
    const e = ev();
    await writeToOutbox(e, ['flaky']);
    const d = startDispatcher([failSink('flaky', true)], { batchSize: 10, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 200)); d.stop();
    expect((await readUndelivered('flaky', 50)).some(r => r.payload.event_id === e.event_id)).toBe(true);
  });

  it('one failing sink does not block another', async () => {
    const e = ev(); const seen: any[] = [];
    await writeToOutbox(e, ['ok2', 'flaky2']);
    const d = startDispatcher([okSink('ok2', seen), failSink('flaky2', true)],
                              { batchSize: 10, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 200)); d.stop();
    expect(seen.some(x => x.event_id === e.event_id)).toBe(true);
    expect((await readUndelivered('flaky2', 50)).some(r => r.payload.event_id === e.event_id)).toBe(true);
  });

  it('does not spin a non-retryable failure into repeated delivery attempts', async () => {
    const e = ev();
    await writeToOutbox(e, ['dead']);
    // Counts how many times THIS event was actually sent (whether as part of the initial
    // batch or an individual per-row resend after a batch failure -- NH2's fix). A shared DB
    // across this file means reconcileOutbox may also backfill 'dead' rows for other tests'
    // events into the same batch; a raw send()-call count would conflate their individual
    // resends with this row's, which is no longer "spinning", just per-event settlement of a
    // larger batch. What must still hold is that backoff stops THIS row from being resent
    // across many ticks.
    let attempts = 0;
    const deadSink: SiemSink = {
      name: 'dead', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => false,
      send: async (batch) => {
        if (batch.some(x => x.event_id === e.event_id)) attempts++;
        throw new SinkError('rejected', false, 400);
      },
    };
    const d = startDispatcher([deadSink], { batchSize: 10, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 200)); d.stop();
    // ~10 ticks would occur in 200ms at a 20ms interval; the non-retryable backoff must keep
    // this well below that, without ever marking the row delivered.
    expect(attempts).toBeLessThan(5);
    expect((await readUndelivered('dead', 50)).some(r => r.payload.event_id === e.event_id)).toBe(true);
  });

  // CRITICAL 1: a config-read failure at ingest (securityEventSubscriber.ts) can write a
  // SiemOutbox row with zero SiemDelivery rows — orphaned, since readUndelivered only ever
  // looks at SiemDelivery. reconcileOutbox runs every tick (before dispatchOne) specifically
  // to repair this, whatever the cause, so the row must not be stranded forever.
  it('self-heals an outbox row with no SiemDelivery rows and delivers it', async () => {
    const e = ev(); const seen: any[] = [];
    await writeToOutbox(e, []); // orphan: written with no sinks, exactly Critical 1's failure mode
    expect((await readUndelivered('orphaned', 50)).some(r => r.payload.event_id === e.event_id)).toBe(false);

    const d = startDispatcher([okSink('orphaned', seen)], { batchSize: 10, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 200)); d.stop();

    expect(seen.some(x => x.event_id === e.event_id)).toBe(true);
    expect((await readUndelivered('orphaned', 50)).some(r => r.payload.event_id === e.event_id)).toBe(false);
  });

  // CRITICAL 2c: credential_material is the full raw value of an unresolved credential.
  // The default per-sink setting (includeCredentialMaterial: false) must never let it
  // through, and a sink that explicitly opts in must actually receive it — proving both
  // sides of the same outbox row can be routed differently.
  it('strips credential_material for a sink that has not opted in, but ships it for one that has', async () => {
    const CANARY_KEY = 'sk-canary-FAKE-0000000000000000000000';
    const e = toSiemEvent({
      eventId: `evt-${Math.random().toString(36).slice(2)}`, eventType: 'failed_auth',
      severity: 'high', timestamp: '2026-08-17T10:00:00.000Z',
      credentialId: 'deadbeef'.repeat(8), credentialHint: CANARY_KEY.slice(0, 8),
      credentialMaterial: CANARY_KEY,
      authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
    } as any);

    const seenDefault: any[] = []; const seenOptedIn: any[] = [];
    await writeToOutbox(e, ['default-sink', 'opted-in-sink']);

    const d = startDispatcher(
      [okSink('default-sink', seenDefault, false), okSink('opted-in-sink', seenOptedIn, true)],
      { batchSize: 10, intervalMs: 20 },
    );
    await new Promise(r => setTimeout(r, 200)); d.stop();

    const defaultEvent = seenDefault.find(x => x.event_id === e.event_id);
    const optedInEvent = seenOptedIn.find(x => x.event_id === e.event_id);
    expect(defaultEvent).toBeDefined();
    expect(optedInEvent).toBeDefined();

    expect(defaultEvent.actor.credential_material).toBeUndefined();
    expect(JSON.stringify(defaultEvent)).not.toContain(CANARY_KEY);
    expect(optedInEvent.actor.credential_material).toBe(CANARY_KEY);
    // The hint is not gated by the opt-in — it appears in both.
    expect(defaultEvent.actor.credential_hint).toBe(CANARY_KEY.slice(0, 8));
  });

  // IMPORTANT 5: silently dropping an audit event is the failure dead-lettering exists to
  // prevent, so expiry must be loud even though it is the correct outcome for a poison
  // event a sink permanently rejects. Reaching DEFAULT_MAX_ATTEMPTS (10) through the
  // dispatcher's real exponential backoff would take minutes of wall-clock time (the
  // non-retryable multiplier is x4 per attempt, capped at 5 minutes) — outbox.test.ts
  // already proves markFailed's cap/expiry mechanics directly and quickly. What is unique
  // to test here is that dispatchOne actually logs when markFailed reports an expiry, so
  // markFailed is stubbed to report one on the very first (otherwise-ordinary) failure.
  it('logs a warning when markFailed reports a row expired after exhausting delivery attempts', async () => {
    const warnSpy = jest.spyOn(getDefaultLogger(), 'warn').mockImplementation(() => {});
    const markFailedSpy = jest.spyOn(outboxModule, 'markFailed')
      .mockResolvedValue([{ ID: 'expired-row-id', attempts: 10 }]);
    try {
      const e = ev();
      await writeToOutbox(e, ['poison']);
      const poisonSink: SiemSink = {
        name: 'poison', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => false,
        send: async () => { throw new SinkError('rejected', false, 400); },
      };
      const d = startDispatcher([poisonSink], { batchSize: 10, intervalMs: 20 });
      await new Promise(r => setTimeout(r, 100));
      d.stop();

      expect(markFailedSpy).toHaveBeenCalled();
      const expiryWarning = warnSpy.mock.calls.find(
        call => call[0] === 'SiemDispatcher' && call[1] === 'Expiring event(s) after exhausting delivery attempts'
      );
      expect(expiryWarning).toBeDefined();
      expect(expiryWarning![2]).toMatchObject({ sink: 'poison', ids: ['expired-row-id'], attempts: 10 });
    } finally {
      warnSpy.mockRestore();
      markFailedSpy.mockRestore();
    }
  });

  // NH2: dispatchOne used to markFailed(ids) for the WHOLE batch on any send() failure, so
  // every batchmate of a poison event accrued the same attempts and could expire alongside
  // it (measured: 1 poison + 2 good => all three expired, STILL_VISIBLE 0). SiemSink.send is
  // all-or-nothing, so the fix isolates on failure by re-sending each row individually --
  // only the row that actually fails on its own may accrue attempts or expire.
  it('one poison event does not dead-letter or expire valid batchmates', async () => {
    const poison = ev(); const good1 = ev(); const good2 = ev();
    await writeToOutbox(poison, ['poison-batch-sink']);
    await writeToOutbox(good1, ['poison-batch-sink']);
    await writeToOutbox(good2, ['poison-batch-sink']);

    const preRows = await readUndelivered('poison-batch-sink', 10);
    const idFor = (e: any) => preRows.find(r => r.payload.event_id === e.event_id)!.ID;
    const poisonId = idFor(poison), good1Id = idFor(good1), good2Id = idFor(good2);

    const seen: any[] = [];
    const sink: SiemSink = {
      name: 'poison-batch-sink', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async (batch) => {
        if (batch.some(e => e.event_id === poison.event_id)) {
          throw new SinkError('poison payload rejected', false, 400);
        }
        seen.push(...batch);
      },
    };

    const d = startDispatcher([sink], { batchSize: 10, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 200));
    d.stop();

    // The good events were actually delivered on the same tick, not merely spared.
    expect(seen.some(e => e.event_id === good1.event_id)).toBe(true);
    expect(seen.some(e => e.event_id === good2.event_id)).toBe(true);
    expect(seen.some(e => e.event_id === poison.event_id)).toBe(false);

    const stillUndelivered = await readUndelivered('poison-batch-sink', 10);
    expect(stillUndelivered.some(r => r.ID === poisonId)).toBe(true);   // still pending, retryable
    expect(stillUndelivered.some(r => r.ID === good1Id)).toBe(false);  // delivered
    expect(stillUndelivered.some(r => r.ID === good2Id)).toBe(false);  // delivered

    // Direct check of delivery-row state: only the poison row accrued an attempt.
    // event_ID (the SiemDelivery FK), not the delivery row's own ID -- poisonId/good*Id here
    // are OutboxRow.ID values (SiemOutbox.ID), matching outbox.ts's OutboxRow doc comment.
    const deliveryRows: Array<{ event_ID: string; attempts: number; status: string }> = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.SiemDelivery')
        .columns('event_ID', 'attempts', 'status')
        .where({ event_ID: { in: [poisonId, good1Id, good2Id] } })
    );
    const byId = Object.fromEntries(deliveryRows.map(r => [r.event_ID, r]));
    expect(byId[poisonId].attempts).toBe(1);
    expect(byId[poisonId].status).toBe('pending');
    expect(byId[good1Id].attempts).toBe(0);
    expect(byId[good1Id].status).toBe('delivered');
    expect(byId[good2Id].attempts).toBe(0);
    expect(byId[good2Id].status).toBe('delivered');
  });

  // Follow-up finding: dispatchOne bisected on ANY multi-row batch failure, including a
  // RETRYABLE one (a 503 the sink will likely recover from). Isolating a transient,
  // whole-sink outage cannot find a poison event -- there isn't one -- so it only amplified
  // load: an 8-row batch with a retryable failure measured sendCalls=9, sizes=[8,1,1,1,1,1,1,1,1]
  // before this gate. The fix restricts bisection to non-retryable failures on batches of
  // more than one row; a retryable failure settles the whole batch (unchanged rows stay
  // pending, one backoff applies), exactly like the pre-isolation behavior.
  it('a retryable whole-batch failure does not bisect: exactly one send, all rows stay pending with one attempt', async () => {
    const events = Array.from({ length: 8 }, () => ev());
    for (const e of events) await writeToOutbox(e, ['retryable-batch-sink']);

    const preRows = await readUndelivered('retryable-batch-sink', 100);
    const ids = events.map(e => preRows.find(r => r.payload.event_id === e.event_id)!.ID);

    // batchSize 100 (not 8) so this test's own rows are never clipped out of the batch even
    // if reconcileOutbox backfills a few older, unrelated rows from earlier tests in this
    // shared-DB file into 'retryable-batch-sink' too -- that backfill is expected behavior
    // (see NH5), not something this test is about. What matters here is call count and
    // composition, not an exact batch size.
    let sendCalls = 0;
    const batches: any[][] = [];
    const sink: SiemSink = {
      name: 'retryable-batch-sink', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => false,
      send: async (batch) => {
        sendCalls++;
        batches.push(batch);
        throw new SinkError('temporarily unavailable', true, 503);
      },
    };

    const d = startDispatcher([sink], { batchSize: 100, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 200));
    d.stop();

    // Exactly one send call all told -- no bisection into per-row resends -- and that one
    // call carried all 8 of this test's own events together, not split up.
    expect(sendCalls).toBe(1);
    const seenEventIds = new Set(batches[0].map((e: any) => e.event_id));
    expect(events.every(e => seenEventIds.has(e.event_id))).toBe(true);

    const stillUndelivered = await readUndelivered('retryable-batch-sink', 10);
    expect(ids.every(id => stillUndelivered.some(r => r.ID === id))).toBe(true);

    const deliveryRows: Array<{ event_ID: string; attempts: number; status: string }> = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.SiemDelivery')
        .columns('event_ID', 'attempts', 'status')
        .where({ event_ID: { in: ids } })
    );
    expect(deliveryRows.length).toBe(8);
    for (const row of deliveryRows) {
      expect(row.attempts).toBe(1);
      expect(row.status).toBe('pending');
    }
  });

  it('the shipped config names env vars and never holds a secret', () => {
    const cfg = require('../../gateway/api_config.json');
    const sinks = cfg?.api_config?.observability?.siem?.sinks ?? [];
    expect(sinks.length).toBeGreaterThan(0);
    for (const s of sinks) {
      for (const k of Object.keys(s)) {
        expect(['token', 'secret', 'password', 'api_key', 'client_secret']).not.toContain(k);
      }
    }
  });
});

describe('per-sink batching', () => {
  it('reads a per-sink batchSize instead of the global one', async () => {
    const seen: number[] = [];
    const sink: SiemSink = {
      name: 'small', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false,
      validateConfig: () => [], healthCheck: async () => true,
      send: async (b) => { seen.push(b.length); },
    };
    for (let i = 0; i < 10; i++) await writeToOutbox(ev(), ['small']);

    const d = startDispatcher([sink], {
      batchSize: 100, intervalMs: 20,
      perSink: { small: { batchSize: 3 } },
    });
    await new Promise(r => setTimeout(r, 150));
    d.stop();

    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(3);
  });

  it('a sink with a longer interval runs less often than one with a shorter interval', async () => {
    let fast = 0, slow = 0;
    const mk = (name: string, count: () => void): SiemSink => ({
      name, includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false,
      validateConfig: () => [], healthCheck: async () => true,
      send: async () => { count(); },
    });
    for (let i = 0; i < 20; i++) {
      await writeToOutbox(ev(), ['fast']);
      await writeToOutbox(ev(), ['slow']);
    }

    const d = startDispatcher([mk('fast', () => { fast++; }), mk('slow', () => { slow++; })], {
      batchSize: 1, intervalMs: 20,
      perSink: { fast: { intervalMs: 20 }, slow: { intervalMs: 200 } },
    });
    await new Promise(r => setTimeout(r, 400));
    d.stop();

    expect(fast).toBeGreaterThan(slow);
  });

  it('falls back to the global values when a sink has no override', async () => {
    const seen: number[] = [];
    const sink: SiemSink = {
      name: 'plain', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false,
      validateConfig: () => [], healthCheck: async () => true,
      send: async (b) => { seen.push(b.length); },
    };
    for (let i = 0; i < 5; i++) await writeToOutbox(ev(), ['plain']);

    const d = startDispatcher([sink], { batchSize: 2, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 150));
    d.stop();

    expect(Math.max(...seen)).toBeLessThanOrEqual(2);
  });
});

describe('concurrent sink dispatch (Fix 1)', () => {
  it('does not block a fast sink behind a slow one: the fast send begins before the slow send resolves', async () => {
    await writeToOutbox(ev(), ['slow-conc']);
    await writeToOutbox(ev(), ['fast-conc']);

    const order: string[] = [];
    let slowResolved = false;

    const slowSink: SiemSink = {
      name: 'slow-conc', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async () => {
        order.push('slow-start');
        await new Promise(r => setTimeout(r, 100));
        slowResolved = true;
        order.push('slow-end');
      },
    };
    const fastSink: SiemSink = {
      name: 'fast-conc', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async () => {
        order.push('fast-start');
        // The concurrency property under test: the fast sink's send has already begun while
        // the slow sink (declared first, same shape as gcs_pubsub/s3 sitting after other
        // sinks in api_config.json) is still in flight. Serial dispatch would make this
        // false every time, regardless of machine speed.
        expect(slowResolved).toBe(false);
      },
    };

    // Slow sink declared FIRST, same shape as the review's measurement of a later-declared
    // sink starving behind an earlier slow one.
    const d = startDispatcher([slowSink, fastSink], { batchSize: 10, intervalMs: 1000 });
    await new Promise(r => setTimeout(r, 200));
    d.stop();

    expect(order[0]).toBe('slow-start');
    expect(order).toContain('fast-start');
    expect(order.indexOf('fast-start')).toBeLessThan(order.indexOf('slow-end'));
  });
});

describe('in-flight dispatch guard (Fix 2)', () => {
  it('never runs a second concurrent dispatch of the same sink while the first is still in flight', async () => {
    await writeToOutbox(ev(), ['overlap-guard']);

    let inFlight = 0; let maxInFlight = 0; let calls = 0;
    const sink: SiemSink = {
      name: 'overlap-guard', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 100));
        inFlight--;
      },
    };

    // intervalMs (10) is far shorter than send()'s own duration (100ms), so several ticks
    // fire while the row is still undelivered and the first dispatch is still in flight --
    // without the guard, each of those ticks starts another concurrent send() of the same
    // row (the review measured 5 concurrent sends of one row set).
    const d = startDispatcher([sink], { batchSize: 10, intervalMs: 10 });
    await new Promise(r => setTimeout(r, 250));
    d.stop();

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(maxInFlight).toBe(1);
  });
});

// Round-2 review: the first version of the in-flight guard wrapped the ENTIRE tick body
// (reconcileOutbox + every sink) in one `tickInFlight` flag, so no tick -- and therefore no
// OTHER sink -- could start until the current tick's slowest sink finished. That silently
// undid Fix 1's whole point (measured: a fast sink alone got 178 dispatches in 2s; beside a
// single 300ms sink it got 7 -- worse than the 144 the pre-Fix-1 serial code got in the same
// window). The rescoped guard drops the tick-level lock entirely: reconcile gets its own
// small guard (see 'hung reconcile' below), and each sink is held back only by its OWN
// `inFlightSinks` entry, never by another sink's.
describe('cross-sink cadence (Fix 2 rescope regression)', () => {
  it('a slow sink still in flight does not reduce a fast co-tenant sink\'s dispatch count', async () => {
    await writeToOutbox(ev(), ['slow-cadence']);
    for (let i = 0; i < 20; i++) await writeToOutbox(ev(), ['fast-cadence']);

    let slowSettled = false;
    let fastCallsWhileSlowInFlight = 0;

    const slowSink: SiemSink = {
      name: 'slow-cadence', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async () => {
        await new Promise(r => setTimeout(r, 250));
        slowSettled = true;
      },
    };
    const fastSink: SiemSink = {
      name: 'fast-cadence', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async () => {
        // Counts progress made strictly while the slow sink's one dispatch is still
        // unresolved -- the relative-progress property under test, not a wall-clock count,
        // so it holds regardless of machine speed.
        if (!slowSettled) fastCallsWhileSlowInFlight++;
      },
    };

    // Slow sink declared first (same shape as the review's measurement). Fast sink's own
    // interval (5ms) is far shorter than the slow sink's 250ms send: with the old tick-level
    // guard, dispatchSinks() as a whole couldn't be re-entered until the slow sink's single
    // dispatch resolved, so the fast sink would advance at most once in this window.
    const d = startDispatcher([slowSink, fastSink], {
      batchSize: 1, intervalMs: 250,
      perSink: { 'fast-cadence': { intervalMs: 5, batchSize: 1 } },
    });
    await new Promise(r => setTimeout(r, 260));
    d.stop();

    expect(fastCallsWhileSlowInFlight).toBeGreaterThan(1);
  });

  it('a sink whose send() never resolves wedges only that sink, not a co-tenant', async () => {
    await writeToOutbox(ev(), ['hung-solo']);
    for (let i = 0; i < 20; i++) await writeToOutbox(ev(), ['co-tenant']);

    let hungCalls = 0;
    const hungSink: SiemSink = {
      name: 'hung-solo', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      // Never resolves -- stands in for a stalled DB/network call (the case the review
      // flagged as reachable through this codebase's own database-transaction-hang suite),
      // not merely a slow one that eventually times out.
      send: async () => { hungCalls++; return new Promise<void>(() => {}); },
    };
    let coTenantCalls = 0;
    const coTenantSink: SiemSink = {
      name: 'co-tenant', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async () => { coTenantCalls++; },
    };

    const d = startDispatcher([hungSink, coTenantSink], { batchSize: 1, intervalMs: 10 });
    await new Promise(r => setTimeout(r, 150));
    d.stop();

    // The hung sink's own in-flight guard keeps IT from ever being re-entered -- exactly one
    // call, permanently in flight -- but that must not hold the co-tenant back.
    expect(hungCalls).toBe(1);
    expect(coTenantCalls).toBeGreaterThan(1);
  });

  it('a hung reconcileOutbox does not stop sink dispatch from continuing', async () => {
    const reconcileSpy = jest.spyOn(outboxModule, 'reconcileOutbox')
      .mockReturnValue(new Promise(() => {})); // never resolves
    try {
      for (let i = 0; i < 5; i++) await writeToOutbox(ev(), ['delivers-despite-hung-reconcile']);
      const seen: any[] = [];
      const d = startDispatcher(
        [okSink('delivers-despite-hung-reconcile', seen)],
        { batchSize: 10, intervalMs: 20 }
      );
      await new Promise(r => setTimeout(r, 150));
      d.stop();

      expect(seen.length).toBeGreaterThan(0);
      expect((await readUndelivered('delivers-despite-hung-reconcile', 50)).length).toBe(0);
    } finally {
      reconcileSpy.mockRestore();
    }
  });
});

// Task 7C: nothing in the repo ever called the handle startDispatcher returns -- admin-service.ts
// stored it in this.siemDispatcherHandle, and index.ts's gracefulShutdown disconnected the DB
// without stopping it first. A tick landing in that window ran reconcileOutbox/readUndelivered
// against a disconnecting connection, and an in-flight send() completing after the disconnect
// could have its markDelivered fail against the closed DB, so the event would be re-sent on next
// start even though the SIEM already received it. Fixed by wiring stop() into gracefulShutdown
// BEFORE the disconnect (index.ts, admin-service.ts's stopSiemDispatcher()). These tests cover
// what stop() itself must guarantee, at the dispatcher level (index.ts's own wiring is not
// jest-testable — it spins up a whole CDS server — so it is covered by code reading, not a test).
describe('stop() during an in-flight send (Task 7C)', () => {
  // Both tests below check ONE specific row's own delivery status directly by outbox-row ID,
  // rather than through readUndelivered's small `limit` or "every row for this sink name" --
  // reconcileOutbox backfills a delivery row for EVERY already-retained outbox row (from every
  // earlier test in this shared-DB file) the first time a brand-new sink name is dispatched, so
  // a fresh sink name here can accumulate far more than `limit` pending/delivered rows that
  // have nothing to do with this test (see the "self-heals..." test and NH5 above).
  const outboxIdFor = async (eventId: string): Promise<string> => {
    const [row] = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.SiemOutbox').columns('ID').where({ eventId })
    );
    return row.ID;
  };
  const deliveryStatusFor = async (outboxId: string, sinkName: string): Promise<string | undefined> => {
    const [row] = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.SiemDelivery').columns('status').where({ event_ID: outboxId, sinkName })
    );
    return row?.status;
  };

  it('does not throw when called while a send() is still in flight, and does not stop that in-flight send from settling the row correctly (never delivered-but-unmarked)', async () => {
    const e = ev();
    await writeToOutbox(e, ['stop-mid-flight']);
    const outboxId = await outboxIdFor(e.event_id);

    let sendHasStarted = false;
    const sink: SiemSink = {
      name: 'stop-mid-flight', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async () => {
        sendHasStarted = true;
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      },
    };

    const d = startDispatcher([sink], { batchSize: 10, intervalMs: 20 });
    // Let the tick actually start the send() before stopping -- this is the "mid-flight" case,
    // not "stopped before anything ran".
    await new Promise(r => setTimeout(r, 40));
    expect(sendHasStarted).toBe(true);

    // stop() only clears the dispatcher's timers -- see the design-decision comment in
    // index.ts's gracefulShutdown -- it does not (and should not) abort the send() already in
    // flight. It must not throw either way.
    expect(() => d.stop()).not.toThrow();

    // Let the in-flight send() actually finish now that stop() has returned.
    await new Promise(r => setTimeout(r, 120));

    // The row settled to a consistent state: fully delivered, never stuck "sent but not
    // marked" -- stop() did not interrupt markDelivered's own completion.
    expect(await deliveryStatusFor(outboxId, 'stop-mid-flight')).toBe('delivered');
  });

  it('schedules no further ticks after stop(), even one already due, matching "stop scheduling new work" rather than draining the queue', async () => {
    const seen: any[] = [];
    const sink: SiemSink = {
      name: 'stop-no-new-ticks', includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, validateConfig: () => [], healthCheck: async () => true,
      send: async (batch) => { seen.push(...batch); },
    };

    const d = startDispatcher([sink], { batchSize: 10, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 40)); // let at least one tick fire and settle
    d.stop();

    // Written only after stop() -- a "drain the queue" design would still pick this up on a
    // final pass; "stop scheduling new work" (the documented choice) must not.
    const e = ev();
    await writeToOutbox(e, ['stop-no-new-ticks']);
    const outboxId = await outboxIdFor(e.event_id);
    await new Promise(r => setTimeout(r, 100));

    expect(seen.some(x => x.event_id === e.event_id)).toBe(false);
    expect(await deliveryStatusFor(outboxId, 'stop-no-new-ticks')).toBe('pending');
  });
});

