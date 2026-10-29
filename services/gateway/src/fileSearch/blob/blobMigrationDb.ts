/**
 * Blob migration: the transaction helper shared by its modules, and finishing a job (used by the
 * worker, the queue's reaper and its idle settling).
 */
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db';

export function requirePool(): Pool {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  return pool;
}

/** Runs `work` in a transaction; `commit: false` rolls a refusal or no-op back without an error.
 *  A failed ROLLBACK discards the connection instead of returning it to the pool. */
export async function inTransaction<T>(work: (client: PoolClient) => Promise<{ commit: boolean; value: T }>): Promise<T> {
  const client = await requirePool().connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const { commit, value } = await work(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (e) {
    await client.query('ROLLBACK').catch((r: Error) => { broken = r; });
    throw e;
  } finally {
    client.release(broken);
  }
}

/**
 * Sets `finished_at` (with `error` when an item failed) once no item is open. The job row is
 * locked first and the items counted by a later statement (a fresh snapshot), so two workers
 * finishing the last two items cannot both miss the other. Returns whether it finished the job.
 */
export async function finalizeBlobMigrationJob(jobId: string): Promise<boolean> {
  return inTransaction(async (client) => {
    const locked = await client.query(
      `SELECT 1 FROM fs_jobs WHERE id = $1 AND kind = 'blob_migration' AND finished_at IS NULL
          AND NOT cancel_requested FOR UPDATE`, [jobId]);
    if ((locked.rowCount ?? 0) === 0) return { commit: false, value: false };
    const { rows } = await client.query<{ open: number; failed: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'in_progress')::int AS open,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM fs_blob_migration_items WHERE job_id = $1`, [jobId]);
    if (rows[0].open > 0) return { commit: false, value: false };
    const error = rows[0].failed > 0 ? {
      code: 'blob_migration_failed',
      message: `${rows[0].failed} blob(s) could not be moved; they stay in their current storage.`,
    } : null;
    await client.query('UPDATE fs_jobs SET finished_at = now(), error = $2::jsonb WHERE id = $1',
      [jobId, error ? JSON.stringify(error) : null]);
    return { commit: true, value: true };
  });
}

/** Finishes running jobs with no open item left (a restart came between an item and its job). */
export async function settleIdleBlobMigrationJobs(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT j.id FROM fs_jobs j
      WHERE j.kind = 'blob_migration' AND j.finished_at IS NULL AND NOT j.cancel_requested
        AND NOT EXISTS (SELECT 1 FROM fs_blob_migration_items i WHERE i.job_id = j.id AND i.status = 'in_progress')
      ORDER BY j.id`);
  let finished = 0;
  for (const { id } of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await finalizeBlobMigrationJob(id)) finished += 1;
  }
  return finished;
}
