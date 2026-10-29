// Page numbers of chunks, from the page breaks of the extracted text.
//
// A paged format's extractor ends every page with one form feed ('\f'):
// pdftotext does (page N is the text before the N-th form feed), OCR keeps them
// in place (pdfOcr.ts), and a slide reader marks its slides the same way — one
// '\f' after each slide, an empty slide included — and lists its extension in
// the registry's paged set (`isPagedFile`). Nothing else is needed for its
// chunks to carry slide numbers.
//
// A character is on page 1 + the number of form feeds before it, so a form feed
// belongs to the page it ends. A span of text is on the pages of its first and
// last non-whitespace character: whitespace at its edges (a form feed is
// whitespace) never claims a neighbouring page, and a span of only whitespace
// has no pages. Chunk text is never changed for this:
// - structure chunks are exact substrings of the document at a known offset;
// - static chunks are word windows (chunker.ts), placed by the offset of their
//   first and last word in the same text the chunker split;
// - a parent section is a substring of the document around a hit whose pages
//   are stored: the form feeds between the hit and the window's edges count.
// Empty pages are skipped and short pages merged by the structure scanner, but
// the offsets are the document's, so every chunk keeps its real page numbers.
import { ChunkingStrategy, staticWordWindows } from './chunker';

export const PAGE_BREAK = '\f';

export interface PageSpan { first: number; last: number }

/** Offsets of every page break in `text`, ascending. */
export function pageBreakOffsets(text: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(PAGE_BREAK); at !== -1; at = text.indexOf(PAGE_BREAK, at + 1)) out.push(at);
  return out;
}

/** The page (from 1) of the character at `offset`: 1 + the page breaks before it. */
export function pageAt(breaks: readonly number[], offset: number): number {
  let lo = 0;
  let hi = breaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (breaks[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

const NON_SPACE = /\S/;

/** The pages of text.slice(start, end): of its first and last non-whitespace character; null when blank. */
export function spanPages(text: string, breaks: readonly number[], start: number, end: number): PageSpan | null {
  let first = start;
  while (first < end && !NON_SPACE.test(text[first])) first += 1;
  if (first >= end) return null;
  let last = end - 1;
  while (last > first && !NON_SPACE.test(text[last])) last -= 1;
  return { first: pageAt(breaks, first), last: pageAt(breaks, last) };
}

/** Each structured chunk's pages; `starts[i]` is chunk i's offset in `text` (its text is text.slice there). */
export function structuredChunkPages(
  text: string, chunks: ReadonlyArray<{ text: string }>, starts: readonly number[],
): Array<PageSpan | null> {
  const breaks = pageBreakOffsets(text);
  return chunks.map((c, i) => spanPages(text, breaks, starts[i], starts[i] + c.text.length));
}

/**
 * Each static chunk's pages, index-aligned with chunkText(text, strategy). The words are
 * the runs of non-whitespace — exactly what chunkText's split of the trimmed text yields —
 * and the windows are chunkText's own; two forward cursors find each window's first and
 * last word, so no per-word table is held for a large file.
 */
export function staticChunkPages(text: string, strategy: ChunkingStrategy): Array<PageSpan | null> {
  const breaks = pageBreakOffsets(text);
  let wordCount = 0;
  const counter = /\S+/g;
  while (counter.exec(text) !== null) wordCount += 1;
  if (wordCount === 0) return [];

  const cursor = () => {
    const re = /\S+/g;
    let index = -1;
    let offset = -1;
    return (word: number): number => {
      while (index < word) {
        offset = re.exec(text)!.index;
        index += 1;
      }
      return offset;
    };
  };
  const firstWord = cursor();
  const lastWord = cursor();
  const out: Array<PageSpan | null> = [];
  for (const { start, end } of staticWordWindows(wordCount, strategy)) {
    out.push({ first: pageAt(breaks, firstWord(start)), last: pageAt(breaks, lastWord(end - 1)) });
  }
  return out;
}

/**
 * The pages of a parent section `parent` built around a hit at `hitStart` whose stored
 * pages are `hitPages`: the hit's first non-whitespace character is on `hitPages.first`,
 * and each page break between it and the window's first (last) non-whitespace character
 * moves one page back (forward). Undefined when the hit's pages are unknown or the window is blank.
 */
export function parentPages(
  parent: string, hitStart: number, hitText: string, hitPages: PageSpan | undefined,
): PageSpan | undefined {
  if (!hitPages) return undefined;
  const lead = hitText.search(NON_SPACE);
  if (lead < 0) return undefined;
  const anchor = hitStart + lead;
  const breaks = pageBreakOffsets(parent);
  const span = spanPages(parent, breaks, 0, parent.length);
  if (!span) return undefined;
  const anchorPage = pageAt(breaks, anchor);
  return { first: hitPages.first + span.first - anchorPage, last: hitPages.first + span.last - anchorPage };
}

/** "4" or "4–5". */
export function formatPages(pages: PageSpan): string {
  return pages.first === pages.last ? String(pages.first) : `${pages.first}–${pages.last}`;
}
