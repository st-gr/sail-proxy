/**
 * Cockpit-only Grounding handlers (spec 2026-10-01 §5.2): what the admin cockpit needs beyond
 * the OpenAI-shaped file and vector-store routes. Everything here runs behind the admin service
 * key and groundingActingUser, so `req.apiKeyInfo.email` is the acting cockpit user.
 */
import { Request, Response, NextFunction } from 'express';
import { getDefaultLogger } from '@libs/logger';
import { isFileSearchAvailable } from '../fileSearch/db';
import { unavailableBody, fileSearchUnavailableReason } from '../fileSearch/unavailable';
import { getFileSearchConfig } from '../services/configService';
import { installationChunking } from '../fileSearch/chunkingSetting';
import { resolveVisionSettings, visionImagesUnmasked, visionSwitchedOff } from '../fileSearch/visionTranscriber';
import { listAttachmentsForFiles } from '../fileSearch/groundingQueries';
import { deleteFileDetachingEverywhere } from '../fileSearch/repository';
import * as jobs from '../fileSearch/jobs';
import { requestBatchCancel } from '../fileSearch/batches';
import { cancelReembed, retryReembed } from '../fileSearch/reembed';
import { cancelBlobMigration, retryBlobMigration } from '../fileSearch/blob/blobMigration';
import { buildPage } from '../fileSearch/pagination';
import * as filesController from './filesController';
import { handleDeadlock } from './vectorStoresController';
import { queryString } from '../utils/queryParam';

const logger = getDefaultLogger();


/**
 * GET /status. Always 200: an unavailable file_search is an answer here, not an error, so the
 * cockpit can show one "not configured" page that says what is missing.
 */
export function status(_req: Request, res: Response, next: NextFunction): void {
  try {
    const config = getFileSearchConfig();
    const reason = fileSearchUnavailableReason();
    res.status(200).json({
      available: reason === null,
      reason,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      blobBackend: config.blobStorage.backend,
      limits: { maxFileBytes: config.limits.maxFileBytes, maxFilesPerStore: config.limits.maxFilesPerStore },
      // The setting a store created without `chunking` gets (the cockpit's create dialog starts from it).
      chunking: installationChunking(config.chunking),
      // Vision transcription of PDF pages: whether a store may opt in here (not where
      // FILE_SEARCH_VISION switches it off), its model, and whether page images would reach it
      // unmasked while pseudonymization applies to file_search content (shown with a vision mode).
      vision: {
        available: visionSwitchedOff() === null,
        model: resolveVisionSettings().model,
        unmaskedWarning: visionImagesUnmasked('all'),
      },
    });
  } catch (error) {
    logger.error('GroundingController', `status failed: ${(error as Error)?.message}`, error instanceof Error ? error : new Error(String(error)));
    next(error);
  }
}

const MAX_ATTACHMENT_IDS = 100;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function ownerEmailOf(req: Request): string | null {
  const email = (req as any).apiKeyInfo?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

// The same body filesController sends (unavailable.ts: the reason in words).
function sendUnavailable(res: Response): void {
  res.status(503).json(unavailableBody());
}

function sendUnauthorized(res: Response): void {
  res.status(401).json({ error: { message: 'Authentication required.', type: 'authentication_error', code: 'authentication_required' } });
}

/** GET /file-attachments?file_ids=a,b - the stores each of the caller's files is attached to. */
export async function fileAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
    const ownerEmail = ownerEmailOf(req);
    if (!ownerEmail) { sendUnauthorized(res); return; }

    const raw = queryString(req.query.file_ids);
    const ids = raw ? raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0) : [];
    if (ids.length > MAX_ATTACHMENT_IDS || ids.some((id) => !ID_PATTERN.test(id))) {
      res.status(400).json({
        error: {
          message: `file_ids takes up to ${MAX_ATTACHMENT_IDS} comma-separated file ids.`,
          type: 'invalid_request_error',
          code: 'invalid_file_ids',
        },
      });
      return;
    }
    if (ids.length === 0) { res.status(200).json({ data: {} }); return; }

    const found = await listAttachmentsForFiles(ownerEmail, ids);
    const data: Record<string, unknown[]> = {};
    for (const id of ids) data[id] = found[id] || [];
    res.status(200).json({ data });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /files/:id. With `?detach=true` the file is first detached from every store of the
 * caller, then deleted, in one transaction. The OpenAI-shaped delete (the request without the flag,
 * which goes to filesController untouched) now does the same, following OpenAI; the flag stays
 * accepted so the cockpit's call keeps working, and the cockpit still asks the user once.
 */
export async function deleteFile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (queryString(req.query.detach) !== 'true') {
      await filesController.deleteFile(req as any, res, next);
      return;
    }
    if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
    const ownerEmail = ownerEmailOf(req);
    if (!ownerEmail) { sendUnauthorized(res); return; }

    await sendDetachingDelete(res, req.params.id, ownerEmail);
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

/**
 * The `?detach=true` delete of `fileId` as `ownerEmail`, answered on `res`. Also the admin delete
 * (groundingAdminController), which passes the file's resolved owner (plan decision 6).
 */
export async function sendDetachingDelete(res: Response, fileId: string, ownerEmail: string): Promise<void> {
  // Detach and delete are one transaction: a failure leaves the file attached, never half-removed.
  const result = await deleteFileDetachingEverywhere(fileId, ownerEmail);
  if (result.inUse) {
    res.status(409).json({
      error: {
        message: `File ${fileId} is used by a vector store you do not own, so it cannot be deleted.`,
        type: 'invalid_request_error',
        code: 'file_in_use',
      },
    });
    return;
  }
  if (!result.deleted) { sendFileNotFound(res, fileId); return; }
  res.status(200).json({ id: fileId, object: 'file', deleted: true });
}

export function sendFileNotFound(res: Response, fileId: string): void {
  res.status(404).json({ error: { message: `No such file: ${fileId}`, type: 'invalid_request_error', code: 'file_not_found' } });
}

const JOB_STATES: readonly jobs.JobState[] = ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'failed'];
const DEFAULT_JOB_LIMIT = 20;
const MAX_JOB_LIMIT = 100;

export function sendError(res: Response, status: number, code: string, message: string, type = 'invalid_request_error'): void {
  res.status(status).json({ error: { message, type, code } });
}

/** 503/401 gate shared by the job handlers; the owner e-mail, or null once the answer is sent. */
export function jobOwner(req: Request, res: Response): string | null {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return null; }
  const ownerEmail = ownerEmailOf(req);
  if (!ownerEmail) { sendUnauthorized(res); return null; }
  return ownerEmail;
}

/** GET /jobs?limit=&after=&state= - the caller's jobs, newest first. */
export async function listJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerEmail = jobOwner(req, res);
    if (!ownerEmail) return;
    const rawLimit = queryString(req.query.limit);
    const limit = rawLimit === null ? DEFAULT_JOB_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOB_LIMIT) {
      sendError(res, 400, 'invalid_limit', `limit must be an integer from 1 to ${MAX_JOB_LIMIT}.`);
      return;
    }
    const state = queryString(req.query.state);
    if (state !== null && !JOB_STATES.includes(state as jobs.JobState)) {
      sendError(res, 400, 'invalid_state', `state must be one of ${JOB_STATES.join(', ')}.`);
      return;
    }
    const rows = await jobs.listJobs(ownerEmail, { limit, after: queryString(req.query.after), state: state as jobs.JobState | null });
    res.status(200).json({ object: 'list', ...buildPage(rows, limit) });
  } catch (error) {
    next(error);
  }
}

export function sendJobNotFound(res: Response): void {
  sendError(res, 404, 'not_found', 'No such job.');
}

/** GET /jobs/:job_id */
export async function getJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerEmail = jobOwner(req, res);
    if (!ownerEmail) return;
    const job = await jobs.jobSummary(req.params.job_id, ownerEmail);
    if (!job) { sendJobNotFound(res); return; }
    res.status(200).json(job);
  } catch (error) {
    next(error);
  }
}

export const REEMBED_KINDS: readonly string[] = ['reembed_store', 'reembed_bulk'];

/** The kinds only an admin starts. */
export const ADMIN_JOB_KINDS: readonly string[] = ['reembed_bulk', 'blob_migration'];

/** A bulk parent (ruling R2) and a blob migration are admins' jobs: cancel, retry and read their
 *  failures only while the acting role is admin, so a demoted admin no longer controls the runs it
 *  started (ruling R10). */
export function isForeignControl(req: Request, kind: string): boolean {
  return ADMIN_JOB_KINDS.includes(kind) && (req as any).groundingActor?.role !== 'admin';
}

/**
 * POST /jobs/:job_id/cancel. Only a queued or running batch gets the cancel latch: on a finished job it
 * would flip the derived state to `cancelled`, so a finished (or already cancelling) batch is answered
 * unchanged. A re-embed job of the caller goes to the re-embed engine, which decides the same for its
 * kinds (a failed one can be cancelled to discard its generation).
 */
export async function cancelJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerEmail = jobOwner(req, res);
    if (!ownerEmail) return;
    const jobId = req.params.job_id;
    const job = await jobs.jobSummary(jobId, ownerEmail);
    if (!job || isForeignControl(req, job.kind)) { sendJobNotFound(res); return; }
    if (REEMBED_KINDS.includes(job.kind)) {
      const result = await cancelReembed(ownerEmail, jobId);
      if (!result.ok) { sendJobNotFound(res); return; }
      res.status(200).json(result.job);
      return;
    }
    if (job.kind === 'blob_migration') {
      const result = await cancelBlobMigration(jobId);
      if (!result.ok) { sendJobNotFound(res); return; }
      res.status(200).json((await jobs.jobSummary(jobId, ownerEmail)) ?? result.job);
      return;
    }
    if ((job.state === 'queued' || job.state === 'running') && job.store_id && job.batch_id) {
      await requestBatchCancel(job.store_id, job.batch_id);
      res.status(200).json((await jobs.jobSummary(jobId, ownerEmail)) ?? job);
      return;
    }
    res.status(200).json(job);
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

export function sendRetryRefusal(res: Response, error: jobs.JobErrorCode, running: string): void {
  switch (error) {
    case 'not_found': sendError(res, 404, 'not_found', 'Nothing to retry was found.'); return;
    case 'job_running': sendError(res, 409, 'job_running', running); return;
    case 'store_expired': sendError(res, 409, 'store_expired', 'The vector store has expired; its files cannot be retried.'); return;
    case 'superseded': sendError(res, 409, 'superseded', 'A newer blob migration was started since; start a new migration instead.'); return;
    default: sendError(res, 409, 'nothing_to_retry', 'No failed file is left to retry.');
  }
}

/** A deadlock with the ingest worker (it took the same rows) is transient: answer "try again". */
function isDeadlock(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '40P01';
}

function sendRetryConflict(res: Response): void {
  sendError(res, 503, 'retry_conflict', 'The files are being processed right now. Try again.', 'server_error');
}

/** A retry's deadlock answered as 503 retry_conflict; whether it was one. Also the admin re-embed retry. */
export function sendRetryConflictIfDeadlock(error: unknown, res: Response): boolean {
  if (!isDeadlock(error)) return false;
  sendRetryConflict(res);
  return true;
}

/** POST /jobs/:job_id/retry - re-opens the job's failed files, or a failed re-embed job's failed items. */
export async function retryJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerEmail = jobOwner(req, res);
    if (!ownerEmail) return;
    const jobId = req.params.job_id;
    const found = await jobs.jobSummary(jobId, ownerEmail);
    if (!found || isForeignControl(req, found.kind)) { sendRetryRefusal(res, 'not_found', ''); return; }
    const result = REEMBED_KINDS.includes(found.kind) ? await retryReembed(ownerEmail, jobId)
      : found.kind === 'blob_migration' ? await retryBlobMigration(jobId)
        : await jobs.retryJob(jobId, ownerEmail);
    if (!result.ok) { sendRetryRefusal(res, result.error, 'The job is still running; retry once it has finished.'); return; }
    const job = await jobs.jobSummary(jobId, ownerEmail);
    res.status(200).json({ ...(job ?? { id: jobId }), retried: result.retried });
  } catch (error) {
    if (sendRetryConflictIfDeadlock(error, res)) return;
    next(error);
  }
}

/** POST /stores/:id/files/:file_id/retry - re-opens one failed file. */
export async function retryStoreFile(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ownerEmail = jobOwner(req, res);
  if (!ownerEmail) return;
  await sendStoreFileRetry(res, next, req.params.id, req.params.file_id, ownerEmail);
}

/**
 * Re-opens one failed file of `ownerEmail`'s store and answers on `res`. Also the admin retry
 * (groundingAdminController), which passes the store's resolved owner (plan decision 6).
 */
export async function sendStoreFileRetry(
  res: Response, next: NextFunction, storeId: string, fileId: string, ownerEmail: string,
): Promise<void> {
  try {
    const result = await jobs.retryFile(storeId, fileId, ownerEmail);
    if (!result.ok) { sendRetryRefusal(res, result.error, "The file's batch is still running; retry once it has finished."); return; }
    const job = result.job_id ? await jobs.jobSummary(result.job_id, ownerEmail) : null;
    res.status(200).json({ job_id: result.job_id, job, retried: result.retried });
  } catch (error) {
    if (isDeadlock(error)) { sendRetryConflict(res); return; }
    next(error);
  }
}
