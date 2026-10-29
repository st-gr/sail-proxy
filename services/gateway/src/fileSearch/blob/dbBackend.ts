import { getPool } from '../db';
import { BlobBackend } from './blobStore';

/**
 * Storage-in-Postgres backend. Unlike s3Backend, the physical bytes for this
 * backend live inline in the `file_blobs.bytes` column whose lifecycle
 * `retainBlob` and the blob sweeper already own: `retainBlob`'s own INSERT
 * carries the bytes on first write, and the row's deletion removes them.
 * `put`/`delete` here are therefore no-ops that exist only to satisfy the
 * BlobBackend contract; `get`/`exists` read the row back out (`openBlob`
 * reads a db row's bytes directly, in the same statement as its storage).
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
      // no-op: the bytes go with the file_blobs row.
    },
    async exists(sha) {
      const pool = getPool();
      if (!pool) return false;
      const { rows } = await pool.query('SELECT 1 FROM file_blobs WHERE sha256 = $1', [sha]);
      return rows.length > 0;
    },
  };
}
