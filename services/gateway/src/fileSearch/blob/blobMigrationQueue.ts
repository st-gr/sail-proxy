/**
 * Blob migration queue: the claim of `fs_blob_migration_items` and the worker loop that drains
 * it. What one item does is blobMigrationWorker.ts.
 */
import type { Pool } from 'pg';
import { getPool, isFileSearchAvailable } from '../db';
import { getFileSearchConfig } from '../../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { LEASE_MINUTES } from '../workQueue';
import { processBlobMigrationItem, BlobMigrationItem } from './blobMigrationWorker';
import { finalizeBlobMigrationJob, settleIdleBlobMigrationJobs } from './blobMigrationDb';

const logger = getDefaultLogger();

/** Items one replica moves at a time. */
export const MIGRATION_CONCURRENCY = 1;
const POLL_INTERVAL_MS = 5_000;
const IDLE_SETTLE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/** Items whose attempts ran out while their worker died turn `failed`; their jobs may then finish. */
async function reapZombies(pool: Pool, maxRetries: number): Promise<void> {
  const { rows } = await pool.query<{ job_id: string }>(
    `UPDATE fs_blob_migration_items SET status = 'failed', claimed_at = NULL, last_error = $2::jsonb
      WHERE (job_id, sha256) IN (
        SELECT job_id, sha256 FROM fs_blob_migration_items
         WHERE status = 'in_progress' AND attempts >= $1
           AND (claimed_at IS NULL OR claimed_at < now() - ($3::int * interval '1 minute'))
         ORDER BY job_id, sha256
         FOR UPDATE)
      RETURNING job_id`,
    [maxRetries, JSON.stringify({
      message: 'The blob migration was interrupted after exhausting its retry budget (the worker likely restarted mid-attempt).',
      name: 'MaxRetriesExceededZombie',
    }), LEASE_MINUTES],
  );
  for (const jobId of [...new Set(rows.map((r) => r.job_id))].sort()) {
    // eslint-disable-next-line no-await-in-loop
    await finalizeBlobMigrationJob(jobId);
  }
}

/**
 * Claims the oldest open item of a running job: lease free or expired, under the retry budget.
 * One CTE with FOR UPDATE SKIP LOCKED, so concurrent claims (any replica) take different rows.
 */
export async function claimNextBlobMigrationItem(): Promise<BlobMigrationItem | null> {
  const pool = getPool();
  if (!pool) return null;
  const { maxRetries } = getFileSearchConfig().ingestion;
  await reapZombies(pool, maxRetries);
  const { rows } = await pool.query<{ job_id: string; sha256: string; target_storage: string; claimed_at: string }>(
    `WITH picked AS (
       SELECT i.job_id, i.sha256 FROM fs_blob_migration_items i
         JOIN fs_jobs j ON j.id = i.job_id
        WHERE i.status = 'in_progress'
          AND (i.claimed_at IS NULL OR i.claimed_at < now() - ($2::int * interval '1 minute'))
          AND i.attempts < $1
          AND j.kind = 'blob_migration' AND NOT j.cancel_requested AND j.finished_at IS NULL
        ORDER BY i.created_at, i.job_id, i.sha256 LIMIT 1
        FOR UPDATE OF i SKIP LOCKED)
     UPDATE fs_blob_migration_items it SET claimed_at = clock_timestamp(), attempts = it.attempts + 1
       FROM picked, fs_jobs j
      WHERE it.job_id = picked.job_id AND it.sha256 = picked.sha256 AND j.id = it.job_id
     RETURNING it.job_id, it.sha256, j.target_storage, it.claimed_at::text AS claimed_at`,
    [maxRetries, LEASE_MINUTES],
  );
  if (rows.length === 0) return null;
  const item = { jobId: rows[0].job_id, sha256: rows[0].sha256, target: rows[0].target_storage, claimedAt: rows[0].claimed_at };
  await pool.query('UPDATE fs_jobs SET started_at = COALESCE(started_at, now()) WHERE id = $1', [item.jobId])
    .catch(() => {}); // only the display stamp; the next claim retries it
  return item;
}


// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface WorkerState {
  stopped: boolean;
  loops: Promise<void>[];
  wake: (() => void) | null;
  lastIdleSettle: number;
}

let workerState: WorkerState | null = null;

function errorOf(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

async function runLoop(state: WorkerState): Promise<void> {
  while (!state.stopped) {
    let item: BlobMigrationItem | null = null;
    try {
      item = await claimNextBlobMigrationItem();
    } catch (e) {
      logger.error('BlobMigration', 'Claiming a migration item failed', errorOf(e));
    }
    if (item) {
      try {
        await processBlobMigrationItem(item);
      } catch (e) {
        logger.error('BlobMigration', 'Processing a migration item threw unexpectedly', errorOf(e), { jobId: item.jobId });
      }
      continue;
    }
    if (Date.now() - state.lastIdleSettle >= IDLE_SETTLE_INTERVAL_MS) {
      state.lastIdleSettle = Date.now();
      await settleIdleBlobMigrationJobs().catch((e) => logger.error('BlobMigration', 'Settling idle jobs failed', errorOf(e)));
    }
    if (state.stopped) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, POLL_INTERVAL_MS);
      if (typeof timer.unref === 'function') timer.unref();
      function done() {
        clearTimeout(timer);
        state.wake = null;
        resolve();
      }
      state.wake = done;
    });
  }
}

/** Starts the migration loops (every replica; claims never overlap). A no-op when unavailable. */
export function startBlobMigrationWorker(): void {
  if (workerState) return;
  if (!isFileSearchAvailable()) {
    logger.info('BlobMigration', 'file_search is unavailable (no database configured, or disabled); blob migration worker not started');
    return;
  }
  const state: WorkerState = { stopped: false, loops: [], wake: null, lastIdleSettle: 0 };
  workerState = state;
  for (let i = 0; i < MIGRATION_CONCURRENCY; i++) state.loops.push(runLoop(state));
}

/** Wakes this process's loop now (after a start or retry); other replicas pick work up by polling. */
export function wakeBlobMigrationWorker(): void {
  workerState?.wake?.();
}

/** Stops the loops; an item in flight finishes (or rolls back) first. */
export async function stopBlobMigrationWorker(): Promise<void> {
  const state = workerState;
  if (!state) return;
  workerState = null;
  state.stopped = true;
  state.wake?.();
  await Promise.all(state.loops);
}

export function __isRunningForTests(): boolean {
  return workerState !== null;
}
