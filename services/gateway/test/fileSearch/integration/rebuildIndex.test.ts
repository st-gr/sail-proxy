// W4 Task 2: the approximate-search index on a real pgvector. New installs get the halfvec kind from the boot
// schema; an existing install keeps its index at boot; `rebuild-index` builds the new kind beside it without
// blocking writes, refuses a second run, leaves no invalid index behind when a build fails or is interrupted,
// and swaps in one transaction.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import {
  readVectorIndex, isHalfvecVectorIndex, VECTOR_INDEX_NAME, VECTOR_INDEX_BUILD_NAME, halfvecIndexDefinition,
} from '../../../src/fileSearch/vectorIndex';
import {
  rebuildVectorIndex, parseRebuildIndexArgs, RebuildIndexError, REBUILD_INDEX_LOCK_KEY,
} from '../../../src/fileSearch/rebuildIndex';
import { createFreshDatabase, dsnWithCredentials, FreshDatabase } from './dbFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));
const mockInfo = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: (...args: unknown[]) => mockInfo(...args), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// 20,000 random 128-dim vectors: a serial ef_construction 200 build takes about 7 s on the local Colima
// (4 vCPU) and longer on a CI runner - long enough to write and to interrupt during it.
const BIG = 20_000;
const DIMS = 128;
const OLD_KIND_DDL = `CREATE INDEX ${VECTOR_INDEX_NAME} ON vector_store_chunks USING hnsw (embedding vector_cosine_ops)`;

d('approximate-search index and rebuild-index (requires FILE_SEARCH_TEST_DSN)', () => {
  const fresh: FreshDatabase[] = [];
  const pools: Pool[] = [];
  const roles: string[] = [];
  const saved = process.env.FILE_SEARCH_DATABASE_URL;

  afterAll(async () => {
    for (const p of pools) await p.end().catch(() => {}); // eslint-disable-line no-await-in-loop
    process.env.FILE_SEARCH_DATABASE_URL = saved;
    // roles last: a role cannot be dropped while any database still holds its grants
    for (const [i, f] of fresh.entries()) await f.drop(i === fresh.length - 1 ? roles : []); // eslint-disable-line no-await-in-loop
  });

  /** A migrated database, as the gateway's own boot leaves it. */
  async function install(dims: number): Promise<{ dsn: string; pool: Pool }> {
    const db = await createFreshDatabase(DSN!, 'fs_rbi_');
    fresh.push(db);
    process.env.FILE_SEARCH_DATABASE_URL = db.dsn;
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    mockConfig = { enabled: true, embeddingModel: 'm', embeddingDimensions: dims, limits: {}, hybrid: {} };
    __resetForTests();
    expect(await runMigration()).toBe(true);
    await getPool()?.end();
    __resetForTests();
    const pool = new Pool({ connectionString: db.dsn, max: 4 });
    pools.push(pool);
    return { dsn: db.dsn, pool };
  }

  /** The boot migration again, against the same database. */
  async function boot(dsn: string, dims: number): Promise<void> {
    process.env.FILE_SEARCH_DATABASE_URL = dsn;
    mockConfig = { enabled: true, embeddingModel: 'm', embeddingDimensions: dims, limits: {}, hybrid: {} };
    __resetForTests();
    expect(await runMigration()).toBe(true);
    await getPool()?.end();
    __resetForTests();
  }

  async function load(pool: Pool, from: number, to: number, dims: number): Promise<void> {
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
       SELECT 'vs_1', 'file-1', g, 'chunk ' || g, 2,
              (SELECT array_agg(random()) FROM generate_series(1, $3) WHERE g >= 0)::vector
         FROM generate_series($1::int, $2::int) g`, [from, to, dims]);
  }

  /** An install from before W4: the previous index over existing chunks. */
  async function upgradedInstall(rows: number, dims = DIMS): Promise<{ dsn: string; pool: Pool }> {
    const db = await install(dims);
    await db.pool.query(`DROP INDEX ${VECTOR_INDEX_NAME}`);
    await load(db.pool, 0, rows - 1, dims);
    await db.pool.query('SET max_parallel_maintenance_workers = 0');
    await db.pool.query(OLD_KIND_DDL);
    return db;
  }

  async function chunkIndexes(pool: Pool): Promise<Array<{ name: string; oid: number; definition: string; valid: boolean }>> {
    const { rows } = await pool.query(
      `SELECT ic.relname AS name, ic.oid::int AS oid, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
         FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
        WHERE i.indrelid = 'vector_store_chunks'::regclass AND ic.relname LIKE 'idx_chunks_hnsw%' ORDER BY 1`);
    return rows;
  }

  // pg_stat_progress_create_index lists every database's builds: other suites running at the same time build
  // indexes in theirs, so every read is narrowed to this database and its chunk table.
  const OWN_BUILDS = `FROM pg_stat_progress_create_index
        WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND relid = 'vector_store_chunks'::regclass`;

  async function buildRunning(pool: Pool): Promise<boolean> {
    const { rows } = await pool.query(`SELECT phase ${OWN_BUILDS} AND phase LIKE 'building index%'`);
    return rows.length > 0;
  }

  async function waitForBuild(pool: Pool): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (!(await buildRunning(pool))) { // eslint-disable-line no-await-in-loop
      if (Date.now() > deadline) throw new Error('the build never started');
      await new Promise((r) => { setTimeout(r, 50); }); // eslint-disable-line no-await-in-loop
    }
  }

  const opts = (argv: string[] = []) => parseRebuildIndexArgs(argv);
  const quiet = () => {
    const lines: string[] = [];
    return { lines, deps: { write: (l: string) => { lines.push(l); }, progressIntervalMs: 250 } };
  };

  it('a new install gets the halfvec index (m 16, ef_construction 200)', async () => {
    const { pool } = await install(1536);
    const index = await readVectorIndex(pool);
    expect(index).toMatchObject({ kind: 'halfvec', dimensions: 1536, m: 16, efConstruction: 200, valid: true });
    const { rows } = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'vector_store_chunks' AND indexname = $1", [VECTOR_INDEX_NAME]);
    expect(isHalfvecVectorIndex(rows[0].indexdef, 1536)).toBe(true);
  }, 60_000);

  it('a new install at 3072 dims gets the halfvec index too', async () => {
    const { pool } = await install(3072);
    expect(await readVectorIndex(pool)).toMatchObject({ kind: 'halfvec', dimensions: 3072, valid: true });
  }, 60_000);

  it('an existing install keeps its previous index at boot, untouched', async () => {
    const { dsn, pool } = await upgradedInstall(50, 8);
    const before = await chunkIndexes(pool);
    expect(before.map((i) => i.definition)).toEqual([expect.stringContaining('USING hnsw (embedding vector_cosine_ops)')]);
    mockInfo.mockClear();
    await boot(dsn, 8);
    expect(await chunkIndexes(pool)).toEqual(before);
    expect(mockInfo.mock.calls.map((c) => c[1]).join('\n')).toMatch(/previous kind.*rebuild-index/);
  }, 60_000);

  it('with chunks but no index, the boot does not build one and names rebuild-index', async () => {
    const { dsn, pool } = await install(8);
    await pool.query(`DROP INDEX ${VECTOR_INDEX_NAME}`);
    await load(pool, 0, 9, 8);
    mockInfo.mockClear();
    await boot(dsn, 8);
    expect(await chunkIndexes(pool)).toEqual([]);
    expect(mockInfo.mock.calls.map((c) => c[1]).join('\n')).toMatch(/no approximate-search index.*rebuild-index/);
    // and with the chunks gone, the next boot creates it (a new install's empty table)
    await pool.query('DELETE FROM vector_store_chunks');
    await boot(dsn, 8);
    expect(await readVectorIndex(pool)).toMatchObject({ kind: 'halfvec', dimensions: 8, valid: true });
  }, 60_000);

  it('rebuilds under concurrent writes: never blocks them, refuses a second run, indexes rows written during the build', async () => {
    const { dsn, pool } = await upgradedInstall(BIG);
    const { lines, deps } = quiet();
    const run = rebuildVectorIndex(dsn, opts(), deps);
    run.catch(() => {}); // awaited below
    await waitForBuild(pool);

    // a second run is refused at once and changes nothing
    const second = quiet();
    await expect(rebuildVectorIndex(dsn, opts(), second.deps)).rejects.toThrow(/another rebuild-index is already running/);

    // writes and reads go on during the build
    const written: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = Date.now();
      await load(pool, BIG + i, BIG + i, DIMS); // eslint-disable-line no-await-in-loop
      written.push(Date.now() - started);
    }
    const searchStarted = Date.now();
    await pool.query("SELECT count(*) FROM vector_store_chunks WHERE store_id = 'vs_1'");
    expect(Date.now() - searchStarted).toBeLessThan(10_000);
    expect(Math.max(...written)).toBeLessThan(10_000);
    expect(await buildRunning(pool)).toBe(true); // the writes happened while it ran

    await expect(run).resolves.toBe('rebuilt');
    expect(lines.join('\n')).toMatch(/progress \d+ s: building index/);

    // exactly one valid index of the new kind, under the one name
    const after = await chunkIndexes(pool);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: VECTOR_INDEX_NAME, valid: true });
    expect(isHalfvecVectorIndex(after[0].definition, DIMS)).toBe(true);

    // every row written during the build is found through the index
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL hnsw.ef_search = 1000');
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await client.query(
          `SELECT c.ord FROM vector_store_chunks c,
                  (SELECT embedding FROM vector_store_chunks WHERE ord = $1) q
            ORDER BY c.embedding::halfvec(${DIMS}) <=> q.embedding::halfvec(${DIMS}) LIMIT 1`, [BIG + i]);
        expect(rows[0].ord).toBe(BIG + i);
      }
      const { rows: explain } = await client.query(
        `EXPLAIN (FORMAT JSON) SELECT ord FROM vector_store_chunks
          ORDER BY embedding::halfvec(${DIMS}) <=> (SELECT embedding FROM vector_store_chunks WHERE ord = ${BIG})::halfvec(${DIMS})
          LIMIT 1`);
      expect(JSON.stringify(explain[0]['QUERY PLAN'])).toContain(`"Index Name":"${VECTOR_INDEX_NAME}"`);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 300_000);

  it('a failed build leaves no invalid index behind and the old index unchanged', async () => {
    const { dsn, pool } = await upgradedInstall(20, 4);
    // above halfvec's range (65504): the cast fails in the middle of the build
    await pool.query(`INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
                      VALUES ('vs_1', 'file-1', 1000, 'too large', 1, '[1e6,0,0,0]')`);
    const before = await chunkIndexes(pool);
    const { lines, deps } = quiet();
    await expect(rebuildVectorIndex(dsn, opts(), deps)).rejects.toThrow(RebuildIndexError);
    expect(lines.join('\n')).toMatch(/build stopped \(22003: .*out of range.*\); dropping idx_chunks_hnsw_v2/);
    expect(await chunkIndexes(pool)).toEqual(before);
    // the lock was released: a later run proceeds (and fails the same way, cleanly)
    await expect(rebuildVectorIndex(dsn, opts(), quiet().deps)).rejects.toThrow(/stopped .*out of range/);
    expect(await chunkIndexes(pool)).toEqual(before);
  }, 120_000);

  it('an interrupted build is cancelled and dropped', async () => {
    const { dsn, pool } = await upgradedInstall(BIG);
    const before = await chunkIndexes(pool);
    const abort = new AbortController();
    const { deps } = quiet();
    const run = rebuildVectorIndex(dsn, opts(), { ...deps, signal: abort.signal });
    run.catch(() => {});
    await waitForBuild(pool);
    abort.abort();
    await expect(run).rejects.toThrow(/stopped \(interrupted\).*unchanged/);
    expect(await chunkIndexes(pool)).toEqual(before);
    const { rows } = await pool.query(`SELECT count(*)::int AS n ${OWN_BUILDS}`);
    expect(rows[0].n).toBe(0);
  }, 300_000);

  it('drops an invalid leftover build first, then builds and swaps', async () => {
    const { dsn, pool } = await upgradedInstall(20, 4);
    // a concurrent build that failed leaves an INVALID index behind
    await pool.query(`INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
                      VALUES ('vs_1', 'file-1', 1000, 'too large', 1, '[1e6,0,0,0]')`);
    await expect(pool.query(`CREATE INDEX CONCURRENTLY ${VECTOR_INDEX_BUILD_NAME} ON vector_store_chunks `
      + halfvecIndexDefinition(4))).rejects.toThrow(/out of range/);
    await pool.query('DELETE FROM vector_store_chunks WHERE ord = 1000');
    expect((await readVectorIndex(pool, VECTOR_INDEX_BUILD_NAME))?.valid).toBe(false);

    const { lines, deps } = quiet();
    await expect(rebuildVectorIndex(dsn, opts(), deps)).resolves.toBe('rebuilt');
    expect(lines.join('\n')).toMatch(/dropping idx_chunks_hnsw_v2 left by an interrupted run/);
    const after = await chunkIndexes(pool);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: VECTOR_INDEX_NAME, valid: true });
    expect(isHalfvecVectorIndex(after[0].definition, 4)).toBe(true);
    // a run asking for the index that is there does nothing
    await expect(rebuildVectorIndex(dsn, opts(), quiet().deps)).resolves.toBe('unchanged');
    expect(await chunkIndexes(pool)).toEqual(after);
  }, 120_000);

  it('a swap that cannot get its lock keeps the built index; the next run reuses it', async () => {
    const { dsn, pool } = await upgradedInstall(20, 4);
    await pool.query(`CREATE INDEX CONCURRENTLY ${VECTOR_INDEX_BUILD_NAME} ON vector_store_chunks ${halfvecIndexDefinition(4)}`);
    const before = await chunkIndexes(pool);
    const reader = await pool.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('LOCK TABLE vector_store_chunks IN ACCESS SHARE MODE'); // a long-running search
      const { lines, deps } = quiet();
      await expect(rebuildVectorIndex(dsn, opts(), { ...deps, swapAttempts: 2, swapLockTimeoutMs: 100 }))
        .rejects.toThrow(/built and valid, but the swap could not take its lock 2 times; idx_chunks_hnsw is unchanged/);
      expect(lines.join('\n')).toMatch(/reusing idx_chunks_hnsw_v2/);
      expect(lines.join('\n')).toMatch(/swap: the chunk table is busy \(attempt 1\/2\)/);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
    expect(await chunkIndexes(pool)).toEqual(before);
    await expect(rebuildVectorIndex(dsn, opts(), quiet().deps)).resolves.toBe('rebuilt');
    const after = await chunkIndexes(pool);
    expect(after.map((i) => i.name)).toEqual([VECTOR_INDEX_NAME]);
    // the very index built before, renamed
    expect(after[0].oid).toBe(before.find((i) => i.name === VECTOR_INDEX_BUILD_NAME)!.oid);
  }, 120_000);

  it('an interrupt after a successful build keeps the valid index; the next run swaps it in without building', async () => {
    const { dsn, pool } = await upgradedInstall(20, 4);
    const before = await chunkIndexes(pool);
    const reader = await pool.connect();
    const abort = new AbortController();
    const lines: string[] = [];
    try {
      await reader.query('BEGIN');
      await reader.query('LOCK TABLE vector_store_chunks IN ACCESS SHARE MODE'); // the swap must wait
      const write = (line: string) => {
        lines.push(line);
        if (/swap: the chunk table is busy/.test(line)) abort.abort(); // Ctrl-C while the swap retries
      };
      await expect(rebuildVectorIndex(dsn, opts(), {
        write, progressIntervalMs: 250, signal: abort.signal, swapAttempts: 10, swapLockTimeoutMs: 100,
      })).rejects.toThrow(/interrupted before the swap; idx_chunks_hnsw_v2 is built and valid and was kept, idx_chunks_hnsw is unchanged/);
      expect(lines.join('\n')).toMatch(/built idx_chunks_hnsw_v2/);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
    const kept = await chunkIndexes(pool);
    expect(kept.filter((i) => i.name === VECTOR_INDEX_NAME)).toEqual(before);
    const v2 = kept.find((i) => i.name === VECTOR_INDEX_BUILD_NAME)!;
    expect(v2.valid).toBe(true);
    // the boot names it
    mockInfo.mockClear();
    await boot(dsn, 4);
    expect(mockInfo.mock.calls.map((c) => c[1]).join('\n')).toMatch(/built, not yet swapped idx_chunks_hnsw_v2.*run it again/);
    const again = quiet();
    await expect(rebuildVectorIndex(dsn, opts(), again.deps)).resolves.toBe('rebuilt');
    expect(again.lines.join('\n')).toMatch(/reusing idx_chunks_hnsw_v2/);
    const after = await chunkIndexes(pool);
    expect(after.map((i) => [i.name, i.oid])).toEqual([[VECTOR_INDEX_NAME, v2.oid]]);
  }, 120_000);

  it('works at 3072 dims (halfvec), with other build parameters', async () => {
    const { dsn, pool } = await install(3072);
    await pool.query(`DROP INDEX ${VECTOR_INDEX_NAME}`);
    await load(pool, 0, 49, 3072);
    await expect(rebuildVectorIndex(dsn, opts(['--ef-construction', '100', '--m', '24']), quiet().deps))
      .resolves.toBe('rebuilt');
    expect(await readVectorIndex(pool)).toMatchObject({
      kind: 'halfvec', dimensions: 3072, m: 24, efConstruction: 100, valid: true,
    });
  }, 120_000);

  it('--dry-run prints the preflight and the plan and changes nothing', async () => {
    const { dsn, pool } = await upgradedInstall(30, 4);
    const before = await chunkIndexes(pool);
    const { lines, deps } = quiet();
    await expect(rebuildVectorIndex(dsn, opts(['--dry-run', '--maintenance-work-mem', '128']), deps)).resolves.toBe('dry-run');
    const out = lines.join('\n');
    expect(out).toMatch(/pgvector +\d+\.\d+/);
    expect(out).toMatch(/embedding width +4/);
    expect(out).toMatch(/chunks \(estimate\) +30/);
    expect(out).toMatch(/current index +idx_chunks_hnsw: previous kind \(vector\), m 16, ef_construction 64, valid/);
    expect(out).toMatch(/maintenance_work_mem +128MB \(--maintenance-work-mem\)/);
    expect(out).toMatch(/serial \(max_parallel_maintenance_workers = 0/);
    expect(out).toContain(`CREATE INDEX CONCURRENTLY ${VECTOR_INDEX_BUILD_NAME} ON vector_store_chunks ${halfvecIndexDefinition(4)}`);
    expect(out).toMatch(/one transaction: DROP INDEX idx_chunks_hnsw; ALTER INDEX idx_chunks_hnsw_v2 RENAME TO idx_chunks_hnsw/);
    expect(await chunkIndexes(pool)).toEqual(before);
    // it took no lock either
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1::bigint::oid", [REBUILD_INDEX_LOCK_KEY]);
    expect(rows[0].n).toBe(0);
  }, 60_000);

  it('an index built with a non-default ef_construction: one boot info line and a dry-run note; a default one gets neither', async () => {
    const { dsn, pool } = await install(8);
    await pool.query(`DROP INDEX ${VECTOR_INDEX_NAME}`);
    await load(pool, 0, 49, 8);
    await expect(rebuildVectorIndex(dsn, opts(['--ef-construction', '64']), quiet().deps)).resolves.toBe('rebuilt');
    mockInfo.mockClear();
    await boot(dsn, 8);
    const notes = mockInfo.mock.calls.map((c) => String(c[1])).filter((l) => l.includes('ef_construction'));
    expect(notes).toEqual([expect.stringMatching(
      /idx_chunks_hnsw was built with ef_construction 64 \(default 200\): lower recall than the defaults.*rebuild-index without --m or --ef-construction/)]);
    const { lines, deps } = quiet();
    await expect(rebuildVectorIndex(dsn, opts(['--dry-run']), deps)).resolves.toBe('dry-run');
    expect(lines.join('\n')).toMatch(/note +idx_chunks_hnsw was built with ef_construction 64 \(default 200\)/);

    await expect(rebuildVectorIndex(dsn, opts(), quiet().deps)).resolves.toBe('rebuilt');
    mockInfo.mockClear();
    await boot(dsn, 8);
    expect(mockInfo.mock.calls.map((c) => String(c[1])).filter((l) => l.includes('ef_construction'))).toEqual([]);
    const after = quiet();
    await expect(rebuildVectorIndex(dsn, opts(['--dry-run']), after.deps)).resolves.toBe('dry-run');
    expect(after.lines.join('\n')).not.toMatch(/note /);
  }, 120_000);

  it('a session holding the chunk table stops the preflight within its lock timeout, with nothing changed', async () => {
    const { dsn, pool } = await install(4);
    await load(pool, 0, 9, 4);
    const before = await chunkIndexes(pool);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`DROP INDEX ${VECTOR_INDEX_NAME}`); // a migration in progress: the index and its table locked
      const started = Date.now();
      for (const argv of [['--dry-run'], []]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(rebuildVectorIndex(dsn, opts(argv), quiet().deps))
          .rejects.toThrow(/another session holds a lock on the chunk table.*retry when it is free; this run changed nothing/);
      }
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await chunkIndexes(pool)).toEqual(before);
  }, 60_000);

  it('refuses a role that does not own the chunk table', async () => {
    const { dsn, pool } = await install(4);
    const role = `fs_rbi_ro_${process.pid}_${Date.now() % 100000}`;
    roles.push(role);
    await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'pw'`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON vector_store_chunks TO "${role}"`);
    const before = await chunkIndexes(pool);
    await expect(rebuildVectorIndex(dsnWithCredentials(dsn, role, 'pw'), opts(), quiet().deps))
      .rejects.toThrow(new RegExp(`role "${role}" does not own vector_store_chunks.*FILE_SEARCH_MIGRATION_DATABASE_URL`));
    expect(await chunkIndexes(pool)).toEqual(before);
  }, 60_000);
});
