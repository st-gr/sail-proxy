/**
 * OpenAI-compatible `/files` endpoints: upload, list, retrieve, delete, and
 * download original bytes. This is the first HTTP surface for file_search —
 * everything below scopes strictly by the authenticated caller's email
 * (`owner_email`) and treats "belongs to someone else" and "does not exist"
 * as indistinguishable (404, never 403): a caller must not be able to use
 * this API to discover that a file id exists but belongs to another owner.
 */
import { Request, Response, NextFunction } from 'express';
import { getPool, isFileSearchAvailable } from '../fileSearch/db';
import { unavailableBody } from '../fileSearch/unavailable';
import { FileSearchBusyError } from '../fileSearch/dbBusy';
import {
  sha256Of, retainBlob, releaseBlob, openBlob, UnsupportedBlobBackendError, BlobUnavailableError,
} from '../fileSearch/blob/blobStore';
import { deleteFileDetachingEverywhere } from '../fileSearch/repository';
import { queryString } from '../utils/queryParam';
import { handleDeadlock } from './vectorStoresController';
import { getFileSearchConfig } from '../services/configService';
import { parsePageParams, buildPage, FILES_PAGE_LIMITS } from '../fileSearch/pagination';
import { newFileId } from '../fileSearch/ids';
import { insertFileRow, notExpiredSql } from '../fileSearch/fileRows';
import { getDefaultLogger } from '@libs/logger';
import { MultipartParser, MalformedMultipartError, extractBoundary, MAX_TEXT_FIELD_BYTES } from '../utils/multipart';
export { parsePartHeaders } from '../utils/multipart';

const logger = getDefaultLogger();

/**
 * The `purpose` values an upload may carry: the two of OpenAI's enum
 * (`assistants`, `batch`, `fine-tune`, `vision`, `user_data`, `evals` —
 * openai-node `FilePurpose`) whose files are headed for a vector store.
 *
 * - `assistants`: what OpenAI's file-search guide uploads with in its Python and
 *   JavaScript samples. (`'file_search'`, what this endpoint once required, is not
 *   in OpenAI's enum, so a compliant client was rejected on its first call.)
 * - `user_data`: "flexible file type for any purpose" — what the same guide's Java
 *   and Ruby samples upload with before attaching the file to a vector store.
 *
 * The value is stored as given and returned on the file object. The rest of the
 * enum stays rejected: general file storage is out of scope — a file that isn't
 * headed for a vector store doesn't belong here — and that rejection is a named
 * deliberate gap in the design doc, not an oversight.
 */
const SUPPORTED_PURPOSES: readonly string[] = ['assistants', 'user_data'];

export interface AuthenticatedRequest extends Request {
  apiKeyInfo?: { email?: string; [key: string]: any };
  apiKey?: { email?: string; [key: string]: any };
}

// ---------------------------------------------------------------------------
// Shared response helpers
// ---------------------------------------------------------------------------

export function sendUnavailable(res: Response): void {
  res.status(503).json(unavailableBody());
}

/**
 * Blob storage errors, and a database pool too busy to hand out a connection
 * (`FileSearchBusyError`, `503 file_search_busy`), are answered with a 503, never a generic 500:
 * - `UnsupportedBlobBackendError`: `blob_storage.backend` is "local" (see
 *   blobStore.ts), a DEPLOYMENT MISCONFIGURATION — semantically identical to
 *   an unavailable file_search (unavailable.ts), answered with `503
 *   file_search_unavailable` and the operator-facing fix;
 * - `BlobUnavailableError`: a blob's storage cannot be reached (S3 credentials
 *   or config missing, a location outside the configured prefix, a failed
 *   request, missing bytes). The detail goes to the log only; the caller gets
 *   a generic `503 blob_storage_unavailable` without storage internals.
 *
 * Called from every handler's catch before `next(error)`; returns true when it
 * has written the response, so the caller must not also call `next`.
 */
export function sendIfUnsupportedBlobBackend(res: Response, error: unknown): boolean {
  if (error instanceof FileSearchBusyError) {
    // No database connection in time: retryable, the same envelope as the other file_search 503s.
    res.status(503).json({ error: { message: error.message, type: 'file_search_unavailable', param: null, code: error.code } });
    return true;
  }
  if (error instanceof BlobUnavailableError) {
    logger.error('FilesController', 'Blob storage is unavailable', error);
    res.status(503).json({
      error: {
        message: 'The file content storage is unavailable.',
        type: 'server_error',
        param: null,
        code: 'blob_storage_unavailable',
      },
    });
    return true;
  }
  if (!(error instanceof UnsupportedBlobBackendError)) return false;
  logger.error('FilesController', 'Refusing a request because blob_storage.backend is unsupported',
    error as Error);
  res.status(503).json({
    error: {
      // The message names the offending backend and how to fix it; it is
      // operator-facing configuration text, carrying no caller data.
      message: error.message,
      type: 'file_search_unavailable',
      param: null,
      code: 'file_search_unavailable',
    },
  });
  return true;
}

export function sendUnauthorized(res: Response): void {
  res.status(401).json({
    error: {
      message: 'Authentication required.',
      type: 'authentication_error',
      code: 'authentication_required',
    },
  });
}

function sendNotFound(res: Response, id: string): void {
  // Deliberately identical whether `id` doesn't exist at all or exists but is
  // owned by someone else — see file header. Callers must not be able to
  // distinguish the two cases from status, body, or shape.
  res.status(404).json({
    error: {
      message: `No such file: ${id}`,
      type: 'invalid_request_error',
      code: 'file_not_found',
    },
  });
}

export function sendInvalidRequest(res: Response, message: string, code: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', code } });
}

/** A rejected `expires_after`, naming the offending parameter as OpenAI's errors do. */
function sendInvalidExpiresAfter(res: Response, message: string, param: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', param, code: 'invalid_expires_after' } });
}

/** A file another owner's vector store still references cannot be deleted —
 *  see `deleteFile`'s own comment. */
function sendFileInUse(res: Response, id: string): void {
  res.status(409).json({
    error: {
      message: `File ${id} is used by a vector store you do not own, so it cannot be deleted.`,
      type: 'invalid_request_error',
      code: 'file_in_use',
    },
  });
}

/**
 * The gateway authenticates API keys that carry an email — both the unified
 * auth path (`unifiedTokenAuth` -> `req.apiKeyInfo = validationResult.data`)
 * and the legacy/local fallback path (`apiKeyAuth` -> `req.apiKeyInfo =
 * validKey`, the raw `ApiKeyRecord`) populate `.email` on `req.apiKeyInfo`
 * (and on the `req.apiKey` spread of the same data). That's the single
 * source of caller identity this module scopes every row lookup by.
 * AWS SigV4-authenticated requests carry no email today, so they simply
 * cannot use this API — there is no permissive fallback.
 */
export function getOwnerEmail(req: AuthenticatedRequest): string | null {
  const email = req.apiKeyInfo?.email ?? req.apiKey?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

export interface FileRow {
  id: string;
  filename: string;
  purpose: string;
  size_bytes: string | number;
  created_at: Date | string;
  expires_at?: Date | string | null;
}

export const toEpochSeconds = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1000);

/**
 * OpenAI's File object. `status` is a required field of the SDK's type (deprecated there, but
 * openai-node's `files.waitForProcessing()` and Python's `wait_for_processing` poll it until it is
 * `processed`), and a file here is ready the moment its upload is answered: always `processed`,
 * with no `status_details`.
 *
 * `expires_at` (Unix seconds) is present only for a file uploaded with `expires_after`, in OpenAI's
 * position after `created_at`. A file that never expires leaves it out rather than sending `null`:
 * the field is optional in OpenAI's File object (openai-node `expires_at?: number`, openai-python
 * `Optional[int] = None`), so both shapes are valid, and leaving it out keeps the responses for files
 * without an expiry byte-identical to before.
 */
export function toFileObject(row: FileRow): Record<string, unknown> {
  return {
    id: row.id,
    object: 'file',
    bytes: Number(row.size_bytes),
    created_at: toEpochSeconds(row.created_at),
    ...(row.expires_at != null ? { expires_at: toEpochSeconds(row.expires_at) } : {}),
    filename: row.filename,
    purpose: row.purpose,
    status: 'processed',
    status_details: null,
  };
}

/**
 * RFC 5987 `attr-char` percent-encoding for the `filename*` extended value:
 * `encodeURIComponent` already escapes everything outside
 * `A-Z a-z 0-9 - _ . ! ~ * ' ( )`, but four of those survivors — `*` `'` `(` `)`
 * — are not valid `attr-char` and must be escaped too.
 */
function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Builds a `Content-Disposition: attachment` header per RFC 6266, with the
 * RFC 5987 extended-value form for a filename Node's own header-value
 * validator (`\t\x20-\x7e\x80-\xff` only) would otherwise reject outright:
 * a character above U+00FF, or a C0/DEL control character, throws
 * `ERR_INVALID_CHAR` on `res.set`, turning every download of such a file into
 * a 500. The filename is caller-controlled (see the former single-caller
 * comment this replaced) and is never trustworthy verbatim.
 *
 * The ASCII fallback (`filename="..."`) replaces the same unsafe characters —
 * plus the quoted-string delimiters `"` and `\` — with `_`, exactly as the
 * hand-rolled sanitizer this replaces did for `"`/CR/LF. `filename*` is only
 * appended when the fallback actually lost information, so a plain-ASCII
 * filename with no special characters gets byte-identical output to before.
 */
function buildContentDispositionHeader(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const header = `attachment; filename="${fallback}"`;
  if (fallback === filename) return header;
  return `${header}; filename*=UTF-8''${encodeRfc5987ValueChars(filename)}`;
}

interface ParsedUpload {
  tooLarge: boolean;
  error: Error | null;
  file: { filename: string; contentType: string; bytes: Buffer } | null;
  purpose: string | null;
  /** The `expires_after[anchor]` / `expires_after[seconds]` parts sent, by name, as text. */
  expiresAfterFields?: Map<string, string>;
}

/** OpenAI's bounds on `expires_after.seconds`: one hour to 30 days. */
const MIN_EXPIRES_AFTER_SECONDS = 3600;
const MAX_EXPIRES_AFTER_SECONDS = 2592000;
export const EXPIRES_AFTER_ANCHOR_FIELD = 'expires_after[anchor]';
export const EXPIRES_AFTER_SECONDS_FIELD = 'expires_after[seconds]';
const EXPIRES_AFTER_FIELDS: readonly string[] = [EXPIRES_AFTER_ANCHOR_FIELD, EXPIRES_AFTER_SECONDS_FIELD];

/**
 * Validates OpenAI's `expires_after` (FileCreateParams.ExpiresAfter: `anchor: "created_at"`,
 * `seconds` 3600–2592000). Both SDKs send it in a multipart upload as the two fields
 * `expires_after[anchor]` and `expires_after[seconds]` — as do openai-java and openai-go: every one
 * of the four encodes a nested object in brackets (openai-node addFormValue `key[prop]`, openai-python
 * array_format "brackets", openai-java serializePart `$name[$key]`, openai-go apiform "brackets"), and
 * none sends a JSON-encoded `expires_after` field. Those two fields are what this reads; any other
 * part is ignored, as unknown parts always are here. Returns the seconds (null without either field),
 * or the problem with the parameter it names.
 */
function parseExpiresAfter(fields: Map<string, string> | undefined):
  { seconds: number | null } | { message: string; param: string } {
  if (!fields || fields.size === 0) return { seconds: null };
  const anchor = fields.get(EXPIRES_AFTER_ANCHOR_FIELD);
  const seconds = fields.get(EXPIRES_AFTER_SECONDS_FIELD);
  if (anchor === undefined) return { message: "Missing required parameter: 'expires_after.anchor'.", param: 'expires_after.anchor' };
  if (anchor !== 'created_at') {
    return { message: `Invalid 'expires_after.anchor': expected 'created_at', got '${anchor.slice(0, 64)}'.`, param: 'expires_after.anchor' };
  }
  if (seconds === undefined) return { message: "Missing required parameter: 'expires_after.seconds'.", param: 'expires_after.seconds' };
  const value = /^\d{1,10}$/.test(seconds) ? Number(seconds) : NaN;
  if (!(value >= MIN_EXPIRES_AFTER_SECONDS && value <= MAX_EXPIRES_AFTER_SECONDS)) {
    return {
      message: `Invalid 'expires_after.seconds': expected a whole number from ${MIN_EXPIRES_AFTER_SECONDS} to ${MAX_EXPIRES_AFTER_SECONDS}.`,
      param: 'expires_after.seconds',
    };
  }
  return { seconds: value };
}

/**
 * Consumes the raw request stream as multipart/form-data, extracting the
 * `file` and `purpose` parts. Enforces `maxFileBytes` DURING the stream as
 * a cap on total bytes consumed ACROSS EVERY PART — not just the one named
 * `file` — because an authenticated caller could otherwise stream unbounded
 * data under any other field name (it would be discarded, so memory is
 * fine, but nothing would ever stop the read). Reading is paused the moment
 * the cap is exceeded, rather than accumulating the rest of a possibly-huge
 * upload only to reject it after — the connection itself is left to
 * `uploadFile`'s tooLarge branch, which destroys it only once the 413 has
 * been flushed.
 */
function parseMultipartUpload(req: Request, boundary: string, maxFileBytes: number): Promise<ParsedUpload> {
  return new Promise((resolve) => {
    let settled = false;
    let activeField: string | null = null;
    let totalBytes = 0;
    let fileChunks: Buffer[] = [];
    let fileMeta: { filename?: string; contentType: string } | null = null;
    let purposeChunks: Buffer[] = [];
    let purposeSize = 0;
    // The two expires_after parts: small text fields, capped like `purpose`.
    const expiresAfterChunks = new Map<string, Buffer[]>();
    let expiresAfterSize = 0;

    function finish(result: ParsedUpload): void {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onReqError);
      resolve(result);
    }

    const parser = new MultipartParser(boundary, {
      onPartStart(part) {
        activeField = part.name;
        if (part.name === 'file') {
          fileMeta = { filename: part.filename, contentType: part.contentType };
          fileChunks = [];
        } else if (part.name === 'purpose') {
          purposeChunks = [];
          purposeSize = 0;
        } else if (EXPIRES_AFTER_FIELDS.includes(part.name)) {
          expiresAfterChunks.set(part.name, []);
          expiresAfterSize = 0;
        }
      },
      onPartData(chunk) {
        if (settled) return;
        // Total-bytes cap applies to every part, named or not — a part with
        // an unrecognized name still counts against the budget even though
        // its content is discarded below.
        totalBytes += chunk.length;
        if (totalBytes > maxFileBytes) {
          finish({ tooLarge: true, error: null, file: null, purpose: null });
          // Stop reading rather than tear the socket down: the 413 this
          // resolves into is written on the SAME connection a few
          // microticks later (uploadFile's tooLarge branch), and destroying
          // it here raced that response, delivering ECONNRESET instead. The
          // 'data' listener is already gone (removed by `finish` above), so
          // `pause()` just applies backpressure until the response ends the
          // request (see uploadFile).
          req.pause();
          return;
        }
        if (activeField === 'file') {
          fileChunks.push(chunk);
        } else if (activeField === 'purpose') {
          if (purposeSize < MAX_TEXT_FIELD_BYTES) {
            const take = chunk.slice(0, MAX_TEXT_FIELD_BYTES - purposeSize);
            purposeChunks.push(take);
            purposeSize += take.length;
          }
        } else if (activeField !== null && expiresAfterChunks.has(activeField)) {
          if (expiresAfterSize < MAX_TEXT_FIELD_BYTES) {
            const take = chunk.slice(0, MAX_TEXT_FIELD_BYTES - expiresAfterSize);
            expiresAfterChunks.get(activeField)!.push(take);
            expiresAfterSize += take.length;
          }
        }
      },
      onPartEnd() {
        activeField = null;
      },
    });

    function onData(chunk: Buffer): void {
      if (settled) return;
      parser.write(chunk);
      if (parser.error) {
        finish({ tooLarge: false, error: new MalformedMultipartError(parser.error.message), file: null, purpose: null });
      }
    }

    function onEnd(): void {
      if (settled) return;
      if (!parser.done) {
        finish({
          tooLarge: false,
          error: new MalformedMultipartError('Unexpected end of multipart body'),
          file: null, purpose: null,
        });
        return;
      }
      const purpose = purposeChunks.length > 0 ? Buffer.concat(purposeChunks).toString('utf8').trim() : null;
      const file = fileMeta
        ? { filename: fileMeta.filename || 'upload.bin', contentType: fileMeta.contentType, bytes: Buffer.concat(fileChunks) }
        : null;
      const expiresAfterFields = new Map(
        [...expiresAfterChunks].map(([name, chunks]) => [name, Buffer.concat(chunks).toString('utf8').trim()]));
      finish({ tooLarge: false, error: null, file, purpose, expiresAfterFields });
    }

    function onReqError(err: Error): void {
      // A genuine network/socket failure, not a parsing problem — left as a
      // plain Error so the caller's existing `next(error)` (-> 500) handling
      // is unchanged.
      finish({ tooLarge: false, error: err, file: null, purpose: null });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onReqError);
  });
}

const MAX_FILENAME_LENGTH = 255;

/** A new file's request that a rule refuses: answered 400 by `sendNewFileProblem`. */
export interface NewFileProblem { message: string; code: string; param?: string }

/**
 * The rules every new file passes, whether uploaded in one request (`POST /files`) or completed
 * from parts (`POST /uploads`, uploadsController.ts): the filename, the purpose (SUPPORTED_PURPOSES)
 * and OpenAI's `expires_after` (its two bracketed fields, as text). Checked in that order; returns
 * the first problem, or the expiry seconds (null: the file never expires).
 */
export function checkNewFile(input: { filename: string; purpose: string | null; expiresAfterFields?: Map<string, string> }):
  { problem: NewFileProblem } | { expiresAfterSeconds: number | null } {
  const filenameProblem = invalidFilenameReason(input.filename);
  if (filenameProblem) return { problem: { message: filenameProblem, code: 'invalid_filename' } };
  if (input.purpose === null || !SUPPORTED_PURPOSES.includes(input.purpose)) {
    return {
      problem: {
        message: `purpose must be "assistants" or "user_data" — this endpoint only supports files destined for a vector store.`,
        code: 'invalid_purpose',
      },
    };
  }
  const expiresAfter = parseExpiresAfter(input.expiresAfterFields);
  if ('param' in expiresAfter) {
    return { problem: { message: expiresAfter.message, code: 'invalid_expires_after', param: expiresAfter.param } };
  }
  return { expiresAfterSeconds: expiresAfter.seconds };
}

/** The 400 for a `checkNewFile` problem; `param` appears only where the rule names one. */
export function sendNewFileProblem(res: Response, problem: NewFileProblem): void {
  if (problem.param !== undefined) sendInvalidExpiresAfter(res, problem.message, problem.param);
  else sendInvalidRequest(res, problem.message, problem.code);
}

/** Returns an error message if `filename` is unfit to store, else null.
 *  Postgres `text` columns reject NUL bytes outright (raising a raw driver
 *  error we don't want to leak to the caller), and an unbounded filename is
 *  free storage for an attacker — both are checked before anything is
 *  hashed, retained, or inserted. */
function invalidFilenameReason(filename: string): string | null {
  if (filename.length === 0) return 'filename must not be empty';
  if (filename.length > MAX_FILENAME_LENGTH) return `filename must be ${MAX_FILENAME_LENGTH} characters or fewer`;
  if (filename.includes('\u0000')) return 'filename must not contain a NUL byte';
  return null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const uploadFile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const boundary = extractBoundary(req.headers['content-type']);
    if (!boundary) {
      sendInvalidRequest(res, 'Content-Type must be multipart/form-data with a boundary.', 'invalid_content_type');
      return;
    }

    const maxFileBytes = getFileSearchConfig().limits.maxFileBytes;
    const parsed = await parseMultipartUpload(req, boundary, maxFileBytes);

    if (parsed.error) {
      if (parsed.error instanceof MalformedMultipartError) {
        // Attacker/client-controlled input, not a server fault: 400, a
        // message we chose (never the raw parser internals), and no
        // error-level log noise. A genuine socket/network failure (a plain
        // Error, not this subclass) still falls through to next(error).
        logger.debug('FilesController', 'Rejected a malformed multipart upload', { reason: parsed.error.message });
        sendInvalidRequest(res, 'The request body is not valid multipart/form-data.', 'invalid_multipart_body');
        return;
      }
      next(parsed.error);
      return;
    }
    if (parsed.tooLarge) {
      if (!res.headersSent) {
        // The cap trips mid-body, so the request's readable side is paused
        // (not destroyed — see parseMultipartUpload) rather than torn down:
        // destroying the socket here raced this response, and the client
        // saw ECONNRESET/EPIPE instead of this JSON. `Connection: close`
        // plus destroying the request only once the response has actually
        // been flushed (`res.once('finish', ...)`) ensures the client reads
        // the 413 body before the socket goes away.
        res.set('Connection', 'close');
        res.once('finish', () => req.destroy());
        res.status(413).json({
          error: {
            message: `The file exceeds the maximum allowed size of ${maxFileBytes} bytes.`,
            type: 'invalid_request_error',
            code: 'file_too_large',
          },
        });
      }
      return;
    }
    if (!parsed.file) {
      sendInvalidRequest(res, 'The request must include a "file" part.', 'missing_file');
      return;
    }
    const checked = checkNewFile({
      filename: parsed.file.filename, purpose: parsed.purpose, expiresAfterFields: parsed.expiresAfterFields,
    });
    if ('problem' in checked) {
      sendNewFileProblem(res, checked.problem);
      return;
    }
    const purpose = parsed.purpose as string;

    // Hashed once, over the single buffer this parse already assembled — not
    // a second full-length pass distinct from receiving the upload.
    const sha = sha256Of(parsed.file.bytes);
    const { deduplicated } = await retainBlob(sha, parsed.file.bytes, parsed.file.contentType);
    // `deduplicated` is metrics-only (see blobStore.ts) — logged at debug,
    // never allowed to influence status/body/timing below.
    logger.debug('FilesController', 'Blob retained for upload', { deduplicated });

    const id = newFileId();
    // created_at from the database clock, RETURNING what was stored: see insertFileRow.
    let stored: { created_at: Date; expires_at: Date | null };
    try {
      stored = await insertFileRow({
        id, ownerEmail, filename: parsed.file.filename, purpose, sha256: sha, sizeBytes: parsed.file.bytes.length,
        expiresAfterSeconds: checked.expiresAfterSeconds,
      });
    } catch (insertError) {
      // Don't leave the blob's refcount incremented for a row that never landed.
      await releaseBlob(sha).catch((releaseError) => {
        logger.error('FilesController', 'Failed to release blob after a failed insert', releaseError, { fileId: id });
      });
      throw insertError;
    }

    res.status(200).json(toFileObject({
      id, filename: parsed.file.filename, purpose, size_bytes: parsed.file.bytes.length,
      created_at: stored.created_at, expires_at: stored.expires_at,
    }));
  } catch (error) {
    if (sendIfUnsupportedBlobBackend(res, error)) return;
    next(error);
  }
};

export const listFiles = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const { limit, order, after, before } = parsePageParams(req.query as Record<string, unknown>, FILES_PAGE_LIMITS);
    // OpenAI's `?purpose=` filter: files of that purpose only. Upload refuses any purpose outside
    // SUPPORTED_PURPOSES, so another value matches nothing and is answered without a query.
    const purpose = queryString((req.query as Record<string, unknown>).purpose);
    if (purpose !== null && !SUPPORTED_PURPOSES.includes(purpose)) {
      res.status(200).json({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
      return;
    }
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
        'SELECT created_at::text AS created_at, id FROM fs_files WHERE id = $1 AND owner_email = $2',
        [cursorId, ownerEmail],
      );
      cursorRow = cursorResult.rows[0] ?? null;
      if (!cursorRow) {
        // A cursor that doesn't resolve for this owner (bad cursor, another
        // owner's id, or an already-deleted file) yields an empty page —
        // never a full unfiltered page, and never a distinguishing error
        // that would confirm/deny the id belongs to someone else.
        res.status(200).json({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
        return;
      }
    }

    const displaySortDir = order === 'asc' ? 'ASC' : 'DESC';
    // cursorId = after ?? before, so if `after` is falsy here the cursor we
    // resolved above came from `before`.
    const usingBefore = !!cursorRow && !after;
    // Fetching in display order (same direction the list is walked via
    // `after`) picks up the rows immediately following the cursor, which is
    // correct for `after` but wrong for `before`: `before` walks the
    // OPPOSITE way — towards the cursor from the other side of the list —
    // so fetching in REVERSED order is what makes `LIMIT` keep the rows
    // closest to the cursor rather than the newest/oldest rows overall.
    // The page is flipped back to display order below once trimmed.
    const fetchSortDir = usingBefore ? (displaySortDir === 'ASC' ? 'DESC' : 'ASC') : displaySortDir;

    const params: unknown[] = [ownerEmail];
    // The cursor above resolves even for a file that expired since the previous page, so paging goes on.
    let where = `owner_email = $1 AND ${notExpiredSql()}`;
    if (purpose !== null) {
      params.push(purpose);
      where += ` AND purpose = $${params.length}`;
    }
    if (cursorRow) {
      params.push(cursorRow.created_at, cursorRow.id);
      const cmp = after ? (order === 'asc' ? '>' : '<') : (order === 'asc' ? '<' : '>');
      where += ` AND (created_at, id) ${cmp} ($${params.length - 1}::timestamptz, $${params.length})`;
    }
    params.push(limit + 1);

    const { rows } = await pool.query<FileRow>(
      `SELECT id, filename, purpose, size_bytes, created_at, expires_at FROM fs_files
       WHERE ${where} ORDER BY created_at ${fetchSortDir}, id ${fetchSortDir} LIMIT $${params.length}`,
      params,
    );

    // buildPage's has_more/trim logic is correct as-is on fetch-order rows
    // (it trims the row farthest from the cursor off the end); for `before`
    // the page is then reversed back into display order.
    const page = buildPage(rows, limit);
    if (usingBefore) {
      page.data.reverse();
      [page.first_id, page.last_id] = [page.last_id, page.first_id];
    }
    res.status(200).json({
      object: 'list',
      data: page.data.map(toFileObject),
      has_more: page.has_more,
      first_id: page.first_id,
      last_id: page.last_id,
    });
  } catch (error) {
    if (sendIfUnsupportedBlobBackend(res, error)) return;
    next(error);
  }
};

export const retrieveFile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const pool = getPool()!;
    const { rows } = await pool.query<FileRow>(
      `SELECT id, filename, purpose, size_bytes, created_at, expires_at FROM fs_files
        WHERE id = $1 AND owner_email = $2 AND ${notExpiredSql()}`,
      [req.params.id, ownerEmail],
    );
    if (rows.length === 0) { sendNotFound(res, req.params.id); return; }
    res.status(200).json(toFileObject(rows[0]));
  } catch (error) {
    if (sendIfUnsupportedBlobBackend(res, error)) return;
    next(error);
  }
};

/**
 * `DELETE /files/{id}` — OpenAI's "Delete a file and remove it from all vector stores": the file is
 * detached from every store of the caller and deleted in ONE transaction
 * (`deleteFileDetachingEverywhere`): its `vector_store_files` rows, its chunks and re-embed items in
 * those stores, the stores' `last_active_at`/`expires_at`, the `fs_files` row and the blob refcount
 * all change together or not at all. A file that was a member of a file batch leaves that batch with
 * it, exactly as a detach does (a batch's counts are derived from its members), and an ingestion
 * already running for it finds its attachment gone and discards its work.
 *
 * Owner-scoped like every route here: a file that does not exist, another owner's file and an
 * expired file the expiry sweeper has not deleted yet are the same 404 (the sweeper deletes it). `file_in_use` (409) remains for the one case the caller cannot resolve by deleting: a
 * store of ANOTHER owner still references the file. The cockpit's `?detach=true` (groundingController)
 * reaches the same transaction and stays accepted.
 */
export const deleteFile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const result = await deleteFileDetachingEverywhere(req.params.id, ownerEmail);
    if (result.inUse) { sendFileInUse(res, req.params.id); return; }
    if (!result.deleted) { sendNotFound(res, req.params.id); return; }
    res.status(200).json({ id: req.params.id, object: 'file', deleted: true });
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    if (sendIfUnsupportedBlobBackend(res, error)) return;
    next(error);
  }
};

export const downloadFileContent = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const pool = getPool()!;
    const { rows } = await pool.query<{ filename: string; sha256: string; mime: string | null }>(
      `SELECT f.filename, f.sha256, b.mime FROM fs_files f
       JOIN file_blobs b ON b.sha256 = f.sha256
       WHERE f.id = $1 AND f.owner_email = $2 AND ${notExpiredSql('f.')}`,
      [req.params.id, ownerEmail],
    );
    if (rows.length === 0) { sendNotFound(res, req.params.id); return; }

    const { filename, sha256, mime } = rows[0];
    // From the storage the blob row names; a BlobUnavailableError (including
    // missing bytes) is answered 503 below.
    const bytes = await openBlob(sha256);

    res
      .status(200)
      .set('Content-Type', mime || 'application/octet-stream')
      .set('Content-Disposition', buildContentDispositionHeader(filename))
      .send(bytes);
  } catch (error) {
    if (sendIfUnsupportedBlobBackend(res, error)) return;
    next(error);
  }
};
