// Throwaway-database helpers shared by the migration and role suites.
//
// These were copied into five files and had already drifted: two of the copies
// silently lost the comment explaining why roles are dropped AFTER the database
// (and why they must be dropped at all), and only one returned the database
// `name` its caller might need. The behaviour was identical everywhere, so the
// drift was purely in what a reader was told — which is the kind that outlives
// everyone who knew the reason.
//
// Distinct from `schemaFixture.ts`: that one creates an isolated SCHEMA inside
// the shared test database and is what most integration suites want. These
// create a whole DATABASE, which the migration suites need because they run
// runMigration() against a cluster state they fully control — including
// databases with no schema at all, and roles with deliberately restricted
// privileges.
import * as crypto from 'crypto';
import { Pool } from 'pg';

/** The same DSN pointed at a different database on the same cluster. */
export function dsnForDatabase(baseDsn: string, dbName: string): string {
  const url = new URL(baseDsn);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** The same DSN with different credentials. Both parts are percent-encoded, so
 *  a generated password containing URL-significant characters round-trips. */
export function dsnWithCredentials(baseDsn: string, user: string, password: string): string {
  const url = new URL(baseDsn);
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  return url.toString();
}

export interface FreshDatabase {
  dsn: string;
  name: string;
  /**
   * Drops the database, then any roles named in `roleNames`.
   *
   * ORDER IS LOAD-BEARING, in both directions:
   *
   *  - Roles are cluster-scoped, not database-scoped, so dropping this test's
   *    throwaway database does NOT drop the roles it provisioned. Left
   *    unhandled, every run leaves one more `fs_*` role behind on the shared
   *    test cluster, forever.
   *  - The roles must go AFTER the database, never before: a role still holding
   *    privileges on live objects in an existing database cannot be dropped.
   *
   * The connection is to `baseDsn` — a stable database that is never dropped —
   * rather than to `name`, which by then is gone.
   */
  drop(roleNames?: string[]): Promise<void>;
}

/**
 * Creates an empty database with a random name under `namePrefix`, on the same
 * cluster as `baseDsn`.
 *
 * `namePrefix` exists so a leaked database is traceable to the suite that
 * created it; it is not otherwise meaningful. Keep it short — Postgres
 * truncates identifiers at 63 bytes, and 12 hex characters are appended.
 */
export async function createFreshDatabase(baseDsn: string, namePrefix: string): Promise<FreshDatabase> {
  const name = `${namePrefix}${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: baseDsn });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  return {
    dsn: dsnForDatabase(baseDsn, name),
    name,
    async drop(roleNames: string[] = []) {
      const dropper = new Pool({ connectionString: baseDsn });
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        for (const roleName of roleNames) {
          // eslint-disable-next-line no-await-in-loop
          await dropper.query(`DROP ROLE IF EXISTS "${roleName}"`);
        }
      } finally {
        await dropper.end();
      }
    },
  };
}
