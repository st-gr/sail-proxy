// Extractor registry for file_search ingestion: turns an uploaded file's raw
// bytes into plain text, dispatching on the file's extension. This is the
// only place in the ingestion pipeline that touches untrusted document
// bytes directly, so every branch here treats `filename` and `bytes` as
// hostile input — see runners.ts for the process-safety guarantees the
// pandoc/pdftotext branches rely on.

import { getFileSearchConfig } from '../../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { runExtractor } from './runners';
import { ocrPdfPages, type PdfOcrOptions } from './pdfOcr';
import { transcribePdfPages, type PdfVisionOptions } from '../visionTranscriber';
import { htmlToStructuredText, tidyPandocMarkdown } from './htmlText';
import { OfficeFormat, readOfficeOffThread } from './ooxml/ooxmlThread';
import { isLegacyDocEnabled, readLegacyDoc } from './legacyDoc';
import type { StructuredFormat } from '../structureScanner';

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

/** A .doc where this gateway does not read them: FILE_SEARCH_DOC=off (always in the npm standalone
 *  CLI) or no antiword on PATH (legacyDoc.ts). Permanent, and an UnsupportedFileTypeError, so a
 *  re-extract queues the file again once .doc is read here (reextract.ts). */
export class LegacyDocUnsupportedError extends UnsupportedFileTypeError {
  constructor() {
    super('doc');
    this.message = 'legacy .doc files are not supported on this deployment';
  }
}

export interface ExtractOptions {
  /** Overrides FileSearchConfig.ingestion.extractTimeoutMs for this call. */
  timeoutMs?: number;
  /** PDF only: OCR of pages without a text layer — the ingestion's memo, the blob's sha256 and
   *  the deadline the OCR budget is taken from (pdfOcr.ts). */
  ocr?: PdfOcrOptions;
  /** PDF only: vision transcription of the pages the store's mode selects (visionTranscriber.ts);
   *  absent or mode 'off' = none. It runs before OCR, so a page without a text layer it did not
   *  transcribe still goes to OCR. */
  vision?: PdfVisionOptions;
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

// PowerPoint and Excel: read by the built-in reader (ooxml/) in its worker
// thread, the same in every deployment, no external tool. Both return Markdown,
// used as is by the static strategy and read as Markdown by the structure
// strategy. A broken, hostile or over-limit file is a DocumentReadError (permanent).
const OOXML_FORMATS: ReadonlySet<string> = new Set<OfficeFormat>(['pptx', 'xlsx']);

// Legacy Word (.doc, Word 97–2003): pandoc cannot read it; antiword does, where it is installed
// and not switched off (legacyDoc.ts). `.ppt` and `.xls` stay refused.
const LEGACY_DOC_EXTENSION = 'doc';

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

// Formats whose extracted text ends every page (slide) with one form feed, so
// their chunks carry page numbers (pages.ts). Every other format's chunks have
// none, whatever form feeds a file of it may hold.
const PAGED_EXTENSIONS = new Set(['pdf', 'pptx']);

/** Whether `filename`'s extracted text marks its pages with form feeds (both extractText and extractStructuredText). */
export function isPagedFile(filename: string): boolean {
  return PAGED_EXTENSIONS.has(extensionOfFilename(filename));
}

/** Whether `filename` is read as a PDF (pdftotext; the only format vision transcribes). */
export function isPdfFile(filename: string): boolean {
  return PDFTOTEXT_EXTENSIONS.has(extensionOfFilename(filename));
}

/**
 * The version of what this build's extractors make of a file, stamped on every file it reads
 * (vector_store_files.extraction_version; NULL = read before the stamp existed, version 0). Raise it
 * when a format is read better, and name the format in READ_BETTER_SINCE: the files of that format
 * read with an older version are then what a re-extract (reextract.ts) reads again.
 */
export const EXTRACTION_VERSION = 1;

/** Per version, the formats it reads better than the version before. 1 (W3): PDF — OCR of pages
 *  without text, page numbers, vision. PowerPoint and Excel were refused before, so no completed
 *  file of theirs was read with an older version (their failed files are retried instead). */
const READ_BETTER_SINCE: ReadonlyArray<readonly [number, (filename: string) => boolean]> = [
  [1, isPdfFile],
];

/** Whether a completed file read with `version` (null = 0) would be read better now. */
export function readBetterNow(filename: string, version: number | null): boolean {
  const from = typeof version === 'number' && Number.isInteger(version) ? version : 0;
  return READ_BETTER_SINCE.some(([since, format]) => since > from && since <= EXTRACTION_VERSION && format(filename));
}

/**
 * Whether a re-extract reads a completed file again: its format is read better since its version
 * (readBetterNow), or its read left pages without text because OCR could not run there
 * (`ocrPending`) and OCR runs on this gateway now (`ocrEnabled`, ocrAvailability.ts isOcrEnabled).
 */
export function readAgain(filename: string, version: number | null, ocrPending: boolean | null, ocrEnabled: boolean): boolean {
  return readBetterNow(filename, version) || (ocrPending === true && ocrEnabled);
}

/** Whether a file named `filename` is of a format this build reads (a name without an extension is not). */
export function isSupportedFilename(filename: string): boolean {
  const ext = extensionOfFilename(filename);
  return ext !== '' && isSupportedExtension(ext);
}

export function isSupportedExtension(ext: string): boolean {
  const norm = normalizeExtension(ext);
  return DIRECT_EXTENSIONS.has(norm) || PANDOC_READERS.has(norm) || PDFTOTEXT_EXTENSIONS.has(norm) || OOXML_FORMATS.has(norm)
    || (norm === LEGACY_DOC_EXTENSION && isLegacyDocEnabled());
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

async function readDoc(filename: string, bytes: Buffer, timeoutMs: number): Promise<string> {
  if (!isLegacyDocEnabled()) throw new LegacyDocUnsupportedError();
  try {
    return await readLegacyDoc(bytes, { timeoutMs });
  } catch (error: any) {
    logger.error('FileSearchExtractor', `antiword extraction failed for .doc file "${filename}"`, error);
    throw error;
  }
}

async function readOoxml(format: OfficeFormat, filename: string, bytes: Buffer, timeoutMs: number): Promise<string> {
  try {
    return await readOfficeOffThread(format, bytes, { timeoutMs });
  } catch (error: any) {
    logger.error('FileSearchExtractor', `.${format} extraction failed for file "${filename}"`, error);
    throw error;
  }
}

/**
 * Extract plain text from an uploaded file's bytes. Dispatches by the
 * filename's extension into one of five runners: a direct in-process
 * decode for source/plain-text formats, pandoc (via stdin, no temp file) for
 * container document formats, pdftotext (also via stdin — poppler
 * accepts "-" as a stdin/stdout placeholder, so no temp file is needed here
 * either) for PDF, the built-in reader (ooxml/, in a worker thread, no temp
 * file) for PowerPoint and Excel, and antiword (a private temp file: it seeks
 * in its input) for legacy Word .doc where it is available (legacyDoc.ts).
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
    let text: string;
    try {
      // "-" for both input and output tells pdftotext to read/write via
      // stdin/stdout instead of a filesystem path.
      text = await runExtractor('pdftotext', ['-', '-'], bytes, { timeoutMs });
    } catch (error: any) {
      logger.error('FileSearchExtractor', `pdftotext extraction failed for file "${filename}"`, error);
      throw error;
    }
    // Opt-in per store: pages the vision model transcribes, in place (never throws; off = no call).
    const vision = opts.vision ? await transcribePdfPages(text, bytes, opts.vision) : { text, transcribed: [] };
    // Pages without a text layer (scans) read by OCR, in place — except those vision wrote; a PDF
    // with text on every page is returned as pdftotext gave it. Never throws.
    return ocrPdfPages(vision.text, bytes, { ...opts.ocr, keepPages: vision.transcribed });
  }

  if (OOXML_FORMATS.has(ext)) return readOoxml(ext as OfficeFormat, filename, bytes, timeoutMs);

  if (ext === LEGACY_DOC_EXTENSION) return readDoc(filename, bytes, timeoutMs);

  throw new UnsupportedFileTypeError(ext);
}

export interface StructuredExtraction {
  text: string;
  /** How the `structure` chunker reads `text` (chunkStructured's `format`). */
  format: StructuredFormat;
}

/**
 * Extraction for the `structure` chunking strategy; `static` keeps using
 * extractText, whose output is unchanged. Differences, all to keep structure:
 * - .md: the text as is (same as extractText), read as Markdown;
 * - docx/odt/epub/rst: pandoc writes GitHub-flavoured Markdown
 *   (`-t gfm --wrap=none`: `#` headings, pipe tables, fenced code, no
 *   re-wrapped lines) instead of plain text, minus its empty anchors and
 *   wrapper <div> lines; tables pandoc cannot draw as pipe tables stay HTML;
 * - .html: tags stripped, headings and <pre> kept as Markdown (htmlText.ts)
 *   instead of the raw markup;
 * - .pdf: the same pdftotext output (with OCR text on pages without a text
 *   layer), read as pages (form feeds) and paragraphs — it carries no heading
 *   markers;
 * - .pptx/.xlsx: the built-in reader's Markdown (the same text as extractText),
 *   read as Markdown: a section per slide (its notes a sub-section) or sheet;
 * - .doc: antiword's text (the same as extractText), read as blank-line blocks;
 * - every other direct format (txt, code, json, …): the text as is, read as
 *   blank-line blocks with no headings.
 *
 * @throws UnsupportedFileTypeError if the extension isn't in the allowlist.
 */
export async function extractStructuredText(
  filename: string,
  bytes: Buffer,
  opts: ExtractOptions = {}
): Promise<StructuredExtraction> {
  const ext = extensionOfFilename(filename);
  const timeoutMs = opts.timeoutMs ?? getFileSearchConfig().ingestion.extractTimeoutMs;

  if (DIRECT_EXTENSIONS.has(ext)) {
    const text = decodeDirectText(bytes);
    if (ext === 'md') return { text, format: 'markdown' };
    if (ext === 'html') return { text: htmlToStructuredText(text), format: 'markdown' };
    return { text, format: 'plain' };
  }

  const pandocReader = PANDOC_READERS.get(ext);
  if (pandocReader !== undefined) {
    try {
      const text = await runExtractor('pandoc', ['-f', pandocReader, '-t', 'gfm', '--wrap=none'], bytes, { timeoutMs });
      return { text: tidyPandocMarkdown(text), format: 'markdown' };
    } catch (error: any) {
      logger.error('FileSearchExtractor', `pandoc extraction failed for .${ext} file "${filename}"`, error);
      throw error;
    }
  }

  if (PDFTOTEXT_EXTENSIONS.has(ext)) {
    return { text: await extractText(filename, bytes, opts), format: 'pdf' };
  }

  if (OOXML_FORMATS.has(ext)) {
    return { text: await readOoxml(ext as OfficeFormat, filename, bytes, timeoutMs), format: 'markdown' };
  }

  if (ext === LEGACY_DOC_EXTENSION) return { text: await readDoc(filename, bytes, timeoutMs), format: 'plain' };

  throw new UnsupportedFileTypeError(ext);
}
