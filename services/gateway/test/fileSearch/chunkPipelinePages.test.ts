// Page numbers in the file → chunk rows pipeline (no database, no binaries: the extracted text is
// given): a PDF's chunks carry the pages of their first and last character for both strategies,
// OCR text included; the chunk text is exactly what it is without pages; other formats get null.
let mockConfig: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  default: { getFileSearchConfig: () => mockConfig },
}));

let extracted = '';
jest.mock('../../src/fileSearch/extractors/registry', () => {
  const actual = jest.requireActual('../../src/fileSearch/extractors/registry');
  return {
    ...actual,
    extractText: async () => extracted,
    extractStructuredText: async (filename: string) => ({
      text: extracted, format: filename.endsWith('.pdf') ? 'pdf' : filename.endsWith('.md') ? 'markdown' : 'plain',
    }),
  };
});

jest.mock('../../src/fileSearch/structureChunkThread', () => {
  const actual = jest.requireActual('../../src/fileSearch/structureChunkThread');
  const { chunkStructuredWithSections } = jest.requireActual('../../src/fileSearch/structureChunker');
  return {
    ...actual,
    chunkStructuredOffThread: async (text: string, o: any) => {
      const { chunks, sections } = chunkStructuredWithSections(text, o);
      return { chunks, starts: chunks.map((c: any) => sections[c.section].start + c.sectionOffset), elapsedMs: 1, offThread: false };
    },
  };
});

import { prepareFileChunks } from '../../src/fileSearch/chunkPipeline';
import { chunkText } from '../../src/fileSearch/chunker';
import { chunkStructuredWithSections } from '../../src/fileSearch/structureChunker';
import { isPagedFile } from '../../src/fileSearch/extractors/registry';
import { ocrPdfPages, OcrDeps } from '../../src/fileSearch/extractors/pdfOcr';

const words = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
/** pdftotext's shape: each page's text, then a form feed. Page 3 is empty. */
const PDF_TEXT = [words('p1w', 300), words('p2w', 15), '', words('p4w', 300)].map((p) => `${p}\n\f`).join('');
const STATIC = { type: 'static' as const, max_tokens: 200, overlap_tokens: 60, contextual: false };
const STRUCTURE = { type: 'structure' as const, max_tokens: 150, overlap_tokens: 0, contextual: false };
const opts = () => ({ extractTimeoutMs: 5000, maxTokensPerFile: 1_000_000, deadline: Date.now() + 600_000, caller: null, embeddingDimensions: 1536 });
const pageOfWord = (w: string): number => Number(/^p(\d)w/.exec(w)![1]);

beforeEach(() => {
  mockConfig = { contextual: { fileDeadlineMs: 360_000 }, ingestion: { extractTimeoutMs: 5000 } };
  extracted = PDF_TEXT;
});

describe('paged formats', () => {
  it('only PDF and PowerPoint are paged', () => {
    expect(isPagedFile('a.pdf')).toBe(true);
    expect(isPagedFile('A.PDF')).toBe(true);
    expect(isPagedFile('deck.pptx')).toBe(true);
    for (const name of ['a.md', 'a.txt', 'a.docx', 'a.html', 'a.xlsx', 'pdf', 'pptx', 'a.pdf.txt']) expect(isPagedFile(name)).toBe(false);
  });
});

describe('static', () => {
  it('a PDF: chunk text byte-identical to chunkText, pages from the word windows', async () => {
    const { chunks } = await prepareFileChunks('r.pdf', Buffer.from('x'), STATIC, opts());
    const plain = chunkText(PDF_TEXT, { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 60 } });
    expect(chunks.map((c) => ({ ord: c.ord, text: c.text, tokens: c.tokens }))).toEqual(plain);
    for (const c of chunks) {
      const w = c.text.split(' ');
      expect([c.pageStart, c.pageEnd]).toEqual([pageOfWord(w[0]), pageOfWord(w[w.length - 1])]);
    }
    expect(chunks.map((c) => `${c.pageStart}-${c.pageEnd}`)).toEqual(['1-1', '1-1', '1-4', '4-4', '4-4', '4-4']);
  });

  it('another format: no pages, even with form feeds in its text', async () => {
    const { chunks } = await prepareFileChunks('r.txt', Buffer.from('x'), STATIC, opts());
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.pageStart === null && c.pageEnd === null)).toBe(true);
  });
});

describe('structure', () => {
  it('a PDF: pages from each chunk\'s document offset, the empty page skipped, the text unchanged', async () => {
    const { chunks } = await prepareFileChunks('r.pdf', Buffer.from('x'), STRUCTURE, opts());
    const plain = chunkStructuredWithSections(PDF_TEXT, { maxTokens: 150, overlapTokens: 0, format: 'pdf' }).chunks;
    expect(chunks.map((c) => c.text)).toEqual(plain.map((c) => c.text));
    for (const c of chunks.filter((x) => /\S/.test(x.text))) {
      const w = c.text.trim().split(/\s+/);
      expect([c.pageStart, c.pageEnd]).toEqual([pageOfWord(w[0]), pageOfWord(w[w.length - 1])]);
    }
    expect(chunks.some((c) => c.pageStart === 3 || c.pageEnd === 3)).toBe(false);
    // the short page 2 (15 words, under 100 tokens) is merged forward into page 4's section: one section, own page numbers
    const p2 = chunks.find((c) => c.text.includes('p2w0 '))!;
    const p4 = chunks.find((c) => c.text.includes('p4w0 '))!;
    expect(p2.section).toBe(p4.section);
    expect([p2.pageStart, p4.pageEnd]).toEqual([2, 4]);
    expect(chunks.some((c) => c.pageStart === 2 && c.pageEnd === 4)).toBe(true); // a chunk across the empty page
  });

  it('a single-page PDF', async () => {
    extracted = `${words('p1w', 20)}\n\f`;
    const { chunks } = await prepareFileChunks('r.pdf', Buffer.from('x'), STRUCTURE, opts());
    expect(chunks.map((c) => [c.pageStart, c.pageEnd])).toEqual([[1, 1]]);
  });

  it('markdown: no pages', async () => {
    extracted = `# A\n\n${words('w', 200)}\f\n\n# B\n\n${words('v', 200)}`;
    const { chunks } = await prepareFileChunks('r.md', Buffer.from('x'), STRUCTURE, opts());
    expect(chunks.every((c) => c.pageStart === null && c.pageEnd === null)).toBe(true);
  });
});

describe('OCRed pages', () => {
  it('a scanned page read by OCR keeps its page number', async () => {
    // pdftotext gave page 2 no text; OCR fills it in place, every form feed kept.
    const raw = `${words('p1w', 120)}\n\f\f${words('p3w', 120)}\n\f`;
    const deps: OcrDeps = {
      status: async () => ({ enabled: true, languages: ['eng'], reason: '' }),
      pageSize: async () => 842,
      render: async () => Buffer.from('img'),
      recognise: async () => `${words('p2w', 120)}\f`,
    };
    extracted = await ocrPdfPages(raw, Buffer.from('%PDF'), {}, deps);
    expect(extracted.split('\f')).toHaveLength(4);
    for (const setting of [STATIC, STRUCTURE]) {
      // eslint-disable-next-line no-await-in-loop
      const { chunks } = await prepareFileChunks('scan.pdf', Buffer.from('x'), setting, opts());
      for (const c of chunks.filter((x) => /\S/.test(x.text))) {
        const w = c.text.trim().split(/\s+/);
        expect([c.pageStart, c.pageEnd]).toEqual([pageOfWord(w[0]), pageOfWord(w[w.length - 1])]);
      }
      expect(chunks.some((c) => c.pageStart === 2 || c.pageEnd === 2)).toBe(true);
    }
  });
});
