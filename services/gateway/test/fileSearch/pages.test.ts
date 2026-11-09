// Page numbers of chunks: derived from the form feeds of the extracted text (one after each page),
// never by changing a chunk's text. Structure chunks by their document offset, static chunks by
// their word window, parent sections by the hit they were built around.
import { chunkText, ChunkingStrategy } from '../../src/fileSearch/chunker';
import { chunkStructuredWithSections } from '../../src/fileSearch/structureChunker';
import {
  formatPages, pageAt, pageBreakOffsets, parentPages, spanPages, staticChunkPages, structuredChunkPages,
} from '../../src/fileSearch/pages';

const words = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const strategy = (size: number, overlap: number): ChunkingStrategy => ({
  type: 'static', static: { max_chunk_size_tokens: size, chunk_overlap_tokens: overlap },
});

describe('pageAt / pageBreakOffsets / spanPages', () => {
  const text = 'one\ftwo two\f\fthree\f';
  const breaks = pageBreakOffsets(text);

  it('a form feed ends a page; a character is on page 1 + the form feeds before it', () => {
    expect(breaks).toEqual([3, 11, 12, 18]);
    expect(pageAt(breaks, 0)).toBe(1);
    expect(pageAt(breaks, 3)).toBe(1); // the form feed belongs to the page it ends
    expect(pageAt(breaks, 4)).toBe(2);
    expect(pageAt(breaks, 13)).toBe(4); // page 3 is empty
  });

  it('a span is on the pages of its first and last non-whitespace character; blank → null', () => {
    expect(spanPages(text, breaks, 0, 3)).toEqual({ first: 1, last: 1 });
    expect(spanPages(text, breaks, 0, 11)).toEqual({ first: 1, last: 2 });
    // whitespace (the form feeds included) at either edge does not claim the next or previous page
    expect(spanPages(text, breaks, 2, 14)).toEqual({ first: 1, last: 4 });
    expect(spanPages(text, breaks, 3, 5)).toEqual({ first: 2, last: 2 });
    expect(spanPages(text, breaks, 11, 13)).toBeNull();
    expect(spanPages(text, breaks, 5, 5)).toBeNull();
  });

  it('formats one page or a range', () => {
    expect(formatPages({ first: 4, last: 4 })).toBe('4');
    expect(formatPages({ first: 4, last: 5 })).toBe('4–5');
  });
});

describe('structuredChunkPages', () => {
  it('pdf structure: empty pages skipped and short pages merged into one section keep their own page numbers', () => {
    // page 1 long, page 2 empty, pages 3 and 4 short (merged forward into one section), page 5 long
    const pages = [words('a', 400), '', 'short three', 'short four', words('e', 400)];
    const text = pages.map((p) => `${p}\n\f`).join('');
    const { chunks, sections } = chunkStructuredWithSections(text, { maxTokens: 300, overlapTokens: 0, format: 'pdf' });
    const starts = chunks.map((c) => sections[c.section].start + c.sectionOffset);
    const got = structuredChunkPages(text, chunks, starts);
    expect(got).toHaveLength(chunks.length);
    chunks.forEach((c, i) => {
      const p = got[i]!;
      if (c.text.includes('a0 ')) expect(p.first).toBe(1);
      if (c.text.includes('short three')) expect(p.first).toBe(3);
      if (c.text.includes('short four')) expect(p.last).toBeGreaterThanOrEqual(4);
      if (c.text.includes('e399')) expect(p.last).toBe(5);
      // every page of the span really holds a character of the chunk: the chunk's text is the document's
      expect(text.slice(starts[i], starts[i] + c.text.length)).toBe(c.text);
    });
    expect(got.every((p) => p !== null && p.first >= 1 && p.last <= 5 && p.first <= p.last)).toBe(true);
    // no chunk is on page 2 (empty)
    expect(got.some((p) => p!.first === 2 || p!.last === 2)).toBe(false);
  });

  it('a chunk crossing a page break spans both pages', () => {
    const text = 'Last words of page one.\fFirst words of page two.\f';
    expect(structuredChunkPages(text, [{ text: 'page one.\fFirst' }], [14])).toEqual([{ first: 1, last: 2 }]);
  });

  it('a whitespace-only chunk has no pages', () => {
    const text = `x\n${' '.repeat(20)}\f`;
    expect(structuredChunkPages(text, [{ text: ' '.repeat(20) }], [2])).toEqual([null]);
  });
});

describe('staticChunkPages', () => {
  const pagesText = [words('p1w', 300), words('p2w', 50), '', words('p4w', 300)].map((p) => `${p}\n\f`).join('');
  const s = strategy(200, 60);

  it('one entry per static chunk, from the word windows; chunk text untouched', () => {
    const chunks = chunkText(pagesText, s);
    const pages = staticChunkPages(pagesText, s);
    expect(pages).toHaveLength(chunks.length);
    chunks.forEach((c, i) => {
      const first = Number(/^p(\d)w/.exec(c.text)![1]);
      const last = Number(/p(\d)w\d+$/.exec(c.text)![1]);
      expect(pages[i]).toEqual({ first, last });
      expect(c.text).not.toContain('\f'); // static text never carries the form feeds
    });
    // windows of 153 words, step 107: 214–367 runs from page 1 over all of page 2 into page 4,
    // 321–474 from page 2 across the empty page 3
    expect(pages.map((p) => formatPages(p!))).toEqual(['1', '1', '1–4', '2–4', '4', '4']);
  });

  it('single page; leading empty pages are counted', () => {
    expect(staticChunkPages(`${words('w', 10)}\f`, s)).toEqual([{ first: 1, last: 1 }]);
    expect(staticChunkPages(`\f\f${words('w', 10)}\f`, s)).toEqual([{ first: 3, last: 3 }]);
  });

  it('empty text → no chunks; text without form feeds is all page 1 (callers decide whether a format is paged)', () => {
    expect(staticChunkPages('  \f \n', s)).toEqual([]);
    expect(staticChunkPages(words('w', 10), s)).toEqual([{ first: 1, last: 1 }]);
  });

  it('agrees with chunkText for every window on a large, irregular text', () => {
    const big = Array.from({ length: 40 }, (_, i) => `${words(`k${i}x`, (i * 37) % 120)}\n\t\f`).join('');
    for (const st of [strategy(100, 0), strategy(800, 400), strategy(4096, 2048), strategy(130, 65)]) {
      const chunks = chunkText(big, st);
      const pages = staticChunkPages(big, st);
      expect(pages).toHaveLength(chunks.length);
      chunks.forEach((c, i) => {
        const firstWord = c.text.split(' ')[0];
        const lastWord = c.text.split(' ').pop()!;
        expect(pages[i]!.first).toBe(1 + Number(/^k(\d+)x/.exec(firstWord)![1]));
        expect(pages[i]!.last).toBe(1 + Number(/^k(\d+)x/.exec(lastWord)![1]));
      });
    }
  });
});

describe('parentPages', () => {
  it('first page of the window\'s first character, last of its last, anchored on the hit', () => {
    const parent = 'end of page three\f\fpage five hit text here\fpage six tail';
    const hitText = 'hit text here';
    const hitStart = parent.indexOf(hitText);
    expect(parentPages(parent, hitStart, hitText, { first: 5, last: 5 })).toEqual({ first: 3, last: 6 });
    // the hit alone
    expect(parentPages(hitText, 0, hitText, { first: 5, last: 5 })).toEqual({ first: 5, last: 5 });
    // a hit crossing a page break, padded with whitespace
    const p2 = '  a\fb  ';
    expect(parentPages(p2, 0, p2, { first: 7, last: 8 })).toEqual({ first: 7, last: 8 });
  });

  it('unknown hit pages → none', () => {
    expect(parentPages('text', 0, 'text', undefined)).toBeUndefined();
  });
});
