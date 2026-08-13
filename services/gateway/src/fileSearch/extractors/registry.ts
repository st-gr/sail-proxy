// Extractor registry for file_search ingestion: turns an uploaded file's raw
// bytes into plain text, dispatching on the file's extension. This is the
// only place in the ingestion pipeline that touches untrusted document
// bytes directly, so every branch here treats `filename` and `bytes` as
// hostile input — see runners.ts for the process-safety guarantees the
// pandoc/pdftotext branches rely on.

import { getFileSearchConfig } from '../../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { runExtractor } from './runners';

const logger = getDefaultLogger();

// Bounds how much of a caller-supplied extension we ever echo back — into a
// thrown Error's message, which downstream can reach both a log line
// (logger.error) and an API error body. Without a cap, an attacker-chosen
// "extension" (there is no real length limit on a filename) becomes a
// log-injection / response-bloat vector: a 5000-character value, or one
// containing newlines/control characters, gets reflected verbatim.
const MAX_ECHOED_EXT_LENGTH = 64;

/**
 * Render an extension for safe display in an error message / log line:
 * strip control characters (in particular newlines, which could otherwise
 * forge extra log lines), then truncate. Applied only at the point of
 * display — normalizeExtension's output is still used unmodified for the
 * actual allowlist lookup.
 */
function sanitizeExtensionForDisplay(ext: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = ext.replace(/[\x00-\x1f\x7f]/g, '');
  const truncated =
    stripped.length > MAX_ECHOED_EXT_LENGTH ? `${stripped.slice(0, MAX_ECHOED_EXT_LENGTH)}…` : stripped;
  return truncated === '' ? '(none)' : truncated;
}

// The raw extension is deliberately not retained on the instance (no public
// property, readable or otherwise): it's caller-controlled, unbounded, and
// can carry control characters. Only the sanitized form ever gets echoed —
// via sanitizeExtensionForDisplay, into `.message` — so nothing downstream
// (e.g. a future `logger.error(..., err.ext)`) can reopen the log-injection
// path that sanitizing the message closed. Nothing in this codebase reads a
// raw or sanitized extension off a thrown UnsupportedFileTypeError today
// (grep for `.ext` before adding one back), so no replacement property is
// exposed either.
export class UnsupportedFileTypeError extends Error {
  constructor(ext: string) {
    const display = sanitizeExtensionForDisplay(ext);
    // An empty ext means "no extension at all" (a dot-less filename, or one
    // ending in a bare trailing dot) — name that case explicitly rather than
    // rendering the slightly nonsensical "Unsupported file type: .(none)".
    const typeDescription = display === '(none)' ? 'no file extension' : `.${display}`;
    super(
      `Unsupported file type: ${typeDescription}. Supported types are listed in the file_search documentation.`
    );
    this.name = 'UnsupportedFileTypeError';
  }
}

export interface ExtractOptions {
  /** Overrides FileSearchConfig.ingestion.extractTimeoutMs for this call. */
  timeoutMs?: number;
}

// Source-code, config, and plain-markup formats: the raw bytes (once decoded
// to text) *are* the desired output. Deliberately excludes rst even though
// it is plain text too — see PANDOC_READERS below for why that one goes
// through pandoc instead.
const DIRECT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'py', 'js', 'ts', 'c', 'cpp', 'cs', 'go', 'java',
  'php', 'rb', 'sh', 'css', 'html', 'tex',
]);

// Binary/container document formats that need a real parser. Each maps to
// the pandoc "reader" name passed via -f, since we feed pandoc anonymous
// bytes on stdin (no filename for it to sniff a format from) — the reader
// must be named explicitly rather than left to autodetection.
//
// A Map, not a plain object: a plain-object lookup (`ext in obj` /
// `obj[ext]`) walks the prototype chain, so an attacker-supplied extension
// of "constructor" or "__proto__" resolves to Object's own `constructor`/
// `__proto__` and is treated as a supported extension — `obj[ext]` then
// hands something like the Object constructor's stringified form into
// pandoc's argv instead of a real reader name. Map.has()/Map.get() only ever
// consult the Map's own entries.
const PANDOC_READERS: ReadonlyMap<string, string> = new Map([
  ['docx', 'docx'],
  ['odt', 'odt'],
  ['epub', 'epub'],
  ['rst', 'rst'],
]);

const PDFTOTEXT_EXTENSIONS = new Set(['pdf']);

// .pptx and .doc are deliberate, documented gaps: pandoc cannot read either
// format, so routing them to the pandoc runner would fail anyway, just with
// a worse error. Reject them explicitly and by name instead.

/**
 * Normalise a raw extension or filename fragment for lookup: lowercase, no
 * leading dot, and — for a filename with multiple dots — only the final
 * segment, so "archive.tar.gz" is treated as a ".gz" (unsupported), not a
 * ".tar.gz" or a ".tar". Callers that already know they have a bare
 * extension (e.g. isSupportedExtension's public API, per its own tests)
 * use this directly; extractText goes through extensionOfFilename instead
 * — see its doc comment for why a dot-less *filename* needs different
 * handling than a dot-less *extension argument*.
 */
function normalizeExtension(raw: string): string {
  const trimmed = (raw || '').trim().toLowerCase();
  const withoutDot = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
  const segments = withoutDot.split('.');
  return segments[segments.length - 1];
}

/**
 * Extract the normalized extension from a *filename*, or '' if the filename
 * has no dot at all — e.g. "README" or a file literally named "pdf" with no
 * extension. Without this distinction, normalizeExtension("pdf") would
 * return "pdf" (since split('.') on a dot-less string just returns the
 * whole string), and a dot-less file named "pdf" would get dispatched to
 * the pdftotext runner as if ".pdf" had been supplied. '' is also what a
 * trailing-dot filename ("notes.") normalizes to, and is never a member of
 * any extension set, so it always falls through to
 * UnsupportedFileTypeError.
 */
function extensionOfFilename(filename: string): string {
  const trimmed = (filename || '').trim();
  if (!trimmed.includes('.')) return '';
  return normalizeExtension(trimmed);
}

export function isSupportedExtension(ext: string): boolean {
  const norm = normalizeExtension(ext);
  return DIRECT_EXTENSIONS.has(norm) || PANDOC_READERS.has(norm) || PDFTOTEXT_EXTENSIONS.has(norm);
}

const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/**
 * Decode raw bytes for the direct-read path, accepting only utf-8, utf-16
 * (LE/BE, detected via BOM), and ascii (a strict subset of utf-8 — no
 * separate branch needed). TextDecoder's `fatal: true` mode is what actually
 * enforces this: unlike Buffer#toString('utf8'), which silently substitutes
 * U+FFFD for invalid sequences, `fatal` decoding throws, so a mis-encoded or
 * binary file surfaces as a rejected extractText() call instead of a
 * corrupted chunk silently entering the index. Detection is BOM-based only
 * (no byte-frequency heuristics for BOM-less UTF-16): that's the only
 * unambiguous signal available without also risking false positives on
 * legitimate UTF-8 text that happens to contain byte pairs resembling
 * UTF-16.
 */
function decodeDirectText(bytes: Buffer): string {
  try {
    if (bytes.subarray(0, 2).equals(UTF16LE_BOM)) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    }
    if (bytes.subarray(0, 2).equals(UTF16BE_BOM)) {
      return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error: any) {
    throw new Error(
      `Could not decode file as a supported text encoding (utf-8, utf-16, or ascii): ${error.message}`
    );
  }
}

/**
 * Extract plain text from an uploaded file's bytes. Dispatches by the
 * filename's extension into one of three runners: a direct in-process
 * decode for source/plain-text formats, pandoc (via stdin, no temp file) for
 * container document formats, and pdftotext (also via stdin — poppler
 * accepts "-" as a stdin/stdout placeholder, so no temp file is needed here
 * either) for PDF.
 *
 * @throws UnsupportedFileTypeError if the extension isn't in the allowlist.
 */
export async function extractText(filename: string, bytes: Buffer, opts: ExtractOptions = {}): Promise<string> {
  const ext = extensionOfFilename(filename);
  const timeoutMs = opts.timeoutMs ?? getFileSearchConfig().ingestion.extractTimeoutMs;

  if (DIRECT_EXTENSIONS.has(ext)) {
    return decodeDirectText(bytes);
  }

  const pandocReader = PANDOC_READERS.get(ext);
  if (pandocReader !== undefined) {
    try {
      return await runExtractor('pandoc', ['-f', pandocReader, '-t', 'plain'], bytes, { timeoutMs });
    } catch (error: any) {
      logger.error('FileSearchExtractor', `pandoc extraction failed for .${ext} file "${filename}"`, error);
      throw error;
    }
  }

  if (PDFTOTEXT_EXTENSIONS.has(ext)) {
    try {
      // "-" for both input and output tells pdftotext to read/write via
      // stdin/stdout instead of a filesystem path.
      return await runExtractor('pdftotext', ['-', '-'], bytes, { timeoutMs });
    } catch (error: any) {
      logger.error('FileSearchExtractor', `pdftotext extraction failed for file "${filename}"`, error);
      throw error;
    }
  }

  throw new UnsupportedFileTypeError(ext);
}
