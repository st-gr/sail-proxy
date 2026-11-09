/**
 * OpenAI's Uploads API, the database side (the HTTP side is controllers/uploadsController.ts): an
 * upload is created with the file's metadata and declared size, receives parts, and is completed
 * into an ordinary file, cancelled, or expires one hour after creation.
 *
 * Parts are staged as `bytea` rows in `fs_upload_parts`, whatever the blob backend: the backends
 * store whole files only, and a staged part is not content yet. Every path that ends an upload
 * deletes its parts in the same transaction that changes its status, so no part outlives a
 * completion, a cancel or an expiry:
 * - complete: the blob retain, the `fs_files` insert, the part delete and the status change are one
 *   transaction (`withRetainTransaction`); a refused completion (unknown part, size or md5
 *   mismatch) writes nothing and leaves the parts for a corrected retry;
 * - cancel: the part delete and the status change;
 * - expiry: the expiry sweeper's pass (`expireDueUploads`) does both for pending uploads past
 *   `expires_at`. Until it runs, every operation already answers such an upload as expired.
 *
 * Every operation on an upload locks its row first (`FOR UPDATE`), so of two concurrent
 * operations — a complete and a cancel, two completes, a part and a complete — the second sees the
 * first one's outcome. Lock order: the upload row, then (complete only) the blob's locks inside the
 * retain; nothing that locks a blob ever locks an upload, so the two orders cannot cross.
 *
 * Bounds (constants, no setting): a part is at most `uploadPartLimit()` bytes; an upload declares
 * at most `limits.max_file_bytes` (POST /files' limit) and never stages more than it declared; at
 * most MAX_PARTS_PER_UPLOAD parts; at most MAX_PENDING_UPLOADS_PER_OWNER pending uploads per owner,
 * counting one past its deadline while it still holds parts.
 * The bytes staged per owner are therefore at most MAX_PENDING_UPLOADS_PER_OWNER × max_file_bytes.
 */
import type { PoolClient } from 'pg';
import * as crypto from 'crypto';
import { getPool } from './db';
import { withRetainTransaction, sha256Of } from './blob/blobStore';
import { insertFileRow } from './fileRows';
import { newFileId, newUploadId, newUploadPartId } from './ids';

/** OpenAI: "expires after an hour after you create it". */
export const UPLOAD_LIFETIME_SECONDS = 3600;

/**
 * The largest part this gateway accepts. OpenAI accepts 64 MB; the nginx in front of the gateway
 * (Docker and Kyma) refuses request bodies over 50 MB, so the cap stays below that with room for the
 * multipart framing. The effective cap is the smaller of this and the file size limit
 * (`uploadPartLimit`): a part larger than the whole file can never be completed.
 */
export const MAX_UPLOAD_PART_BYTES = 48 * 1024 * 1024;

/** Parts one upload may stage. */
export const MAX_PARTS_PER_UPLOAD = 1000;

/** Uploads one owner may have pending at once. */
export const MAX_PENDING_UPLOADS_PER_OWNER = 10;

/** Terminal (completed, cancelled, expired) uploads are kept this long, then deleted by the sweeper. */
export const TERMINAL_UPLOAD_RETENTION_DAYS = 30;

/** Advisory lock class for the per-owner pending count: 'upld' packed as an int4. */
const UPLOAD_LOCK_CLASS = 0x75706c64;

export function uploadPartLimit(maxFileBytes: number): number {
  return Math.min(MAX_UPLOAD_PART_BYTES, maxFileBytes);
}

export type UploadStatus = 'pending' | 'completed' | 'cancelled' | 'expired';

export interface UploadRow {
  id: string;
  owner_email: string;
  filename: string;
  purpose: string;
  mime_type: string;
  bytes: string | number;
  expires_after_seconds: number | null;
  status: UploadStatus;
  file_id: string | null;
  created_at: Date;
  expires_at: Date;
}

/** The file a completion created, as `toFileObject` reads it. */
export interface CompletedFile {
  id: string;
  filename: string;
  purpose: string;
  size_bytes: number;
  created_at: Date;
  expires_at: Date | null;
}

/** A refused request, answered with `status` and an OpenAI-shaped `invalid_request_error`. */
export class UploadRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly param: string | null = null) {
    super(message);
    this.name = 'UploadRequestError';
  }
}

/** No upload of that id for this owner (another owner's is the same answer). */
export class UploadNotFoundError extends Error {
  constructor(readonly uploadId: string) {
    super(`No such upload: ${uploadId}`);
    this.name = 'UploadNotFoundError';
  }
}

const UPLOAD_COLUMNS = `id, owner_email, filename, purpose, mime_type, bytes, expires_after_seconds, status, file_id,
  created_at, expires_at`;

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Locks the owner's upload and returns it while it still accepts operations. A pending upload past
 * its `expires_at` is expired although the sweeper has not marked it yet.
 */
async function lockPendingUpload(client: PoolClient, ownerEmail: string, uploadId: string, action: string): Promise<UploadRow> {
  const { rows } = await client.query<UploadRow & { lapsed: boolean }>(
    `SELECT ${UPLOAD_COLUMNS}, (status = 'pending' AND expires_at <= now()) AS lapsed
       FROM fs_uploads WHERE id = $1 AND owner_email = $2 FOR UPDATE`,
    [uploadId, ownerEmail],
  );
  if (rows.length === 0) throw new UploadNotFoundError(uploadId);
  const { lapsed, ...upload } = rows[0];
  const status: UploadStatus = lapsed ? 'expired' : upload.status;
  if (status !== 'pending') {
    throw new UploadRequestError(400, 'upload_not_pending',
      `Cannot ${action} upload ${uploadId}: its status is ${status}, and only a pending upload accepts this.`);
  }
  return upload;
}

export interface NewUpload {
  ownerEmail: string;
  filename: string;
  purpose: string;
  mimeType: string;
  bytes: number;
  expiresAfterSeconds: number | null;
}

/** Creates a pending upload, refusing one beyond the owner's pending limit. */
export async function createUpload(input: NewUpload): Promise<UploadRow> {
  return inTransaction(async (client) => {
    // Serialises the owner's creates, so the count below cannot be raced past the limit.
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [UPLOAD_LOCK_CLASS, input.ownerEmail]);
    // A pending upload past its deadline still counts while it holds parts (until the sweeper has
    // deleted them), so lapsed uploads cannot raise the bytes staged per owner above the bound.
    const { rows: [{ n }] } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fs_uploads u
        WHERE u.owner_email = $1 AND u.status = 'pending'
          AND (u.expires_at > now() OR EXISTS (SELECT 1 FROM fs_upload_parts p WHERE p.upload_id = u.id))`,
      [input.ownerEmail],
    );
    if (n >= MAX_PENDING_UPLOADS_PER_OWNER) {
      throw new UploadRequestError(400, 'too_many_pending_uploads',
        `You have ${n} pending uploads, the most allowed at once. Complete or cancel one first.`);
    }
    const { rows } = await client.query<UploadRow>(
      `INSERT INTO fs_uploads (id, owner_email, filename, purpose, mime_type, bytes, expires_after_seconds, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + make_interval(secs => $8))
       RETURNING ${UPLOAD_COLUMNS}`,
      [newUploadId(), input.ownerEmail, input.filename, input.purpose, input.mimeType, input.bytes,
        input.expiresAfterSeconds, UPLOAD_LIFETIME_SECONDS],
    );
    return rows[0];
  });
}

/** Stages one part of a pending upload. */
export async function addUploadPart(
  ownerEmail: string, uploadId: string, data: Buffer,
): Promise<{ id: string; created_at: Date; upload_id: string }> {
  return inTransaction(async (client) => {
    const upload = await lockPendingUpload(client, ownerEmail, uploadId, 'add a part to');
    const { rows: [staged] } = await client.query<{ n: number; total: string }>(
      'SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::text AS total FROM fs_upload_parts WHERE upload_id = $1',
      [uploadId],
    );
    if (staged.n >= MAX_PARTS_PER_UPLOAD) {
      throw new UploadRequestError(400, 'too_many_parts', `An upload accepts at most ${MAX_PARTS_PER_UPLOAD} parts.`);
    }
    const declared = Number(upload.bytes);
    if (Number(staged.total) + data.length > declared) {
      throw new UploadRequestError(400, 'upload_bytes_exceeded',
        `This part would bring the upload to ${Number(staged.total) + data.length} bytes, more than the ${declared} bytes it was created with.`);
    }
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO fs_upload_parts (id, upload_id, size_bytes, data) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [newUploadPartId(), uploadId, data.length, data],
    );
    return { ...rows[0], upload_id: uploadId };
  });
}

/**
 * Completes a pending upload into a file: the parts named by `partIds`, in that order, must be
 * exactly the upload's declared size (and match `md5`, lower-case hex, when given). The file is
 * created as `POST /files` creates one (blob retained, `insertFileRow`, the upload's
 * `expires_after`), in the transaction that deletes every part and marks the upload completed.
 * `maxFileBytes` is the file limit now (a declared size it no longer admits is refused).
 */
export async function completeUpload(
  ownerEmail: string, uploadId: string, partIds: string[], md5: string | null, maxFileBytes: number,
): Promise<{ upload: UploadRow; file: CompletedFile }> {
  return withRetainTransaction(async (client, retain) => {
    const upload = await lockPendingUpload(client, ownerEmail, uploadId, 'complete');
    const declared = Number(upload.bytes);
    if (declared > maxFileBytes) {
      throw new UploadRequestError(400, 'file_too_large',
        `The upload's ${declared} bytes exceed the maximum allowed file size of ${maxFileBytes} bytes.`, 'bytes');
    }
    const { rows: sizes } = await client.query<{ id: string; size_bytes: string }>(
      'SELECT id, size_bytes::text AS size_bytes FROM fs_upload_parts WHERE upload_id = $1', [uploadId]);
    const sizeOf = new Map(sizes.map((r) => [r.id, Number(r.size_bytes)]));
    let total = 0;
    for (const partId of partIds) {
      const size = sizeOf.get(partId);
      if (size === undefined) {
        throw new UploadRequestError(400, 'invalid_part_id', `No part ${partId.slice(0, 64)} in upload ${uploadId}.`, 'part_ids');
      }
      total += size;
    }
    if (total !== declared) {
      throw new UploadRequestError(400, 'upload_size_mismatch',
        `The parts total ${total} bytes, but the upload was created with ${declared} bytes.`, 'part_ids');
    }

    // The whole file in ONE buffer of the declared size (at most max_file_bytes, checked above), filled
    // by reading the parts one query at a time in part_ids order: the peak is the file plus one part,
    // never every part and a concatenated copy besides.
    const bytes = Buffer.alloc(declared);
    const hash = md5 !== null ? crypto.createHash('md5') : null;
    let offset = 0;
    for (const partId of partIds) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: [part] } = await client.query<{ data: Buffer }>(
        'SELECT data FROM fs_upload_parts WHERE upload_id = $1 AND id = $2', [uploadId, partId]);
      // Sizes were summed from size_bytes above; a row whose data disagrees is not this upload's file.
      if (!part || offset + part.data.length > declared) {
        throw new Error(`upload ${uploadId}: part ${partId} does not match its recorded size`);
      }
      part.data.copy(bytes, offset);
      hash?.update(part.data);
      offset += part.data.length;
    }
    if (offset !== declared) throw new Error(`upload ${uploadId}: the parts hold ${offset} bytes, not ${declared}`);
    if (hash !== null && hash.digest('hex') !== md5) {
      throw new UploadRequestError(400, 'md5_mismatch',
        'The md5 checksum of the uploaded parts does not match the md5 given.', 'md5');
    }

    const sha = sha256Of(bytes);
    await retain(sha, bytes, upload.mime_type);
    const fileId = newFileId();
    const stored = await insertFileRow({
      id: fileId, ownerEmail, filename: upload.filename, purpose: upload.purpose, sha256: sha, sizeBytes: declared,
      expiresAfterSeconds: upload.expires_after_seconds,
    }, client);
    await client.query('DELETE FROM fs_upload_parts WHERE upload_id = $1', [uploadId]);
    const { rows } = await client.query<UploadRow>(
      `UPDATE fs_uploads SET status = 'completed', file_id = $2 WHERE id = $1 RETURNING ${UPLOAD_COLUMNS}`,
      [uploadId, fileId]);
    return {
      upload: rows[0],
      file: {
        id: fileId, filename: upload.filename, purpose: upload.purpose, size_bytes: declared,
        created_at: stored.created_at, expires_at: stored.expires_at,
      },
    };
  });
}

/** Cancels a pending upload and deletes its parts. */
export async function cancelUpload(ownerEmail: string, uploadId: string): Promise<UploadRow> {
  return inTransaction(async (client) => {
    await lockPendingUpload(client, ownerEmail, uploadId, 'cancel');
    await client.query('DELETE FROM fs_upload_parts WHERE upload_id = $1', [uploadId]);
    const { rows } = await client.query<UploadRow>(
      `UPDATE fs_uploads SET status = 'cancelled' WHERE id = $1 RETURNING ${UPLOAD_COLUMNS}`, [uploadId]);
    return rows[0];
  });
}

/**
 * The expiry sweeper's upload pass: marks up to `batchLimit` pending uploads past `expires_at` as
 * expired and deletes their parts, in one statement (oldest deadline first). An upload another
 * transaction holds (a part, complete or cancel in flight) is skipped (SKIP LOCKED inside the CTE,
 * so a row is claimed exactly once) and resolved by that transaction's own expiry check or by the
 * next pass. Then deletes up to `batchLimit` terminal uploads older than
 * TERMINAL_UPLOAD_RETENTION_DAYS. Returns the number expired.
 */
export async function expireDueUploads(batchLimit: number): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const { rowCount } = await pool.query(
    `WITH due AS (
       SELECT id FROM fs_uploads WHERE status = 'pending' AND expires_at <= now()
        ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     ), gone AS (
       DELETE FROM fs_upload_parts p USING due WHERE p.upload_id = due.id
     )
     UPDATE fs_uploads u SET status = 'expired' FROM due WHERE u.id = due.id`,
    [batchLimit],
  );
  await pool.query(
    `WITH old AS (
       SELECT id FROM fs_uploads WHERE status <> 'pending' AND created_at < now() - make_interval(days => $2)
        LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     DELETE FROM fs_uploads u USING old WHERE u.id = old.id`,
    [batchLimit, TERMINAL_UPLOAD_RETENTION_DAYS],
  );
  return rowCount ?? 0;
}
