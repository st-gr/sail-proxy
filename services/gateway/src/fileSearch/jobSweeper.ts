/**
 * Periodic history sweeper for file_search jobs (`fs_jobs`).
 *
 * Deletes the job rows of jobs that finished more than 30 days ago — the
 * Jobs screen's history window. Only the job row goes: the batch and its
 * member files are the vector store's own data and stay (their lifetime is
 * the store's, see expirySweeper.ts). A job with `finished_at` NULL is never
 * swept, however old: it is still running. One whose members were removed
 * while it ran is finished first by `settleOrphanedJobs`, so it ages out too.
 *
 * The schema backfill (schema.sql.ts) only creates jobs for batches younger
 * than 29 days, so a job swept here is never recreated on the next boot.
 *
 * A sweep first finishes orphaned jobs (`settleOrphanedJobs`, its own short
 * transaction that locks the candidate job rows), then deletes with one
 * DELETE that takes no locks beforehand: it touches only finished job rows,
 * which nothing else writes except a retry or an attach clearing
 * `finished_at` — and the DELETE re-checks its predicate on a row such a
 * writer just updated, so a job reopened in that moment is kept.
 */
import { getPool, isFileSearchAvailable } from './db';
import { getDefaultLogger } from '@libs/logger';
import { settleIdleReembedJobs, inTransaction } from './reembedWorker';

const logger = getDefaultLogger();

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
// A gateway restarted more often than the interval would never sweep: one sweep soon after start.
const FIRST_SWEEP_DELAY_MS = 60 * 1000;
const RETENTION_DAYS = 30;

// createBatch commits the job row before its first member's attach commits,
// so a young job with no member yet is still being created, not orphaned.
// A constant, interpolated as a number, never user input.
const CREATION_GRACE_MINUTES = 5;

// How many chunks one transaction of dropOrphanedGenerations deletes, so the
// store row it locks is held only briefly.
const ORPHAN_DELETE_BATCH = 5000;

// A generation of chunk `c` (or of `$1`/`$2`) that nobody will ever read: not
// the store's active one, and no re-embed job that is not cancelled targets it.
// A running job, and a failed one kept for Retry, protect theirs; the 30-day
// sweep deleting a failed job is what orphans its generation. A cancelled job
// deleted its generation itself, unless a successor reused the number — which
// then protects it.
const UNTARGETED_SQL = (store: string, generation: string) => `NOT EXISTS (
  SELECT 1 FROM fs_jobs j
   WHERE j.kind = 'reembed_store' AND j.store_id = ${store} AND j.target_generation = ${generation}
     AND NOT j.cancel_requested)`;

/**
 * Every (store, generation) of chunks that UNTARGETED_SQL says nobody reads,
 * found per store of vector_stores by walking idx_chunks_store_gen: the
 * smallest generation of the store, then the next above it, until there is
 * none. Each step is one index probe, so a store holding only its active
 * generation costs two (found, then none above it) however many chunks it has;
 * the whole chunk table is never read. Protected generations are stepped over,
 * so one below or above the active generation never hides another behind it.
 * Chunks of a store whose row is gone are not listed (deleting a store deletes
 * its chunks in the same transaction).
 */
export const ORPHANED_GENERATIONS_SQL = `WITH RECURSIVE gens AS (
  SELECT vs.id AS store_id, vs.active_generation,
         (SELECT min(c.generation) FROM vector_store_chunks c WHERE c.store_id = vs.id) AS generation
    FROM vector_stores vs
  UNION ALL
  SELECT g.store_id, g.active_generation,
         (SELECT min(c.generation) FROM vector_store_chunks c
           WHERE c.store_id = g.store_id AND c.generation > g.generation)
    FROM gens g
   WHERE g.generation IS NOT NULL
)
SELECT gens.store_id, gens.generation FROM gens
 WHERE gens.generation IS NOT NULL AND gens.generation <> gens.active_generation
   AND ${UNTARGETED_SQL('gens.store_id', 'gens.generation')}
 ORDER BY gens.store_id, gens.generation`;

const NO_MEMBER_IN_PROGRESS_SQL = `NOT EXISTS (
  SELECT 1 FROM vector_store_files f
   WHERE f.store_id = j.store_id AND f.batch_id = j.batch_id AND f.status = 'in_progress')`;

/**
 * Settles orphaned jobs of every kind; returns how many it finished. A file
 * batch: `settleOrphanedBatchJobs` below. A re-embed (store or bulk parent) with
 * nothing left to claim: reembedWorker.ts's `settleIdleReembedJobs`, which the idle
 * worker loops also run — here it covers a gateway whose worker is not running
 * (it switches a store whose items are all done, fails a job whose items
 * failed or whose store expired, and finishes a bulk parent whose children all
 * finished).
 */
export async function settleOrphanedJobs(): Promise<number> {
  const batches = await settleOrphanedBatchJobs();
  const reembeds = await settleIdleReembedJobs();
  if (reembeds > 0) {
    logger.info('JobSweeper', `Finished ${reembeds} re-embed job(s) with nothing left to do`);
  }
  return batches + reembeds;
}

/**
 * Sets `finished_at` on every unfinished file-batch job whose batch has no
 * member in_progress any more — including a batch with no members left at
 * all. The worker settles a job itself whenever IT changes a member's status;
 * this catches the paths that remove members instead: the expiry sweeper
 * deleting an expired store's files mid-ingestion, a detach of the last
 * in_progress member, and any future one. Without it such a job would keep
 * `finished_at` NULL and never leave the history. Returns how many it set.
 *
 * Two statements in one transaction, like `settleFinishedIfTerminal`: the
 * candidates are locked first, then re-checked by a statement with a fresh
 * snapshot. A single UPDATE would evaluate its NOT EXISTS on the snapshot it
 * started with, so a retry that reopened members and committed while the
 * UPDATE waited on the job row would still get its job marked finished.
 * Only `fs_jobs` rows are locked (in id order), never files, so this cannot
 * deadlock with the stores -> files -> jobs order everywhere else.
 */
async function settleOrphanedBatchJobs(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query<{ id: string }>(
      `SELECT j.id FROM fs_jobs j
        WHERE j.kind = 'file_batch' AND j.finished_at IS NULL
          AND j.created_at < now() - interval '${CREATION_GRACE_MINUTES} minutes'
          AND ${NO_MEMBER_IN_PROGRESS_SQL}
        ORDER BY j.id
        FOR UPDATE`,
    );
    let settled = 0;
    if ((candidates.rowCount ?? 0) > 0) {
      const result = await client.query(
        `UPDATE fs_jobs j SET finished_at = now()
          WHERE j.id = ANY($1::text[]) AND j.finished_at IS NULL AND ${NO_MEMBER_IN_PROGRESS_SQL}`,
        [candidates.rows.map((r) => r.id)],
      );
      settled = result.rowCount ?? 0;
    }
    await client.query('COMMIT');
    if (settled > 0) {
      logger.info('JobSweeper', `Finished ${settled} job(s) whose remaining files were removed`);
    }
    return settled;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Deletes the chunks of every generation nobody will read again (see
 * UNTARGETED_SQL) — chiefly the generation a failed re-embed kept for Retry,
 * once the history sweep deleted the job. The candidates come from
 * ORPHANED_GENERATIONS_SQL (index probes, never the whole chunk table) and are
 * only candidates: each batch of `batchSize` chunks is
 * one transaction under the lock order: the store row FOR UPDATE first (as every
 * re-embed state change takes it), then the generation is re-checked by a
 * SECOND statement, whose fresh READ COMMITTED snapshot sees a start, retry or
 * switch that committed while the lock was awaited (one statement would judge
 * its NOT EXISTS on the snapshot taken before the wait).
 * Returns how many chunks it deleted.
 */
export async function dropOrphanedGenerations(batchSize = ORPHAN_DELETE_BATCH): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const candidates = await pool.query<{ store_id: string; generation: number }>(ORPHANED_GENERATIONS_SQL);
  let deleted = 0;
  for (const { store_id: storeId, generation } of candidates.rows) {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const n = await inTransaction<number>(async (client) => {
        await client.query('SELECT 1 FROM vector_stores WHERE id = $1 FOR UPDATE', [storeId]);
        const store = await client.query(
          `SELECT 1 FROM vector_stores WHERE id = $1 AND active_generation <> $2 AND ${UNTARGETED_SQL('$1', '$2')}`,
          [storeId, generation]);
        if ((store.rowCount ?? 0) === 0) return { commit: false, value: 0 };
        const result = await client.query(
          `DELETE FROM vector_store_chunks WHERE (store_id, file_id, generation, ord) IN (
             SELECT store_id, file_id, generation, ord FROM vector_store_chunks
              WHERE store_id = $1 AND generation = $2 LIMIT $3)`,
          [storeId, generation, batchSize]);
        return { commit: true, value: result.rowCount ?? 0 };
      });
      deleted += n;
      if (n < batchSize) break;
    }
  }
  if (deleted > 0) {
    logger.info('JobSweeper', `Deleted ${deleted} chunk(s) of generations no store or job uses any more`);
  }
  return deleted;
}

/**
 * Finishes orphaned jobs (`settleOrphanedJobs`), then deletes jobs finished
 * more than `olderThanDays` days ago, then the generations those jobs left
 * behind (`dropOrphanedGenerations`), and returns how many jobs it deleted. A
 * no-op (returns 0) when file_search has no database configured.
 */
export async function sweepFinishedJobs(olderThanDays = RETENTION_DAYS): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  await settleOrphanedJobs();
  const result = await pool.query(
    `DELETE FROM fs_jobs WHERE finished_at < now() - ($1::int * interval '1 day')`,
    [olderThanDays],
  );
  const swept = result.rowCount ?? 0;
  if (swept > 0) {
    logger.info('JobSweeper', `Deleted ${swept} finished job(s) older than ${olderThanDays} days`);
  }
  await dropOrphanedGenerations();
  return swept;
}

// ---------------------------------------------------------------------------
// Interval driver — mirrors expirySweeper.ts's start/stop shape.
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;

function runSweep(what: string): void {
  sweepFinishedJobs().catch((error) => {
    logger.error('JobSweeper', `${what} failed`,
      error instanceof Error ? error : new Error(String(error)));
  });
}

/**
 * Starts the periodic sweep. A no-op (logged, not thrown) if file_search is
 * unavailable — no database configured is the normal state for a
 * standalone install — or if already running.
 */
export function startJobSweeper(): void {
  if (sweepTimer) return;
  if (!isFileSearchAvailable()) {
    logger.info('JobSweeper', 'file_search is unavailable (no database configured, or disabled); job sweeper not started');
    return;
  }
  sweepTimer = setInterval(() => runSweep('Sweep tick'), SWEEP_INTERVAL_MS);
  firstSweepTimer = setTimeout(() => {
    firstSweepTimer = null;
    runSweep('First sweep');
  }, FIRST_SWEEP_DELAY_MS);
  // Never keep the process (or a test) alive just for these timers.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  if (typeof firstSweepTimer.unref === 'function') firstSweepTimer.unref();
  logger.info('JobSweeper', `Started, sweeping every ${SWEEP_INTERVAL_MS}ms`);
}

/** Stops the periodic sweep. Safe to call when never started. */
export function stopJobSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (firstSweepTimer) {
    clearTimeout(firstSweepTimer);
    firstSweepTimer = null;
  }
}

export function __isRunningForTests(): boolean {
  return sweepTimer !== null;
}
