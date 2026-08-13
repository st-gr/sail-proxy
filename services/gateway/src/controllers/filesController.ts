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
import {
  sha256Of, retainBlob, releaseBlob, getBackend, UnsupportedBlobBackendError,
} from '../fileSearch/blob/blobStore';
import { getFileSearchConfig } from '../services/configService';
import { parsePageParams, buildPage } from '../fileSearch/pagination';
import { newFileId } from '../fileSearch/ids';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

/**
 * The only `purpose` this feature supports.
 *
 * It is `'assistants'` because that is the value OpenAI's own file-search guide
 * uploads with, and the value the OpenAI SDK therefore sends. `'file_search'`
 * — what this constant used to be — is NOT in OpenAI's documented enum for
 * `POST /v1/files` (`assistants`, `assistants_output`, `batch`, `batch_output`,
 * `fine-tune`, `fine-tune-results`, `vision`, `user_data`), so a client written
 * against OpenAI's documentation was rejected on its first call and the feature
 * was unreachable through a compliant SDK. Verified against OpenAI's published
 * API reference, 2026-08-05.
 *
 * The rest of the enum stays rejected: general file storage is out of scope —
 * a file that isn't headed for a vector store doesn't belong here — and that
 * rejection is a named deliberate gap in the design doc, not an oversight.
 */
const SUPPORTED_PURPOSE = 'assistants';

interface AuthenticatedRequest extends Request {
  apiKeyInfo?: { email?: string; [key: string]: any };
  apiKey?: { email?: string; [key: string]: any };
}

// ---------------------------------------------------------------------------
// Shared response helpers
// ---------------------------------------------------------------------------

function sendUnavailable(res: Response): void {
  res.status(503).json({
    error: {
      message: 'file_search is unavailable: no vector database is configured for this deployment.',
      type: 'file_search_unavailable',
      code: 'file_search_unavailable',
    },
  });
}

/**
 * `getBackend()` refuses a `blob_storage.backend` other than `"db"` (see
 * blobStore.ts). That is a DEPLOYMENT MISCONFIGURATION, not a caller mistake
 * and not a server fault the caller could retry into success — semantically
 * identical to "no vector database is configured", which this module already
 * answers with `503 file_search_unavailable`. Left to fall through to
 * `next(error)` it surfaced as a generic `500`, telling an operator nothing and
 * telling a client to treat it as a transient server bug.
 *
 * Called from every handler's catch before `next(error)`; returns true when it
 * has written the response, so the caller must not also call `next`.
 */
function sendIfUnsupportedBlobBackend(res: Response, error: unknown): boolean {
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

function sendUnauthorized(res: Response): void {
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

function sendInvalidRequest(res: Response, message: string, code: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', code } });
}

/** A file still attached to at least one vector store cannot be deleted —
 *  see `deleteFile`'s own comment for why. */
function sendFileInUse(res: Response, id: string): void {
  res.status(409).json({
    error: {
      message: `File ${id} is still attached to one or more vector stores; detach it from every store before deleting it.`,
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
function getOwnerEmail(req: AuthenticatedRequest): string | null {
  const email = req.apiKeyInfo?.email ?? req.apiKey?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

interface FileRow {
  id: string;
  filename: string;
  purpose: string;
  size_bytes: string | number;
  created_at: Date | string;
}

function toFileObject(row: FileRow): Record<string, unknown> {
  const createdAtMs = row.created_at instanceof Date ? row.created_at.getTime() : new Date(row.created_at).getTime();
  return {
    id: row.id,
    object: 'file',
    bytes: Number(row.size_bytes),
    created_at: Math.floor(createdAtMs / 1000),
    filename: row.filename,
    purpose: row.purpose,
  };
}

function sanitizeFilenameForHeader(filename: string): string {
  // The filename is caller-controlled and gets echoed into a response header;
  // strip characters that could split/inject headers rather than trust it verbatim.
  return filename.replace(/[\r\n"]/g, '_');
}

// ---------------------------------------------------------------------------
// Minimal streaming multipart/form-data parser
//
// No multipart-parsing dependency exists anywhere in this workspace's
// dependency tree (checked: not a direct or transitive dependency). Rather
// than add one, this implements just enough of RFC 7578 for what OpenAI's
// file-upload clients (and curl -F) actually send: a `file` part and an
// optional `purpose` part, in any order, over a stream that may arrive in
// arbitrarily small chunks. It is intentionally NOT a general-purpose
// multipart library — only the two field names this endpoint understands are
// captured; everything else is parsed through (for correct boundary
// tracking) and discarded.
// ---------------------------------------------------------------------------

interface MultipartPart {
  name: string;
  filename?: string;
  contentType: string;
}

interface MultipartCallbacks {
  onPartStart(part: MultipartPart): void;
  onPartData(chunk: Buffer): void;
  onPartEnd(): void;
}

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'latin1');
const MAX_HEADER_BYTES = 8 * 1024;

/**
 * Decodes an RFC 5987 `charset'language'percent-encoded-value`.
 *
 * Returns null — leaving any quoted `filename` in place — for anything it
 * cannot decode safely: an unsupported charset, malformed percent-encoding, or
 * a decoded value carrying a NUL. A NUL here would otherwise reach Postgres as
 * raw text and throw 22021, which is the class of defect `nulByteGuard` exists
 * to prevent; the guard does not cover this path because the byte arrives
 * percent-encoded and is only materialised by this decoder.
 */
function decodeRfc5987(raw: string): string | null {
  const m = raw.match(/^([^']*)'[^']*'(.*)$/);
  if (!m) return null;
  const charset = m[1].toLowerCase();
  if (charset !== 'utf-8' && charset !== 'us-ascii') return null;
  let decoded: string;
  try {
    // Throws URIError on malformed escapes ('%ZZ', a trailing '%') and on
    // percent-encoded bytes that are not valid UTF-8.
    decoded = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (decoded.includes(String.fromCharCode(0))) return null;
  return decoded;
}

// Exported for direct unit testing: driving the header-form matrix (unquoted
// tokens, RFC 5987 extended values, malformed encodings) through a full HTTP
// upload would test the wire framing, not the parsing rules under test.
export function parsePartHeaders(raw: string): MultipartPart | null {
  let name: string | undefined;
  let filename: string | undefined;
  let contentType = 'application/octet-stream';
  for (const line of raw.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'content-disposition') {
      // RFC 7578 allows a bare token for `name`; browsers quote it, curl does
      // not. The quoted form is tried first so a quoted value containing a
      // delimiter is not truncated by the token alternative.
      const nameMatch = value.match(/;\s*name="([^"]*)"/i) ?? value.match(/;\s*name=([^;"\s]+)/i);
      const filenameMatch = value.match(/;\s*filename="([^"]*)"/i);
      // RFC 5987. Takes precedence over the Latin-1 `filename` when both are
      // sent, which is what browsers do for a non-ASCII name.
      const extendedMatch = value.match(/;\s*filename\*=([^;]+)/i);
      if (nameMatch) name = nameMatch[1];
      if (filenameMatch) filename = filenameMatch[1];
      if (extendedMatch) {
        const decoded = decodeRfc5987(extendedMatch[1].trim());
        if (decoded !== null) filename = decoded;
      }
    } else if (key === 'content-type') {
      contentType = value;
    }
  }
  if (!name) return null;
  return { name, filename, contentType };
}

type ParserState = 'HEADERS' | 'BODY' | 'BOUNDARY_TAIL' | 'DONE' | 'ERROR';

/**
 * Streaming multipart body parser. Fed via `write(chunk)`; emits part
 * lifecycle callbacks as boundaries resolve, buffering only the small amount
 * of unresolved tail data needed to detect a boundary split across chunks
 * (bounded by the boundary marker's length, not the body size).
 */
class MultipartParser {
  private readonly delim: Buffer;
  private buf: Buffer;
  private state: ParserState = 'HEADERS';
  private readonly cb: MultipartCallbacks;
  public error: Error | null = null;

  constructor(boundary: string, cb: MultipartCallbacks) {
    this.delim = Buffer.from(`\r\n--${boundary}`, 'latin1');
    // A virtual leading CRLF lets the very first boundary (which has no
    // preceding CRLF in the wire format) match the same delimiter pattern as
    // every subsequent one.
    this.buf = Buffer.from('\r\n', 'latin1');
    this.cb = cb;
  }

  get done(): boolean {
    return this.state === 'DONE';
  }

  write(chunk: Buffer): void {
    if (this.state === 'DONE' || this.state === 'ERROR') return;
    this.buf = Buffer.concat([this.buf, chunk]);
    this.pump();
  }

  private fail(message: string): void {
    this.state = 'ERROR';
    this.error = new Error(message);
  }

  private pump(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.state === 'DONE' || this.state === 'ERROR') return;

      if (this.state === 'HEADERS') {
        const sep = this.buf.indexOf(HEADER_TERMINATOR);
        if (sep === -1) {
          if (this.buf.length > MAX_HEADER_BYTES) { this.fail('multipart part headers too large'); }
          return;
        }
        const part = parsePartHeaders(this.buf.slice(0, sep).toString('latin1'));
        this.buf = this.buf.slice(sep + HEADER_TERMINATOR.length);
        if (!part) { this.fail('multipart part missing Content-Disposition name'); return; }
        this.cb.onPartStart(part);
        this.state = 'BODY';
        continue;
      }

      if (this.state === 'BODY') {
        const idx = this.buf.indexOf(this.delim);
        if (idx === -1) {
          // Flush everything except a tail long enough to still contain a
          // boundary split across this chunk and the next one.
          const keep = Math.min(this.buf.length, this.delim.length - 1);
          const flushLen = this.buf.length - keep;
          if (flushLen > 0) {
            this.cb.onPartData(this.buf.slice(0, flushLen));
            this.buf = this.buf.slice(flushLen);
          }
          return;
        }
        if (idx > 0) this.cb.onPartData(this.buf.slice(0, idx));
        this.cb.onPartEnd();
        this.buf = this.buf.slice(idx + this.delim.length);
        this.state = 'BOUNDARY_TAIL';
        continue;
      }

      if (this.state === 'BOUNDARY_TAIL') {
        if (this.buf.length < 2) return;
        if (this.buf[0] === 0x2d && this.buf[1] === 0x2d) { // '--'
          this.state = 'DONE';
          return;
        }
        if (this.buf[0] === 0x0d && this.buf[1] === 0x0a) { // '\r\n'
          this.buf = this.buf.slice(2);
          this.state = 'HEADERS';
          continue;
        }
        this.fail('malformed multipart boundary');
        return;
      }
    }
  }
}

function extractBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = contentType.match(/multipart\/form-data\s*;.*boundary=("?)([^";]+)\1/i);
  return match ? match[2] : null;
}

const MAX_TEXT_FIELD_BYTES = 1024;

/**
 * A multipart body that failed to parse (bad boundary syntax, an
 * unterminated final part, a truncated/empty body, etc). This is always
 * attacker/client-controlled input, never a server fault — it must map to
 * `400`, not `500`, and must not be logged at error level. Deliberately
 * distinct from a raw `req.on('error', ...)` (a genuine socket/network
 * failure), which keeps its existing `500` behavior unchanged.
 */
class MalformedMultipartError extends Error {}

interface ParsedUpload {
  tooLarge: boolean;
  error: Error | null;
  file: { filename: string; contentType: string; bytes: Buffer } | null;
  purpose: string | null;
}

/**
 * Consumes the raw request stream as multipart/form-data, extracting the
 * `file` and `purpose` parts. Enforces `maxFileBytes` DURING the stream as
 * a cap on total bytes consumed ACROSS EVERY PART — not just the one named
 * `file` — because an authenticated caller could otherwise stream unbounded
 * data under any other field name (it would be discarded, so memory is
 * fine, but nothing would ever stop the read). The connection is torn down
 * (`req.destroy()`) the moment the cap is exceeded, rather than
 * accumulating the rest of a possibly-huge upload only to reject it after.
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
          req.destroy();
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
      finish({ tooLarge: false, error: null, file, purpose });
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
    const filenameProblem = invalidFilenameReason(parsed.file.filename);
    if (filenameProblem) {
      sendInvalidRequest(res, filenameProblem, 'invalid_filename');
      return;
    }
    if (parsed.purpose !== SUPPORTED_PURPOSE) {
      sendInvalidRequest(
        res,
        `purpose must be "${SUPPORTED_PURPOSE}" — this endpoint only supports files destined for a vector store.`,
        'invalid_purpose',
      );
      return;
    }

    // Hashed once, over the single buffer this parse already assembled — not
    // a second full-length pass distinct from receiving the upload.
    const sha = sha256Of(parsed.file.bytes);
    const { deduplicated } = await retainBlob(sha, parsed.file.bytes, parsed.file.contentType);
    // `deduplicated` is metrics-only (see blobStore.ts) — logged at debug,
    // never allowed to influence status/body/timing below.
    logger.debug('FilesController', 'Blob retained for upload', { deduplicated });

    const id = newFileId();
    const pool = getPool()!;
    // created_at comes from the DATABASE clock, like vector_stores and
    // vector_store_files. It is the keyset pagination cursor for GET /files
    // (ORDER BY created_at, id), so an application-clock value is not merely
    // inconsistent: two gateway replicas whose clocks disagree would store rows
    // in an order that contradicts their true insertion order, and a cursor
    // resolved against one replica's value can skip or repeat rows on a page
    // served by the other.
    //
    // RETURNING, not a second SELECT and not the bound value: the response must
    // report what was actually stored. Note that `RETURNING` echoing a BOUND
    // parameter is exactly how the old form looked correct while being wrong —
    // here there is no bound value to echo.
    let createdAt: Date;
    try {
      const inserted = await pool.query<{ created_at: Date }>(
        `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         RETURNING created_at`,
        [id, ownerEmail, parsed.file.filename, parsed.purpose, sha, parsed.file.bytes.length],
      );
      createdAt = inserted.rows[0].created_at;
    } catch (insertError) {
      // Don't leave the blob's refcount incremented for a row that never landed.
      await releaseBlob(sha).catch((releaseError) => {
        logger.error('FilesController', 'Failed to release blob after a failed insert', releaseError, { fileId: id });
      });
      throw insertError;
    }

    res.status(200).json(toFileObject({
      id, filename: parsed.file.filename, purpose: parsed.purpose, size_bytes: parsed.file.bytes.length, created_at: createdAt,
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
    let where = 'owner_email = $1';
    if (cursorRow) {
      params.push(cursorRow.created_at, cursorRow.id);
      const cmp = after ? (order === 'asc' ? '>' : '<') : (order === 'asc' ? '<' : '>');
      where += ` AND (created_at, id) ${cmp} ($2::timestamptz, $3)`;
    }
    params.push(limit + 1);

    const { rows } = await pool.query<FileRow>(
      `SELECT id, filename, purpose, size_bytes, created_at FROM fs_files
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
      'SELECT id, filename, purpose, size_bytes, created_at FROM fs_files WHERE id = $1 AND owner_email = $2',
      [req.params.id, ownerEmail],
    );
    if (rows.length === 0) { sendNotFound(res, req.params.id); return; }
    res.status(200).json(toFileObject(rows[0]));
  } catch (error) {
    if (sendIfUnsupportedBlobBackend(res, error)) return;
    next(error);
  }
};

export const deleteFile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const pool = getPool()!;
    // Atomic delete-and-return: no separate SELECT-then-DELETE race window
    // where a concurrent request could see the row as present after it's
    // already gone (or vice versa). This also means a concurrent ATTACH
    // racing this delete is resolved correctly with no separate lock: the
    // FK below either sees the new vector_store_files row (and rejects) or
    // doesn't (and this delete proceeds) — there is no window where both
    // "succeeded".
    //
    // `vector_store_files.file_id` deliberately has no `ON DELETE CASCADE`
    // onto this table (see schema.sql.ts and Task 10's repository.ts) — a
    // file can serve several vector stores, and OpenAI's own API is explicit
    // that detaching a file from a store does not delete the file. So a file
    // still attached anywhere must not be deletable here; Postgres enforces
    // that as a `foreign_key_violation` (23503), caught below and mapped to
    // a clean 409 rather than left to leak as a raw driver error via next().
    let rows: { sha256: string }[];
    try {
      ({ rows } = await pool.query<{ sha256: string }>(
        'DELETE FROM fs_files WHERE id = $1 AND owner_email = $2 RETURNING sha256',
        [req.params.id, ownerEmail],
      ));
    } catch (deleteError: any) {
      if (deleteError?.code === '23503') {
        sendFileInUse(res, req.params.id);
        return;
      }
      throw deleteError;
    }
    if (rows.length === 0) { sendNotFound(res, req.params.id); return; }

    // Decrements the blob's refcount; only removes the physical bytes when it
    // reaches zero (see blobStore.releaseBlob). Another owner's identical
    // upload — same sha256, its own fs_files row — is unaffected.
    await releaseBlob(rows[0].sha256);

    res.status(200).json({ id: req.params.id, object: 'file', deleted: true });
  } catch (error) {
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
       WHERE f.id = $1 AND f.owner_email = $2`,
      [req.params.id, ownerEmail],
    );
    if (rows.length === 0) { sendNotFound(res, req.params.id); return; }

    const { filename, sha256, mime } = rows[0];
    const bytes = await getBackend().get(sha256);
    if (!bytes) {
      logger.error('FilesController', 'fs_files row references a blob with no backing bytes',
        undefined, { fileId: req.params.id });
      res.status(500).json({
        error: { message: 'Stored file content is unavailable.', type: 'server_error', code: 'blob_missing' },
      });
      return;
    }

    res
      .status(200)
      .set('Content-Type', mime || 'application/octet-stream')
      .set('Content-Disposition', `attachment; filename="${sanitizeFilenameForHeader(filename)}"`)
      .send(bytes);
  } catch (error) {
    if (sendIfUnsupportedBlobBackend(res, error)) return;
    next(error);
  }
};
