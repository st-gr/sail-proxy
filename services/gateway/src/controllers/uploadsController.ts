/**
 * OpenAI's Uploads API (`/uploads`): create an upload, add parts (multipart field `data`), complete
 * it into a file with the part ids in order (and an optional md5), or cancel it. The request and
 * response shapes are openai-node's `client.uploads.*` and openai-python's `client.uploads.*`
 * (including `upload_file_chunked`, which needs `part_size` at most this gateway's part limit).
 *
 * A completed upload is an ordinary file: the same filename, purpose and `expires_after` rules as
 * `POST /files` (`checkNewFile`), the same size limit, and the same storage path (fileSearch/uploads.ts).
 * Owner-scoped like the Files API: another owner's upload is the same 404 as one that does not exist.
 */
import { Response, NextFunction } from 'express';
import { isFileSearchAvailable } from '../fileSearch/db';
import { getFileSearchConfig } from '../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { extractBoundary, MalformedMultipartError, parseMultipartFields } from '../utils/multipart';
import {
  AuthenticatedRequest, getOwnerEmail, sendUnavailable, sendUnauthorized, sendInvalidRequest, sendIfUnsupportedBlobBackend,
  checkNewFile, sendNewFileProblem, toFileObject, toEpochSeconds, EXPIRES_AFTER_ANCHOR_FIELD, EXPIRES_AFTER_SECONDS_FIELD,
} from './filesController';
import { handleDeadlock } from './vectorStoresController';
import {
  createUpload as createUploadRow, addUploadPart, completeUpload as completeUploadRow, cancelUpload as cancelUploadRow,
  uploadPartLimit, UploadRow, UploadRequestError, UploadNotFoundError, MAX_PARTS_PER_UPLOAD,
} from '../fileSearch/uploads';

const logger = getDefaultLogger();

const MAX_MIME_TYPE_LENGTH = 255;
/** `type/subtype`, optionally with parameters (`text/plain; charset=utf-8`). */
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(\s*;[\x20-\x7e]*)?$/;
const MAX_PART_ID_LENGTH = 64;
const MD5_PATTERN = /^[0-9a-fA-F]{32}$/;

/** OpenAI's Upload object. `file` is the created File object once completed, else null. */
function toUploadObject(row: UploadRow, file: Record<string, unknown> | null): Record<string, unknown> {
  return {
    id: row.id,
    object: 'upload',
    bytes: Number(row.bytes),
    created_at: toEpochSeconds(row.created_at),
    filename: row.filename,
    purpose: row.purpose,
    status: row.status,
    expires_at: toEpochSeconds(row.expires_at),
    file,
  };
}

function sendParamError(res: Response, status: number, message: string, param: string | null, code: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error', param, code } });
}

const missing = (res: Response, param: string): void =>
  sendParamError(res, 400, `Missing required parameter: '${param}'.`, param, 'missing_required_parameter');
const wrongType = (res: Response, param: string, expected: string): void =>
  sendParamError(res, 400, `Invalid type for '${param}': expected ${expected}.`, param, 'invalid_type');

/** Maps the upload module's refusals; returns true when it has answered. */
function sendUploadError(res: Response, error: unknown): boolean {
  if (error instanceof UploadNotFoundError) {
    res.status(404).json({ error: { message: error.message, type: 'invalid_request_error', code: 'upload_not_found' } });
    return true;
  }
  if (error instanceof UploadRequestError) {
    sendParamError(res, error.status, error.message, error.param, error.code);
    return true;
  }
  return handleDeadlock(error, res) || sendIfUnsupportedBlobBackend(res, error);
}

const bodyOf = (req: AuthenticatedRequest): Record<string, unknown> =>
  (req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

/** `POST /uploads` {filename, purpose, bytes, mime_type, expires_after?} → the pending Upload. */
export const createUpload = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const body = bodyOf(req);
    for (const param of ['bytes', 'filename', 'mime_type', 'purpose']) {
      if (body[param] === undefined || body[param] === null) { missing(res, param); return; }
    }
    const { filename, purpose, bytes, mime_type: mimeType, expires_after: expiresAfter } = body;
    if (typeof filename !== 'string') { wrongType(res, 'filename', 'a string'); return; }
    if (typeof purpose !== 'string') { wrongType(res, 'purpose', 'a string'); return; }
    if (typeof mimeType !== 'string') { wrongType(res, 'mime_type', 'a string'); return; }
    if (typeof bytes !== 'number') { wrongType(res, 'bytes', 'an integer'); return; }

    // OpenAI's `expires_after {anchor, seconds}` as JSON, checked by the same rule as the bracketed
    // multipart fields of POST /files.
    const expiresAfterFields = new Map<string, string>();
    if (expiresAfter !== undefined && expiresAfter !== null) {
      if (typeof expiresAfter !== 'object' || Array.isArray(expiresAfter)) {
        sendParamError(res, 400, "Invalid 'expires_after': expected an object.", 'expires_after', 'invalid_expires_after');
        return;
      }
      const { anchor, seconds } = expiresAfter as Record<string, unknown>;
      if (anchor !== undefined) expiresAfterFields.set(EXPIRES_AFTER_ANCHOR_FIELD, String(anchor));
      if (seconds !== undefined) expiresAfterFields.set(EXPIRES_AFTER_SECONDS_FIELD, String(seconds));
      if (expiresAfterFields.size === 0) {
        sendParamError(res, 400, "Missing required parameter: 'expires_after.anchor'.", 'expires_after.anchor', 'invalid_expires_after');
        return;
      }
    }
    const checked = checkNewFile({ filename, purpose, expiresAfterFields });
    if ('problem' in checked) { sendNewFileProblem(res, checked.problem); return; }

    const maxFileBytes = getFileSearchConfig().limits.maxFileBytes;
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      sendParamError(res, 400, "Invalid 'bytes': expected a whole number of at least 1.", 'bytes', 'invalid_value');
      return;
    }
    if (bytes > maxFileBytes) {
      sendParamError(res, 400, `The file exceeds the maximum allowed size of ${maxFileBytes} bytes.`, 'bytes', 'file_too_large');
      return;
    }
    if (mimeType.length > MAX_MIME_TYPE_LENGTH || !MIME_TYPE_PATTERN.test(mimeType)) {
      sendParamError(res, 400, "Invalid 'mime_type': expected a MIME type such as 'application/pdf'.", 'mime_type', 'invalid_mime_type');
      return;
    }

    const row = await createUploadRow({
      ownerEmail, filename, purpose, mimeType, bytes, expiresAfterSeconds: checked.expiresAfterSeconds,
    });
    res.status(200).json(toUploadObject(row, null));
  } catch (error) {
    if (sendUploadError(res, error)) return;
    next(error);
  }
};

/** `POST /uploads/{id}/parts` (multipart, field `data`) → the Upload Part. */
export const addPart = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const boundary = extractBoundary(req.headers['content-type']);
    if (!boundary) {
      sendInvalidRequest(res, 'Content-Type must be multipart/form-data with a boundary.', 'invalid_content_type');
      return;
    }
    const limit = uploadPartLimit(getFileSearchConfig().limits.maxFileBytes);
    // At most `limit` bytes across the body, enforced while it streams (see parseMultipartFields).
    const parsed = await parseMultipartFields(req, boundary, { maxBytes: limit, fileFields: ['data'], textFields: [], maxFileBytes: limit });
    if (parsed.error) {
      if (parsed.error instanceof MalformedMultipartError) {
        logger.debug('UploadsController', 'Rejected a malformed multipart part', { reason: parsed.error.message });
        sendInvalidRequest(res, 'The request body is not valid multipart/form-data.', 'invalid_multipart_body');
        return;
      }
      next(parsed.error);
      return;
    }
    if (parsed.tooLarge) {
      if (!res.headersSent) {
        // As POST /files' 413: the request is paused, not destroyed, until this answer is flushed.
        res.set('Connection', 'close');
        res.once('finish', () => req.destroy());
        sendParamError(res, 413, `The part exceeds the maximum part size of ${limit} bytes. Send the file in smaller parts.`,
          'data', 'part_too_large');
      }
      return;
    }
    const data = parsed.files.find((f) => f.field === 'data');
    if (!data) {
      sendParamError(res, 400, 'The request must include a "data" part.', 'data', 'missing_required_parameter');
      return;
    }
    const part = await addUploadPart(ownerEmail, req.params.id, data.bytes);
    res.status(200).json({
      id: part.id, object: 'upload.part', created_at: toEpochSeconds(part.created_at), upload_id: part.upload_id,
    });
  } catch (error) {
    if (sendUploadError(res, error)) return;
    next(error);
  }
};

/** `POST /uploads/{id}/complete` {part_ids, md5?} → the completed Upload with its `file`. */
export const completeUpload = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const body = bodyOf(req);
    const partIds = body.part_ids;
    if (partIds === undefined || partIds === null) { missing(res, 'part_ids'); return; }
    if (!Array.isArray(partIds) || partIds.some((p) => typeof p !== 'string' || p.length === 0 || p.length > MAX_PART_ID_LENGTH)) {
      wrongType(res, 'part_ids', 'an array of part ids');
      return;
    }
    if (partIds.length === 0 || partIds.length > MAX_PARTS_PER_UPLOAD) {
      sendParamError(res, 400, `'part_ids' must name from 1 to ${MAX_PARTS_PER_UPLOAD} parts.`, 'part_ids', 'invalid_value');
      return;
    }
    if (new Set(partIds).size !== partIds.length) {
      sendParamError(res, 400, "'part_ids' must not name a part twice.", 'part_ids', 'invalid_value');
      return;
    }
    const { md5 } = body;
    if (md5 !== undefined && md5 !== null && (typeof md5 !== 'string' || !MD5_PATTERN.test(md5))) {
      sendParamError(res, 400, "Invalid 'md5': expected 32 hexadecimal characters.", 'md5', 'invalid_value');
      return;
    }

    const { upload, file } = await completeUploadRow(
      ownerEmail, req.params.id, partIds as string[], typeof md5 === 'string' ? md5.toLowerCase() : null,
      getFileSearchConfig().limits.maxFileBytes,
    );
    res.status(200).json(toUploadObject(upload, toFileObject(file)));
  } catch (error) {
    if (sendUploadError(res, error)) return;
    next(error);
  }
};

/** `POST /uploads/{id}/cancel` → the cancelled Upload. */
export const cancelUpload = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!isFileSearchAvailable()) { sendUnavailable(res); return; }
  const ownerEmail = getOwnerEmail(req);
  if (!ownerEmail) { sendUnauthorized(res); return; }

  try {
    const row = await cancelUploadRow(ownerEmail, req.params.id);
    res.status(200).json(toUploadObject(row, null));
  } catch (error) {
    if (sendUploadError(res, error)) return;
    next(error);
  }
};
