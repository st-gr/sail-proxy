/**
 * Blob storage administration (engine in fileSearch/blob/blobMigration.ts, reads in blobAdmin.ts):
 * the panel's figures, the S3 connection test and the migration start. Behind the groundingAdmin
 * guard. Cancel, retry and failures go through the existing `/admin/jobs/:job_id/...` and
 * `/jobs/:job_id/...` handlers, which accept `blob_migration` jobs.
 */
import { Request, Response, NextFunction } from 'express';
import * as migration from '../fileSearch/blob/blobMigration';
import { blobStorageOverview, testS3Connection } from '../fileSearch/blob/blobAdmin';
import { batchJobIdentity, handleDeadlock } from './vectorStoresController';
import { jobOwner } from './groundingController';

const START_REFUSALS: Record<Exclude<migration.StartMigrationRefusal, 'nothing_to_migrate'>, [number, string]> = {
  invalid_target: [400, `target must be one of ${migration.MIGRATION_TARGETS.join(', ')}.`],
  target_unavailable: [409, 'The target blob storage is not configured or not reachable.'],
  migration_running: [409, 'A blob migration is already running.'],
};

/**
 * POST /admin/blob-storage/migrate `{ "target": "db" | "s3" }` - starts moving every blob that is
 * not in `target` there. 200 with the job; 200 with `job: null` when nothing is to be moved; 400
 * for an unknown target; 409 `migration_running` (with `job_id`) or `target_unavailable` (with the
 * reason: storage, S3 operation/status/code, never a key or bucket).
 */
export async function adminStartBlobMigration(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const target = typeof req.body?.target === 'string' ? req.body.target : '';
    const identity = batchJobIdentity(req, email);
    const result = await migration.startBlobMigration(target, {
      email: identity.startedBy ?? email, credentialId: identity.credentialId, authType: identity.authType,
    });
    if (result.ok) { res.status(200).json({ job: result.job }); return; }
    if (result.error === 'nothing_to_migrate') { res.status(200).json({ job: null }); return; }
    const [status, message] = START_REFUSALS[result.error];
    res.status(status).json({
      error: { message, type: 'invalid_request_error', code: result.error },
      ...(result.job_id ? { job_id: result.job_id } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

/**
 * GET /admin/blob-storage - the configured backend, whether S3 is configured (never its bucket,
 * endpoint or keys), blob counts and bytes per storage (live and released apart), the garbage queue
 * and the unfinished or most recent migration.
 */
export async function adminBlobStorage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    res.status(200).json(await blobStorageOverview());
  } catch (error) {
    next(error);
  }
}

/**
 * POST /admin/blob-storage/test - the S3 probe (PUT and GET of a fixed object under the prefix). 200 with
 * `{ ok: true }` or `{ ok: false, error: { reason, op?, status?, code? } }`.
 */
export async function adminTestBlobStorage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    res.status(200).json(await testS3Connection());
  } catch (error) {
    next(error);
  }
}
