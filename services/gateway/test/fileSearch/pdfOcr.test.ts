// W3 Task 2: OCR of PDF pages without a text layer (extractors/pdfOcr.ts). The OCR engine is
// injected (status, render, recognise), so these run without poppler or tesseract; the real
// binaries are covered by the FILE_SEARCH_TEST_BINARIES suite (integration/pdfOcr.test.ts).
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLog }));
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ parsing: { ocr: { languages: ['eng'] } } }),
}));

import {
  joinPages, splitPages, textlessPages, pageCount, ocrPdfPages, OcrMemo, OcrSemaphore, OCR_LIMITS,
  logOcrTotals, renderDpi, pageLongSidePt, type OcrDeps,
} from '../../src/fileSearch/extractors/pdfOcr';
import { ExtractionTimeoutError } from '../../src/fileSearch/extractors/runners';

const PDF = Buffer.from('%PDF-1.7 fake');
const SHA = 'a'.repeat(64);
const LONG = 'This page has a real text layer of more than sixteen characters.\n';

/** A fake engine: page n reads "OCR text of page n", unless `fail` names it. */
function fakeDeps(opts: {
  enabled?: boolean; fail?: number[]; slow?: Record<number, number>; recognised?: (page: number) => string;
  clock?: { now: number };
  /** Long side in points per page (default A4, 842); null = unreadable. */
  sizes?: Record<number, number | null>;
} = {}): OcrDeps & { rendered: number[]; recognisedLangs: string[][]; timeouts: number[]; dpis: number[] } {
  const rendered: number[] = [];
  const dpis: number[] = [];
  const recognisedLangs: string[][] = [];
  const timeouts: number[] = [];
  let lastPage = 0;
  return {
    rendered,
    recognisedLangs,
    timeouts,
    dpis,
    pageSize: async (_pdf, page) => (opts.sizes && page in opts.sizes ? opts.sizes[page] : 842),
    status: async () => (opts.enabled === false
      ? { enabled: false, languages: [], reason: 'switched off (FILE_SEARCH_OCR=off)' }
      : { enabled: true, languages: ['eng', 'deu'], reason: 'tesseract with eng+deu' }),
    render: async (_pdf, page, dpi, timeoutMs) => {
      rendered.push(page);
      dpis.push(dpi);
      timeouts.push(timeoutMs);
      lastPage = page;
      // Rendering takes `slow[page]` ms on the fake clock and, like the runner, is killed at its timeout.
      const cost = opts.slow?.[page] ?? 0;
      if (opts.clock && cost > 0) {
        if (cost > timeoutMs) {
          opts.clock.now += timeoutMs;
          throw new ExtractionTimeoutError('pdftoppm', timeoutMs);
        }
        opts.clock.now += cost;
      }
      if (opts.fail?.includes(page)) throw new ExtractionTimeoutError('pdftoppm', timeoutMs);
      return Buffer.from(`png-${page}`);
    },
    recognise: async (png, languages, dpi, timeoutMs) => {
      recognisedLangs.push(languages);
      dpis.push(dpi);
      timeouts.push(timeoutMs);
      const page = Number(png.toString().slice(4));
      expect(page).toBe(lastPage);
      return opts.recognised ? opts.recognised(page) : `OCR text of page ${page}\n\f`;
    },
    now: opts.clock ? () => opts.clock!.now : undefined,
  };
}

beforeEach(() => Object.values(mockLog).forEach((fn) => fn.mockClear()));

describe('page split and merge', () => {
  it('splits on form feeds and joins back byte-identically', () => {
    for (const text of ['', '\f', 'a\fb\f', 'a\f\f\fb', 'no form feed', 'x\f\f']) {
      expect(joinPages(splitPages(text))).toBe(text);
    }
  });

  it('counts one page per form feed (pdftotext ends each page with one)', () => {
    expect(pageCount('a\fb\f')).toBe(2);
    expect(pageCount('\f\f\f')).toBe(3);
    expect(pageCount('a\fb')).toBe(2);
    expect(pageCount('only')).toBe(1);
  });

  it('finds pages with fewer than 16 non-whitespace characters, 1-based, not the segment after the last form feed', () => {
    const text = [LONG, '', '  12  \n', '123456789012345', '1234567890123456', LONG, ''].join('\f');
    expect(textlessPages(splitPages(text), pageCount(text))).toEqual([2, 3, 4]);
    expect(textlessPages(splitPages('\f\f'), 2)).toEqual([1, 2]);
    expect(OCR_LIMITS.minCharsPerPage).toBe(16);
  });
});

describe('ocrPdfPages', () => {
  it('leaves a text PDF untouched and never asks for OCR', async () => {
    const deps = fakeDeps();
    const status = jest.spyOn(deps, 'status');
    const text = `${LONG}\f${LONG}\f`;
    expect(await ocrPdfPages(text, PDF, {}, deps)).toBe(text);
    expect(status).not.toHaveBeenCalled();
    expect(deps.rendered).toEqual([]);
  });

  it('replaces only the empty pages in place, keeping every form feed and the page order', async () => {
    const deps = fakeDeps();
    const memo = new OcrMemo();
    const text = `${LONG}\f\f${LONG}\f \n\f`;
    const out = await ocrPdfPages(text, PDF, { memo, sha256: SHA }, deps);
    expect(out).toBe(`${LONG}\fOCR text of page 2\n\f${LONG}\fOCR text of page 4\n\f`);
    expect(splitPages(out)).toHaveLength(splitPages(text).length);
    expect(deps.rendered).toEqual([2, 4]);
    expect(deps.recognisedLangs).toEqual([['eng', 'deu'], ['eng', 'deu']]);
    expect(memo.totals()).toMatchObject({ candidates: 2, ocrPages: 2, skippedPages: 0, unavailable: null });
  });

  it('drops form feeds and surrounding blank lines from the OCR output', async () => {
    const deps = fakeDeps({ recognised: () => '\n\n  Scanned\fline \n\n\f' });
    expect(await ocrPdfPages('\f', PDF, {}, deps)).toBe('Scannedline\n\f');
  });

  it('keeps a page whose OCR found nothing as it was, counted skipped (not read, not failed)', async () => {
    const deps = fakeDeps({ recognised: () => '  \n\f' });
    const memo = new OcrMemo();
    expect(await ocrPdfPages(` \f${LONG}\f`, PDF, { memo, sha256: SHA }, deps)).toBe(` \f${LONG}\f`);
    expect(memo.totals()).toMatchObject({ candidates: 1, ocrPages: 0, skippedPages: 1, failedPages: 0 });
  });

  it('renders a normal page at 300 dpi and a huge page box at a dpi that keeps it within 5000 px, tesseract told the same', async () => {
    const deps = fakeDeps({ sizes: { 1: 842, 2: 10_000, 3: 1191 } });
    await ocrPdfPages('\f\f\f', PDF, {}, deps);
    // render and recognise of each page: A4, a 10,000 pt box (floor(5000 × 72 / 10000) = 36), A3
    expect(deps.dpis).toEqual([300, 300, 36, 36, 300, 300]);
  });

  it('a page whose size cannot be read (or is too large for 1 dpi) is not rendered and is counted skipped', async () => {
    const deps = fakeDeps({ sizes: { 1: null, 2: 1e9 } });
    const memo = new OcrMemo();
    expect(await ocrPdfPages('\f\f\f', PDF, { memo, sha256: SHA }, deps)).toBe('\f\fOCR text of page 3\n\f');
    expect(deps.rendered).toEqual([3]);
    expect(memo.totals()).toMatchObject({ ocrPages: 1, skippedPages: 2, failedPages: 2 });
  });

  it('a page that fails stays empty, is counted, and the other pages are still read', async () => {
    const deps = fakeDeps({ fail: [2] });
    const memo = new OcrMemo();
    const out = await ocrPdfPages('\f\f\f', PDF, { memo, sha256: SHA }, deps);
    expect(out).toBe('OCR text of page 1\n\f\fOCR text of page 3\n\f');
    expect(memo.totals()).toMatchObject({ candidates: 3, ocrPages: 2, skippedPages: 1, failedPages: 1 });
  });

  it('never throws: an engine that rejects everything leaves the text as pdftotext gave it', async () => {
    const deps = fakeDeps({ fail: [1, 2] });
    await expect(ocrPdfPages('\f\f', PDF, {}, deps)).resolves.toBe('\f\f');
    const broken = { ...fakeDeps(), status: async () => { throw new Error('config broke'); } };
    await expect(ocrPdfPages('\f\f', PDF, {}, broken)).resolves.toBe('\f\f');
  });

  it('OCR off (switch, no tesseract, npm standalone): pages stay empty, all counted skipped, noted once', async () => {
    const deps = fakeDeps({ enabled: false });
    const memo = new OcrMemo();
    expect(await ocrPdfPages('\f\f', PDF, { memo, sha256: SHA }, deps)).toBe('\f\f');
    expect(deps.rendered).toEqual([]);
    expect(memo.totals()).toMatchObject({ candidates: 2, ocrPages: 0, skippedPages: 2,
      unavailable: 'switched off (FILE_SEARCH_OCR=off)' });
    // The second extraction of the same file (a re-chunk) does not ask again and counts nothing more.
    const status = jest.spyOn(deps, 'status');
    expect(await ocrPdfPages('\f\f', PDF, { memo, sha256: SHA }, deps)).toBe('\f\f');
    expect(status).not.toHaveBeenCalled();
    expect(memo.totals()).toMatchObject({ skippedPages: 2 });
    logOcrTotals(memo, { storeId: 'vs_1', fileId: 'file-1' });
    expect(mockLog.info).toHaveBeenCalledTimes(1);
    expect(mockLog.info.mock.calls[0][2]).toMatchObject({ storeId: 'vs_1', fileId: 'file-1', ocrPages: 0, skippedPages: 2,
      ocr: 'unavailable', reason: 'switched off (FILE_SEARCH_OCR=off)' });
  });

  it('reuses the OCR output within one ingestion: a second extraction of the same blob runs no OCR', async () => {
    const deps = fakeDeps();
    const memo = new OcrMemo();
    const first = await ocrPdfPages('\f\f', PDF, { memo, sha256: SHA }, deps);
    const second = await ocrPdfPages('\f\f', PDF, { memo, sha256: SHA }, deps);
    expect(second).toBe(first);
    expect(deps.rendered).toEqual([1, 2]);
    expect(memo.totals()).toMatchObject({ ocrPages: 2, skippedPages: 0 });
    // Another blob in the same memo is its own entry.
    await ocrPdfPages('\f', PDF, { memo, sha256: 'b'.repeat(64) }, deps);
    expect(deps.rendered).toEqual([1, 2, 1]);
    // A failed page is remembered too: not retried by the second extraction.
    const failing = fakeDeps({ fail: [1] });
    const memo2 = new OcrMemo();
    await ocrPdfPages('\f', PDF, { memo: memo2, sha256: SHA }, failing);
    await ocrPdfPages('\f', PDF, { memo: memo2, sha256: SHA }, failing);
    expect(failing.rendered).toEqual([1]);
    expect(memo2.totals()).toMatchObject({ ocrPages: 0, skippedPages: 1 });
  });

  it('reads at most 200 pages per file; the rest are counted skipped', async () => {
    const deps = fakeDeps({ recognised: () => 'x' });
    const memo = new OcrMemo();
    const text = '\f'.repeat(205);
    await ocrPdfPages(text, PDF, { memo, sha256: SHA, deadline: Date.now() + 60 * 60_000 }, deps);
    expect(deps.rendered).toHaveLength(OCR_LIMITS.maxPagesPerFile);
    expect(OCR_LIMITS.maxPagesPerFile).toBe(200);
    expect(deps.rendered[199]).toBe(200);
    expect(memo.totals()).toMatchObject({ candidates: 205, ocrPages: 200, skippedPages: 5 });
  });

  it('per-file budget: min(5 min, 40 % of the time left); pages past it are skipped', async () => {
    const fifty = { 1: 50_000, 2: 50_000, 3: 50_000, 4: 50_000, 5: 50_000, 6: 50_000, 7: 50_000 };
    const clock = { now: 1_000_000 };
    // 10 minutes left → 40 % = 240 s < 5 min. Each page takes 50 s: pages 1–4 fit (200 s);
    // page 5 starts with 40 s left, gets a 40 s timeout and is killed at it; page 6 never starts.
    const deps = fakeDeps({ clock, slow: fifty });
    const memo = new OcrMemo();
    await ocrPdfPages('\f\f\f\f\f\f', PDF, { memo, sha256: SHA, deadline: clock.now + 600_000 }, deps);
    expect(deps.timeouts[0]).toBe(OCR_LIMITS.pageTimeoutMs);
    expect(deps.rendered).toEqual([1, 2, 3, 4, 5]);
    expect(deps.timeouts[8]).toBe(40_000);
    expect(memo.totals()).toMatchObject({ candidates: 6, ocrPages: 4, skippedPages: 2, failedPages: 1 });

    // 20 minutes left → 40 % = 480 s, so the 5-minute cap applies: pages of 55 s, five fit
    // (275 s), the sixth gets the last 25 s.
    const fiftyFive = Object.fromEntries(Object.keys(fifty).map((k) => [k, 55_000]));
    const clock2 = { now: 0 };
    const deps2 = fakeDeps({ clock: clock2, slow: fiftyFive });
    const memo2 = new OcrMemo();
    await ocrPdfPages('\f\f\f\f\f\f\f', PDF, { memo: memo2, sha256: SHA, deadline: 20 * 60_000 }, deps2);
    expect(OCR_LIMITS.fileDeadlineMs).toBe(300_000);
    expect(OCR_LIMITS.shareOfRemaining).toBe(0.4);
    expect(deps2.rendered).toEqual([1, 2, 3, 4, 5, 6]);
    expect(deps2.timeouts[10]).toBe(25_000);
    expect(memo2.totals()).toMatchObject({ ocrPages: 5, skippedPages: 2 });
  });

  it('the page timeout is 60 s split across render and recognise', async () => {
    const clock = { now: 0 };
    const deps = fakeDeps({ clock, slow: { 1: 45_000 } });
    await ocrPdfPages('\f', PDF, { deadline: 12 * 60_000 }, deps);
    expect(deps.timeouts).toEqual([60_000, 15_000]);
  });
});

describe('page size and render dpi', () => {
  it('renders at 300 dpi up to a 1200 pt long side, lower beyond, 0 when not even 1 dpi fits', () => {
    expect(OCR_LIMITS.maxSidePx).toBe(5000);
    expect(renderDpi(841.92)).toBe(300); // A4
    expect(renderDpi(1190.55)).toBe(300); // A3: 4961 px
    expect(renderDpi(1200)).toBe(300);
    expect(renderDpi(1201)).toBe(299);
    expect(renderDpi(10_000)).toBe(36);
    expect(renderDpi(14_400)).toBe(25); // the largest page a PDF may declare (200 in)
    expect(renderDpi(400_000)).toBe(0);
    for (const bad of [0, -5, NaN, Infinity]) expect(renderDpi(bad)).toBe(0);
  });

  it('reads the long side from pdfinfo\'s size and box lines for the page, the largest of them', () => {
    const info = [
      'Title:          Page    3 size: 1 x 1 pts',
      'Page    3 size: 595.2 x 841.92 pts (A4)',
      'Page    3 rot:  90',
      'Page    3 MediaBox:     0.00     0.00   595.20   841.92',
      'Page    3 CropBox:      0.00     0.00   595.20   841.92',
      'Page    3 ArtBox:     -10.00   -20.00  3000.00   100.00',
      'Page   13 size: 99999 x 99999 pts',
    ].join('\n');
    expect(pageLongSidePt(info, 3)).toBe(3010);
    // A forged smaller line inside metadata cannot lower the real one.
    expect(pageLongSidePt('Title: x\nPage    1 size: 10 x 10 pts\nPage    1 size: 10000 x 10000 pts\n', 1)).toBe(10000);
    expect(pageLongSidePt('Pages: 1\n', 1)).toBeNull();
    expect(pageLongSidePt('Page    1 size: 0 x 0 pts\n', 1)).toBeNull();
  });
});

describe('OcrSemaphore', () => {
  it('runs one holder at a time and hands the slot over in arrival order', async () => {
    const sem = new OcrSemaphore(1);
    const order: string[] = [];
    const first = await sem.acquire();
    expect(first).not.toBeNull();
    const waiters = ['b', 'c', 'd'].map((name) => sem.acquire().then((release) => {
      order.push(name);
      return release!;
    }));
    await Promise.resolve();
    expect(order).toEqual([]);
    first!();
    const b = await waiters[0];
    expect(order).toEqual(['b']);
    b();
    (await waiters[1])();
    (await waiters[2])();
    expect(order).toEqual(['b', 'c', 'd']);
    // Free again: an acquire resolves at once.
    const again = await sem.acquire();
    expect(again).not.toBeNull();
    again!();
  });

  it('a waiter that waits longer than its limit gives up (null) and leaves the queue', async () => {
    jest.useFakeTimers();
    try {
      const sem = new OcrSemaphore(1);
      const held = await sem.acquire();
      const late = sem.acquire(1000);
      const next = sem.acquire();
      jest.advanceTimersByTime(1001);
      await expect(late).resolves.toBeNull();
      held!();
      const release = await next;
      expect(release).not.toBeNull();
      release!();
      // A double release does not free a second slot.
      release!();
      const a = await sem.acquire();
      let bGot = false;
      void sem.acquire().then(() => { bGot = true; });
      await Promise.resolve();
      expect(bGot).toBe(false);
      a!();
    } finally {
      jest.useRealTimers();
    }
  });

  it('two files OCR one page at a time, never concurrently', async () => {
    let running = 0;
    let maxRunning = 0;
    const deps: OcrDeps = {
      ...fakeDeps(),
      render: async (_pdf, page) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return Buffer.from(`png-${page}`);
      },
      recognise: async () => 'text',
    };
    await Promise.all([
      ocrPdfPages('\f\f\f', PDF, { sha256: SHA }, deps),
      ocrPdfPages('\f\f\f', PDF, { sha256: 'c'.repeat(64) }, deps),
    ]);
    expect(maxRunning).toBe(1);
  });
});

describe('the real engine (runners mocked)', () => {
  it('renders one page with pdftoppm to stdout and reads it with tesseract from stdin, both at lower priority', async () => {
    const runExtractor = jest.fn(async (bin: string) => (bin === 'pdfinfo'
      ? 'Pages:          2\nPage    2 size: 10000 x 7000 pts\nPage    2 MediaBox:     0.00     0.00 10000.00  7000.00\n'
      : 'Scanned words\n\f'));
    const runExtractorBuffer = jest.fn().mockResolvedValue(Buffer.from('PGM'));
    const getOcrStatus = jest.fn().mockResolvedValue({ enabled: true, languages: ['eng', 'deu'], reason: 'ok' });
    let mod!: typeof import('../../src/fileSearch/extractors/pdfOcr');
    jest.isolateModules(() => {
      jest.doMock('../../src/fileSearch/extractors/runners', () => ({ runExtractor, runExtractorBuffer }));
      jest.doMock('../../src/fileSearch/extractors/ocrAvailability', () => ({
        getOcrStatus, tesseractChildEnv: () => ({ OMP_THREAD_LIMIT: '1' }),
      }));
      mod = require('../../src/fileSearch/extractors/pdfOcr');
    });
    expect(await mod.ocrPdfPages(`${LONG}\f\f`, PDF, { deadline: Date.now() + 12 * 60_000 })).toBe(`${LONG}\fScanned words\n\f`);
    expect(runExtractorBuffer).toHaveBeenCalledTimes(1);
    const [bin, args, input, opts] = runExtractorBuffer.mock.calls[0];
    // A 10,000 pt page renders at 36 dpi (36 × 10000 / 72 = 5000 px), grey PGM on stdout.
    expect([bin, args, input]).toEqual(['pdftoppm', ['-f', '2', '-l', '2', '-r', '36', '-gray', '-'], PDF]);
    expect(opts).toMatchObject({ lowPriority: true, maxOutputBytes: OCR_LIMITS.maxPageImageBytes });
    expect(opts.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(runExtractor).toHaveBeenCalledTimes(2);
    const [iBin, iArgs, iInput, iOpts] = runExtractor.mock.calls[0] as any[];
    expect([iBin, iArgs, iInput]).toEqual(['pdfinfo', ['-f', '2', '-l', '2', '-box', '-'], PDF]);
    expect(iOpts).toMatchObject({ lowPriority: true, maxOutputBytes: OCR_LIMITS.maxPageInfoBytes });
    expect(iOpts.timeoutMs).toBeLessThanOrEqual(OCR_LIMITS.pageInfoTimeoutMs);
    const [tBin, tArgs, tInput, tOpts] = runExtractor.mock.calls[1] as any[];
    expect([tBin, tArgs, tInput]).toEqual(
      ['tesseract', ['stdin', 'stdout', '-l', 'eng+deu', '--dpi', '36', '--psm', '3'], Buffer.from('PGM')]);
    expect(tOpts).toMatchObject({ lowPriority: true, env: { OMP_THREAD_LIMIT: '1' } });
  });
});
