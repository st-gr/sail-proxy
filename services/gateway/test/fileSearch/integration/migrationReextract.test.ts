// The W3 upgrade for re-extraction — vector_store_files.extraction_version and ocr_pending,
// fs_jobs.reextract, fs_reembed_items.extraction_version and ocr_pending — run by the real runMigration() against a database in the
// shape before them (the current schema without the five columns) holding a store, a file and a
// job item:
//   - the schema declares each once, behind a catalog guard, nullable without a default;
//   - owner, single DSN: adds the five in place without rewriting the tables; the existing rows
//     read NULL (a file read before the version existed; a job that is no re-extract); the next
//     boot re-applies silently;
//   - non-owner without CREATE: cannot add them, so file_search reports UNAVAILABLE naming them,
//     until the owner runs the migration step.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql, splitSqlStatements } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'w3-reextract-owner@example.test';
const NEW_COLUMNS = [
  { table: 'fs_jobs', column: 'reextract', type: 'boolean' },
  { table: 'fs_reembed_items', column: 'extraction_version', type: 'int' },
  { table: 'fs_reembed_items', column: 'ocr_pending', type: 'boolean' },
  { table: 'vector_store_files', column: 'extraction_version', type: 'int' },
  { table: 'vector_store_files', column: 'ocr_pending', type: 'boolean' },
];
const NAMES = NEW_COLUMNS.map((c) => `${c.table}.${c.column}`);
const TABLES = ['vector_store_files', 'fs_jobs', 'fs_reembed_items'];

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
    for (const c of NEW_COLUMNS) {
      // eslint-disable-next-line no-await-in-loop
      await p.query(`ALTER TABLE ${c.table} DROP COLUMN ${c.column}`);
    }
    await p.query(
      `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim) VALUES ('vs_rx', $1, 'm', $2)`,
      [OWNER, EMBED_DIM]);
    await p.query(`INSERT INTO file_blobs (sha256, size_bytes, ref_count, storage, bytes) VALUES ('sha', 1, 1, 'db', '\\x00')`);
    await p.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ('file_rx', $1, 'old.pdf', 'assistants', 'sha', 1, now())`, [OWNER]);
    await p.query(`INSERT INTO vector_store_files (store_id, file_id, status) VALUES ('vs_rx', 'file_rx', 'completed')`);
    await p.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, store_id, target_model, target_dim, target_generation, finished_at)
       VALUES ('job_rx', 'reembed_store', $1, 'vs_rx', 'm', $2, 1, now())`, [OWNER, EMBED_DIM]);
    await p.query(`INSERT INTO fs_reembed_items (job_id, store_id, file_id, status) VALUES ('job_rx', 'vs_rx', 'file_rx', 'completed')`);
  });
}

async function columns(dsn: string): Promise<string[]> {
  return withPool(dsn, async (p) => (await p.query<{ n: string }>(
    `SELECT table_name || '.' || column_name AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name || '.' || column_name = ANY ($1::text[]) ORDER BY 1`,
    [NAMES])).rows.map((r) => r.n));
}

async function fileNodes(dsn: string): Promise<number[]> {
  return withPool(dsn, async (p) => (await p.query<{ f: number }>(
    `SELECT relfilenode::int AS f FROM pg_class WHERE relname = ANY ($1::text[]) ORDER BY relname`, [TABLES])).rows.map((r) => r.f));
}

d('W3 upgrade of a database before re-extraction (requires FILE_SEARCH_TEST_DSN)', () => {
  let db: FreshDatabase;
  const roles: string[] = [];

  beforeAll(() => {
    mockConfig = { enabled: true, embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM, limits: { maxFilesPerStore: 10000 } };
  });

  beforeEach(async () => {
    db = await createFreshDatabase(DSN!, 'fs_w3rx_');
    await seedBefore(db.dsn);
    expect(await columns(db.dsn)).toEqual([]);
  });

  afterEach(async () => {
    await getPool()?.end().catch(() => {});
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    jest.restoreAllMocks();
    await db.drop(roles.splice(0));
  });

  it('the schema declares each column once, behind a catalog guard, nullable without a default', () => {
    const statements = splitSqlStatements(buildSchemaSql(EMBED_DIM));
    for (const { table, column, type } of NEW_COLUMNS) {
      const adds = statements.filter((s) => s.includes(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} `));
      expect(adds).toHaveLength(1);
      expect(adds[0].startsWith('DO $$')).toBe(true);
      expect(adds[0]).toContain(`attrelid = '${table}'::regclass`);
      expect(adds[0]).toContain(`attname = '${column}'`);
      expect(adds[0]).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type};`);
    }
  });

  it('owner, single DSN: adds the five without a rewrite, old rows read NULL, and the next boot re-applies silently', async () => {
    const before = await fileNodes(db.dsn);
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(await columns(db.dsn)).toEqual(NAMES);
    expect(await fileNodes(db.dsn)).toEqual(before);
    const pool = getPool()!;
    expect((await pool.query('SELECT extraction_version, ocr_pending FROM vector_store_files')).rows)
      .toEqual([{ extraction_version: null, ocr_pending: null }]);
    expect((await pool.query('SELECT reextract FROM fs_jobs')).rows).toEqual([{ reextract: null }]);
    expect((await pool.query('SELECT extraction_version, ocr_pending FROM fs_reembed_items')).rows)
      .toEqual([{ extraction_version: null, ocr_pending: null }]);

    await pool.end();
    __resetForTests();
    expect(await runMigration()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  }, 60_000);

  it('non-owner without CREATE: unavailable naming the five columns, until the owner migrates', async () => {
    const role = `fs_w3rx_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(8).toString('hex');
    roles.push(role);
    await withPool(db.dsn, async (p) => {
      await p.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await p.query(`GRANT CONNECT ON DATABASE "${db.name}" TO "${role}"`);
      await p.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    });
    const dsn = dsnWithCredentials(db.dsn, role, password);
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');

    expect(await runMigration()).toBe(false);
    expect(isFileSearchAvailable()).toBe(false);
    const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
    expect(warning).toContain('UNAVAILABLE');
    for (const name of NAMES) expect(warning).toContain(name);

    await getPool()?.end().catch(() => {});
    process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn;
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    await getPool()?.end().catch(() => {});
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
  }, 60_000);
});
