// A store's files: attach, enqueue for ingestion, detach, delete everywhere, and the store cascade
// (split out of repository.ts, which re-exports them).
import { getPool } from './db';
import { releaseBlobIn } from './blob/blobStore';
import { notExpiredSql } from './fileRows';
import { getDefaultLogger } from '@libs/logger';
import { publishIngestHint } from './ingestHint';
import { validateAttributes } from './storeValidation';
import { AttachStamp, RECOMPUTE_EXPIRES_AT_SQL, VectorStoreFileRow } from './stores';

const logger = getDefaultLogger();

/**
 * Attaches `fileId` to `storeId` with status `'in_progress'` (never
 * `'completed'` — Task 11's worker owns advancing it) and touches the
 * store's `last_active_at`, since `expires_after.anchor` is
 * `'last_active_at'`. This is a low-level primitive: it does not check
 * store/file ownership, the per-store file-count limit, or the store's
 * pinned embedding dimension — those are the HTTP layer's job (each is its
 * own scoped SQL lookup there), so this function stays usable standalone
 * (e.g. from a future batch-attach path) without re-deriving them.
 *
 * `batchId` stamps `vector_store_files.batch_id`, which is how a file batch
 * records its membership (`batches.ts` has no membership table of its own —
 * see the schema comment). It is OPTIONAL and defaults to `null` precisely so
 * every pre-existing call site keeps its current meaning without an edit: an
 * ordinary single-file attach is an attach with no batch, which is exactly
 * what `null` already meant in that column.
 *
 * `stamp` records who pays for the ingestion. A retry re-opens the row and
 * keeps it, so a retried file is billed like its first attempt.
 */
export async function attachFile(
  storeId: string,
  fileId: string,
  attributes: Record<string, unknown> | null | undefined,
  chunkingStrategy?: Record<string, unknown> | null,
  batchId: string | null = null,
  stamp: AttachStamp | null = null,
): Promise<VectorStoreFileRow> {
  const validAttributes = validateAttributes(attributes);
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // created_at comes from the database clock, like every other timestamp
    // this module writes. It is the keyset pagination cursor for both file-list
    // endpoints (ORDER BY created_at, file_id), so an application-clock value
    // is not merely inconsistent: two gateway replicas whose clocks disagree
    // would store rows in an order that contradicts their true insertion
    // order, and a cursor resolved against one replica's value can skip or
    // repeat rows on a page served by the other.
    const { rows } = await client.query<VectorStoreFileRow>(
      `INSERT INTO vector_store_files (store_id, file_id, attributes, chunking_strategy, status, batch_id, created_at,
                                       credential_id, auth_type, on_behalf_of)
       VALUES ($1,$2,$3,$4,'in_progress',$5, now(), $6, $7, $8)
       RETURNING *`,
      [
        storeId,
        fileId,
        JSON.stringify(validAttributes),
        chunkingStrategy ? JSON.stringify(chunkingStrategy) : null,
        batchId,
        stamp?.credentialId ?? null,
        stamp?.authType ?? null,
        stamp?.onBehalfOf ?? null,
      ],
    );
    // Postgres evaluates now() once per transaction, so this anchors
    // expires_after to the same instant the row above was stamped with, and
    // agrees with RECOMPUTE_EXPIRES_AT_SQL everywhere else last_active_at is
    // touched.
    await client.query(
      `UPDATE vector_stores SET last_active_at = now(), expires_at = ${RECOMPUTE_EXPIRES_AT_SQL} WHERE id = $1`,
      [storeId],
    );
    // createBatch attaches its members one transaction at a time, after the
    // job row exists: if the members attached so far already finished, the
    // worker has settled the job, and this member reopens it. Last in the
    // transaction, per the lock order stores -> files -> jobs.
    if (batchId) {
      await client.query(
        'UPDATE fs_jobs SET finished_at = NULL WHERE batch_id = $1 AND finished_at IS NOT NULL',
        [batchId],
      );
    }
    await client.query('COMMIT');
    return rows[0];
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
 * Signals that `fileId` in `storeId` is ready for ingestion. Per the design
 * (`docs/superpowers/specs/2026-07-29-responses-file-search-design.md`),
 * "the database row is the source of truth; valkey is an accelerator" — a
 * job *is* the `vector_store_files` row this call's caller already inserted
 * with `status='in_progress'` (see `attachFile`), and the ingestion worker
 * (`ingestWorker.ts`) polls for exactly that, re-claiming rows whose lease
 * has expired even if no hint ever arrived. `publishIngestHint` (Task 11,
 * `ingestHint.ts`) is strictly a low-latency wake-up: absent VALKEY_URL, or
 * if the publish itself fails, this degrades to the same no-op-beyond-a-
 * debug-log this function shipped as originally — never the source of
 * truth, never awaited by anything that would fail the caller's request.
 */
export async function enqueueIngestion(storeId: string, fileId: string): Promise<void> {
  logger.debug('FileSearchRepository', 'Ingestion enqueued', { storeId, fileId });
  await publishIngestHint(storeId, fileId);
}

/**
 * Detaches `fileId` from `storeId` (scoped to `ownerEmail` in the SQL, not
 * applied afterwards): removes its chunks and the `vector_store_files` row,
 * and touches the store's `last_active_at`. One transaction, so a mid-delete
 * crash cannot remove the chunks without removing the attachment row (or
 * vice versa). Returns `deleted: false` — never a distinguishing error —
 * when the store isn't owned by `ownerEmail` or the file isn't attached
 * to it.
 *
 * Deliberately does NOT touch `fs_files` or any blob. Detaching a file from
 * a vector store is not the same operation as deleting the file: OpenAI's
 * own API is explicit that removing a file from a vector store "will not"
 * delete the file itself, and returns a distinct `vector_store_file.deleted`
 * object rather than `file.deleted`. `vector_store_files.file_id` also has
 * no `ON DELETE CASCADE` onto `fs_files` in the schema for exactly this
 * reason — a file can and should serve several stores, or be re-attached
 * after detaching, without losing its blob or its `GET /files/{id}` entry.
 * Only two paths ever remove an `fs_files` row or decrement a blob's
 * `ref_count`: `filesController.deleteFile` (`DELETE /files/{id}`) and
 * `deleteFileDetachingEverywhere` below (`?detach=true`).
 *
 * LOCK ORDER (Task 11 review, C2): always locks `vector_stores` FOR UPDATE
 * before touching `vector_store_files`, matching `deleteStoreCascade` below
 * and `ingestWorker.ts`'s `commitChunks` (which takes `FOR SHARE` on
 * `vector_stores` before re-checking the `vector_store_files` row). Before
 * this fix, this function deleted `vector_store_files` FIRST and only
 * touched `vector_stores` afterward (via the trailing `UPDATE
 * last_active_at`) — the reverse order from `commitChunks` and
 * `deleteStoreCascade`. Two transactions taking the same two locks in
 * opposite orders is a textbook deadlock: reproduced live 6/6 (a detach
 * racing an ingestion write for the same file), with THIS function losing
 * 5 of 6 as Postgres's `40P01` victim, surfacing as an unmapped 500 in
 * `vectorStoresController.ts` before that was also fixed. One global rule
 * fixes it structurally rather than case-by-case: every write path that
 * touches both tables locks `vector_stores` first.
 */
export async function deleteStoreFile(storeId: string, fileId: string, ownerEmail: string): Promise<{ deleted: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storeRows = await client.query(
      'SELECT id FROM vector_stores WHERE id = $1 AND owner_email = $2 FOR UPDATE', [storeId, ownerEmail],
    );
    if (storeRows.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return { deleted: false };
    }
    const del = await client.query(
      `DELETE FROM vector_store_files WHERE store_id = $1 AND file_id = $2 RETURNING file_id`,
      [storeId, fileId],
    );
    if (del.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return { deleted: false };
    }
    await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);
    // A re-embed of the store no longer has this file to do: its work item goes
    // with it (every generation of its chunks went above). Items after files.
    await client.query('DELETE FROM fs_reembed_items WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);
    await client.query(
      `UPDATE vector_stores SET last_active_at = now(), expires_at = ${RECOMPUTE_EXPIRES_AT_SQL} WHERE id = $1`,
      [storeId],
    );
    await client.query('COMMIT');
    return { deleted: true };
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
 * Detaches a file from every store of `ownerEmail` and deletes it, in ONE transaction: a failure at
 * any step rolls the detach back, so the file is never left detached but not deleted.
 *
 * Mirrors deleteStoreFile for each store (the file's vector_store_files rows, its chunks in that
 * store, the store's last_active_at / expires_at), then deletes the owner's fs_files row and releases
 * its blob in the same transaction, exactly as filesController.deleteFile does.
 *
 * LOCK ORDER: the owner's stores that hold the file are locked FOR UPDATE (ordered by id) BEFORE the
 * fs_files row, matching deleteStoreFile's rule that vector_stores is always locked first; locking
 * fs_files first would deadlock against an attach, which holds the store lock and then needs the
 * file row for its foreign key check.
 *
 * `{ deleted: false }` for a missing or foreign file; `{ deleted: false, inUse: true }` when another
 * owner's store still references it (foreign_key_violation 23503 on the fs_files delete).
 *
 * `which`: `'live'` (every caller's delete) finds only a file that has not expired — an expired file
 * is gone for its owner, so their delete is the same `{ deleted: false }` (404) as for a missing one;
 * `'expired'` (the expiry sweeper) finds only a file whose `expires_at` has passed. Checked under the
 * file row's lock, so the two never delete the same row twice. An `'expired'` delete leaves the
 * stores' last_active_at / expires_at alone: it is not activity of the owner.
 */
export async function deleteFileDetachingEverywhere(
  fileId: string,
  ownerEmail: string,
  which: 'live' | 'expired' = 'live',
): Promise<{ deleted: boolean; sha256?: string; inUse?: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const client = await pool.connect();
  let sha256: string;
  try {
    await client.query('BEGIN');
    const stores = await client.query<{ id: string }>(
      `SELECT id FROM vector_stores
        WHERE owner_email = $2 AND id IN (SELECT store_id FROM vector_store_files WHERE file_id = $1)
        ORDER BY id FOR UPDATE`,
      [fileId, ownerEmail],
    );
    const storeIds = stores.rows.map((row) => row.id);
    const file = await client.query<{ sha256: string }>(
      `SELECT sha256 FROM fs_files WHERE id = $1 AND owner_email = $2
          AND ${which === 'live' ? notExpiredSql() : 'expires_at <= now()'} FOR UPDATE`,
      [fileId, ownerEmail],
    );
    if (file.rowCount === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return { deleted: false };
    }
    sha256 = file.rows[0].sha256;
    if (storeIds.length > 0) {
      await client.query('DELETE FROM vector_store_files WHERE file_id = $1 AND store_id = ANY($2::text[])', [fileId, storeIds]);
      await client.query('DELETE FROM vector_store_chunks WHERE file_id = $1 AND store_id = ANY($2::text[])', [fileId, storeIds]);
      // The file's re-embed work items, as deleteStoreFile removes them.
      await client.query('DELETE FROM fs_reembed_items WHERE file_id = $1 AND store_id = ANY($2::text[])', [fileId, storeIds]);
      // A delete by the owner (or the cockpit) is activity on the stores, as any detach is. The expiry
      // sweeper's delete ('expired') is not: a store must not be kept alive by its files expiring.
      if (which === 'live') {
        await client.query(
          `UPDATE vector_stores SET last_active_at = now(), expires_at = ${RECOMPUTE_EXPIRES_AT_SQL} WHERE id = ANY($1::text[])`,
          [storeIds],
        );
      }
    }
    try {
      await client.query('DELETE FROM fs_files WHERE id = $1 AND owner_email = $2', [fileId, ownerEmail]);
    } catch (deleteError: any) {
      if (deleteError?.code === '23503') {
        await client.query('ROLLBACK').catch(() => {});
        return { deleted: false, inUse: true };
      }
      throw deleteError;
    }
    // Decrements the blob's refcount (at zero the row turns pending delete for the sweeper) in the
    // same transaction as the file row's delete, so a crash between the two cannot drift the count.
    await releaseBlobIn(client, sha256);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { deleted: true, sha256 };
}

/**
 * Deletes `storeId` (scoped to `ownerEmail` in the SQL) and cascades to
 * every file it contains: chunks are removed, then `vector_store_files`
 * rows, then the store itself. One transaction, so a crash mid-cascade
 * cannot leave chunks without their attachment row, or an attachment row
 * without its store. Returns `deleted: false` — never a distinguishing
 * error — for a store that doesn't exist or isn't owned by `ownerEmail`.
 *
 * Deliberately does NOT touch `fs_files` or any blob — see `deleteStoreFile`
 * above for why: deleting a store removes that store's associations and
 * chunks only, never the underlying files, which may still be attached to
 * (or later attached to) other stores.
 */
export async function deleteStoreCascade(storeId: string, ownerEmail: string): Promise<{ deleted: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storeRows = await client.query(
      'SELECT id FROM vector_stores WHERE id = $1 AND owner_email = $2 FOR UPDATE', [storeId, ownerEmail],
    );
    if (storeRows.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return { deleted: false };
    }
    await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM vector_store_files WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM vector_stores WHERE id = $1', [storeId]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (e) {
    // Swallow a failing ROLLBACK: it fires precisely when the connection is
    // already broken, and letting it throw replaces the error that explains why.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
