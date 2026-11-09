/**
 * Re-embedding routes of the grounding group (grounding phase 4a, plan Decisions 10-12; engine in
 * fileSearch/reembed.ts). Kept apart from groundingController/groundingAdminController, which were
 * near the size guideline already.
 *
 * - User level, OWNER ONLY: `GET /stores/:id/reembed/estimate`, `POST /stores/:id/reembed`. A
 *   non-owner of a shared store gets the same 404 as for an unknown store (spec §5.1). The owner's
 *   cancel and retry of a re-embed job go through the existing `/jobs/:job_id/...` routes
 *   (groundingController), scoped to the owner.
 * - Admin level, behind the groundingAdmin guard: `POST /admin/stores/:id/reembed` resolves the
 *   store's owner first and runs the owner-scoped start with the admin as the actor (the job shows
 *   in the owner's Jobs, started by the admin); `GET /admin/stores/:id/reembed/estimate` resolves the
 *   owner the same way and answers that owner's estimate; `GET /admin/reembed-outdated/estimate` and
 *   `POST /admin/reembed-outdated` cover every owner; `POST /admin/jobs/:job_id/cancel|retry` act
 *   on re-embed jobs of any owner and on blob migrations — a file batch is not found there (Decision 10,
 *   ruling P2).
 * - The files a re-embed job could not re-embed: `GET /jobs/:job_id/failures` resolves the job
 *   owner-scoped like every owner job read (another owner's job is the unknown-job 404, a bulk parent
 *   needs the acting role admin, ruling R10); `GET /admin/jobs/:job_id/failures` takes a re-embed job
 *   of any owner. A blob migration answers its failed blobs instead (sha256, source storage, size,
 *   message). Only these two read query parameters (`limit`, `after`), through queryString().
 */
import { Request, Response, NextFunction } from 'express';
import * as admin from '../fileSearch/admin';
import * as reembed from '../fileSearch/reembed';
import { jobSummary, jobSummaryAnyOwner, type JobSummary } from '../fileSearch/jobs';
import { listReembedFailures } from '../fileSearch/reembedFailures';
import { cancelBlobMigration, listBlobMigrationFailures, retryBlobMigration } from '../fileSearch/blob/blobMigration';
import { buildPage } from '../fileSearch/pagination';
import { queryString } from '../utils/queryParam';
import { batchJobIdentity, handleDeadlock, sendStoreNotFound } from './vectorStoresController';
import {
  REEMBED_KINDS,
  isForeignControl,
  jobOwner,
  sendError,
  sendJobNotFound,
  sendRetryConflictIfDeadlock,
  sendRetryRefusal,
} from './groundingController';

const DEFAULT_FAILURES_LIMIT = 20;

/** The acting user and credential, stamped on the job like a batch's (Decision 14). */
function actorOf(req: Request, actingEmail: string): reembed.ReembedActor {
  const identity = batchJobIdentity(req, actingEmail);
  return { email: identity.startedBy ?? actingEmail, credentialId: identity.credentialId, authType: identity.authType };
}

const REFUSAL_MESSAGES: Record<Exclude<reembed.StartRefusal, 'not_found'>, string> = {
  store_dimension_mismatch:
    'The vector store uses another embedding dimension than the configured model, so it cannot be re-embedded. Create a new store instead.',
  store_expired: 'The vector store has expired; it cannot be re-embedded.',
  reembed_running: 'A re-embed of this vector store is already running.',
  store_current: 'The vector store already uses the configured embedding model.',
};

/** A refused start: 404 for an unknown (or foreign) store, 409 with the engine's code otherwise. */
export function sendStartRefusal(res: Response, error: reembed.StartRefusal, storeId: string): void {
  if (error === 'not_found') { sendStoreNotFound(res, storeId); return; }
  sendError(res, 409, error, REFUSAL_MESSAGES[error]);
}

async function sendStart(res: Response, ownerEmail: string, storeId: string, actor: reembed.ReembedActor): Promise<void> {
  const result = await reembed.startReembed(ownerEmail, storeId, actor);
  if (!result.ok) { sendStartRefusal(res, result.error, storeId); return; }
  res.status(200).json(result.job);
}

// ---------------------------------------------------------------------------
// User level (owner only)
// ---------------------------------------------------------------------------

/** GET /stores/:id/reembed/estimate - files, chunks and estimated tokens of the caller's own store. */
export async function estimateStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const estimate = await reembed.estimateStore(email, req.params.id);
    if (!estimate) { sendStoreNotFound(res, req.params.id); return; }
    res.status(200).json(estimate);
  } catch (error) {
    next(error);
  }
}

/** POST /stores/:id/reembed - re-embeds the caller's own store with the configured model. */
export async function reembedStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    await sendStart(res, email, req.params.id, actorOf(req, email));
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Admin level (behind the groundingAdmin guard)
// ---------------------------------------------------------------------------

/** GET /admin/stores/:id/reembed/estimate - the owner's estimate of any owner's store (ruling R12). */
export async function adminEstimateStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const storeId = req.params.id;
    const owner = await admin.ownerOfStore(storeId);
    const estimate = owner === null ? null : await reembed.estimateStore(owner, storeId);
    // Unknown, or deleted between the two statements: the unknown-store 404.
    if (!estimate) { sendStoreNotFound(res, storeId); return; }
    res.status(200).json(estimate);
  } catch (error) {
    next(error);
  }
}

/** POST /admin/stores/:id/reembed - the owner's start, run as the store's owner, started by the admin. */
export async function adminReembedStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const storeId = req.params.id;
    const owner = await admin.ownerOfStore(storeId);
    // A store deleted between the two statements is the same 404 the owner's start answers.
    if (owner === null) { sendStoreNotFound(res, storeId); return; }
    await sendStart(res, owner, storeId, actorOf(req, email));
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

/** GET /admin/reembed-outdated/estimate - every owner's outdated stores, and the ones a bulk run skips. */
export async function adminEstimateOutdated(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    res.status(200).json(await reembed.estimateOutdated());
  } catch (error) {
    next(error);
  }
}

/** POST /admin/reembed-outdated - one bulk job (owned by the admin) re-embedding every outdated store. */
export async function adminReembedOutdated(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const result = await reembed.startBulkReembed(actorOf(req, email));
    if (!result.ok) { sendError(res, 409, 'nothing_to_reembed', 'No outdated vector store can be re-embedded.'); return; }
    res.status(200).json({ job: result.job, skipped: result.skipped });
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

/** POST /admin/jobs/:job_id/cancel - a re-embed job of any owner or a blob migration; any other job is not found. */
export async function adminCancelJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const found = await jobSummaryAnyOwner(req.params.job_id);
    const result = found?.kind === 'blob_migration'
      ? await cancelBlobMigration(req.params.job_id)
      : await reembed.cancelReembed(null, req.params.job_id);
    if (!result.ok) { sendJobNotFound(res); return; }
    res.status(200).json(result.job);
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

/** POST /admin/jobs/:job_id/retry - a failed re-embed job of any owner or a blob migration; any other
 *  job is not found. Answers like the owner's retry: the job and the number of re-opened items. */
export async function adminRetryJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const jobId = req.params.job_id;
    const found = await jobSummaryAnyOwner(jobId);
    const result = found?.kind === 'blob_migration' ? await retryBlobMigration(jobId) : await reembed.retryReembed(null, jobId);
    if (!result.ok) { sendRetryRefusal(res, result.error, 'The job is still running; retry once it has finished.'); return; }
    const job = await jobSummaryAnyOwner(jobId);
    res.status(200).json({ ...(job ?? { id: jobId }), retried: result.retried });
  } catch (error) {
    if (sendRetryConflictIfDeadlock(error, res)) return;
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Failed files of a re-embed job (owner and admin)
// ---------------------------------------------------------------------------

/**
 * One page of the job's failed items, or the unknown-job 404 when `job` is null or no re-embed
 * job. `limit` 1-100 (default 20) and `after` (the previous page's `last_id`) are the only inputs.
 */
async function sendFailures(req: Request, res: Response, job: JobSummary | null): Promise<void> {
  if (!job || !(REEMBED_KINDS.includes(job.kind) || job.kind === 'blob_migration')) { sendJobNotFound(res); return; }
  const rawLimit = queryString(req.query.limit);
  const limit = rawLimit === null ? DEFAULT_FAILURES_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > admin.MAX_ADMIN_PAGE_LIMIT) {
    sendError(res, 400, 'invalid_limit', `limit must be an integer from 1 to ${admin.MAX_ADMIN_PAGE_LIMIT}.`);
    return;
  }
  try {
    const after = queryString(req.query.after);
    const rows: Array<{ id: string }> = job.kind === 'blob_migration'
      ? await listBlobMigrationFailures(job.id, { limit, after })
      : await listReembedFailures(job.id, { limit, after });
    res.status(200).json({ object: 'list', ...buildPage(rows, limit) });
  } catch (error) {
    if (error instanceof admin.AdminQueryInputError) { sendError(res, 400, 'invalid_parameter', error.message); return; }
    throw error;
  }
}

/** GET /jobs/:job_id/failures - the files the caller's re-embed job could not re-embed. */
export async function jobFailures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const job = await jobSummary(req.params.job_id, email);
    await sendFailures(req, res, job && !isForeignControl(req, job.kind) ? job : null);
  } catch (error) {
    next(error);
  }
}

/** GET /admin/jobs/:job_id/failures - the same for a re-embed job of any owner; a file batch is not found. */
export async function adminJobFailures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    await sendFailures(req, res, await jobSummaryAnyOwner(req.params.job_id));
  } catch (error) {
    next(error);
  }
}
