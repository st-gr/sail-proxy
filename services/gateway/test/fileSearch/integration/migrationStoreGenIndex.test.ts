// The upgrade that adds idx_chunks_store_gen (plan 2026-10-07, B1 Task 2,
// Decision 4) on a populated database: the current schema minus that one index,
// 50,000 chunks.
//
// The index is created by the boot schema (CREATE INDEX IF NOT EXISTS, inside the
// one advisory-locked schema transaction), not by the migrate CLI as a concurrent
// build, if its build lock is short. Measured here:
//   - the statement alone: its build time, and what its SHARE lock does — reads
//     go on, writes to the chunks wait until the transaction ends;
//   - the whole runMigration() upgrade, and the idempotent re-application on the
//     next boot while a search holds the table open;
//   - a non-owner install (CREATE on the schema, not the table owner) cannot
//     build it, stays available without a warning — the index is a performance
//     index, not part of db.ts's required schema — and the sweep still works.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { buildSchemaSql, splitSqlStatements } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { dropOrphanedGenerations } from '../../../src/fileSearch/jobSweeper';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnForDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const STORES = 100;
const FILES_PER_STORE = 10;
const CHUNKS_PER_FILE = 50;
const TOTAL_CHUNKS = STORES * FILES_PER_STORE * CHUNKS_PER_FILE; // 50,000
const OWNER = 'sg-owner@example.test';
const INDEX_DDL = 'CREATE INDEX IF NOT EXISTS idx_chunks_store_gen ON vector_store_chunks (store_id, generation)';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

async function withPool<T>(dsn: string, fn: (p: Pool) => Promise<T>): Promise<T> {
  const p = new Pool({ connectionString: dsn, max: 4 }); // the lock test holds three clients and polls with a fourth
  try {
    return await fn(p);
  } finally {
    await p.end();
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

/** Whether the index exists, and whether it is valid. */
async function indexState(dsn: string): Promise<{ present: boolean; valid: boolean }> {
  return withPool(dsn, async (p) => {
    const { rows } = await p.query(
      `SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass('idx_chunks_store_gen')`);
    return { present: rows.length === 1, valid: rows[0]?.indisvalid ?? false };
  });
}

d('idx_chunks_store_gen upgrade on a populated database (requires FILE_SEARCH_TEST_DSN)', () => {
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
    // The schema as shipped, the new index statement present in it once.
    const statements = splitSqlStatements(buildSchemaSql(EMBED_DIM));
    expect(statements.filter((s) => s === INDEX_DDL)).toHaveLength(1);

    template = await createFreshDatabase(DSN!, 'fs_sgtpl_');
    await withPool(template.dsn, async (p) => {
      await p.query(buildSchemaSql(EMBED_DIM));
      // The schema before this change; the HNSW index is rebuilt after the load
      // (same definition), which only makes the load faster.
      await p.query('DROP INDEX idx_chunks_store_gen');
      await p.query('DROP INDEX idx_chunks_hnsw');
      const files = STORES * FILES_PER_STORE;
      await p.query(`INSERT INTO file_blobs (sha256, size_bytes, storage, ref_count) VALUES ('sha_sg', 1, 'db', $1)`, [files]);
      await p.query(
        `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim)
         SELECT 'vs_sg_' || s, $2, 'test-model', ${EMBED_DIM} FROM generate_series(0, $1 - 1) s`, [STORES, OWNER]);
      await p.query(
        `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
         SELECT 'file-sg-' || f, $2, 'doc.txt', 'assistants', 'sha_sg', 1 FROM generate_series(0, $1 - 1) f`,
        [files, OWNER]);
      await p.query(
        `INSERT INTO vector_store_files (store_id, file_id, status)
         SELECT 'vs_sg_' || (f / $2), 'file-sg-' || f, 'completed' FROM generate_series(0, $1 - 1) f`,
        [files, FILES_PER_STORE]);
      await p.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
         SELECT 'vs_sg_' || (f / $2), 'file-sg-' || f, o, 'lighthouse log ' || f || ' entry ' || o, 5,
                ('[' || random() || ',' || random() || ',' || random() || ']')::vector
           FROM generate_series(0, $1 - 1) f, generate_series(0, $3 - 1) o`,
        [files, FILES_PER_STORE, CHUNKS_PER_FILE]);
      // One stray generation the sweep must find (a failed re-embed's, its job swept).
      await p.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding)
         SELECT store_id, file_id, 1, ord, text, tokens, embedding FROM vector_store_chunks WHERE store_id = 'vs_sg_7'`);
      const client = await p.connect();
      try {
        // Serial, in backend memory: a parallel build needs /dev/shm, which Docker caps at 64 MB.
        await client.query('SET max_parallel_maintenance_workers = 0');
        await client.query(`SET maintenance_work_mem = '256MB'`);
        await client.query('CREATE INDEX idx_chunks_hnsw ON vector_store_chunks USING hnsw (embedding vector_cosine_ops)');
      } finally {
        client.release();
      }
      await p.query('VACUUM ANALYZE');
    });
    expect(await indexState(template.dsn)).toEqual({ present: false, valid: false });
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
    jest.restoreAllMocks();
  });

  async function copyOfTemplate(): Promise<{ name: string; dsn: string; roles: string[] }> {
    const name = `fs_sgcopy_${crypto.randomBytes(6).toString('hex')}`;
    await withPool(DSN!, (p) => p.query(`CREATE DATABASE "${name}" TEMPLATE "${template.name}"`));
    const entry = { name, roles: [] as string[] };
    copies.push(entry);
    return { name, dsn: dsnForDatabase(DSN!, name), roles: entry.roles };
  }

  it('the build: reads go on, writes to the chunks wait until the transaction ends', async () => {
    const copy = await copyOfTemplate();
    const result = await withPool(copy.dsn, async (p) => {
      const builder = await p.connect();
      const reader = await p.connect();
      const writer = await p.connect();
      try {
        await builder.query('BEGIN');
        const build = await timed(() => builder.query(INDEX_DDL));
        // The build's SHARE lock is held until the schema transaction ends.
        const read = await timed(() => reader.query(
          `SELECT count(*)::int AS n FROM vector_store_chunks WHERE store_id = 'vs_sg_3'`));
        expect(read.value.rows[0].n).toBe(FILES_PER_STORE * CHUNKS_PER_FILE);
        await writer.query('BEGIN');
        const write = timed(() => writer.query(
          `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, embedding)
           VALUES ('vs_sg_3', 'file-sg-30', 9, 0, 'new', '[1,0,0]')`));
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const { rows } = await p.query(
            `SELECT 1 FROM pg_locks l WHERE l.relation = 'vector_store_chunks'::regclass AND NOT l.granted
               AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
          waiting = rows.length > 0;
          // eslint-disable-next-line no-await-in-loop
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await builder.query('ROLLBACK');
        const written = await write;
        await writer.query('ROLLBACK');
        return { build: build.ms, read: read.ms, writeWait: written.ms };
      } finally {
        builder.release();
        reader.release();
        writer.release();
      }
    });
    // eslint-disable-next-line no-console
    console.log(`[idx_chunks_store_gen] ${TOTAL_CHUNKS} chunks: build ${result.build.toFixed(0)} ms; a read during `
      + `the open transaction ${result.read.toFixed(1)} ms; a write waited ${result.writeWait.toFixed(0)} ms (until rollback)`);
  }, 120_000);

  it('owner, single DSN: the boot upgrade builds it, and the next boot re-applies without waiting behind a search', async () => {
    const copy = await copyOfTemplate();
    process.env.FILE_SEARCH_DATABASE_URL = copy.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    const upgrade = await timed(() => runMigration());
    expect(upgrade.value).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(await indexState(copy.dsn)).toEqual({ present: true, valid: true });

    // Re-application: CREATE INDEX IF NOT EXISTS still takes its SHARE lock, which
    // a search's ACCESS SHARE does not block.
    await getPool()?.end().catch(() => {});
    const reader = new Pool({ connectionString: copy.dsn, max: 1 });
    const readerClient = await reader.connect();
    let reapply: { value: boolean; ms: number };
    try {
      await readerClient.query('BEGIN');
      await readerClient.query(`SELECT count(*) FROM vector_store_chunks WHERE store_id = 'vs_sg_0'`);
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
    expect(await indexState(copy.dsn)).toEqual({ present: true, valid: true });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    // The sweep finds the stray generation through the new index.
    expect(await dropOrphanedGenerations()).toBe(FILES_PER_STORE * CHUNKS_PER_FILE);
    // eslint-disable-next-line no-console
    console.log(`[idx_chunks_store_gen] ${TOTAL_CHUNKS} chunks: boot upgrade (runMigration) ${upgrade.ms.toFixed(0)} ms; `
      + `idempotent re-application ${reapply.ms.toFixed(0)} ms`);
  }, 180_000);

  it('non-owner with CREATE: cannot build it, stays available without a warning, and the sweep still works', async () => {
    const copy = await copyOfTemplate();
    const role = `fs_sg_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(8).toString('hex');
    copy.roles.push(role);
    // The template is the current schema with only the index missing.
    await withPool(copy.dsn, async (p) => {
      await p.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await p.query(`GRANT CONNECT ON DATABASE "${copy.name}" TO "${role}"`);
      await p.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${role}"`);
      await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    });
    process.env.FILE_SEARCH_DATABASE_URL = dsnWithCredentials(copy.dsn, role, password);
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(await indexState(copy.dsn)).toEqual({ present: false, valid: false });
    // Without the index the sweep is slower, not wrong.
    expect(await dropOrphanedGenerations()).toBe(FILES_PER_STORE * CHUNKS_PER_FILE);
    expect(await dropOrphanedGenerations()).toBe(0);
  }, 180_000);
});
