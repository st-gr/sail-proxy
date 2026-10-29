/**
 * Reads the cockpit needs that the OpenAI-shaped routes do not offer (spec 2026-10-01 §5.2).
 * Both are scoped by the owner's e-mail in SQL, like every file_search query.
 */
import { getPool } from './db';

export interface FileAttachment {
  store_id: string;
  store_name: string | null;
  status: string;
}

/** For each of the owner's files among `fileIds`: the stores it is attached to, oldest store first. */
export async function listAttachmentsForFiles(ownerEmail: string, fileIds: string[]): Promise<Record<string, FileAttachment[]>> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  if (fileIds.length === 0) return {};
  const { rows } = await pool.query<{ file_id: string; store_id: string; store_name: string | null; status: string }>(
    `SELECT vsf.file_id, vsf.store_id, vs.name AS store_name, vsf.status
       FROM vector_store_files vsf
       JOIN vector_stores vs ON vs.id = vsf.store_id
       JOIN fs_files f ON f.id = vsf.file_id
      WHERE vsf.file_id = ANY($1::text[]) AND f.owner_email = $2 AND vs.owner_email = $2
      ORDER BY vsf.file_id, vs.created_at, vs.id`,
    [fileIds, ownerEmail],
  );
  const byFile: Record<string, FileAttachment[]> = {};
  for (const row of rows) {
    (byFile[row.file_id] = byFile[row.file_id] || []).push({ store_id: row.store_id, store_name: row.store_name, status: row.status });
  }
  return byFile;
}

export interface OwnerStorage {
  owner_email: string;
  file_count: number;
  /** The sum of the owner's file sizes: what they uploaded, before deduplication (plan decision 3). */
  logical_bytes: number;
}

/** The owner's file count and logical bytes: one aggregate over the owner's file rows. */
export async function storageOfOwner(ownerEmail: string): Promise<OwnerStorage> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const { rows } = await pool.query<{ file_count: number; logical_bytes: string }>(
    `SELECT COUNT(*)::int AS file_count, COALESCE(SUM(size_bytes), 0) AS logical_bytes
       FROM fs_files WHERE owner_email = $1`,
    [ownerEmail],
  );
  // SUM(bigint) arrives as a string from node-postgres.
  return { owner_email: ownerEmail, file_count: rows[0].file_count, logical_bytes: Number(rows[0].logical_bytes) };
}
