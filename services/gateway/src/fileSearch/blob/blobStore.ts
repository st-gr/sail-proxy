import * as crypto from 'crypto';
import { getPool } from '../db';
import { getFileSearchConfig, FileSearchConfig } from '../../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { createDbBackend } from './dbBackend';
// createLocalBackend/createS3Backend are deliberately NOT imported here —
// see getBackend()'s doc comment below: those code paths still exist
// (localBackend.ts, s3Backend.ts, each independently unit-tested) for Plan 3
// to finish, but getBackend() refuses both configurations before ever
// needing to construct one.

const logger = getDefaultLogger();

export interface BlobBackend {
  put(sha256: string, bytes: Buffer, mime: string): Promise<{ location: string | null }>;
  get(sha256: string): Promise<Buffer | null>;
  delete(sha256: string): Promise<void>;
  exists(sha256: string): Promise<boolean>;
}

export function sha256Of(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function backendName(): FileSearchConfig['blobStorage']['backend'] {
  return getFileSearchConfig().blobStorage.backend;
}

/**
 * Thrown by `getBackend()` for a configured `blob_storage.backend` other
 * than `'db'`. Callers should treat this like any other "file_search is
 * unavailable" condition (the controllers' existing `503
 * file_search_unavailable` guard) rather than a generic 500.
 */
export class UnsupportedBlobBackendError extends Error {
  constructor(backend: string) {
    super(
      `blob_storage.backend "${backend}" is experimental and not yet supported in production. ` +
      'Only "db" is supported. The "local" and "s3" backends have known, unresolved defects ' +
      '(a physical-delete race that can permanently lose content on a concurrent re-upload, ' +
      'silent orphaning of existing blobs on a backend switch, and no request timeout on an ' +
      'in-transaction network call) — see Plan 3. Set blob_storage.backend to "db", or leave it unset.',
    );
    this.name = 'UnsupportedBlobBackendError';
  }
}

/**
 * Resolves the currently configured storage backend. Reads config fresh on
 * every call (rather than caching an instance) so a hot-reloaded backend
 * setting takes effect immediately instead of requiring a restart.
 *
 * Only `'db'` is production-ready today (final whole-branch review, I1):
 * `'local'`/`'s3'` ship real, understood code paths — kept in place for
 * Plan 3 to finish — but are not safe to run unattended yet. Rather than fix
 * those defects here (out of scope for this pass), this is the single choke
 * point every caller (`retainBlob`/`releaseBlob` below, `ingestWorker.ts`,
 * `filesController.ts`'s download handler) goes through to obtain a backend,
 * so refusing here makes the unsafe configuration unreachable everywhere at
 * once — fast and clear, at first use, rather than a maintainer discovering
 * the defects live.
 */
export function getBackend(): BlobBackend {
  const cfg = getFileSearchConfig().blobStorage;
  switch (cfg.backend) {
    case 'local':
    case 's3':
      throw new UnsupportedBlobBackendError(cfg.backend);
    case 'db':
    default:
      return createDbBackend();
  }
}

/**
 * Content-addressed acquire: increments the blob's refcount, writing the
 * physical bytes only the first time this sha256 is ever seen. Two concurrent
 * uploads of the same content race on the `SELECT ... FOR UPDATE` — Postgres
 * serializes them on the row lock, so only one can take the "not found, write
 * and INSERT" branch; the other blocks until the first commits, then sees the
 * row and simply increments ref_count.
 *
 * `deduplicated` is for metrics/logging ONLY. It must never leak into an API
 * response, a status code, or response timing: doing so would let a caller
 * discover whether another user already has a given file's bytes on file by
 * uploading a guess (an existence oracle).
 */
export async function retainBlob(
  sha: string, bytes: Buffer, mime: string,
): Promise<{ deduplicated: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row if it exists so two concurrent uploads cannot both think they are first.
    const existing = await client.query(
      'SELECT sha256 FROM file_blobs WHERE sha256 = $1 FOR UPDATE', [sha]);
    if (existing.rowCount === 0) {
      const { location } = await getBackend().put(sha, bytes, mime);
      await client.query(
        `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, location)
         VALUES ($1,$2,$3,1,$4,$5,$6) ON CONFLICT (sha256) DO UPDATE
           SET ref_count = file_blobs.ref_count + 1`,
        [sha, bytes.length, mime, backendName(), backendName() === 'db' ? bytes : null, location]);
      await client.query('COMMIT');
      return { deduplicated: false };
    }
    await client.query('UPDATE file_blobs SET ref_count = ref_count + 1 WHERE sha256 = $1', [sha]);
    await client.query('COMMIT');
    return { deduplicated: true };
  } catch (e) {
    // Swallow a failing ROLLBACK: it fires precisely when the connection is
    // already broken, and letting it throw replaces the error that explains why.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Content-addressed release: decrements the blob's refcount, and only when it
 * reaches zero removes the row and the physical bytes. The physical delete is
 * deliberately issued AFTER the DB transaction commits, not inside it: doing
 * it inside would risk deleting bytes that a subsequent ROLLBACK then leaves
 * still referenced by a live row (a dangling reference, worse than a leaked
 * file). A failure to physically delete after a successful commit just
 * orphans bytes on disk/S3/db for later cleanup — logged, not thrown, because
 * the refcount bookkeeping (the part other owners depend on for correctness)
 * already succeeded.
 */
export async function releaseBlob(sha: string): Promise<{ removed: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database not configured');
  const client = await pool.connect();
  let removed = false;
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT ref_count FROM file_blobs WHERE sha256 = $1 FOR UPDATE', [sha]);
    if (existing.rowCount === 0) {
      await client.query('COMMIT');
      return { removed: false };
    }
    const remaining = existing.rows[0].ref_count - 1;
    if (remaining <= 0) {
      await client.query('DELETE FROM file_blobs WHERE sha256 = $1', [sha]);
      removed = true;
    } else {
      await client.query('UPDATE file_blobs SET ref_count = $2 WHERE sha256 = $1', [sha, remaining]);
    }
    await client.query('COMMIT');
  } catch (e) {
    // Swallow a failing ROLLBACK: it fires precisely when the connection is
    // already broken, and letting it throw replaces the error that explains why.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  if (removed) {
    try {
      await getBackend().delete(sha);
    } catch (e: any) {
      logger.error('BlobStore',
        `Refcount reached zero and the row was removed, but physically deleting the blob failed: ${sha}`,
        e);
    }
  }
  return { removed };
}
