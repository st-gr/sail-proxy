/**
 * OpenAI-compatible `/vector_stores` and `/vector_stores/{id}/files`
 * endpoints. Mirrors `filesController.ts`'s hardened patterns exactly:
 * owner identity from `req.apiKeyInfo?.email ?? req.apiKey?.email`, a
 * `503 file_search_unavailable` guard on every handler, 404 (never 403,
 * never distinguishable from "does not exist") for another owner's
 * resource, ownership scoped INSIDE each query rather than filtered
 * afterwards, and cursor pagination via `parsePageParams`/`buildPage`.
 *
 * Three properties specific to this controller (see `fileSearch/storeValidation.ts`
 * for the mechanics):
 *  - a store's pinned `embedding_dim` is checked against the live
 *    configuration before any operation that would create new vectors for
 *    it (attaching a file) — `assertStoreDimension` throws a 409, mapped
 *    below, rather than letting a dimension-mismatched insert reach
 *    pgvector as a raw 500;
 *  - an `'expired'` store rejects attach (here) and search (`search.ts`)
 *    with a 409 — `assertStoreNotExpired`/`StoreExpiredError`, mapped below
 *    — while remaining retrievable/listable/deletable, matching OpenAI's own
 *    "expired keeps its row" semantics for the read paths;
 *  - deleting a store, or detaching a file from one, removes that store's
 *    chunks and `vector_store_files` association ONLY, inside one
 *    transaction — it never touches `fs_files` or any blob. A file persists
 *    independently of vector-store attachment (OpenAI's own semantics: this
 *    is not a delete), so it can be re-attached, or was already attached to
 *    another store, without ever having lost its bytes. The only path that
 *    removes an `fs_files` row and decrements a blob's ref_count is
 *    `filesController.deleteFile` (`DELETE /files/{id}`), which detaches the
 *    file from every store of its owner and deletes it in one transaction
 *    (409 only while a store of another owner still references it).
 */
import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { getPool, isFileSearchAvailable } from '../fileSearch/db';
import { notExpiredSql, attachedFileNotExpiredSql } from '../fileSearch/fileRows';
import { unavailableBody } from '../fileSearch/unavailable';
import { FileSearchBusyError } from '../fileSearch/dbBusy';
import { getFileSearchConfig } from '../services/configService';
import { parsePageParams, buildPage } from '../fileSearch/pagination';
import {
  createStore,
  attachFile,
  enqueueIngestion,
  deleteStoreFile,
  deleteStoreCascade,
  assertStoreDimension,
  assertStoreNotExpired,
  validateAttributes,
  StoreDimensionMismatchError,
  StoreExpiredError,
  AttributeValidationError,
  RecallInputError,
  VectorStoreRow,
  VectorStoreFileRow,
  AttachStamp,
  FileCounts,
  FileStatus,
  VALID_FILE_STATUSES,
  ACTIVE_GENERATION_PREDICATE_SQL,
} from '../fileSearch/repository';
import {
  createBatch,
  getBatch,
  batchStatusAndCounts,
  requestBatchCancel,
  listBatchFiles,
  BatchRow,
  BatchStatus,
  CreateBatchJobOptions,
  BatchFile,
} from '../fileSearch/batches';
import {
  searchVectorStores, SearchStoreNotFoundError, SearchQueryTooLongError, StoreModelUnavailableError, SEARCH_RANKERS,
  MIN_MAX_NUM_RESULTS, MAX_MAX_NUM_RESULTS,
} from '../fileSearch/search';
import { RerankerUnavailableError } from '../fileSearch/reranker';
import { HybridWeights, parseHybridSearch } from '../fileSearch/rrf';
import { fileSearchCallerOf, searchUsageSink } from '../fileSearch/usage';
import { callerTeamIds } from '../utils/userBlock';
import { getDefaultLogger } from '@libs/logger';
import {
  ChunkingStrategyError, fileChunkingStrategyObject, parseFileChunkingStrategy, resolveChunking, validateChunkingSetting,
} from '../fileSearch/chunkingSetting';
import { visionModeOf, visionSwitchedOff, warnVisionUnmasked } from '../fileSearch/visionTranscriber';

const logger = getDefaultLogger();

interface AuthenticatedRequest extends Request {
  apiKeyInfo?: { email?: string; [key: string]: any };
  apiKey?: { email?: string; [key: string]: any };
}

// ---------------------------------------------------------------------------
// Shared response helpers
// ---------------------------------------------------------------------------

function sendUnavailable(res: Response): void {
  res.status(503).json(unavailableBody());
}

/**
 * `RerankerUnavailableError`'s own `status`/`code` (503 / `file_search_unavailable`)
 * already match this envelope; this helper just puts them on the wire the same way
 * `sendUnavailable` above and `filesController.ts`'s `sendIfUnsupportedBlobBackend` do,
 * carrying the error's own message (a fixed, non-caller-interpolated string — see
 * reranker.ts) instead of `sendUnavailable`'s reason (unavailable.ts), since this is a
 * different, more specific unavailability.
 */
function sendRerankerUnavailable(res: Response, message: string): void {
  res.status(503).json({
    error: { message, type: 'file_search_unavailable', code: 'file_search_unavailable' },
  });
}

/** No database connection in time (`FileSearchBusyError`): a retryable 503 in the file_search
 *  envelope. Returns whether it answered. */
function sendIfBusy(res: Response, error: unknown): boolean {
  if (!(error instanceof FileSearchBusyError)) return false;
  res.status(503).json({ error: { message: error.message, type: 'file_search_unavailable', code: error.code } });
  return true;
}

function sendUnauthorized(res: Response): void {
  res.status(401).json({
    error: {
      message: 'Authentication required.',
      type: 'authentication_error',
      code: 'authentication_required',
    },
  });
}

/** Deliberately identical whether a store id doesn't exist at all or exists
 *  but is owned by someone else — callers must not be able to distinguish
 *  the two cases from status, body, or shape. */
export function sendStoreNotFound(res: Response, id: string): void {
  res.status(404).json({
    error: { message: `No such vector store: ${id}`, type: 'invalid_request_error', code: 'vector_store_not_found' },
  });
}

/** Same non-distinguishing guarantee as `sendStoreNotFound`, for the
 *  (store-not-found OR file-not-attached-to-that-store) case — a single
 *  query below produces this outcome for both, so there is exactly one
 *  code path, not two that could drift out of sync. */
function sendStoreFileNotFound(res: Response, fileId: string): void {
  res.status(404).json({
    error: {
      message: `No such vector store file: ${fileId}`,
      type: 'invalid_request_error',
      code: 'vector_store_file_not_found',
    },
  });
}

/**
 * The batch-shaped sibling of `sendStoreFileNotFound`, with the identical
 * non-distinguishing guarantee: a batch id that never existed, a batch id
 * belonging to ANOTHER store, and a batch in a store the caller does not own
 * must all produce this exact response. A 403 (or any other body) for the
 * second two would turn `GET .../file_batches/{id}` into an existence oracle
 * for `vsfb_` ids — see `assertStoresAccessible` in fileSearch/storeAccess.ts and the
 * TENANT BOUNDARY note at the top of `fileSearch/batches.ts`, whose
 * `store_id`-scoped queries are the other half of this property.
 *
 * This is a distinct helper rather than a reuse of `sendStoreNotFound`
 * because the two are different resources: reusing the store helper would
 * emit `No such vector store: vsfb_...`, naming a resource kind the caller
 * never asked about, and would make a genuinely missing STORE
 * indistinguishable from a missing BATCH in a store the caller does own —
 * a distinction the caller legitimately needs and that leaks nothing.
 */
function sendBatchNotFound(res: Response, batchId: string): void {
  res.status(404).json({
    error: {
      message: `No such vector store file batch: ${batchId}`,
      type: 'invalid_request_error',
      code: 'vector_store_file_batch_not_found',
    },
  });
}

function sendInvalidRequest(res: Response, message: string, code: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', code } });
}

/**
 * Maps Postgres's `40P01` (deadlock_detected) to a clean, retryable 409
 * instead of letting it fall through to `next(error)` -> a raw 500 that
 * leaks the driver's message. Returns whether it handled the error (caller
 * should return immediately if true).
 *
 * Deadlocks between `deleteStoreFile`/`deleteStoreCascade` and a concurrent
 * ingestion write (`ingestWorker.ts`'s `commitChunks`) are expected to be
 * rare in production now that both sides lock `vector_stores` before
 * `vector_store_files` (see fileSearch/storeFiles.ts's `deleteStoreFile` doc comment),
 * but Postgres's deadlock detector is a last-resort safety net, not a
 * guarantee of zero races — one of the two competing transactions can still
 * be chosen as the victim under genuine concurrency, and that must surface
 * as something the client can sensibly retry, not a 500.
 */
export function handleDeadlock(error: any, res: Response): boolean {
  if (error?.code !== '40P01') return false;
  res.status(409).json({
    error: {
      message: 'This request conflicted with another concurrent operation on the same file. Please retry.',
      type: 'invalid_request_error',
      code: 'concurrent_modification',
    },
  });
  return true;
}

function sendDimensionConflict(res: Response, message: string): void {
  res.status(409).json({ error: { message, type: 'invalid_request_error', code: 'embedding_dimension_mismatch' } });
}

function sendStoreExpired(res: Response, message: string): void {
  res.status(409).json({ error: { message, type: 'invalid_request_error', code: 'vector_store_expired' } });
}

/** Client-input validation failures raised directly by this controller
 *  (request-body shape errors) — distinct from `AttributeValidationError`
 *  (repository-owned, for the attributes/metadata rule specifically) so
 *  `handleKnownError` can map both to 400 without string-matching messages. */
class BadRequestError extends Error {
  readonly status = 400;
  readonly code: string;
  constructor(message: string, code = 'invalid_request') {
    super(message);
    this.name = 'BadRequestError';
    this.code = code;
  }
}

/** Maps the small set of typed, expected errors this controller's own
 *  helpers throw to their HTTP status; anything else falls through to
 *  `next(error)` (-> 500), matching filesController's error handling shape. */
function handleKnownError(err: unknown, res: Response, next: NextFunction): void {
  if (sendIfBusy(res, err)) return;
  if (err instanceof StoreDimensionMismatchError) {
    sendDimensionConflict(res, err.message);
    return;
  }
  if (err instanceof StoreExpiredError) {
    sendStoreExpired(res, err.message);
    return;
  }
  if (err instanceof StoreModelUnavailableError) {
    res.status(err.status).json({ error: { message: err.message, type: 'invalid_request_error', code: err.code } });
    return;
  }
  if (err instanceof AttributeValidationError) {
    sendInvalidRequest(res, err.message, 'invalid_attributes');
    return;
  }
  if (err instanceof RecallInputError) {
    sendInvalidRequest(res, err.message, 'invalid_filter');
    return;
  }
  if (err instanceof SearchQueryTooLongError) {
    sendInvalidRequest(res, err.message, 'query_too_long');
    return;
  }
  if (err instanceof RerankerUnavailableError) {
    sendRerankerUnavailable(res, err.message);
    return;
  }
  if (err instanceof BadRequestError) {
    sendInvalidRequest(res, err.message, err.code);
    return;
  }
  if (err instanceof ChunkingStrategyError) {
    res.status(400).json({ error: { message: err.message, type: 'invalid_request_error', param: err.param, code: err.code } });
    return;
  }
  next(err as Error);
}

/** See filesController.ts's identical helper for the full rationale: this is
 *  the single source of caller identity every query below scopes by. */
function getOwnerEmail(req: AuthenticatedRequest): string | null {
  const email = req.apiKeyInfo?.email ?? req.apiKey?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

// ---------------------------------------------------------------------------
// Request-body validation helpers
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 256;
// OpenAI's per-request caps (spec maxItems): a store create takes at most 500 file_ids, a file
// batch at most 2000 file_ids or files (openai-node vector-stores/file-batches.ts). Both are also
// bounded by limits.maxFilesPerStore below.
const MAX_FILE_IDS_PER_CREATE = 500;
const MAX_FILE_IDS_PER_BATCH = 2000;
// `VALID_FILE_STATUSES`/`FileStatus` also live in `../fileSearch/repository`
// (imported above) — the batch count path needs the same list, and the keys of
// `FileCounts` are defined by it.

const NUL_BYTE = String.fromCharCode(0);

function parseOptionalName(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw new BadRequestError('name must be a string');
  if (input.length > MAX_NAME_LENGTH) throw new BadRequestError(`name must be at most ${MAX_NAME_LENGTH} characters`);
  // vector_stores.name is a plain text column and this value is bound
  // straight into the INSERT/UPDATE (createStore/modifyVectorStore below).
  // Postgres's text encoding cannot represent a raw NUL byte and would
  // otherwise 500 with a raw driver message -- same class of bug, and the
  // same fix, as fileSearch/recallInput.ts's queryText guard and filterCompiler.ts's
  // filter-key/value guards.
  //
  // metadata/attributes need the identical check and now get it, in
  // `validateAttributes`. Being JSON.stringify'd first does NOT exempt them:
  // this comment used to say it did, on the grounds that stringify escapes an
  // embedded NUL to a six-character sequence. It does -- and Postgres's
  // `jsonb` then rejects that escape SPECIFICALLY, with `[22P05] unsupported
  // Unicode escape sequence`, because jsonb stores decoded text. Confirmed
  // live; see validateAttributes' header. NUL_BYTE is built via
  // fromCharCode, not a literal escape, so no raw NUL byte lives in this
  // source file (same reasoning as filterCompiler.ts's own NUL_BYTE constant).
  if (input.includes(NUL_BYTE)) throw new BadRequestError('name must not contain a NUL byte', 'invalid_name');
  return input;
}

function parseExpiresAfter(input: unknown): { anchor: 'last_active_at'; days: number } | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestError('expires_after must be an object');
  }
  const obj = input as Record<string, unknown>;
  if (obj.anchor !== 'last_active_at') {
    throw new BadRequestError('expires_after.anchor must be "last_active_at"');
  }
  const { days } = obj;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
    throw new BadRequestError('expires_after.days must be an integer between 1 and 365');
  }
  return { anchor: 'last_active_at', days };
}

function parseFileIds(input: unknown, maxAllowed: number): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((v) => typeof v !== 'string' || v.length === 0)) {
    throw new BadRequestError('file_ids must be an array of non-empty strings');
  }
  if (input.length > maxAllowed) {
    throw new BadRequestError(`file_ids must contain at most ${maxAllowed} entries for this store`);
  }
  // Deduped rather than rejected: a repeated id in the array is client
  // sloppiness, not a meaningful distinct request, and attaching it twice
  // would otherwise hit the (store_id, file_id) unique constraint and
  // surface as an unrelated-looking 500 for what is really a 400-shaped
  // problem.
  return Array.from(new Set(input as string[]));
}

/** OpenAI's `chunking_strategy` (store create, attach, file batch): `auto`, `static` in OpenAI's
 *  ranges, or absent. Anything else is a 400 here (ChunkingStrategyError), never stored. */
function parseChunkingStrategy(input: unknown): Record<string, unknown> | null {
  return parseFileChunkingStrategy(input);
}

/**
 * The file batch's `files: [{ file_id, attributes?, chunking_strategy? }]` (OpenAI's alternative to
 * `file_ids`, for per-file values). Each entry's attributes and chunking strategy get exactly the
 * single-file attach's validation and error codes; the message (attributes) or `param` (chunking)
 * is prefixed with the entry, `files[i]`. A file listed twice is a 400 rather than deduped as in
 * `file_ids`: its two sets of values would be ambiguous. The same per-request cap as `file_ids`.
 */
function parseBatchFiles(input: unknown, maxAllowed: number): BatchFile[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequestError('files must be a non-empty array of objects with a file_id', 'invalid_files');
  }
  if (input.length > maxAllowed) {
    throw new BadRequestError(`files must contain at most ${maxAllowed} entries for this store`, 'invalid_files');
  }
  const seen = new Set<string>();
  return input.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestError(`files[${i}] must be an object with a file_id`, 'invalid_files');
    }
    const { file_id: fileId, attributes, chunking_strategy: chunking } = entry as Record<string, unknown>;
    if (typeof fileId !== 'string' || fileId.length === 0) {
      throw new BadRequestError(`files[${i}].file_id is required and must be a non-empty string`, 'invalid_files');
    }
    if (seen.has(fileId)) {
      throw new BadRequestError(`files lists ${fileId} more than once`, 'invalid_files');
    }
    seen.add(fileId);
    let validAttributes: Record<string, unknown> | null;
    let chunkingStrategy: Record<string, unknown> | null;
    try {
      validAttributes = validateAttributes(attributes);
    } catch (error) {
      if (error instanceof AttributeValidationError) throw new AttributeValidationError(`files[${i}]: ${error.message}`);
      throw error;
    }
    try {
      chunkingStrategy = parseChunkingStrategy(chunking);
    } catch (error) {
      if (error instanceof ChunkingStrategyError) throw new ChunkingStrategyError(error.message, `files[${i}].${error.param}`, error.code);
      throw error;
    }
    return { fileId, attributes: validAttributes, chunkingStrategy };
  });
}

function parseFilterStatus(input: unknown): FileStatus | null {
  if (input === undefined || input === null) return null;
  const value = Array.isArray(input) ? input[0] : input;
  if (typeof value !== 'string' || !(VALID_FILE_STATUSES as readonly string[]).includes(value)) {
    throw new BadRequestError(`filter must be one of: ${VALID_FILE_STATUSES.join(', ')}`, 'invalid_filter');
  }
  return value as FileStatus;
}

interface ParsedSearchBody {
  query: string | string[];
  maxNumResults?: number;
  filters?: unknown;
  rankingOptions?: { scoreThreshold?: number; hybridWeights?: HybridWeights; rerank?: false };
  rewriteQuery?: boolean;
}

/** The most queries one search takes as an array (OpenAI documents no bound); each one is a recall
 *  of its own, and together they share the single query's length bound (search.ts). */
const MAX_SEARCH_QUERIES = 10;

function parseSearchQuery(input: unknown): string | string[] {
  if (typeof input === 'string' && input.length > 0) return input;
  if (Array.isArray(input) && input.length > 0 && input.length <= MAX_SEARCH_QUERIES
    && input.every((q) => typeof q === 'string' && q.length > 0)) {
    return input as string[];
  }
  throw new BadRequestError(
    `query is required and must be a non-empty string or an array of 1 to ${MAX_SEARCH_QUERIES} non-empty strings`,
    'invalid_query',
  );
}

function parseSearchBody(body: Record<string, unknown>): ParsedSearchBody {
  const query = parseSearchQuery(body.query);

  let maxNumResults: number | undefined;
  // null counts as absent, as on the Responses file_search tool.
  if (body.max_num_results !== undefined && body.max_num_results !== null) {
    if (typeof body.max_num_results !== 'number' || !Number.isFinite(body.max_num_results)) {
      throw new BadRequestError('max_num_results must be a number', 'invalid_max_num_results');
    }
    // OpenAI's range, refused outside it rather than clamped — as the Responses file_search tool
    // refuses it (plugins/fileSearch/descriptor.ts prepare): one behaviour on both search paths.
    if (!Number.isInteger(body.max_num_results)
      || body.max_num_results < MIN_MAX_NUM_RESULTS || body.max_num_results > MAX_MAX_NUM_RESULTS) {
      throw new BadRequestError(
        `max_num_results must be an integer between ${MIN_MAX_NUM_RESULTS} and ${MAX_MAX_NUM_RESULTS}`,
        'invalid_max_num_results',
      );
    }
    maxNumResults = body.max_num_results;
  }

  // `ranking_options.ranker` (SEARCH_RANKERS): `none` skips the rerank (no call, no rerank cost),
  // the others rerank as an absent (or null) ranker does; any other value is a 400 rather than
  // silently ignored.
  let rankingOptions: { scoreThreshold?: number; hybridWeights?: HybridWeights; rerank?: false } | undefined;
  if (body.ranking_options !== undefined) {
    const raw = body.ranking_options;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new BadRequestError('ranking_options must be an object', 'invalid_ranking_options');
    }
    const rawObj = raw as Record<string, unknown>;
    if (rawObj.score_threshold !== undefined
      && (typeof rawObj.score_threshold !== 'number' || !Number.isFinite(rawObj.score_threshold))) {
      throw new BadRequestError('ranking_options.score_threshold must be a number', 'invalid_score_threshold');
    }
    if (rawObj.ranker !== undefined && rawObj.ranker !== null
      && (typeof rawObj.ranker !== 'string' || !SEARCH_RANKERS.includes(rawObj.ranker))) {
      throw new BadRequestError(`ranking_options.ranker must be one of: ${SEARCH_RANKERS.join(', ')}`, 'invalid_ranker');
    }
    const hybrid = parseHybridSearch(rawObj.hybrid_search);
    if (!hybrid.ok) {
      throw new BadRequestError(hybrid.message, 'invalid_hybrid_search');
    }
    rankingOptions = {
      scoreThreshold: typeof rawObj.score_threshold === 'number' ? rawObj.score_threshold : undefined,
      ...(hybrid.weights ? { hybridWeights: hybrid.weights } : {}),
      ...(rawObj.ranker === 'none' ? { rerank: false as const } : {}),
    };
  }

  let rewriteQuery: boolean | undefined;
  if (body.rewrite_query !== undefined) {
    if (typeof body.rewrite_query !== 'boolean') {
      throw new BadRequestError('rewrite_query must be a boolean', 'invalid_rewrite_query');
    }
    rewriteQuery = body.rewrite_query;
  }

  return { query, maxNumResults, filters: body.filters, rankingOptions, rewriteQuery };
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

function toUnixSeconds(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(ms / 1000);
}

// `FileCounts` now lives in `../fileSearch/repository` (imported above): the
// batch path (`fileSearch/batches.ts`) emits the identical shape, and one
// definition in the data layer beats two structurally identical ones that
// agree today.

export interface StoreUsage {
  counts: FileCounts;
  usageBytes: number;
}

export function emptyUsage(): StoreUsage {
  return { counts: { in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 }, usageBytes: 0 };
}

/**
 * The first id in `fileIds` that is not an `fs_files` row owned by
 * `ownerEmail`, or `null` when every one of them is.
 *
 * ONE QUERY FOR THE WHOLE LIST, and — the security-relevant part — one answer
 * for two different causes. A file that does not exist and a file that exists
 * but belongs to another owner both fail the same `id = ANY(...) AND
 * owner_email = ...` predicate and are both reported by the single caller-side
 * message `No such file: {id}`. Splitting them (404 vs 403, or two messages)
 * would let a caller enumerate which `file-` ids exist by diffing responses —
 * the same oracle `assertStoresAccessible` and `sendStoreNotFound` exist to
 * close for stores.
 *
 * Shared by store creation and batch creation so those two cannot drift apart:
 * both attach a LIST of files and must vet the entire list before creating
 * anything, since a partially created store (or a batch rolled back halfway —
 * see `createBatch`'s partial-failure note) is a far worse state for a caller
 * to discover than a clean up-front rejection.
 */
async function findUnownedFileId(pool: Pool, fileIds: string[], ownerEmail: string): Promise<string | null> {
  if (fileIds.length === 0) return null;
  const owned = await pool.query<{ id: string }>(
    // An expired file (not yet swept) is gone: not found, like a missing one.
    `SELECT id FROM fs_files WHERE id = ANY($1) AND owner_email = $2 AND ${notExpiredSql()}`, [fileIds, ownerEmail],
  );
  if (owned.rows.length === fileIds.length) return null;
  const ownedIds = new Set(owned.rows.map((r) => r.id));
  return fileIds.find((id) => !ownedIds.has(id)) ?? null;
}

/** One grouped query for however many store ids are on the current page —
 *  not one query per store — so listing N stores costs a constant two
 *  round trips, not N+1. */
export async function computeUsageForStores(pool: Pool, storeIds: string[]): Promise<Map<string, StoreUsage>> {
  const result = new Map<string, StoreUsage>();
  if (storeIds.length === 0) return result;
  const { rows } = await pool.query<{ store_id: string; status: string; count: string; bytes: string }>(
    `SELECT store_id, status, COUNT(*)::int AS count, COALESCE(SUM(usage_bytes), 0)::bigint AS bytes
     FROM vector_store_files WHERE store_id = ANY($1) GROUP BY store_id, status`,
    [storeIds],
  );
  for (const row of rows) {
    const usage = result.get(row.store_id) ?? emptyUsage();
    const n = Number(row.count);
    if ((VALID_FILE_STATUSES as readonly string[]).includes(row.status)) {
      (usage.counts as any)[row.status] = n;
    }
    usage.counts.total += n;
    usage.usageBytes += Number(row.bytes);
    result.set(row.store_id, usage);
  }
  return result;
}

/**
 * A store's status is DERIVED from its file counts, not read off the row.
 *
 * `vector_stores.status` is stamped once at creation and no writer ever moves
 * it off `'in_progress'` — the ingestion worker updates the FILE rows. So a
 * store whose files had all completed still reported `in_progress` forever, and
 * a client polling `status` (OpenAI's documented way to wait for ingestion, and
 * what our own parity capture script does) never stopped polling. Observed
 * live on 2026-08-07: `file_counts` reached 1/1 while `status` stayed
 * `in_progress` for 30 consecutive polls.
 *
 * Same derivation the batch object already used (`batches.deriveBatchStatus`),
 * and for the same reason: counts are the truth, the column is a cache nobody
 * invalidates. Failures do not hold a store open — a file that failed is
 * finished, and the damage is visible in `file_counts.failed`.
 *
 * `'expired'` is the exception and is read from the row: it is terminal, set by
 * the sweeper, and not derivable from counts (see repository.StoreExpiredError).
 */
function deriveStoreStatus(row: VectorStoreRow, counts: FileCounts): string {
  if (row.status === 'expired') return 'expired';
  return counts.in_progress > 0 ? 'in_progress' : 'completed';
}

export function toStoreObject(row: VectorStoreRow, usage: StoreUsage): Record<string, unknown> {
  return {
    id: row.id,
    object: 'vector_store',
    created_at: toUnixSeconds(row.created_at),
    name: row.name,
    usage_bytes: usage.usageBytes,
    file_counts: usage.counts,
    status: deriveStoreStatus(row, usage.counts),
    expires_after: row.expires_after ?? null,
    expires_at: toUnixSeconds(row.expires_at),
    last_active_at: toUnixSeconds(row.last_active_at),
    metadata: row.metadata ?? {},
  };
}

/**
 * `storeChunking` is the store's `vector_stores.chunking` (NULL = static 800/400). The file's
 * `chunking_strategy` is its EFFECTIVE strategy (chunkingSetting.ts `resolveChunking`): the
 * resolved static parameters, as OpenAI reports them, or `{type: 'other'}` for `structure`.
 * A store setting that does not validate (only a hand-edited row can) is logged and reported
 * as `other` — OpenAI's slot for a strategy it cannot describe, never a request-only type.
 */
function fileChunkingStrategy(row: VectorStoreFileRow, storeChunking: unknown): Record<string, unknown> {
  try {
    return fileChunkingStrategyObject(resolveChunking({ file: row.chunking_strategy, store: storeChunking ?? null }));
  } catch (error) {
    if (!(error instanceof ChunkingStrategyError)) throw error;
    logger.warn('VectorStoresController', `Vector store ${row.store_id} has an invalid chunking setting: ${error.message}`);
    return { type: 'other' };
  }
}

/**
 * `contextStop`: a cockpit (grounding) call — the object also carries `context_stopped`, the file's
 * context stop (fileSearch/contextStop.ts; null when none), which OpenAI's object has no slot for.
 */
function toStoreFileObject(row: VectorStoreFileRow, storeChunking: unknown, contextStop = false): Record<string, unknown> {
  return {
    id: row.file_id,
    object: 'vector_store.file',
    usage_bytes: row.usage_bytes ?? 0,
    created_at: toUnixSeconds(row.created_at),
    vector_store_id: row.store_id,
    status: row.status,
    last_error: row.last_error ?? null,
    chunking_strategy: fileChunkingStrategy(row, storeChunking),
    attributes: row.attributes ?? {},
    ...(contextStop ? { context_stopped: row.context_stopped ?? null } : {}),
  };
}

/**
 * THE ONE PLACE a page of `vector_store.file` objects is turned into OpenAI's
 * list envelope — used by BOTH `GET /vector_stores/{id}/files` and
 * `GET /vector_stores/{id}/file_batches/{batch_id}/files`.
 *
 * It exists as a shared function rather than as two similar blocks because
 * `has_more`, `first_id`/`last_id`, and the `before` reversal are a CONTRACT,
 * not an implementation detail: a client pages until `has_more` is false and
 * feeds `last_id` back as `after`. Two copies that agree today would drift the
 * first time one of them is fixed, and the drift is invisible to any test that
 * only ever exercises one endpoint — the reader of the other would silently
 * loop forever or skip a page. One definition means a change to the cursor
 * contract is a change to one function.
 *
 * `rows` is the up-to-`limit + 1` rows the caller fetched, IN FETCH ORDER —
 * `buildPage` trims the extra row, which is what makes `has_more` correct
 * without a second COUNT (see pagination.ts).
 *
 * `usingBefore` says the rows were fetched in the reverse of display order (a
 * backwards page: the `limit + 1` rows nearest the cursor, taken away from it).
 * They are reversed back here, and `first_id`/`last_id` swapped with them, so a
 * backwards page reads in the same direction as a forwards one. Emitting them
 * unreversed would produce a page whose `last_id`, fed back as `after`,
 * re-fetches the page just returned.
 *
 * `id` is projected from `file_id` only to satisfy `buildPage`'s `{id: string}`
 * constraint; the emitted object's own `id` comes from `toStoreFileObject`.
 */
function sendStoreFilePage(
  res: Response, rows: VectorStoreFileRow[], limit: number, usingBefore: boolean, storeChunking: unknown, contextStop: boolean,
): void {
  const page = buildPage(rows.map((row) => ({ ...row, id: row.file_id })), limit);
  if (usingBefore) {
    page.data.reverse();
    [page.first_id, page.last_id] = [page.last_id, page.first_id];
  }
  res.status(200).json({
    object: 'list',
    data: page.data.map((row) => toStoreFileObject(row, storeChunking, contextStop)),
    has_more: page.has_more,
    first_id: page.first_id,
    last_id: page.last_id,
  });
}

/**
 * OpenAI's `vector_store.file_batch` object.
 *
 * `created_at` goes through the SAME `toUnixSeconds` every other timestamp on
 * this controller uses (see `toStoreObject`/`toStoreFileObject`). That is the
 * whole point of routing it through the shared helper rather than emitting
 * `row.created_at` — a `Date` serialises to an ISO string and `getTime()` to
 * milliseconds, and BOTH are accepted without complaint by a hand-written
 * curl check while breaking every SDK client, which parses this field as Unix
 * seconds. Pinned by an assertion a milliseconds value fails.
 *
 * `status` and `file_counts` are NOT properties of the batch row: they are
 * derived from the member files on every read (`batchStatusAndCounts`), which
 * is why they arrive as a second argument rather than being read off `row`.
 */
function toBatchObject(
  row: BatchRow,
  derived: { status: BatchStatus; file_counts: FileCounts },
): Record<string, unknown> {
  return {
    id: row.id,
    object: 'vector_store.file_batch',
    created_at: toUnixSeconds(row.created_at),
    vector_store_id: row.store_id,
    status: derived.status,
    file_counts: derived.file_counts,
  };
}

// ---------------------------------------------------------------------------
// Store handlers
// ---------------------------------------------------------------------------

/** `res.locals` key under which the grounding create hands the body's `chunking` to createVectorStore. */
export const GROUNDING_STORE_CHUNKING = 'groundingStoreChunking';

export const createVectorStore = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = parseOptionalName(body.name);
    const metadata = validateAttributes(body.metadata);
    const expiresAfter = parseExpiresAfter(body.expires_after);
    const maxFilesPerStore = getFileSearchConfig().limits.maxFilesPerStore;
    const fileIds = parseFileIds(body.file_ids, Math.min(MAX_FILE_IDS_PER_CREATE, maxFilesPerStore));
    const chunkingStrategy = parseChunkingStrategy(body.chunking_strategy);
    // The store's own chunking setting: only the grounding create passes one (GROUNDING_STORE_CHUNKING,
    // from its `chunking` field); the OpenAI routes never do, and a store then gets the installation default.
    const rawChunking = res.locals?.[GROUNDING_STORE_CHUNKING];
    const chunking = rawChunking === undefined || rawChunking === null ? undefined : validateChunkingSetting(rawChunking);
    // A vision mode where vision is switched off (FILE_SEARCH_VISION=off; the npm standalone CLI)
    // would never run: refused rather than stored.
    if (chunking && visionModeOf(chunking) !== 'off' && visionSwitchedOff()) {
      throw new ChunkingStrategyError(
        "Invalid 'chunking.vision': vision transcription is switched off on this gateway.", 'chunking.vision', 'invalid_value',
      );
    }

    const pool = getPool()!;
    if (fileIds.length > 0) {
      // Validate every file_id belongs to this caller BEFORE creating
      // anything — a partially created store (some files attached, others
      // silently skipped because they were invalid) would be a confusing,
      // hard-to-diagnose state for a caller to discover after the fact.
      // Same non-distinguishing guarantee as sendStoreFileNotFound: this
      // covers both "no such file" and "that file belongs to someone else"
      // with one message template. See findUnownedFileId, shared with the
      // file-batch create path.
      const missing = await findUnownedFileId(pool, fileIds, ownerEmail);
      if (missing !== null) {
        sendInvalidRequest(res, `No such file: ${missing}`, 'file_not_found');
        return;
      }
    }

    const store = await createStore({
      ownerEmail,
      name,
      metadata,
      expiresAfter,
      initialStatus: fileIds.length > 0 ? 'in_progress' : 'completed',
      ...(chunking ? { chunking } : {}),
    });

    if (fileIds.length > 0) {
      // A store this function just created is always pinned to the CURRENT
      // configuration (see repository.createStore), so this can never
      // actually throw here — it's called anyway so store creation and the
      // dedicated attach endpoint share one code path rather than one of
      // them silently skipping the check.
      await assertStoreDimension(store);
    }
    // Page images are never masked: say so where pseudonymization applies to file_search content.
    warnVisionUnmasked(visionModeOf(store.chunking), { storeId: store.id });
    for (const fileId of fileIds) {
      // eslint-disable-next-line no-await-in-loop
      await attachFile(store.id, fileId, {}, chunkingStrategy, null, attachStamp(req, ownerEmail, store.owner_email));
      // eslint-disable-next-line no-await-in-loop
      await enqueueIngestion(store.id, fileId);
    }

    const usage = fileIds.length > 0
      ? (await computeUsageForStores(pool, [store.id])).get(store.id) ?? emptyUsage()
      : emptyUsage();
    res.status(200).json(toStoreObject(store, usage));
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

export const listVectorStores = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const { limit, order, after, before } = parsePageParams(req.query as Record<string, unknown>);
    const pool = getPool()!;
    const cursorId = after ?? before;

    // created_at is read back as TEXT and rebound with an explicit ::timestamptz
    // below. A JS Date holds milliseconds; Postgres timestamptz holds
    // microseconds, so binding the Date sends a cursor slightly EARLIER than the
    // row it names and `(created_at, id) > cursor` matches that row itself —
    // every page repeats its own first row. See the same note in
    // fileSearch/batches.ts, which resolves its cursor the identical way.
    let cursorRow: { created_at: string; id: string } | null = null;
    if (cursorId) {
      const cursorResult = await pool.query(
        'SELECT created_at::text AS created_at, id FROM vector_stores WHERE id = $1 AND owner_email = $2', [cursorId, ownerEmail],
      );
      cursorRow = cursorResult.rows[0] ?? null;
      if (!cursorRow) {
        res.status(200).json({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
        return;
      }
    }

    const displaySortDir = order === 'asc' ? 'ASC' : 'DESC';
    const usingBefore = !!cursorRow && !after;
    const fetchSortDir = usingBefore ? (displaySortDir === 'ASC' ? 'DESC' : 'ASC') : displaySortDir;

    const params: unknown[] = [ownerEmail];
    let where = 'owner_email = $1';
    if (cursorRow) {
      params.push(cursorRow.created_at, cursorRow.id);
      const cmp = after ? (order === 'asc' ? '>' : '<') : (order === 'asc' ? '<' : '>');
      where += ` AND (created_at, id) ${cmp} ($2::timestamptz, $3)`;
    }
    params.push(limit + 1);

    const { rows } = await pool.query<VectorStoreRow>(
      `SELECT * FROM vector_stores WHERE ${where} ORDER BY created_at ${fetchSortDir}, id ${fetchSortDir} LIMIT $${params.length}`,
      params,
    );

    const page = buildPage(rows, limit);
    if (usingBefore) {
      page.data.reverse();
      [page.first_id, page.last_id] = [page.last_id, page.first_id];
    }
    const usageByStore = await computeUsageForStores(pool, page.data.map((r) => r.id));
    res.status(200).json({
      object: 'list',
      data: page.data.map((row) => toStoreObject(row, usageByStore.get(row.id) ?? emptyUsage())),
      has_more: page.has_more,
      first_id: page.first_id,
      last_id: page.last_id,
    });
  } catch (error) {
    if (sendIfBusy(res, error)) return;
    next(error);
  }
};

export const retrieveVectorStore = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const pool = getPool()!;
    const { rows } = await pool.query<VectorStoreRow>(
      'SELECT * FROM vector_stores WHERE id = $1 AND owner_email = $2', [req.params.id, ownerEmail],
    );
    if (rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }
    const usage = (await computeUsageForStores(pool, [rows[0].id])).get(rows[0].id) ?? emptyUsage();
    res.status(200).json(toStoreObject(rows[0], usage));
  } catch (error) {
    if (sendIfBusy(res, error)) return;
    next(error);
  }
};

export const modifyVectorStore = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];

    if ('name' in body) {
      const name = parseOptionalName(body.name);
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if ('metadata' in body) {
      const metadata = validateAttributes(body.metadata);
      params.push(JSON.stringify(metadata));
      sets.push(`metadata = $${params.length}`);
    }
    if ('expires_after' in body) {
      const expiresAfter = parseExpiresAfter(body.expires_after);
      params.push(expiresAfter ? JSON.stringify(expiresAfter) : null);
      sets.push(`expires_after = $${params.length}`);
      // Anchored to the store's OWN last_active_at (read server-side, in the
      // same UPDATE) rather than Date.now() computed here. The previous
      // version pinned expires_at to the moment this policy was set — a
      // fixed deadline from whenever modify happened to run, not a sliding
      // one — which is what let expires_after:{anchor:'last_active_at'}
      // silently behave as a fixed deadline from creation (attach/detach
      // never recomputed it either; see fileSearch/stores.ts's
      // RECOMPUTE_EXPIRES_AT_SQL and storeAccess.ts's touchStoreActivity for the other sites
      // that keep it sliding as last_active_at itself changes).
      if (expiresAfter) {
        params.push(expiresAfter.days);
        sets.push(`expires_at = last_active_at + ($${params.length} * interval '1 day')`);
      } else {
        sets.push('expires_at = NULL');
      }
    }

    const pool = getPool()!;
    if (sets.length === 0) {
      const { rows } = await pool.query<VectorStoreRow>(
        'SELECT * FROM vector_stores WHERE id = $1 AND owner_email = $2', [req.params.id, ownerEmail],
      );
      if (rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }
      const usage = (await computeUsageForStores(pool, [rows[0].id])).get(rows[0].id) ?? emptyUsage();
      res.status(200).json(toStoreObject(rows[0], usage));
      return;
    }

    params.push(req.params.id, ownerEmail);
    const { rows } = await pool.query<VectorStoreRow>(
      `UPDATE vector_stores SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND owner_email = $${params.length}
       RETURNING *`,
      params,
    );
    if (rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }
    const usage = (await computeUsageForStores(pool, [rows[0].id])).get(rows[0].id) ?? emptyUsage();
    res.status(200).json(toStoreObject(rows[0], usage));
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

export const deleteVectorStore = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const { deleted } = await deleteStoreCascade(req.params.id, ownerEmail);
    if (!deleted) { sendStoreNotFound(res, req.params.id); return; }
    res.status(200).json({ id: req.params.id, object: 'vector_store.deleted', deleted: true });
  } catch (error: any) {
    if (handleDeadlock(error, res)) return;
    if (sendIfBusy(res, error)) return;
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Store-file handlers
// ---------------------------------------------------------------------------

export const createVectorStoreFile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fileId = body.file_id;
    if (typeof fileId !== 'string' || fileId.length === 0) {
      sendInvalidRequest(res, 'file_id is required and must be a string', 'invalid_file_id');
      return;
    }
    const attributes = validateAttributes(body.attributes);
    const chunkingStrategy = parseChunkingStrategy(body.chunking_strategy);

    const pool = getPool()!;
    const storeRows = await pool.query<VectorStoreRow>(
      'SELECT * FROM vector_stores WHERE id = $1 AND owner_email = $2', [req.params.id, ownerEmail],
    );
    if (storeRows.rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }
    const store = storeRows.rows[0];

    // An expired store is terminal for use (see fileSearch/storeValidation.ts's
    // StoreExpiredError/assertStoreNotExpired doc comments) — checked before
    // assertStoreDimension since it's the more fundamental of the two.
    assertStoreNotExpired(store);
    await assertStoreDimension(store);

    const fileRows = await pool.query<{ id: string }>(
      `SELECT id FROM fs_files WHERE id = $1 AND owner_email = $2 AND ${notExpiredSql()}`, [fileId, ownerEmail],
    );
    if (fileRows.rows.length === 0) {
      sendInvalidRequest(res, `No such file: ${fileId}`, 'file_not_found');
      return;
    }

    const countRows = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::int AS count FROM vector_store_files WHERE store_id = $1', [store.id],
    );
    const maxFilesPerStore = getFileSearchConfig().limits.maxFilesPerStore;
    if (Number(countRows.rows[0].count) >= maxFilesPerStore) {
      sendInvalidRequest(
        res, `This vector store already has the maximum of ${maxFilesPerStore} files attached`, 'vector_store_file_limit_exceeded',
      );
      return;
    }

    let vsf: VectorStoreFileRow;
    try {
      vsf = await attachFile(store.id, fileId, attributes, chunkingStrategy, null, attachStamp(req, ownerEmail, store.owner_email));
    } catch (attachError: any) {
      if (attachError?.code === '23505') { // unique_violation on (store_id, file_id)
        res.status(409).json({
          error: {
            message: `File ${fileId} is already attached to this vector store`,
            type: 'invalid_request_error',
            code: 'file_already_attached',
          },
        });
        return;
      }
      if (attachError?.code === '23503') {
        // foreign_key_violation: the store/file existence checks above ran
        // to completion, but a concurrent DELETE committed before this
        // INSERT did -- mirrors filesController.deleteFile's own reverse-race
        // handling. `.constraint` tells us which of vector_store_files' two
        // FKs fired, so the two racing deletes get mapped to the SAME status
        // a direct lookup of the vanished resource would have returned,
        // rather than both collapsing into an unrelated 500 that would also
        // leak the table/constraint name verbatim via errorHandler.
        logger.debug('VectorStoresController', 'Attach lost a race to a concurrent delete', {
          constraint: attachError?.constraint,
        });
        if (attachError.constraint === 'vector_store_files_file_id_fkey') {
          sendInvalidRequest(res, `No such file: ${fileId}`, 'file_not_found');
          return;
        }
        sendStoreNotFound(res, req.params.id);
        return;
      }
      throw attachError;
    }
    await enqueueIngestion(store.id, fileId);

    res.status(200).json(toStoreFileObject(vsf, store.chunking));
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

/**
 * `GET /vector_stores/{id}/files`.
 *
 * The query is `listBatchFiles` WITH A NULL BATCH ID — the same builder the
 * batch-scoped list uses, called with the batch narrowing switched off. This
 * endpoint and `listVectorStoreFileBatchFiles` therefore share BOTH halves of
 * the page: the keyset query (`listBatchFiles`) and the envelope
 * (`sendStoreFilePage`). Neither `after`/`before` precedence, nor the cursor's
 * comparison direction, nor `has_more` can mean one thing here and another
 * there, because there is only one of each. They used to be two near-identical
 * blocks, and the drift a client would have seen — a cursor that skips a page
 * on one endpoint but not the other — is invisible to any test that exercises
 * only one of them.
 *
 * `listBatchFiles` with a null batch id emits BYTE-IDENTICAL SQL to the block
 * this replaced, deliberately: the store-level list is the hot one, and
 * `idx_vsf_batch` is `(store_id, batch_id)`, so a `batch_id` predicate added
 * "harmlessly" for the null case is a predicate on the index this scan uses.
 * See `storeFileScope` in `batches.ts`.
 *
 * The store-existence check stays HERE rather than moving into the query: it
 * is owner-scoped, and its 404 must be indistinguishable from the 404 for a
 * store that does not exist. An empty file list is the right answer for a real
 * empty store, so folding the two together would render someone else's store
 * as an empty one of your own.
 */
export const listVectorStoreFiles = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const { limit, order, after, before } = parsePageParams(req.query as Record<string, unknown>);
    const filterStatus = parseFilterStatus((req.query as Record<string, unknown>).filter);
    const pool = getPool()!;

    const storeRows = await pool.query<{ id: string; chunking: unknown }>(
      'SELECT id, chunking FROM vector_stores WHERE id = $1 AND owner_email = $2', [req.params.id, ownerEmail],
    );
    if (storeRows.rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }

    // `null` = every file in the store, batched or not. An unknown cursor
    // comes back as `[]` from the builder and renders through the same
    // `sendStoreFilePage` as any other page, so "empty" has exactly one shape.
    const rows = await listBatchFiles(req.params.id, null, {
      limit, order, after, before, filter: filterStatus,
    });

    // A backwards page (`before` with no `after`) came back in reverse display
    // order; `sendStoreFilePage` flips it. `listBatchFiles` derives the same
    // condition from the same inputs — see its `usingBefore`. Identical to the
    // batch-scoped handler's call, which is the point.
    sendStoreFilePage(res, rows, limit, !!before && !after, storeRows.rows[0].chunking, !!(req as any).groundingActor);
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

export const retrieveVectorStoreFile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const pool = getPool()!;
    const { rows } = await pool.query<VectorStoreFileRow & { store_chunking: unknown }>(
      `SELECT vsf.*, vs.chunking AS store_chunking FROM vector_store_files vsf
       JOIN vector_stores vs ON vs.id = vsf.store_id
       WHERE vsf.store_id = $1 AND vsf.file_id = $2 AND vs.owner_email = $3
         AND ${attachedFileNotExpiredSql('vsf.file_id')}`,
      [req.params.id, req.params.file_id, ownerEmail],
    );
    if (rows.length === 0) { sendStoreFileNotFound(res, req.params.file_id); return; }
    const { store_chunking: storeChunking, ...row } = rows[0];
    res.status(200).json(toStoreFileObject(row, storeChunking));
  } catch (error) {
    if (sendIfBusy(res, error)) return;
    next(error);
  }
};

export const modifyVectorStoreFile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('attributes' in body)) {
      throw new BadRequestError('attributes is required', 'missing_attributes');
    }
    const attributes = validateAttributes(body.attributes);

    const pool = getPool()!;
    const { rows } = await pool.query<VectorStoreFileRow & { store_chunking: unknown }>(
      `UPDATE vector_store_files vsf SET attributes = $1
       FROM vector_stores vs
       WHERE vs.id = vsf.store_id AND vsf.store_id = $2 AND vsf.file_id = $3 AND vs.owner_email = $4
       RETURNING vsf.*, vs.chunking AS store_chunking`,
      [JSON.stringify(attributes), req.params.id, req.params.file_id, ownerEmail],
    );
    if (rows.length === 0) { sendStoreFileNotFound(res, req.params.file_id); return; }
    const { store_chunking: storeChunking, ...row } = rows[0];
    res.status(200).json(toStoreFileObject(row, storeChunking));
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

export const deleteVectorStoreFile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const { deleted } = await deleteStoreFile(req.params.id, req.params.file_id, ownerEmail);
    if (!deleted) { sendStoreFileNotFound(res, req.params.file_id); return; }
    res.status(200).json({ id: req.params.file_id, object: 'vector_store.file.deleted', deleted: true });
  } catch (error: any) {
    if (handleDeadlock(error, res)) return;
    if (sendIfBusy(res, error)) return;
    next(error);
  }
};

export const downloadVectorStoreFileContent = async (
  req: AuthenticatedRequest, res: Response, next: NextFunction,
): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const pool = getPool()!;
    // An expired file's text is gone with it, although its chunks stay until the expiry sweep.
    const attachedRows = await pool.query<{ file_id: string }>(
      `SELECT vsf.file_id FROM vector_store_files vsf
       JOIN vector_stores vs ON vs.id = vsf.store_id
       WHERE vsf.store_id = $1 AND vsf.file_id = $2 AND vs.owner_email = $3
         AND ${attachedFileNotExpiredSql('vsf.file_id')}`,
      [req.params.id, req.params.file_id, ownerEmail],
    );
    if (attachedRows.rows.length === 0) { sendStoreFileNotFound(res, req.params.file_id); return; }

    // Extracted text reassembled from chunks in `ord` order — deliberately
    // NOT the original bytes (that's GET /files/{id}/content). Ownership is
    // re-checked here too (not just above) because this is its own query
    // site — see fileSearch/recall.ts's header note on why every site scopes itself.
    // Only the active generation: during a re-embed the next one holds the
    // same texts again.
    const { rows: chunkRows } = await pool.query<{ text: string }>(
      `SELECT c.text FROM vector_store_chunks c
       JOIN vector_stores vs ON vs.id = c.store_id
       WHERE c.store_id = $1 AND c.file_id = $2 AND vs.owner_email = $3
         AND ${ACTIVE_GENERATION_PREDICATE_SQL}
       ORDER BY c.ord ASC`,
      [req.params.id, req.params.file_id, ownerEmail],
    );

    res.status(200).json({
      object: 'list',
      data: [{ type: 'text', text: chunkRows.map((r) => r.text).join('\n') }],
      has_more: false,
    });
  } catch (error) {
    if (sendIfBusy(res, error)) return;
    next(error);
  }
};

// ---------------------------------------------------------------------------
// File-batch handlers
//
// A batch is a LABEL over `vector_store_files` rows, not a container that owns
// them (see fileSearch/batches.ts). These two handlers are therefore thin: the
// data layer holds the tenant boundary (`store_id` in every predicate) and the
// derivation of `status`/`file_counts`; what lives here is the OWNER boundary
// — `vector_stores.owner_email`, which batches.ts deliberately knows nothing
// about — plus request validation and the OpenAI response shape.
// ---------------------------------------------------------------------------

/**
 * Who started a batch's job, with which credential. On a grounding call the
 * acting cockpit user is `groundingActor` and the credential is the admin
 * service key; an API client's own key id is on `apiKeyInfo`. Null when the
 * auth path recorded no key id. Re-embed jobs are stamped the same way
 * (groundingReembedController, plan Decision 14).
 */
export function batchJobIdentity(req: AuthenticatedRequest, ownerEmail: string): CreateBatchJobOptions {
  const anyReq = req as any;
  return {
    startedBy: anyReq.groundingActor?.email ?? ownerEmail,
    credentialId: anyReq.serviceAuth?.serviceKey?.id ?? req.apiKeyInfo?.keyId ?? null,
    authType: 'api_key',
  };
}

/**
 * Who pays for the ingestion of the files an attach adds: the batch job's
 * credential and, on a grounding call only, the store's owner as the user the
 * admin service key acts for. Ingestion is the owner's usage even when an
 * admin attaches; the job still records the admin as its starter. Stamped on
 * each `vector_store_files` row, where the ingest worker reads it
 * (fileSearch/usage.ts).
 */
export function attachStamp(req: AuthenticatedRequest, ownerEmail: string, storeOwnerEmail: string): AttachStamp {
  const { credentialId, authType } = batchJobIdentity(req, ownerEmail);
  return {
    credentialId,
    authType,
    onBehalfOf: (req as any).groundingActor ? storeOwnerEmail : null,
  };
}

/**
 * `POST /vector_stores/{id}/file_batches`.
 *
 * VALIDATES THE ENTIRE `file_ids` LIST BEFORE `createBatch` RUNS. `createBatch`
 * does have a rollback for a mid-batch attach failure, but that exists because
 * `attachFile` opens its own transaction per file and so the N attachments are
 * not atomic — it is a safety net for genuine races (a file deleted by a
 * concurrent request between validation and insert), not the routine path for
 * bad input. Every check the single-file `createVectorStoreFile` above applies
 * is applied here to the whole list first, with the same error codes:
 *
 *   store exists AND is owned by the caller     -> 404 (never 403)
 *   store not expired / dimension still matches -> 409
 *   every file exists AND is owned              -> 400 file_not_found
 *   none already attached to this store         -> 409 file_already_attached
 *   the batch fits under maxFilesPerStore       -> 400 ..._limit_exceeded
 *
 * The `23505`/`23503` mapping after the call is what remains of the race
 * window, and maps to the SAME responses the pre-checks produce so a caller
 * cannot tell a lost race from an ordinary rejection.
 */
export const createVectorStoreFileBatch = async (
  req: AuthenticatedRequest, res: Response, next: NextFunction,
): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const maxFilesPerStore = getFileSearchConfig().limits.maxFilesPerStore;
    // parseFileIds dedupes and enforces the array-of-non-empty-strings shape
    // and the per-request ceiling; it returns [] for a missing/null field, so
    // the length check below covers "absent", "null" and "[]" identically —
    // all three are the same client mistake, and OpenAI requires file_ids on
    // this endpoint (unlike POST /vector_stores, where it is optional).
    //
    // `files` (per-file values) is OpenAI's alternative to `file_ids`, exclusive with it; with
    // `files` the top-level attributes and chunking_strategy are ignored, as OpenAI documents.
    const perRequestCap = Math.min(MAX_FILE_IDS_PER_BATCH, maxFilesPerStore);
    const filesGiven = body.files !== undefined && body.files !== null;
    if (filesGiven && body.file_ids !== undefined && body.file_ids !== null) {
      throw new BadRequestError('file_ids and files are mutually exclusive; give one of them', 'invalid_files');
    }
    let members: Array<string | BatchFile>;
    let fileIds: string[];
    let attributes: Record<string, unknown> | null = null;
    let chunkingStrategy: Record<string, unknown> | null = null;
    if (filesGiven) {
      const files = parseBatchFiles(body.files, perRequestCap);
      members = files;
      fileIds = files.map((f) => f.fileId);
    } else {
      fileIds = parseFileIds(body.file_ids, perRequestCap);
      if (fileIds.length === 0) {
        throw new BadRequestError('file_ids is required and must contain at least one file id', 'invalid_file_ids');
      }
      members = fileIds;
      attributes = validateAttributes(body.attributes);
      chunkingStrategy = parseChunkingStrategy(body.chunking_strategy);
    }

    const pool = getPool()!;
    const storeRows = await pool.query<VectorStoreRow>(
      'SELECT * FROM vector_stores WHERE id = $1 AND owner_email = $2', [req.params.id, ownerEmail],
    );
    if (storeRows.rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }
    const store = storeRows.rows[0];

    // Same order and same reasoning as createVectorStoreFile: expiry is the
    // more fundamental of the two, so it is checked first.
    assertStoreNotExpired(store);
    await assertStoreDimension(store);

    const missing = await findUnownedFileId(pool, fileIds, ownerEmail);
    if (missing !== null) {
      sendInvalidRequest(res, `No such file: ${missing}`, 'file_not_found');
      return;
    }

    // Already-attached files are rejected up front rather than left to
    // `attachFile`'s unique violation: reaching that violation would abort the
    // batch partway and take the rollback path for what is plainly a 409-shaped
    // client error.
    const attachedRows = await pool.query<{ file_id: string }>(
      'SELECT file_id FROM vector_store_files WHERE store_id = $1 AND file_id = ANY($2)', [store.id, fileIds],
    );
    if (attachedRows.rows.length > 0) {
      res.status(409).json({
        error: {
          message: `File ${attachedRows.rows[0].file_id} is already attached to this vector store`,
          type: 'invalid_request_error',
          code: 'file_already_attached',
        },
      });
      return;
    }

    const countRows = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::int AS count FROM vector_store_files WHERE store_id = $1', [store.id],
    );
    // The single-file path's `>= maxFilesPerStore`, generalised to N: every id
    // in `fileIds` is distinct (parseFileIds dedupes) and none is attached yet
    // (checked immediately above), so the batch adds exactly `fileIds.length`.
    if (Number(countRows.rows[0].count) + fileIds.length > maxFilesPerStore) {
      sendInvalidRequest(
        res,
        `Attaching ${fileIds.length} files would exceed this vector store's maximum of ${maxFilesPerStore} files`,
        'vector_store_file_limit_exceeded',
      );
      return;
    }

    let batch: BatchRow;
    try {
      const jobOptions: CreateBatchJobOptions = {
        ...batchJobIdentity(req, ownerEmail),
        onBehalfOf: attachStamp(req, ownerEmail, store.owner_email).onBehalfOf,
      };
      batch = await createBatch(store.id, members, attributes, chunkingStrategy, jobOptions);
    } catch (batchError: any) {
      // Everything below is a lost race against a concurrent write, not bad
      // input — the pre-checks above already ran to completion. `createBatch`
      // has undone its partial work by the time this catch runs.
      if (batchError?.code === '23505') { // unique_violation on (store_id, file_id)
        // Deliberately does NOT echo the driver's `detail` (which would carry
        // the raw constraint and key values); the id is unavailable here, and
        // the pre-check above is what names it in the non-racing case.
        res.status(409).json({
          error: {
            message: 'One or more files in this batch are already attached to this vector store',
            type: 'invalid_request_error',
            code: 'file_already_attached',
          },
        });
        return;
      }
      if (batchError?.code === '23503') {
        // foreign_key_violation: a concurrent DELETE of the store or of one of
        // the files committed between the checks above and these inserts.
        // `.constraint` says which, so each maps to the status a direct lookup
        // of the vanished resource would have returned rather than both
        // collapsing into a 500 that leaks the constraint name verbatim.
        logger.debug('VectorStoresController', 'Batch create lost a race to a concurrent delete', {
          constraint: batchError?.constraint,
        });
        if (batchError.constraint === 'vector_store_files_file_id_fkey') {
          sendInvalidRequest(res, 'No such file: one or more files in this batch no longer exist', 'file_not_found');
          return;
        }
        sendStoreNotFound(res, req.params.id);
        return;
      }
      throw batchError;
    }

    for (const fileId of fileIds) {
      // eslint-disable-next-line no-await-in-loop
      await enqueueIngestion(store.id, fileId);
    }

    const derived = await batchStatusAndCounts(store.id, batch.id);
    if (!derived) {
      // The batch existed a moment ago; only a concurrent store delete (which
      // cascades to vector_store_batches) can remove it this fast. Reported as
      // the store being gone, which by then it is.
      sendStoreNotFound(res, req.params.id);
      return;
    }
    res.status(200).json(toBatchObject(batch, derived));
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

/**
 * `GET /vector_stores/{id}/file_batches/{batch_id}`.
 *
 * TWO BOUNDARIES, BOTH REQUIRED:
 *  - the store must be owned by the caller (checked here — `getBatch` scopes
 *    by `store_id`, not by owner, so without this check any caller who knew
 *    another tenant's store id could read that store's batches);
 *  - the batch must belong to THAT store (`getBatch`/`batchStatusAndCounts`
 *    scope by `store_id` themselves, so a `vsfb_` id from another store
 *    resolves to null rather than to data).
 * Both failures, and a batch id that simply never existed, produce the one
 * `sendBatchNotFound` response — no 403 anywhere, nothing that distinguishes
 * "not yours" from "not real".
 *
 * THE `null` CHECKS ARE LOAD-BEARING, not defensive padding.
 * `batchStatusAndCounts` returns `null` (rather than a zeroed `completed`)
 * precisely so this layer can tell a missing batch from a genuinely empty one:
 * an empty batch really is `{status:'completed', total:0}`, so rendering a
 * missing batch that way would answer 200 for a batch that does not exist.
 *
 * Both reads are issued together: they are independent, `store_id`-scoped
 * lookups of the same row, so serialising them would only add a round trip.
 */
export const retrieveVectorStoreFileBatch = async (
  req: AuthenticatedRequest, res: Response, next: NextFunction,
): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const pool = getPool()!;
    const storeRows = await pool.query<{ id: string }>(
      'SELECT id FROM vector_stores WHERE id = $1 AND owner_email = $2', [req.params.id, ownerEmail],
    );
    if (storeRows.rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }

    const [batch, derived] = await Promise.all([
      getBatch(req.params.id, req.params.batch_id),
      batchStatusAndCounts(req.params.id, req.params.batch_id),
    ]);
    if (!batch || !derived) { sendBatchNotFound(res, req.params.batch_id); return; }

    res.status(200).json(toBatchObject(batch, derived));
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

/**
 * `POST /vector_stores/{id}/file_batches/{batch_id}/cancel`.
 *
 * THIS ENDPOINT DOES NOT PROMISE `status: 'cancelled'`, AND MUST NOT BE
 * "FIXED" TO. It records a request; the ingestion worker is what makes the
 * batch terminal, at its next between-files check (see `requestBatchCancel`
 * and `deriveBatchStatus` in batches.ts, and the worker's own check). So the
 * object returned here legitimately reads `in_progress` whenever a member file
 * was still being ingested at the moment of the call — and `cancelled` only
 * once nothing is running.
 *
 * Special-casing the response to `'cancelled'` would be a lie with teeth:
 * `cancelled` is TERMINAL, and an SDK's `fileBatches.createAndPoll(...)` stops
 * polling on a terminal status. Reporting it while the worker is still writing
 * chunks hands that caller a vector store that is still being mutated at the
 * exact moment the helper told it the batch had settled. OpenAI's own cancel
 * is a request rather than a completion for the same reason.
 *
 * The status therefore comes from the SAME `batchStatusAndCounts` derivation
 * and the SAME `toBatchObject` renderer as create and retrieve, so all three
 * endpoints emit a byte-identical object shape for the same batch.
 *
 * ORDER: cancel first, then read. Reading first would open a window in which
 * the counts predate the flag, and the response is a snapshot either way — the
 * worker can advance a file between the UPDATE and the SELECT regardless. What
 * this order does guarantee is that a 200 means the flag IS set.
 *
 * `requestBatchCancel` returning false is the 404 signal: it is `store_id`-
 * scoped, so a batch in another store updates no rows and is indistinguishable
 * from one that never existed — the same non-oracle contract as retrieve.
 */
export const cancelVectorStoreFileBatch = async (
  req: AuthenticatedRequest, res: Response, next: NextFunction,
): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const pool = getPool()!;
    // The owner check is this layer's job: `requestBatchCancel` scopes by
    // `store_id`, not by owner, so without it any caller who knew another
    // tenant's store id could cancel that tenant's ingestion.
    const storeRows = await pool.query<{ id: string }>(
      'SELECT id FROM vector_stores WHERE id = $1 AND owner_email = $2', [req.params.id, ownerEmail],
    );
    if (storeRows.rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }

    const cancelled = await requestBatchCancel(req.params.id, req.params.batch_id);
    if (!cancelled) { sendBatchNotFound(res, req.params.batch_id); return; }

    const [batch, derived] = await Promise.all([
      getBatch(req.params.id, req.params.batch_id),
      batchStatusAndCounts(req.params.id, req.params.batch_id),
    ]);
    // Only a concurrent store delete (which cascades to vector_store_batches)
    // can remove a batch that was updated a moment ago; by then it is gone, so
    // it is reported as gone rather than as a half-rendered object.
    if (!batch || !derived) { sendBatchNotFound(res, req.params.batch_id); return; }

    res.status(200).json(toBatchObject(batch, derived));
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

/**
 * `GET /vector_stores/{id}/file_batches/{batch_id}/files`.
 *
 * The store-level `GET /vector_stores/{id}/files` restricted to one batch. It
 * emits `vector_store.file` objects through `toStoreFileObject` and the page
 * envelope through `sendStoreFilePage` — the same two functions that endpoint
 * uses — so `limit`/`after`/`before`/`has_more`/`first_id`/`last_id` cannot
 * mean one thing here and another there. The query is `listBatchFiles`, which
 * is `store_id`- AND `batch_id`-scoped and resolves the cursor within the
 * batch, so a `file-` id from a sibling batch is as good as no cursor.
 *
 * `after` beats `before` when a caller sends both — `listBatchFiles` takes
 * `after ?? before` exactly as the store-level handler does. It is one rule,
 * chosen once, rather than an error: OpenAI's list endpoints do not reject the
 * combination, and this way the two endpoints cannot disagree about it.
 *
 * A batch that does not exist in this store 404s rather than returning an
 * empty list, which is why `getBatch` is consulted at all: an empty page is
 * the correct answer for a real batch whose files were all detached, and
 * answering 200-with-nothing for a nonexistent batch would make those two
 * indistinguishable — the same reasoning as retrieve's null check.
 *
 * The two reads are issued together: independent, `store_id`-scoped, and the
 * file query returns nothing for a batch that fails the existence check
 * anyway, so serialising them would only add a round trip.
 */
export const listVectorStoreFileBatchFiles = async (
  req: AuthenticatedRequest, res: Response, next: NextFunction,
): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const { limit, order, after, before } = parsePageParams(req.query as Record<string, unknown>);
    const filterStatus = parseFilterStatus((req.query as Record<string, unknown>).filter);
    const pool = getPool()!;

    const storeRows = await pool.query<{ id: string; chunking: unknown }>(
      'SELECT id, chunking FROM vector_stores WHERE id = $1 AND owner_email = $2', [req.params.id, ownerEmail],
    );
    if (storeRows.rows.length === 0) { sendStoreNotFound(res, req.params.id); return; }

    const [batch, rows] = await Promise.all([
      getBatch(req.params.id, req.params.batch_id),
      listBatchFiles(req.params.id, req.params.batch_id, {
        limit, order, after, before, filter: filterStatus,
      }),
    ]);
    if (!batch) { sendBatchNotFound(res, req.params.batch_id); return; }

    // A backwards page (`before` with no `after`) came back in reverse display
    // order; `sendStoreFilePage` flips it. `listBatchFiles` derives the same
    // condition from the same inputs — see its `usingBefore`.
    sendStoreFilePage(res, rows, limit, !!before && !after, storeRows.rows[0].chunking, !!(req as any).groundingActor);
  } catch (error) {
    handleKnownError(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// Search (Task 12)
// ---------------------------------------------------------------------------

/**
 * `POST /vector_stores/{id}/search` — the OpenAI-compatible search endpoint,
 * a thin HTTP wrapper over `search.ts`'s `searchVectorStores`. Returns
 * OpenAI's exact page shape; `mode` (which retrieval mode actually ran —
 * see search.ts's own doc comment) is internal bookkeeping for the live
 * gate and is deliberately NOT included in the response body below.
 */
export const searchVectorStore = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseSearchBody(body);

    const result = await searchVectorStores({
      storeIds: [req.params.id],
      query: parsed.query,
      ownerEmail,
      teamIds: callerTeamIds(req),
      maxNumResults: parsed.maxNumResults,
      filters: parsed.filters,
      rankingOptions: parsed.rankingOptions,
      rewriteQuery: parsed.rewriteQuery,
      // The caller pays for its search, also a cockpit user searching a store shared with
      // them (billed to the service key on their behalf).
      usage: searchUsageSink(fileSearchCallerOf(req), (req as any).debugRequestId),
    });

    res.status(200).json({
      object: result.object,
      // ARRAY, not a string. Verified against captured OpenAI responses on
      // 2026-08-06: both a plain search and a rewritten one returned
      // `"search_query": ["…"]`. We emitted a bare string, so a client doing
      // `search_query[0]` — the documented way to read it — got the first
      // CHARACTER of the query rather than the query.
      //
      // It is an array because a request can carry several queries (`query` as an array): every
      // query searched, after an optional rewrite; one entry for a single query.
      search_query: result.searchQueries,
      data: result.data.map((hit) => ({
        file_id: hit.fileId,
        filename: hit.filename,
        score: hit.score,
        attributes: hit.attributes,
        content: hit.content,
        // An extension, present only for a file with pages: the pages the content spans.
        ...(hit.pages ? { pages: hit.pages } : {}),
      })),
      has_more: result.hasMore,
      next_page: result.nextPage,
    });
  } catch (error) {
    if (error instanceof SearchStoreNotFoundError) { sendStoreNotFound(res, req.params.id); return; }
    handleKnownError(error, res, next);
  }
};
