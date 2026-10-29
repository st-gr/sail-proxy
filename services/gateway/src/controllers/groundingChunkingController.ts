/**
 * Chunking routes of the grounding group (W2: a store's chunking setting; engine in
 * fileSearch/rechunk.ts). Grounding-only: the OpenAI-shaped routes never see a store setting.
 *
 * - `POST /stores` - the shared OpenAI create, plus a `chunking` field (`{type, max_tokens,
 *   overlap_tokens, contextual, vision?}`, validated as a store setting: 400 when invalid, and for a
 *   vision mode where vision is switched off). Without it the store gets the installation default
 *   (`file_search.chunking` with `file_search.parsing.vision.default_mode`).
 * - User level, OWNER ONLY (a non-owner of a shared store gets the unknown-store 404):
 *   `GET /stores/:id/chunking/estimate?type=&max_tokens=&overlap_tokens=&contextual=&vision=` - what
 *   re-chunking to that setting would cost (estimates only; no blob, embedding or LLM call);
 *   `POST /stores/:id/chunking` with `{chunking: {...}}` - starts the re-chunk job (a
 *   `reembed_store` job with `target_chunking`); 409 when a re-embed or re-chunk is running, the
 *   setting is the store's already, the store expired or has another dimension, or its embedding
 *   model is no longer served (`store_model_unavailable`: checked with one short embedding before
 *   the job is created; the estimate reports a model already found not served), or a contextual
 *   target's context model is not served (`context_model_unavailable`: one tiny context call), or
 *   a target with a vision mode finds the vision model not served or vision switched off on this
 *   gateway (`vision_model_unavailable`: one tiny call with an image; no call when switched off). A
 *   start with the store's own contextual setting is allowed while chunks lack their context (the
 *   estimate's `chunks_without_context`): it fills them. Cancel and retry
 *   go through the existing job routes.
 * - Admin level, behind the groundingAdmin guard: `GET /admin/stores/:id/chunking/estimate` and
 *   `POST /admin/stores/:id/chunking` resolve the store's owner first and act as that owner, the
 *   admin recorded as the starter (like the re-embed's admin routes).
 * - Re-extract (W3; engine in fileSearch/reextract.ts), with the same owner and admin rules:
 *   `GET /stores/:id/reextract/estimate` - which files would be read again (those an older extractor
 *   read: PDFs before W3), which are kept, the failed PowerPoint/Excel files a start queues again, and
 *   what reading them again costs (estimates; vision "up to"); `POST /stores/:id/reextract` (no body)
 *   - starts it: `{job, retried_files, refused_files}` (`job` null when only failed files were queued;
 *   `refused_files`: the failed files the file retry refused, `[{file_id, error}]`); 409 for
 *   `nothing_to_reextract`, `store_chunking_invalid`, and the re-chunk's refusals (a running job, an
 *   expired store, another dimension, a model not served). Admin: `GET /admin/stores/:id/reextract/estimate`
 *   and `POST /admin/stores/:id/reextract`.
 */
import { Request, Response, NextFunction } from 'express';
import * as admin from '../fileSearch/admin';
import { ChunkingSetting, ChunkingStrategyError, validateChunkingSetting } from '../fileSearch/chunkingSetting';
import * as rechunk from '../fileSearch/rechunk';
import * as reextract from '../fileSearch/reextract';
import type { ReembedActor } from '../fileSearch/reembed';
import { queryString } from '../utils/queryParam';
import {
  batchJobIdentity, createVectorStore, GROUNDING_STORE_CHUNKING, handleDeadlock, sendStoreNotFound,
} from './vectorStoresController';
import { jobOwner, sendError } from './groundingController';

function actorOf(req: Request, actingEmail: string): ReembedActor {
  const identity = batchJobIdentity(req, actingEmail);
  return { email: identity.startedBy ?? actingEmail, credentialId: identity.credentialId, authType: identity.authType };
}

function sendInvalidSetting(res: Response, error: ChunkingStrategyError): void {
  res.status(400).json({ error: { message: error.message, type: 'invalid_request_error', param: error.param, code: error.code } });
}

/** A whole number stays a number; anything else is passed on as given, for the validator to name. */
function queryNumber(value: string | null): unknown {
  if (value === null) return undefined;
  return /^\d{1,9}$/.test(value) ? Number(value) : value;
}

/** The estimate's target setting from the query (`type`, `max_tokens`, `overlap_tokens`, `contextual`,
 *  `vision`). */
function settingFromQuery(query: Record<string, unknown>): ChunkingSetting {
  const contextual = queryString(query.contextual);
  return validateChunkingSetting({
    type: queryString(query.type) ?? undefined,
    max_tokens: queryNumber(queryString(query.max_tokens)),
    overlap_tokens: queryNumber(queryString(query.overlap_tokens)),
    contextual: contextual === null ? undefined : contextual === 'true' ? true : contextual === 'false' ? false : contextual,
    vision: queryString(query.vision) ?? undefined,
  });
}

const REFUSAL_MESSAGES: Record<Exclude<rechunk.RechunkRefusal, 'not_found'>, string> = {
  store_dimension_mismatch:
    'The vector store uses another embedding dimension than the configured model, so its files cannot be chunked again. Create a new store instead.',
  store_expired: 'The vector store has expired; its chunking cannot be changed.',
  reembed_running: 'A re-embed or re-chunk of this vector store is already running.',
  chunking_current: 'The vector store already uses this chunking setting.',
  store_model_unavailable:
    'The vector store\'s embedding model is no longer available, so its files cannot be embedded again. Re-embed the store first.',
  context_model_unavailable:
    'The model configured to write chunk contexts is not available, so contexts cannot be written. Ask an administrator to configure an available context model.',
  vision_model_unavailable:
    'Vision transcription is not available: it is switched off on this gateway, or the configured vision model is not served or does not read images. Choose the vision mode "off", or ask an administrator to configure an available vision model.',
};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** POST /stores - the shared OpenAI create with the store's `chunking` setting. */
export async function createStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.locals[GROUNDING_STORE_CHUNKING] = (req.body ?? {}).chunking;
  await createVectorStore(req as any, res, next);
}

// ---------------------------------------------------------------------------
// Estimate and start, for the owner (resolved by the caller)
// ---------------------------------------------------------------------------

async function sendEstimate(req: Request, res: Response, owner: string | null): Promise<void> {
  let target: ChunkingSetting;
  try {
    target = settingFromQuery(req.query as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ChunkingStrategyError) { sendInvalidSetting(res, error); return; }
    throw error;
  }
  const storeId = req.params.id;
  const estimate = owner === null ? null : await rechunk.estimateRechunk(owner, storeId, target);
  if (!estimate) { sendStoreNotFound(res, storeId); return; }
  res.status(200).json(estimate);
}

async function sendStart(req: Request, res: Response, owner: string | null, actor: ReembedActor): Promise<void> {
  let target: ChunkingSetting;
  try {
    target = validateChunkingSetting((req.body ?? {}).chunking);
  } catch (error) {
    if (error instanceof ChunkingStrategyError) { sendInvalidSetting(res, error); return; }
    throw error;
  }
  const storeId = req.params.id;
  // A store deleted between resolving its owner and the start is the same 404.
  if (owner === null) { sendStoreNotFound(res, storeId); return; }
  const result = await rechunk.startRechunk(owner, storeId, target, actor);
  if (!result.ok) {
    if (result.error === 'not_found') { sendStoreNotFound(res, storeId); return; }
    sendError(res, 409, result.error, REFUSAL_MESSAGES[result.error]);
    return;
  }
  res.status(200).json(result.job);
}

/** GET /stores/:id/chunking/estimate - the caller's own store. */
export async function estimateChunking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    await sendEstimate(req, res, email);
  } catch (error) {
    next(error);
  }
}

/** POST /stores/:id/chunking - re-chunks the caller's own store to `chunking`. */
export async function startChunking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    await sendStart(req, res, email, actorOf(req, email));
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

/** GET /admin/stores/:id/chunking/estimate - the estimate of any owner's store, as its owner. */
export async function adminEstimateChunking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    await sendEstimate(req, res, await admin.ownerOfStore(req.params.id));
  } catch (error) {
    next(error);
  }
}

/** POST /admin/stores/:id/chunking - the owner's re-chunk, run as the store's owner, started by the admin. */
export async function adminStartChunking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    await sendStart(req, res, await admin.ownerOfStore(req.params.id), actorOf(req, email));
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Re-extract
// ---------------------------------------------------------------------------

const REEXTRACT_MESSAGES: Record<Exclude<reextract.ReextractRefusal, 'not_found'>, string> = {
  store_dimension_mismatch: REFUSAL_MESSAGES.store_dimension_mismatch,
  store_expired: 'The vector store has expired; its files cannot be read again.',
  reembed_running: REFUSAL_MESSAGES.reembed_running,
  nothing_to_reextract: 'Every file of this vector store was read by the current extractors; there is nothing to read again.',
  store_chunking_invalid:
    'The vector store\'s chunking setting is not valid, so its files cannot be chunked again with it. Change the chunking instead.',
  store_model_unavailable: REFUSAL_MESSAGES.store_model_unavailable,
  context_model_unavailable: REFUSAL_MESSAGES.context_model_unavailable,
  vision_model_unavailable:
    'Vision transcription is not available: it is switched off on this gateway, or the configured vision model is not served or does not read images. Change the chunking to the vision mode "off", or ask an administrator to configure an available vision model.',
};

async function sendReextractEstimate(req: Request, res: Response, owner: string | null): Promise<void> {
  const storeId = req.params.id;
  const estimate = owner === null ? null : await reextract.estimateReextract(owner, storeId);
  if (!estimate) { sendStoreNotFound(res, storeId); return; }
  res.status(200).json(estimate);
}

async function sendReextractStart(req: Request, res: Response, owner: string | null, actor: ReembedActor): Promise<void> {
  const storeId = req.params.id;
  if (owner === null) { sendStoreNotFound(res, storeId); return; }
  const result = await reextract.startReextract(owner, storeId, actor);
  if (!result.ok) {
    if (result.error === 'not_found') { sendStoreNotFound(res, storeId); return; }
    sendError(res, 409, result.error, REEXTRACT_MESSAGES[result.error]);
    return;
  }
  res.status(200).json({ job: result.job, retried_files: result.retried_files, refused_files: result.refused_files });
}

/** GET /stores/:id/reextract/estimate - the caller's own store. */
export async function estimateReextract(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    await sendReextractEstimate(req, res, email);
  } catch (error) {
    next(error);
  }
}

/** POST /stores/:id/reextract - re-extracts the caller's own store. */
export async function startReextract(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    await sendReextractStart(req, res, email, actorOf(req, email));
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}

/** GET /admin/stores/:id/reextract/estimate - the estimate of any owner's store, as its owner. */
export async function adminEstimateReextract(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    await sendReextractEstimate(req, res, await admin.ownerOfStore(req.params.id));
  } catch (error) {
    next(error);
  }
}

/** POST /admin/stores/:id/reextract - the owner's re-extract, run as the store's owner, started by the admin. */
export async function adminStartReextract(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    await sendReextractStart(req, res, await admin.ownerOfStore(req.params.id), actorOf(req, email));
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    next(error);
  }
}
