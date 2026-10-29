// The W3 upgrade — page numbers on chunks, vector_store_chunks.page_start / page_end — run by the
// real runMigration() against a database in the pre-W3 shape (the current schema without the two
// columns) holding a store and a chunk:
//   - owner, single DSN: adds both in place without rewriting vector_store_chunks; the existing
//     chunk reads NULL (no pages) and keeps its text; the next boot re-applies silently;
//   - non-owner (with CREATE and without): cannot add them, so file_search reports UNAVAILABLE
//     naming them and the migrate CLI, until the owner runs the migration step;
//   - each column missing alone makes a non-owner boot unavailable and is named.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql, splitSqlStatements } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { insertChunkRows } from '../../../src/fileSearch/chunkRows';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'w3-pages-owner@example.test';
const NEW_COLUMNS = ['vector_store_chunks.page_end', 'vector_store_chunks.page_start'];
const TO_PRE_W3 = 'ALTER TABLE vector_store_chunks DROP COLUMN page_start, DROP COLUMN page_end';

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

async function seedPreW3(dsn: string): Promise<void> {
  await withPool(dsn, async (p) => {
    await p.query(buildSchemaSql(EMBED_DIM));
    await p.query(TO_PRE_W3);
    await p.query(
      `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim) VALUES ('vs_w3', $1, 'm', $2)`,
      [OWNER, EMBED_DIM]);
    await p.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
       VALUES ('vs_w3', 'file_old', 0, 'old chunk', 2, '[1,0,0]')`);
  });
}

async function columns(dsn: string): Promise<string[]> {
  return withPool(dsn, async (p) => (await p.query<{ n: string }>(
    `SELECT table_name || '.' || column_name AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name || '.' || column_name = ANY ($1::text[]) ORDER BY 1`,
    [NEW_COLUMNS])).rows.map((r) => r.n));
}

async function chunksFile(dsn: string): Promise<number> {
  return withPool(dsn, async (p) => (await p.query<{ f: number }>(
    `SELECT relfilenode::int AS f FROM pg_class WHERE relname = 'vector_store_chunks'`)).rows[0].f);
}

/** What ingestion and search do with the columns, run as whichever role `p` connects as. */
async function exerciseColumns(p: Pool): Promise<void> {
  const old = await p.query(`SELECT page_start, page_end FROM vector_store_chunks WHERE file_id = 'file_old'`);
  expect(old.rows).toEqual([{ page_start: null, page_end: null }]);
  const client = await p.connect();
  try {
    await insertChunkRows(client, 'vs_w3', 'file_old', 0, [{
      ord: 1, text: 'new chunk', tokens: 2, vector: [1, 0, 0], context: null, section: null, sectionOffset: null,
      headingPath: null, pageStart: 4, pageEnd: 5,
    }]);
  } finally {
    client.release();
  }
  const now = await p.query(`SELECT ord, page_start, page_end FROM vector_store_chunks WHERE file_id = 'file_old' ORDER BY ord`);
  expect(now.rows).toEqual([{ ord: 0, page_start: null, page_end: null }, { ord: 1, page_start: 4, page_end: 5 }]);
}

async function nonOwnerRole(db: FreshDatabase, roles: string[], withCreate: boolean): Promise<string> {
  const role = `fs_w3p_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(8).toString('hex');
  roles.push(role);
  await withPool(db.dsn, async (p) => {
    await p.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await p.query(`GRANT CONNECT ON DATABASE "${db.name}" TO "${role}"`);
    await p.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    if (withCreate) await p.query(`GRANT CREATE ON SCHEMA public TO "${role}"`);
  });
  return dsnWithCredentials(db.dsn, role, password);
}

d('W3 upgrade of a pre-W3 database: chunk page numbers (requires FILE_SEARCH_TEST_DSN)', () => {
  let db: FreshDatabase;
  const roles: string[] = [];

  beforeAll(() => {
    mockConfig = { enabled: true, embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM, limits: { maxFilesPerStore: 10000 } };
  });

  beforeEach(async () => {
    db = await createFreshDatabase(DSN!, 'fs_w3p_');
    await seedPreW3(db.dsn);
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
    for (const col of NEW_COLUMNS) {
      const [table, column] = col.split('.');
      const guarded = statements.filter((s) => s.startsWith('DO $$') && s.includes(`ADD COLUMN IF NOT EXISTS ${column} `));
      expect(guarded).toHaveLength(1);
      expect(guarded[0]).toContain(`attrelid = '${table}'::regclass`);
      expect(guarded[0]).toContain(`attname = '${column}'`);
      expect(guarded[0]).toContain(`ADD COLUMN IF NOT EXISTS ${column} int;`);
      expect(statements.filter((s) => !s.startsWith('DO $$') && s.includes(`ADD COLUMN IF NOT EXISTS ${column} `)))
        .toHaveLength(0);
    }
  });

  it('owner, single DSN: adds both without a rewrite, the old chunk reads NULL, and the next boot re-applies silently', async () => {
    const before = await chunksFile(db.dsn);
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(await columns(db.dsn)).toEqual(NEW_COLUMNS);
    expect(await chunksFile(db.dsn)).toBe(before);
    const chunk = await getPool()!.query(`SELECT text FROM vector_store_chunks WHERE file_id = 'file_old'`);
    expect(chunk.rows).toEqual([{ text: 'old chunk' }]);
    await exerciseColumns(getPool()!);

    await getPool()!.end();
    __resetForTests();
    expect(await runMigration()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  }, 60_000);

  for (const withCreate of [true, false]) {
    it(`non-owner ${withCreate ? 'with' : 'without'} CREATE: unavailable naming both columns and the migrate CLI, until the owner migrates`, async () => {
      const dsn = await nonOwnerRole(db, roles, withCreate);
      process.env.FILE_SEARCH_DATABASE_URL = dsn;
      __resetForTests();
      const warn = jest.spyOn(getDefaultLogger(), 'warn');

      expect(await runMigration()).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);
      const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
      expect(warning).toContain('UNAVAILABLE');
      for (const c of NEW_COLUMNS) expect(warning).toContain(c);
      expect(warning).toContain('cli-tools/file-search-migrate.js');
      expect(await columns(db.dsn)).toEqual([]);

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
      await exerciseColumns(getPool()!);
    }, 60_000);
  }

  for (const part of NEW_COLUMNS) {
    it(`partially migrated, missing ${part}: a non-owner boot reports unavailable and names it`, async () => {
      const [table, column] = part.split('.');
      await withPool(db.dsn, async (p) => {
        await p.query(buildSchemaSql(EMBED_DIM));
        await p.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      });
      const dsn = await nonOwnerRole(db, roles, false);
      process.env.FILE_SEARCH_DATABASE_URL = dsn;
      __resetForTests();
      const warn = jest.spyOn(getDefaultLogger(), 'warn');

      expect(await runMigration()).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);
      const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
      expect(warning).toContain('UNAVAILABLE');
      expect(warning).toContain(part);
      for (const other of NEW_COLUMNS.filter((c) => c !== part)) expect(warning).not.toContain(other);
    }, 60_000);
  }
});
