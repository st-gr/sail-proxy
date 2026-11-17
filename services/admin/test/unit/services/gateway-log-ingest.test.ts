/**
 * The admin service's half of the gateway log: stream entries become rows. A batch is stored with an
 * idempotent write keyed by where it came from (stream entry id + index), an entry is acknowledged
 * and deleted only after its rows are committed, and one bad entry can never block the stream.
 */
import { join } from 'path';

const cds = require('@sap/cds');

import {
  storeBatch, handleStreamEntry, startGatewayLogIngest, gatewayLogSettings, ingestStats, resetIngestStats,
  ShippedLogEntry
} from '../../../src/services/gatewayLogIngest';
import { ensureGatewayLogIndexes } from '../../../src/db/data/gateway-log-indexes';

const ENTITY = 'sap.llm.gateway.admin.GatewayLogEntries';
const entry = (over: Partial<ShippedLogEntry> = {}): ShippedLogEntry => ({
  t: '2026-11-11T10:00:00.000Z', seq: 1, level: 'INFO', component: 'chatController', requestId: 'req-1', message: 'hello', ...over
});
const rows = async () => cds.db.run(cds.ql.SELECT.from(ENTITY).orderBy('ID'));
const fakeClient = (over: any = {}) => ({
  xgroup: jest.fn(async () => 'OK'),
  xreadgroup: jest.fn(async () => null),
  xautoclaim: jest.fn(async () => ['0-0', [], []]),
  xack: jest.fn(async () => 1),
  xdel: jest.fn(async () => 1),
  disconnect: jest.fn(),
  ...over
});

describe('gatewayLogSettings', () => {
  const defaults = { enabled: true, retentionHours: 48, maxEntries: 2000000, minLevel: 'INFO' };
  it('gives the defaults for no configuration, no block or a block that is not an object', () => {
    expect(gatewayLogSettings(undefined)).toEqual(defaults);
    expect(gatewayLogSettings({ api_config: { observability: {} } })).toEqual(defaults);
    expect(gatewayLogSettings({ api_config: { observability: { gateway_log: 'on' } } })).toEqual(defaults);
  });
  it('stores the log for a configuration without the block, and keeps a block that says enabled: false off', () => {
    expect(gatewayLogSettings({ api_config: {} }).enabled).toBe(true);
    expect(gatewayLogSettings({ api_config: { observability: { gateway_log: { retention_hours: 12 } } } }).enabled).toBe(true);
    expect(gatewayLogSettings({ api_config: { observability: { gateway_log: { enabled: false } } } }).enabled).toBe(false);
  });
  it('reads the block of observability.gateway_log and upper-cases the level', () => {
    const config = { api_config: { observability: { gateway_log: { enabled: true, retention_hours: 12, max_entries: 500, min_level: 'warn' } } } };
    expect(gatewayLogSettings(config)).toEqual({ enabled: true, retentionHours: 12, maxEntries: 500, minLevel: 'WARN' });
  });
  it('keeps 0 as 0', () => {
    const config = { api_config: { observability: { gateway_log: { retention_hours: 0, max_entries: 0 } } } };
    expect(gatewayLogSettings(config)).toMatchObject({ retentionHours: 0, maxEntries: 0 });
  });
  it('gives the default for a value of the wrong type or range', () => {
    const config = { api_config: { observability: { gateway_log: { enabled: 'yes', retention_hours: '5', max_entries: -1, min_level: 'LOUD' } } } };
    expect(gatewayLogSettings(config)).toEqual(defaults);
  });
});

describe('ensureGatewayLogIndexes', () => {
  it('creates the indexes on loggedAt and storedAt, idempotently', async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../../src/db/schema')).to(db);
    expect(await ensureGatewayLogIndexes(db)).toEqual({ ensured: 6, failed: [] });
    expect(await ensureGatewayLogIndexes(db)).toEqual({ ensured: 6, failed: [] });
    const indexes = await db.run("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sap_llm_gateway_admin_GatewayLogEntries'");
    const byName = Object.fromEntries(indexes.map((i: any) => [i.name, i.sql]));
    expect(byName.idx_gatewaylogentries_loggedat).toMatch(/\(loggedAt\)/);
    expect(byName.idx_gatewaylogentries_storedat).toMatch(/\(storedAt\)/);
  });
});

describe('gateway log ingest', () => {
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../../src/db/schema')).to(db);
  });
  beforeEach(async () => {
    await cds.db.run(cds.ql.DELETE.from(ENTITY));
    resetIngestStats();
  });

  describe('storeBatch', () => {
    it('stores a batch of three as three rows keyed by stream id and index', async () => {
      const n = await storeBatch('1731312000000-0', [entry({ seq: 1 }), entry({ seq: 2, level: 'ERROR', error: 'TypeError: boom' }), entry({ seq: 3, requestId: undefined })]);
      expect(n).toBe(3);
      const r = await rows();
      expect(r.map((x: any) => x.ID)).toEqual(['1731312000000-0-0', '1731312000000-0-1', '1731312000000-0-2']);
      expect(r[1]).toMatchObject({ level: 'ERROR', error: 'TypeError: boom', component: 'chatController', message: 'hello' });
      expect(r[2].requestId).toBeNull();
      expect(new Date(r[0].loggedAt).toISOString()).toBe('2026-11-11T10:00:00.000Z');
    });

    it('sets storedAt to the admin\'s time of the write, one value for the whole batch, whatever the entries\' own time', async () => {
      const before = Date.now();
      await storeBatch('1-0', [entry({ t: '2026-01-01T00:00:00.000Z' }), entry({ seq: 2 })]);
      const after = Date.now();
      const r = await rows();
      expect(r).toHaveLength(2);
      const stored = Date.parse(r[0].storedAt);
      expect(stored).toBeGreaterThanOrEqual(before - 1);
      expect(stored).toBeLessThanOrEqual(after + 1);
      expect(r[1].storedAt).toBe(r[0].storedAt);
    });

    it('cuts an entry longer than its columns instead of refusing it', async () => {
      await storeBatch('1-0', [entry({ message: 'm'.repeat(5000), component: 'c'.repeat(200), requestId: 'r'.repeat(200), error: 'e'.repeat(900) })]);
      const [r] = await rows();
      expect(r.message).toHaveLength(2000);
      expect(r.component).toHaveLength(80);
      expect(r.requestId).toHaveLength(60);
      expect(r.error).toHaveLength(500);
    });

    it('strips NUL characters, which PostgreSQL text cannot hold', async () => {
      await storeBatch('1-0', [entry({ message: 'a\u0000b' })]);
      expect((await rows())[0].message).toBe('ab');
    });

    it('stores a stream entry delivered twice once', async () => {
      await storeBatch('1731312000000-0', [entry(), entry({ seq: 2 })]);
      await storeBatch('1731312000000-0', [entry(), entry({ seq: 2 })]);
      expect(await rows()).toHaveLength(2);
    });

    it('stores two batches with identical t, seq and requestId but different stream ids (two replicas)', async () => {
      await storeBatch('1731312000000-0', [entry()]);
      await storeBatch('1731312000000-1', [entry()]);
      expect(await rows()).toHaveLength(2);
    });

    it('skips an entry that is not an object or has no usable t, stores the rest and counts the skipped', async () => {
      const n = await storeBatch('9-0', [entry({ message: 'good-1' }), null as any, 'text' as any, entry({ t: 'not a date' }), entry({ t: undefined as any }), entry({ t: 12 as any }), entry({ message: 'good-2' })]);
      expect(n).toBe(2);
      expect((await rows()).map((x: any) => x.message)).toEqual(['good-1', 'good-2']);
      expect(ingestStats().skippedEntries).toBe(5);
    });

    describe('a row that cannot be stored must not cost the batch', () => {
      const dataError = () => Object.assign(new Error('invalid input'), { code: '22021' });
      /** cds.tx whose write throws `failWith()` for any write that holds a row with message `bad` (or any write when `all`). */
      const stubWrites = (failWith: () => Error, all = false) => jest.spyOn(cds, 'tx').mockImplementation(async (fn: any) =>
        fn({ run: async (q: any) => {
          const entries: any[] = q.UPSERT.entries;
          if (all || entries.some((r) => r.message === 'bad')) throw failWith();
          return cds.db.run(q);
        } }));

      it('cuts a message at an emoji without leaving a lone surrogate', async () => {
        await storeBatch('1-0', [entry({ message: 'a'.repeat(1999) + '\u{1F600}' })]);
        const [r] = await rows();
        expect(r.message.length).toBeLessThanOrEqual(2000);
        expect(r.message).toBe('a'.repeat(1999));
        expect(r.message.isWellFormed()).toBe(true);
      });
      it('replaces a lone surrogate in the middle of a value', async () => {
        await storeBatch('1-0', [entry({ message: 'x\uD83Dy', component: 'c\uDE00' })]);
        const [r] = await rows();
        expect(r.message).toBe('x\uFFFDy');
        expect(r.component).toBe('c\uFFFD');
      });
      it('stores a seq that is not a safe integer as 0', async () => {
        await storeBatch('1-0', [entry({ seq: 1e30 }), entry({ seq: 2 ** 53 }), entry({ seq: 7 })]);
        expect((await rows()).map((r: any) => Number(r.seq))).toEqual([0, 0, 7]);
      });
      it('stores a level other than ERROR, WARN, INFO, DEBUG, TRACE as INFO', async () => {
        await storeBatch('1-0', [entry({ level: 'warning' }), entry({ level: 'warn' }), entry({ level: 'FATAL' }), entry({ level: 5 as any }), entry({ level: 'trace' })]);
        expect((await rows()).map((r: any) => r.level)).toEqual(['INFO', 'WARN', 'INFO', 'INFO', 'TRACE']);
      });
      it('(a) a data error on the batch write: the other rows are stored one by one, one is skipped, the entry is acknowledged', async () => {
        const spy = stubWrites(dataError);
        const client = fakeClient();
        try {
          await handleStreamEntry(client as any, '3-0', ['batch', JSON.stringify([entry({ message: 'one' }), entry({ message: 'bad' }), entry({ message: 'three' })])]);
        } finally { spy.mockRestore(); }
        expect((await rows()).map((r: any) => r.message)).toEqual(['one', 'three']);
        expect(ingestStats().skippedEntries).toBe(1);
        expect(client.xack).toHaveBeenCalledTimes(1);
        expect(client.xdel).toHaveBeenCalledTimes(1);
      });
      it('(a) storeBatch returns the number stored', async () => {
        const spy = stubWrites(dataError);
        try { expect(await storeBatch('4-0', [entry({ message: 'one' }), entry({ message: 'bad' })])).toBe(1); } finally { spy.mockRestore(); }
      });
      it('(b) a non-data error: nothing is acknowledged and storeBatch rejects', async () => {
        const spy = stubWrites(() => Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }), true);
        const client = fakeClient();
        try {
          await expect(storeBatch('5-0', [entry(), entry({ seq: 2 })])).rejects.toThrow('connection lost');
          await handleStreamEntry(client as any, '5-0', ['batch', JSON.stringify([entry()])]);
        } finally { spy.mockRestore(); }
        expect(client.xack).not.toHaveBeenCalled();
        expect(client.xdel).not.toHaveBeenCalled();
      });
    });

    it('stores an empty batch as nothing', async () => {
      expect(await storeBatch('1-0', [])).toBe(0);
    });
  });

  describe('handleStreamEntry', () => {
    it('stores the batch, then acknowledges and deletes the stream entry, in that order', async () => {
      const order: string[] = [];
      const client = fakeClient({
        xack: jest.fn(async () => { order.push(`ack after ${(await rows()).length} rows`); return 1; }),
        xdel: jest.fn(async () => { order.push('del'); return 1; })
      });
      await handleStreamEntry(client as any, '5-0', ['batch', JSON.stringify([entry(), entry({ seq: 2 })])]);
      expect(order).toEqual(['ack after 2 rows', 'del']);
      expect(client.xack).toHaveBeenCalledWith('gateway-log', 'gateway-log-ingest', '5-0');
      expect(client.xdel).toHaveBeenCalledWith('gateway-log', '5-0');
    });

    it.each([
      ['no batch field', ['other', 'x']],
      ['invalid JSON', ['batch', '{nope']],
      ['JSON that is not an array', ['batch', '{"a":1}']],
      ['an empty batch field', ['batch', '']]
    ])('acknowledges, deletes and counts a malformed entry (%s) so it cannot block the stream', async (_name, fields) => {
      const client = fakeClient();
      await handleStreamEntry(client as any, '6-0', fields as string[]);
      expect(client.xack).toHaveBeenCalledTimes(1);
      expect(client.xdel).toHaveBeenCalledTimes(1);
      expect(ingestStats().malformedEntries).toBe(1);
      expect(await rows()).toHaveLength(0);
    });

    it('logs malformed entries at most once a minute, counting every one', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const client = fakeClient();
        for (let i = 0; i < 5; i++) await handleStreamEntry(client as any, `${i}-0`, ['batch', '{nope']);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(ingestStats().malformedEntries).toBe(5);
        expect(client.xack).toHaveBeenCalledTimes(5);
      } finally { warn.mockRestore(); }
    });

    it('leaves the stream entry unacknowledged when the rows cannot be committed', async () => {
      const client = fakeClient();
      const spy = jest.spyOn(cds, 'tx').mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }));
      try {
        await handleStreamEntry(client as any, '7-0', ['batch', JSON.stringify([entry()])]);
      } finally { spy.mockRestore(); }
      expect(client.xack).not.toHaveBeenCalled();
      expect(client.xdel).not.toHaveBeenCalled();
    });

    it('acknowledges an entry the database rejects with a data error no redelivery can fix', async () => {
      const client = fakeClient();
      const spy = jest.spyOn(cds, 'tx').mockRejectedValueOnce(Object.assign(new Error('value too long'), { code: '22001' }));
      try {
        await handleStreamEntry(client as any, '8-0', ['batch', JSON.stringify([entry()])]);
      } finally { spy.mockRestore(); }
      expect(client.xack).toHaveBeenCalledTimes(1);
      expect(client.xdel).toHaveBeenCalledTimes(1);
    });

    it('does not let a failing XDEL turn into an error (the entry is already acknowledged)', async () => {
      const client = fakeClient({ xdel: jest.fn(async () => { throw new Error('gone'); }) });
      await expect(handleStreamEntry(client as any, '9-0', ['batch', JSON.stringify([entry()])])).resolves.toBeUndefined();
      expect(await rows()).toHaveLength(1);
    });
  });

  describe('startGatewayLogIngest', () => {
    it('creates its consumer group, reads, stores and survives a poison entry', async () => {
      let call = 0;
      let stop: () => Promise<void> = async () => undefined;
      const client = fakeClient({
        xreadgroup: jest.fn(async () => {
          call++;
          if (call === 1) return [['gateway-log', [['1-0', ['batch', 'not json']], ['2-0', ['batch', JSON.stringify([entry({ message: 'after the poison' })])]]]]];
          await stop();
          return null;
        })
      });
      const handle = startGatewayLogIngest({ client: client as any });
      expect(handle).not.toBeNull();
      stop = handle!.stop;
      await handle!.done;
      expect(client.xgroup).toHaveBeenCalledWith('CREATE', 'gateway-log', 'gateway-log-ingest', '0', 'MKSTREAM');
      expect((await rows()).map((r: any) => r.message)).toEqual(['after the poison']);
      expect(client.xack).toHaveBeenCalledTimes(2);
    });

    it('reclaims entries a dead consumer left unacknowledged', async () => {
      let stop: () => Promise<void> = async () => undefined;
      const client = fakeClient({
        xautoclaim: jest.fn(async () => ['0-0', [['3-0', ['batch', JSON.stringify([entry({ message: 'reclaimed' })])]], ['4-0', null]], []]),
        xreadgroup: jest.fn(async () => { await stop(); return null; })
      });
      const handle = startGatewayLogIngest({ client: client as any });
      stop = handle!.stop;
      await handle!.done;
      expect((await rows()).map((r: any) => r.message)).toEqual(['reclaimed']);
    });

    it('does not start in a test process without an injected client, nor without Valkey', () => {
      const saved = process.env.VALKEY_URL;
      process.env.VALKEY_URL = 'redis://127.0.0.1:1';
      try { expect(startGatewayLogIngest()).toBeNull(); } finally { if (saved === undefined) delete process.env.VALKEY_URL; else process.env.VALKEY_URL = saved; }
      delete process.env.VALKEY_URL;
      try { expect(startGatewayLogIngest({ allowInTest: true })).toBeNull(); } finally { if (saved !== undefined) process.env.VALKEY_URL = saved; }
    });
  });
});
