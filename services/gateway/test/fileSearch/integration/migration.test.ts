import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql } from '../../../src/fileSearch/schema.sql';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { createFreshDatabase, dsnWithCredentials } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

// Only used by the grant-coverage describe block below (runMigration() calls
// getFileSearchConfig() internally); the schema-application tests above go
// through buildSchemaSql()/createIsolatedSchema() directly and never touch
// configService, so this mock does not affect them.
let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

d('migration (requires FILE_SEARCH_TEST_DSN pointing at pgvector)', () => {
  let fixture: IsolatedSchema;
  beforeAll(async () => { fixture = await createIsolatedSchema(DSN!, 1536); });
  afterAll(async () => { await fixture.teardown(); });

  it('applies cleanly and is idempotent when run twice', async () => {
    // createIsolatedSchema already applied buildSchemaSql once while setting up
    // the fixture; this second application (into the same, now-populated
    // schema) is what proves idempotency — it must not throw.
    await fixture.pool.query(buildSchemaSql(1536));
    const EXPECTED_TABLES = [
      'file_blobs', 'fs_files', 'vector_stores', 'vector_store_files',
      'vector_store_batches', 'vector_store_chunks',
    ];
    const { rows } = await fixture.pool.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename = ANY($2)',
      [fixture.schema, EXPECTED_TABLES],
    );
    // Compared as a SORTED LIST, not as a count. `expect(rows.length).toBe(N)`
    // reports "expected 6, received 5" and leaves you to work out WHICH table
    // is missing; this names it. That matters because the failure mode this
    // test exists to catch is a new table being added to buildSchemaSql and
    // silently dropped from the second application -- and the person reading
    // the failure is, by definition, the person who does not yet know which
    // table it was.
    expect(rows.map((r) => r.tablename).sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it('creates the generated tsvector column', async () => {
    const { rows } = await fixture.pool.query(
      `SELECT is_generated FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='vector_store_chunks' AND column_name='tsv'`,
      [fixture.schema],
    );
    expect(rows[0].is_generated).toBe('ALWAYS');
  });
});

it('rejects an implausible embedding dimension', () => {
  expect(() => buildSchemaSql(0)).toThrow(/Invalid embedding dimension/);
});

d('teacher-logging tables grant coverage (requires FILE_SEARCH_TEST_DSN)', () => {
  beforeAll(() => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: 3,
      limits: { maxFilesPerStore: 10000 },
    };
  });

  afterEach(async () => {
    await getPool()?.end().catch(() => {});
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
  });

  // Regression coverage for the failure mode called out in the task brief:
  // a table added outside buildSchemaSql() would let runMigration() report
  // success and isFileSearchAvailable() report healthy while every write to
  // that table dies with "permission denied" — a per-request failure hidden
  // behind a healthy status. Runs runMigration() for real (split migration/
  // runtime credentials) against a fresh database, then confirms the actual
  // runtime role's INSERT privilege via Postgres's own catalog function
  // rather than re-deriving the expectation from application source.
  it('grants the runtime role DML on the new teacher-logging tables', async () => {
    const db = await createFreshDatabase(DSN!, 'fs_teacher_logging_test_');
    const runtimeUser = `fs_runtime_tl_${crypto.randomBytes(4).toString('hex')}`;
    const runtimePassword = crypto.randomBytes(8).toString('hex');
    const runtimeDsn = dsnWithCredentials(db.dsn, runtimeUser, runtimePassword);

    try {
      process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn; // superuser: DDL rights
      process.env.FILE_SEARCH_DATABASE_URL = runtimeDsn;        // the role being provisioned
      __resetForTests();

      const ok = await runMigration();
      expect(ok).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);

      const admin = new Pool({ connectionString: db.dsn });
      try {
        for (const t of ['reranker_search_events', 'reranker_candidate_labels']) {
          const { rows } = await admin.query(
            `SELECT has_table_privilege($1, $2, 'INSERT') AS ok`, [runtimeUser, t]);
          expect(rows[0].ok).toBe(true);
        }
      } finally {
        await admin.end();
      }
    } finally {
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await db.drop([runtimeUser]);
    }
  });
});
