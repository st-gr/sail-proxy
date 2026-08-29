import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SecurityEventFromGateway } from '../src/services/securityEventSubscriber';

const cds = require('@sap/cds');

// securityEventSubscriber.ts instantiates a singleton and opens a real Valkey connection as
// a module-level side effect on import (see the bottom of that file). VALKEY_URL is set in
// .env for local dev, so importing the module here would otherwise spin up a real background
// consumeLoop that outlives this test file and logs after Jest has finished. Only the
// exported class is needed for these tests, so the env var is hidden for the single
// synchronous require() that constructs it, then restored immediately.
const originalValkeyUrl = process.env.VALKEY_URL;
delete process.env.VALKEY_URL;
const { SecurityEventSubscriber } = require('../src/services/securityEventSubscriber');
if (originalValkeyUrl !== undefined) process.env.VALKEY_URL = originalValkeyUrl;

import { SecurityEventService } from '../src/services/securityEventService';
import { readUndelivered, reconcileOutbox } from '../src/siem/outbox';

const outboxModule = require('../src/siem/outbox');

// Same reasoning as the top-level require above: the constructor calls initializeSubscription(),
// which opens a real Valkey connection whenever VALKEY_URL is set — as it is via .env for local
// dev. Every test here immediately overwrites `.valkeyClient` with a fake, but that races the
// real client's own async connect/subscribe chain, which is what left stray timers logging
// ("Cannot log after tests are done") once enough subscriber instances piled up across this
// file. Hiding VALKEY_URL for construction makes initializeSubscription's early-return path
// ("Valkey URL not configured") the one that runs, so there is no real connection to race.
function newSubscriber(): any {
  const original = process.env.VALKEY_URL;
  delete process.env.VALKEY_URL;
  const subscriber = new SecurityEventSubscriber();
  if (original !== undefined) process.env.VALKEY_URL = original;
  return subscriber;
}

const baseEvent: SecurityEventFromGateway = {
  eventId: 'evt-ack-base',
  credentialId: 'missing-key',
  authType: 'api_key',
  eventType: 'failed_auth',
  severity: 'high',
  description: 'No API key provided',
  timestamp: '2026-08-17T10:00:00.000Z',
  clientIP: '203.0.113.9',
  endpoint: '/x',
  source: 'gateway',
};

describe('SecurityEventSubscriber: ack only after persistence and the outbox both succeed', () => {
  let db: any;

  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' }
    };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);

    // Task 5 reads the enabled sink names from the active configuration instead of the
    // Task 3 hard-coded ['webhook']; seed one here so the outbox-write assertions below
    // still exercise a real write instead of the config-not-found fallback.
    await db.run(
      cds.ql.INSERT.into('sap.llm.gateway.admin.ApiConfigurations').entries({
        ID: uuidv4(),
        name: 'test-config',
        version: '1.0.0',
        isActive: true,
        configData: JSON.stringify({
          api_config: {
            observability: {
              siem: {
                enabled: true,
                sinks: [{ name: 'webhook', type: 'webhook', enabled: true }],
              }
            },
          },
        }),
      })
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // This is the guarantee the whole outbox design rests on. Before this fix,
  // processSecurityEvent swallowed persistence errors and handleStreamEntry acked
  // regardless, so a DB failure meant the event vanished from both the stream (acked)
  // and the database (write rejected) — lost from both, with nothing left to redeliver.
  it('leaves the stream entry unacked when domain persistence fails', async () => {
    const subscriber = newSubscriber();
    const xack = jest.fn();
    (subscriber as any).valkeyClient = { xack };

    jest.spyOn(SecurityEventService, 'createApiKeySecurityEventOrThrow')
      .mockRejectedValue(new Error('connection to db lost'));
    const writeToOutboxSpy = jest.spyOn(outboxModule, 'writeToOutbox');

    const event = { ...baseEvent, eventId: 'evt-fail-1' };
    await (subscriber as any).handleStreamEntry('1-0', ['event', JSON.stringify(event)]);

    expect(xack).not.toHaveBeenCalled();
    // Persistence failed before the outbox write was ever attempted (persist, then outbox,
    // then ack — never ack-first, and never outbox-before-persist).
    expect(writeToOutboxSpy).not.toHaveBeenCalled();
    expect((await readUndelivered('webhook', 100)).some(r => r.payload.event_id === event.eventId)).toBe(false);
  });

  it('persists, writes the outbox, and acks in that order when everything succeeds', async () => {
    const subscriber = newSubscriber();
    const calls: string[] = [];

    jest.spyOn(SecurityEventService, 'createApiKeySecurityEventOrThrow')
      .mockImplementation(async () => { calls.push('persist'); });

    const realWriteToOutbox = outboxModule.writeToOutbox;
    jest.spyOn(outboxModule, 'writeToOutbox').mockImplementation(async (...args: any[]) => {
      calls.push('outbox');
      return realWriteToOutbox(...args);
    });

    const xack = jest.fn(async () => { calls.push('ack'); });
    (subscriber as any).valkeyClient = { xack };

    const event = { ...baseEvent, eventId: 'evt-ok-1' };
    await (subscriber as any).handleStreamEntry('2-0', ['event', JSON.stringify(event)]);

    expect(calls).toEqual(['persist', 'outbox', 'ack']);
    expect(xack).toHaveBeenCalledWith('siem-events', 'siem-ingest', '2-0');
    expect((await readUndelivered('webhook', 100)).some(r => r.payload.event_id === event.eventId)).toBe(true);
  });

  it('acks a stream entry with a malformed JSON payload instead of redelivering it forever', async () => {
    const subscriber = newSubscriber();
    const xack = jest.fn();
    (subscriber as any).valkeyClient = { xack };

    await (subscriber as any).handleStreamEntry('3-0', ['event', '{not valid json']);

    expect(xack).toHaveBeenCalledWith('siem-events', 'siem-ingest', '3-0');
  });

  it('acks a stream entry missing the event field instead of redelivering it forever', async () => {
    const subscriber = newSubscriber();
    const xack = jest.fn();
    (subscriber as any).valkeyClient = { xack };

    await (subscriber as any).handleStreamEntry('4-0', ['other', 'x']);

    expect(xack).toHaveBeenCalledWith('siem-events', 'siem-ingest', '4-0');
  });

  // The other non-negotiable half of Task 5's config gate: an operator's explicit
  // siem.enabled: false must stop the outbox row itself, not just delivery to sinks —
  // no rows, no growth — while still letting the domain event persist and the stream
  // entry ack normally.
  it('writes nothing to the outbox when siem.enabled is explicitly false, but still persists and acks', async () => {
    const subscriber = newSubscriber();
    const xack = jest.fn();
    (subscriber as any).valkeyClient = { xack };

    jest.spyOn(SecurityEventService, 'createApiKeySecurityEventOrThrow')
      .mockImplementation(async () => {});
    const writeToOutboxSpy = jest.spyOn(outboxModule, 'writeToOutbox');

    await db.run(
      cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations')
        .set({
          configData: JSON.stringify({
            api_config: {
              observability: {
                siem: { enabled: false, sinks: [{ name: 'webhook', enabled: true }] },
              },
            },
          }),
        })
        .where({ isActive: true })
    );

    try {
      const event = { ...baseEvent, eventId: 'evt-disabled-1' };
      await (subscriber as any).handleStreamEntry('5-0', ['event', JSON.stringify(event)]);

      expect(writeToOutboxSpy).not.toHaveBeenCalled();
      expect(xack).toHaveBeenCalledWith('siem-events', 'siem-ingest', '5-0');
    } finally {
      // Restore the enabled config so it does not leak into any test that runs after this one.
      await db.run(
        cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations')
          .set({
            configData: JSON.stringify({
              api_config: {
                observability: {
                  siem: { enabled: true, sinks: [{ name: 'webhook', type: 'webhook', enabled: true }] }
                },
              },
            }),
          })
          .where({ isActive: true })
      );
    }
  });

  // CRITICAL 1: getSiemDispatchConfig falls back to shouldWrite:true with an empty sink
  // list on a config-read failure (a parse error here, standing in for any transient read
  // failure) rather than dropping the event — but writing with no sinks means zero
  // SiemDelivery rows, which is invisible to readUndelivered until reconcileOutbox (run every
  // dispatcher tick) repairs it. Proves the orphan exists AND that it is not permanent.
  it('a config-read failure orphans the outbox row, and reconcileOutbox makes it deliverable again', async () => {
    const subscriber = newSubscriber();
    const xack = jest.fn();
    (subscriber as any).valkeyClient = { xack };

    jest.spyOn(SecurityEventService, 'createApiKeySecurityEventOrThrow')
      .mockImplementation(async () => {});

    await db.run(
      cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations')
        .set({ configData: '{not valid json' })
        .where({ isActive: true })
    );

    try {
      const event = { ...baseEvent, eventId: 'evt-orphan-1' };
      await (subscriber as any).handleStreamEntry('6-0', ['event', JSON.stringify(event)]);

      // Acked and persisted to the outbox — the event is not lost...
      expect(xack).toHaveBeenCalledWith('siem-events', 'siem-ingest', '6-0');
      const outboxRows: any[] = await db.run(
        cds.ql.SELECT.from('sap.llm.gateway.admin.SiemOutbox').where({ eventId: event.eventId })
      );
      expect(outboxRows.length).toBe(1);

      // ...but ORPHAN_VISIBLE_TO_DISPATCHER is false: zero SiemDelivery rows means
      // readUndelivered cannot see it yet.
      expect((await readUndelivered('webhook', 100)).some(r => r.payload.event_id === event.eventId)).toBe(false);

      await reconcileOutbox(['webhook']);

      // reconcileOutbox repaired the missing SiemDelivery row; the dispatcher would now
      // deliver it on its next tick.
      expect((await readUndelivered('webhook', 100)).some(r => r.payload.event_id === event.eventId)).toBe(true);
    } finally {
      await db.run(
        cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations')
          .set({
            configData: JSON.stringify({
              api_config: {
                observability: {
                  siem: { enabled: true, sinks: [{ name: 'webhook', type: 'webhook', enabled: true }] }
                },
              },
            }),
          })
          .where({ isActive: true })
      );
    }
  });

  // MINOR 6: siem.categories scopes which normalized-event categories get written to the
  // outbox at all. An operator setting categories: ['audit'] must not still get security
  // events just because ingest never checked the category before writing.
  it('a category excluded by siem.categories is not written to the outbox', async () => {
    const subscriber = newSubscriber();
    const xack = jest.fn();
    (subscriber as any).valkeyClient = { xack };

    jest.spyOn(SecurityEventService, 'createApiKeySecurityEventOrThrow')
      .mockImplementation(async () => {});
    const writeToOutboxSpy = jest.spyOn(outboxModule, 'writeToOutbox');

    await db.run(
      cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations')
        .set({
          configData: JSON.stringify({
            api_config: {
              observability: {
                siem: {
                  enabled: true,
                  categories: ['audit'],
                  sinks: [{ name: 'webhook', type: 'webhook', enabled: true }],
                }
              },
            },
          }),
        })
        .where({ isActive: true })
    );

    try {
      // securityEventSubscriber only ever produces 'security'-category events (there is no
      // live audit-event ingest path yet — see siemEvent.ts), so scoping to ['audit'] must
      // filter every event this subscriber writes.
      const event = { ...baseEvent, eventId: 'evt-filtered-1' };
      await (subscriber as any).handleStreamEntry('7-0', ['event', JSON.stringify(event)]);

      expect(xack).toHaveBeenCalledWith('siem-events', 'siem-ingest', '7-0');
      expect(writeToOutboxSpy).not.toHaveBeenCalled();
      const outboxRows: any[] = await db.run(
        cds.ql.SELECT.from('sap.llm.gateway.admin.SiemOutbox').where({ eventId: event.eventId })
      );
      expect(outboxRows.length).toBe(0);
    } finally {
      await db.run(
        cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations')
          .set({
            configData: JSON.stringify({
              api_config: {
                observability: {
                  siem: { enabled: true, sinks: [{ name: 'webhook', type: 'webhook', enabled: true }] }
                },
              },
            }),
          })
          .where({ isActive: true })
      );
    }
  });
});
