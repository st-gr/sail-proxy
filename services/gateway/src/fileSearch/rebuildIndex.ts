/**
 * `migrateCli.js rebuild-index`: builds the approximate-search index of the new kind (vectorIndex.ts) over an
 * existing install's chunks and puts it in place of `idx_chunks_hnsw`, without blocking ingestion or search.
 *
 * An operator command only, never part of a boot or deploy step: over existing chunks the build takes minutes
 * to hours (scale bench: 443 s for 288k chunks at 1536 dims, serial), so the operator picks the window.
 *
 *  1. Preflight: pgvector >= 0.7 (halfvec), the column's width, the estimated chunk count, the current index (kind,
 *     validity, size), maintenance_work_mem; rough size and time. `--dry-run` stops here.
 *  2. A session-level advisory lock: a second run is refused while one is running.
 *  3. A leftover `idx_chunks_hnsw_v2` from an interrupted run is dropped, unless it is valid and exactly the
 *     requested index (an earlier run built it and could not swap), which is then reused.
 *  4. `CREATE INDEX CONCURRENTLY idx_chunks_hnsw_v2`, serial (`max_parallel_maintenance_workers = 0`, so no
 *     dynamic shared memory: Docker and Kyma give Postgres 64 MB of /dev/shm) unless `--parallel`. Writes go on;
 *     rows written during the build are in the index when it completes. Progress comes from
 *     pg_stat_progress_create_index. A failed or interrupted build drops the invalid index it leaves.
 *  5. `indisvalid` is checked, then the swap: DROP INDEX idx_chunks_hnsw and RENAME of v2 in ONE short
 *     transaction, so a reader sees the old index or the new one and never neither. The DROP needs a brief
 *     ACCESS EXCLUSIVE lock on the chunk table. While an attempt waits for it (at most 2 s, lock_timeout), new
 *     searches AND ingestion writes on the chunk table queue behind it: a pause of up to 2 s per attempt, not a
 *     failure; up to 15 attempts. Once the build has succeeded, nothing drops it any more: if the swap never
 *     gets its lock, fails, or is interrupted, the valid index stays as idx_chunks_hnsw_v2 and a re-run swaps it
 *     without building again.
 *
 * Needs the role that owns the tables (FILE_SEARCH_MIGRATION_DATABASE_URL, like the migration); the runtime role
 * is DML-only and is refused in the preflight.
 */
import { Client } from 'pg';
import {
  VECTOR_INDEX_NAME, VECTOR_INDEX_BUILD_NAME, HNSW_M, HNSW_EF_CONSTRUCTION, HALFVEC_MIN_PGVECTOR,
  MAX_EMBEDDING_DIMENSIONS, halfvecIndexDefinition, readVectorIndex, pgvectorVersionAtLeast,
  estimateHalfvecIndexBytes, estimateBuildSeconds, nonDefaultBuildNote, VectorIndexState,
} from './vectorIndex';

/** Session advisory lock held for a whole run ('vidx'); distinct from the migration's transaction lock. */
export const REBUILD_INDEX_LOCK_KEY = 0x76696478;

export const REBUILD_INDEX_USAGE = `Usage: rebuild-index [--dry-run] [--ef-construction 200] [--m 16] [--parallel]
                     [--maintenance-work-mem <MB>]

  standalone CLI:  sail-proxy file-search rebuild-index
  a checkout:      node cli-tools/file-search-migrate.js rebuild-index
  gateway image:   node services/gateway/dist/services/gateway/src/fileSearch/migrateCli.js rebuild-index

Builds the halfvec HNSW index over the existing chunks without blocking writes and puts it in place of
${VECTOR_INDEX_NAME}. Needs the owning role (FILE_SEARCH_MIGRATION_DATABASE_URL, else FILE_SEARCH_DATABASE_URL).

  --dry-run                    print the preflight and the plan, change nothing
  --ef-construction <n>        graph quality, 4-1000 (default ${HNSW_EF_CONSTRUCTION})
  --m <n>                      neighbours per node, 2-100 (default ${HNSW_M})
  --parallel                   use the server's parallel maintenance workers; needs /dev/shm larger than
                               maintenance_work_mem (Docker and Kyma default to 64 MB)
  --maintenance-work-mem <MB>  memory for the build's graph (default: the server's setting)`;

export interface RebuildIndexOptions {
  dryRun: boolean;
  m: number;
  efConstruction: number;
  parallel: boolean;
  /** null: keep the server's maintenance_work_mem. */
  maintenanceWorkMemMb: number | null;
  help: boolean;
}

export class RebuildIndexUsageError extends Error {}
/** A refusal or failure with a message meant for the operator as it stands. */
export class RebuildIndexError extends Error {}

function wholeNumber(flag: string, raw: string, min: number, max: number, unit = ''): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new RebuildIndexUsageError(`${flag} must be a whole number ${unit}from ${min} to ${max} (got ${raw})`);
  }
  return n;
}

export function parseRebuildIndexArgs(argv: string[]): RebuildIndexOptions {
  const opts: RebuildIndexOptions = {
    dryRun: false, m: HNSW_M, efConstruction: HNSW_EF_CONSTRUCTION, parallel: false, maintenanceWorkMemMb: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new RebuildIndexUsageError(`unknown argument ${arg}`);
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new RebuildIndexUsageError(`${flag} needs a value`);
      i += 1;
      return next;
    };
    const noValue = (): void => {
      if (inline !== undefined) throw new RebuildIndexUsageError(`${flag} takes no value`);
    };
    switch (flag) {
      case '--dry-run': noValue(); opts.dryRun = true; break;
      case '--parallel': noValue(); opts.parallel = true; break;
      case '--help': noValue(); opts.help = true; break;
      case '--m': opts.m = wholeNumber(flag, value(), 2, 100); break;
      case '--ef-construction': opts.efConstruction = wholeNumber(flag, value(), 4, 1000); break;
      case '--maintenance-work-mem':
        opts.maintenanceWorkMemMb = wholeNumber(flag, value(), 1, 2097151, 'of megabytes ');
        break;
      default: throw new RebuildIndexUsageError(`unknown option ${flag}`);
    }
  }
  if (opts.efConstruction < 2 * opts.m) {
    throw new RebuildIndexUsageError(
      `--ef-construction must be at least twice --m (pgvector's rule; got ${opts.efConstruction} and ${opts.m})`);
  }
  return opts;
}

export interface RebuildIndexDeps {
  /** One line of operator output. */
  write: (line: string) => void;
  /** How often build progress is printed (default 15 s). */
  progressIntervalMs?: number;
  /** Aborting cancels the build and drops what it left. */
  signal?: AbortSignal;
  /** The swap's lock wait per attempt and the number of attempts (defaults 2 s, 15). */
  swapLockTimeoutMs?: number;
  swapAttempts?: number;
}

export type RebuildIndexOutcome = 'dry-run' | 'unchanged' | 'rebuilt';

interface Preflight {
  pgvector: string;
  schema: string;
  dimensions: number;
  chunks: number;
  current: VectorIndexState | null;
  leftover: VectorIndexState | null;
  maintenanceWorkMem: string;
  maintenanceWorkMemBytes: number;
  runningPid: number | null;
}

/** The preflight's session timeouts (its statements are catalog reads and, on a never-analysed table, a count). */
const PREFLIGHT_STATEMENT_TIMEOUT = '30s';
const PREFLIGHT_LOCK_TIMEOUT = '2s';

const MIB = 2 ** 20;
const mib = (bytes: number): string => `${Math.round(bytes / MIB).toLocaleString('en-US')} MiB`;

function duration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`;
  return `about ${(seconds / 3600).toFixed(1)} h`;
}

function describeIndex(index: VectorIndexState | null): string {
  if (!index) return 'none';
  const kind = index.kind === 'halfvec'
    ? `halfvec(${index.dimensions}), m ${index.m}, ef_construction ${index.efConstruction}`
    : index.kind === 'vector' ? `previous kind (vector), m ${index.m}, ef_construction ${index.efConstruction}`
      : `unrecognised: ${index.definition}`;
  return `${kind}, ${index.valid ? 'valid' : 'INVALID'}, ${mib(index.sizeBytes)}`;
}

function matchesRequest(index: VectorIndexState | null, dimensions: number, opts: RebuildIndexOptions): boolean {
  return !!index && index.valid && index.kind === 'halfvec' && index.dimensions === dimensions
    && index.m === opts.m && index.efConstruction === opts.efConstruction;
}

async function lockHolder(client: Client): Promise<number | null> {
  const { rows } = await client.query(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 0 AND objid = $1::bigint::oid
        AND objsubid = 1 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [REBUILD_INDEX_LOCK_KEY]);
  return rows[0]?.pid ?? null;
}

async function preflight(client: Client): Promise<Preflight> {
  const ext = await client.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  if (ext.rows.length === 0) {
    throw new RebuildIndexError('the vector extension is not installed in this database: run the file_search migration first');
  }
  const pgvector: string = ext.rows[0].extversion;
  const table = await client.query(
    `SELECT n.nspname AS schema, pg_has_role(current_user, c.relowner, 'USAGE') AS owner, current_user AS role,
            (SELECT a.atttypmod FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'embedding'
                AND NOT a.attisdropped) AS dimensions
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass('vector_store_chunks')`);
  if (table.rows.length === 0) {
    throw new RebuildIndexError('no file_search schema in this database (vector_store_chunks not found): run the migration first');
  }
  const { schema, owner, role, dimensions } = table.rows[0];
  if (!owner) {
    throw new RebuildIndexError(`the database role "${role}" does not own vector_store_chunks and cannot build its index: `
      + 'run with the migration credential (FILE_SEARCH_MIGRATION_DATABASE_URL)');
  }
  if (!pgvectorVersionAtLeast(pgvector, HALFVEC_MIN_PGVECTOR)) {
    throw new RebuildIndexError(`pgvector ${pgvector} has no halfvec; the index needs pgvector ${HALFVEC_MIN_PGVECTOR.join('.')} `
      + 'or later (ALTER EXTENSION vector UPDATE after upgrading the package)');
  }
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
    throw new RebuildIndexError(`vector_store_chunks.embedding has width ${dimensions}; a halfvec index needs 1 to ${MAX_EMBEDDING_DIMENSIONS}`);
  }
  // The planner's row estimate is enough for the size and time estimates and costs nothing at millions of rows;
  // a table never analyzed (-1 on Postgres 14+, 0 before) is counted, which is cheap exactly because such a table
  // is new and small (and an empty one counts nothing).
  const estimate = await client.query("SELECT reltuples::bigint AS n FROM pg_class WHERE oid = to_regclass('vector_store_chunks')");
  const count = Number(estimate.rows[0].n) > 0 ? estimate
    : await client.query('SELECT count(*)::bigint AS n FROM vector_store_chunks');
  const settings = await client.query(
    `SELECT current_setting('maintenance_work_mem') AS mwm, pg_size_bytes(current_setting('maintenance_work_mem')) AS bytes`);
  return {
    pgvector,
    schema,
    dimensions,
    chunks: Number(count.rows[0].n),
    current: await readVectorIndex(client, VECTOR_INDEX_NAME),
    leftover: await readVectorIndex(client, VECTOR_INDEX_BUILD_NAME),
    maintenanceWorkMem: settings.rows[0].mwm,
    maintenanceWorkMemBytes: Number(settings.rows[0].bytes),
    runningPid: await lockHolder(client),
  };
}

/**
 * The preflight with its two timeouts turned into what an operator can act on; any other failure keeps its own
 * message. Nothing has been changed when the preflight fails.
 */
async function boundedPreflight(client: Client): Promise<Preflight> {
  try {
    return await preflight(client);
  } catch (error: any) {
    if (error?.code === '57014') { // query_canceled: the preflight's statement_timeout
      throw new RebuildIndexError(`the preflight did not finish within ${PREFLIGHT_STATEMENT_TIMEOUT}: the database `
        + 'is busy, or the chunk table is large and was never analysed. Run ANALYZE vector_store_chunks, then retry; '
        + 'this run changed nothing');
    }
    if (error?.code === '55P03') { // lock_not_available: the preflight's lock_timeout
      throw new RebuildIndexError('another session holds a lock on the chunk table (vector_store_chunks), such as a '
        + 'migration or a VACUUM FULL; retry when it is free; this run changed nothing');
    }
    throw error;
  }
}

function printPreflight(pre: Preflight, opts: RebuildIndexOptions, write: (line: string) => void): void {
  const size = estimateHalfvecIndexBytes(pre.chunks, pre.dimensions, opts.m);
  const memory = opts.maintenanceWorkMemMb !== null ? opts.maintenanceWorkMemMb * MIB : pre.maintenanceWorkMemBytes;
  const memoryLabel = opts.maintenanceWorkMemMb !== null ? `${opts.maintenanceWorkMemMb}MB (--maintenance-work-mem)`
    : `${pre.maintenanceWorkMem} (server setting)`;
  write('rebuild-index preflight');
  write(`  pgvector              ${pre.pgvector}`);
  write(`  embedding width       ${pre.dimensions}`);
  write(`  chunks (estimate)     ${pre.chunks.toLocaleString('en-US')}`);
  write(`  current index         ${VECTOR_INDEX_NAME}: ${describeIndex(pre.current)}`);
  const note = nonDefaultBuildNote(pre.current);
  if (note) write(`  note                  ${VECTOR_INDEX_NAME} was ${note}`);
  if (pre.leftover) write(`  leftover build        ${VECTOR_INDEX_BUILD_NAME}: ${describeIndex(pre.leftover)}`);
  write(`  maintenance_work_mem  ${memoryLabel}${size > memory
    ? ` - below the graph's estimated ${mib(size)}: the build continues on disk past it, several times slower; `
      + 'raise it with --maintenance-work-mem if the database host has the memory'
    : ''}`);
  write(`  build                 ${opts.parallel
    ? "parallel (the server's max_parallel_maintenance_workers): Postgres needs /dev/shm larger than maintenance_work_mem"
    : 'serial (max_parallel_maintenance_workers = 0; no shared memory needed)'}`);
  write(`  estimate              about ${mib(size)} of new index; ${duration(estimateBuildSeconds(pre.chunks, pre.dimensions, opts.efConstruction, opts.parallel))} `
    + '(rough: measured on 4 vCPU with the graph in memory)');
  write('  free disk             not readable from SQL: the database volume needs room for the new index while '
    + `the old one${pre.current ? ` (${mib(pre.current.sizeBytes)}, freed by the swap)` : ''} still exists`);
  if (pre.runningPid !== null) write(`  running               a rebuild-index is running now (backend pid ${pre.runningPid})`);
}

function printPlan(pre: Preflight, opts: RebuildIndexOptions, write: (line: string) => void): void {
  write('plan');
  if (matchesRequest(pre.current, pre.dimensions, opts)) {
    write(`  nothing to do: ${VECTOR_INDEX_NAME} already is this index`
      + `${pre.leftover ? ` (only DROP INDEX CONCURRENTLY ${VECTOR_INDEX_BUILD_NAME}, left by an interrupted run)` : ''}`);
    return;
  }
  const reuse = matchesRequest(pre.leftover, pre.dimensions, opts);
  const steps = [
    ...(pre.leftover && !reuse ? [`DROP INDEX CONCURRENTLY ${VECTOR_INDEX_BUILD_NAME} (left by an interrupted run)`] : []),
    reuse ? `reuse ${VECTOR_INDEX_BUILD_NAME}, already built and valid`
      : `CREATE INDEX CONCURRENTLY ${VECTOR_INDEX_BUILD_NAME} ON vector_store_chunks ${halfvecIndexDefinition(pre.dimensions, opts)}`,
    `one transaction: DROP INDEX ${pre.current ? VECTOR_INDEX_NAME : `IF EXISTS ${VECTOR_INDEX_NAME}`}; `
      + `ALTER INDEX ${VECTOR_INDEX_BUILD_NAME} RENAME TO ${VECTOR_INDEX_NAME}`,
  ];
  steps.forEach((step, i) => write(`  ${i + 1}. ${step}`));
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RebuildIndexError('interrupted');
}

/**
 * A role's own timeouts must not end an hours-long build or a concurrent DROP that waits for running queries; a
 * CLI that dies mid-build cancels it server side (Postgres 14+ notices the closed connection) instead of leaving
 * it running unattended.
 */
async function prepareSession(client: Client): Promise<void> {
  await client.query('SET statement_timeout = 0');
  await client.query('SET lock_timeout = 0');
  await client.query("SET client_connection_check_interval = '10s'").catch(() => {});
}

async function dropBuildIndex(dsn: string, client: Client, qualified: string): Promise<void> {
  const sql = `DROP INDEX CONCURRENTLY IF EXISTS ${qualified}`;
  try {
    await client.query(sql);
  } catch {
    // the build's own connection may be gone (a lost connection is how some builds fail)
    const fresh = new Client({ connectionString: dsn, application_name: 'file-search-rebuild-index' });
    await fresh.connect();
    try {
      await prepareSession(fresh);
      await fresh.query(sql);
    } finally { await fresh.end().catch(() => {}); }
  }
}

async function build(
  dsn: string, client: Client, pre: Preflight, opts: RebuildIndexOptions, deps: RebuildIndexDeps,
  q: (name: string) => string,
): Promise<void> {
  const { write, signal } = deps;
  if (!opts.parallel) await client.query('SET max_parallel_maintenance_workers = 0');
  if (opts.maintenanceWorkMemMb !== null) await client.query(`SET maintenance_work_mem = '${opts.maintenanceWorkMemMb}MB'`);
  const pid: number = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

  const monitor = new Client({ connectionString: dsn, application_name: 'file-search-rebuild-index-progress' });
  await monitor.connect();
  const started = Date.now();
  const progress = setInterval(() => {
    monitor.query(
      `SELECT phase, blocks_done, blocks_total, tuples_done, tuples_total, lockers_done, lockers_total
         FROM pg_stat_progress_create_index WHERE pid = $1`, [pid])
      .then(({ rows }) => {
        if (rows.length === 0) return;
        const r = rows[0];
        const part = (label: string, done: string, total: string): string => (Number(total) > 0
          ? `, ${label} ${Number(done).toLocaleString('en-US')} / ${Number(total).toLocaleString('en-US')} `
            + `(${Math.floor((100 * Number(done)) / Number(total))}%)` : '');
        write(`  progress ${Math.round((Date.now() - started) / 1000)} s: ${r.phase}`
          + `${part('tuples', r.tuples_done, r.tuples_total)}${part('blocks', r.blocks_done, r.blocks_total)}`
          + `${part('waiting for transactions', r.lockers_done, r.lockers_total)}`);
      })
      .catch(() => {});
  }, deps.progressIntervalMs ?? 15_000);
  const cancel = (): void => { monitor.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });

  write(`building ${VECTOR_INDEX_BUILD_NAME} (writes and searches go on)...`);
  try {
    aborted(signal);
    await client.query(
      // an index is created in its table's schema; CREATE INDEX takes no qualified name
      `CREATE INDEX CONCURRENTLY ${client.escapeIdentifier(VECTOR_INDEX_BUILD_NAME)} ON ${q('vector_store_chunks')} `
      + `${halfvecIndexDefinition(pre.dimensions, opts)}`);
    // An interrupt arriving now no longer drops anything: the swap below sees it and keeps the valid index.
    const built = await readVectorIndex(client, VECTOR_INDEX_BUILD_NAME);
    if (!built?.valid) throw new RebuildIndexError(`${VECTOR_INDEX_BUILD_NAME} was created but is not valid`);
    write(`built ${VECTOR_INDEX_BUILD_NAME} in ${Math.round((Date.now() - started) / 1000)} s, ${mib(built.sizeBytes)}`);
  } catch (error: any) {
    const reason = signal?.aborted ? 'interrupted' : `${error.code ? `${error.code}: ` : ''}${error.message}`;
    write(`build stopped (${reason}); dropping ${VECTOR_INDEX_BUILD_NAME}`);
    await dropBuildIndex(dsn, client, q(VECTOR_INDEX_BUILD_NAME));
    throw new RebuildIndexError(`building ${VECTOR_INDEX_BUILD_NAME} stopped (${reason}); it was dropped and `
      + `${VECTOR_INDEX_NAME} is unchanged`);
  } finally {
    clearInterval(progress);
    signal?.removeEventListener('abort', cancel);
    await monitor.end().catch(() => {});
  }
}

async function swap(client: Client, deps: RebuildIndexDeps, q: (name: string) => string): Promise<void> {
  const attempts = deps.swapAttempts ?? 15;
  const lockTimeoutMs = deps.swapLockTimeoutMs ?? 2000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    aborted(deps.signal);
    // eslint-disable-next-line no-await-in-loop
    await client.query('BEGIN');
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      // eslint-disable-next-line no-await-in-loop
      await client.query(`DROP INDEX IF EXISTS ${q(VECTOR_INDEX_NAME)}`);
      // eslint-disable-next-line no-await-in-loop
      await client.query(`ALTER INDEX ${q(VECTOR_INDEX_BUILD_NAME)} RENAME TO ${client.escapeIdentifier(VECTOR_INDEX_NAME)}`);
      // eslint-disable-next-line no-await-in-loop
      await client.query('COMMIT');
      return;
    } catch (error: any) {
      // eslint-disable-next-line no-await-in-loop
      await client.query('ROLLBACK').catch(() => {});
      if (error.code !== '55P03') throw error; // lock_not_available is the only retryable failure
      deps.write(`  swap: the chunk table is busy (attempt ${attempt}/${attempts}); retrying`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(1000 * attempt, 10_000), deps.signal);
    }
  }
  throw new RebuildIndexError(`${VECTOR_INDEX_BUILD_NAME} is built and valid, but the swap could not take its lock `
    + `${attempts} times; ${VECTOR_INDEX_NAME} is unchanged. Run rebuild-index again at a quieter time: it reuses `
    + `the built index. Until then both indexes are maintained on every write.`);
}

/** Runs the command against `dsn`. Throws RebuildIndexError with an operator-ready message on refusal or failure. */
export async function rebuildVectorIndex(
  dsn: string, opts: RebuildIndexOptions, deps: RebuildIndexDeps,
): Promise<RebuildIndexOutcome> {
  const { write } = deps;
  const client = new Client({ connectionString: dsn, application_name: 'file-search-rebuild-index' });
  await client.connect();
  try {
    // The preflight (all a dry run does) is short catalog reads: bounded, whatever the role's own settings are.
    // A build lifts both again (prepareSession) once it holds the lock and has read the preflight again.
    await client.query(`SET statement_timeout = '${PREFLIGHT_STATEMENT_TIMEOUT}'`);
    await client.query(`SET lock_timeout = '${PREFLIGHT_LOCK_TIMEOUT}'`);
    const first = await boundedPreflight(client);
    printPreflight(first, opts, write);
    if (opts.dryRun) {
      printPlan(first, opts, write);
      return 'dry-run';
    }
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [REBUILD_INDEX_LOCK_KEY]);
    if (!rows[0].ok) {
      const pid = await lockHolder(client);
      throw new RebuildIndexError(`another rebuild-index is already running on this database${pid ? ` (backend pid ${pid})` : ''}; `
        + 'this run changed nothing');
    }
    try {
      // Read again under the lock: another run may have finished since the preflight above. Still under the
      // preflight's timeouts: its reads wait for a relation lock, without lock_timeout for as long as it is held.
      const pre = await boundedPreflight(client);
      await prepareSession(client);
      printPlan(pre, opts, write);
      const q = (name: string): string => `${client.escapeIdentifier(pre.schema)}.${client.escapeIdentifier(name)}`;
      if (matchesRequest(pre.current, pre.dimensions, opts)) {
        if (pre.leftover) await dropBuildIndex(dsn, client, q(VECTOR_INDEX_BUILD_NAME));
        return 'unchanged';
      }
      if (matchesRequest(pre.leftover, pre.dimensions, opts)) {
        write(`reusing ${VECTOR_INDEX_BUILD_NAME}, built by an earlier run`);
      } else {
        if (pre.leftover) {
          write(`dropping ${VECTOR_INDEX_BUILD_NAME} left by an interrupted run`);
          await dropBuildIndex(dsn, client, q(VECTOR_INDEX_BUILD_NAME));
        }
        await build(dsn, client, pre, opts, deps, q);
      }
      try {
        await swap(client, deps, q);
      } catch (error: any) {
        if (error instanceof RebuildIndexError && error.message !== 'interrupted') throw error;
        // The build succeeded: keep it (hours of work), as when the swap runs out of attempts.
        throw new RebuildIndexError(`${error instanceof RebuildIndexError ? 'interrupted before the swap'
          : `the swap failed (${error.message})`}; ${VECTOR_INDEX_BUILD_NAME} is built and valid and was kept, `
          + `${VECTOR_INDEX_NAME} is unchanged. Run rebuild-index again to swap it in without building again; `
          + 'until then both indexes are maintained on every write.');
      }
      const done = await readVectorIndex(client, VECTOR_INDEX_NAME);
      write(`done: ${VECTOR_INDEX_NAME} is ${describeIndex(done)}`);
      return 'rebuilt';
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [REBUILD_INDEX_LOCK_KEY]).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}
