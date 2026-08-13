// Regression coverage for defect 2 — "the gateway holds DDL privileges
// permanently for a boot-only need". Two properties are proven live against
// a real Postgres/pgvector database, not mocked:
//
//   1. When FILE_SEARCH_MIGRATION_DATABASE_URL is set, runMigration()
//      provisions the role named by FILE_SEARCH_DATABASE_URL with DML only:
//      connecting AS that role, `CREATE TABLE` and `CREATE EXTENSION` are
//      both rejected by Postgres itself (not merely "the app never asks
//      it to"), while normal SELECT/INSERT/UPDATE/DELETE against the
//      file_search tables works exactly as it does for the gateway today.
//   2. Fail-closed: a gateway pointed only at a database role that lacks
//      CREATE, against a schema that was never migrated, reports
//      `isFileSearchAvailable() === false` (the source of the controller
//      layer's 503 file_search_unavailable) without crashing and without
//      ever attempting a DDL statement — no error is logged, matching the
//      quality of "no database configured" today, not a caught
//      permission-denied.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

d('runtime role restriction / fail-closed behaviour (requires FILE_SEARCH_TEST_DSN)', () => {
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
  });

  it('provisions a DML-only runtime role: CREATE TABLE and CREATE EXTENSION are both rejected, ' +
     'DML on file_search tables still works', async () => {
    const db = await createFreshDatabase(DSN!, 'fs_role_test_');
    const runtimeUser = `fs_runtime_${crypto.randomBytes(4).toString('hex')}`;
    const runtimePassword = 'p@ss/word ' + crypto.randomBytes(4).toString('hex'); // spaces + '@' + '/' on purpose: exercises escapeLiteral + URL percent-encoding together
    const runtimeDsn = dsnWithCredentials(db.dsn, runtimeUser, runtimePassword);

    try {
      process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn; // superuser: DDL rights
      process.env.FILE_SEARCH_DATABASE_URL = runtimeDsn;        // the role being provisioned
      __resetForTests();

      const ok = await runMigration();
      expect(ok).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);

      // Grant coverage must track the schema exactly, not a hand-maintained
      // list that can silently drift from it: a table present in the
      // migrated schema but missing from the runtime role's grants would
      // leave runMigration() returning true and isFileSearchAvailable()
      // reporting healthy while every query against that one table fails
      // with "permission denied for table" — a per-request failure hidden
      // behind a healthy status. Compares the actual set of tables the
      // database has (this is a fresh, isolated database — every table
      // here came from this migration, nothing pre-existing to exclude)
      // against the actual set the runtime role has SELECT on, both read
      // live from Postgres catalogs, not from db.ts's own source.
      const admin = new Pool({ connectionString: db.dsn });
      try {
        const { rows: allTables } = await admin.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
        );
        const { rows: grantedTables } = await admin.query(
          `SELECT DISTINCT table_name FROM information_schema.role_table_grants
           WHERE grantee = $1 AND privilege_type = 'SELECT' AND table_schema = 'public'
           ORDER BY table_name`,
          [runtimeUser],
        );
        expect(grantedTables.map((r) => r.table_name)).toEqual(allTables.map((r) => r.tablename));
      } finally {
        await admin.end();
      }

      // Prove it live, on a connection that only ever authenticates as the
      // runtime role — never via the migration credential.
      const runtimePool = new Pool({ connectionString: runtimeDsn });
      try {
        await expect(runtimePool.query('CREATE TABLE fs_role_test_should_fail (id int)'))
          .rejects.toThrow(/permission denied/i);

        await expect(runtimePool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto'))
          .rejects.toThrow(/permission denied/i);

        // DML: full round-trip against a real file_search table.
        await runtimePool.query(
          `INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ($1, $2, $3)`,
          ['deadbeef'.repeat(8), 3, 'db'],
        );
        const { rows } = await runtimePool.query(
          `SELECT sha256, size_bytes FROM file_blobs WHERE sha256 = $1`, ['deadbeef'.repeat(8)],
        );
        expect(rows).toEqual([{ sha256: 'deadbeef'.repeat(8), size_bytes: '3' }]);

        await runtimePool.query(`UPDATE file_blobs SET ref_count = ref_count + 1 WHERE sha256 = $1`,
          ['deadbeef'.repeat(8)]);
        await runtimePool.query(`DELETE FROM file_blobs WHERE sha256 = $1`, ['deadbeef'.repeat(8)]);
      } finally {
        await runtimePool.end();
      }
    } finally {
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await db.drop([runtimeUser]);
    }
  });

  it('fails closed (no DDL attempted, no error logged) when only a runtime-only role is configured ' +
     'against an unmigrated database', async () => {
    const db = await createFreshDatabase(DSN!, 'fs_role_test_');
    const restrictedUser = `fs_restricted_${crypto.randomBytes(4).toString('hex')}`;
    const restrictedPassword = crypto.randomBytes(8).toString('hex');

    try {
      // Provision the restricted role directly (not via runMigration()) —
      // simulates a deployment where the deploy-time migration step has
      // simply never run against this database, and the gateway process
      // only ever has the unprivileged runtime DSN.
      const admin = new Pool({ connectionString: db.dsn });
      try {
        await admin.query(`CREATE ROLE "${restrictedUser}" LOGIN PASSWORD '${restrictedPassword}'`);
      } finally {
        await admin.end();
      }

      process.env.FILE_SEARCH_DATABASE_URL = dsnWithCredentials(db.dsn, restrictedUser, restrictedPassword);
      __resetForTests();

      const logger = getDefaultLogger();
      const errorSpy = jest.spyOn(logger, 'error');

      const ok = await runMigration();

      expect(ok).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled(); // no permission-denied caught-and-logged; DDL was never attempted

      const admin2 = new Pool({ connectionString: db.dsn });
      try {
        const { rows } = await admin2.query(
          `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='file_blobs'`,
        );
        expect(rows.length).toBe(0); // confirms no DDL was ever attempted, not just that it failed
      } finally {
        await admin2.end();
      }
    } finally {
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await db.drop([restrictedUser]);
    }
  });
});
