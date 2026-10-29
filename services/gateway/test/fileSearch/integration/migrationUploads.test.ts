// The G12 upgrade for the Uploads API — the fs_uploads and fs_upload_parts tables — run by the real
// runMigration() against a database in the shape before them (the current schema without the two
// tables) holding a file:
//   - the schema creates both in one DO block that only a role owning fs_files runs, and db.ts
//     requires both;
//   - owner, single DSN: creates them, the existing file is untouched, and the next boot re-applies
//     silently (idempotent);
//   - non-owner, even one with CREATE on the schema: creates nothing (so it can never own them), and
//     file_search reports UNAVAILABLE naming them until the owner runs the migration step.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql, splitSqlStatements } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'g12-uploads-owner@example.test';
const TABLES = ['fs_upload_parts', 'fs_uploads'];

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

async function seedBefore(dsn: string): Promise<void> {
  await withPool(dsn, async (p) => {
    await p.query(buildSchemaSql(EMBED_DIM));
    await p.query('DROP TABLE fs_upload_parts');
    await p.query('DROP TABLE fs_uploads');
    await p.query(`INSERT INTO file_blobs (sha256, size_bytes, ref_count, storage, bytes) VALUES ('sha', 1, 1, 'db', '\\x00')`);
    await p.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ('file_g12', $1, 'old.pdf', 'assistants', 'sha', 1, now())`, [OWNER]);
  });
}

async function tables(dsn: string): Promise<string[]> {
  return withPool(dsn, async (p) => (await p.query<{ n: string }>(
    `SELECT n FROM unnest($1::text[]) AS n WHERE to_regclass(n) IS NOT NULL ORDER BY 1`, [TABLES])).rows.map((r) => r.n));
}

d('G12 upgrade of a database before the Uploads API (requires FILE_SEARCH_TEST_DSN)', () => {
  let db: FreshDatabase;
  const roles: string[] = [];

  beforeAll(() => {
    mockConfig = { enabled: true, embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM, limits: { maxFilesPerStore: 10000 } };
  });

  beforeEach(async () => {
    db = await createFreshDatabase(DSN!, 'fs_g12_');
    await seedBefore(db.dsn);
    expect(await tables(db.dsn)).toEqual([]);
  });

  afterEach(async () => {
    await getPool()?.end().catch(() => {});
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    jest.restoreAllMocks();
    await db.drop(roles.splice(0));
  });

  it('the schema creates both tables once, in a DO block guarded by fs_files ownership', () => {
    const statements = splitSqlStatements(buildSchemaSql(EMBED_DIM));
    for (const table of TABLES) {
      const creates = statements.filter((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${table} (`));
      expect(creates).toHaveLength(1);
      expect(creates[0].startsWith('DO $$')).toBe(true);
      expect(creates[0]).toContain("pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'fs_files'::regclass), 'USAGE')");
    }
  });

  it('owner, single DSN: creates both tables, leaves the file alone, and the next boot re-applies silently', async () => {
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(await tables(db.dsn)).toEqual(TABLES);
    const pool = getPool()!;
    expect((await pool.query('SELECT id FROM fs_files')).rows).toEqual([{ id: 'file_g12' }]);
    // The tables work as the code uses them, and a part goes with its upload.
    await pool.query(`INSERT INTO fs_uploads (id, owner_email, filename, purpose, mime_type, bytes, expires_at)
                      VALUES ('upload_g12', $1, 'a.txt', 'assistants', 'text/plain', 1, now() + interval '1 hour')`, [OWNER]);
    await pool.query(`INSERT INTO fs_upload_parts (id, upload_id, size_bytes, data) VALUES ('part_g12', 'upload_g12', 1, '\\x61')`);
    await expect(pool.query(`UPDATE fs_uploads SET status = 'unknown'`)).rejects.toThrow(/check constraint/);
    await pool.query(`DELETE FROM fs_uploads`);
    expect((await pool.query('SELECT count(*)::int AS n FROM fs_upload_parts')).rows[0].n).toBe(0);

    await pool.end();
    __resetForTests();
    expect(await runMigration()).toBe(true);
    await getPool()!.end();
    __resetForTests();
    expect(await runMigration()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  }, 60_000);

  it('non-owner, even with CREATE on the schema: creates nothing and is unavailable naming the tables, until the owner migrates', async () => {
    const role = `fs_g12_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(8).toString('hex');
    roles.push(role);
    await withPool(db.dsn, async (p) => {
      await p.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await p.query(`GRANT CONNECT ON DATABASE "${db.name}" TO "${role}"`);
      await p.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${role}"`);
      await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    });
    const dsn = dsnWithCredentials(db.dsn, role, password);
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');

    expect(await runMigration()).toBe(false);
    expect(isFileSearchAvailable()).toBe(false);
    expect(await tables(db.dsn)).toEqual([]);
    const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
    expect(warning).toContain('UNAVAILABLE');
    for (const table of TABLES) expect(warning).toContain(table);

    await getPool()?.end().catch(() => {});
    process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn;
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    await getPool()?.end().catch(() => {});
    // The owner's tables, readable by the runtime role it grants.
    await withPool(db.dsn, async (p) => {
      await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON fs_uploads, fs_upload_parts TO "${role}"`);
    });
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
  }, 60_000);
});
