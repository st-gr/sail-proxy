/**
 * The payload trace suites wipe the PostgreSQL that TRACE_TEST_POSTGRES names. They must refuse a
 * database that holds API keys: postgres/postgres on a local port may be a real dev database. A refused
 * database is never connected as cds.db, and the suites' cleanups touch only a database they set up.
 */
import { assertThrowawayDatabase, guardTraceTestPostgres, connectTraceTestDb, ownsTraceTestDb } from './trace-test-db';

const cds = require('@sap/cds');

/** A database whose ApiKeys table is absent (null) or holds `rows` rows; the statements it ran. */
function fakeDb(rows: number | null, countAs: (n: number) => unknown = String) {
  const ran: string[] = [];
  return {
    ran,
    run: async (sql: string) => {
      ran.push(sql);
      if (/to_regclass/i.test(sql)) return [{ t: rows === null ? null : 'sap_llm_gateway_admin_apikeys' }];
      if (/count\(\*\)/i.test(sql)) return [{ n: countAs(rows ?? 0) }];
      throw new Error(`unexpected statement: ${sql}`);
    }
  };
}

describe('the trace test database guard', () => {
  it('lets a database without the ApiKeys table be wiped', async () => {
    await expect(assertThrowawayDatabase(fakeDb(null))).resolves.toBeUndefined();
  });

  it('lets a database with an empty ApiKeys table be wiped', async () => {
    await expect(assertThrowawayDatabase(fakeDb(0))).resolves.toBeUndefined();
  });

  it('refuses a database that holds API keys, whatever type the count comes back as', async () => {
    await expect(assertThrowawayDatabase(fakeDb(3))).rejects.toThrow(/holds 3 API keys/);
    await expect(assertThrowawayDatabase(fakeDb(1, (n) => n))).rejects.toThrow(/TRACE_TEST_POSTGRES/);
  });

  it('only reads: it runs no DROP', async () => {
    const db = fakeDb(3);
    await assertThrowawayDatabase(db).catch(() => undefined);
    expect(db.ran.join('\n')).not.toMatch(/drop/i);
  });
});

/** A short-lived client whose ApiKeys table holds `rows` rows; what it was asked. */
function fakeClient(rows: number) {
  const calls: string[] = [];
  return {
    calls,
    connect: async () => { calls.push('connect'); },
    query: async (sql: string) => {
      calls.push(sql);
      if (/to_regclass/i.test(sql)) return { rows: [{ t: 'sap_llm_gateway_admin_apikeys' }] };
      return { rows: [{ n: String(rows) }] };
    },
    end: async () => { calls.push('end'); }
  };
}

describe('the guard on its own connection', () => {
  it('reads through a short-lived client and closes it, also when it refuses', async () => {
    const client = fakeClient(2);
    await expect(guardTraceTestPostgres({ host: 'localhost', port: 1 }, () => client)).rejects.toThrow(/holds 2 API keys/);
    expect(client.calls[0]).toBe('connect');
    expect(client.calls[client.calls.length - 1]).toBe('end');
    expect(client.calls.join('\n')).not.toMatch(/drop|delete/i);
  });

  it('lets an empty database through and closes the client', async () => {
    const client = fakeClient(0);
    await expect(guardTraceTestPostgres({ host: 'localhost', port: 1 }, () => client)).resolves.toBeUndefined();
    expect(client.calls[client.calls.length - 1]).toBe('end');
  });
});

describe('a refused TRACE_TEST_POSTGRES', () => {
  const saved = process.env.TRACE_TEST_POSTGRES;
  afterEach(() => { if (saved === undefined) delete process.env.TRACE_TEST_POSTGRES; else process.env.TRACE_TEST_POSTGRES = saved; });

  it('is never connected as cds.db, and the suite does not own it, so no cleanup DELETE reaches it', async () => {
    process.env.TRACE_TEST_POSTGRES = '127.0.0.1:1';
    const connect = jest.spyOn(cds.connect, 'to');
    try {
      await expect(connectTraceTestDb({ guard: async () => { throw new Error('refused'); } })).rejects.toThrow('refused');
      expect(connect).not.toHaveBeenCalled();
      expect(ownsTraceTestDb()).toBe(false);
    } finally {
      connect.mockRestore();
    }
  });
});
