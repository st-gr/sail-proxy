// The W3 upgrade — the page counters fs_jobs.ocr_pages / ocr_skipped_pages (OCR) and
// vision_pages / vision_skipped_pages (vision transcription) — run by the real runMigration()
// against a database in the pre-W3 shape (the current schema without the four columns) holding a
// finished job:
//   - owner, single DSN: adds them in place without rewriting fs_jobs; the existing job reads 0;
//     the next boot re-applies silently;
//   - non-owner (with CREATE and without): cannot add them, so file_search reports UNAVAILABLE
//     naming them and the migrate CLI, until the owner runs the migration step;
//   - each column missing alone makes a non-owner boot unavailable and is named.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql, splitSqlStatements } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { addJobOcrTotals, addOcrTotals } from '../../../src/fileSearch/jobs';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'w3-owner@example.test';
const COUNTERS = ['ocr_pages', 'ocr_skipped_pages', 'vision_pages', 'vision_skipped_pages'];
const NEW_COLUMNS = COUNTERS.map((c) => `fs_jobs.${c}`).sort();
const TO_PRE_W3 = `ALTER TABLE fs_jobs ${COUNTERS.map((c) => `DROP COLUMN ${c}`).join(', ')}`;

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
      `INSERT INTO fs_jobs (id, kind, owner_email, store_id, batch_id, embedding_tokens, finished_at)
       VALUES ('job_old', 'file_batch', $1, 'vs_w3', 'vsfb_old', 7, now())`, [OWNER]);
  });
}

async function columns(dsn: string): Promise<string[]> {
  return withPool(dsn, async (p) => (await p.query<{ n: string }>(
    `SELECT table_name || '.' || column_name AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name || '.' || column_name = ANY ($1::text[]) ORDER BY 1`,
    [NEW_COLUMNS])).rows.map((r) => r.n));
}

async function fsJobsFile(dsn: string): Promise<number> {
  return withPool(dsn, async (p) => (await p.query<{ f: number }>(
    `SELECT relfilenode::int AS f FROM pg_class WHERE relname = 'fs_jobs'`)).rows[0].f);
}

/** What the workers do with the counters, run as whichever role `p` connects as. */
async function exerciseCounters(p: Pool): Promise<void> {
  const read = `SELECT ${COUNTERS.join(', ')} FROM fs_jobs WHERE id = 'job_old'`;
  const old = await p.query(read);
  expect(old.rows).toEqual([{ ocr_pages: '0', ocr_skipped_pages: '0', vision_pages: '0', vision_skipped_pages: '0' }]);
  await addOcrTotals(p, 'vsfb_old', { ocrPages: 3, skippedPages: 1 });
  await addJobOcrTotals(p, 'job_old', { ocrPages: 2, skippedPages: 0, visionPages: 4, visionSkippedPages: 1 });
  // Vision counts alone are written too (a text PDF whose table pages were transcribed).
  await addOcrTotals(p, 'vsfb_old', { ocrPages: 0, skippedPages: 0, visionPages: 2, visionSkippedPages: 0 });
  // A file without scanned or transcribed pages writes nothing.
  await addOcrTotals(p, 'vsfb_old', { ocrPages: 0, skippedPages: 0 });
  const now = await p.query(read);
  expect(now.rows).toEqual([{ ocr_pages: '5', ocr_skipped_pages: '1', vision_pages: '6', vision_skipped_pages: '1' }]);
  for (const counter of COUNTERS) {
    // eslint-disable-next-line no-await-in-loop
    await expect(p.query(`UPDATE fs_jobs SET ${counter} = NULL WHERE id = 'job_old'`)).rejects.toMatchObject({ code: '23502' });
  }
}

async function nonOwnerRole(db: FreshDatabase, roles: string[], withCreate: boolean): Promise<string> {
  const role = `fs_w3_${crypto.randomBytes(4).toString('hex')}`;
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

d('W3 upgrade of a pre-W3 database: OCR and vision page counters (requires FILE_SEARCH_TEST_DSN)', () => {
  let db: FreshDatabase;
  const roles: string[] = [];

  beforeAll(() => {
    mockConfig = { enabled: true, embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM, limits: { maxFilesPerStore: 10000 } };
  });

  beforeEach(async () => {
    db = await createFreshDatabase(DSN!, 'fs_w3_');
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

  it('the schema declares each counter once, behind a catalog guard', () => {
    const statements = splitSqlStatements(buildSchemaSql(EMBED_DIM));
    for (const col of NEW_COLUMNS) {
      const [table, column] = col.split('.');
      const guarded = statements.filter((s) => s.startsWith('DO $$') && s.includes(`ADD COLUMN IF NOT EXISTS ${column} `));
      expect(guarded).toHaveLength(1);
      expect(guarded[0]).toContain(`attrelid = '${table}'::regclass`);
      expect(guarded[0]).toContain(`attname = '${column}'`);
      expect(guarded[0]).toContain(`ADD COLUMN IF NOT EXISTS ${column} bigint NOT NULL DEFAULT 0;`);
      expect(statements.filter((s) => !s.startsWith('DO $$') && s.includes(`ADD COLUMN IF NOT EXISTS ${column} `)))
        .toHaveLength(0);
    }
  });

  it('owner, single DSN: adds all four without a rewrite, the old job reads 0, and the next boot re-applies silently', async () => {
    const before = await fsJobsFile(db.dsn);
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(await columns(db.dsn)).toEqual(NEW_COLUMNS);
    expect(await fsJobsFile(db.dsn)).toBe(before);
    const job = await getPool()!.query(`SELECT embedding_tokens FROM fs_jobs WHERE id = 'job_old'`);
    expect(job.rows).toEqual([{ embedding_tokens: '7' }]);
    await exerciseCounters(getPool()!);

    await getPool()!.end();
    __resetForTests();
    expect(await runMigration()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  }, 60_000);

  for (const withCreate of [true, false]) {
    it(`non-owner ${withCreate ? 'with' : 'without'} CREATE: unavailable naming every column and the migrate CLI, until the owner migrates`, async () => {
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
      await exerciseCounters(getPool()!);
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
