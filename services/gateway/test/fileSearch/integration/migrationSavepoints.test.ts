// Live coverage for the non-owner re-application shape: an install whose
// file_search schema was created by one role, and whose gateway connects as a
// DIFFERENT role that holds CREATE on the schema but owns none of the existing
// tables.
//
// Why this shape strands schema additions, and why it needs a real database to
// prove: `CREATE INDEX IF NOT EXISTS` performs its OWNERSHIP check BEFORE the
// "already exists, skipping" check (verified on 16.14; `CREATE TABLE IF NOT
// EXISTS` has no such requirement). So `idx_fs_files_owner` — the fourth
// statement buildSchemaSql() emits — is rejected with 42501 on every boot of a
// perfectly healthy install. Applied as ONE multi-statement query, that single
// rejection aborts the whole thing, and every table declared after it is never
// created. A table added to the schema today therefore never reaches this
// install, while runMigration() reports success at `info`.
//
// The fix is a savepoint per statement: the rejected index rolls back alone and
// the statements after it still apply. These tests pin both halves of that —
// the new table lands, AND a first-ever migration that cannot complete still
// fails closed rather than committing a half-built schema.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { buildSchemaSql } from '../../../src/fileSearch/schema.sql';
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

/**
 * Builds the "already migrated, by someone else" starting state: the full
 * schema applied as the owning (superuser) role, minus the named tables,
 * standing in for an install that migrated before those tables were added to
 * buildSchemaSql(). Both omissions used below are real additions — the
 * reranker pair came with teacher logging, `vector_store_batches` with file
 * batches — and they behave differently on a non-owner install, which is why
 * each gets its own test.
 */
async function seedSchemaOwnedByAnotherRole(ownerDsn: string, omitTables: string[]): Promise<void> {
  const owner = new Pool({ connectionString: ownerDsn });
  try {
    await owner.query(buildSchemaSql(EMBED_DIM));
    for (const table of omitTables) {
      // eslint-disable-next-line no-await-in-loop
      await owner.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  } finally {
    await owner.end();
  }
}

/** A CREATE-capable role that owns none of the objects seeded above. */
async function createNonOwnerRole(ownerDsn: string, dbName: string): Promise<{
  user: string; password: string; dsn: string;
}> {
  const user = `fs_nonowner_${crypto.randomBytes(5).toString('hex')}`;
  const password = crypto.randomBytes(12).toString('hex');
  const owner = new Pool({ connectionString: ownerDsn });
  try {
    await owner.query(`CREATE ROLE "${user}" LOGIN PASSWORD '${password}'`);
    await owner.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${user}"`);
    // CREATE on the schema, but deliberately NO ownership of what is already
    // there and no membership in the owning role — that combination is the
    // whole point of the fixture.
    await owner.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${user}"`);
  } finally {
    await owner.end();
  }
  return { user, password, dsn: dsnWithCredentials(ownerDsn, user, password) };
}

async function tableExists(dsn: string, table: string): Promise<boolean> {
  const p = new Pool({ connectionString: dsn });
  try {
    const { rows } = await p.query('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
    return rows[0].present;
  } finally {
    await p.end();
  }
}

d('migration savepoints / non-owner re-application (requires FILE_SEARCH_TEST_DSN)', () => {
  beforeAll(() => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
    };
  });

  beforeEach(() => {
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
  });

  afterEach(() => {
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
  });

  it('creates tables added after the install migrated, even though an earlier statement is rejected for ownership', async () => {
    // The reranker tables are the real instance of this: the teacher-logging
    // work added them long after the retrieval core shipped, and they are
    // self-contained — reranker_search_events has no foreign key at all, and
    // reranker_candidate_labels references only the table created beside it,
    // which this role therefore owns.
    const db = await createFreshDatabase(DSN!, 'fs_sp_test_');
    let role: { user: string; password: string; dsn: string } | null = null;
    try {
      await seedSchemaOwnedByAnotherRole(db.dsn, ['reranker_candidate_labels', 'reranker_search_events']);
      expect(await tableExists(db.dsn, 'reranker_search_events')).toBe(false);
      role = await createNonOwnerRole(db.dsn, db.name);

      process.env.FILE_SEARCH_DATABASE_URL = role.dsn;
      __resetForTests();
      const ok = await runMigration();

      // The install stays available throughout — this is a healthy shape, not
      // an outage, and reporting otherwise was never the defect here.
      expect(ok).toBe(true);
      // The defect: before savepoints, the 42501 on idx_fs_files_owner aborted
      // the whole multi-statement query and neither table was ever created.
      expect(await tableExists(db.dsn, 'reranker_search_events')).toBe(true);
      expect(await tableExists(db.dsn, 'reranker_candidate_labels')).toBe(true);
    } finally {
      await db.drop(role ? [role.user] : []);
    }
  }, 60_000);

  it('does NOT rescue an addition whose foreign key targets a table this role does not own', async () => {
    // Savepoints unblock statements, not privileges. `vector_store_batches`
    // REFERENCES vector_stores, and creating that foreign key needs REFERENCES
    // on a table seeded by the other role — so this addition stays blocked and
    // is reported, not silently skipped. Pinning it here stops the next reader
    // concluding that per-statement application makes every addition reachable
    // on a non-owner install; it does not, and the deploy step is still the
    // answer for this shape.
    const db = await createFreshDatabase(DSN!, 'fs_sp_test_');
    let role: { user: string; password: string; dsn: string } | null = null;
    try {
      await seedSchemaOwnedByAnotherRole(db.dsn, ['vector_store_batches']);
      role = await createNonOwnerRole(db.dsn, db.name);

      process.env.FILE_SEARCH_DATABASE_URL = role.dsn;
      __resetForTests();
      const warn = jest.spyOn(getDefaultLogger(), 'warn');
      const ok = await runMigration();

      expect(ok).toBe(true);
      expect(await tableExists(db.dsn, 'vector_store_batches')).toBe(false);
      // And it is NOT reported at info: a table the probe can see is missing
      // gets the loud warning naming it and the deploy step that fixes it.
      expect(warn).toHaveBeenCalledWith(
        'FileSearchDb',
        expect.stringContaining('vector_store_batches'),
      );
    } finally {
      await db.drop(role ? [role.user] : []);
    }
  }, 60_000);

  it('leaves NOTHING behind when a first-ever migration cannot complete', async () => {
    // The counterweight to the test above: committing the statements that DID
    // succeed is correct when re-applying over a working install, and wrong on
    // a first migration — a half-built schema would let the NEXT boot take the
    // "already present" path and report available-with-warnings, converting a
    // loud failure into a quiet partial one.
    const db = await createFreshDatabase(DSN!, 'fs_sp_test_');
    let role: { user: string; password: string; dsn: string } | null = null;
    try {
      role = await createNonOwnerRole(db.dsn, db.name);
      // Nothing is seeded, so this is a first migration; revoking CREATE on the
      // extension's behalf is not needed — a non-superuser cannot CREATE
      // EXTENSION vector, so the very first statement fails and everything
      // after it depends on the type it would have installed.
      process.env.FILE_SEARCH_DATABASE_URL = role.dsn;
      __resetForTests();
      const ok = await runMigration();

      expect(ok).toBe(false);
      // No partial schema: the next boot must retry as a first migration.
      expect(await tableExists(db.dsn, 'file_blobs')).toBe(false);
      expect(await tableExists(db.dsn, 'fs_files')).toBe(false);
    } finally {
      await db.drop(role ? [role.user] : []);
    }
  }, 60_000);
});
