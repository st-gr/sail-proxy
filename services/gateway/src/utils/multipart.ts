// ---------------------------------------------------------------------------
// Minimal streaming multipart/form-data parser
//
// Shared by the files upload endpoint (`/openai/v1/files`, which drives the
// parser directly from `filesController.parseMultipartUpload`) and the Images
// endpoints (`/openai/v1/images/edits`, through `parseMultipartFields` below).
//
// No multipart-parsing dependency exists anywhere in this workspace's
// dependency tree (checked: not a direct or transitive dependency). Rather
// than add one, this implements just enough of RFC 7578 for what OpenAI's
// file-upload clients (and curl -F) actually send: file parts and text parts,
// in any order, over a stream that may arrive in arbitrarily small chunks. It
// is intentionally NOT a general-purpose multipart library — only the field
// names a caller asks for are captured; everything else is parsed through (for
// correct boundary tracking) and discarded.
// ---------------------------------------------------------------------------

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType: string;
}

export interface MultipartCallbacks {
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
export class MultipartParser {
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

export function extractBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = contentType.match(/multipart\/form-data\s*;.*boundary=("?)([^";]+)\1/i);
  return match ? match[2] : null;
}

export const MAX_TEXT_FIELD_BYTES = 1024;

/**
 * A multipart body that failed to parse (bad boundary syntax, an
 * unterminated final part, a truncated/empty body, etc). This is always
 * attacker/client-controlled input, never a server fault — it must map to
 * `400`, not `500`, and must not be logged at error level. Deliberately
 * distinct from a raw `req.on('error', ...)` (a genuine socket/network
 * failure), which keeps its existing `500` behavior unchanged.
 */
export class MalformedMultipartError extends Error {}

import type { Readable } from 'stream';

export interface ParsedFile { field: string; filename: string; contentType: string; bytes: Buffer }
export interface ParsedFields {
  tooLarge: boolean;
  /** The file field whose own part blew `maxFileBytes`; unset when the WHOLE-body cap was hit. */
  tooLargeField?: string;
  /**
   * Text fields whose part exceeded the per-field byte budget. Only as much as the budget was
   * kept in `fields`, so a caller that ignores this list silently serves a truncated value —
   * which is why `/edits` refuses the request instead (its `prompt` IS the input).
   */
  truncated: string[];
  error: Error | null;
  files: ParsedFile[];
  fields: Record<string, string>;
}

/** `image[]` (the OpenAI SDKs' array field syntax) is the same field as `image`. */
function fieldName(name: string): string {
  return name.endsWith('[]') ? name.slice(0, -2) : name;
}

/**
 * Generic sibling of the files controller's upload parser: collects the named file
 * parts (bytes in memory) and text parts (each capped at `maxTextFieldBytes`, default
 * MAX_TEXT_FIELD_BYTES, with an over-budget field reported in `truncated` rather than
 * silently shortened), parses everything else through for boundary tracking and discards it.
 *
 * Two independent size caps, both enforced DURING the stream so nothing oversized is ever
 * fully buffered: `maxBytes` over the total bytes consumed across every part, and the
 * optional `maxFileBytes` over each single file part (reported as `tooLarge` with
 * `tooLargeField`). Either one tears the request down.
 */
export function parseMultipartFields(
  req: Readable,
  boundary: string,
  opts: { maxBytes: number; fileFields: string[]; textFields: string[]; maxTextFieldBytes?: number; maxFileBytes?: number },
): Promise<ParsedFields> {
  return new Promise((resolve) => {
    let settled = false;
    let totalBytes = 0;
    const maxTextFieldBytes = opts.maxTextFieldBytes ?? MAX_TEXT_FIELD_BYTES;
    let active: { kind: 'file' | 'text' | 'skip'; field: string; filename: string; contentType: string; chunks: Buffer[]; size: number } | null = null;
    const files: ParsedFile[] = [];
    const fields: Record<string, string> = {};
    const truncated: string[] = [];

    const finish = (result: ParsedFields): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onReqError);
      resolve(result);
    };

    const parser = new MultipartParser(boundary, {
      onPartStart(part) {
        const field = fieldName(part.name);
        const kind = opts.fileFields.includes(field) ? 'file' : opts.textFields.includes(field) ? 'text' : 'skip';
        active = { kind, field, filename: part.filename || 'upload.bin', contentType: part.contentType, chunks: [], size: 0 };
      },
      onPartData(chunk) {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > opts.maxBytes) {
          finish({ tooLarge: true, truncated, error: null, files: [], fields: {} });
          (req as any).destroy?.();
          return;
        }
        if (!active || active.kind === 'skip') return;
        if (active.kind === 'text') {
          active.size += chunk.length;
          if (active.size > maxTextFieldBytes) {
            // Keep only the budget (so memory stays bounded) but remember that this field
            // arrived incomplete — the caller decides between truncation and a refusal.
            if (!truncated.includes(active.field)) truncated.push(active.field);
            const room = maxTextFieldBytes - (active.size - chunk.length);
            if (room > 0) active.chunks.push(chunk.subarray(0, room));
            return;
          }
          active.chunks.push(chunk);
          return;
        }
        active.size += chunk.length;
        if (opts.maxFileBytes !== undefined && active.size > opts.maxFileBytes) {
          // Per-file cap, enforced here rather than after `onEnd`: a post-hoc check has already
          // buffered the whole upload (up to `maxBytes`) before refusing it.
          finish({ tooLarge: true, tooLargeField: active.field, truncated, error: null, files: [], fields: {} });
          (req as any).destroy?.();
          return;
        }
        active.chunks.push(chunk);
      },
      onPartEnd() {
        if (!active) return;
        if (active.kind === 'file') files.push({ field: active.field, filename: active.filename, contentType: active.contentType, bytes: Buffer.concat(active.chunks) });
        else if (active.kind === 'text') fields[active.field] = Buffer.concat(active.chunks).toString('utf8').trim();
        active = null;
      },
    });

    function onData(chunk: Buffer): void {
      if (settled) return;
      parser.write(chunk);
      if (parser.error) finish({ tooLarge: false, truncated, error: new MalformedMultipartError(parser.error.message), files: [], fields: {} });
    }
    function onEnd(): void {
      if (settled) return;
      if (!parser.done) { finish({ tooLarge: false, truncated, error: new MalformedMultipartError('Unexpected end of multipart body'), files: [], fields: {} }); return; }
      finish({ tooLarge: false, truncated, error: null, files, fields });
    }
    function onReqError(err: Error): void { finish({ tooLarge: false, truncated, error: err, files: [], fields: {} }); }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onReqError);
  });
}
