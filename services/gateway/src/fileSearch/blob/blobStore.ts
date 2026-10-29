import * as crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db';
import { getFileSearchConfig, FileSearchConfig } from '../../services/configService';
import { createDbBackend } from './dbBackend';
import { createS3Backend, S3ConfigError, S3Credentials, S3LocationError } from './s3Backend';
import { withS3SlotIfNeeded, NeedsS3SlotError, S3SlotBusyError, S3_SLOT_WAIT_MS } from './s3Slots';

/**
 * Content-addressed blob store. Lifecycle of a `file_blobs` row:
 * - live: `ref_count > 0`, `delete_after` NULL;
 * - pending delete: the last reference was released (`ref_count = 0`, `delete_after` set). Nothing
 *   is deleted here; the blob sweeper removes the row and then the object once `delete_after` has
 *   passed. The grace keeps the bytes readable for a reader that resolved the row just before;
 * - revived: a retain of a pending row clears `delete_after` and, for external storage, PUTs the
 *   bytes again (a sweeper's object delete may have completed even though its transaction did not).
 *
 * Every read dispatches on the row's own `storage`/`location`, never on the configured backend, so a
 * backend switch never orphans existing blobs. The configured backend decides only where NEW blobs go.
 */

export interface BlobBackend {
  put(sha256: string, bytes: Buffer, mime: string): Promise<{ location: string | null }>;
  /** `maxBytes`: the largest body an external backend accepts (see maxGetBytes). */
  get(sha256: string, location?: string | null, maxBytes?: number): Promise<Buffer | null>;
  delete(sha256: string, location?: string | null): Promise<void>;
  exists(sha256: string, location?: string | null): Promise<boolean>;
}

type BlobStorageConfig = FileSearchConfig['blobStorage'];

export function sha256Of(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Slack over a blob's recorded size that a GET still accepts. */
export const GET_SIZE_MARGIN_BYTES = 64 * 1024;

/**
 * The largest body a GET of a blob accepts: its recorded size plus a margin, else (size unknown)
 * the configured upload limit plus the margin. A response beyond it is refused, never buffered.
 */
export function maxGetBytes(sizeBytes: number | string | null | undefined): number {
  const size = sizeBytes === null || sizeBytes === undefined ? NaN : Number(sizeBytes);
  if (Number.isFinite(size) && size >= 0) return size + GET_SIZE_MARGIN_BYTES;
  return getFileSearchConfig().limits.maxFileBytes + GET_SIZE_MARGIN_BYTES;
}

/** Grace between the last release and the sweeper's delete (a constant: no api_config key). */
export const BLOB_RELEASE_GRACE_SECONDS = 15 * 60;

/**
 * Per-sha advisory lock: the two-int4 form `pg_advisory_xact_lock(BLOB_LOCK_CLASS, blobLockKey(sha))`.
 * - class: 'blob' packed as an int4 (0x626c6f62). The two-key form is a different lock space from the
 *   one-bigint `MIGRATION_LOCK_KEY`, so the two never collide.
 * - key: the sha's first 8 hex digits (32 bits) as a signed int4. Two shas sharing them only
 *   serialise against each other, which is harmless.
 * Taken by retain before it reads the row, and by every object put/delete elsewhere (sweeper,
 * migration) before it touches the object, so no PUT and DELETE of one content-addressed key overlap.
 * Transaction-scoped: released at COMMIT/ROLLBACK.
 */
export const BLOB_LOCK_CLASS = 0x626c6f62;

const SHA_RE = /^[0-9a-f]{64}$/;

export function blobLockKey(sha: string): number {
  if (!SHA_RE.test(sha)) throw new Error('Invalid sha256 key');
  return parseInt(sha.slice(0, 8), 16) | 0;
}

export async function lockBlobSha(client: PoolClient, sha: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [BLOB_LOCK_CLASS, blobLockKey(sha)]);
}

/** `blob_storage.backend` is set to a backend that cannot store new blobs ("local"). */
export class UnsupportedBlobBackendError extends Error {
  constructor(backend: string) {
    super(`blob_storage.backend "${backend}" is not supported. Use "db" or "s3".`);
    this.name = 'UnsupportedBlobBackendError';
  }
}

export type BlobUnavailableReason =
  /** The row's storage is not one this gateway can read ("local", or an unknown value). */
  | 'unsupported_storage'
  /** blob_storage.s3 or the S3 credentials are missing or invalid. */
  | 'not_configured'
  /** The stored location is not under the configured prefix. */
  | 'location_unreachable'
  /** The storage request failed (status, timeout, network). */
  | 'request_failed'
  /** No row, no bytes, or the object is gone. */
  | 'missing';

/**
 * A blob's bytes cannot be read or written in its storage. Operator-facing: the message names the
 * storage and the reason, never a URL, bucket, key or credential. API callers map it to a 503 with a
 * generic message.
 */
export class BlobUnavailableError extends Error {
  constructor(readonly storage: string, readonly reason: BlobUnavailableReason, detail?: string) {
    super(`blob storage "${storage}" is unavailable for this blob (${reason})${detail ? `: ${detail}` : ''}`);
    this.name = 'BlobUnavailableError';
  }
}

let testS3Credentials: S3Credentials | null = null;

/** Tests inject their MinIO keys here; production reads FILE_SEARCH_S3_* per call. */
export function setBlobS3CredentialsForTests(credentials: S3Credentials | null): void {
  testS3Credentials = credentials;
}

function buildS3(cfg: BlobStorageConfig) {
  return createS3Backend(cfg.s3, testS3Credentials ? { credentials: testS3Credentials } : {});
}

/**
 * For the admin panel, without a request: whether `blob_storage.s3` is a valid configuration and
 * whether the S3 credentials are set. A wrong bucket or key shows only in a connection test.
 */
export function s3Readiness(cfg: BlobStorageConfig = getFileSearchConfig().blobStorage): { configured: boolean; credentialsPresent: boolean } {
  let configured = true;
  try {
    buildS3(cfg);
  } catch {
    configured = false;
  }
  const credentialsPresent = testS3Credentials !== null
    || (!!process.env.FILE_SEARCH_S3_ACCESS_KEY_ID && !!process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY);
  return { configured, credentialsPresent };
}

/** Any error of a storage operation as a BlobUnavailableError (also for the blob migration). */
export function unavailable(storage: string, e: unknown): BlobUnavailableError {
  if (e instanceof BlobUnavailableError) return e;
  if (e instanceof S3ConfigError) return new BlobUnavailableError(storage, 'not_configured', e.message);
  if (e instanceof S3LocationError) return new BlobUnavailableError(storage, 'location_unreachable');
  return new BlobUnavailableError(storage, 'request_failed', e instanceof Error ? e.message : undefined);
}

/**
 * The backend that holds blobs stored as `storage`, built from `cfg` (resolve it once per operation).
 * Throws BlobUnavailableError for a storage this gateway cannot address. For the sweeper and the
 * migration as much as for reads.
 */
export function backendForStorage(storage: string, cfg: BlobStorageConfig = getFileSearchConfig().blobStorage): BlobBackend {
  if (storage === 'db') return createDbBackend();
  if (storage !== 's3') throw new BlobUnavailableError(storage, 'unsupported_storage');
  try {
    return buildS3(cfg);
  } catch (e) {
    throw unavailable(storage, e);
  }
}

/**
 * The backend NEW blobs are written to (the configured one). Refuses only "local"; an s3
 * configuration error surfaces as S3ConfigError.
 */
export function getBackend(cfg: BlobStorageConfig = getFileSearchConfig().blobStorage): BlobBackend {
  switch (cfg.backend) {
    case 's3':
      return buildS3(cfg);
    case 'db':
      return createDbBackend();
    default:
      throw new UnsupportedBlobBackendError(cfg.backend);
  }
}

/** Cancels a pending garbage delete of the key about to be written (see the sweeper). */
async function cancelGarbage(client: PoolClient, storage: string, location: string | null): Promise<void> {
  if (storage === 'db' || !location) return;
  await client.query('DELETE FROM file_blob_garbage WHERE storage = $1 AND location = $2', [storage, location]);
}

/**
 * Queues an external object for the sweeper's garbage pass after `graceSeconds` (a db "object" is
 * the row itself: nothing to queue). An object without a location is queued under its sha. The
 * garbage pass deletes it only while no row of that sha is in that storage, under the sha lock.
 */
export async function queueGarbage(
  client: PoolClient, storage: string, location: string | null, sha: string, graceSeconds = BLOB_RELEASE_GRACE_SECONDS,
): Promise<void> {
  if (storage === 'db') return;
  await client.query(
    `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     ON CONFLICT (storage, location) DO UPDATE SET sha256 = EXCLUDED.sha256, delete_after = EXCLUDED.delete_after`,
    [storage, location ?? sha, sha, graceSeconds]);
}

/**
 * Content-addressed acquire. Under the per-sha advisory lock and the row lock:
 * - external configured backend (s3): the bytes are PUT to the content-addressed key FIRST, whether
 *   or not the content exists already. Then: no row → INSERT; a row in that storage → ref_count + 1
 *   (a pending one revived), its location set to the key just written; a row elsewhere (db) →
 *   ref_count + 1, and the object just written belongs to no row, so it is queued as garbage;
 * - db configured: no row → INSERT with the bytes; a pending row in external storage is revived
 *   with a re-PUT to its OWN storage (never an exists check: a missing key may answer 403); any
 *   other row → ref_count + 1 (and revived).
 * The PUT runs inside the transaction (bounded by the S3 transfer deadline): a PUT before BEGIN
 * could land after a sweeper deleted the object and the row. Every S3 request here holds an S3 slot
 * (s3Slots.ts), taken before the connection. The INSERT keeps ON CONFLICT for a writer that does
 * not take the lock (an older replica during a rolling deploy).
 *
 * `deduplicated` is for metrics/logging ONLY. It must never leak into an API response, a status
 * code, or response timing: that would let a caller discover whether another user already has a
 * given file's bytes on file by uploading a guess (an existence oracle). What holds: with an
 * external backend configured, new and duplicate content make the same S3 request and get the same
 * status, a storage outage included (503 for both). A small database-side difference remains (an
 * INSERT against an UPDATE, possibly a garbage row), far below the PUT's own variance. With db
 * configured, a new upload and a duplicate of a db row touch no external storage, but a duplicate
 * that revives a RELEASED s3 row re-PUTs the bytes to S3 (its own storage), so there an S3 outage
 * answers 503 for that duplicate only: a released row has no file left, so this reveals only that
 * the content was uploaded and deleted within the last grace period.
 */
export async function retainBlob(
  sha: string, bytes: Buffer, mime: string,
): Promise<{ deduplicated: boolean }> {
  return withRetainTransaction((_client, retain) => retain(sha, bytes, mime));
}

/** Retains a blob on the transaction `withRetainTransaction` opened (see retainBlob). */
export type RetainInTransaction = (sha: string, bytes: Buffer, mime: string) => Promise<{ deduplicated: boolean }>;

/**
 * Runs `work` in ONE transaction in which it may retain a blob (`retain`, retainBlob's semantics) and
 * write the rows that reference it, so the reference and the refcount commit or roll back together.
 * retainBlob is this with a `work` that only retains. The S3 slot rule is retainBlob's: a slot is
 * taken before the connection when the configured backend is external, and a `work` that learns
 * under the lock that it needs one (NeedsS3SlotError) is rolled back and run again holding a slot,
 * so `work` must be safe to run twice (it only reads and writes inside this transaction).
 */
export async function withRetainTransaction<T>(
  work: (client: PoolClient, retain: RetainInTransaction) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database not configured');
  const cfg = getFileSearchConfig().blobStorage;
  // The backend new content goes to: resolved before anything else, so a misconfiguration answers
  // the same for new and duplicate content.
  let target: BlobBackend | null = null;
  if (cfg.backend !== 'db') {
    try {
      target = getBackend(cfg);
    } catch (e) {
      throw e instanceof UnsupportedBlobBackendError ? e : unavailable(cfg.backend, e);
    }
  }
  try {
    return await withS3SlotIfNeeded(target !== null,
      (holding) => retainTransactionOnce(pool, work, cfg, target, holding),
      { waitMs: S3_SLOT_WAIT_MS, storage: cfg.backend });
  } catch (e) {
    if (e instanceof S3SlotBusyError) throw new BlobUnavailableError(e.storage, 'request_failed', e.message);
    throw e;
  }
}

async function retainTransactionOnce<T>(
  pool: Pool, work: (client: PoolClient, retain: RetainInTransaction) => Promise<T>, cfg: BlobStorageConfig,
  target: BlobBackend | null, holding: boolean,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client, (sha, bytes, mime) => retainIn(client, sha, bytes, mime, cfg, target, holding));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    // Swallow a failing ROLLBACK: it fires precisely when the connection is
    // already broken, and letting it throw replaces the error that explains why.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function retainIn(
  client: PoolClient, sha: string, bytes: Buffer, mime: string, cfg: BlobStorageConfig, target: BlobBackend | null,
  holding: boolean,
): Promise<{ deduplicated: boolean }> {
  await lockBlobSha(client, sha);
  const existing = await client.query<{ storage: string; location: string | null; delete_after: Date | null }>(
    'SELECT storage, location, delete_after FROM file_blobs WHERE sha256 = $1 FOR UPDATE', [sha]);
  let written: string | null = null;
  if (target) {
    try {
      ({ location: written } = await target.put(sha, bytes, mime));
    } catch (e) {
      throw unavailable(cfg.backend, e);
    }
  }
  let deduplicated = true;
  if (existing.rowCount === 0) {
    const storage = cfg.backend;
    await cancelGarbage(client, storage, written);
    await client.query(
      `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, location)
       VALUES ($1,$2,$3,1,$4,$5,$6) ON CONFLICT (sha256) DO UPDATE
         SET ref_count = file_blobs.ref_count + 1`,
      [sha, bytes.length, mime, storage, storage === 'db' ? bytes : null, written]);
    deduplicated = false;
  } else {
    const { storage, delete_after: deleteAfter } = existing.rows[0];
    let { location } = existing.rows[0];
    if (target && storage === cfg.backend) {
      // The key just written is the row's (back under the configured prefix if it moved).
      location = written;
      await cancelGarbage(client, storage, location);
    } else {
      // The object just written (if any) belongs to no row: the row lives in another storage.
      if (target) await queueGarbage(client, cfg.backend, written, sha);
      if (deleteAfter !== null && storage !== 'db') {
        if (!holding) throw new NeedsS3SlotError();
        try {
          // Revive in the row's own storage, back to the configured prefix.
          ({ location } = await backendForStorage(storage, cfg).put(sha, bytes, mime));
        } catch (e) {
          throw unavailable(storage, e);
        }
        await cancelGarbage(client, storage, location);
      }
    }
    await client.query(
      'UPDATE file_blobs SET ref_count = ref_count + 1, delete_after = NULL, location = $2 WHERE sha256 = $1',
      [sha, location]);
  }
  return { deduplicated };
}

/**
 * Content-addressed release on the CALLER's transaction: decrements the refcount and, at zero, marks
 * the row pending delete (`delete_after = now() + grace`). No I/O and no COMMIT, so it belongs in
 * the same transaction that deletes the referencing fs_files row: a crash or rollback undoes both.
 * `graceSeconds` is for tests.
 */
export async function releaseBlobIn(
  client: PoolClient, sha: string, opts: { graceSeconds?: number } = {},
): Promise<{ pendingDelete: boolean }> {
  const existing = await client.query<{ ref_count: number }>(
    'SELECT ref_count FROM file_blobs WHERE sha256 = $1 FOR UPDATE', [sha]);
  if (existing.rowCount === 0) return { pendingDelete: false };
  const remaining = existing.rows[0].ref_count - 1;
  if (remaining > 0) {
    await client.query('UPDATE file_blobs SET ref_count = $2 WHERE sha256 = $1', [sha, remaining]);
    return { pendingDelete: false };
  }
  await client.query(
    'UPDATE file_blobs SET ref_count = 0, delete_after = now() + make_interval(secs => $2) WHERE sha256 = $1',
    [sha, opts.graceSeconds ?? BLOB_RELEASE_GRACE_SECONDS]);
  return { pendingDelete: true };
}

/** releaseBlobIn in a transaction of its own, for a caller with no transaction to join. */
export async function releaseBlob(sha: string): Promise<{ pendingDelete: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await releaseBlobIn(client, sha);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

type StoredRow = { storage: string; location: string | null; bytes: Buffer | null; size_bytes: string | number | null };

async function readRow(sha: string): Promise<StoredRow | null> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database not configured');
  const { rows } = await pool.query<StoredRow>(
    'SELECT storage, location, bytes, size_bytes FROM file_blobs WHERE sha256 = $1', [sha]);
  return rows[0] ?? null;
}

async function readFrom(sha: string, row: StoredRow, cfg: BlobStorageConfig): Promise<Buffer | null> {
  if (row.storage === 'db') return row.bytes;
  try {
    return await backendForStorage(row.storage, cfg).get(sha, row.location, maxGetBytes(row.size_bytes));
  } catch (e) {
    throw unavailable(row.storage, e);
  }
}

/**
 * The blob's bytes, read from the storage its row names. A db row's bytes come from the same
 * statement as its storage value. An object missing from external storage re-reads the row once, in
 * case a migration moved it. Throws BlobUnavailableError; never returns without bytes.
 */
export async function openBlob(sha: string): Promise<Buffer> {
  const cfg = getFileSearchConfig().blobStorage;
  const row = await readRow(sha);
  if (!row) throw new BlobUnavailableError('none', 'missing');
  const bytes = await readFrom(sha, row, cfg);
  if (bytes) return bytes;
  if (row.storage !== 'db') {
    const again = await readRow(sha);
    if (again && (again.storage !== row.storage || again.location !== row.location)) {
      const moved = await readFrom(sha, again, cfg);
      if (moved) return moved;
    }
  }
  throw new BlobUnavailableError(row.storage, 'missing');
}
