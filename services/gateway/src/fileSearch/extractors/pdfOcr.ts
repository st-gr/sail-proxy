// OCR for PDF pages without a text layer (scans). Runs on pdftotext's output: pdftotext ends every
// page with a form feed, so the text splits into pages; a page with fewer than 16 non-whitespace
// characters is read again from its image — pdfinfo reads the page's size, pdftoppm renders that one
// page as an 8-bit grey PGM on stdout (300 dpi, lower for a page whose long side would exceed
// OCR_LIMITS.maxSidePx), tesseract reads it from stdin at the same dpi (`--psm 3`, the configured
// languages) — and its OCR text replaces the page in place. Every form feed stays where it was, so page numbers count the
// same with and without OCR, and a PDF whose every page has text is returned unchanged (byte for
// byte: OCR is never asked).
//
// Best effort, never a failure of the file: a page that fails or times out, whose size cannot be
// read, or whose OCR finds no text stays as pdftotext gave it and is counted skipped; so are pages past the per-file cap or budget, and every candidate page
// when OCR is off (FILE_SEARCH_OCR=off — always so in the npm standalone CLI — or no tesseract;
// ocrAvailability.ts decides). Limits (OCR_LIMITS): one page OCR at a time per gateway process
// (other files queue, FIFO), both tools at lower priority and tesseract on one thread; 60 s per
// page; per file min(5 min, 40 % of the time left before the caller's deadline) and at most 200
// pages.
//
// One ingestion may extract a file twice (while its store re-chunks: once per chunking setting);
// an OcrMemo kept for the ingestion holds each page's outcome by blob sha256 + page, so the second
// extraction runs no OCR, and counts each page once (fs_jobs.ocr_pages / ocr_skipped_pages).

import * as crypto from 'crypto';
import { getDefaultLogger } from '@libs/logger';
import { runExtractor, runExtractorBuffer } from './runners';
import { getOcrStatus, tesseractChildEnv } from './ocrAvailability';

const logger = getDefaultLogger();

export const OCR_LIMITS = Object.freeze({
  dpi: 300,
  psm: 3,
  /** A page with fewer non-whitespace characters counts as having no text. */
  minCharsPerPage: 16,
  maxPagesPerFile: 200,
  /** Render and recognise of one page together. */
  pageTimeoutMs: 60_000,
  /** The per-file OCR budget: min(fileDeadlineMs, shareOfRemaining × the time left). */
  fileDeadlineMs: 300_000,
  shareOfRemaining: 0.4,
  /** A page is not started with less than this left of the file's budget. */
  minPageBudgetMs: 1_000,
  /**
   * The longest side of a rendered page in pixels. A4 (3508 px) and A3 (4961 px) render at the full
   * 300 dpi; a larger page box renders at a lower dpi so its image stays at most 5000 × 5000 px — a
   * 25 MB grey PGM (one byte per pixel) and a bounded pdftoppm/tesseract memory, whatever box a PDF
   * declares (poppler itself accepts sides up to ~11,000 pt: 41,667 px at 300 dpi).
   */
  maxSidePx: 5000,
  /** The rendered page image: a raw 8-bit PGM, at most maxSidePx² bytes plus its header. */
  maxPageImageBytes: 48 * 1024 * 1024,
  /** pdfinfo's output for one page (a few lines of metadata and boxes). */
  maxPageInfoBytes: 64 * 1024,
  pageInfoTimeoutMs: 10_000,
});

/** The dpi a page whose long side is `longSidePt` points renders at: `maxDpi` (OCR: 300), or less so
 *  the image stays within `maxSidePx`; 0 when not even 1 dpi fits (the page is skipped). The vision
 *  transcriber (visionTranscriber.ts) renders through the same bound with its own, smaller limits. */
export function renderDpi(longSidePt: number, maxDpi: number = OCR_LIMITS.dpi, maxSidePx: number = OCR_LIMITS.maxSidePx): number {
  if (!Number.isFinite(longSidePt) || longSidePt <= 0) return 0;
  return Math.max(0, Math.min(maxDpi, Math.floor((maxSidePx * 72) / longSidePt)));
}

/**
 * The long side in points of page `page` from `pdfinfo -f N -l N -box` output: the largest of its
 * size line and every box line printed for that page. The largest, because metadata printed before
 * them (a title with a line break) could forge a smaller line, never remove the real ones. Null when
 * no line for the page parses.
 */
export function pageLongSidePt(info: string, page: number): number | null {
  let longest = 0;
  const num = '(-?\\d+(?:\\.\\d+)?)';
  const size = new RegExp(`^Page\\s+${page}\\s+size:\\s+${num}\\s+x\\s+${num}\\s+pts`, 'gm');
  const box = new RegExp(`^Page\\s+${page}\\s+(?:Media|Crop|Bleed|Trim|Art)Box:\\s+${num}\\s+${num}\\s+${num}\\s+${num}`, 'gm');
  for (const m of info.matchAll(size)) longest = Math.max(longest, Math.abs(Number(m[1])), Math.abs(Number(m[2])));
  for (const m of info.matchAll(box)) {
    longest = Math.max(longest, Math.abs(Number(m[3]) - Number(m[1])), Math.abs(Number(m[4]) - Number(m[2])));
  }
  return Number.isFinite(longest) && longest > 0 ? longest : null;
}

/** The OCR engine; injected by the unit tests. */
export interface OcrDeps {
  status(): Promise<{ enabled: boolean; languages: string[]; reason: string }>;
  /** The long side of one page (1-based) in points; null when it cannot be read. */
  pageSize(pdf: Buffer, page: number, timeoutMs: number): Promise<number | null>;
  /** The image of one page (1-based) at `dpi`. */
  render(pdf: Buffer, page: number, dpi: number, timeoutMs: number): Promise<Buffer>;
  /** The text tesseract reads from a page image rendered at `dpi`. */
  recognise(image: Buffer, languages: string[], dpi: number, timeoutMs: number): Promise<string>;
  now?: () => number;
}

/** One PDF page as an image: its size (pdfinfo) and its bounded render (pdftoppm, grey PGM). */
export type PageRenderer = Pick<OcrDeps, 'pageSize' | 'render'>;

/** The poppler page renderer OCR uses; the vision transcriber reuses it. */
export const popplerPageRenderer: PageRenderer = {
  pageSize: async (pdf, page, timeoutMs) => pageLongSidePt(
    // `-` reads the PDF from stdin.
    await runExtractor('pdfinfo', ['-f', String(page), '-l', String(page), '-box', '-'], pdf,
      { timeoutMs, maxOutputBytes: OCR_LIMITS.maxPageInfoBytes, lowPriority: true }),
    page,
  ),
  render: (pdf, page, dpi, timeoutMs) =>
    // `-` reads the PDF from stdin; without an output root pdftoppm writes the image to stdout.
    // `-gray` without `-png` is a raw 8-bit grey PGM (P5; checked on poppler 25.12 and 26.04). With
    // `-png` poppler 26.04 writes RGB, so the PGM is both smaller to decode and exactly bounded in size.
    runExtractorBuffer(
      'pdftoppm',
      ['-f', String(page), '-l', String(page), '-r', String(dpi), '-gray', '-'],
      pdf,
      { timeoutMs, maxOutputBytes: OCR_LIMITS.maxPageImageBytes, lowPriority: true },
    ),
};

const defaultDeps: OcrDeps = {
  status: () => getOcrStatus(),
  ...popplerPageRenderer,
  recognise: (image, languages, dpi, timeoutMs) =>
    runExtractor(
      'tesseract',
      ['stdin', 'stdout', '-l', languages.join('+'), '--dpi', String(dpi), '--psm', String(OCR_LIMITS.psm)],
      image,
      { timeoutMs, env: tesseractChildEnv(), lowPriority: true },
    ),
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** pdftotext output split on form feeds; joinPages(splitPages(t)) === t. */
export function splitPages(text: string): string[] {
  return text.split('\f');
}

export function joinPages(pages: string[]): string {
  return pages.join('\f');
}

/** Pages in pdftotext output: one form feed ends each page (text after the last one is a page too). */
export function pageCount(text: string): number {
  const segments = splitPages(text).length;
  return text.endsWith('\f') ? segments - 1 : segments;
}

/** The 1-based numbers of the pages with fewer than OCR_LIMITS.minCharsPerPage non-whitespace characters. */
export function textlessPages(pages: string[], count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (pages[i].replace(/\s+/g, '').length < OCR_LIMITS.minCharsPerPage) out.push(i + 1);
  }
  return out;
}

/** tesseract's text for one page: no form feeds (its page separator), no surrounding blank space. */
function cleanOcrText(raw: string): string {
  return raw.replace(/\f/g, '').trim();
}

// ---------------------------------------------------------------------------
// One OCR at a time per process
// ---------------------------------------------------------------------------

/** A FIFO counting semaphore; acquire resolves a release function, or null when it waited too long. */
export class OcrSemaphore {
  private free: number;
  private readonly waiters: Array<(release: (() => void) | null) => void> = [];

  constructor(slots: number) {
    this.free = slots;
  }

  /** Waits at most `maxWaitMs` (forever when omitted) for a slot. Never blocks the event loop. */
  acquire(maxWaitMs?: number): Promise<(() => void) | null> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = (release: (() => void) | null) => {
        if (timer) clearTimeout(timer);
        resolve(release);
      };
      this.waiters.push(waiter);
      if (maxWaitMs !== undefined) {
        timer = setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) {
            this.waiters.splice(at, 1);
            resolve(null);
          }
        }, Math.max(0, maxWaitMs));
        if (typeof timer.unref === 'function') timer.unref();
      }
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.releaser());
      else this.free += 1;
    };
  }
}

const ocrSlots = new OcrSemaphore(1);

// ---------------------------------------------------------------------------
// Per-ingestion memo and counters
// ---------------------------------------------------------------------------

export interface OcrTotals {
  /** Pages without a text layer seen (each once). */
  candidates: number;
  /** Pages OCR read text from (fs_jobs.ocr_pages). */
  ocrPages: number;
  /** Pages left without OCR text: failed, timed out, size unreadable, no text found, past the cap or budget,
   *  OCR off (fs_jobs.ocr_skipped_pages). */
  skippedPages: number;
  /** Of skippedPages: those whose OCR failed, timed out or whose size could not be read. */
  failedPages: number;
  /** Time spent in OCR, waiting for the slot included. */
  elapsedMs: number;
  /** Why OCR did not run, when it was off. */
  unavailable: string | null;
}

/**
 * Whether a file's read left OCR pending: it had pages without text and OCR could not run (switched
 * off, tesseract or its languages missing). Pages past the per-file cap or the budget, failed pages and
 * pages OCR found no text on do not make it pending: reading the file again would not change them.
 */
export function ocrPendingOf(totals: Partial<Pick<OcrTotals, 'candidates' | 'unavailable'>> | undefined): boolean {
  return (totals?.candidates ?? 0) > 0 && typeof totals?.unavailable === 'string';
}

/** Page outcomes of one ingestion (or one re-chunk of a file), by blob sha256 + page. */
export class OcrMemo {
  private readonly pages = new Map<string, string | null>();
  private readonly budgetEnds = new Map<string, number>();
  private readonly counts: OcrTotals = {
    candidates: 0, ocrPages: 0, skippedPages: 0, failedPages: 0, elapsedMs: 0, unavailable: null,
  };

  has(sha256: string, page: number): boolean {
    return this.pages.has(`${sha256}:${page}`);
  }

  /** The OCR text of a page; null when it was skipped. */
  get(sha256: string, page: number): string | null {
    return this.pages.get(`${sha256}:${page}`) ?? null;
  }

  done(sha256: string, page: number, text: string): void {
    this.record(sha256, page, text);
    this.counts.ocrPages += 1;
  }

  skipped(sha256: string, page: number, failed = false): void {
    this.record(sha256, page, null);
    this.counts.skippedPages += 1;
    if (failed) this.counts.failedPages += 1;
  }

  /** The end of this blob's OCR budget, fixed when its first page is read. */
  budgetEnd(sha256: string, compute: () => number): number {
    let end = this.budgetEnds.get(sha256);
    if (end === undefined) {
      end = compute();
      this.budgetEnds.set(sha256, end);
    }
    return end;
  }

  addElapsed(ms: number): void {
    this.counts.elapsedMs += Math.max(0, ms);
  }

  noteUnavailable(reason: string): void {
    if (this.counts.unavailable === null) this.counts.unavailable = reason;
  }

  totals(): OcrTotals {
    return { ...this.counts };
  }

  private record(sha256: string, page: number, text: string | null): void {
    const key = `${sha256}:${page}`;
    if (!this.pages.has(key)) this.counts.candidates += 1;
    this.pages.set(key, text);
  }
}

/** The per-file log line: pages OCRed, skipped, time. Nothing when the file had no page without text. */
export function logOcrTotals(memo: OcrMemo, ids: { storeId: string; fileId: string; jobId?: string }): void {
  const t = memo.totals();
  if (t.candidates === 0) return;
  const fields = {
    ...ids, pagesWithoutText: t.candidates, ocrPages: t.ocrPages, skippedPages: t.skippedPages,
    failedPages: t.failedPages, ms: Math.round(t.elapsedMs),
  };
  if (t.unavailable !== null) {
    logger.info('FileSearchOcr', 'PDF pages without a text layer were left empty: OCR unavailable',
      { ...fields, ocr: 'unavailable', reason: t.unavailable });
  } else {
    logger.info('FileSearchOcr', 'OCR of PDF pages without a text layer', fields);
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface PdfOcrOptions {
  /** Reuse within one ingestion; a fresh one per call when omitted. */
  memo?: OcrMemo;
  /** The blob's sha256 (the memo key); hashed from the bytes when omitted. */
  sha256?: string;
  /** The caller's deadline (epoch ms) the OCR budget takes its 40 % of. */
  deadline?: number;
  /** Pages another reader already wrote (the vision transcriber, which runs first): never OCRed,
   *  however little text they hold. */
  keepPages?: readonly number[];
}

/**
 * pdftotext output with its pages without text read by OCR (see the module comment). Never
 * throws: anything unexpected leaves the text as it was.
 */
export async function ocrPdfPages(
  text: string, pdf: Buffer, opts: PdfOcrOptions = {}, deps: OcrDeps = defaultDeps,
): Promise<string> {
  const pages = splitPages(text);
  const keep = new Set(opts.keepPages ?? []);
  const candidates = textlessPages(pages, pageCount(text)).filter((page) => !keep.has(page));
  if (candidates.length === 0) return text;
  try {
    const memo = opts.memo ?? new OcrMemo();
    const sha = opts.sha256 ?? crypto.createHash('sha256').update(pdf).digest('hex');
    const open = candidates.filter((page) => !memo.has(sha, page));
    if (open.length > 0) await readPages(pdf, candidates, open, sha, memo, opts.deadline, deps);
    let changed = false;
    for (const page of candidates) {
      const ocr = memo.get(sha, page);
      if (ocr) {
        pages[page - 1] = `${ocr}\n`;
        changed = true;
      }
    }
    return changed ? joinPages(pages) : text;
  } catch (err) {
    logger.warn('FileSearchOcr', 'OCR of a PDF stopped unexpectedly; its pages without text stay empty',
      { error: err instanceof Error ? err.name : 'Error' });
    return text;
  }
}

async function readPages(
  pdf: Buffer, candidates: number[], open: number[], sha: string, memo: OcrMemo,
  deadline: number | undefined, deps: OcrDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const status = await deps.status();
  if (!status.enabled || status.languages.length === 0) {
    memo.noteUnavailable(status.reason);
    for (const page of open) memo.skipped(sha, page);
    return;
  }
  const started = now();
  const budgetEnd = memo.budgetEnd(sha, () => {
    const left = deadline === undefined ? Infinity : Math.max(0, deadline - started);
    return started + Math.min(OCR_LIMITS.fileDeadlineMs, Math.floor(OCR_LIMITS.shareOfRemaining * left));
  });
  try {
    for (const page of open) {
      if (candidates.indexOf(page) >= OCR_LIMITS.maxPagesPerFile || budgetEnd - now() < OCR_LIMITS.minPageBudgetMs) {
        memo.skipped(sha, page);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const release = await ocrSlots.acquire(budgetEnd - now());
      if (!release) {
        memo.skipped(sha, page);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const text = await readPage(pdf, page, status.languages, budgetEnd, deps, now);
        // A page OCR found no text on keeps its old text, so it counts as skipped, not read.
        if (text === '') memo.skipped(sha, page);
        else memo.done(sha, page, text);
      } catch (err) {
        memo.skipped(sha, page, true);
        logger.debug('FileSearchOcr', 'OCR of a PDF page failed; it stays empty',
          { page, error: err instanceof Error ? err.message : String(err) });
      } finally {
        release();
      }
    }
  } finally {
    memo.addElapsed(now() - started);
  }
}

async function readPage(
  pdf: Buffer, page: number, languages: string[], budgetEnd: number, deps: OcrDeps, now: () => number,
): Promise<string> {
  const pageEnd = Math.min(now() + OCR_LIMITS.pageTimeoutMs, budgetEnd);
  const left = () => {
    const ms = pageEnd - now();
    if (ms <= 0) throw new Error(`OCR of page ${page} ran out of time`);
    return ms;
  };
  const longSide = await deps.pageSize(pdf, page, Math.min(OCR_LIMITS.pageInfoTimeoutMs, left()));
  const dpi = longSide === null ? 0 : renderDpi(longSide);
  if (dpi < 1) throw new Error(`the size of page ${page} could not be read or is too large to render`);
  const image = await deps.render(pdf, page, dpi, left());
  return cleanOcrText(await deps.recognise(image, languages, dpi, left()));
}
