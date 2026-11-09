/**
 * Blob migration, the routes' side: start, cancel, retry and the reads behind the admin panel and
 * the Jobs screen. Nothing here is HTTP-aware; the admin handlers call these functions. The worker
 * side is blobMigrationWorker.ts (one item) and blobMigrationQueue.ts (claim, loop).
 *
 * A `blob_migration` job (`fs_jobs`, no store, owned by the admin who started it) pins its target
 * in `target_storage` and has one `fs_blob_migration_items` row per blob not yet in the target,
 * taken when it starts. At most one is unfinished at a time (the unique index
 * idx_fs_jobs_blob_migration_running). State and counters are derived from the items (jobs.ts).
 *
 * LOCK ORDER: the job row FOR UPDATE, then its items. The worker's switch locks a blob (per-sha
 * advisory lock, then the row) and then only its own item, never the job, so neither waits on
 * the other in a cycle.
 */
import { getFileSearchConfig } from '../../services/configService';
import { newJobId } from '../ids';
import { jobSummaryAnyOwner, JobSummary, RetryResult } from '../jobs';
import { AdminQueryInputError, MAX_ADMIN_PAGE_LIMIT } from '../admin';
import { backendForStorage } from './blobStore';
import { errorSummary } from './blobSweeper';
import type { S3Backend } from './s3Backend';
import { wakeBlobMigrationWorker } from './blobMigrationQueue';
import { inTransaction, requirePool } from './blobMigrationDb';

export const MIGRATION_TARGETS = ['db', 's3'] as const;
export type MigrationTarget = typeof MIGRATION_TARGETS[number];

export type BlobMigrationJob = JobSummary & { owner_email: string | null; target_storage: string | null };

/** Who starts a migration: recorded as owner and `started_by`, with the credential (like a re-embed). */
export interface MigrationActor {
  email: string;
  credentialId?: string | null;
  authType?: string | null;
}

export type StartMigrationRefusal = 'invalid_target' | 'target_unavailable' | 'migration_running' | 'nothing_to_migrate';

export type StartMigrationResult =
  | { ok: true; job: BlobMigrationJob }
  | { ok: false; error: StartMigrationRefusal; detail?: Record<string, unknown>; job_id?: string };

/** The job with its target, or null when there is no blob migration of that id. */
export async function blobMigrationJob(jobId: string): Promise<BlobMigrationJob | null> {
  const summary = await jobSummaryAnyOwner(jobId);
  if (!summary || summary.kind !== 'blob_migration') return null;
  const { rows } = await requirePool().query<{ target_storage: string | null }>(
    'SELECT target_storage FROM fs_jobs WHERE id = $1', [jobId]);
  return { ...summary, target_storage: rows[0]?.target_storage ?? null };
}

/** The unfinished blob migration, if any (for the admin panel). */
export async function runningBlobMigration(): Promise<BlobMigrationJob | null> {
  const { rows } = await requirePool().query<{ id: string }>(
    `SELECT id FROM fs_jobs WHERE kind = 'blob_migration' AND finished_at IS NULL`);
  return rows[0] ? blobMigrationJob(rows[0].id) : null;
}

/**
 * Whether `target` can take blobs now: db always; s3 needs its configuration, credentials and a
 * successful probe (PUT and GET of the fixed probe object under the prefix, left in place: see
 * S3Backend.probe). Null when reachable, else an operator-facing summary (storage,
 * reason, S3 op/status/code; never a key, bucket or host).
 */
export async function checkMigrationTarget(target: MigrationTarget): Promise<Record<string, unknown> | null> {
  if (target === 'db') return null;
  try {
    const backend = backendForStorage(target, getFileSearchConfig().blobStorage) as S3Backend;
    await backend.probe();
    return null;
  } catch (e) {
    return errorSummary(e);
  }
}

/**
 * Starts moving every blob not stored in `target` there (released ones included: see
 * blobMigrationWorker.ts). Refuses an unknown target, a target that is not configured or not
 * reachable, a second unfinished migration, and an empty move (no job is created).
 */
export async function startBlobMigration(target: string, actor: MigrationActor): Promise<StartMigrationResult> {
  if (!(MIGRATION_TARGETS as readonly string[]).includes(target)) return { ok: false, error: 'invalid_target' };
  const running = await runningBlobMigration();
  if (running) return { ok: false, error: 'migration_running', job_id: running.id };
  const problem = await checkMigrationTarget(target as MigrationTarget);
  if (problem) return { ok: false, error: 'target_unavailable', detail: problem };

  const jobId = newJobId();
  let items: number;
  try {
    items = await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO fs_jobs (id, kind, owner_email, started_by, credential_id, auth_type, target_storage)
         VALUES ($1, 'blob_migration', $2, $2, $3, $4, $5)`,
        [jobId, actor.email, actor.credentialId ?? null, actor.authType ?? null, target]);
      const inserted = await client.query(
        `INSERT INTO fs_blob_migration_items (job_id, sha256, source_storage)
         SELECT $1, sha256, storage FROM file_blobs WHERE storage <> $2`,
        [jobId, target]);
      const n = inserted.rowCount ?? 0;
      return { commit: n > 0, value: n };
    });
  } catch (error: any) {
    // The unique "one unfinished blob migration" index: a concurrent start won.
    if (error?.code === '23505') return { ok: false, error: 'migration_running' };
    throw error;
  }
  if (items === 0) return { ok: false, error: 'nothing_to_migrate' };
  wakeBlobMigrationWorker();
  const job = await blobMigrationJob(jobId);
  if (!job) throw new Error('blob migration job vanished right after its start');
  return { ok: true, job };
}

export type CancelMigrationResult = { ok: true; job: BlobMigrationJob } | { ok: false; error: 'not_found' };

/**
 * Cancels a running migration: its open items `cancelled`, the job finished as cancelled, in one
 * transaction. An item a worker is moving right now is cancelled too: its switch then moves
 * nothing (a copy already written is queued as garbage) and the blob stays where it was. If that
 * switch holds the item's lock, the cancel waits for it, at most the S3 GET deadline of its
 * read-back. A finished or already cancelled job is answered unchanged.
 */
export async function cancelBlobMigration(jobId: string): Promise<CancelMigrationResult> {
  const found = await inTransaction(async (client) => {
    const { rows } = await client.query<{ cancel_requested: boolean; finished_at: Date | null }>(
      `SELECT cancel_requested, finished_at FROM fs_jobs WHERE id = $1 AND kind = 'blob_migration' FOR UPDATE`, [jobId]);
    const job = rows[0];
    if (!job) return { commit: false, value: false };
    if (job.cancel_requested || job.finished_at) return { commit: false, value: true };
    await client.query(
      `UPDATE fs_blob_migration_items SET status = 'cancelled' WHERE job_id = $1 AND status = 'in_progress'`, [jobId]);
    await client.query('UPDATE fs_jobs SET cancel_requested = true, finished_at = now() WHERE id = $1', [jobId]);
    return { commit: true, value: true };
  });
  const job = found ? await blobMigrationJob(jobId) : null;
  return job ? { ok: true, job } : { ok: false, error: 'not_found' };
}

/**
 * Re-opens the failed items of a finished, not cancelled migration and runs it again. Refused
 * while it runs or while another migration is unfinished (`job_running`), when a newer migration
 * was started since (`superseded`: its items reflect where the blobs are now), and when nothing
 * failed.
 */
export async function retryBlobMigration(jobId: string): Promise<RetryResult> {
  let result: RetryResult;
  try {
    result = await inTransaction<RetryResult>(async (client) => {
      const refuse = (error: 'not_found' | 'job_running' | 'nothing_to_retry' | 'superseded') =>
        ({ commit: false, value: { ok: false as const, error } });
      const { rows } = await client.query<{ cancel_requested: boolean; finished_at: Date | null; newer: boolean }>(
        `SELECT j.cancel_requested, j.finished_at,
                EXISTS (SELECT 1 FROM fs_jobs n WHERE n.kind = 'blob_migration' AND n.id <> j.id
                           AND n.created_at > j.created_at) AS newer
           FROM fs_jobs j WHERE j.id = $1 AND j.kind = 'blob_migration' FOR UPDATE OF j`, [jobId]);
      const job = rows[0];
      if (!job) return refuse('not_found');
      if (!job.finished_at) return refuse('job_running');
      if (job.cancel_requested) return refuse('nothing_to_retry');
      if (job.newer) return refuse('superseded');
      const reopened = await client.query(
        `UPDATE fs_blob_migration_items SET status = 'in_progress', attempts = 0, last_error = NULL, claimed_at = NULL
          WHERE job_id = $1 AND status = 'failed'`, [jobId]);
      if ((reopened.rowCount ?? 0) === 0) return refuse('nothing_to_retry');
      await client.query('UPDATE fs_jobs SET finished_at = NULL, error = NULL WHERE id = $1', [jobId]);
      return { commit: true, value: { ok: true as const, job_id: jobId, retried: reopened.rowCount ?? 0 } };
    });
  } catch (error: any) {
    if (error?.code === '23505') return { ok: false, error: 'job_running' };
    throw error;
  }
  if (result.ok) wakeBlobMigrationWorker();
  return result;
}

export interface BlobMigrationFailureRow {
  /** The sha256: the paging cursor. */
  id: string;
  sha256: string;
  source_storage: string;
  size_bytes: number | null;
  last_error: { message: string | null };
  attempts: number;
}

const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * One page of a migration's failed items, keyset on sha256 ascending (`after` = the previous
 * page's last id). Up to `limit + 1` rows, for pagination.buildPage. Never selects a location.
 */
export async function listBlobMigrationFailures(
  jobId: string, opts: { limit: number; after?: string | null },
): Promise<BlobMigrationFailureRow[]> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_ADMIN_PAGE_LIMIT) {
    throw new AdminQueryInputError(`limit must be an integer from 1 to ${MAX_ADMIN_PAGE_LIMIT}.`);
  }
  const params: unknown[] = [jobId];
  let cursor = '';
  if (opts.after !== undefined && opts.after !== null) {
    if (!SHA_RE.test(opts.after)) throw new AdminQueryInputError('after must be the last id of the previous page.');
    params.push(opts.after);
    cursor = 'AND i.sha256 > $2';
  }
  params.push(opts.limit + 1);
  const { rows } = await requirePool().query(
    `SELECT i.sha256 AS id, i.sha256, i.source_storage, b.size_bytes,
            jsonb_build_object('message', i.last_error->>'message') AS last_error, i.attempts
       FROM fs_blob_migration_items i
       LEFT JOIN file_blobs b ON b.sha256 = i.sha256
      WHERE i.job_id = $1 AND i.status = 'failed' ${cursor}
      ORDER BY i.sha256
      LIMIT $${params.length}`,
    params);
  return rows.map((r) => ({ ...r, size_bytes: r.size_bytes === null ? null : Number(r.size_bytes) }));
}
