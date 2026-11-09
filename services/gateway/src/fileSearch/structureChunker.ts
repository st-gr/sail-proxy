// The `structure` chunking strategy: chunks follow the document's sections
// (headings in Markdown, pages in PDF text) instead of fixed word windows.
// Pure, no I/O. `static` chunking (chunker.ts) is a separate path and unchanged.
//
// Contract, relied on by parent-section assembly (parents are rebuilt from the
// chunks alone; the extracted text is not stored):
// - every chunk's text is text.slice(sectionStart + sectionOffset, … + text.length),
//   an exact substring of its section, newlines and all;
// - the chunks of one section, in order, start at offset 0, never leave a gap
//   (they may overlap) and end at the section's end, so joining them by
//   sectionOffset reproduces the section exactly;
// - offsets are JS string (UTF-16) offsets;
// - a section is the text from its heading line to the next heading (or page),
//   trimmed of surrounding whitespace — only whitespace lies between sections.

import { countTokens as countCl100kTokens } from 'gpt-tokenizer/cjs/encoding/cl100k_base';
import {
  blockStarts, closesFence, fenceOpening, joinHeadingPath, Line, sectionsOf, splitLines, StructuredFormat,
} from './structureScanner';

export type { StructuredFormat } from './structureScanner';

export interface StructuredChunkOptions {
  /** Upper bound of a chunk in cl100k_base tokens. */
  maxTokens: number;
  /** Tokens repeated between consecutive chunks of one section (never across sections). */
  overlapTokens: number;
  format: StructuredFormat;
  /** Sections below this many tokens merge forward into the next one. Default 100. */
  minSectionTokens?: number;
}

export interface StructuredChunk {
  text: string;
  /** Ordinal of the chunk's section within the file, from 0. */
  section: number;
  /** Offset of the chunk's first character within its section (UTF-16 units). */
  sectionOffset: number;
  /** Heading chain, e.g. "Install > Docker > Ports"; null when there is none. */
  headingPath: string | null;
  /** cl100k_base token count of `text` (see countTokens). */
  tokens: number;
  /**
   * For a chunk that starts inside a Markdown table after its header: the
   * table's header and delimiter rows, which are not in `text`. Absent otherwise.
   */
  tableHeader?: string;
}

export interface StructuredSection {
  start: number;
  end: number;
  headings: string[];
  headingPath: string | null;
  tokens: number;
}

const DEFAULT_MIN_SECTION_TOKENS = 100;
// Document text is data: a literal "<|endoftext|>" is counted as ordinary text
// rather than rejected (gpt-tokenizer throws on special tokens by default).
const AS_PLAIN_TEXT = { disallowedSpecial: new Set<string>() };

// gpt-tokenizer's BPE is quadratic in the length of one pre-token, and a run
// of letters (no spaces/digits), of one symbol or emoji, or of whitespace is a
// single pre-token: 100k letters took seconds. Runs longer than this are cut
// into pieces of this length before counting (a pre-token never spans a
// whitespace/non-whitespace change), which bounds the cost per character.
// Text without such runs is counted exactly.
const LONG_RUN_CHARS = 256;

function isWhitespaceCode(c: number): boolean {
  return (c >= 9 && c <= 13) || c === 32 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

/**
 * Token count with the tokenizer of the text-embedding-3 models (cl100k_base),
 * the same gpt-tokenizer package the gateway's token counting uses. Exact
 * unless the text has a run of more than LONG_RUN_CHARS whitespace or
 * non-whitespace characters, which is counted in LONG_RUN_CHARS pieces (an
 * estimate within a few tokens per piece, in linear time).
 */
export function countTokens(text: string): number {
  if (text === '') return 0;
  let total = 0;
  let segmentStart = 0;
  let runStart = 0;
  let runIsWhitespace = isWhitespaceCode(text.charCodeAt(0));
  for (let i = 1; i < text.length; i += 1) {
    const ws = isWhitespaceCode(text.charCodeAt(i));
    if (ws !== runIsWhitespace) {
      runIsWhitespace = ws;
      runStart = i;
    } else if (i - runStart >= LONG_RUN_CHARS && !isLowSurrogate(text.charCodeAt(i))) {
      total += countCl100kTokens(text.slice(segmentStart, i), AS_PLAIN_TEXT);
      segmentStart = i;
      runStart = i;
    }
  }
  return total + countCl100kTokens(text.slice(segmentStart), AS_PLAIN_TEXT);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// A code point is at most 4 UTF-8 bytes, so at most 4 byte-level tokens; the
// sub-line pieces are maxTokens/4, so 16 guarantees one code point always
// fits. The API's own floor (100, chunker.ts) is far above it.
const MAX_CODE_POINT_TOKENS = 4;
const MIN_MAX_TOKENS = 4 * MAX_CODE_POINT_TOKENS;
// Upper bound of one sub-line window in characters, whatever the token count.
const MAX_WINDOW_CHARS = 32768;
// A table header longer than this is not repeated on continuation chunks.
const MAX_TABLE_HEADER_CHARS = 1000;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function validate(opts: StructuredChunkOptions): void {
  const { maxTokens, overlapTokens } = opts;
  if (!Number.isInteger(maxTokens) || maxTokens < MIN_MAX_TOKENS) {
    throw new Error(`maxTokens must be an integer of at least ${MIN_MAX_TOKENS}, got ${maxTokens}`);
  }
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error(`overlapTokens must be an integer in [0, maxTokens), got ${overlapTokens}`);
  }
}

/** True when `prefix` is the start of `chain` (heading by heading). */
function isChainPrefix(prefix: string[], chain: string[]): boolean {
  return prefix.length <= chain.length && prefix.every((h, i) => h === chain[i]);
}

function commonChain(a: string[], b: string[]): string[] {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return a.slice(0, n);
}

/**
 * The sections chunkStructured cuts, in order, after merging: a section under
 * minSectionTokens (a heading with little or no body) merges forward into the
 * next, and the merged section spans both. Its heading chain is the next
 * section's when the small one's own chain leads into it (a heading-only
 * parent before its first child), otherwise the chains' common prefix
 * (siblings share only their parent; null if nothing is shared). Once a
 * merged section holds a common prefix, every further merge into it takes the
 * common prefix too. Merging stops once the
 * merged section reaches minSectionTokens, so it adds less than that to the
 * receiving section. A small last section has nothing to merge into and stays
 * on its own.
 */
export function structuredSections(text: string, opts: StructuredChunkOptions): StructuredSection[] {
  validate(opts);
  const minTokens = opts.minSectionTokens ?? DEFAULT_MIN_SECTION_TOKENS;
  const merged: StructuredSection[] = [];
  let current: StructuredSection | null = null;
  // True once `current` holds a common prefix rather than one section's own
  // chain: an empty or parent-only prefix must not then "lead into" whatever
  // section comes next.
  let currentIsPrefix = false;
  for (const span of sectionsOf(text, opts.format)) {
    const next: StructuredSection = { ...span, tokens: countTokens(text.slice(span.start, span.end)) };
    if (current && current.tokens < minTokens) {
      const leadsIn: boolean = !currentIsPrefix && isChainPrefix(current.headings, next.headings);
      const headings: string[] = leadsIn ? next.headings : commonChain(current.headings, next.headings);
      currentIsPrefix = !leadsIn;
      current = {
        start: current.start,
        end: next.end,
        headings,
        headingPath: joinHeadingPath(headings),
        // Summed rather than recounted: the gap between them is whitespace.
        tokens: current.tokens + countTokens(text.slice(current.end, next.start)) + next.tokens,
      };
      continue;
    }
    if (current) merged.push(current);
    current = next;
    currentIsPrefix = false;
  }
  if (current) merged.push(current);
  return merged;
}

interface Piece {
  start: number;
  end: number;
  tokens: number;
  tableHeader?: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** A cut at or before `c` that does not separate a surrogate pair. */
function codePointBoundary(text: string, c: number, floor: number): number {
  if (c > floor + 1 && isHighSurrogate(text.charCodeAt(c - 1))) return c - 1;
  return c;
}

/**
 * Cut [start, end) — a single line too long for one chunk — into pieces of at
 * most `target` tokens: a window sized from the observed characters per token
 * (each count covers about one piece, so a long line costs a few passes, not a
 * pass per piece), cut after its last sentence end, else after its last
 * whitespace, else inside a word but never inside a surrogate pair.
 */
function splitLongLine(text: string, start: number, end: number, target: number): Piece[] {
  const pieces: Piece[] = [];
  let pos = start;
  let length = Math.min(target * 4, MAX_WINDOW_CHARS);
  while (pos < end) {
    let cut = Math.min(end, pos + length);
    let tokens = countTokens(text.slice(pos, cut));
    // Grow while the window is far below the target (very compressible text),
    // never beyond MAX_WINDOW_CHARS.
    while (cut < end && tokens <= target / 2 && cut - pos < MAX_WINDOW_CHARS) {
      cut = Math.min(end, pos + Math.min((cut - pos) * 2, MAX_WINDOW_CHARS));
      tokens = countTokens(text.slice(pos, cut));
    }
    // Shrink in proportion until it fits; at worst one code point remains.
    const oneCodePoint = pos + (isHighSurrogate(text.charCodeAt(pos)) && pos + 2 <= end ? 2 : 1);
    while (tokens > target && cut > oneCodePoint) {
      const shorter = Math.floor(((cut - pos) * target * 0.9) / tokens);
      cut = Math.max(oneCodePoint, codePointBoundary(text, pos + Math.min(shorter, cut - pos - 1), pos));
      tokens = countTokens(text.slice(pos, cut));
    }
    cut = Math.max(oneCodePoint, codePointBoundary(text, cut, pos));
    length = cut - pos;
    if (cut < end) {
      // Pieces only set the packing granularity, so a short piece ending at a
      // sentence is better than a full one ending mid-sentence.
      const window = text.slice(pos, cut);
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
      const space = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
      const preferred = sentence > 0 ? sentence + 2 : space > 0 ? space + 1 : -1;
      if (preferred > 0 && countTokens(window.slice(0, preferred)) <= target) cut = pos + preferred;
    }
    tokens = countTokens(text.slice(pos, cut));
    pieces.push({ start: pos, end: cut, tokens });
    pos = cut;
  }
  return pieces;
}

/**
 * Pieces tiling [start, end): blocks (paragraph, list, table, fenced code) that
 * fit maxTokens stay whole; larger blocks fall apart into lines, and lines too
 * long for a chunk into sub-line pieces small enough for overlap to work.
 */
function piecesOf(text: string, start: number, end: number, opts: StructuredChunkOptions): Piece[] {
  const pieces: Piece[] = [];
  const starts = blockStarts(text, start, end, opts.format);
  starts.forEach((blockStart, k) => {
    const blockEnd = k + 1 < starts.length ? starts[k + 1] : end;
    const tokens = countTokens(text.slice(blockStart, blockEnd));
    if (tokens <= opts.maxTokens) {
      pieces.push({ start: blockStart, end: blockEnd, tokens });
      return;
    }
    const lines = splitLines(text, blockStart, blockEnd);
    const headers = opts.format === 'markdown' ? tableHeaders(text, lines) : [];
    lines.forEach((line, i) => {
      const tableHeader = headers[i];
      const lineTokens = countTokens(text.slice(line.start, line.next));
      if (lineTokens <= opts.maxTokens) {
        pieces.push({ start: line.start, end: line.next, tokens: lineTokens, tableHeader });
      } else {
        const target = Math.max(1, Math.floor(opts.maxTokens / 4));
        for (const p of splitLongLine(text, line.start, line.next, target)) pieces.push({ ...p, tableHeader });
      }
    });
  });
  return pieces;
}

/**
 * Per line: the header of the pipe table the line is a body row of (header
 * row + delimiter row, both containing '|'), else undefined. A row is a line
 * containing '|'; the table ends at the first line without one. Lines in
 * fenced code are never table rows.
 */
function tableHeaders(text: string, lines: Line[]): Array<string | undefined> {
  const out: Array<string | undefined> = new Array(lines.length).fill(undefined);
  let header: string | undefined;
  let inTable = false;
  const content = (l: Line): string => text.slice(l.start, Math.min(l.end, l.start + MAX_TABLE_HEADER_CHARS + 1));
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const row = content(lines[i]);
    // Nothing inside fenced code is a table.
    if (fence !== null) {
      if (closesFence(row, fence)) fence = null;
      continue;
    }
    const opening = fenceOpening(row);
    if (opening !== null) {
      fence = opening;
      inTable = false;
      continue;
    }
    if (inTable && row.includes('|')) {
      out[i] = header;
      continue;
    }
    inTable = false;
    const next = i + 1 < lines.length ? content(lines[i + 1]) : '';
    if (row.includes('|') && next.includes('|') && next.length <= MAX_TABLE_HEADER_CHARS && TABLE_DELIMITER.test(next)) {
      const span = text.slice(lines[i].start, lines[i + 1].end);
      header = span.length <= MAX_TABLE_HEADER_CHARS ? span : undefined;
      inTable = true;
      i += 1; // the delimiter row
    }
  }
  return out;
}

/** Chunk one section; every returned piece is a [start, end) range inside it. */
function chunkSection(text: string, section: StructuredSection, opts: StructuredChunkOptions): Piece[] {
  if (section.tokens <= opts.maxTokens) {
    // A merged section's count is a sum; the chunk carries the exact count.
    const tokens = countTokens(text.slice(section.start, section.end));
    if (tokens <= opts.maxTokens) return [{ start: section.start, end: section.end, tokens }];
  }
  const pieces = piecesOf(text, section.start, section.end, opts);
  const chunks: Piece[] = [];
  let first = 0;
  let previousLast = -1;
  for (;;) {
    let last = first;
    let sum = pieces[first].tokens;
    while (last + 1 < pieces.length && sum + pieces[last + 1].tokens <= opts.maxTokens) {
      last += 1;
      sum += pieces[last].tokens;
    }
    // Piece counts are exact, but their sum only estimates the joined text's
    // count — far above it for blank lines, which tokenize together (one run:
    // 785 tokens joined, 1,523 summed). The window is therefore settled on the
    // exact count of the joined text, the same measure the whitespace check
    // below uses: extend while the joined text still fits (galloping, then
    // bisecting), and if it is over, drop pieces from the end while the chunk
    // still reaches past the previous one, then repeated (overlap) pieces from
    // the front; one piece alone always fits.
    const joined = (to: number): number => countTokens(text.slice(pieces[first].start, pieces[to].end));
    let tokens = joined(last);
    if (tokens <= opts.maxTokens && last + 1 < pieces.length) {
      let lo = last;
      let hi = pieces.length;
      for (let step = 1; ; step *= 2) {
        const probe = Math.min(lo + step, pieces.length - 1);
        const t = joined(probe);
        if (t > opts.maxTokens) {
          hi = probe;
          break;
        }
        lo = probe;
        tokens = t;
        if (probe === pieces.length - 1) break;
      }
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const t = joined(mid);
        if (t <= opts.maxTokens) {
          lo = mid;
          tokens = t;
        } else {
          hi = mid;
        }
      }
      last = lo;
    }
    while (tokens > opts.maxTokens) {
      if (last > Math.max(first, previousLast + 1)) last -= 1;
      else first += 1;
      tokens = joined(last);
    }
    // Whitespace alone, beside a next piece too big to join it: cut that piece
    // finer so its head fills the room, and pack this window again (the exact
    // re-pack decides whether the head fits; a piece that cannot be cut finer
    // ends the attempt). A chunk of only whitespace is left only where the
    // window cannot take even the next code point.
    const room = opts.maxTokens - tokens;
    if (
      last + 1 < pieces.length &&
      room >= 1 &&
      !/\S/.test(text.slice(pieces[first].start, pieces[last].end)) &&
      /\S/.test(text.slice(pieces[last + 1].start, pieces[last + 1].end))
    ) {
      const y = pieces[last + 1];
      const finer = splitLongLine(text, y.start, y.end, room);
      if (finer.length > 1) {
        // The sub-pieces lie inside y, so they are body rows of y's table (if
        // any) and y's header is still the one above them.
        pieces.splice(last + 1, 1, ...finer.map((p) => ({ ...p, tableHeader: y.tableHeader })));
        continue;
      }
    }
    chunks.push({ start: pieces[first].start, end: pieces[last].end, tokens, tableHeader: pieces[first].tableHeader });
    previousLast = last;
    if (last === pieces.length - 1) return chunks;
    // The next chunk repeats whole trailing pieces of this one, up to the
    // overlap, as long as the first new piece still fits beside them; it
    // always starts after this chunk's start and ends after its end.
    const nextPiece = pieces[last + 1].tokens;
    let next = last + 1;
    let overlap = 0;
    while (
      next - 1 > first &&
      overlap + pieces[next - 1].tokens <= opts.overlapTokens &&
      overlap + pieces[next - 1].tokens + nextPiece <= opts.maxTokens
    ) {
      next -= 1;
      overlap += pieces[next].tokens;
    }
    // Repeating blank lines carries nothing, and a window that starts inside a
    // whitespace run can count more than the whole run: an overlap never
    // starts on a whitespace-only piece.
    while (next <= last && !/\S/.test(text.slice(pieces[next].start, pieces[next].end))) next += 1;
    first = next;
  }
}

/**
 * Chunk extracted text by its structure. Chunks come in file order (their
 * index is the chunk ord); see the module comment for the substring contract.
 */
export function chunkStructured(text: string, opts: StructuredChunkOptions): StructuredChunk[] {
  return chunkStructuredWithSections(text, opts).chunks;
}

/** chunkStructured plus the sections it cut (indexed by a chunk's `section`), whose `start`
 *  places a chunk in the document: `sections[c.section].start + c.sectionOffset`. */
export function chunkStructuredWithSections(
  text: string, opts: StructuredChunkOptions,
): { chunks: StructuredChunk[]; sections: StructuredSection[] } {
  const chunks: StructuredChunk[] = [];
  const sections = structuredSections(text, opts);
  sections.forEach((section, ordinal) => {
    for (const piece of chunkSection(text, section, opts)) {
      chunks.push({
        text: text.slice(piece.start, piece.end),
        section: ordinal,
        sectionOffset: piece.start - section.start,
        headingPath: section.headingPath,
        ...(piece.tableHeader !== undefined ? { tableHeader: piece.tableHeader } : {}),
        tokens: piece.tokens,
      });
    }
  });
  return { chunks, sections };
}
