// Line scanner behind the `structure` chunking strategy: finds a document's
// sections (heading path + character span) and, inside a section, the start
// of each block (paragraph, list, table, fenced code). Pure, no I/O.
//
// Every span is a [start, end) range of JS string (UTF-16) offsets into the
// text it was given — nothing here copies or rewrites text, so whatever the
// chunker cuts from these spans is an exact substring of the input.

export type StructuredFormat = 'markdown' | 'pdf' | 'plain';

export interface Line {
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's content (before any "\r\n" / "\n"). */
  end: number;
  /** Offset of the next line's first character (text.length on the last line). */
  next: number;
}

export interface SectionSpan {
  start: number;
  end: number;
  /** The heading chain, outermost first; empty where the format has no headings or before the first one. */
  headings: string[];
  /** headings joined with ' > ' (capped at MAX_HEADING_PATH_CHARS); null when there are none. */
  headingPath: string | null;
}

// Heading text and the joined path are stored on every chunk of a section, so
// both are capped: an unclosed or huge heading must not be copied per chunk.
export const MAX_HEADING_CHARS = 200;
export const MAX_HEADING_PATH_CHARS = 1000;

/** At most `max` UTF-16 units of `text`, never ending inside a surrogate pair. */
export function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

export function joinHeadingPath(headings: string[]): string | null {
  const path = headings.filter((h) => h !== '').join(' > ');
  return path === '' ? null : capChars(path, MAX_HEADING_PATH_CHARS);
}

/** Split into lines on "\n"; a preceding "\r" belongs to the terminator, not the content. */
export function splitLines(text: string, from = 0, to = text.length): Line[] {
  const lines: Line[] = [];
  let start = from;
  while (start < to) {
    let nl = text.indexOf('\n', start);
    if (nl === -1 || nl >= to) nl = -1;
    const next = nl === -1 ? to : nl + 1;
    let end = nl === -1 ? to : nl;
    if (end > start && text.charCodeAt(end - 1) === 13 /* \r */) end -= 1;
    lines.push({ start, end, next });
    start = next;
  }
  return lines;
}

const BLANK = /^\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
// Greedy `.*` and the closing-sequence strip in atxText keep this linear on hostile lines.
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+([\s\S]*))?$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
// Lines that start a block of their own and therefore cannot be the text of a
// setext heading: list items, block quotes, table rows, raw HTML.
const NON_PARAGRAPH = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|\||<)/;
const FRONT_MATTER_FENCE = /^---[ \t]*$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

function isBlank(text: string, line: Line): boolean {
  return BLANK.test(text.slice(line.start, line.end));
}

/** Leading spaces/tabs of a line, tabs counted as 4 (enough to tell 0–3 from 4+). */
function indentOf(content: string): number {
  let n = 0;
  for (const ch of content) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function atxText(raw: string | undefined): string {
  if (raw === undefined) return '';
  // An optional closing sequence of '#' must be preceded by a space (or be the whole text).
  const trimmed = raw.trim();
  let hashes = trimmed.length;
  while (hashes > 0 && trimmed[hashes - 1] === '#') hashes -= 1;
  if (hashes === trimmed.length) return trimmed;
  if (hashes === 0) return '';
  return /[ \t]/.test(trimmed[hashes - 1]) ? trimmed.slice(0, hashes).trim() : trimmed;
}

/** The fence marker (e.g. "```") when the line opens a fenced code block, else null. */
export function fenceOpening(content: string): string | null {
  const fence = FENCE_OPEN.exec(content);
  return fence && !(fence[1][0] === '`' && fence[2].includes('`')) ? fence[1] : null;
}

/** True when the line closes a fence opened with `marker`. */
export function closesFence(content: string, marker: string): boolean {
  const ch = marker[0] === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${ch}{${marker.length},}[ \\t]*$`).test(content);
}

/** Index of the line closing a fence opened on line `open`, or the last line if never closed. */
function fenceEnd(text: string, lines: Line[], open: number, marker: string): number {
  const ch = marker[0];
  const close = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
  for (let i = open + 1; i < lines.length; i += 1) {
    if (close.test(text.slice(lines[i].start, lines[i].end))) return i;
  }
  return lines.length - 1;
}

/** Index of the line closing a YAML front matter block at the top of the file, or -1. */
function frontMatterEnd(text: string, lines: Line[]): number {
  if (lines.length < 2 || !FRONT_MATTER_FENCE.test(text.slice(lines[0].start, lines[0].end))) return -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONT_MATTER_CLOSE.test(text.slice(lines[i].start, lines[i].end))) return i;
  }
  return -1;
}

interface Heading {
  line: number;
  level: number;
  text: string;
}

/**
 * ATX (`# x`) and setext (`x` over `===` / `---`) headings outside fenced code
 * and front matter. A setext heading starts at the first line of the paragraph
 * its underline closes.
 */
export function markdownHeadings(text: string, lines: Line[]): Heading[] {
  const headings: Heading[] = [];
  // Lines that are plain paragraph text (possible setext heading content).
  const paragraph: boolean[] = new Array(lines.length).fill(false);
  let i = frontMatterEnd(text, lines) + 1;
  while (i < lines.length) {
    const content = text.slice(lines[i].start, lines[i].end);
    const fence = FENCE_OPEN.exec(content);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      i = fenceEnd(text, lines, i, fence[1]) + 1;
      continue;
    }
    const atx = ATX.exec(content);
    if (atx) {
      headings.push({ line: i, level: atx[1].length, text: capChars(atxText(atx[2]), MAX_HEADING_CHARS) });
      i += 1;
      continue;
    }
    const underline = SETEXT_UNDERLINE.exec(content);
    if (underline && i > 0 && paragraph[i - 1]) {
      let first = i - 1;
      while (first > 0 && paragraph[first - 1]) first -= 1;
      let headingText = '';
      for (let k = first; k < i && headingText.length <= MAX_HEADING_CHARS; k += 1) {
        const part = text.slice(lines[k].start, Math.min(lines[k].end, lines[k].start + MAX_HEADING_CHARS * 2)).trim();
        headingText = headingText === '' ? part : `${headingText} ${part}`;
      }
      headingText = capChars(headingText, MAX_HEADING_CHARS).trim();
      for (let k = first; k < i; k += 1) paragraph[k] = false;
      headings.push({ line: first, level: underline[1][0] === '=' ? 1 : 2, text: headingText });
      i += 1;
      continue;
    }
    // A setext run never reaches back past a blank, a heading, a fence or a
    // list/quote/table/HTML line; a lone '---' is a thematic break.
    paragraph[i] = !BLANK.test(content) && indentOf(content) < 4 && !NON_PARAGRAPH.test(content) && !underline;
    i += 1;
  }
  return headings;
}

/** Shrink [start, end) to exclude leading and trailing whitespace; null if nothing is left. */
function trimSpan(text: string, start: number, end: number): { start: number; end: number } | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return s < e ? { start: s, end: e } : null;
}

/** Sections of a Markdown text: one per heading, plus the text before the first heading. */
export function markdownSections(text: string): SectionSpan[] {
  const lines = splitLines(text);
  const headings = markdownHeadings(text, lines);
  const sections: SectionSpan[] = [];
  const push = (start: number, end: number, chain: string[]): void => {
    const span = trimSpan(text, start, end);
    if (span) sections.push({ ...span, headings: chain, headingPath: joinHeadingPath(chain) });
  };
  const firstStart = headings.length > 0 ? lines[headings[0].line].start : text.length;
  push(0, firstStart, []);
  const stack: Array<{ level: number; text: string }> = [];
  headings.forEach((h, k) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    const end = k + 1 < headings.length ? lines[headings[k + 1].line].start : text.length;
    push(lines[h.line].start, end, stack.map((s) => s.text));
  });
  return sections;
}

/** Sections of pdftotext output: one per page (pages are separated by form feeds). */
export function pdfSections(text: string): SectionSpan[] {
  const sections: SectionSpan[] = [];
  let start = 0;
  while (start <= text.length) {
    let ff = text.indexOf('\f', start);
    if (ff === -1) ff = text.length;
    const span = trimSpan(text, start, ff);
    if (span) sections.push({ ...span, headings: [], headingPath: null });
    start = ff + 1;
  }
  return sections;
}

/** The whole text as one section. */
export function plainSections(text: string): SectionSpan[] {
  const span = trimSpan(text, 0, text.length);
  return span ? [{ ...span, headings: [], headingPath: null }] : [];
}

export function sectionsOf(text: string, format: StructuredFormat): SectionSpan[] {
  if (format === 'markdown') return markdownSections(text);
  if (format === 'pdf') return pdfSections(text);
  return plainSections(text);
}

/**
 * Block starts inside [start, end): a block is a run of non-blank lines, and in
 * Markdown a fenced code block is one block even across blank lines. The
 * returned offsets begin with `start`; blank lines belong to the block before
 * them, so consecutive starts tile the span with no gaps.
 */
export function blockStarts(text: string, start: number, end: number, format: StructuredFormat): number[] {
  const lines = splitLines(text, start, end);
  const starts: number[] = [start];
  let previousBlank = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const blank = isBlank(text, line);
    if (!blank && previousBlank && line.start !== start) starts.push(line.start);
    previousBlank = blank;
    if (!blank && format === 'markdown') {
      const fence = FENCE_OPEN.exec(text.slice(line.start, line.end));
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        i = fenceEnd(text, lines, i, fence[1]) + 1;
        continue;
      }
    }
    i += 1;
  }
  return starts;
}
