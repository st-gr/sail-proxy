// W3 Task 2 against the real poppler (pdftotext, pdftoppm) and tesseract binaries; opt-in with
// FILE_SEARCH_TEST_BINARIES=1 like the other extractor suites (CI installs tesseract with eng):
// - pdftoppm without an output root writes the page image to stdout (the OCR path relies on it),
//   with `-gray` as an 8-bit grey PGM; pdfinfo reads the page size from stdin;
// - a page declaring a huge box renders at a reduced dpi, quickly and within the pixel cap;
// - every text PDF of the eval corpus extracts byte-identically to pdftotext, and OCR is never
//   asked (static and structure);
// - a scanned corpus PDF and an image-only PDF built here from two text pages are read by OCR,
//   each page's text in its own place, the form feeds kept;
// - FILE_SEARCH_OCR=off leaves the pages empty although tesseract is installed.
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { extractStructuredText, extractText } from '../../../src/fileSearch/extractors/registry';
import * as ocrAvailability from '../../../src/fileSearch/extractors/ocrAvailability';
import { runExtractor, runExtractorBuffer } from '../../../src/fileSearch/extractors/runners';
import { OcrMemo, pageCount, pageLongSidePt, renderDpi, splitPages } from '../../../src/fileSearch/extractors/pdfOcr';

jest.mock('../../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ ingestion: { extractTimeoutMs: 60_000 }, parsing: { ocr: { languages: ['eng'] } } }),
}));

const RUN_BINARY_TESTS = process.env.FILE_SEARCH_TEST_BINARIES === '1';
const d = RUN_BINARY_TESTS ? describe : describe.skip;

const CORPUS = join(__dirname, '../../../../../ci/file-search-eval/corpus');
const TEXT_PDFS = ['pdf', 'table'].flatMap((dir) =>
  readdirSync(join(CORPUS, dir)).filter((f) => f.endsWith('.pdf')).map((f) => join(CORPUS, dir, f)));

/** The words of a text, lower-cased, letters and digits only, 4+ characters. */
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));
}
function overlap(expected: string, actual: string): number {
  const want = words(expected);
  const got = words(actual);
  return [...want].filter((w) => got.has(w)).length / Math.max(1, want.size);
}

/** A baseline JPEG's number of colour components (1 grey, 3 RGB), from its SOF0 marker. */
function jpegComponents(jpeg: Buffer): number {
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  if (sof < 0) throw new Error('not a baseline JPEG');
  return jpeg[sof + 9];
}

/** An image-only PDF: one US-letter page per JPEG (each `width`×`height` pixels), no text layer. */
function imageOnlyPdf(jpegs: Buffer[], width: number, height: number): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Buffer) => { parts.push(b); length += b.length; };
  const obj = (n: number, body: Buffer[]) => {
    offsets[n] = length;
    push(Buffer.from(`${n} 0 obj\n`, 'latin1'));
    body.forEach(push);
    push(Buffer.from('\nendobj\n', 'latin1'));
  };
  push(Buffer.from('%PDF-1.4\n', 'latin1'));
  const pageIds = jpegs.map((_, i) => 3 + i * 3);
  obj(1, [Buffer.from('<</Type/Catalog/Pages 2 0 R>>', 'latin1')]);
  obj(2, [Buffer.from(`<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${jpegs.length}>>`, 'latin1')]);
  jpegs.forEach((jpeg, i) => {
    const page = pageIds[i];
    const content = 'q 612 0 0 792 0 0 cm /Im0 Do Q';
    obj(page, [Buffer.from(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</XObject<</Im0 ${page + 1} 0 R>>>>/Contents ${page + 2} 0 R>>`, 'latin1')]);
    obj(page + 1, [
      Buffer.from(`<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}/ColorSpace/${jpegComponents(jpeg) === 1 ? 'DeviceGray' : 'DeviceRGB'}/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>\nstream\n`, 'latin1'),
      jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]);
    obj(page + 2, [Buffer.from(`<</Length ${content.length}>>\nstream\n${content}\nendstream`, 'latin1')]);
  });
  const size = 3 + jpegs.length * 3;
  const xref = length;
  const rows = ['xref', `0 ${size}`, '0000000000 65535 f '];
  for (let n = 1; n < size; n += 1) rows.push(`${String(offsets[n]).padStart(10, '0')} 00000 n `);
  push(Buffer.from(`${rows.join('\n')}\ntrailer<</Size ${size}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const pdftotext = (pdf: Buffer) => runExtractor('pdftotext', ['-', '-'], pdf, { timeoutMs: 60_000 });

afterEach(() => {
  delete process.env.FILE_SEARCH_OCR;
  ocrAvailability.resetOcrStatusForTests();
  jest.restoreAllMocks();
});

d('PDF OCR with the real binaries (requires FILE_SEARCH_TEST_BINARIES=1)', () => {
  it('pdftoppm -gray without -png writes an 8-bit grey PGM (P5, maxval 255); pdfinfo reads the page size from stdin', async () => {
    const pdf = readFileSync(TEXT_PDFS[0]);
    const pgm = await runExtractorBuffer('pdftoppm', ['-f', '1', '-l', '1', '-r', '50', '-gray', '-'], pdf, { timeoutMs: 60_000 });
    const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 32).toString('latin1'));
    expect(header).not.toBeNull();
    const [w, h] = [Number(header![1]), Number(header![2])];
    expect(pgm.length).toBeGreaterThanOrEqual(w * h);
    const info = await runExtractor('pdfinfo', ['-f', '1', '-l', '1', '-box', '-'], pdf, { timeoutMs: 10_000 });
    const side = pageLongSidePt(info, 1)!;
    expect(side).toBeGreaterThan(500);
    expect(Math.max(w, h)).toBe(Math.ceil((side * 50) / 72));
  });

  it('a page declaring a 10,000 pt box renders at 36 dpi: fast, at most 5000 px, OCR completes', async () => {
    expect(await ocrAvailability.isOcrEnabled()).toBe(true);
    const content = 'q Q';
    const huge = Buffer.from([
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10000 10000]/Contents 4 0 R>>endobj`,
      `4 0 obj<</Length ${content.length}>>`, 'stream', content, 'endstream', 'endobj',
      'trailer<</Size 5/Root 1 0 R>>', '%%EOF',
    ].join('\n'), 'latin1');
    const side = pageLongSidePt(await runExtractor('pdfinfo', ['-f', '1', '-l', '1', '-box', '-'], huge, { timeoutMs: 10_000 }), 1);
    expect(side).toBe(10_000);
    expect(renderDpi(side!)).toBe(36);
    const started = Date.now();
    const pgm = await runExtractorBuffer('pdftoppm', ['-f', '1', '-l', '1', '-r', '36', '-gray', '-'], huge, { timeoutMs: 60_000 });
    expect(pgm.subarray(0, 14).toString('latin1')).toMatch(/^P5\s+5000\s+5000\s/);
    const memo = new OcrMemo();
    expect(await extractText('huge.pdf', huge, { ocr: { memo, deadline: Date.now() + 12 * 60_000 } })).toBe('\f');
    expect(Date.now() - started).toBeLessThan(15_000);
    // A blank page: OCR ran and found nothing, so it is counted skipped, not failed.
    expect(memo.totals()).toMatchObject({ candidates: 1, ocrPages: 0, skippedPages: 1, failedPages: 0 });
  }, 60_000);

  it('text PDFs extract byte-identically to pdftotext, static and structure, without asking for OCR', async () => {
    expect(TEXT_PDFS.length).toBeGreaterThanOrEqual(7);
    const status = jest.spyOn(ocrAvailability, 'getOcrStatus');
    for (const file of TEXT_PDFS) {
      const pdf = readFileSync(file);
      // eslint-disable-next-line no-await-in-loop
      const plain = await pdftotext(pdf);
      // eslint-disable-next-line no-await-in-loop
      expect(await extractText('doc.pdf', pdf, { ocr: { memo: new OcrMemo(), deadline: Date.now() + 600_000 } })).toBe(plain);
      // eslint-disable-next-line no-await-in-loop
      expect(await extractStructuredText('doc.pdf', pdf)).toEqual({ text: plain, format: 'pdf' });
    }
    expect(status).not.toHaveBeenCalled();
  }, 120_000);

  it('tesseract reads a scanned corpus PDF: every page gets text, the form feeds stay', async () => {
    expect(await ocrAvailability.isOcrEnabled()).toBe(true);
    const pdf = readFileSync(join(CORPUS, 'scanned/user-chapter-1-introduction.pdf'));
    const before = await pdftotext(pdf);
    expect(before.replace(/\f/g, '')).toBe('');
    const memo = new OcrMemo();
    const text = await extractText('scan.pdf', pdf, { ocr: { memo, deadline: Date.now() + 12 * 60_000 } });
    expect(pageCount(text)).toBe(pageCount(before));
    expect(text).toMatch(/What is SAIL-PROXY/i);
    for (const page of splitPages(text).slice(0, pageCount(text))) expect(page.trim().length).toBeGreaterThan(100);
    expect(memo.totals()).toMatchObject({ candidates: pageCount(before), ocrPages: pageCount(before), skippedPages: 0 });
  }, 300_000);

  it('an image-only PDF made from two text pages: each page\'s OCR text in its own place', async () => {
    expect(await ocrAvailability.isOcrEnabled()).toBe(true);
    const source = readFileSync(TEXT_PDFS.find((f) => f.endsWith('developer-chapter-2-architecture.pdf'))!);
    const original = splitPages(await pdftotext(source));
    const jpegs = await Promise.all([1, 2].map((n) => runExtractorBuffer('pdftoppm',
      ['-f', String(n), '-l', String(n), '-r', '150', '-jpeg', '-scale-to-x', '1275', '-scale-to-y', '1650', '-'],
      source, { timeoutMs: 60_000 })));
    const scan = imageOnlyPdf(jpegs, 1275, 1650);
    expect(await pdftotext(scan)).toBe('\f\f');

    const text = await extractText('scan.pdf', scan, { ocr: { deadline: Date.now() + 12 * 60_000 } });
    const pages = splitPages(text);
    expect(pages).toHaveLength(3);
    expect(pages[2]).toBe('');
    expect(overlap(original[0], pages[0])).toBeGreaterThan(0.6);
    expect(overlap(original[1], pages[1])).toBeGreaterThan(0.6);
    // In order: each page reads like its own source page more than like the other one.
    expect(overlap(original[0], pages[0])).toBeGreaterThan(overlap(original[0], pages[1]));
    expect(overlap(original[1], pages[1])).toBeGreaterThan(overlap(original[1], pages[0]));
    // The structure path gets the same text.
    expect((await extractStructuredText('scan.pdf', scan)).text).toBe(text);
  }, 300_000);

  it('FILE_SEARCH_OCR=off: the pages stay empty although tesseract is installed', async () => {
    process.env.FILE_SEARCH_OCR = 'off';
    ocrAvailability.resetOcrStatusForTests();
    const pdf = readFileSync(join(CORPUS, 'scanned/user-chapter-1-introduction.pdf'));
    const memo = new OcrMemo();
    const text = await extractText('scan.pdf', pdf, { ocr: { memo } });
    expect(text).toBe(await pdftotext(pdf));
    expect(memo.totals()).toMatchObject({ ocrPages: 0, skippedPages: pageCount(text), unavailable: expect.stringMatching(/switched off/) });
  });
});

// Not a test of this module, but what the suite needs: say so plainly when tesseract is missing.
d('the OCR suite\'s prerequisites', () => {
  it('has tesseract on PATH', () => {
    expect(() => execFileSync('tesseract', ['--version'], { stdio: 'ignore' })).not.toThrow();
  });
});
