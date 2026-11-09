// The W2 upgrade — structured and contextual chunks — run by the real
// runMigration() against a database in the pre-W2 shape: the current schema
// without the chunk columns (context, context_tsv, section, section_offset,
// heading_path), vector_stores.chunking, fs_jobs.target_chunking and the four
// context counters, and without idx_chunks_context_tsv; holding a store,
// chunks and a job. Three role shapes:
//   - owner, single DSN: adds every part in place without rewriting a table;
//     existing rows read NULL (and 0 for the counters); the context_tsv index
//     is built after the columns commit, so readers of the chunks are not held
//     up by its build; the next boot re-applies without warning and without
//     waiting behind open readers.
//   - split credentials: the privileged path adds them, and the runtime role
//     can use them.
//   - non-owner (with CREATE and without): cannot add them, so file_search
//     reports UNAVAILABLE naming them and the migrate CLI, until the owner runs
//     the migration step.
// The upgrade also drops NOT NULL from vector_store_chunks.embedding (a
// whitespace-only structured chunk is stored without a vector).
// Plus the probe: each new column missing alone makes a non-owner boot
// unavailable and is named, as does an embedding column still NOT NULL; the context_tsv index is a performance index whose
// absence does not; and the index serves a context_tsv match.
import * as crypto from 'crypto';
import { Client, Pool } from 'pg';
import { buildSchemaSql, splitSchemaPhases, splitSqlStatements } from '../../../src/fileSearch/schema.sql';
import { getPool, runMigration, isFileSearchAvailable, __resetForTests } from '../../../src/fileSearch/db';
import { unavailableCause } from '../../../src/fileSearch/unavailableCause';
import { getDefaultLogger } from '@libs/logger';
import { createFreshDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'w2-owner@example.test';
const NEW_COLUMNS = [
  'fs_jobs.context_cached_tokens',
  'fs_jobs.context_failed_chunks',
  'fs_jobs.context_input_tokens',
  'fs_jobs.context_output_tokens',
  'fs_jobs.target_chunking',
  'vector_store_chunks.context',
  'vector_store_chunks.context_tsv',
  'vector_store_chunks.heading_path',
  'vector_store_chunks.section',
  'vector_store_chunks.section_offset',
  'vector_stores.chunking',
];
const CONTEXT_INDEX = 'idx_chunks_context_tsv';
const ALTERED_TABLES = ['fs_jobs', 'vector_store_chunks', 'vector_stores'];

/** Undoes the W2 additions on a database built from the current schema. */
const TO_PRE_W2 = `
  DROP INDEX ${CONTEXT_INDEX};
  ALTER TABLE vector_store_chunks DROP COLUMN context, DROP COLUMN context_tsv, DROP COLUMN section,
    DROP COLUMN section_offset, DROP COLUMN heading_path;
  ALTER TABLE vector_stores DROP COLUMN chunking;
  ALTER TABLE fs_jobs DROP COLUMN target_chunking, DROP COLUMN context_input_tokens, DROP COLUMN context_output_tokens,
    DROP COLUMN context_cached_tokens, DROP COLUMN context_failed_chunks;
  ALTER TABLE vector_store_chunks ALTER COLUMN embedding SET NOT NULL;
`;
const EMBEDDING_NULL = 'vector_store_chunks.embedding accepting NULL';

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

/** The pre-W2 shape, seeded as the superuser (who then owns every object),
 *  with a store, a file, two chunks and a finished re-embed job. */
async function seedPreW2(dsn: string): Promise<void> {
  await withPool(dsn, async (p) => {
    await p.query(buildSchemaSql(EMBED_DIM));
    await p.query(TO_PRE_W2);
    await p.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage, bytes, ref_count) VALUES ('sha_0', 1, 'db', '\\x41', 1)`);
    await p.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ('file-w2-0', $1, 'doc.md', 'assistants', 'sha_0', 1)`, [OWNER]);
    await p.query(
      `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim) VALUES ('vs_w2', $1, 'm', $2)`,
      [OWNER, EMBED_DIM]);
    await p.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
       VALUES ('vs_w2', 'file-w2-0', 0, 'legacy alpha', 2, '[1,0,0]'), ('vs_w2', 'file-w2-0', 1, 'legacy beta', 2, '[0,1,0]')`);
    await p.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, store_id, embedding_tokens, finished_at)
       VALUES ('job_old', 'reembed_store', $1, 'vs_w2', 7, now())`, [OWNER]);
  });
}

/** Which of the W2 parts exist. */
async function inspect(dsn: string): Promise<{ columns: string[]; indexes: string[]; nullableEmbedding: boolean }> {
  return withPool(dsn, async (p) => {
    const columns = await p.query<{ n: string }>(
      `SELECT table_name || '.' || column_name AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name || '.' || column_name = ANY ($1::text[]) ORDER BY 1`,
      [NEW_COLUMNS]);
    const indexes = await p.query<{ n: string }>(
      'SELECT n FROM unnest($1::text[]) AS n WHERE to_regclass(n) IS NOT NULL ORDER BY 1', [[CONTEXT_INDEX]]);
    const embedding = await p.query<{ notnull: boolean }>(
      `SELECT attnotnull AS notnull FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass AND attname = 'embedding'`);
    return {
      columns: columns.rows.map((r) => r.n), indexes: indexes.rows.map((r) => r.n), nullableEmbedding: !embedding.rows[0].notnull,
    };
  });
}

/** The physical file of each altered table: an ALTER that rewrites the table
 *  gives it a new one. */
async function relfilenodes(dsn: string): Promise<Record<string, number>> {
  return withPool(dsn, async (p) => {
    const { rows } = await p.query<{ relname: string; relfilenode: number }>(
      `SELECT relname, relfilenode::int AS relfilenode FROM pg_class WHERE relname = ANY ($1::text[])`, [ALTERED_TABLES]);
    return Object.fromEntries(rows.map((r) => [r.relname, r.relfilenode]));
  });
}

const UPGRADED = { columns: NEW_COLUMNS, indexes: [CONTEXT_INDEX], nullableEmbedding: true };
const NOT_UPGRADED = { columns: [], indexes: [], nullableEmbedding: false };

/** What Tasks 3–6 will do with the new parts, run as whichever role `p` connects as. */
async function exerciseNewSchema(p: Pool): Promise<void> {
  // Legacy chunks read NULL in every new column.
  const legacy = await p.query(
    `SELECT ord, context, context_tsv, section, section_offset, heading_path
       FROM vector_store_chunks WHERE store_id = 'vs_w2' ORDER BY ord`);
  expect(legacy.rows).toEqual([
    { ord: 0, context: null, context_tsv: null, section: null, section_offset: null, heading_path: null },
    { ord: 1, context: null, context_tsv: null, section: null, section_offset: null, heading_path: null },
  ]);

  // A structured, contextualized chunk; its context is found by full text.
  await p.query(
    `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding,
                                      context, context_tsv, section, section_offset, heading_path)
     VALUES ('vs_w2', 'file-w2-0', 2, 'retries back off', 3, '[0,0,1]',
             $1, to_tsvector('simple', $1), 4, 120, 'Guide > Ingestion > Retries')`,
    ['Guide > Ingestion > Retries\nHow the ingestion worker retries a failed embedding.']);
  const hit = await p.query(
    `SELECT ord, section, section_offset, heading_path FROM vector_store_chunks
      WHERE context_tsv @@ to_tsquery('simple', 'worker & embedding')`);
  expect(hit.rows).toEqual([{ ord: 2, section: 4, section_offset: 120, heading_path: 'Guide > Ingestion > Retries' }]);

  // A whitespace-only structured chunk: stored without a vector.
  await p.query(
    `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding, section, section_offset)
     VALUES ('vs_w2', 'file-w2-0', 3, $1, 900, NULL, 4, 300)`, [' '.repeat(5000)]);
  const blank = await p.query(`SELECT embedding FROM vector_store_chunks WHERE store_id = 'vs_w2' AND ord = 3`);
  expect(blank.rows).toEqual([{ embedding: null }]);

  // The store setting: NULL until set.
  const before = await p.query(`SELECT chunking FROM vector_stores WHERE id = 'vs_w2'`);
  expect(before.rows).toEqual([{ chunking: null }]);
  const setting = { strategy: 'structure', max_chunk_size_tokens: 800, chunk_overlap_tokens: 0, contextual: true };
  await p.query(`UPDATE vector_stores SET chunking = $1 WHERE id = 'vs_w2'`, [setting]);
  const after = await p.query(`SELECT chunking FROM vector_stores WHERE id = 'vs_w2'`);
  expect(after.rows).toEqual([{ chunking: setting }]);

  // A pre-W2 job reads 0 context tokens and no target chunking; a re-chunk job
  // pins its target and accumulates context tokens.
  const counters = 'context_input_tokens, context_cached_tokens, context_output_tokens, context_failed_chunks';
  const old = await p.query(`SELECT target_chunking, ${counters} FROM fs_jobs WHERE id = 'job_old'`);
  expect(old.rows).toEqual([{
    target_chunking: null, context_input_tokens: '0', context_cached_tokens: '0', context_output_tokens: '0',
    context_failed_chunks: '0',
  }]);
  await p.query(
    `INSERT INTO fs_jobs (id, kind, store_id, target_chunking) VALUES ('job_rechunk', 'reembed_store', 'vs_w2', $1)`,
    [setting]);
  await p.query(
    `UPDATE fs_jobs SET context_input_tokens = context_input_tokens + $1, context_cached_tokens = context_cached_tokens + $2,
                        context_output_tokens = context_output_tokens + $3, context_failed_chunks = context_failed_chunks + 1
      WHERE id = 'job_rechunk'`, ['5000000000', 900, 40]);
  const job = await p.query(`SELECT target_chunking, ${counters} FROM fs_jobs WHERE id = 'job_rechunk'`);
  expect(job.rows).toEqual([{
    target_chunking: setting, context_input_tokens: '5000000000', context_cached_tokens: '900', context_output_tokens: '40',
    context_failed_chunks: '1',
  }]);
  for (const counter of counters.split(', ')) {
    // eslint-disable-next-line no-await-in-loop
    await expect(p.query(`UPDATE fs_jobs SET ${counter} = NULL WHERE id = 'job_rechunk'`))
      .rejects.toMatchObject({ code: '23502' });
  }
}

async function nonOwnerRole(db: FreshDatabase, roles: string[], withCreate: boolean): Promise<{ role: string; dsn: string }> {
  const role = `fs_w2_${crypto.randomBytes(4).toString('hex')}`;
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

d('W2 upgrade of a pre-W2 database: structured and contextual chunks (requires FILE_SEARCH_TEST_DSN)', () => {
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
    db = await createFreshDatabase(DSN!, 'fs_w2_');
    await seedPreW2(db.dsn);
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

  it('the schema declares every W2 part once, the column additions behind a catalog guard', () => {
    const statements = splitSqlStatements(buildSchemaSql(EMBED_DIM));
    for (const col of NEW_COLUMNS) {
      const [table, column] = col.split('.');
      const guarded = statements.filter((s) => s.startsWith('DO $$') && s.includes(`ADD COLUMN IF NOT EXISTS ${column} `));
      expect(guarded).toHaveLength(1);
      expect(guarded[0]).toContain(`attrelid = '${table}'::regclass`);
      expect(guarded[0]).toContain(`attname = '${column}'`);
      // No bare ALTER of the column outside its guard.
      expect(statements.filter((s) => !s.startsWith('DO $$') && s.includes(`ADD COLUMN IF NOT EXISTS ${column} `)))
        .toHaveLength(0);
    }
    const index = statements.filter((s) => s.includes(` ${CONTEXT_INDEX} `));
    expect(index).toHaveLength(1);
    expect(index[0]).toMatch(/USING gin \(context_tsv\) WHERE context_tsv IS NOT NULL$/);
    // Built after the main transaction commits, beside the other post-commit indexes
    // (POST_COMMIT_INDEXES); every other statement stays in it.
    const { main, post } = splitSchemaPhases(buildSchemaSql(EMBED_DIM));
    expect(post).toEqual(expect.arrayContaining(index));
    expect(main).toHaveLength(statements.length - post.length);
    expect(main).not.toContain(index[0]);
  });

  it('owner, single DSN: adds every part without a rewrite, keeps rows, and re-applies silently without waiting behind readers', async () => {
    const filesBefore = await relfilenodes(db.dsn);
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(await inspect(db.dsn)).toEqual(UPGRADED);
    // Nullable columns and constant defaults are catalog-only on PG >= 11.
    expect(await relfilenodes(db.dsn)).toEqual(filesBefore);

    const runtime = getPool()!;
    const { rows } = await runtime.query(`SELECT ord, text FROM vector_store_chunks ORDER BY ord`);
    expect(rows).toEqual([{ ord: 0, text: 'legacy alpha' }, { ord: 1, text: 'legacy beta' }]);
    const job = await runtime.query(`SELECT embedding_tokens FROM fs_jobs WHERE id = 'job_old'`);
    expect(job.rows).toEqual([{ embedding_tokens: '7' }]);
    await exerciseNewSchema(runtime);
    await runtime.end();

    // The next boot: the guards make the column additions read-only, so an open
    // reader of any altered table does not hold the re-application up.
    const reader = new Pool({ connectionString: db.dsn, max: 1 });
    const readerClient = await reader.connect();
    try {
      await readerClient.query('BEGIN');
      for (const table of ALTERED_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        await readerClient.query(`SELECT count(*) FROM ${table}`);
      }
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

  // The upgrade adds the chunk columns (ACCESS EXCLUSIVE on vector_store_chunks,
  // held to the end of its transaction) and builds the context_tsv index (a
  // scan of every chunk). The index is built in a transaction of its own after
  // the columns commit, so the scan blocks writes to the chunks but not reads.
  // Observed at the moment the build is sent, on both migration paths.
  for (const split of [false, true]) {
    it(`${split ? 'split credentials' : 'owner, single DSN'}: the index build runs after the columns commit and does not block readers`, async () => {
      if (split) {
        const runtimeRole = `fs_w2rt_${crypto.randomBytes(4).toString('hex')}`;
        roles.push(runtimeRole);
        process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn;
        process.env.FILE_SEARCH_DATABASE_URL = dsnWithCredentials(db.dsn, runtimeRole, crypto.randomBytes(8).toString('hex'));
      } else {
        process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
      }
      __resetForTests();
      const observer = new Pool({ connectionString: db.dsn, max: 1 });
      const seen: Array<{ columns: string[]; exclusive: number; read: number }> = [];
      const original = Client.prototype.query;
      jest.spyOn(Client.prototype, 'query').mockImplementation(function query(this: Client, ...args: any[]) {
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (typeof text === 'string' && text.startsWith(`CREATE INDEX IF NOT EXISTS ${CONTEXT_INDEX} `)) {
          const observed = (async () => {
            const c = await observer.connect();
            try {
              // What another session sees while the build is about to run.
              const columns = await c.query<{ n: string }>(
                `SELECT table_name || '.' || column_name AS n FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name || '.' || column_name = ANY ($1::text[]) ORDER BY 1`,
                [NEW_COLUMNS]);
              const locks = await c.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM pg_locks
                  WHERE relation = 'vector_store_chunks'::regclass AND mode = 'AccessExclusiveLock' AND granted`);
              await c.query('BEGIN');
              await c.query(`SET LOCAL lock_timeout = '2s'`);
              const read = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM vector_store_chunks');
              await c.query('COMMIT');
              seen.push({ columns: columns.rows.map((r) => r.n), exclusive: locks.rows[0].n, read: read.rows[0].n });
            } finally {
              c.release();
            }
          })();
          return observed.then(() => (original as any).apply(this, args));
        }
        return (original as any).apply(this, args);
      });
      try {
        expect(await runMigration()).toBe(true);
      } finally {
        jest.restoreAllMocks();
        await observer.end();
      }
      expect(seen).toEqual([{ columns: NEW_COLUMNS, exclusive: 0, read: 2 }]);
      expect(await inspect(db.dsn)).toEqual(UPGRADED);
    }, 60_000);
  }

  it('split credentials: the privileged path adds every part and the runtime role can use them', async () => {
    const runtimeRole = `fs_w2rt_${crypto.randomBytes(4).toString('hex')}`;
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
    it(`non-owner ${withCreate ? 'with' : 'without'} CREATE: reports unavailable naming the columns and the migrate CLI, until the owner migrates`, async () => {
      const { dsn } = await nonOwnerRole(db, roles, withCreate);
      process.env.FILE_SEARCH_DATABASE_URL = dsn;
      __resetForTests();
      const warn = jest.spyOn(getDefaultLogger(), 'warn');
      const error = jest.spyOn(getDefaultLogger(), 'error');

      expect(await runMigration()).toBe(false);
      expect(isFileSearchAvailable()).toBe(false);
      expect(unavailableCause()).toBe('schema_outdated');
      expect(error).not.toHaveBeenCalled();
      const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
      expect(warning).toContain('UNAVAILABLE');
      for (const c of NEW_COLUMNS) expect(warning).toContain(c);
      expect(warning).toContain(EMBEDDING_NULL);
      expect(warning).toContain('cli-tools/file-search-migrate.js');
      expect(await inspect(db.dsn)).toEqual(NOT_UPGRADED);

      // The fix the warning names: the migration step as the owner. After it,
      // the same non-owner install boots available.
      await getPool()?.end().catch(() => {});
      process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = db.dsn;
      process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
      __resetForTests();
      expect(await runMigration()).toBe(true);
      expect(unavailableCause()).toBeNull();
      delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
      process.env.FILE_SEARCH_DATABASE_URL = dsn;
      __resetForTests();
      expect(await runMigration()).toBe(true);
      expect(isFileSearchAvailable()).toBe(true);
      expect(unavailableCause()).toBeNull();
      expect(await inspect(db.dsn)).toEqual(UPGRADED);
      await exerciseNewSchema(getPool()!);
    }, 60_000);
  }

  // A partially migrated install: the current schema minus ONE new column,
  // booted by a non-owner. Each column alone must make file_search unavailable
  // and be named.
  for (const part of NEW_COLUMNS) {
    it(`partially migrated, missing ${part}: a non-owner boot reports unavailable and names it`, async () => {
      const [table, column] = part.split('.');
      await withPool(db.dsn, async (p) => {
        await p.query(buildSchemaSql(EMBED_DIM));
        await p.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
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

  it('partially migrated, embedding still NOT NULL: a non-owner boot reports unavailable and names it', async () => {
    await withPool(db.dsn, async (p) => {
      await p.query(buildSchemaSql(EMBED_DIM));
      await p.query('ALTER TABLE vector_store_chunks ALTER COLUMN embedding SET NOT NULL');
    });
    const { dsn } = await nonOwnerRole(db, roles, false);
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    __resetForTests();
    const warn = jest.spyOn(getDefaultLogger(), 'warn');

    expect(await runMigration()).toBe(false);
    expect(isFileSearchAvailable()).toBe(false);
    const warning = warn.mock.calls.map((c) => String(c[1])).join('\n');
    expect(warning).toContain('UNAVAILABLE');
    expect(warning).toContain(EMBEDDING_NULL);
    for (const c of NEW_COLUMNS) expect(warning).not.toContain(c);
  }, 60_000);

  it('missing only the context_tsv index: a non-owner boot stays available (a performance index)', async () => {
    await withPool(db.dsn, async (p) => {
      await p.query(buildSchemaSql(EMBED_DIM));
      await p.query(`DROP INDEX ${CONTEXT_INDEX}`);
    });
    const { dsn } = await nonOwnerRole(db, roles, true);
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    __resetForTests();

    expect(await runMigration()).toBe(true);
    expect(isFileSearchAvailable()).toBe(true);
    expect((await inspect(db.dsn)).indexes).toEqual([]);
  }, 60_000);

  it('the partial index serves a context_tsv match once rows exist', async () => {
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    await withPool(db.dsn, async (p) => {
      // 20,000 chunks: most without a context (legacy and static), one in a
      // hundred with one, a handful of them matching.
      await p.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding, context, context_tsv)
         SELECT 'vs_w2', 'file-w2-0', 100 + g, 'chunk ' || g, '[1,1,1]',
                CASE WHEN g % 100 = 0 THEN 'context ' || CASE WHEN g % 5000 = 0 THEN 'zebra' ELSE 'common' END END,
                CASE WHEN g % 100 = 0 THEN to_tsvector('simple', 'context ' || CASE WHEN g % 5000 = 0 THEN 'zebra' ELSE 'common' END) END
           FROM generate_series(1, 20000) AS g`);
      await p.query('ANALYZE vector_store_chunks');
      const plan = await p.query(
        `EXPLAIN SELECT ord FROM vector_store_chunks WHERE context_tsv @@ to_tsquery('simple', 'zebra')`);
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain(CONTEXT_INDEX);
      const { rows } = await p.query(
        `SELECT count(*)::int AS n FROM vector_store_chunks WHERE context_tsv @@ to_tsquery('simple', 'zebra')`);
      expect(rows).toEqual([{ n: 4 }]);
    });
  }, 60_000);
});
