/**
 * Blob sweeper: deletes released blobs once their grace has passed, and the external objects
 * queued in `file_blob_garbage`.
 *
 * Every replica runs it (no leader election, like the other file_search sweepers); correctness
 * rests on the per-sha advisory lock and row locks. Candidates are found with a CTE
 * `FOR UPDATE SKIP LOCKED` (rows another replica is sweeping right now are skipped); each one is
 * then handled in its own transaction:
 *   1. the per-sha advisory lock, then the row `FOR UPDATE` (the order retain uses);
 *   2. re-check `ref_count = 0 AND delete_after < now()` (a retain may have revived it);
 *   3. DELETE the row. 23503 (an fs_files row still references it) is refcount drift: the row is
 *      repaired from the actual fs_files count instead. 40P01 (a deadlock, possible only on such a
 *      drifted row) skips it until the next sweep;
 *   4. delete the object (external storage only). A missing key is gone already (the backend
 *      takes 404 as success; S3 answers 204); any other refusal, a 403 included, is a failure;
 *   5. COMMIT.
 * A failed object delete rolls back, so the row survives and is retried later. An object deleted
 * whose COMMIT then fails is safe: the row stays pending, and a revive PUTs the bytes again.
 *
 * A row whose storage this gateway cannot address (an unknown storage, missing S3 config or
 * credentials, a location outside the configured prefix) cannot be retried usefully every sweep
 * and file_blobs has no column for attempts, so the row is deleted and its object is handed to
 * file_blob_garbage, which keeps attempts, last_error and a backoff. A later write of the same
 * content cancels that entry (retain).
 *
 * Garbage entries are claimed with a lease (delete_after pushed out), then deleted by exact key
 * under the entry's per-sha lock. An entry whose sha has a row in the same storage is dropped
 * WITHOUT deleting anything: the backend resolves a legacy URL location, or no location, to the
 * row's own content-addressed key, so comparing location strings could delete a live object. The
 * accepted cost is that an old-prefix object of that sha may be left behind. Nothing here ever
 * lists a bucket.
 */
import type { Pool, PoolClient } from 'pg';
import { getPool, isFileSearchAvailable } from '../db';
import { getFileSearchConfig, FileSearchConfig } from '../../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { backendForStorage, lockBlobSha, BlobUnavailableError } from './blobStore';
import { S3ConfigError, S3LocationError, S3RequestError } from './s3Backend';
import { withS3Slot, withS3SlotIfNeeded, NeedsS3SlotError } from './s3Slots';

const logger = getDefaultLogger();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A gateway restarted more often than the interval would never sweep: one sweep soon after start.
const FIRST_SWEEP_DELAY_MS = 60 * 1000;
// Bounds one tick's work; a backlog is picked up by the next tick.
const SWEEP_BATCH_LIMIT = 200;
// A failed object delete of a pending row is retried after this (file_blobs has no attempts column).
const ROW_RETRY_SECONDS = 15 * 60;
// A claimed garbage entry is not claimed again for this long (a crash mid-delete retries after it).
const GARBAGE_LEASE_SECONDS = 10 * 60;
const WARN_EVERY_MS = 60 * 60 * 1000;

const SHA_RE = /^[0-9a-f]{64}$/;

type BlobStorageConfig = FileSearchConfig['blobStorage'];

/** Test hooks; all no-ops in production. */
export interface BlobSweepHooks {
  /** Before a candidate row's transaction begins. */
  beforeRow?: (sha: string) => Promise<void>;
  /** After the re-check, holding the advisory and row locks. */
  afterRecheck?: (sha: string) => Promise<void>;
  /** After the row and object deletes, just before COMMIT. */
  beforeCommit?: (sha: string) => Promise<void>;
  /** Before a claimed garbage entry's transaction begins. */
  beforeGarbage?: (entry: { storage: string; location: string; sha256: string }) => Promise<void>;
  /** After a garbage entry's re-check, holding its locks, before the object delete. */
  beforeGarbageDelete?: (entry: { storage: string; location: string; sha256: string }) => Promise<void>;
}

export interface BlobSweepResult {
  deleted: number;
  repaired: number;
  parked: number;
  failed: number;
  skipped: number;
  garbageDeleted: number;
  garbageFailed: number;
}

const lastWarned = new Map<string, number>();

function warnRateLimited(key: string, message: string, meta: Record<string, unknown>): void {
  const now = Date.now();
  if ((lastWarned.get(key) ?? 0) + WARN_EVERY_MS > now) return;
  lastWarned.set(key, now);
  logger.warn('BlobSweeper', message, meta);
}

export function __resetWarningsForTests(): void {
  lastWarned.clear();
}

/** An operator-facing error summary: storage, reason, S3 operation/status/code. Never a key, bucket or host. */
export function errorSummary(e: unknown): Record<string, unknown> {
  if (e instanceof S3RequestError) return { reason: 'request_failed', op: e.op, status: e.status, code: e.code };
  if (e instanceof S3LocationError) return { reason: 'location_unreachable' };
  if (e instanceof S3ConfigError) return { reason: 'not_configured', message: e.message };
  if (e instanceof BlobUnavailableError) return { reason: e.reason, storage: e.storage, message: e.message };
  const sqlstate = (e as { code?: unknown } | null)?.code;
  if (typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) return { reason: 'database', sqlstate };
  return { reason: 'error', name: e instanceof Error ? e.name : typeof e };
}

/** A storage this gateway cannot address now: retrying the row each sweep cannot help. */
function isUnaddressable(e: unknown): boolean {
  return e instanceof S3LocationError || e instanceof S3ConfigError
    || (e instanceof BlobUnavailableError && e.reason !== 'request_failed' && e.reason !== 'missing');
}

async function deleteObject(storage: string, sha: string, location: string | null, cfg: BlobStorageConfig): Promise<void> {
  if (storage === 'db') return;
  await backendForStorage(storage, cfg).delete(sha, location);
}

type RowOutcome = 'deleted' | 'repaired' | 'parked' | 'failed' | 'skipped';

/** One row; an external one holds an S3 slot (taken before the connection: see s3Slots.ts). */
async function sweepOneBlob(
  pool: Pool, sha: string, storage: string, cfg: BlobStorageConfig, hooks: BlobSweepHooks,
): Promise<RowOutcome> {
  return withS3SlotIfNeeded(storage !== 'db', (holding) => sweepOneBlobOnce(pool, sha, cfg, hooks, holding));
}

async function sweepOneBlobOnce(
  pool: Pool, sha: string, cfg: BlobStorageConfig, hooks: BlobSweepHooks, holding: boolean,
): Promise<RowOutcome> {
  const client = await pool.connect();
  let broken: Error | undefined; // a failed ROLLBACK: the connection must not go back to the pool
  const rollback = () => client.query('ROLLBACK').then(() => undefined, (e: Error) => { broken = e; });
  let outcome: RowOutcome = 'skipped';
  try {
    await client.query('BEGIN');
    await lockBlobSha(client, sha);
    const { rows } = await client.query<{ storage: string; location: string | null; due: boolean }>(
      `SELECT storage, location, (ref_count = 0 AND delete_after < now()) AS due
         FROM file_blobs WHERE sha256 = $1 FOR UPDATE`, [sha]);
    if (!rows[0]?.due) {
      await rollback();
      return 'skipped';
    }
    const { storage, location } = rows[0];
    if (storage !== 'db' && !holding) throw new NeedsS3SlotError(); // moved since the candidate query
    if (hooks.afterRecheck) await hooks.afterRecheck(sha);
    await client.query('SAVEPOINT row_delete');
    try {
      await client.query('DELETE FROM file_blobs WHERE sha256 = $1', [sha]);
    } catch (e: any) {
      if (e?.code !== '23503') throw e;
      await client.query('ROLLBACK TO SAVEPOINT row_delete');
      const repaired = await client.query<{ ref_count: number }>(
        `UPDATE file_blobs b SET ref_count = c.n, delete_after = NULL
           FROM (SELECT count(*)::int AS n FROM fs_files WHERE sha256 = $1) c
          WHERE b.sha256 = $1 AND c.n > 0 RETURNING b.ref_count`, [sha]);
      await client.query('COMMIT');
      logger.warn('BlobSweeper', 'A released blob is still referenced (refcount drift); ref_count repaired',
        { sha256: sha, refCount: repaired.rows[0]?.ref_count ?? null });
      return 'repaired';
    }
    outcome = 'deleted';
    try {
      await deleteObject(storage, sha, location, cfg);
    } catch (e) {
      if (!isUnaddressable(e)) throw e;
      // Hand the object to file_blob_garbage, which keeps attempts and backs off.
      const summary = errorSummary(e);
      await client.query(
        `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after, attempts, last_error)
         VALUES ($1, $2, $3, now() + make_interval(mins => 2), 1, $4)
         ON CONFLICT (storage, location) DO UPDATE SET sha256 = EXCLUDED.sha256, delete_after = EXCLUDED.delete_after,
           attempts = file_blob_garbage.attempts + 1, last_error = EXCLUDED.last_error`,
        [storage, location ?? sha, sha, JSON.stringify(summary)]);
      warnRateLimited(`park:${storage}:${summary.reason}`,
        'A released blob\'s object cannot be deleted from its storage now; queued for retry', summary);
      outcome = 'parked';
    }
    if (hooks.beforeCommit) await hooks.beforeCommit(sha);
    await client.query('COMMIT');
    return outcome;
  } catch (e: any) {
    await rollback();
    if (e instanceof NeedsS3SlotError) throw e;
    if (e?.code === '40P01') {
      logger.warn('BlobSweeper', 'Deadlock deleting a released blob (refcount drift?); retried next sweep', { sha256: sha });
      return 'skipped';
    }
    // The row stays pending; try again after a pause rather than every tick.
    await pool.query(
      `UPDATE file_blobs SET delete_after = now() + make_interval(secs => $2)
        WHERE sha256 = $1 AND ref_count = 0 AND delete_after IS NOT NULL`, [sha, ROW_RETRY_SECONDS]).catch(() => {});
    warnRateLimited(`row:${errorSummary(e).reason}`, 'Deleting a released blob failed; retried later',
      { sha256: sha, ...errorSummary(e), stage: outcome === 'deleted' ? 'object_or_commit' : 'row' });
    return 'failed';
  } finally {
    client.release(broken);
  }
}

type GarbageEntry = { storage: string; location: string; sha256: string; lease: string };

/** One entry, holding an S3 slot for an external storage (taken before the connection). */
async function sweepOneGarbage(
  pool: Pool, entry: GarbageEntry, cfg: BlobStorageConfig, hooks: BlobSweepHooks,
): Promise<boolean> {
  const work = () => sweepOneGarbageLocked(pool, entry, cfg, hooks);
  return entry.storage === 'db' ? work() : withS3Slot(work);
}

async function sweepOneGarbageLocked(
  pool: Pool, entry: GarbageEntry, cfg: BlobStorageConfig, hooks: BlobSweepHooks,
): Promise<boolean> {
  const client: PoolClient = await pool.connect();
  let broken: Error | undefined;
  const rollback = () => client.query('ROLLBACK').then(() => undefined, (e: Error) => { broken = e; });
  try {
    await client.query('BEGIN');
    if (SHA_RE.test(entry.sha256)) await lockBlobSha(client, entry.sha256);
    // Still ours: not cancelled by a write of the key, not re-enqueued with a new grace.
    const mine = await client.query(
      `SELECT 1 FROM file_blob_garbage WHERE storage = $1 AND location = $2 AND delete_after = $3::timestamptz FOR UPDATE`,
      [entry.storage, entry.location, entry.lease]);
    if (mine.rowCount === 0) {
      await rollback();
      return true;
    }
    // Any row of this sha in this storage: its key may be the one this entry resolves to.
    const inUse = await client.query(
      'SELECT 1 FROM file_blobs WHERE sha256 = $1 AND storage = $2', [entry.sha256, entry.storage]);
    if (hooks.beforeGarbageDelete) await hooks.beforeGarbageDelete(entry);
    if (inUse.rowCount === 0) {
      // A row parked without a location carries its sha as the location (see sweepOneBlob).
      const location = entry.location === entry.sha256 ? null : entry.location;
      await deleteObject(entry.storage, entry.sha256, location, cfg);
    }
    await client.query('DELETE FROM file_blob_garbage WHERE storage = $1 AND location = $2', [entry.storage, entry.location]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await rollback();
    const summary = errorSummary(e);
    await pool.query(
      `UPDATE file_blob_garbage SET attempts = attempts + 1, last_error = $3,
              -- backoff: 2^attempts minutes, capped at a day
              delete_after = now() + make_interval(mins => LEAST(power(2, LEAST(attempts + 1, 11)), 1440)::int)
        WHERE storage = $1 AND location = $2 AND delete_after = $4::timestamptz -- still our lease`,
      [entry.storage, entry.location, JSON.stringify(summary), entry.lease]).catch(() => {});
    warnRateLimited(`garbage:${entry.storage}:${summary.reason}`, 'Deleting a queued blob object failed; retried later', summary);
    return false;
  } finally {
    client.release(broken);
  }
}

/**
 * One sweep pass over due released blobs and due garbage entries. A no-op without a database.
 * `batch` and `hooks` are for tests.
 */
export async function sweepBlobs(
  opts: { batch?: number; hooks?: BlobSweepHooks } = {},
): Promise<BlobSweepResult> {
  const result: BlobSweepResult = { deleted: 0, repaired: 0, parked: 0, failed: 0, skipped: 0, garbageDeleted: 0, garbageFailed: 0 };
  const pool = getPool();
  if (!pool) return result;
  const batch = opts.batch ?? SWEEP_BATCH_LIMIT;
  const hooks = opts.hooks ?? {};
  const cfg = getFileSearchConfig().blobStorage;

  const { rows: due } = await pool.query<{ sha256: string; storage: string }>(
    `WITH c AS (
       SELECT sha256, storage FROM file_blobs
        WHERE delete_after < now() AND ref_count = 0
        ORDER BY delete_after LIMIT $1
        FOR UPDATE SKIP LOCKED)
     SELECT sha256, storage FROM c`, [batch]);
  for (const { sha256, storage } of due) {
    if (hooks.beforeRow) await hooks.beforeRow(sha256);
    // Sequential: one row lock and one connection at a time.
    // eslint-disable-next-line no-await-in-loop
    result[await sweepOneBlob(pool, sha256, storage, cfg, hooks)] += 1;
  }

  const { rows: garbage } = await pool.query<GarbageEntry>(
    `WITH c AS (
       SELECT storage, location FROM file_blob_garbage
        WHERE delete_after < now()
        ORDER BY delete_after LIMIT $1
        FOR UPDATE SKIP LOCKED)
     UPDATE file_blob_garbage g SET delete_after = now() + make_interval(secs => $2)
       FROM c WHERE g.storage = c.storage AND g.location = c.location
     RETURNING g.storage, g.location, g.sha256, g.delete_after::text AS lease`, [batch, GARBAGE_LEASE_SECONDS]);
  for (const entry of garbage) {
    if (hooks.beforeGarbage) await hooks.beforeGarbage(entry);
    // eslint-disable-next-line no-await-in-loop
    if (await sweepOneGarbage(pool, entry, cfg, hooks)) result.garbageDeleted += 1;
    else result.garbageFailed += 1;
  }

  if (result.deleted + result.repaired + result.parked + result.garbageDeleted > 0) {
    logger.info('BlobSweeper', 'Sweep finished', { ...result });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Interval driver: the start/stop shape of jobSweeper.ts.
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;

function runSweep(what: string): void {
  sweepBlobs().catch((error) => {
    logger.error('BlobSweeper', `${what} failed`, error instanceof Error ? error : new Error(String(error)));
  });
}

/** Starts the periodic sweep. A no-op (logged) when file_search is unavailable or already running. */
export function startBlobSweeper(): void {
  if (sweepTimer) return;
  if (!isFileSearchAvailable()) {
    logger.info('BlobSweeper', 'file_search is unavailable (no database configured, or disabled); blob sweeper not started');
    return;
  }
  sweepTimer = setInterval(() => runSweep('Sweep tick'), SWEEP_INTERVAL_MS);
  firstSweepTimer = setTimeout(() => {
    firstSweepTimer = null;
    runSweep('First sweep');
  }, FIRST_SWEEP_DELAY_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  if (typeof firstSweepTimer.unref === 'function') firstSweepTimer.unref();
  logger.info('BlobSweeper', `Started, sweeping every ${SWEEP_INTERVAL_MS}ms`);
}

/** Stops the periodic sweep. Safe to call when never started; an in-flight row commits or rolls back on its own. */
export function stopBlobSweeper(): void {
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
