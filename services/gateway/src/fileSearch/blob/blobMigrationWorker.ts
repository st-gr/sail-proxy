/**
 * Blob migration, the worker side: moves each item's blob to the job's target storage. The
 * routes' side (start, cancel, retry, reads) is blobMigration.ts; the claim and the loop are
 * blobMigrationQueue.ts.
 *
 * One item per blob (`fs_blob_migration_items`), claimed like a re-embed item: a CTE with
 * `FOR UPDATE SKIP LOCKED`, a lease of LEASE_MINUTES (an item whose worker died is claimed again
 * once its lease expires), at most `ingestion.maxRetries` attempts. Per item:
 *   1. read the row (no lock). Gone: the item is deleted. Already on the target: completed;
 *   2. read the source bytes from the row's own storage and check their SHA-256 against the sha.
 *      A mismatch fails the item for good and leaves the row alone;
 *   3. s3 target: under the per-sha lock, cancel any pending garbage delete of the sha's s3 object
 *      (a stale entry from an earlier s3 -> db move would otherwise delete the copy about to be
 *      written); then PUT (content-addressed key);
 *   4. the switch, one transaction: per-sha lock, the item FOR UPDATE under its claim, the row
 *      FOR UPDATE. An item no longer this claim's and in progress (cancelled, reclaimed after its
 *      lease, failed by the reaper) moves nothing: a copy just PUT is queued as garbage unless a
 *      row uses it. Row gone: the item is deleted (and the copy queued). Already on the target:
 *      completed. Otherwise, for an s3 target, any garbage entry of the sha's s3 object is deleted
 *      and the object is read back (GET + SHA-256; never HEAD, which may answer 403 for a missing
 *      key) under the lock: the copy's only verification. Missing or wrong: the attempt fails and
 *      the row stays. The garbage pass deletes only under the same lock, so a copy verified there
 *      cannot vanish before the row points at it, however long the PUT took. Then
 *      storage/location/bytes switch (bytes set for db, NULL for s3), an external source object
 *      is queued in file_blob_garbage after a grace (the garbage pass drops the entry if a row of
 *      the sha is back in that storage), and the item completes.
 * A failure before the switch commits leaves the row on its source. A PUT already made is queued
 * as garbage on a handled failure; after a crash it stays (content-addressed: the retry writes
 * the same key). Released rows (delete_after set) are migrated like live ones: a row revived
 * after the job must not be left on the old storage, and the sweeper deletes a released row
 * wherever it is.
 *
 * Cancel (blobMigration.ts) turns open items `cancelled`, the one in flight included: its switch
 * then moves nothing, so a migration started right after the cancel sees every row where it
 * stays. Lock order: the switch takes the sha lock, then its item, then the blob row, and never
 * the job; cancel and retry take the job, then its items, and never a sha lock or a blob row, so
 * the two cannot wait on each other in a cycle. Nothing here lists a bucket: every object is
 * addressed through a row.
 */
import type { Pool, PoolClient } from 'pg';
import { getFileSearchConfig, FileSearchConfig } from '../../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { serializeError } from '../workQueue';
import {
  backendForStorage, lockBlobSha, sha256Of, unavailable, maxGetBytes, queueGarbage, BlobUnavailableError,
  BLOB_RELEASE_GRACE_SECONDS,
} from './blobStore';
import { withS3Slot } from './s3Slots';
import { errorSummary } from './blobSweeper';
import { finalizeBlobMigrationJob, inTransaction, requirePool } from './blobMigrationDb';
import { FileSearchBusyError } from '../dbBusy';
import { LEASE_MINUTES, BUSY_RETRY_SECONDS, BUSY_HANDBACK_SET } from '../workQueue';

const logger = getDefaultLogger();

type BlobStorageConfig = FileSearchConfig['blobStorage'];

export interface BlobMigrationItem {
  jobId: string;
  sha256: string;
  target: string;
  /** The claim's timestamp: updates of the item are guarded by it. */
  claimedAt: string;
}

/** The bytes do not hash to the blob's sha (`stage` source: permanent; target: retried). */
export class BlobMigrationVerifyError extends Error {
  constructor(readonly stage: 'source' | 'target') {
    super(`the ${stage} copy of the blob does not match its SHA-256`);
    this.name = 'BlobMigrationVerifyError';
  }
}

/** Test hooks; no-ops in production. */
export interface BlobMigrationHooks {
  /** After the target object was written (a db target: nothing yet), before the switch. */
  afterTargetWrite?: (item: BlobMigrationItem) => Promise<void>;
  /** Inside the switch transaction (its client), holding the locks, just before COMMIT. */
  beforeCommit?: (item: BlobMigrationItem, client: PoolClient) => Promise<void>;
}

export interface ProcessOptions {
  hooks?: BlobMigrationHooks;
  /** Grace before a source object is deleted (default BLOB_RELEASE_GRACE_SECONDS); for tests. */
  garbageGraceSeconds?: number;
}

export type ItemOutcome = 'completed' | 'vanished' | 'failed' | 'retry' | 'skipped';

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

type SourceRow = { storage: string; location: string | null; mime: string; bytes: Buffer | null; size_bytes: string | null };

async function readRow(pool: Pool, sha: string): Promise<SourceRow | null> {
  const { rows } = await pool.query<SourceRow>(
    `SELECT storage, location, mime, size_bytes, CASE WHEN storage = 'db' THEN bytes END AS bytes
       FROM file_blobs WHERE sha256 = $1`, [sha]);
  return rows[0] ?? null;
}

async function readSource(sha: string, row: SourceRow, cfg: BlobStorageConfig): Promise<Buffer | null> {
  if (row.storage === 'db') return row.bytes;
  try {
    return await backendForStorage(row.storage, cfg).get(sha, row.location, maxGetBytes(row.size_bytes));
  } catch (e) {
    throw unavailable(row.storage, e);
  }
}

type Copy = { bytes: Buffer; location: string | null };

/** Reads the target object back and checks its SHA-256 (a GET: HEAD may answer 403 for a missing key). */
async function verifyTarget(item: BlobMigrationItem, copy: Copy, cfg: BlobStorageConfig): Promise<void> {
  let back: Buffer | null;
  try {
    back = await backendForStorage(item.target, cfg).get(item.sha256, copy.location, maxGetBytes(copy.bytes.length));
  } catch (e) {
    throw unavailable(item.target, e);
  }
  if (!back || sha256Of(back) !== item.sha256) throw new BlobMigrationVerifyError('target');
}

const ITEM_GUARD = 'job_id = $1 AND sha256 = $2 AND claimed_at = $3::timestamptz';
const guardParams = (item: BlobMigrationItem) => [item.jobId, item.sha256, item.claimedAt];

type SwitchOutcome = 'completed' | 'vanished' | 'skipped';

/**
 * Step 4: the switch transaction. `copy` is what was read (and, for s3, written); null: nothing.
 * The read-back GET runs under the lock, so an external target takes an S3 slot first.
 */
async function switchRow(
  item: BlobMigrationItem, copy: Copy | null, cfg: BlobStorageConfig, opts: ProcessOptions,
): Promise<SwitchOutcome> {
  const put = copy !== null && item.target !== 'db';
  return put ? withS3Slot(() => switchRowLocked(item, copy, cfg, opts)) : switchRowLocked(item, copy, cfg, opts);
}

async function switchRowLocked(
  item: BlobMigrationItem, copy: Copy | null, cfg: BlobStorageConfig, opts: ProcessOptions,
): Promise<SwitchOutcome> {
  const grace = opts.garbageGraceSeconds ?? BLOB_RELEASE_GRACE_SECONDS;
  const put = copy !== null && item.target !== 'db';
  return inTransaction(async (client) => {
    await lockBlobSha(client, item.sha256);
    const mine = await client.query<{ status: string }>(
      `SELECT status FROM fs_blob_migration_items WHERE ${ITEM_GUARD} FOR UPDATE`, guardParams(item));
    const { rows } = await client.query<{ storage: string; location: string | null }>(
      'SELECT storage, location FROM file_blobs WHERE sha256 = $1 FOR UPDATE', [item.sha256]);
    const row = rows[0];
    let outcome: SwitchOutcome = 'completed';
    if (mine.rows[0]?.status !== 'in_progress') {
      // Cancelled, reclaimed or reaped since the claim: hands off. A copy no row uses is garbage.
      if (put && row?.storage !== item.target) await queueGarbage(client, item.target, copy!.location, item.sha256, grace);
      outcome = 'skipped';
    } else if (!row) {
      // Swept meanwhile: nothing to move. An object just written belongs to no row.
      if (put) await queueGarbage(client, item.target, copy!.location, item.sha256, grace);
      await client.query(`DELETE FROM fs_blob_migration_items WHERE ${ITEM_GUARD}`, guardParams(item));
      outcome = 'vanished';
    } else {
      if (row.storage !== item.target) {
        if (!copy) throw new Error('blob migration: the switch needs the copied bytes');
        if (put) {
          // Anything queued since step 3 may have deleted the copy already: verify it here, locked.
          await client.query('DELETE FROM file_blob_garbage WHERE sha256 = $1 AND storage = $2', [item.sha256, item.target]);
          await verifyTarget(item, copy, cfg);
        }
        await client.query(
          'UPDATE file_blobs SET storage = $2, location = $3, bytes = $4 WHERE sha256 = $1',
          [item.sha256, item.target, put ? copy.location : null, put ? null : copy.bytes]);
        await queueGarbage(client, row.storage, row.location, item.sha256, grace);
      }
      await client.query(
        `UPDATE fs_blob_migration_items SET status = 'completed', claimed_at = NULL, last_error = NULL WHERE ${ITEM_GUARD}`,
        guardParams(item));
    }
    if (opts.hooks?.beforeCommit) await opts.hooks.beforeCommit(item, client);
    return { commit: true, value: outcome };
  });
}

/** Step 3 for an external target: cancel stale garbage of the sha there, then PUT (verified in the switch). */
async function writeTarget(item: BlobMigrationItem, bytes: Buffer, mime: string, cfg: BlobStorageConfig): Promise<string | null> {
  const backend = backendForStorage(item.target, cfg);
  await inTransaction(async (client) => {
    await lockBlobSha(client, item.sha256);
    await client.query('DELETE FROM file_blob_garbage WHERE sha256 = $1 AND storage = $2', [item.sha256, item.target]);
    return { commit: true, value: undefined };
  });
  try {
    return (await backend.put(item.sha256, bytes, mime)).location;
  } catch (e) {
    throw unavailable(item.target, e);
  }
}

/** After a handled failure: an object written to the target that no row uses goes to garbage. */
async function discardCopy(item: BlobMigrationItem, location: string | null, grace: number): Promise<void> {
  await inTransaction(async (client) => {
    await lockBlobSha(client, item.sha256);
    const used = await client.query('SELECT 1 FROM file_blobs WHERE sha256 = $1 AND storage = $2', [item.sha256, item.target]);
    if ((used.rowCount ?? 0) === 0) await queueGarbage(client, item.target, location, item.sha256, grace);
    return { commit: true, value: undefined };
  }).catch(() => {}); // best effort: a stray content-addressed object loses nothing
}

function isPermanent(error: unknown): boolean {
  if (error instanceof BlobMigrationVerifyError) return error.stage === 'source';
  return error instanceof BlobUnavailableError
    && (error.reason === 'unsupported_storage' || error.reason === 'location_unreachable');
}

/** A busy pool is not the blob's fault: handed back without spending an attempt (BUSY_HANDBACK_SET). */
async function handBackBusy(pool: Pool, item: BlobMigrationItem, error: FileSearchBusyError): Promise<ItemOutcome> {
  logger.warn('BlobMigration', 'Moving a blob deferred: the database pool is busy', { jobId: item.jobId, sha256: item.sha256 });
  await pool.query(
    `UPDATE fs_blob_migration_items SET ${BUSY_HANDBACK_SET}, last_error = $6::jsonb
      WHERE job_id = $3 AND sha256 = $4 AND claimed_at = $5::timestamptz AND status = 'in_progress'`,
    [BUSY_RETRY_SECONDS, LEASE_MINUTES, item.jobId, item.sha256, item.claimedAt, JSON.stringify(serializeError(error))],
  ).catch(() => {}); // the lease expires instead
  return 'retry';
}

async function handleItemFailure(pool: Pool, item: BlobMigrationItem, error: unknown): Promise<ItemOutcome> {
  if (error instanceof FileSearchBusyError) return handBackBusy(pool, item, error);
  const { maxRetries } = getFileSearchConfig().ingestion;
  logger.warn('BlobMigration', 'Moving a blob failed', { jobId: item.jobId, sha256: item.sha256, ...errorSummary(error) });
  const { rows } = await pool.query<{ status: string }>(
    `UPDATE fs_blob_migration_items
        SET status = CASE WHEN $4::boolean OR attempts >= $5 THEN 'failed' ELSE 'in_progress' END,
            claimed_at = NULL, last_error = $6::jsonb
      WHERE ${ITEM_GUARD} AND status = 'in_progress'
      RETURNING status`,
    [...guardParams(item), isPermanent(error), maxRetries, JSON.stringify(serializeError(error))]);
  if (rows[0]?.status !== 'failed') return 'retry';
  await finalizeBlobMigrationJob(item.jobId);
  return 'failed';
}

/** Moves one claimed item's blob to the job's target (steps 1-4 of the module comment). */
export async function processBlobMigrationItem(item: BlobMigrationItem, opts: ProcessOptions = {}): Promise<ItemOutcome> {
  try {
    return await processBlobMigrationItemUnguarded(item, opts);
  } catch (error) {
    // A busy pool outside the attempt's own error handling (its first read): hand it back too.
    if (!(error instanceof FileSearchBusyError)) throw error;
    return handBackBusy(requirePool(), item, error);
  }
}

async function processBlobMigrationItemUnguarded(item: BlobMigrationItem, opts: ProcessOptions): Promise<ItemOutcome> {
  const pool = requirePool();
  const ctx = await pool.query<{ status: string; cancel_requested: boolean; finished_at: Date | null }>(
    `SELECT i.status, j.cancel_requested, j.finished_at FROM fs_blob_migration_items i
       JOIN fs_jobs j ON j.id = i.job_id WHERE i.job_id = $1 AND i.sha256 = $2`, [item.jobId, item.sha256]);
  const c = ctx.rows[0];
  if (!c || c.status !== 'in_progress' || c.cancel_requested || c.finished_at) return 'skipped';
  const cfg = getFileSearchConfig().blobStorage;
  let written: { location: string | null } | null = null;
  let outcome: ItemOutcome;
  try {
    const row = await readRow(pool, item.sha256);
    if (!row || row.storage === item.target) {
      outcome = await switchRow(item, null, cfg, opts);
    } else {
      const bytes = await readSource(item.sha256, row, cfg);
      if (!bytes) throw new BlobUnavailableError(row.storage, 'missing');
      if (sha256Of(bytes) !== item.sha256) throw new BlobMigrationVerifyError('source');
      let location: string | null = null;
      if (item.target !== 'db') {
        location = await writeTarget(item, bytes, row.mime, cfg);
        written = { location };
      }
      if (opts.hooks?.afterTargetWrite) await opts.hooks.afterTargetWrite(item);
      outcome = await switchRow(item, { bytes, location }, cfg, opts);
    }
  } catch (error) {
    if (written) await discardCopy(item, written.location, opts.garbageGraceSeconds ?? BLOB_RELEASE_GRACE_SECONDS);
    return handleItemFailure(pool, item, error);
  }
  await finalizeBlobMigrationJob(item.jobId);
  return outcome;
}
