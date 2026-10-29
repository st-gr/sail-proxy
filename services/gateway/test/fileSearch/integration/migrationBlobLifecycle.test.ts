// The phase-5 upgrade — blob lifecycle and blob migration — run by the real
// runMigration() against a database in the phase-4b shape: the current schema
// without file_blobs.delete_after, fs_jobs.target_storage, file_blob_garbage,
// fs_blob_migration_items and their indexes, holding stored blobs and a job.
// Three role shapes:
//   - owner, single DSN: adds every part in place; existing blobs stay live
//     (delete_after null); the next boot re-applies without warning and without
//     waiting behind open readers of file_blobs and fs_jobs.
//   - split credentials: the privileged path adds them, and the runtime role
//     can use the new columns and tables.
//   - non-owner (with CREATE and without): cannot add them, so file_search
//     reports UNAVAILABLE naming them and the migrate CLI, until the owner runs
//     the migration step.
// Plus the probe: each new required part missing alone makes a non-owner boot
// unavailable and is named.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql, splitSqlStatements } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'p5-owner@example.test';
const NEW_COLUMNS = ['file_blobs.delete_after', 'fs_jobs.target_storage'];
const NEW_TABLES = ['file_blob_garbage', 'fs_blob_migration_items'];
const NEW_INDEXES = [
  'idx_blob_migration_items_claim',
  'idx_file_blob_garbage_due',
  'idx_file_blob_garbage_sha',
  'idx_file_blobs_delete_after',
  'idx_fs_jobs_blob_migration_running',
];
const RUNNING_INDEX = 'idx_fs_jobs_blob_migration_running';

/** Undoes the phase-5 additions on a database built from the current schema. */
const TO_PHASE_4B = `
  DROP TABLE fs_blob_migration_items;
  DROP TABLE file_blob_garbage;
  DROP INDEX idx_fs_jobs_blob_migration_running;
  ALTER TABLE file_blobs DROP COLUMN delete_after;
  ALTER TABLE fs_jobs DROP COLUMN target_storage;
`;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

async function withPool<T>(dsn: string, fn: (p: Pool) => Promise<T>): Promise<T> {
  const p = new Pool({ connectionString: dsn, max: 2 });
  try {
    return await fn(p);
  } finally {
    await p.end();
  }
}

/** The phase-4b shape, seeded as the superuser (who then owns every object),
 *  with two stored blobs, a file and a finished re-embed job. */
async function seedPhase4b(dsn: string): Promise<void> {
  await withPool(dsn, async (p) => {
    await p.query(buildSchemaSql(EMBED_DIM));
    await p.query(TO_PHASE_4B);
    await p.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage, bytes, ref_count)
       VALUES ('sha_0', 1, 'db', '\\x41', 1), ('sha_1', 1, 'db', '\\x42', 0)`);
    await p.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ('file-p5-0', $1, 'doc.txt', 'assistants', 'sha_0', 1)`, [OWNER]);
    await p.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, finished_at) VALUES ('job_old', 'reembed_bulk', $1, now())`, [OWNER]);
  });
}

/** Which of the phase-5 parts exist. */
async function inspect(dsn: string): Promise<{ columns: string[]; tables: string[]; indexes: string[] }> {
  return withPool(dsn, async (p) => {
    const columns = await p.query<{ n: string }>(
      `SELECT table_name || '.' || column_name AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name || '.' || column_name = ANY ($1::text[]) ORDER BY 1`,
      [NEW_COLUMNS]);
    const tables = await p.query<{ n: string }>(
      'SELECT n FROM unnest($1::text[]) AS n WHERE to_regclass(n) IS NOT NULL ORDER BY 1', [NEW_TABLES]);
    const indexes = await p.query<{ n: string }>(
      'SELECT n FROM unnest($1::text[]) AS n WHERE to_regclass(n) IS NOT NULL ORDER BY 1', [NEW_INDEXES]);
    return { columns: columns.rows.map((r) => r.n), tables: tables.rows.map((r) => r.n), indexes: indexes.rows.map((r) => r.n) };
  });
}

const UPGRADED = { columns: NEW_COLUMNS, tables: NEW_TABLES, indexes: NEW_INDEXES };
const NOT_UPGRADED = { columns: [], tables: [], indexes: [] };

/** What Tasks 3–5 will do with the new parts, run as whichever role `p` connects as. */
async function exerciseNewSchema(p: Pool): Promise<void> {
  // A released blob: pending delete, still readable.
  await p.query(`UPDATE file_blobs SET delete_after = now() + interval '15 minutes' WHERE sha256 = 'sha_1'`);
  const pending = await p.query(
    `SELECT sha256 FROM file_blobs WHERE delete_after IS NOT NULL AND delete_after > now() - interval '1 day'`);
  expect(pending.rows).toEqual([{ sha256: 'sha_1' }]);

  // A garbage entry is keyed on the object it names; re-enqueueing the same key merges.
  for (let i = 0; i < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await p.query(
      `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after) VALUES ('s3', 'pre/sha_1', 'sha_1', now())
       ON CONFLICT (storage, location) DO UPDATE SET delete_after = EXCLUDED.delete_after`);
  }
  const garbage = await p.query(
    `SELECT storage, location, sha256, attempts, last_error, enqueued_at IS NOT NULL AS stamped FROM file_blob_garbage`);
  expect(garbage.rows).toEqual([
    { storage: 's3', location: 'pre/sha_1', sha256: 'sha_1', attempts: 0, last_error: null, stamped: true },
  ]);

  // A migration job pins its target; its items default to in_progress.
  await p.query(
    `INSERT INTO fs_jobs (id, kind, started_by, target_storage) VALUES ('job_mig', 'blob_migration', $1, 's3')`, [OWNER]);
  await p.query(
    `INSERT INTO fs_blob_migration_items (job_id, sha256, source_storage)
     SELECT 'job_mig', sha256, storage FROM file_blobs WHERE delete_after IS NULL`);
  const items = await p.query(
    `SELECT sha256, source_storage, status, attempts, claimed_at, last_error
       FROM fs_blob_migration_items ORDER BY sha256`);
  expect(items.rows).toEqual([{
    sha256: 'sha_0', source_storage: 'db', status: 'in_progress', attempts: 0,
    claimed_at: null, last_error: null,
  }]);
  await expect(p.query(
    `UPDATE fs_blob_migration_items SET status = 'bogus' WHERE job_id = 'job_mig'`)).rejects.toMatchObject({ code: '23514' });

  // At most one unfinished blob migration; a finished one does not count.
  await expect(p.query(
    `INSERT INTO fs_jobs (id, kind, target_storage) VALUES ('job_mig2', 'blob_migration', 'db')`))
    .rejects.toMatchObject({ code: '23505' });
  await p.query(`UPDATE fs_jobs SET finished_at = now() WHERE id = 'job_mig'`);
  await p.query(`INSERT INTO fs_jobs (id, kind, target_storage) VALUES ('job_mig2', 'blob_migration', 'db')`);

  // Items go with their job.
  await p.query(`DELETE FROM fs_jobs WHERE id = 'job_mig'`);
  expect((await p.query(`SELECT 1 FROM fs_blob_migration_items`)).rowCount).toBe(0);
}

async function nonOwnerRole(db: FreshDatabase, roles: string[], withCreate: boolean): Promise<{ role: string; dsn: string }> {
  const role = `fs_p5_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(8).toString('hex');
  roles.push(role);
  await withPool(db.dsn, async (p) => {
    await p.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await p.query(`GRANT CONNECT ON DATABASE "${db.name}" TO "${role}"`);
    await p.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    if (withCreate) await p.query(`GRANT CREATE ON SCHEMA public TO "${role}"`);
  });
  return { role, dsn: dsnWithCredentials(db.dsn, role, password) };
}

d('phase-5 upgrade of a phase-4b database: blob lifecycle and migration (requires FILE_SEARCH_TEST_DSN)', () => {
  let db: FreshDatabase;
  const roles: string[] = [];

  beforeAll(() => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
    };
  });

  beforeEach(async () => {
    db = await createFreshDatabase(DSN!, 'fs_p5_');
    await seedPhase4b(db.dsn);
    expect(await inspect(db.dsn)).toEqual(NOT_UPGRADED);
  });

  afterEach(async () => {
    await getPool()?.end().catch(() => {});
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    jest.restoreAllMocks();
    await db.drop(roles.splice(0));
  });

  it('the schema declares every phase-5 part once, the column additions behind a catalog guard', () => {
    const statements = splitSqlStatements(buildSchemaSql(EMBED_DIM));
    for (const name of [...NEW_TABLES.map((t) => `CREATE TABLE IF NOT EXISTS ${t} `), ...NEW_INDEXES.map((i) => ` ${i} `)]) {
      expect(statements.filter((s) => s.includes(name))).toHaveLength(1);
    }
    for (const col of NEW_COLUMNS) {
      const [table, column] = col.split('.');
      const guarded = statements.filter((s) => s.startsWith('DO $$') && s.includes(`ADD COLUMN IF NOT EXISTS ${column} `));
      expect(guarded).toHaveLength(1);
      expect(guarded[0]).toContain(`attrelid = '${table}'::regclass`);
      expect(guarded[0]).toContain(`attname = '${column}'`);
    }
    // The garbage table and its indexes sit behind the file_blobs ownership check.
    const garbage = statements.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS file_blob_garbage '));
    expect(garbage[0]).toMatch(/^DO \$\$/);
    expect(garbage[0]).toContain(`pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'file_blobs'::regclass), 'USAGE')`);
    expect(garbage[0]).toContain('idx_file_blob_garbage_due');
    expect(garbage[0]).toContain('idx_file_blob_garbage_sha');
  });

  it('owner, single DSN: adds every part, keeps existing blobs live, and re-applies silently without waiting behind readers', async () => {
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(await inspect(db.dsn)).toEqual(UPGRADED);

    const runtime = getPool()!;
    const { rows } = await runtime.query(
      `SELECT sha256, storage, delete_after FROM file_blobs ORDER BY sha256`);
    expect(rows).toEqual([
      { sha256: 'sha_0', storage: 'db', delete_after: null },
      { sha256: 'sha_1', storage: 'db', delete_after: null },
    ]);
    const job = await runtime.query(`SELECT target_storage FROM fs_jobs WHERE id = 'job_old'`);
    expect(job.rows).toEqual([{ target_storage: null }]);
    await exerciseNewSchema(runtime);
    await runtime.end();

    // The next boot: the guards make the column additions read-only, so an open
    // reader of either altered table does not hold the re-application up.
    const reader = new Pool({ connectionString: db.dsn, max: 1 });
    const readerClient = await reader.connect();
    try {
      await readerClient.query('BEGIN');
      await readerClient.query('SELECT count(*) FROM file_blobs');
      await readerClient.query('SELECT count(*) FROM fs_jobs');
      __resetForTests();
      let timer: NodeJS.Timeout | undefined;
      const reapplied = await Promise.race([
        runMigration(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('re-application waited behind a reader')), 20_000);
        }),
      ]);
      clearTimeout(timer);
      expect(reapplied).toBe(true);
    } finally {
      await readerClient.query('ROLLBACK').catch(() => {});
      readerClient.release();
      await reader.end();
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  }, 60_000);

  it('split credentials: the privileged path adds every part and the runtime role can use them', async () => {
    const runtimeRole = `fs_p5rt_${crypto.randomBytes(4).toString('hex')}`;
    roles.push(runtimeRole);
    process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn;
    process.env.FILE_SEARCH_DATABASE_URL = dsnWithCredentials(db.dsn, runtimeRole, crypto.randomBytes(8).toString('hex'));
    __resetForTests();
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(await inspect(db.dsn)).toEqual(UPGRADED);

    const who = await getPool()!.query('SELECT current_user AS who');
    expect(who.rows).toEqual([{ who: runtimeRole }]);
    await exerciseNewSchema(getPool()!);
  }, 60_000);

  for (const withCreate of [true, false]) {
    it(`non-owner ${withCreate ? 'with' : 'without'} CREATE: reports unavailable naming the parts and the migrate CLI, until the owner migrates`, async () => {
      const { role, dsn } = await nonOwnerRole(db, roles, withCreate);
      process.env.FILE_SEARCH_DATABASE_URL = dsn;
      __resetForTests();
      const warn = jest.spyOn(getDefaultLogger(), 'warn');
      const error = jest.spyOn(getDefaultLogger(), 'error');

      expect(await runMigration()).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);
      expect(error).not.toHaveBeenCalled();
      const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
      expect(warning).toContain('UNAVAILABLE');
      for (const c of NEW_COLUMNS) expect(warning).toContain(c);
      // fs_blob_migration_items needs REFERENCES on fs_jobs, which a DML-only
      // role lacks; the running index needs ownership of fs_jobs.
      expect(warning).toContain('fs_blob_migration_items');
      expect(warning).toContain(RUNNING_INDEX);
      expect(warning).toContain('cli-tools/file-search-migrate.js');
      // Nothing changed — not even the garbage table, which references nothing
      // and which a role with CREATE could otherwise have created (and owned).
      expect(await inspect(db.dsn)).toEqual(NOT_UPGRADED);

      // The fix the warning names: the migration step as the owner. After it,
      // the same non-owner install boots available.
      await getPool()?.end().catch(() => {});
      process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn;
      process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
      __resetForTests();
      expect(await runMigration()).toBe(true);
      delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
      process.env.FILE_SEARCH_DATABASE_URL = dsn;
      __resetForTests();
      // Tables the owner created after the role's grants are covered by the
      // operator's grant step like any other.
      await withPool(db.dsn, (p) => p.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`));
      expect(await runMigration()).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);
      expect(await inspect(db.dsn)).toEqual(UPGRADED);
      await exerciseNewSchema(getPool()!);
    }, 60_000);
  }

  // The owner is an ordinary role here, not the superuser: a superuser passes
  // every ownership check, so only a plain owner shows whether a non-owner boot
  // left behind an object the owner's migration step then cannot touch.
  it('non-owner with CREATE, then a non-superuser owner migrates: succeeds and owns the garbage table', async () => {
    const owner = `fs_p5own_${crypto.randomBytes(4).toString('hex')}`;
    const ownerPassword = crypto.randomBytes(8).toString('hex');
    roles.push(owner);
    const ownerDb = await createFreshDatabase(DSN!, 'fs_p5own_');
    try {
      await withPool(ownerDb.dsn, async (p) => {
        await p.query('CREATE EXTENSION IF NOT EXISTS vector');
        await p.query(`CREATE ROLE "${owner}" LOGIN PASSWORD '${ownerPassword}'`);
        await p.query(`GRANT CONNECT ON DATABASE "${ownerDb.name}" TO "${owner}"`);
        await p.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${owner}"`);
      });
      const ownerDsn = dsnWithCredentials(ownerDb.dsn, owner, ownerPassword);
      await seedPhase4b(ownerDsn);
      expect(await inspect(ownerDb.dsn)).toEqual(NOT_UPGRADED);

      const runtime = `fs_p5rt_${crypto.randomBytes(4).toString('hex')}`;
      const runtimePassword = crypto.randomBytes(8).toString('hex');
      roles.push(runtime);
      await withPool(ownerDb.dsn, async (p) => {
        await p.query(`CREATE ROLE "${runtime}" LOGIN PASSWORD '${runtimePassword}'`);
        await p.query(`GRANT CONNECT ON DATABASE "${ownerDb.name}" TO "${runtime}"`);
        await p.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${runtime}"`);
      });
      await withPool(ownerDsn, (p) => p.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtime}"`));
      const runtimeDsn = dsnWithCredentials(ownerDb.dsn, runtime, runtimePassword);

      // The non-owner boots first: unavailable, and it creates nothing.
      process.env.FILE_SEARCH_DATABASE_URL = runtimeDsn;
      __resetForTests();
      jest.spyOn(getDefaultLogger(), 'warn');
      expect(await runMigration()).toBe(false);
      expect(await inspect(ownerDb.dsn)).toEqual(NOT_UPGRADED);
      await getPool()?.end().catch(() => {});

      // The owner's migration step (the privileged path, fatal on any rejected statement).
      process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = ownerDsn;
      process.env.FILE_SEARCH_DATABASE_URL = ownerDsn;
      __resetForTests();
      const error = jest.spyOn(getDefaultLogger(), 'error');
      expect(await runMigration()).toBe(true);
      expect(error).not.toHaveBeenCalled();
      expect(await inspect(ownerDb.dsn)).toEqual(UPGRADED);
      const owners = await withPool(ownerDb.dsn, (p) => p.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
          WHERE c.relname = ANY ($1::text[]) ORDER BY 1`,
        [['file_blob_garbage', 'idx_file_blob_garbage_due', 'idx_file_blob_garbage_sha']]));
      expect(owners.rows).toEqual([
        { relname: 'file_blob_garbage', owner },
        { relname: 'idx_file_blob_garbage_due', owner },
        { relname: 'idx_file_blob_garbage_sha', owner },
      ]);
      await getPool()?.end().catch(() => {});

      // After the grant step, the non-owner boots available.
      delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
      process.env.FILE_SEARCH_DATABASE_URL = runtimeDsn;
      __resetForTests();
      await withPool(ownerDsn, (p) => p.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtime}"`));
      expect(await runMigration()).toBe(true);
      await exerciseNewSchema(getPool()!);
    } finally {
      await getPool()?.end().catch(() => {});
      __resetForTests();
      await ownerDb.drop();
    }
  }, 60_000);

  // A partially migrated install: the current schema minus ONE phase-5 part,
  // booted by a non-owner (with or without CREATE it never creates the garbage
  // table: the ownership guard leaves that to the owner). Each part alone must
  // make file_search unavailable and be named.
  const PARTIAL: Array<{ part: string; breakSql: string }> = [
    { part: 'file_blobs.delete_after', breakSql: 'ALTER TABLE file_blobs DROP COLUMN delete_after' },
    { part: 'fs_jobs.target_storage', breakSql: 'ALTER TABLE fs_jobs DROP COLUMN target_storage' },
    { part: 'file_blob_garbage', breakSql: 'DROP TABLE file_blob_garbage' },
    { part: 'fs_blob_migration_items', breakSql: 'DROP TABLE fs_blob_migration_items' },
    { part: RUNNING_INDEX, breakSql: `DROP INDEX ${RUNNING_INDEX}` },
  ];
  for (const { part, breakSql } of PARTIAL) {
    it(`partially migrated, missing ${part}: a non-owner boot reports unavailable and names it`, async () => {
      await withPool(db.dsn, async (p) => {
        await p.query(buildSchemaSql(EMBED_DIM));
        await p.query(breakSql);
      });
      const { dsn } = await nonOwnerRole(db, roles, false);
      process.env.FILE_SEARCH_DATABASE_URL = dsn;
      __resetForTests();
      const warn = jest.spyOn(getDefaultLogger(), 'warn');

      expect(await runMigration()).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);
      const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
      expect(warning).toContain('UNAVAILABLE');
      expect(warning).toContain(part);
      expect(warning).toContain('cli-tools/file-search-migrate.js');
    }, 60_000);
  }

  it('the running-migration index must be unique: a plain index of that name does not satisfy the probe', async () => {
    await withPool(db.dsn, async (p) => {
      await p.query(buildSchemaSql(EMBED_DIM));
      await p.query(`DROP INDEX ${RUNNING_INDEX}`);
      await p.query(`CREATE INDEX ${RUNNING_INDEX} ON fs_jobs (kind) WHERE kind = 'blob_migration' AND finished_at IS NULL`);
    });
    const { dsn } = await nonOwnerRole(db, roles, false);
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');

    expect(await runMigration()).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[1])).join('\n')).toContain(RUNNING_INDEX);
  }, 60_000);
});
