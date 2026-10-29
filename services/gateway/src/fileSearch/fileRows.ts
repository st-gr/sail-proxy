import type { PoolClient } from 'pg';
import { getPool } from './db';

/**
 * File expiry on read. A file whose `expires_at` has passed is gone for its owner (OpenAI answers an
 * expired file as gone) from that instant, although the expiry sweeper deletes its row, attachments
 * and chunks only on its next pass (every few minutes). Every read and every attach lookup of a file
 * therefore filters with one of these:
 * - `notExpiredSql(alias)`: on a query over `fs_files` (`alias` such as `'f.'` qualifies the column);
 * - `attachedFileNotExpiredSql(fileIdExpr)`: on a query over `vector_store_files`, whose own rows
 *   stay until the sweep.
 */
export const notExpiredSql = (alias = ''): string => `(${alias}expires_at IS NULL OR ${alias}expires_at > now())`;
export const attachedFileNotExpiredSql = (fileIdExpr: string): string =>
  `NOT EXISTS (SELECT 1 FROM fs_files xf WHERE xf.id = ${fileIdExpr} AND xf.expires_at <= now())`;

export interface NewFileRow {
  id: string;
  ownerEmail: string;
  filename: string;
  purpose: string;
  sha256: string;
  sizeBytes: number;
  /** OpenAI's `expires_after.seconds` (anchor `created_at`); null or absent never expires. */
  expiresAfterSeconds?: number | null;
}

export interface StoredFileTimes {
  created_at: Date;
  /** null: the file never expires. */
  expires_at: Date | null;
}

/**
 * Inserts the `fs_files` row of an upload whose blob is already retained, and returns the stored
 * `created_at` and `expires_at` (created_at plus the expiry seconds, in the same statement). Shared
 * by the upload route (filesController) and the evaluation runner.
 *
 * created_at comes from the DATABASE clock, like vector_stores and vector_store_files. It is the
 * keyset pagination cursor for GET /files (ORDER BY created_at, id), so an application-clock value is
 * not merely inconsistent: two gateway replicas whose clocks disagree would store rows in an order
 * that contradicts their true insertion order, and a cursor resolved against one replica's value can
 * skip or repeat rows on a page served by the other.
 *
 * RETURNING, not a second SELECT and not the bound value: the caller must report what was actually
 * stored. Note that `RETURNING` echoing a BOUND parameter is exactly how the old form looked correct
 * while being wrong — here there is no bound value to echo.
 *
 * `client`: the caller's open transaction (an Uploads API completion inserts the row in the same
 * transaction that retains the blob and consumes the upload); the pool otherwise.
 */
export async function insertFileRow(row: NewFileRow, client?: PoolClient): Promise<StoredFileTimes> {
  const db = client ?? getPool();
  if (!db) throw new Error('file_search database is not configured');
  const inserted = await db.query<StoredFileTimes>(
    `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now() + make_interval(secs => $7::int))
     RETURNING created_at, expires_at`,
    [row.id, row.ownerEmail, row.filename, row.purpose, row.sha256, row.sizeBytes, row.expiresAfterSeconds ?? null],
  );
  const stored = inserted.rows[0];
  return { created_at: stored.created_at, expires_at: stored.expires_at ?? null };
}
