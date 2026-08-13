import { Pool, PoolClient } from 'pg';
import { buildSchemaSql, splitSqlStatements } from './schema.sql';
import { getFileSearchConfig } from '../services/configService';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

let pool: Pool | null = null;
let migrated = false;

export function getPool(): Pool | null {
  if (pool) return pool;
  const dsn = process.env.FILE_SEARCH_DATABASE_URL || process.env.POSTGRES_URL;
  if (!dsn) return null;               // standalone installs: no database, feature unavailable
  pool = new Pool({ connectionString: dsn, max: 10 });
  pool.on('error', (err) => logger.error('FileSearchDb', `Idle pg client error: ${err.message}`, err));
  return pool;
}

export function isFileSearchAvailable(): boolean {
  return getFileSearchConfig().enabled && getPool() !== null && migrated;
}

// A single well-known advisory lock key ('vect' packed as an int4), shared
// verbatim with test/fileSearch/integration/schemaFixture.ts (which imports
// this constant instead of repeating the literal) so production and tests
// serialize against the exact same key. Postgres's `CREATE ... IF NOT
// EXISTS` DDL — for the `vector` extension and, just as much, for every
// `CREATE TABLE IF NOT EXISTS` below — is a check-then-act that is NOT safe
// against genuinely concurrent execution: two sessions racing a first-ever
// attempt can both observe "doesn't exist yet" and both attempt the catalog
// insert, and the loser gets `duplicate key value violates unique
// constraint` instead of a clean no-op. In production this fires whenever
// more than one gateway replica boots cold against a not-yet-migrated
// database: reproduced at 15 of 18 concurrent unguarded runMigration()
// calls failing, across three trials of six simultaneous callers, on
// Postgres 16.14. The losers used to log-and-swallow (see the catch below)
// and then quietly serve `503 file_search_unavailable` forever — a
// hard-to-diagnose partial outage behind a load balancer, not a crash. See
// test/fileSearch/integration/migrationConcurrency.test.ts for the live
// regression coverage.
export const MIGRATION_LOCK_KEY = 0x76656374;

// The set of tables/sequences the runtime (DML-only) role needs access to,
// derived directly from buildSchemaSql() rather than hand-maintained: a
// table added there without a matching entry here would otherwise let
// migration succeed and isFileSearchAvailable() report healthy while every
// query against that table dies with "permission denied for table" — a
// per-request failure hidden behind a healthy status. The embedding
// dimension passed to buildSchemaSql() is arbitrary (any valid value
// produces identical table/sequence names); this SQL is only ever parsed
// for names here, never executed. No table today uses a SERIAL/IDENTITY
// column (every primary key is `text` or a composite of `text`/`int`
// columns supplied by the app), so `sequences` is currently empty — that
// falls out of this derivation automatically rather than needing separate
// upkeep.
//
// Deliberately NOT expressed via `ALTER DEFAULT PRIVILEGES FOR ROLE
// <migration role> IN SCHEMA public` instead of this per-object grant list:
// in the shipped deploy tooling FILE_SEARCH_MIGRATION_DATABASE_URL is the
// *same* role the admin service's CAP schema evolution runs as (both derive
// from POSTGRES_USER), and default privileges in Postgres are scoped by
// (role, schema) only — never by table name. Granting default privileges
// "for that role, in schema public" would also silently apply to every
// future CAP table that role creates, handing the file_search runtime role
// read/write access to admin's API keys and usage records. Explicit,
// idempotent per-object GRANTs — re-applied on every migration run, derived
// fresh from the very SQL that creates each object — avoid that
// cross-contamination entirely and keep the blast radius limited to
// exactly these names.
function runtimeGrantTargets(): { tables: string[]; sequences: string[] } {
  const sql = buildSchemaSql(1);
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  const sequences = [...sql.matchAll(/CREATE SEQUENCE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  return { tables, sequences };
}

// Which of the tables buildSchemaSql() declares are NOT resolvable from this
// connection — derived from that same SQL (never a hand-maintained list), and
// resolved through `to_regclass`, i.e. via the connection's own search_path,
// exactly the way every runtime query will resolve them. Used to decide what
// runMigration() may honestly claim on the paths where DDL was skipped or
// rejected: a table that is absent here is a table whose every query will die
// with 42P01, and that must never be reported as a healthy migration.
async function missingSchemaTables(client: PoolClient): Promise<string[]> {
  const { tables } = runtimeGrantTargets();
  const { rows } = await client.query<{ name: string }>(
    'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NULL', [tables]);
  return rows.map((r) => r.name);
}

function parseDsnCredentials(dsn: string): { user: string; password: string } {
  const url = new URL(dsn);
  return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

// Creates (or, idempotently, updates the password of) the runtime role
// named by `runtimeDsn` and grants it exactly DML on the file_search
// tables — no CREATE, ever. Runs inside the caller's already-open
// transaction on the privileged migration connection; `client.escapeLiteral`
// / `escapeIdentifier` (from `pg`, not a new dependency) build safe SQL text
// directly, since Postgres does not accept query parameters in DDL/role
// statements — `ALTER ROLE x PASSWORD $1` is a syntax error, verified
// against this branch's own pgvector/pg16 test container.
async function grantRuntimeRole(client: PoolClient, migrationUser: string, runtimeDsn: string): Promise<void> {
  const { user, password } = parseDsnCredentials(runtimeDsn);
  if (!user) return; // nothing to provision without a runtime username
  if (user === migrationUser) {
    // The migration and runtime DSNs name the same role (e.g. an install
    // that hasn't split them, or a misconfiguration) — CREATE/ALTER ROLE
    // would just be resetting the migration credential's own password
    // (potentially the Postgres image's bootstrap superuser) on every
    // migration run, and granting DML to a role that's already a superuser
    // is a no-op anyway. Skip provisioning entirely rather than mutate a
    // credential this code did not generate.
    logger.info('FileSearchDb',
      'FILE_SEARCH_DATABASE_URL names the same role as FILE_SEARCH_MIGRATION_DATABASE_URL; skipping runtime role provisioning');
    return;
  }

  const roleIdent = client.escapeIdentifier(user);
  const userLiteral = client.escapeLiteral(user);
  const passwordLiteral = client.escapeLiteral(password);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${userLiteral}) THEN
        CREATE ROLE ${roleIdent} LOGIN PASSWORD ${passwordLiteral};
      ELSE
        ALTER ROLE ${roleIdent} LOGIN PASSWORD ${passwordLiteral};
      END IF;
    END
    $$;
  `);

  const { rows } = await client.query('SELECT current_database() AS db, current_schema() AS schema');
  const dbIdent = client.escapeIdentifier(rows[0].db);
  const schemaIdent = client.escapeIdentifier(rows[0].schema);

  await client.query(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${roleIdent}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schemaIdent} TO ${roleIdent}`);
  // Defense in depth: Postgres 15+ already excludes CREATE on the `public`
  // schema from PUBLIC's default grant, so a freshly created role has no
  // DDL rights unless explicitly given them (which the statements below
  // never do) — this REVOKE just makes that explicit instead of relying on
  // it being nobody's job to have granted CREATE to PUBLIC.
  await client.query(`REVOKE CREATE ON SCHEMA ${schemaIdent} FROM ${roleIdent}`);

  const { tables, sequences } = runtimeGrantTargets();
  for (const table of tables) {
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${client.escapeIdentifier(table)} TO ${roleIdent}`);
  }
  for (const seq of sequences) {
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE ${client.escapeIdentifier(seq)} TO ${roleIdent}`);
  }
}

interface StatementFailure { statement: string; error: any }

/**
 * Thrown when the schema applied but individual statements were rejected.
 * Carries a `code` so callers can keep making the one distinction they always
 * made: 42501 over a complete schema is the healthy non-owner case, anything
 * else is a real failure. When the failures do not agree on a code, `code` is
 * left undefined — a mix that included a 42501 must not read as benign.
 */
class SchemaApplicationError extends Error {
  code?: string;

  failures: StatementFailure[];

  constructor(failures: StatementFailure[], total: number) {
    const codes = new Set(failures.map((f) => f.error?.code));
    const first = failures[0];
    super(
      `${failures.length} of ${total} schema statements were rejected; first was `
      + `${first.error?.code ?? 'no code'}: ${first.error?.message} `
      + `(${first.statement.split('\n')[0].slice(0, 120)})`,
    );
    this.name = 'SchemaApplicationError';
    this.failures = failures;
    this.code = codes.size === 1 ? [...codes][0] : undefined;
  }
}

/**
 * Runs each schema statement inside its own savepoint, so a statement Postgres
 * rejects rolls back alone instead of aborting the whole transaction.
 *
 * This exists for one specific, healthy shape: an install whose schema was
 * created by one role and whose gateway connects as another CREATE-capable
 * role. `CREATE INDEX IF NOT EXISTS` checks OWNERSHIP BEFORE it checks whether
 * the index already exists, so the fourth statement of buildSchemaSql() is
 * rejected with 42501 on every boot of such an install — and as one
 * multi-statement query, that rejection discarded every table declared after
 * it. A table added to the schema therefore never reached those installs.
 *
 * Returns the failures rather than throwing them, because the caller — not
 * this function — decides whether the statements that DID apply should be
 * committed or rolled back. See applySchemaLocked.
 */
async function applySchemaStatements(client: PoolClient): Promise<StatementFailure[]> {
  const statements = splitSqlStatements(buildSchemaSql(getFileSearchConfig().embeddingDimensions));
  const failures: StatementFailure[] = [];

  for (let i = 0; i < statements.length; i += 1) {
    const savepoint = `fs_schema_${i}`;
    // eslint-disable-next-line no-await-in-loop
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.query(statements[i]);
      // eslint-disable-next-line no-await-in-loop
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (err) {
      // ROLLBACK TO leaves the savepoint defined; releasing it too keeps the
      // savepoint stack from growing by one per rejected statement.
      // eslint-disable-next-line no-await-in-loop
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      // eslint-disable-next-line no-await-in-loop
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      failures.push({ statement: statements[i], error: err });
    }
  }

  return failures;
}

/**
 * Applies the schema under the migration advisory lock.
 *
 * `commitPartial` decides what happens when some statements were rejected, and
 * the two answers are opposites for good reason:
 *
 *  - Re-applying over a schema that is already present and working (true):
 *    COMMIT what applied. This is the entire point of the per-statement split
 *    — the install gains the tables added since it last migrated, and the
 *    rejected index it never owned stays rejected, exactly as before.
 *  - A first-ever migration (false): ROLLBACK everything. Committing a
 *    half-built schema would let the NEXT boot take the "already present"
 *    branch and report available-with-warnings, quietly converting a loud,
 *    fail-closed failure into a partial one.
 *
 * Either way the caller sees a throw carrying the rejections, so the existing
 * info-vs-warn reporting is unchanged.
 */
async function applySchemaLocked(
  client: PoolClient,
  { commitPartial }: { commitPartial: boolean },
): Promise<void> {
  let failures: StatementFailure[];
  let total: number;

  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    const statements = splitSqlStatements(buildSchemaSql(getFileSearchConfig().embeddingDimensions));
    total = statements.length;
    failures = await applySchemaStatements(client);
    if (failures.length > 0 && !commitPartial) {
      await client.query('ROLLBACK');
      throw new SchemaApplicationError(failures, total);
    }
    await client.query('COMMIT');
  } catch (err) {
    // A SchemaApplicationError has already rolled back and must not be
    // re-wrapped; anything else is an infrastructure failure (lost connection,
    // lock wait aborted) that leaves the transaction to unwind here.
    if (!(err instanceof SchemaApplicationError)) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw err;
  }

  // Raised only AFTER the successful statements are committed, so the caller's
  // best-effort reporting sees the rejections without undoing the progress.
  if (failures.length > 0) throw new SchemaApplicationError(failures, total);
}

// Confirms the runtime role's grants actually work end-to-end, not just
// that the GRANT statements themselves succeeded against the privileged
// connection — a wrong table name, a search_path mismatch, or any other
// grant misconfiguration would otherwise let migration report success and
// isFileSearchAvailable() report healthy while every real request fails
// with "permission denied". Connects as the runtime role itself (a
// throwaway pool, not the privileged migration connection) so this
// exercises the exact same path getPool() will for every subsequent
// request. Only meaningful for the split-credential path: the fallback
// single-DSN path (applySchemaLocked) runs DDL and DML on the very same
// connection/role, so a successful migration there already proves DML
// works with nothing separate to smoke-test.
async function smokeTestRuntimeGrants(runtimeDsn: string): Promise<void> {
  const smokePool = new Pool({ connectionString: runtimeDsn, max: 1 });
  try {
    await smokePool.query('SELECT 1 FROM file_blobs LIMIT 0');
  } finally {
    await smokePool.end();
  }
}

// Runs the full DDL migration (schema + runtime-role grants) against a
// dedicated, short-lived pool for `migrationDsn` — intentionally never
// assigned to the module-level `pool` singleton returned by getPool(), so
// the gateway's runtime connections (repository.ts, search.ts,
// ingestWorker.ts, blob/*.ts, ...) never see DDL-capable credentials, not
// even transiently.
async function runPrivilegedMigration(migrationDsn: string, runtimeDsn: string | undefined): Promise<void> {
  const migrationPool = new Pool({ connectionString: migrationDsn, max: 2 });
  try {
    const { user: migrationUser } = parseDsnCredentials(migrationDsn);
    const client = await migrationPool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

        // Statement-by-statement, exactly as applySchemaLocked does. This path
        // is fatal on failure either way — it owns the privileged credential
        // and a partial schema must not be committed — so the savepoints buy
        // diagnostics rather than progress: the transaction survives each
        // rejection long enough to collect EVERY failing statement and name
        // them, instead of dying on the first with no indication of which of
        // the ~30 statements it was.
        //
        // Keeping both paths on one applier is the point. They previously
        // differed — one split, one not — and nothing at either call site said
        // so.
        const total = splitSqlStatements(
          buildSchemaSql(getFileSearchConfig().embeddingDimensions),
        ).length;
        const failures = await applySchemaStatements(client);
        if (failures.length > 0) {
          throw new SchemaApplicationError(failures, total);
        }

        if (runtimeDsn) {
          await grantRuntimeRole(client, migrationUser, runtimeDsn);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }

    // Must run after COMMIT: grants are invisible to a fresh connection
    // (the runtime role's own) until the granting transaction commits.
    if (runtimeDsn) {
      const { user: runtimeUser } = parseDsnCredentials(runtimeDsn);
      if (runtimeUser !== migrationUser) {
        await smokeTestRuntimeGrants(runtimeDsn);
      }
    }

    migrated = true;
    logger.info('FileSearchDb', 'file_search schema migration applied (privileged migration credential)');
  } catch (error: any) {
    migrated = false;
    logger.error('FileSearchDb',
      `file_search migration failed; feature will report unavailable: ${error.message}`, error);
  } finally {
    await migrationPool.end();
  }
}

/**
 * Applies the file_search schema migration and returns whether it (or an
 * equivalent already-applied schema) is now in place. The return value is
 * new but additive: existing callers (services/gateway/src/index.ts) call
 * this without using the result, exactly as before.
 *
 * Credential selection:
 *  - `FILE_SEARCH_MIGRATION_DATABASE_URL`, when set, is used for the DDL
 *    (and to provision the runtime role named by FILE_SEARCH_DATABASE_URL);
 *    the runtime pool from getPool() never uses it.
 *  - Otherwise, falls back to today's single-DSN behaviour: DDL is
 *    attempted against the same DSN getPool() uses, unchanged, for local
 *    dev and any install that has not adopted the split credential.
 *
 * In the fallback case the idempotent DDL is re-applied even when the schema
 * is ALREADY present, whenever the configured role holds CREATE on the
 * schema. It used to be skipped outright ("fast, and nothing to do"), which
 * was true only for as long as the schema never changed: the moment
 * buildSchemaSql() gained a table, every single-DSN install that had already
 * migrated silently never got it — runMigration() logged "already present",
 * applied no DDL, and reported success while queries against the new table
 * died with 42P01. The cost of not skipping is negligible and was measured,
 * not assumed: a full re-application against a populated database is single-
 * digit milliseconds, once, at boot. It goes through applySchemaLocked(), so
 * it takes the same advisory lock as the create path — concurrently booting
 * replicas stay safe (see MIGRATION_LOCK_KEY).
 *
 * Re-application over an already-present schema is BEST-EFFORT, and its
 * outcome is not what decides the result. Postgres rejects `CREATE INDEX IF
 * NOT EXISTS` on a table the current role does not own — with 42501 "must be
 * owner of table", before it ever gets to the "it already exists, skipping"
 * check (verified live on 16.14; `CREATE TABLE IF NOT EXISTS` has no such
 * ownership requirement). An install whose schema was created by one role and
 * whose gateway connects as another CREATE-capable role is therefore normal
 * and healthy, and must not be taken offline by a DDL statement that had
 * nothing left to do. So on the already-present path a failed re-application
 * is caught, and what runMigration() reports is decided by probing which of
 * buildSchemaSql()'s tables actually exist (missingSchemaTables):
 *  - none missing: migrated, at info — but only when the rejection was 42501
 *    (insufficient_privilege), i.e. the ownership case above. Re-application
 *    failing for any OTHER reason with every table present is a real failure
 *    and gets a `warn`: it is exactly the shape the table probe cannot see,
 *    since a schema addition that is only an index, a column or a constraint
 *    leaves the table list complete.
 *  - some missing (the role could not create them, whether for lack of CREATE
 *    or lack of ownership): still migrated — the pre-existing schema is
 *    untouched and everything that worked before still works — but with a
 *    loud `warn` naming the absent tables and the migration step that fixes
 *    them. Reporting unavailable instead would convert "an optional,
 *    off-by-default logging table is missing" into a total outage of
 *    file_search; reporting plain success would be the silent lie this whole
 *    change exists to remove.
 *
 * If the schema is absent AND the configured role cannot create it — the
 * shape of a properly locked-down deployment that was pointed at the
 * restricted runtime role without ever running the migration step — no DDL is
 * attempted at all; the feature fails closed (503 file_search_unavailable)
 * exactly as it does with no database configured, just for a different
 * reason.
 */
export async function runMigration(): Promise<boolean> {
  const migrationDsn = process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
  const runtimeDsn = process.env.FILE_SEARCH_DATABASE_URL || process.env.POSTGRES_URL;

  if (migrationDsn) {
    await runPrivilegedMigration(migrationDsn, runtimeDsn);
    return migrated;
  }

  const p = getPool();
  if (!p) {
    logger.info('FileSearchDb', 'No database configured; file_search is unavailable');
    return migrated;
  }

  try {
    const client = await p.connect();
    try {
      const { rows: existsRows } = await client.query("SELECT to_regclass('file_blobs') IS NOT NULL AS exists");
      const { rows: privRows } = await client.query(
        "SELECT has_schema_privilege(current_user, current_schema(), 'CREATE') AS can_create");

      const schemaPresent: boolean = existsRows[0].exists;
      const canCreate: boolean = privRows[0].can_create;

      if (!schemaPresent && !canCreate) {
        migrated = false;
        logger.info('FileSearchDb',
          'file_search schema is absent and the configured database role cannot create it; run the ' +
          'migration deploy step (cli-tools/file-search-migrate.js, or set FILE_SEARCH_MIGRATION_DATABASE_URL) ' +
          '— feature will report unavailable until then');
      } else if (!schemaPresent) {
        // First-ever migration: a failure here is fatal to the feature (the
        // outer catch reports unavailable), because nothing usable exists.
        await applySchemaLocked(client, { commitPartial: false });
        migrated = true;
        logger.info('FileSearchDb', 'file_search schema migration applied');
      } else {
        // Already present: re-apply the idempotent DDL so schema additions
        // reach installs that migrated before those additions existed — but
        // best-effort only. See this function's doc comment for why a
        // rejected re-application must not take a working install offline.
        let ddlError: any = null;
        if (canCreate) {
          try {
            await applySchemaLocked(client, { commitPartial: true });
          } catch (err) {
            ddlError = err;
          }
        }

        const missing = await missingSchemaTables(client);
        migrated = true;
        if (missing.length > 0) {
          const one = missing.length === 1;
          // States the cause verbatim rather than asserting a permissions
          // problem: re-application can fail for reasons that have nothing to
          // do with privileges, and naming the wrong cause sends the operator
          // to the wrong place.
          const cause = ddlError
            ? `re-applying the schema failed (${ddlError.code ?? 'no code'}: ${ddlError.message})`
            : 'this database role has no CREATE privilege on the schema';
          logger.warn('FileSearchDb',
            `file_search schema is present but INCOMPLETE: ${missing.join(', ')} ${one ? 'is' : 'are'} ` +
            `missing and could not be created — ${cause}. Run the migration deploy step ` +
            '(cli-tools/file-search-migrate.js, or set FILE_SEARCH_MIGRATION_DATABASE_URL) to create ' +
            (one ? 'it' : 'them') + '. Until then every query against ' + (one ? 'that table' : 'those tables') +
            ' fails with "relation does not exist"; the rest of file_search is unaffected and stays available');
        } else if (ddlError) {
          // Every expected table is present, yet re-application failed.
          //
          // 42501 (insufficient_privilege) is precisely the healthy non-owner
          // case this best-effort path exists for: Postgres rejects `CREATE
          // INDEX IF NOT EXISTS` on a table the current role does not own
          // before it ever reaches the "already exists, skipping" check, so
          // this fires on every boot of a perfectly correct install. Info.
          //
          // ANY OTHER code is a real failure and must not be swallowed at
          // info. It is also the one shape missingSchemaTables() cannot see:
          // the probe covers tables, so a schema addition that is only an
          // index, a column or a constraint can fail here while every table
          // still exists — silently and permanently, if this line lied about
          // it.
          const benign = ddlError.code === '42501';
          logger[benign ? 'info' : 'warn']('FileSearchDb', benign
            ? 'file_search schema already present and complete; idempotent re-application was rejected by ' +
              `Postgres and skipped (${ddlError.message})`
            : 'file_search schema is present and every expected table exists, but re-applying the schema ' +
              `FAILED (${ddlError.code ?? 'no code'}: ${ddlError.message}). Parts of the schema that are not ` +
              'whole tables — indexes, columns, constraints — may be missing or out of date; the table probe ' +
              'cannot see those. Run the migration deploy step (cli-tools/file-search-migrate.js, or set ' +
              'FILE_SEARCH_MIGRATION_DATABASE_URL) and check the database log');
        } else {
          logger.info('FileSearchDb', 'file_search schema already present; idempotent migration re-applied');
        }
      }
    } finally {
      client.release();
    }
  } catch (error: any) {
    migrated = false;
    logger.error('FileSearchDb',
      `file_search migration failed; feature will report unavailable: ${error.message}`, error);
  }
  return migrated;
}

export function __resetForTests(): void { pool = null; migrated = false; }
