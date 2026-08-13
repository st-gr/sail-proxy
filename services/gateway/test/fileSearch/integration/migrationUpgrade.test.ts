// Regression coverage for "a schema addition never reaches an install that
// already migrated". runMigration()'s single-DSN fallback path used to probe
// `to_regclass('file_blobs')` and, finding the schema present, apply NO DDL at
// all. That was correct for exactly as long as buildSchemaSql() never changed:
// this branch adds `reranker_search_events` / `reranker_candidate_labels`, and
// every install that migrated before this branch and does not set
// FILE_SEARCH_MIGRATION_DATABASE_URL would have gone on logging "file_search
// schema already present" forever while the two tables stayed absent —
// reported healthy, and silently writing zero teacher labels (one `warn`, then
// a permanent self-disable, per teacherLogger.ts's 42P01 handling).
// cli-tools/file-search-migrate.js was no rescue either: it calls this same
// runMigration().
//
// Every test here seeds the PRE-BRANCH schema shape — the current schema with
// the two new tables sliced off, which is exactly 47d276f's buildSchemaSql
// output — and then runs the real runMigration() against a real Postgres.
// Nothing about the migration is mocked; only getFileSearchConfig() is (it is
// how runMigration() learns the embedding dimension).
//
// Three role shapes are covered, because "can this process create the new
// tables?" has three live answers and they must not be conflated:
//   1. owner of the existing objects — the DDL applies, tables appear.
//   2. holds CREATE on the schema but does NOT own the existing objects —
//      Postgres rejects `CREATE INDEX IF NOT EXISTS` on a table the role does
//      not own with 42501 "must be owner of table", *before* the "already
//      exists, skipping" check (verified live on 16.14; `CREATE TABLE IF NOT
//      EXISTS` has no such requirement). A working install must not be taken
//      offline by that.
//   3. no CREATE at all — nothing can be created, and the gateway must say so
//      loudly instead of reporting a healthy migration.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql } from '../../../src/fileSearch/schema.sql';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const NEW_TABLES = ['reranker_search_events', 'reranker_candidate_labels'];

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

// Lets one test make the re-applied DDL fail for a reason that is NOT a
// permissions problem, by appending a statement to the real schema SQL. Empty
// for every other test, so buildSchemaSql() behaves exactly as it ships.
// Appending rather than replacing keeps the CREATE TABLE statements that
// missingSchemaTables() and runtimeGrantTargets() parse out of this same SQL
// intact — the whole point of that test is a failure the TABLE probe cannot
// see, which is what a future index-only or column-only schema addition
// would be.
let mockDdlSuffix = '';
jest.mock('../../../src/fileSearch/schema.sql', () => {
  const actual = jest.requireActual('../../../src/fileSearch/schema.sql');
  return {
    __esModule: true,
    // Spread the real module: db.ts also imports splitSqlStatements from here,
    // and a mock that enumerates only the export it means to override turns
    // every other one into `undefined` — which surfaces as a migration failure
    // blamed on the DDL rather than on the mock.
    ...actual,
    buildSchemaSql: (dim: number) => actual.buildSchemaSql(dim) + mockDdlSuffix,
  };
});

// The schema as it stood before this branch: everything buildSchemaSql()
// emits, up to the first of the two tables this branch added. Derived from
// the live schema rather than pasted from 47d276f so it cannot rot into a
// stale copy — and asserted, not assumed, so a rename that turned this into
// "the whole current schema" (making every test below vacuously pass) fails
// here instead of silently.
function preBranchSchemaSql(): string {
  const full = buildSchemaSql(EMBED_DIM);
  const cut = full.indexOf(`CREATE TABLE IF NOT EXISTS ${NEW_TABLES[0]}`);
  expect(cut).toBeGreaterThan(0);
  const pre = full.slice(0, cut);
  expect(pre).toContain('vector_store_chunks');
  for (const t of NEW_TABLES) expect(pre).not.toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
  return pre;
}

/** Seeds `sql` as the superuser and provisions a login role with the given
 *  schema-level privileges — the role runMigration() will then connect as. */
async function seedDatabaseWithRole(
  baseDsn: string, sql: string, opts: { withCreate: boolean },
): Promise<{ db: Awaited<ReturnType<typeof createFreshDatabase>>; role: string; roleDsn: string }> {
  const db = await createFreshDatabase(baseDsn, 'fs_upgrade_test_');
  const role = `fs_upgrade_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(8).toString('hex');

  const owner = new Pool({ connectionString: db.dsn });
  try {
    await owner.query(sql); // seeded AS the superuser: it owns every object
    await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    const dbName = decodeURIComponent(new URL(db.dsn).pathname.slice(1));
    await owner.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${role}"`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    if (opts.withCreate) {
      await owner.query(`GRANT CREATE ON SCHEMA public TO "${role}"`);
    }
  } finally {
    await owner.end();
  }

  return { db, role, roleDsn: dsnWithCredentials(db.dsn, role, password) };
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [table]);
  return rows[0].ok;
}

d('runMigration() upgrades an already-migrated single-DSN install (requires FILE_SEARCH_TEST_DSN)', () => {
  beforeAll(() => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
    };
  });

  afterEach(async () => {
    await getPool()?.end().catch(() => {});
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    jest.restoreAllMocks();
  });

  // THE headline case: the install shape the whole finding is about. Single
  // DSN (no FILE_SEARCH_MIGRATION_DATABASE_URL), schema already migrated at
  // the pre-branch shape, role owns it. Revert db.ts's change and this fails
  // at the first expect() below with the tables still absent.
  it('creates the newly added tables on a database that already carries the pre-branch schema', async () => {
    let fixture: IsolatedSchema | undefined;
    try {
      // createIsolatedSchema applies the FULL current schema; dropping the two
      // new tables reproduces the pre-branch shape inside an isolated schema
      // (this suite runs concurrently with every other DSN-gated suite).
      fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
      await fixture.pool.query(`DROP TABLE ${NEW_TABLES[1]}, ${NEW_TABLES[0]}`);
      for (const t of NEW_TABLES) {
        expect(await tableExists(fixture.pool, t)).toBe(false);
      }

      process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
      __resetForTests();

      const logger = getDefaultLogger();
      const errorSpy = jest.spyOn(logger, 'error');

      const ok = await runMigration();

      expect(ok).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();

      for (const t of NEW_TABLES) {
        expect(await tableExists(fixture.pool, t)).toBe(true);
      }

      // Existence is not enough — the tables must actually accept the writes
      // teacherLogger.ts makes, including the FK between them.
      const runtime = getPool()!;
      await runtime.query(
        `INSERT INTO reranker_search_events (id, query_text, query_hash, source, store_ids,
           retrieval_mode, reranker_available) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        ['rse_probe', 'q', 'h', 'test', ['vs_1'], 'reranked', true],
      );
      await runtime.query(
        `INSERT INTO reranker_candidate_labels (id, event_id, candidate_index, store_id, file_id,
           ord, chunk_hash, retrieval_rank) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        ['rcl_probe', 'rse_probe', 0, 'vs_1', 'file_1', 0, 'h', 1],
      );
      const { rows } = await runtime.query(
        `SELECT e.id, count(l.id)::int AS labels FROM reranker_search_events e
         JOIN reranker_candidate_labels l ON l.event_id = e.id GROUP BY e.id`);
      expect(rows).toEqual([{ id: 'rse_probe', labels: 1 }]);
    } finally {
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await fixture?.teardown();
    }
  });

  // A role that holds CREATE on the schema but does not own the existing
  // tables is rejected with 42501 on `CREATE INDEX IF NOT EXISTS`, even though
  // every index already exists.
  //
  // This test used to assert that such an install was left DEGRADED — the new
  // tables absent, an INCOMPLETE warning naming them — because one rejected
  // index aborted the single multi-statement query and discarded every
  // statement after it. Per-statement savepoints removed that: the index is
  // still rejected and still rolls back alone, and the tables declared after
  // it now apply. The install upgrades itself, so there is nothing to warn
  // about. What this test still guards is everything around that: it stays
  // available, nothing is logged as an error, and the pre-existing schema is
  // untouched.
  it('upgrades itself, silently, when the role may CREATE but does not own the schema', async () => {
    const seeded = await seedDatabaseWithRole(DSN!, preBranchSchemaSql(), { withCreate: true });
    try {
      process.env.FILE_SEARCH_DATABASE_URL = seeded.roleDsn;
      __resetForTests();

      const logger = getDefaultLogger();
      const warnSpy = jest.spyOn(logger, 'warn');
      const errorSpy = jest.spyOn(logger, 'error');

      const ok = await runMigration();

      expect(ok).toBe(true);              // the pre-existing schema still works
      expect(isFileSearchAvailable()).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();

      // No INCOMPLETE warning: the tables it would have named are now present.
      expect(warnSpy).not.toHaveBeenCalled();

      const runtime = getPool()!;
      for (const t of NEW_TABLES) expect(await tableExists(runtime, t)).toBe(true);
      // And the pre-existing schema came through the partial application
      // unharmed — the rejected index rolled back alone, not the transaction.
      await runtime.query(`INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ($1,$2,$3)`,
        ['ab'.repeat(32), 1, 'db']);
    } finally {
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await seeded.db.drop([seeded.role]);
    }
  });

  // Same non-owner role, but nothing is actually missing: the re-application
  // is still rejected, and that must NOT produce a warn on every single boot.
  // A false alarm here would train operators to ignore the real one above.
  it('does not warn when the re-application is rejected but every expected table is present', async () => {
    const seeded = await seedDatabaseWithRole(DSN!, buildSchemaSql(EMBED_DIM), { withCreate: true });
    try {
      process.env.FILE_SEARCH_DATABASE_URL = seeded.roleDsn;
      __resetForTests();

      const logger = getDefaultLogger();
      const warnSpy = jest.spyOn(logger, 'warn');
      const errorSpy = jest.spyOn(logger, 'error');

      expect(await runMigration()).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await seeded.db.drop([seeded.role]);
    }
  });

  // The complement of the test above, and the reason the info/warn choice is
  // gated on the SQLSTATE rather than on "an error happened at all". 42501 is
  // the benign ownership rejection; anything else is a real failure, and it
  // is precisely the failure missingSchemaTables() cannot detect — every
  // table still exists, so without the code gate a broken schema addition
  // (an index, a column, a constraint) would vanish at `info`, permanently.
  it('names the failing statement when the PRIVILEGED migration path fails', async () => {
    // The privileged path (FILE_SEARCH_MIGRATION_DATABASE_URL) applies the
    // schema statement-by-statement like the single-DSN path does. It is fatal
    // on failure either way — a partial schema must never be committed — so
    // what the savepoints buy is diagnostics: the transaction survives the
    // rejection long enough to report WHICH of the ~30 statements failed,
    // instead of dying on the first with no indication.
    let fixture: IsolatedSchema | undefined;
    try {
      fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
      mockDdlSuffix = '\nSELECT this_statement_is_not_valid_ddl();';

      process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = fixture.dsn;
      __resetForTests();

      const errorSpy = jest.spyOn(getDefaultLogger(), 'error');

      // Fatal: the feature reports unavailable rather than half-migrated.
      expect(await runMigration()).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);

      expect(errorSpy).toHaveBeenCalled();
      const reported = errorSpy.mock.calls.map((c) => String(c[1])).join('\n');
      expect(reported).toContain('this_statement_is_not_valid_ddl');
      expect(reported).toContain('42883');
    } finally {
      mockDdlSuffix = '';
      await getPool()?.end().catch(() => {});
      __resetForTests();
      delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
      await fixture?.teardown();
    }
  });

  it('warns, not infos, when re-application fails for a reason that is not a permissions rejection', async () => {
    let fixture: IsolatedSchema | undefined;
    try {
      fixture = await createIsolatedSchema(DSN!, EMBED_DIM); // complete, current schema
      mockDdlSuffix = '\nSELECT this_statement_is_not_valid_ddl();';

      process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
      __resetForTests();

      const logger = getDefaultLogger();
      const warnSpy = jest.spyOn(logger, 'warn');
      const infoSpy = jest.spyOn(logger, 'info');
      const errorSpy = jest.spyOn(logger, 'error');

      // The install still works — every table is there — so it stays
      // available; the point is that the operator is told, at warn.
      expect(await runMigration()).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warning = String(warnSpy.mock.calls[0][1]);
      expect(warning).toContain('42883');            // undefined_function, i.e. NOT 42501
      expect(warning).toContain('this_statement_is_not_valid_ddl');
      expect(warning).toMatch(/indexes, columns, constraints/);
      expect(warning).toContain('file-search-migrate.js');

      // And it must NOT have been reported as the benign, skip-it-quietly case.
      const infos = infoSpy.mock.calls.map((c) => String(c[1])).join('\n');
      expect(infos).not.toMatch(/rejected by Postgres and skipped/);
    } finally {
      mockDdlSuffix = '';
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await fixture?.teardown();
    }
  });

  // The third role shape: no CREATE at all against an already-migrated
  // pre-branch schema. No DDL is possible, so the honest outcome is "still
  // available, but loudly incomplete" — never a silent success.
  it('warns, naming the tables and the migration step, when the role has no CREATE', async () => {
    const seeded = await seedDatabaseWithRole(DSN!, preBranchSchemaSql(), { withCreate: false });
    try {
      process.env.FILE_SEARCH_DATABASE_URL = seeded.roleDsn;
      __resetForTests();

      const logger = getDefaultLogger();
      const warnSpy = jest.spyOn(logger, 'warn');
      const errorSpy = jest.spyOn(logger, 'error');

      expect(await runMigration()).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();

      const warning = warnSpy.mock.calls.map((c) => String(c[1])).join('\n');
      for (const t of NEW_TABLES) expect(warning).toContain(t);
      expect(warning).toContain('FILE_SEARCH_MIGRATION_DATABASE_URL');
      expect(warning).toContain('file-search-migrate.js');

      const runtime = getPool()!;
      for (const t of NEW_TABLES) expect(await tableExists(runtime, t)).toBe(false);
    } finally {
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await seeded.db.drop([seeded.role]);
    }
  });
});
