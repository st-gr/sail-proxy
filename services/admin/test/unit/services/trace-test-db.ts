/**
 * The database of the payload trace suites: in-memory SQLite, or, for a one-off check against a
 * throwaway container, the PostgreSQL that TRACE_TEST_POSTGRES names as `host:port` (user, password
 * and database `postgres`). The schema is deployed either way.
 *
 * A PostgreSQL is checked on a connection of its own before it is connected as cds.db, and refused when
 * it holds API keys; a suite's cleanup runs only when `ownsTraceTestDb()` says this suite set it up.
 */
import { dirname, join } from 'path';

const cds = require('@sap/cds');
// The driver of @cap-js/postgres; the admin does not depend on it directly.
const { Client } = require(require.resolve('pg', { paths: [dirname(require.resolve('@cap-js/postgres/package.json'))] }));

type PgCredentials = { host: string; port: number; user?: string; password?: string; database?: string };
type GuardClient = { connect: () => Promise<unknown>; query: (sql: string) => Promise<{ rows: any[] }>; end: () => Promise<unknown> };

let owned = false;

/** Whether the last connectTraceTestDb set up the database itself (wiped and deployed it). */
export const ownsTraceTestDb = (): boolean => owned;

/**
 * Throws unless the database is a throwaway one: postgres/postgres on a local port may be a real dev
 * database, and the suites wipe it. One that holds API keys is refused; reads only.
 */
export async function assertThrowawayDatabase(db: { run: (sql: string) => Promise<any> }): Promise<void> {
  const [table] = await db.run(`SELECT to_regclass('public.sap_llm_gateway_admin_apikeys') AS "t"`);
  if (!table?.t) return;
  const [count] = await db.run('SELECT count(*) AS "n" FROM sap_llm_gateway_admin_apikeys');
  const keys = Number(count?.n ?? 0);
  if (keys > 0) {
    throw new Error(`TRACE_TEST_POSTGRES names a database that holds ${keys} API keys; the trace suites wipe it, so they refuse. Point it at a throwaway container.`);
  }
}

/** The guard on a short-lived connection of its own, closed again also when it refuses. */
export async function guardTraceTestPostgres(credentials: PgCredentials,
  openClient: (c: PgCredentials) => GuardClient = (c) => new Client(c)): Promise<void> {
  const client = openClient(credentials);
  await client.connect();
  try {
    await assertThrowawayDatabase({ run: async (sql: string) => (await client.query(sql)).rows });
  } finally {
    await client.end();
  }
}

export async function connectTraceTestDb(opts: { guard?: (c: PgCredentials) => Promise<void> } = {}): Promise<any> {
  owned = false;
  const pg = process.env.TRACE_TEST_POSTGRES;
  if (pg) {
    const [host, port] = pg.split(':');
    const credentials = { host, port: Number(port), user: 'postgres', password: 'postgres', database: 'postgres' };
    // Before cds.db exists: a refused database is never connected as the suite's database.
    await (opts.guard ?? guardTraceTestPostgres)(credentials);
    cds.env.requires.db = { kind: 'postgres', impl: '@cap-js/postgres', credentials };
    cds.env.sql.dialect = 'postgres';
  } else {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
  }
  const db = await cds.connect.to('db');
  // Each suite starts from an empty throwaway database (a second deploy would insert the seed data twice).
  if (pg) {
    await db.run('DROP SCHEMA public CASCADE');
    await db.run('CREATE SCHEMA public');
  }
  await cds.deploy(join(__dirname, '../../../src/db/schema')).to(db);
  owned = true;
  return db;
}
