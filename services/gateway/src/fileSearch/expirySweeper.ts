/**
 * Periodic expiry sweeper for file_search vector stores.
 *
 * Finds stores past their `expires_at` deadline and, for each one, deletes
 * its `vector_store_chunks` and `vector_store_files` rows and flips
 * `status` to `'expired'` — mirroring `repository.ts`'s `deleteStoreCascade`
 * exactly, except the `vector_stores` row itself is kept (not deleted) and
 * its status is set rather than the row removed.
 *
 * CORRECTED SCOPE (see the plan's Task 12 hand-off note): this must NOT run
 * "the same refcount-decrement cascade as deletion" — that would be wrong.
 * Files persist independently of vector-store attachment; OpenAI's own
 * reference is explicit that removing a vector-store file does not delete
 * the underlying file. This sweeper therefore NEVER touches `fs_files` rows
 * or blob bytes — `DELETE /files/{id}` remains the only path that frees
 * them. An expired store keeps its row and reports `status: "expired"`
 * rather than 404-ing, matching every other read path in this feature (see
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
    sweepExpiredStores().catch((error) => {
      logger.error('ExpirySweeper', 'Sweep tick failed',
        error instanceof Error ? error : new Error(String(error)));
    });
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
