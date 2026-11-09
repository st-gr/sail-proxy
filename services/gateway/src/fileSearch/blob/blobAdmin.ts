/**
 * The admin panel's reads of blob storage (GET /admin/blob-storage, POST /admin/blob-storage/test).
 * Nothing here is HTTP-aware. Every answer is operator-facing and carries no bucket, endpoint, host,
 * key, location or credential: S3 shows only whether it is configured, its prefix, and the outcome
 * of the S3 probe (a PUT and GET of a fixed object under the prefix).
 */
import { getFileSearchConfig } from '../../services/configService';
import { s3Readiness } from './blobStore';
import { blobMigrationJob, checkMigrationTarget, BlobMigrationJob } from './blobMigration';
import { requirePool } from './blobMigrationDb';

/** One storage that holds blob rows: live rows and released ones (`delete_after` set) apart. */
export interface BlobStorageCounts {
  storage: string;
  live_blobs: number;
  live_bytes: number;
  /** Released rows (no reference left) waiting for the sweeper: `delete_after` is set. */
  released_blobs: number;
  released_bytes: number;
  /** Whether this gateway can address the storage now (db always; s3 configured with credentials). */
  addressable: boolean;
}

/** Objects queued for deletion in one storage (`file_blob_garbage`). */
export interface BlobGarbageCounts {
  storage: string;
  entries: number;
  /** Past their `delete_after`: the next garbage pass takes them. */
  due: number;
  /** Failed at least once (attempts > 0) and retried with a backoff. */
  failing: number;
}

export interface BlobStorageOverview {
  configured_backend: string;
  s3: {
    configured: boolean; credentials_present: boolean; prefix: string;
    /**
     * s3 rows whose stored location is not their key under the configured prefix (a prefix
     * changed since they were written): unreadable until the prefix is set back. 0 when s3 is not
     * configured.
     */
    outside_prefix_blobs: number;
  };
  storages: BlobStorageCounts[];
  garbage: BlobGarbageCounts[];
  /** The unfinished migration, else the most recent one; null when none was ever started. */
  migration: BlobMigrationJob | null;
}

/** The panel's figures. Reads `file_blobs` (storage, size, delete_after only) and `file_blob_garbage` counts. */
export async function blobStorageOverview(): Promise<BlobStorageOverview> {
  const cfg = getFileSearchConfig().blobStorage;
  const readiness = s3Readiness(cfg);
  const s3Addressable = readiness.configured && readiness.credentialsPresent;
  const pool = requirePool();
  const blobs = await pool.query<Record<string, string>>(
    `SELECT storage,
            count(*) FILTER (WHERE delete_after IS NULL)                         AS live_blobs,
            COALESCE(sum(size_bytes) FILTER (WHERE delete_after IS NULL), 0)     AS live_bytes,
            count(*) FILTER (WHERE delete_after IS NOT NULL)                     AS released_blobs,
            COALESCE(sum(size_bytes) FILTER (WHERE delete_after IS NOT NULL), 0) AS released_bytes
       FROM file_blobs GROUP BY storage ORDER BY storage`);
  const garbage = await pool.query<Record<string, string>>(
    `SELECT storage, count(*) AS entries,
            count(*) FILTER (WHERE delete_after <= now()) AS due,
            count(*) FILTER (WHERE attempts > 0)          AS failing
       FROM file_blob_garbage GROUP BY storage ORDER BY storage`);
  const prefix = (cfg.s3.prefix || '').replace(/\/+$/, '');
  let outsidePrefix = 0;
  if (readiness.configured) {
    // The key a row must have (s3Backend.keyFor); a legacy URL location is compared by its path,
    // with or without the bucket, as the backend resolves it. The bucket stays a query parameter.
    const outside = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT location, $1 || '/' || substr(sha256, 1, 2) || '/' || sha256 AS key,
                regexp_replace(location, '^[A-Za-z][A-Za-z0-9+.-]*://[^/]*/', '') AS path
           FROM file_blobs WHERE storage = 's3' AND location IS NOT NULL) r
        WHERE CASE WHEN position('://' in r.location) > 0
                   THEN r.path <> r.key AND r.path <> $2 || '/' || r.key
                   ELSE r.location <> r.key END`,
      [prefix, cfg.s3.bucket]);
    outsidePrefix = Number(outside.rows[0]?.n ?? 0);
  }
  const latest = await pool.query<{ id: string }>(
    `SELECT id FROM fs_jobs WHERE kind = 'blob_migration'
      ORDER BY (finished_at IS NULL) DESC, created_at DESC, id DESC LIMIT 1`);
  // COUNT and SUM(bigint) arrive as strings from node-postgres.
  return {
    configured_backend: cfg.backend,
    s3: {
      configured: readiness.configured, credentials_present: readiness.credentialsPresent, prefix,
      outside_prefix_blobs: outsidePrefix,
    },
    storages: blobs.rows.map((r) => ({
      storage: r.storage,
      live_blobs: Number(r.live_blobs),
      live_bytes: Number(r.live_bytes),
      released_blobs: Number(r.released_blobs),
      released_bytes: Number(r.released_bytes),
      addressable: r.storage === 'db' || (r.storage === 's3' && s3Addressable),
    })),
    garbage: garbage.rows.map((r) => ({ storage: r.storage, entries: Number(r.entries), due: Number(r.due), failing: Number(r.failing) })),
    migration: latest.rows[0] ? await blobMigrationJob(latest.rows[0].id) : null,
  };
}

export type ConnectionTestResult =
  | { ok: true }
  | { ok: false; error: { reason: string; op?: string; status?: number; code?: string } };

/**
 * The S3 probe: a PUT and GET of a fixed object under the configured prefix, left in place. Only the reason and the S3
 * operation, status and error code come back: never a message, which could name a value.
 */
export async function testS3Connection(): Promise<ConnectionTestResult> {
  const problem = await checkMigrationTarget('s3');
  if (!problem) return { ok: true };
  const error: { reason: string; op?: string; status?: number; code?: string } = { reason: String(problem.reason ?? 'error') };
  if (typeof problem.op === 'string') error.op = problem.op;
  if (typeof problem.status === 'number') error.status = problem.status;
  if (typeof problem.code === 'string') error.code = problem.code;
  return { ok: false, error };
}
