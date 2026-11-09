// The phase-4b upgrade — the usage stamp on vector_store_files (credential_id,
// auth_type, on_behalf_of) — run by the real runMigration() against a database
// in the phase-4a shape: the current schema without the three columns, holding
// attached files. Three role shapes:
//   - owner, single DSN: adds the columns in place; existing rows keep a null
//     stamp; re-application changes nothing and warns about nothing.
//   - split credentials: the privileged path adds them, and the runtime role
//     can attach a stamped file.
//   - non-owner (with CREATE and without): cannot add them, so file_search
//     reports UNAVAILABLE naming the columns and the migrate CLI — never
//     available-and-failing every attach with 42703.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { attachFile } from '../../../src/fileSearch/repository';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'p4a-owner@example.test';
const STAMP_COLUMNS = ['credential_id', 'auth_type', 'on_behalf_of'];

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

/** The phase-4a shape, seeded as the superuser (who then owns every object),
 *  with one store and two attached files. */
async function seedPhase4a(dsn: string): Promise<void> {
  await withPool(dsn, async (p) => {
    await p.query(buildSchemaSql(EMBED_DIM));
    await p.query(`ALTER TABLE vector_store_files ${STAMP_COLUMNS.map((c) => `DROP COLUMN ${c}`).join(', ')}`);
    await p.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage, ref_count)
       SELECT 'sha_' || f, 1, 'db', 1 FROM generate_series(0, 2) f`);
    await p.query(
      `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim)
       VALUES ('vs_p4a', $1, 'test-model', ${EMBED_DIM})`, [OWNER]);
    await p.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       SELECT 'file-p4a-' || f, $1, 'doc.txt', 'assistants', 'sha_' || f, 1 FROM generate_series(0, 2) f`, [OWNER]);
    await p.query(
      `INSERT INTO vector_store_files (store_id, file_id, status)
       VALUES ('vs_p4a', 'file-p4a-0', 'completed'), ('vs_p4a', 'file-p4a-1', 'in_progress')`);
  });
}

async function stampColumns(dsn: string): Promise<string[]> {
  return withPool(dsn, async (p) => {
    const { rows } = await p.query<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'vector_store_files'
          AND column_name = ANY ($1::text[]) ORDER BY 1`, [STAMP_COLUMNS]);
    return rows.map((r) => r.c);
  });
}

async function nonOwnerRole(db: FreshDatabase, roles: string[], withCreate: boolean): Promise<string> {
  const role = `fs_p4a_${crypto.randomBytes(4).toString('hex')}`;
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

d('phase-4b upgrade of a phase-4a database: the usage stamp (requires FILE_SEARCH_TEST_DSN)', () => {
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
    db = await createFreshDatabase(DSN!, 'fs_p4a_');
    await seedPhase4a(db.dsn);
    expect(await stampColumns(db.dsn)).toEqual([]);
  });

  afterEach(async () => {
    await getPool()?.end().catch(() => {});
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    jest.restoreAllMocks();
    await db.drop(roles.splice(0));
  });

  it('owner, single DSN: adds the columns, keeps existing rows unstamped, and re-applies silently', async () => {
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(await stampColumns(db.dsn)).toEqual(['auth_type', 'credential_id', 'on_behalf_of']);

    const runtime = getPool()!;
    const { rows } = await runtime.query(
      `SELECT file_id, credential_id, auth_type, on_behalf_of FROM vector_store_files ORDER BY file_id`);
    expect(rows).toEqual([
      { file_id: 'file-p4a-0', credential_id: null, auth_type: null, on_behalf_of: null },
      { file_id: 'file-p4a-1', credential_id: null, auth_type: null, on_behalf_of: null },
    ]);
    await attachFile('vs_p4a', 'file-p4a-2', null, null, null, { credentialId: 'svc', authType: 'api_key', onBehalfOf: OWNER });
    const stamped = await runtime.query(
      `SELECT credential_id, auth_type, on_behalf_of FROM vector_store_files WHERE file_id = 'file-p4a-2'`);
    expect(stamped.rows).toEqual([{ credential_id: 'svc', auth_type: 'api_key', on_behalf_of: OWNER }]);

    await runtime.end();
    __resetForTests();
    expect(await runMigration()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  }, 60_000);

  it('split credentials: the privileged path adds the columns and the runtime role attaches a stamped file', async () => {
    const runtimeRole = `fs_p4art_${crypto.randomBytes(4).toString('hex')}`;
    roles.push(runtimeRole);
    process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn;
    process.env.FILE_SEARCH_DATABASE_URL = dsnWithCredentials(db.dsn, runtimeRole, crypto.randomBytes(8).toString('hex'));
    __resetForTests();
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(await stampColumns(db.dsn)).toEqual(['auth_type', 'credential_id', 'on_behalf_of']);

    await attachFile('vs_p4a', 'file-p4a-2', null, null, null, { credentialId: 'key-9', authType: 'api_key', onBehalfOf: null });
    const { rows } = await getPool()!.query(
      `SELECT current_user AS who, credential_id, auth_type, on_behalf_of FROM vector_store_files WHERE file_id = 'file-p4a-2'`);
    expect(rows).toEqual([{ who: runtimeRole, credential_id: 'key-9', auth_type: 'api_key', on_behalf_of: null }]);
  }, 60_000);

  for (const withCreate of [true, false]) {
    it(`non-owner ${withCreate ? 'with' : 'without'} CREATE: reports unavailable naming the columns and the migrate CLI`, async () => {
      process.env.FILE_SEARCH_DATABASE_URL = await nonOwnerRole(db, roles, withCreate);
      __resetForTests();
      const warn = jest.spyOn(getDefaultLogger(), 'warn');
      const error = jest.spyOn(getDefaultLogger(), 'error');

      expect(await runMigration()).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);
      expect(error).not.toHaveBeenCalled();
      const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
      expect(warning).toContain('UNAVAILABLE');
      for (const c of STAMP_COLUMNS) expect(warning).toContain(`vector_store_files.${c}`);
      expect(warning).toContain('cli-tools/file-search-migrate.js');
      expect(await stampColumns(db.dsn)).toEqual([]);
    }, 60_000);
  }
});
