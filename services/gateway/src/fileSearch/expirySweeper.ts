/**
 * Periodic expiry sweeper for file_search vector stores, files and uploads.
 *
 * FILES (OpenAI's `expires_after` on upload, `fs_files.expires_at`): see
 * `sweepExpiredFiles` below — a due file is deleted exactly as
 * `DELETE /files/{id}` deletes it. Everything from here to the end of this
 * comment is about STORES.
 *
 * Finds stores past their `expires_at` deadline and, for each one, deletes
 * its `vector_store_chunks` and `vector_store_files` rows and flips
 * `status` to `'expired'` — mirroring `storeFiles.ts`'s `deleteStoreCascade`
 * exactly, except the `vector_stores` row itself is kept (not deleted) and
 * its status is set rather than the row removed.
 *
 * CORRECTED SCOPE (see the plan's Task 12 hand-off note): this must NOT run
 * "the same refcount-decrement cascade as deletion" — that would be wrong.
 * Files persist independently of vector-store attachment; OpenAI's own
 * reference is explicit that removing a vector-store file does not delete
 * the underlying file. The store pass therefore NEVER touches `fs_files` rows
 * or blob bytes — only a file delete frees them (`DELETE /files/{id}`, or the
 * file pass for a file that itself expired). An expired store keeps its row
 * and reports `status: "expired"` rather than 404-ing, matching every other read path in this feature (see
 * `vectorStoresController.ts`'s `toStoreObject`, which reports whatever
 * `status` the row has verbatim).
 *
 * LOCK ORDER: every mutating path in this codebase locks `vector_stores`
 * BEFORE touching `vector_store_chunks`/`vector_store_files` — see
 * `ingestWorker.ts`'s module doc comment for the deadlock this ordering
 * closes (it took two review rounds to pin down against `commitChunks` and
 * `deleteStoreFile`/`deleteStoreCascade`). This sweeper follows the exact
 * same rule: `FOR UPDATE` on the target `vector_stores` row first, matching
 * `deleteStoreCascade`'s lock class exactly (both are exclusive lockers, so
 * `commitChunks`'s `FOR SHARE` correctly blocks against either one).
 *
 * Re-checking `expires_at < now() AND status != 'expired'` a second time,
 * UNDER that lock, immediately before deleting anything, is what makes this
 * safe against a store that becomes active again between the sweep's
 * candidate scan and this store's turn: `touchStoreActivity` (search) and
 * `attachFile`/`deleteStoreFile` (file mutations) all slide `expires_at`
 * forward via an ordinary row-level write on `vector_stores`, which this
 * transaction's `FOR UPDATE` correctly serializes against — if one of them
 * commits first, the re-check sees the new (future) `expires_at` and this
 * sweep skips the store rather than expiring it out from under a caller who
 * just used it.
 */
import { Pool } from 'pg';
import { getPool, isFileSearchAvailable } from './db';
import { deleteFileDetachingEverywhere } from './repository';
import { expireDueUploads } from './uploads';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Bounds how much work one sweep tick can take on; a backlog beyond this is
// simply picked up by the next tick rather than making one tick unbounded.
const SWEEP_BATCH_LIMIT = 200;

/**
 * Expires one candidate store inside its own transaction. Returns whether it
 * was actually expired (false if a concurrent activity touch or another
 * sweep already resolved it by the time the lock was acquired).
 */
async function sweepOneStore(pool: Pool, storeId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // LOCK ORDER: vector_stores FIRST — see this module's doc comment.
    // Re-verifies BOTH the deadline and status under lock.
    const storeRows = await client.query(
      `SELECT id FROM vector_stores WHERE id = $1 AND expires_at < now() AND status != 'expired' FOR UPDATE`,
      [storeId],
    );
    if (storeRows.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return false;
    }
    await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM vector_store_files WHERE store_id = $1', [storeId]);
    await client.query(`UPDATE vector_stores SET status = 'expired' WHERE id = $1`, [storeId]);
    // A re-embed of the store has nothing left to do: its open items stop here,
    // and the job is finished as failed (store_expired) by reembed.ts's
    // settleIdleReembedJobs.
    await client.query(
      `UPDATE fs_reembed_items SET status = 'cancelled', claimed_at = NULL WHERE store_id = $1 AND status = 'in_progress'`,
      [storeId],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(
      'ExpirySweeper',
      `Failed to expire vector store ${storeId}`,
      error instanceof Error ? error : new Error(String(error)),
    );
    return false;
  } finally {
    client.release();
  }
}

/**
 * Runs one sweep pass: finds up to `SWEEP_BATCH_LIMIT` stores past their
 * `expires_at` deadline and expires each one (see `sweepOneStore`). Returns
 * the number actually expired. A no-op (returns 0) when file_search has no
 * database configured.
 *
 * `onBeforeStoreForTests` — a no-op in production — fires immediately before
 * a given candidate's own per-store transaction starts, i.e. exactly at the
 * boundary between the initial candidate scan above and `sweepOneStore`'s
 * own `FOR UPDATE` re-check. This is the ONLY way to construct,
 * deterministically rather than via a timing-dependent sleep, the race the
 * re-check exists to close: a test can use it to run `touchStoreActivity`
 * (or an attach/detach) on a store that is already IN `candidates` — i.e.
 * the scan above already found it expired — after the scan but before that
 * store's own turn, and then assert the re-check correctly skips it. See
 * expirySweeper.test.ts's "the FOR UPDATE re-check is genuinely load-bearing"
 * test, and `ingestWorker.ts`'s `commitChunks` for the identical pattern
 * used to test the analogous race there.
 */
export async function sweepExpiredStores(
  onBeforeStoreForTests?: (storeId: string) => Promise<void>,
): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;

  const { rows: candidates } = await pool.query<{ id: string }>(
    `SELECT id FROM vector_stores WHERE expires_at < now() AND status != 'expired' ORDER BY expires_at ASC LIMIT $1`,
    [SWEEP_BATCH_LIMIT],
  );

  let sweptCount = 0;
  for (const { id: storeId } of candidates) {
    if (onBeforeStoreForTests) await onBeforeStoreForTests(storeId);
    // Sequential, not parallel: each iteration takes and releases its own
    // FOR UPDATE lock, so bounding concurrency here also bounds how many
    // sweep transactions can be in flight at once.
    // eslint-disable-next-line no-await-in-loop
    const swept = await sweepOneStore(pool, storeId);
    if (swept) sweptCount += 1;
  }
  if (sweptCount > 0) {
    logger.info('ExpirySweeper', `Expired ${sweptCount} vector store(s)`);
  }
  return sweptCount;
}

/**
 * Where the next file pass resumes: after the last candidate of a full
 * batch, so files the pass cannot delete (still referenced elsewhere, or
 * failing) never hold the head of the queue forever. A short batch means the
 * scan reached the end, and the next pass starts from the oldest deadline
 * again. Per process: each gateway walks the queue on its own.
 */
let fileSweepResume: { expiresAt: string; id: string } | null = null;

/**
 * Runs one file-expiry pass: finds up to `batchLimit` files whose
 * `expires_at` has passed (oldest deadline first, resuming after the
 * previous full batch — see `fileSweepResume` — through the partial index
 * `idx_fs_files_expires_at`) and deletes each one as its owner's
 * `DELETE /files/{id}` would: `deleteFileDetachingEverywhere`, the same
 * function the route calls, detaches it from every store of the owner (its
 * `vector_store_files` rows, chunks and re-embed items), touches those
 * stores, deletes the `fs_files` row and releases its blob, in one
 * transaction. Everything derived from `fs_files` (the cockpit's storage per
 * owner, the admin overview) drops with the row, as after a user delete.
 * Returns the number of files deleted; 0 without a database.
 *
 * Several gateways sweep the same database. The candidate scan takes no
 * lock: a claim (`FOR UPDATE SKIP LOCKED`) only helps if it is held through
 * the delete, which would lock `fs_files` before `vector_stores` — the
 * reverse of `deleteFileDetachingEverywhere`'s LOCK ORDER, which exists
 * because the other order deadlocks against an attach. The delete
 * transaction itself is the serialization point instead: it locks the
 * owner's stores and then the file row `FOR UPDATE` (only while it is still
 * expired: `'expired'`), so of two sweepers — or a sweeper and the owner's
 * own delete — one deletes the file and releases its blob, and the other
 * finds no row and returns `deleted: false` without touching anything.
 *
 * A file that cannot be deleted yet (`inUse`: a vector store outside the
 * owner's still references it) is left for a later pass; a failure on one
 * file is logged and does not stop the pass.
 */
export async function sweepExpiredFiles(batchLimit: number = SWEEP_BATCH_LIMIT): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;

  // expires_at as text: a JS Date drops the microseconds, and a cursor bound
  // from one would sort before its own row (see filesController's listFiles).
  const resume = fileSweepResume;
  const { rows: candidates } = await pool.query<{ id: string; owner_email: string; expires_at: string }>(
    `SELECT id, owner_email, expires_at::text AS expires_at FROM fs_files
      WHERE expires_at <= now()${resume ? ' AND (expires_at, id) > ($2::timestamptz, $3)' : ''}
      ORDER BY expires_at, id LIMIT $1`,
    resume ? [batchLimit, resume.expiresAt, resume.id] : [batchLimit],
  );
  const last = candidates[candidates.length - 1];
  fileSweepResume = candidates.length === batchLimit ? { expiresAt: last.expires_at, id: last.id } : null;

  let deletedCount = 0;
  for (const { id, owner_email: ownerEmail } of candidates) {
    try {
      // Sequential, like the store pass: one delete transaction at a time.
      // eslint-disable-next-line no-await-in-loop
      const result = await deleteFileDetachingEverywhere(id, ownerEmail, 'expired');
      if (result.deleted) deletedCount += 1;
      else if (result.inUse) {
        logger.warn('ExpirySweeper', `Expired file ${id} is still referenced by a vector store; retried on a later sweep`);
      }
    } catch (error) {
      logger.error('ExpirySweeper', `Failed to delete expired file ${id}`,
        error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (deletedCount > 0) {
    logger.info('ExpirySweeper', `Deleted ${deletedCount} expired file(s)`);
  }
  return deletedCount;
}

export function __resetFileSweepForTests(): void {
  fileSweepResume = null;
}

/**
 * Runs one upload-expiry pass (OpenAI's Uploads API): pending uploads past their one-hour
 * `expires_at` become `expired` and their staged parts are deleted (`expireDueUploads`). Returns
 * the number expired; 0 without a database.
 */
export async function sweepExpiredUploads(batchLimit: number = SWEEP_BATCH_LIMIT): Promise<number> {
  const expired = await expireDueUploads(batchLimit);
  if (expired > 0) {
    logger.info('ExpirySweeper', `Expired ${expired} upload(s)`);
  }
  return expired;
}

/** One sweep tick: expired stores, then expired files, then expired uploads.
 *  Each pass fails on its own: a failing store pass does not keep files from expiring. */
async function sweepTick(): Promise<void> {
  const passes: Array<[string, () => Promise<number>]> = [
    ['stores', () => sweepExpiredStores()],
    ['files', () => sweepExpiredFiles()],
    ['uploads', () => sweepExpiredUploads()],
  ];
  for (const [name, pass] of passes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pass();
    } catch (error) {
      logger.error('ExpirySweeper', `Sweep tick failed (${name})`,
        error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// ---------------------------------------------------------------------------
// Interval driver — mirrors ingestWorker.ts's start/stop shape.
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic sweep. A no-op (logged, not thrown) if file_search is
 * unavailable — no database configured is the normal state for a
 * standalone install — or if already running.
 */
export function startExpirySweeper(): void {
  if (sweepTimer) return;
  if (!isFileSearchAvailable()) {
    logger.info('ExpirySweeper', 'file_search is unavailable (no database configured, or disabled); expiry sweeper not started');
    return;
  }
  sweepTimer = setInterval(() => {
    // sweepTick catches each pass itself.
    void sweepTick();
  }, SWEEP_INTERVAL_MS);
  // Never keep the process (or a test) alive just for this timer.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  logger.info('ExpirySweeper', `Started, sweeping every ${SWEEP_INTERVAL_MS}ms`);
}

/** Stops the periodic sweep. Safe to call when never started. Does not wait
 *  for an in-flight sweep tick — sweepOneStore's own per-store transaction
 *  is always left in a consistent committed-or-rolled-back state regardless
 *  of when the process exits. */
export function stopExpirySweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function __isRunningForTests(): boolean {
  return sweepTimer !== null;
}
