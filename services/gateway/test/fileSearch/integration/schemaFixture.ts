// Per-suite Postgres schema isolation for fileSearch integration tests.
//
// jest.config.json sets no maxWorkers, so Jest runs test files concurrently in
// separate worker processes, and every DSN-gated suite under this directory
// (blobStore, filterCompiler, migration — and any future one) connects to the
// SAME live database. Without isolation, one suite's DELETE/TRUNCATE races
// another suite's INSERTs and reads. No amount of afterAll cleanup discipline
// fixes that: the problem is concurrent access to shared mutable state (the
// `public` schema), not leftover rows. Each suite instead gets its own schema,
// created fresh in beforeAll and dropped CASCADE in afterAll, so suites are
// independent of both execution order and concurrency, and repeat runs never
// depend on manual cleanup between them.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql } from '../../../src/fileSearch/schema.sql';
import { MIGRATION_LOCK_KEY } from '../../../src/fileSearch/db';

export interface IsolatedSchema {
  /** Connections from this pool have `search_path` pinned to `schema, public`. */
  pool: Pool;
  /** The connection string backing `pool` — for a suite that needs its own second
   *  pool pointed at the same schema (e.g. via src/fileSearch/db.ts's `getPool()`
   *  singleton, which builds its own Pool from an env var rather than taking one). */
  dsn: string;
  schema: string;
  teardown(): Promise<void>;
}

// pgvector's `CREATE EXTENSION` is database-scoped, not schema-scoped, and it
// already lives in `public` from earlier setup. `search_path` is set to
// `<schema>,public` specifically so unqualified `vector(N)` column types in
// buildSchemaSql still resolve — `schema` first (so unqualified table/DDL names
// land there), `public` second (so the `vector` type still resolves).
function searchPathDsn(baseDsn: string, schema: string): string {
  const options = encodeURIComponent(`-c search_path=${schema},public`);
  return `${baseDsn}${baseDsn.includes('?') ? '&' : '?'}options=${options}`;
}

function randomSchemaName(): string {
  // Lowercase hex + pid: always a valid, never-needs-quoting identifier
  // (though we quote it anyway below), unique across concurrently-running
  // Jest worker processes without a database round trip to check.
  return `fs_test_${crypto.randomBytes(6).toString('hex')}_${process.pid}`;
}

// Postgres's `IF NOT EXISTS` clauses are not safe against genuinely
// concurrent execution: two sessions racing a first-ever `CREATE EXTENSION
// IF NOT EXISTS vector` can both observe "it doesn't exist yet" and both
// attempt the catalog insert — the loser gets `duplicate key value violates
// unique constraint "pg_extension_name_index"` instead of a clean no-op.
// Reproduced deterministically against this Postgres version (16.14): 5 of 6
// concurrent unguarded attempts failed, across 3 separate trials, on a
// database where the extension did not yet exist; 0 of 18 failed with this
// guard in place. Advisory locks are scoped per-database and visible to
// every backend connected to it, so `pg_advisory_xact_lock` here reliably
// serializes just this one statement across every worker process — not the
// rest of setup. Uses `MIGRATION_LOCK_KEY` from src/fileSearch/db.ts (rather
// than a second literal) so this test fixture and the production
// runMigration() fix for the identical race serialize against the exact
// same key.
async function ensureVectorExtension(baseDsn: string): Promise<void> {
  const admin = new Pool({ connectionString: baseDsn });
  try {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await admin.end();
  }
}

/**
 * Refuse to build a fixture on a database whose `public` schema already carries
 * the file_search tables.
 *
 * `search_path` is `<schema>,public` — deliberately, so unqualified `vector(N)`
 * resolves (see searchPathDsn). The cost of that fallback is that `public` acts
 * as a shadow: a table a test DROPs or RENAMEs away inside its own schema still
 * resolves, to public's copy, and the failure the test was inducing never
 * happens. On 2026-08-07 that broke `migrationUpgrade` (a dropped table still
 * "existed") and `teacherLogging` (a renamed-away table still accepted the
 * insert, so the logger never saw 42P01 and never self-disabled). Neither
 * failure named its cause, and both vanish on a pristine database.
 *
 * `public` gets populated when a running gateway is pointed at the SAME database
 * via FILE_SEARCH_DATABASE_URL — it migrates into `public` at boot. Give the
 * gateway its own database. CI is unaffected (its gateway has no file_search
 * DSN), so this guard exists for the local loop, where the mistake is easy and
 * the symptom is opaque.
 */
async function assertPublicIsClean(baseDsn: string): Promise<void> {
  const probe = new Pool({ connectionString: baseDsn });
  try {
    const { rows } = await probe.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN ('vector_stores', 'fs_files', 'reranker_search_events')
        ORDER BY tablename`,
    );
    if (rows.length > 0) {
      throw new Error(
        `file_search tables exist in the PUBLIC schema of this database (${rows.map(r => r.tablename).join(', ')}). `
        + 'The isolated-schema fixture uses search_path=<schema>,public, so public shadows anything a test '
        + 'drops or renames and the DSN-gated suites fail for reasons that name nothing. This happens when a '
        + 'running gateway has FILE_SEARCH_DATABASE_URL pointing at the same database as FILE_SEARCH_TEST_DSN. '
        + 'Point the gateway at its own database (e.g. filesearch_dev), then drop the file_search tables from '
        + "public here: psql -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' on the TEST database.",
      );
    }
  } finally {
    await probe.end();
  }
}

export async function createIsolatedSchema(baseDsn: string, embeddingDim = 3): Promise<IsolatedSchema> {
  const schema = randomSchemaName();

  await assertPublicIsClean(baseDsn);

  const admin = new Pool({ connectionString: baseDsn });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }

  await ensureVectorExtension(baseDsn);

  const dsn = searchPathDsn(baseDsn, schema);
  const pool = new Pool({ connectionString: dsn });
  await pool.query(buildSchemaSql(embeddingDim));

  return {
    pool,
    dsn,
    schema,
    async teardown() {
      await pool.end();
      const cleanupAdmin = new Pool({ connectionString: baseDsn });
      try {
        await cleanupAdmin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanupAdmin.end();
      }
    },
  };
}
