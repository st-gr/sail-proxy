import { join } from 'path';

const cds = require('@sap/cds');

import { startDispatcher } from '../src/siem/dispatcher';
import { writeToOutbox, readUndelivered } from '../src/siem/outbox';
import { toSiemEvent } from '../src/siem/siemEvent';
import { SiemSink, safeStringify } from '../src/siem/sink';

const ev = () => toSiemEvent({
  eventId: `evt-${Math.random().toString(36).slice(2)}`, eventType: 'failed_auth',
  severity: 'high', timestamp: new Date().toISOString(), credentialId: 'm',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

/**
 * Part 7B. Before this fix, `JSON.stringify` was unguarded both at ingest (outbox.ts:36) and
 * again at send time in five sinks. The real behavior, established with a failing test before
 * any fix landed (see git history of this file):
 *
 *  - FINDING 1: `writeToOutbox` threw synchronously on a poison event, so nothing was ever
 *    persisted. If reachable, that would be worse than "one delivery attempt fails": the
 *    caller (securityEventSubscriber.ts) catches the throw and leaves the source stream entry
 *    UNACKED for XAUTOCLAIM redelivery -- with no attempts cap at that layer, the same poison
 *    event would be reprocessed and fail identically forever, and every redelivery re-runs
 *    processSecurityEvent's domain-table write first (step 1 of handleStreamEntry), which is
 *    not guarded against being repeated. The mechanism is real (constructed directly below);
 *    the reachability is not, for the same reason as FINDING 2 -- this ingest path itself
 *    feeds toSiemEvent(JSON.parse(raw)) (securityEventSubscriber.ts:229-241), so the event
 *    object handed to writeToOutbox has already round-tripped through JSON.parse and cannot
 *    carry a BigInt, circular reference, or throwing getter either. Fixed as defense-in-depth,
 *    same as FINDING 2, not because this path is exploitable today.
 *  - FINDING 2: a payload that DOES make it into the outbox can never poison a sink's send()
 *    later, because outbox.ts stores it via JSON.stringify and reads it back via JSON.parse
 *    (readUndelivered) -- a value that survives that round trip is by construction free of
 *    BigInts, functions, circular references and throwing getters. So the five sinks' own
 *    unguarded `JSON.stringify(e)` calls were not a currently-reachable failure mode; they are
 *    fixed here anyway, as defense-in-depth matching the ingest-side fix, and against a sink
 *    someday enriching a record with something unsafe before serializing it.
 *  - FINDING 3: when a raw (non-SinkError) exception IS thrown from `send()`, the dispatcher's
 *    `error instanceof SinkError ? error.retryable : true` classification (dispatcher.ts)
 *    treats it as retryable, which skips settleIndividually's bisection (that path only
 *    triggers for a non-retryable failure on a multi-row batch — see
 *    siem-dispatcher.test.ts's "one poison event does not dead-letter..." test). The whole
 *    batch is retried together every tick: poison and innocent rows accrue the same attempts
 *    and never get delivered while sharing a batch with the poison row. The chosen fix (a
 *    serializer that cannot throw) makes this classification gap moot for serialization
 *    specifically, rather than teaching the dispatcher to bisect a wider class of raw errors —
 *    ANY OTHER raw, non-SinkError throw from send() (not just a serialization failure) still
 *    has this gap; not fixed here (see the task report's Concerns).
 */
describe('serialization safety (Part 7B)', () => {
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);
  });

  describe('safeStringify', () => {
    it('serializes a normal SiemEvent exactly like JSON.stringify would', () => {
      const e = ev();
      expect(safeStringify(e)).toBe(JSON.stringify(e));
    });

    it('does not throw on a BigInt, and degrades it to a fixed marker rather than a value-derived string', () => {
      const e = ev();
      (e.actor as any).poisonField = 12345678901234567890n;
      expect(() => safeStringify(e)).not.toThrow();
      const safe = JSON.parse(safeStringify(e));
      expect(safe.actor.poisonField).toBe('[unserializable]');
    });

    it('does not throw on a circular reference, and breaks the cycle with a fixed marker', () => {
      const e: any = ev();
      e.actor.self = e.actor; // circular
      expect(() => safeStringify(e)).not.toThrow();
      const safe = JSON.parse(safeStringify(e));
      expect(safe.actor.self).toBe('[circular]');
    });

    it('does not throw on a throwing getter, and degrades only that property', () => {
      const e: any = ev();
      Object.defineProperty(e.actor, 'poisonGetter', {
        enumerable: true,
        get() { throw new Error('nope'); },
      });
      expect(() => safeStringify(e)).not.toThrow();
      const safe = JSON.parse(safeStringify(e));
      expect(safe.actor.poisonGetter).toBe('[unserializable]');
      // Everything else on the same object is untouched by the one poison property.
      expect(safe.actor.credential_id).toBe(e.actor.credential_id);
    });

    // LiteLLM's own regression test for this class of bug (test_posthog.py's
    // test_safe_dumps_serialization_in_async_send_batch) deliberately uses a secret-shaped
    // `token: "sk-secret"` value inside the poison object. LiteLLM's safe_dumps then WALKS
    // into it (it recognizes Pydantic models and calls model_dump()), so the secret string
    // ends up in its output. This test asserts the opposite for our fallback: nothing about
    // the poison object's OWN content -- including a secret-shaped string sitting right next
    // to the unserializable field -- may leak through the degraded marker.
    it('never emits a credential-shaped value through the degraded marker, even when the poison object\'s own toString() is that value', () => {
      const CANARY_SECRET = 'sk-canary-FAKE-0000000000000000000000';
      const e: any = ev();
      e.actor.credential_material = CANARY_SECRET; // the legitimate field, unrelated to the poison
      e.actor.poison = {
        toString() { return CANARY_SECRET; }, // what a naive String(value) fallback would leak
      };
      // An OWN enumerable property with a throwing getter -- unlike a class-defined getter
      // (which lands on the prototype, invisible to JSON.stringify's own-property walk and
      // so never actually throws), this is what makes JSON.stringify throw at all.
      Object.defineProperty(e.actor.poison, 'bad', {
        enumerable: true,
        get(): never { throw new Error('nope'); },
      });

      const safe = safeStringify(e);
      // The legitimate credential_material field is untouched -- this helper does not redact
      // fields that already serialize fine, only ones that cannot.
      expect(JSON.parse(safe).actor.credential_material).toBe(CANARY_SECRET);
      // But the CANARY_SECRET must appear exactly that ONE time -- not a second time smuggled
      // out via the poison object's own toString(), which a naive fallback would have called.
      const occurrences = safe.split(CANARY_SECRET).length - 1;
      expect(occurrences).toBe(1);
    });

    it('never throws even on a pathological nested structure (array of poisoned objects)', () => {
      const arr: any[] = [{ a: 1n }, { b() {} }, { c: Symbol('x') }];
      arr.push(arr); // circular at the top level too
      expect(() => safeStringify(arr)).not.toThrow();
    });
  });

  describe('writeToOutbox (ingest)', () => {
    it('does not throw and does persist the row when the event contains a value JSON.stringify cannot serialize', async () => {
      const poison = ev();
      (poison.actor as any).poisonField = 10n;

      await expect(writeToOutbox(poison, ['ingest-safety-sink'])).resolves.toBeUndefined();

      const rows: Array<{ payload: string }> = await cds.run(
        cds.ql.SELECT.from('sap.llm.gateway.admin.SiemOutbox').columns('payload').where({ eventId: poison.event_id })
      );
      expect(rows.length).toBe(1);
      const stored = JSON.parse(rows[0].payload);
      expect(stored.actor.poisonField).toBe('[unserializable]');
    });

    it('a poison event no longer poisons its batchmates: all three are delivered on the same batch', async () => {
      const poison = ev();
      (poison.actor as any).poisonField = 10n;
      const good1 = ev();
      const good2 = ev();

      await writeToOutbox(poison, ['ingest-safety-batch-sink']);
      await writeToOutbox(good1, ['ingest-safety-batch-sink']);
      await writeToOutbox(good2, ['ingest-safety-batch-sink']);

      const seen: any[] = [];
      const sink: SiemSink = {
        name: 'ingest-safety-batch-sink', includeCredentialMaterial: false,
        includeContent: false, allowUnmaskedContent: false,
        validateConfig: () => [], healthCheck: async () => true,
        send: async (batch) => { seen.push(...batch); },
      };

      const d = startDispatcher([sink], { batchSize: 10, intervalMs: 20 });
      await new Promise(r => setTimeout(r, 200));
      d.stop();

      expect(seen.some(e => e.event_id === poison.event_id)).toBe(true);
      expect(seen.some(e => e.event_id === good1.event_id)).toBe(true);
      expect(seen.some(e => e.event_id === good2.event_id)).toBe(true);
      expect((await readUndelivered('ingest-safety-batch-sink', 10)).length).toBe(0);
    });
  });

  describe('readUndelivered payload safety', () => {
    it('a payload round-tripped through the outbox is always re-serializable by every sink', async () => {
      const poison = ev();
      (poison.actor as any).poisonField = 10n;
      await writeToOutbox(poison, ['round-trip-safety-sink']);

      const [row] = await readUndelivered('round-trip-safety-sink', 10);
      expect(row).toBeDefined();
      expect(() => JSON.stringify(row.payload)).not.toThrow();
    });
  });
});
