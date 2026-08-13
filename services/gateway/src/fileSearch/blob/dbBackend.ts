import { getPool } from '../db';
import { BlobBackend } from './blobStore';

/**
 * Storage-in-Postgres backend. Unlike localBackend/s3Backend, the physical
 * bytes for this backend live inline in the `file_blobs.bytes` column that
 * `retainBlob`/`releaseBlob` already own the lifecycle of: `retainBlob`'s own
 * INSERT carries the bytes on first write, and `releaseBlob`'s own DELETE
 * removes them when the refcount reaches zero. `put`/`delete` here are
 * therefore no-ops that exist only to satisfy the BlobBackend contract and
 * keep the refcount transaction backend-agnostic; `get`/`exists` do the real
 * work of reading the row back out.
 */
export function createDbBackend(): BlobBackend {
  return {
    async put(_sha, _bytes, _mime) {
      return { location: null };
    },
    async get(sha) {
      const pool = getPool();
      if (!pool) return null;
      const { rows } = await pool.query('SELECT bytes FROM file_blobs WHERE sha256 = $1', [sha]);
      if (rows.length === 0 || rows[0].bytes === null) return null;
      return rows[0].bytes as Buffer;
    },
    async delete(_sha) {
      // no-op: releaseBlob's own DELETE FROM file_blobs already removed the row.
    },
    async exists(sha) {
      const pool = getPool();
      if (!pool) return false;
      const { rows } = await pool.query('SELECT 1 FROM file_blobs WHERE sha256 = $1', [sha]);
      return rows.length > 0;
    },
  };
}
