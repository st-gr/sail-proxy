// The phase-4a upgrade — chunk generations — run by the real runMigration()
// against a populated database in the exact phase-3 shape (phase3Schema.ts,
// frozen from db0d2b27): 50,000 chunks under the old primary key (store_id,
// file_id, ord), no generation columns, no fs_reembed_items.
//
// Each role shape gets its own copy of one populated template database:
//   - owner, single DSN: upgrades in place; the key swap is timed; a second
//     run is an idempotent no-op that does not wait behind a running search.
//   - split credentials (FILE_SEARCH_MIGRATION_DATABASE_URL): upgrades, and the
//     runtime role can use the new table and write a second generation.
//   - non-owner with CREATE, and without: cannot add the columns, so
//     file_search reports UNAVAILABLE with a warning naming the migrate CLI —
//     never available-and-failing every search with 42703. Running the
//     migration step as the owner then brings the same install back.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql, splitSqlStatements } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { recallCandidates } from '../../../src/fileSearch/repository';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnForDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';
import { phase3SchemaSql } from './phase3Schema';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const STORES = 10;
const FILES_PER_STORE = 10;
const CHUNKS_PER_FILE = 500;
const TOTAL_CHUNKS = STORES * FILES_PER_STORE * CHUNKS_PER_FILE; // 50,000
const OWNER = 'p3-owner@example.test';

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

async function populatePhase3(dsn: string): Promise<void> {
  await withPool(dsn, async (p) => {
    await p.query(phase3SchemaSql(EMBED_DIM));
    // Loaded with the HNSW index dropped and rebuilt afterwards (same
    // definition as phase 3): the end state is identical, the load faster.
    await p.query('DROP INDEX idx_chunks_hnsw');
    const files = STORES * FILES_PER_STORE;
    await p.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage, ref_count)
       SELECT 'sha_' || f, 1, 'db', 1 FROM generate_series(0, $1 - 1) f`, [files]);
    await p.query(
      `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim)
       SELECT 'vs_p3_' || s, $2, 'test-model', ${EMBED_DIM} FROM generate_series(0, $1 - 1) s`, [STORES, OWNER]);
    await p.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       SELECT 'file-p3-' || f, $2, 'doc.txt', 'assistants', 'sha_' || f, 1 FROM generate_series(0, $1 - 1) f`,
      [files, OWNER]);
    await p.query(
      `INSERT INTO vector_store_files (store_id, file_id, status)
       SELECT 'vs_p3_' || (f / $2), 'file-p3-' || f, 'completed' FROM generate_series(0, $1 - 1) f`,
      [files, FILES_PER_STORE]);
    await p.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
       SELECT 'vs_p3_' || (f / $2), 'file-p3-' || f, o, 'lighthouse log ' || f || ' entry ' || o, 5,
              ('[' || random() || ',' || random() || ',' || random() || ']')::vector
         FROM generate_series(0, $1 - 1) f, generate_series(0, $3 - 1) o`,
      [files, FILES_PER_STORE, CHUNKS_PER_FILE]);
    await p.query('CREATE INDEX idx_chunks_hnsw ON vector_store_chunks USING hnsw (embedding vector_cosine_ops)');
    await p.query(
      `INSERT INTO vector_store_batches (id, store_id, created_at) VALUES ('vsfb_p3', 'vs_p3_0', now())`);
    await p.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, started_by, store_id, batch_id, finished_at)
       VALUES ('job_p3', 'file_batch', $1, $1, 'vs_p3_0', 'vsfb_p3', now())`, [OWNER]);
    await p.query('ANALYZE');
  });
}

interface Shape {
  chunkKey: string[];
  columns: string[];
  chunkCount: number;
  generations: number[];
  reembedItems: boolean;
}

async function inspect(dsn: string): Promise<Shape> {
  return withPool(dsn, async (p) => {
    const { rows: key } = await p.query<{ attname: string }>(
      `SELECT a.attname FROM pg_constraint con
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, n) ON true
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE con.conrelid = 'vector_store_chunks'::regclass AND con.contype = 'p' ORDER BY k.n`);
    const { rows: cols } = await p.query<{ c: string }>(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name, column_name) IN (('vector_store_chunks', 'generation'), ('vector_stores', 'active_generation'),
               ('fs_jobs', 'cancel_requested'), ('fs_jobs', 'target_model'), ('fs_jobs', 'target_dim'),
               ('fs_jobs', 'target_generation'))
        ORDER BY 1`);
    const { rows: count } = await p.query('SELECT count(*)::int AS n FROM vector_store_chunks');
    const hasGeneration = cols.some((c) => c.c === 'vector_store_chunks.generation');
    const generations = hasGeneration
      ? (await p.query('SELECT DISTINCT generation FROM vector_store_chunks ORDER BY 1')).rows.map((r) => r.generation)
      : [];
    const { rows: items } = await p.query("SELECT to_regclass('fs_reembed_items') IS NOT NULL AS ok");
    return {
      chunkKey: key.map((k) => k.attname),
      columns: cols.map((c) => c.c),
      chunkCount: count[0].n,
      generations,
      reembedItems: items[0].ok,
    };
  });
}

const UPGRADED_COLUMNS = [
  'fs_jobs.cancel_requested', 'fs_jobs.target_dim', 'fs_jobs.target_generation', 'fs_jobs.target_model',
  'vector_store_chunks.generation', 'vector_stores.active_generation',
];

/** Times one call. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

d('phase-4a upgrade of a populated phase-3 database (requires FILE_SEARCH_TEST_DSN)', () => {
  let template: FreshDatabase;
  const copies: Array<{ name: string; roles: string[] }> = [];

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
      hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 },
    };
    template = await createFreshDatabase(DSN!, 'fs_p3tpl_');
    await populatePhase3(template.dsn);
    const before = await inspect(template.dsn);
    // The starting point really is phase 3: old key, none of the new parts.
    expect(before).toEqual({
      chunkKey: ['store_id', 'file_id', 'ord'], columns: [], chunkCount: TOTAL_CHUNKS, generations: [],
      reembedItems: false,
    });
  }, 300_000);

  afterAll(async () => {
    await withPool(DSN!, async (p) => {
      for (const c of copies) {
        // eslint-disable-next-line no-await-in-loop
        await p.query(`DROP DATABASE IF EXISTS "${c.name}" WITH (FORCE)`);
        for (const r of c.roles) {
          // eslint-disable-next-line no-await-in-loop
          await p.query(`DROP ROLE IF EXISTS "${r}"`);
        }
      }
    });
    await template.drop();
  }, 120_000);

  afterEach(async () => {
    await getPool()?.end().catch(() => {});
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    jest.restoreAllMocks();
  });

  /** A copy of the populated template; its DSN connects as the superuser that owns every object. */
  async function copyOfTemplate(): Promise<{ name: string; dsn: string; roles: string[] }> {
    const name = `fs_p3copy_${crypto.randomBytes(6).toString('hex')}`;
    await withPool(DSN!, (p) => p.query(`CREATE DATABASE "${name}" TEMPLATE "${template.name}"`));
    const entry = { name, roles: [] as string[] };
    copies.push(entry);
    return { name, dsn: dsnForDatabase(DSN!, name), roles: entry.roles };
  }

  /** A login role with DML on every existing table, and CREATE on the schema when asked. */
  async function nonOwnerRole(copy: { name: string; dsn: string; roles: string[] }, withCreate: boolean): Promise<string> {
    const role = `fs_p3_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(8).toString('hex');
    copy.roles.push(role);
    await withPool(copy.dsn, async (p) => {
      await p.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await p.query(`GRANT CONNECT ON DATABASE "${copy.name}" TO "${role}"`);
      await p.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
      if (withCreate) await p.query(`GRANT CREATE ON SCHEMA public TO "${role}"`);
    });
    return dsnWithCredentials(copy.dsn, role, password);
  }

  it('owner, single DSN: swaps the key in place, keeps every chunk, and re-applies idempotently', async () => {
    const copy = await copyOfTemplate();
    process.env.FILE_SEARCH_DATABASE_URL = copy.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    const upgrade = await timed(() => runMigration());
    expect(upgrade.value).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(await inspect(copy.dsn)).toEqual({
      chunkKey: ['store_id', 'file_id', 'generation', 'ord'], columns: UPGRADED_COLUMNS,
      chunkCount: TOTAL_CHUNKS, generations: [0], reembedItems: true,
    });

    // The pre-existing data answers through the new generation-scoped recall.
    const hits = await recallCandidates({
      storeIds: ['vs_p3_3'], ownerEmail: OWNER, queryText: 'lighthouse', queryEmbedding: [0.5, 0.5, 0.5],
    });
    expect(hits).toHaveLength(50);
    expect(hits.every((h) => h.storeId === 'vs_p3_3')).toBe(true);

    // Re-application (every boot) takes no ACCESS EXCLUSIVE lock on the chunk
    // table: it completes while a search holds the table open.
    const reader = new Pool({ connectionString: copy.dsn, max: 1 });
    const readerClient = await reader.connect();
    let reapply: { value: boolean; ms: number };
    try {
      await readerClient.query('BEGIN');
      await readerClient.query('SELECT count(*) FROM vector_store_chunks WHERE store_id = $1', ['vs_p3_0']);
      __resetForTests();
      let timer: NodeJS.Timeout | undefined;
      reapply = await Promise.race([
        timed(() => runMigration()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('re-application waited behind a reader')), 20_000);
        }),
      ]);
      clearTimeout(timer);
    } finally {
      await readerClient.query('ROLLBACK').catch(() => {});
      readerClient.release();
      await reader.end();
    }
    expect(reapply.value).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect((await inspect(copy.dsn)).chunkKey).toEqual(['store_id', 'file_id', 'generation', 'ord']);

    // eslint-disable-next-line no-console
    console.log(`[phase-4a upgrade] owner single-DSN: upgrade of ${TOTAL_CHUNKS} chunks took ${upgrade.ms.toFixed(0)} ms; `
      + `idempotent re-application took ${reapply.ms.toFixed(0)} ms`);
  }, 180_000);

  it('measures the primary-key swap alone on 50,000 chunks', async () => {
    // The swap is the one statement that holds ACCESS EXCLUSIVE on the chunk
    // table for longer than a catalog update; it is timed on its own here.
    const copy = await copyOfTemplate();
    const statements = splitSqlStatements(buildSchemaSql(EMBED_DIM));
    const addColumn = statements.find((s) => s.startsWith('DO $$') && s.includes('ADD COLUMN IF NOT EXISTS generation'));
    const swap = statements.find((s) => s.startsWith('DO $$') && s.includes('ADD PRIMARY KEY'));
    expect(addColumn).toBeDefined();
    expect(swap).toBeDefined();
    const result = await withPool(copy.dsn, async (p) => {
      const column = await timed(() => p.query(addColumn!));
      const key = await timed(() => p.query(swap!));
      const again = await timed(() => p.query(swap!));
      return { column: column.ms, key: key.ms, again: again.ms };
    });
    expect((await inspect(copy.dsn)).chunkKey).toEqual(['store_id', 'file_id', 'generation', 'ord']);
    // eslint-disable-next-line no-console
    console.log(`[phase-4a upgrade] ${TOTAL_CHUNKS} chunks: add generation column ${result.column.toFixed(0)} ms, `
      + `primary-key swap ${result.key.toFixed(0)} ms, swap re-run (no-op) ${result.again.toFixed(0)} ms`);
  }, 180_000);

  it('split credentials: the privileged path upgrades, and the runtime role can use the new schema', async () => {
    const copy = await copyOfTemplate();
    const runtimeRole = `fs_p3rt_${crypto.randomBytes(4).toString('hex')}`;
    copy.roles.push(runtimeRole);
    process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = copy.dsn;
    process.env.FILE_SEARCH_DATABASE_URL = dsnWithCredentials(copy.dsn, runtimeRole, crypto.randomBytes(8).toString('hex'));
    __resetForTests();
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(await inspect(copy.dsn)).toEqual({
      chunkKey: ['store_id', 'file_id', 'generation', 'ord'], columns: UPGRADED_COLUMNS,
      chunkCount: TOTAL_CHUNKS, generations: [0], reembedItems: true,
    });

    // As the runtime role: a second generation of an existing chunk is
    // accepted by the new key, and the new table carries its grants.
    const runtime = getPool()!;
    await runtime.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, embedding)
       VALUES ('vs_p3_0', 'file-p3-0', 1, 0, 'next generation', '[1,0,0]')`);
    await runtime.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, store_id, target_model, target_dim, target_generation)
       VALUES ('job_re', 'reembed_store', $1, 'vs_p3_0', 'next-model', ${EMBED_DIM}, 1)`, [OWNER]);
    await runtime.query(
      `INSERT INTO fs_reembed_items (job_id, store_id, file_id) VALUES ('job_re', 'vs_p3_0', 'file-p3-0')`);
    // At most one unfinished re-embed per store.
    await expect(runtime.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, store_id) VALUES ('job_re2', 'reembed_store', $1, 'vs_p3_0')`,
      [OWNER])).rejects.toMatchObject({ code: '23505' });

    // Idempotent on the privileged path too.
    await runtime.end();
    __resetForTests();
    expect(await runMigration()).toBe(true);
    expect(error).not.toHaveBeenCalled();
  }, 180_000);

  // A partially migrated install: the current schema, minus ONE required part
  // — the shape an interrupted or partially committed upgrade leaves behind —
  // booted by a non-owner that cannot repair it. Every required part, checked
  // one at a time, must make file_search unavailable and be named.
  const PARTIAL: Array<{ part: string; breakSql: string; named: string }> = [
    ...[
      ['vector_stores', 'active_generation'], ['vector_store_chunks', 'generation'],
      ['fs_jobs', 'cancel_requested'], ['fs_jobs', 'target_model'], ['fs_jobs', 'target_dim'],
      ['fs_jobs', 'target_generation'], ['vector_store_files', 'credential_id'],
      ['vector_store_files', 'auth_type'], ['vector_store_files', 'on_behalf_of'],
    ].map(([t, c]) => ({ part: `${t}.${c}`, breakSql: `ALTER TABLE ${t} DROP COLUMN ${c} CASCADE`, named: `${t}.${c}` })),
    {
      part: 'the generation primary key (old key restored)',
      breakSql: `ALTER TABLE vector_store_chunks DROP CONSTRAINT vector_store_chunks_pkey;
                 ALTER TABLE vector_store_chunks ADD PRIMARY KEY (store_id, file_id, ord)`,
      named: 'vector_store_chunks primary key',
    },
    { part: 'fs_reembed_items', breakSql: 'DROP TABLE fs_reembed_items', named: 'fs_reembed_items' },
    {
      part: 'the one-running-re-embed-per-store index',
      breakSql: 'DROP INDEX idx_fs_jobs_reembed_running',
      named: 'idx_fs_jobs_reembed_running',
    },
  ];
  for (const { part, breakSql, named } of PARTIAL) {
    it(`partially migrated, missing ${part}: a non-owner boot reports unavailable and names it`, async () => {
      const db = await createFreshDatabase(DSN!, 'fs_p4part_');
      const role = `fs_p4part_${crypto.randomBytes(4).toString('hex')}`;
      const password = crypto.randomBytes(8).toString('hex');
      try {
        await withPool(db.dsn, async (p) => {
          await p.query(buildSchemaSql(EMBED_DIM));
          await p.query(breakSql);
          await p.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
          await p.query(`GRANT CONNECT ON DATABASE "${db.name}" TO "${role}"`);
          await p.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${role}"`);
          await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
        });
        process.env.FILE_SEARCH_DATABASE_URL = dsnWithCredentials(db.dsn, role, password);
        __resetForTests();
        const warn = jest.spyOn(getDefaultLogger(), 'warn');

        expect(await runMigration()).toBe(false);
        expect(isFileSearchAvailable()).toBe(false);
        const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
        expect(warning).toContain('UNAVAILABLE');
        expect(warning).toContain(named);
        expect(warning).toContain('cli-tools/file-search-migrate.js');
      } finally {
        await getPool()?.end().catch(() => {});
        __resetForTests();
        await db.drop([role]);
      }
    }, 60_000);
  }

  for (const withCreate of [true, false]) {
    it(`non-owner ${withCreate ? 'with' : 'without'} CREATE: reports unavailable naming the migrate CLI, until the owner migrates`, async () => {
      const copy = await copyOfTemplate();
      process.env.FILE_SEARCH_DATABASE_URL = await nonOwnerRole(copy, withCreate);
      __resetForTests();
      const warn = jest.spyOn(getDefaultLogger(), 'warn');
      const error = jest.spyOn(getDefaultLogger(), 'error');

      expect(await runMigration()).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);
      expect(error).not.toHaveBeenCalled();
      const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
      expect(warning).toContain('UNAVAILABLE');
      expect(warning).toContain('vector_store_chunks.generation');
      expect(warning).toContain('vector_stores.active_generation');
      expect(warning).toContain('fs_reembed_items');
      expect(warning).toContain('cli-tools/file-search-migrate.js');
      // The phase-3 install is untouched: nothing half-applied.
      expect(await inspect(copy.dsn)).toEqual({
        chunkKey: ['store_id', 'file_id', 'ord'], columns: [], chunkCount: TOTAL_CHUNKS, generations: [],
        reembedItems: false,
      });

      // A re-run says the same, every boot.
      await getPool()?.end().catch(() => {});
      __resetForTests();
      expect(await runMigration()).toBe(false);

      // The fix the warning names: the migration step as the owner. After it,
      // the same non-owner install boots available.
      const runtimeDsn = process.env.FILE_SEARCH_DATABASE_URL!;
      process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = copy.dsn;
      process.env.FILE_SEARCH_DATABASE_URL = copy.dsn;
      __resetForTests();
      expect(await runMigration()).toBe(true);
      delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
      process.env.FILE_SEARCH_DATABASE_URL = runtimeDsn;
      __resetForTests();
      // fs_reembed_items was created by the owner after the role's grants;
      // the operator's grant step covers it like any other table.
      await withPool(copy.dsn, (p) => p.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${copy.roles[0]}"`));
      expect(await runMigration()).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);
    }, 180_000);
  }
});
