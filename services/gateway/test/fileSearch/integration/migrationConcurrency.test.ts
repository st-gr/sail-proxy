// Regression coverage for the "boot migration is not safe under multiple
// replicas" defect: runMigration() used to run buildSchemaSql() unguarded,
// and Postgres's `CREATE EXTENSION/TABLE IF NOT EXISTS` DDL is a
// check-then-act that is NOT safe against genuinely concurrent execution.
// Reproduced against this branch's own pgvector/pg16 test container: 15 of
// 18 concurrent unguarded runMigration() calls failed with `duplicate key
// value violates unique constraint "pg_extension_name_index"`, across three
// trials of six simultaneous callers — see db.ts's MIGRATION_LOCK_KEY doc
// comment. Because runMigration() deliberately logs-and-swallows failures
// (so an unreachable database doesn't crash the process), a losing replica
// used to boot healthy and answer 503 file_search_unavailable forever,
// silently, while one replica in the fleet worked.
//
// This test creates a brand-new (never-migrated, `CREATE DATABASE`) Postgres
// database per trial specifically so `vector` is NOT already installed —
// unlike this directory's other suites, which share createIsolatedSchema's
// single long-lived database where `vector` is typically already present by
// the time this suite runs and the extension race would simply never fire.
// Multiple trials guard against a single lucky statement ordering passing by
// chance (see the class of bug this very fix addresses: the identical guard
// already existed in schemaFixture.ts for weeks while production stayed
// unguarded, because nobody proved the production path with a live test).
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

const CONCURRENCY = 6;
const TRIALS = 3;

d('runMigration() concurrency safety (requires FILE_SEARCH_TEST_DSN)', () => {
  beforeAll(() => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
    };
  });

  afterAll(() => {
    delete process.env.FILE_SEARCH_DATABASE_URL;
  });

  for (let trial = 1; trial <= TRIALS; trial++) {
    it(`trial ${trial}/${TRIALS}: ${CONCURRENCY} concurrent runMigration() calls against a fresh, ` +
       `never-migrated database all succeed and produce one correct schema`, async () => {
      const db = await createFreshDatabase(DSN!, 'fs_migration_race_');
      try {
        process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
        __resetForTests();

        const logger = getDefaultLogger();
        const errorSpy = jest.spyOn(logger, 'error');

        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, () => runMigration()),
        );

        // Every simulated replica must report migrated (no silent losers
        // left serving 503 while one replica works).
        expect(results).toEqual(Array(CONCURRENCY).fill(true));
        // No caller may have hit the duplicate-key race; runMigration()
        // swallows failures internally, so the only externally observable
        // trace of a loss is a logged error.
        expect(errorSpy).not.toHaveBeenCalled();

        const pool = getPool()!;
        const { rows: tableRows } = await pool.query(
          `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN
           ('file_blobs','fs_files','vector_stores','vector_store_files','vector_store_chunks')`,
        );
        expect(tableRows.length).toBe(5);

        const { rows: extRows } = await pool.query(`SELECT extname FROM pg_extension WHERE extname='vector'`);
        expect(extRows.length).toBe(1);
      } finally {
        await getPool()?.end();
        __resetForTests();
        await db.drop(); // no role provisioned on this path — nothing to clean up
      }
    });
  }
});

// db.ts has two independent call sites for the advisory-lock guard: the
// fallback single-DSN path exercised above (applySchemaLocked, used when
// FILE_SEARCH_MIGRATION_DATABASE_URL is unset) and runPrivilegedMigration's
// own inline BEGIN/lock/DDL block (used when it is set). They are separate
// code paths, not a shared helper, so a lock removed from one would not be
// caught by a test that only exercises the other — this covers the second
// path the same way.
d('runMigration() concurrency safety via FILE_SEARCH_MIGRATION_DATABASE_URL (requires FILE_SEARCH_TEST_DSN)', () => {
  beforeAll(() => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
    };
  });

  afterAll(() => {
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    delete process.env.FILE_SEARCH_DATABASE_URL;
  });

  for (let trial = 1; trial <= TRIALS; trial++) {
    it(`trial ${trial}/${TRIALS}: ${CONCURRENCY} concurrent runMigration() calls via the privileged ` +
       `migration DSN against a fresh, never-migrated database all succeed`, async () => {
      const db = await createFreshDatabase(DSN!, 'fs_migration_race_');
      const runtimeUser = `fs_conc_runtime_${crypto.randomBytes(4).toString('hex')}`;
      try {
        process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn;
        process.env.FILE_SEARCH_DATABASE_URL =
          db.dsn.replace(/postgresql:\/\/[^:]+:[^@]+@/, `postgresql://${runtimeUser}:concurrencytestpw@`);
        __resetForTests();

        const logger = getDefaultLogger();
        const errorSpy = jest.spyOn(logger, 'error');

        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, () => runMigration()),
        );

        expect(results).toEqual(Array(CONCURRENCY).fill(true));
        expect(errorSpy).not.toHaveBeenCalled();

        const admin = new Pool({ connectionString: db.dsn });
        try {
          const { rows: tableRows } = await admin.query(
            `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN
             ('file_blobs','fs_files','vector_stores','vector_store_files','vector_store_chunks')`,
          );
          expect(tableRows.length).toBe(5);

          // Concurrent CREATE ROLE / ALTER ROLE for the same role name is
          // exactly the kind of check-then-act race the lock also needs to
          // cover — confirm the role ends up created exactly once (no
          // duplicate-key crash from a concurrent CREATE ROLE attempt) and
          // with a real login password ALTER ROLE actually set.
          const { rows: roleRows } = await admin.query(
            `SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = $1`, [runtimeUser],
          );
          expect(roleRows).toEqual([{ rolname: runtimeUser, rolcanlogin: true }]);
        } finally {
          await admin.end();
        }
      } finally {
        await getPool()?.end();
        __resetForTests();
        await db.drop([runtimeUser]);
      }
    });
  }
});
