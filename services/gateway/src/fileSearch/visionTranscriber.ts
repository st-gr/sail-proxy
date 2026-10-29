/**
 * Vision transcription of hard PDF pages (opt-in per store): a page is rendered to an image and an
 * SAP-served vision model writes it out as Markdown, which replaces the page's text in place.
 *
 * Off unless the store's chunking setting asks for it (`visionModeOf`): an upgrade starts no model
 * costs. The modes pick the pages (`selectVisionPages`):
 *   no_text — pages without a text layer (fewer than 16 non-whitespace characters: scans);
 *   auto    — those, plus pages with little text (fewer than 200 non-whitespace characters: a figure
 *             or a diagram with a caption) and table-heavy pages (`tableLikePage`, read from one
 *             `pdftotext -layout` pass over the file);
 *   all     — every page.
 * At most `maxPagesPerFile` pages per file are sent, in page order, counted over every extraction
 * that shares the memo (a re-chunk's two settings may select different pages).
 *
 * Page images are never masked: where pseudonymization applies to file_search content
 * (`visionImagesUnmasked`), the gateway log says so once per process (VISION_UNMASKED_WARNING), and
 * so do a store setting change and the re-chunk estimate.
 *
 * Each page: pdfinfo's page box → a bounded dpi (at most 200, and a long side of at most
 * `maxSidePx` = 1568 px; pdfOcr.ts renderDpi) → pdftoppm's grey PGM (popplerPageRenderer, the
 * renderer OCR uses) → a grey PNG within the bound (sharp; extractors/pageImage.ts) → one
 * completion (orchestrationCompletion.ts) with VISION_SYSTEM_PROMPT and the image as a data-URL
 * part, temperature 0, at most `maxOutputTokensPerPage` output tokens. The reply is sanitised (no
 * form feed or control character can shift the page numbering, no wrapping code fence) and capped.
 *
 * Why 1568 px: the long edge Anthropic's models read without downscaling and SAP's per-image limit
 * for multi-image requests (plugins/resizeOversizedImages.ts); Gemini bills an image by its media
 * resolution, not its pixels. An A4 page renders at 134 dpi: 10 pt text is about 19 px high,
 * comfortably legible, and the PNG stays a few hundred KB.
 *
 * Best effort, like the context writer (contextWriter.ts): a page whose render or call fails, times
 * out, comes back empty or is cut at the output limit (`finish_reason: length`) keeps its text, and
 * the pass never throws. Because this runs BEFORE OCR, a page without a text layer that vision did
 * not transcribe is still empty when OCR looks at it, so OCR reads it (the fallback); a page with a
 * text layer keeps pdftotext's text. It stops starting new calls — calls in flight finish — on
 * the caller's abort, at the per-file deadline (min(`fileDeadlineMs`, 40 % of the time left before
 * the caller's deadline), fixed at the file's first page), once the file has spent
 * `maxInputTokensPerFile` input or `maxOutputTokensPerFile` output tokens, when no orchestration
 * deployment exists, when the first 3 calls all failed (the model is most likely not served), or
 * after max(4, 2 × concurrency) failures in a row. A reply cut at the output limit fails its page but
 * counts as an answer for these stops (the model is served; the page was just dense).
 *
 * The ceilings hold per ingestion attempt: a file whose ingestion fails and is retried starts afresh,
 * so its worst case is (1 + ingestion.maxRetries) × each ceiling.
 *
 * Unavailable — every selected page keeps its text, with one warning per process — when
 * FILE_SEARCH_VISION=off (always so in the npm standalone CLI, the lite gateway), or where pdftoppm
 * or pdfinfo is not on PATH or sharp does not load.
 *
 * One ingestion may extract a file twice (while its store re-chunks); a VisionMemo kept for the
 * ingestion holds each page's outcome by blob sha256 + page and the file's spend, so the second
 * extraction calls the model for no page twice and the ceilings hold over both. Never logs page
 * text or images.
 */
import * as crypto from 'crypto';
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import {
  CompletionCall, CompletionError, CompletionResult, CompletionUsage, orchestrationComplete, ZERO_USAGE,
} from './orchestrationCompletion';
import {
  OCR_LIMITS, PageRenderer, joinPages, pageCount, popplerPageRenderer, renderDpi, splitPages, textlessPages,
} from './extractors/pdfOcr';
import { loadSharp, PageImage, pageImageDataUrl, sharpLoadError } from './extractors/pageImage';
import { resolveBinary, runExtractor } from './extractors/runners';

const logger = getDefaultLogger();

// ---------------------------------------------------------------------------
// Modes and settings
// ---------------------------------------------------------------------------

export type VisionMode = 'off' | 'no_text' | 'auto' | 'all';
export const VISION_MODES: readonly VisionMode[] = Object.freeze(['off', 'no_text', 'auto', 'all']);

/** `value` as a vision mode; anything else is 'off'. */
export function parseVisionMode(value: unknown): VisionMode {
  return (VISION_MODES as readonly unknown[]).includes(value) ? (value as VisionMode) : 'off';
}

/** A chunking setting's vision mode: its `vision` field when valid, else 'off' (every setting
 *  before W3 has none). */
export function visionModeOf(setting: unknown): VisionMode {
  return parseVisionMode(setting && typeof setting === 'object' ? (setting as { vision?: unknown }).vision : undefined);
}

export interface VisionSettings {
  /** The SAP orchestration model; it must read images (catalog capability `image-recognition`). */
  model: string;
  maxPagesPerFile: number;
  /** Calls in flight at once. */
  concurrency: number;
  /** Timeout of one call. */
  requestTimeoutMs: number;
  /** The per-file deadline's upper bound (see the module comment). */
  fileDeadlineMs: number;
  /** Input tokens (cached reads included) one file may spend; no call starts once they are spent. */
  maxInputTokensPerFile: number;
  /** Output tokens one file may spend; no call starts once they are spent. */
  maxOutputTokensPerFile: number;
  /** One reply's limit; a reply cut there counts as failed. */
  maxOutputTokensPerPage: number;
  /** The long side of the image sent, in pixels. */
  maxSidePx: number;
}

export const VISION_DEFAULTS: Readonly<VisionSettings> = Object.freeze({
  // Live probe 2026-10-09 (2 scanned pages): flash-lite and 3.8-flash both reproduced 100 % of the
  // words; flash-lite wrote 323–382 output tokens in 2.3–2.5 s per page, 3.8-flash 863–1590 in
  // 5.7–10.5 s; input 1,235 tokens per page for both.
  model: 'gemini-3.5-flash-lite',
  maxPagesPerFile: 50,
  concurrency: 2,
  requestTimeoutMs: 90_000,
  fileDeadlineMs: 240_000,
  // 50 pages × (≈ 1.1–1.6k image + ≈ 0.2k prompt tokens) with headroom.
  maxInputTokensPerFile: 150_000,
  // 50 pages × ≈ 0.6–1.2k typical; a few dense pages may use the page limit.
  maxOutputTokensPerFile: 120_000,
  maxOutputTokensPerPage: 4096,
  maxSidePx: 1568,
});

/** The highest dpi a page renders at for the model (a small page; an A4 page gets 134 dpi). */
export const VISION_MAX_DPI = 200;
/** The longest transcription kept for one page, in characters (4096 tokens ≈ 16k characters). */
export const MAX_PAGE_CHARS = 20_000;
/** The reply that means "nothing on this page". */
export const BLANK_PAGE_REPLY = '[blank page]';

/** `auto`: a page with fewer non-whitespace characters than this is sent (a figure, a diagram). */
export const LOW_TEXT_CHARS = 200;
/** `auto`: a page is table-heavy when at least this many of its layout lines… */
export const TABLE_LINES_MIN = 15;
/** …and at least this share of its non-empty layout lines have a column gap. */
export const TABLE_LINE_SHARE = 0.3;

const SHARE_OF_REMAINING = 0.4;
const MIN_PAGE_BUDGET_MS = 2_000;
const LAYOUT_TIMEOUT_MS = 30_000;
const FAILURES_BEFORE_GIVING_UP = 3;
const CONSECUTIVE_FAILURES_PER_SLOT = 2;
const MIN_CONSECUTIVE_FAILURES = 4;
const MODEL_CHECK_TIMEOUT_MS = 30_000;

const positiveInt = (v: unknown, fallback: number): number =>
  (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback);

/** The schema's range of each configurable limit (api-config-schema.json `file_search.parsing.vision`;
 *  a test holds them equal). A hand-edited configuration reaches the gateway unvalidated. */
export const VISION_CONFIG_RANGES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  maxPagesPerFile: [1, 1000],
  concurrency: [1, 8],
  requestTimeoutMs: [5000, 300_000],
  fileDeadlineMs: [10_000, 1_800_000],
  maxInputTokensPerFile: [10_000, 100_000_000],
  maxOutputTokensPerFile: [10_000, 100_000_000],
});

let clampWarnedFor: string | null = null;

/** Configured whole numbers outside VISION_CONFIG_RANGES clamped into them, with one warning per distinct
 *  set of corrections (the configuration is read on every file). Other values pass for resolveVisionSettings. */
function clampConfigured(configured: Record<string, unknown>): Partial<VisionSettings> {
  const out: Record<string, unknown> = { ...configured };
  const notes: string[] = [];
  for (const [key, [min, max]] of Object.entries(VISION_CONFIG_RANGES)) {
    const value = configured[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) continue;
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) {
      out[key] = clamped;
      notes.push(`${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)} ${value} -> ${clamped}`);
    }
  }
  const message = notes.length > 0 ? `file_search.parsing.vision: values outside their range were clamped: ${notes.join(', ')}` : null;
  if (message !== null && message !== clampWarnedFor) logger.warn('FileSearchVision', message);
  clampWarnedFor = message;
  return out as Partial<VisionSettings>;
}

/** The installation's vision settings (`file_search.parsing.vision`, when configured, clamped into the
 *  schema's ranges) over the defaults, then `override` (taken as given); invalid values fall back to the
 *  default. */
export function resolveVisionSettings(override?: Partial<VisionSettings>): VisionSettings {
  let configured: Partial<VisionSettings> = {};
  try {
    configured = clampConfigured((configService.getFileSearchConfig() as any)?.parsing?.vision ?? {});
  } catch {
    configured = {};
  }
  const raw: Partial<VisionSettings> = { ...configured, ...(override ?? {}) };
  const d = VISION_DEFAULTS;
  return {
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : d.model,
    maxPagesPerFile: positiveInt(raw.maxPagesPerFile, d.maxPagesPerFile),
    concurrency: positiveInt(raw.concurrency, d.concurrency),
    requestTimeoutMs: positiveInt(raw.requestTimeoutMs, d.requestTimeoutMs),
    fileDeadlineMs: positiveInt(raw.fileDeadlineMs, d.fileDeadlineMs),
    maxInputTokensPerFile: positiveInt(raw.maxInputTokensPerFile, d.maxInputTokensPerFile),
    maxOutputTokensPerFile: positiveInt(raw.maxOutputTokensPerFile, d.maxOutputTokensPerFile),
    maxOutputTokensPerPage: positiveInt(raw.maxOutputTokensPerPage, d.maxOutputTokensPerPage),
    maxSidePx: positiveInt(raw.maxSidePx, d.maxSidePx),
  };
}

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

/**
 * Whether a page of `pdftotext -layout` output is table-heavy: at least TABLE_LINES_MIN lines with a
 * column gap (a run of 3+ spaces between two words) making up at least TABLE_LINE_SHARE of its
 * non-empty lines. Measured on the eval corpus: its 5 table pages have 19–37 such lines (34–70 %);
 * no prose page has more than 13 (code trees and diagrams), most have none.
 */
export function tableLikePage(layoutPage: string): boolean {
  let lines = 0;
  let gapLines = 0;
  for (const line of layoutPage.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    lines += 1;
    if (/\S {3,}\S/.test(trimmed)) gapLines += 1;
  }
  return gapLines >= TABLE_LINES_MIN && gapLines >= TABLE_LINE_SHARE * lines;
}

/** The 1-based pages `mode` sends to the model, in order (not yet capped). `layoutPages`: the
 *  file's `pdftotext -layout` pages, used by `auto` only; ignored when their count differs. */
export function selectVisionPages(mode: VisionMode, pages: string[], count: number, layoutPages?: string[]): number[] {
  if (mode === 'off' || count <= 0) return [];
  if (mode === 'all') return Array.from({ length: count }, (_, i) => i + 1);
  if (mode === 'no_text') return textlessPages(pages, count);
  const layout = layoutPages && layoutPages.length >= count ? layoutPages : undefined;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const chars = pages[i].replace(/\s+/g, '').length;
    if (chars < LOW_TEXT_CHARS || (layout !== undefined && tableLikePage(layout[i]))) out.push(i + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt and reply
// ---------------------------------------------------------------------------

export const VISION_SYSTEM_PROMPT =
  'You transcribe one page of a document from its image, for a search index. Reply with all the text on ' +
  'the page as GitHub-flavoured Markdown, in reading order: headings with #, lists as lists, tables as pipe ' +
  'tables (a header row, a separator row, one line per row), code as fenced code. For a figure or diagram, ' +
  "transcribe only the text in it. Keep the page's own words and language: do not translate, summarise, " +
  'correct, explain or describe the page. Reply with the transcription only: no preamble, no comments, no ' +
  `code fence around the whole reply. If the page has no text, reply exactly: ${BLANK_PAGE_REPLY}`;

const pageMessage = (page: number) => `Transcribe page ${page}.`;

const WHOLE_FENCE = /^(`{3,}|~{3,})[ \t]*(?:markdown|md|gfm)?[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/i;

/**
 * A model reply → the page's text: line breaks normalised, a code fence around the whole reply
 * removed, every control character but newline and tab dropped (a form feed would shift the page
 * numbering), trailing spaces and runs of blank lines trimmed, at most MAX_PAGE_CHARS (cut at a line
 * break). '' when nothing is left; BLANK_PAGE_REPLY when the model said the page is blank.
 */
export function sanitizeTranscription(reply: string): string {
  let text = reply.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').trim();
  const fenced = WHOLE_FENCE.exec(text);
  if (fenced) text = fenced[2];
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  text = text.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (/^\[?\s*blank page\s*\]?\.?$/i.test(text)) return BLANK_PAGE_REPLY;
  if (text.length > MAX_PAGE_CHARS) {
    const cut = text.slice(0, MAX_PAGE_CHARS);
    const nl = cut.lastIndexOf('\n');
    text = (nl > MAX_PAGE_CHARS / 2 ? cut.slice(0, nl) : cut).trim();
  }
  return text;
}

// ---------------------------------------------------------------------------
// Memo and counters
// ---------------------------------------------------------------------------

export type VisionStop = 'deadline' | 'input_budget' | 'output_budget' | 'no_deployment' | 'failing' | 'aborted';

export interface VisionTotals {
  model: string;
  /** Pages selected for vision (each once). */
  selected: number;
  /** Pages whose text the model wrote (fs_jobs.vision_pages). */
  visionPages: number;
  /** Selected pages that kept their text — failed, blank, past the cap, a ceiling or a stop, or
   *  vision unavailable (fs_jobs.vision_skipped_pages). */
  skippedPages: number;
  /** Of skippedPages: those whose render or call failed. */
  failedPages: number;
  usage: CompletionUsage;
  /** Time spent, from the file's first page to its last call. */
  elapsedMs: number;
  /** The first reason a file stopped early, if any did. */
  stopped: VisionStop | null;
  /** Why vision did not run, when it was unavailable. */
  unavailable: string | null;
}

interface FileState {
  budgetEnd: number;
  /** Pages handed to the model so far (across every extraction sharing the memo): maxPagesPerFile
   *  caps this, so a re-chunk whose two settings select different pages still sends at most that many. */
  admitted: number;
  usage: CompletionUsage;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  stopped?: VisionStop;
}

const addUsage = (a: CompletionUsage, b: CompletionUsage): CompletionUsage => ({
  input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cachedRead: a.cachedRead + b.cachedRead, output: a.output + b.output,
});

/** Page outcomes and per-file spend of one ingestion (or one re-chunk of a file), by blob sha256 + page. */
export class VisionMemo {
  private readonly pages = new Map<string, string | null>();
  private readonly files = new Map<string, FileState>();
  private readonly counts: VisionTotals = {
    model: '', selected: 0, visionPages: 0, skippedPages: 0, failedPages: 0,
    usage: { ...ZERO_USAGE }, elapsedMs: 0, stopped: null, unavailable: null,
  };

  has(sha256: string, page: number): boolean {
    return this.pages.has(`${sha256}:${page}`);
  }

  /** The model's text of a page; null when it kept its own. */
  get(sha256: string, page: number): string | null {
    return this.pages.get(`${sha256}:${page}`) ?? null;
  }

  done(sha256: string, page: number, text: string): void {
    this.record(sha256, page, text);
    this.counts.visionPages += 1;
  }

  skipped(sha256: string, page: number, failed = false): void {
    this.record(sha256, page, null);
    this.counts.skippedPages += 1;
    if (failed) this.counts.failedPages += 1;
  }

  /** The file's state; its budget end fixed by `budgetEnd()` on first use. */
  file(sha256: string, budgetEnd: () => number): FileState {
    let state = this.files.get(sha256);
    if (!state) {
      state = { budgetEnd: budgetEnd(), admitted: 0, usage: { ...ZERO_USAGE }, successes: 0, failures: 0, consecutiveFailures: 0 };
      this.files.set(sha256, state);
    }
    return state;
  }

  addUsage(state: FileState, usage: CompletionUsage): void {
    state.usage = addUsage(state.usage, usage);
    this.counts.usage = addUsage(this.counts.usage, usage);
  }

  addElapsed(ms: number): void {
    this.counts.elapsedMs += Math.max(0, ms);
  }

  noteModel(model: string): void {
    if (!this.counts.model) this.counts.model = model;
  }

  noteStopped(reason: VisionStop): void {
    if (this.counts.stopped === null) this.counts.stopped = reason;
  }

  noteUnavailable(reason: string): void {
    if (this.counts.unavailable === null) this.counts.unavailable = reason;
  }

  totals(): VisionTotals {
    return { ...this.counts, usage: { ...this.counts.usage } };
  }

  /** The job counters (fs_jobs.vision_pages / vision_skipped_pages). */
  counters(): { visionPages: number; visionSkippedPages: number } {
    return { visionPages: this.counts.visionPages, visionSkippedPages: this.counts.skippedPages };
  }

  private record(sha256: string, page: number, text: string | null): void {
    const key = `${sha256}:${page}`;
    if (!this.pages.has(key)) this.counts.selected += 1;
    this.pages.set(key, text);
  }
}

/** The per-file log line: pages, tokens, time, ids. Nothing when no page was selected. */
export function logVisionTotals(memo: VisionMemo, ids: { storeId: string; fileId: string; jobId?: string }): void {
  const t = memo.totals();
  if (t.selected === 0) return;
  const fields = {
    ...ids, model: t.model, selectedPages: t.selected, visionPages: t.visionPages, skippedPages: t.skippedPages,
    failedPages: t.failedPages, inputTokens: t.usage.input, cachedTokens: t.usage.cachedRead,
    outputTokens: t.usage.output, ms: Math.round(t.elapsedMs),
  };
  if (t.unavailable !== null) {
    logger.info('FileSearchVision', 'Vision transcription unavailable; the selected pages kept their text', { ...fields, reason: t.unavailable });
  } else if (t.stopped === 'no_deployment' || t.stopped === 'failing' || t.stopped === 'input_budget' || t.stopped === 'output_budget') {
    logger.warn('FileSearchVision', 'Vision transcription stopped early on this file; the remaining pages kept their text', { ...fields, stopped: t.stopped });
  } else {
    logger.info('FileSearchVision', 'Vision transcription of PDF pages', { ...fields, ...(t.stopped ? { stopped: t.stopped } : {}) });
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface VisionCallRecord {
  model: string;
  usage: CompletionUsage;
  elapsedMs: number;
}

/** The engine; injected by the unit tests. */
export interface VisionDeps extends PageRenderer {
  /** null when pages can be rendered and encoded here; otherwise why not. */
  unavailable(): string | null;
  /** `pdftotext -layout` of the whole file (auto mode). */
  layoutText(pdf: Buffer, timeoutMs: number): Promise<string>;
  toImage(pgm: Buffer, maxSidePx: number): Promise<PageImage>;
  complete(call: CompletionCall): Promise<CompletionResult>;
  now?: () => number;
}

/** The env variable that switches vision transcription off (the npm standalone CLI always does). */
export const VISION_SWITCH_ENV = 'FILE_SEARCH_VISION';
const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled']);

/** Why vision is switched off by FILE_SEARCH_VISION, or null when it is not. */
export function visionSwitchedOff(env: NodeJS.ProcessEnv = process.env): string | null {
  return OFF_VALUES.has((env[VISION_SWITCH_ENV] ?? '').trim().toLowerCase())
    ? `switched off (${VISION_SWITCH_ENV}=off)` : null;
}

function rendererUnavailable(): string | null {
  const off = visionSwitchedOff();
  if (off) return off;
  for (const tool of ['pdfinfo', 'pdftoppm']) {
    try {
      resolveBinary(tool);
    } catch {
      return `${tool} is not installed`;
    }
  }
  if (!loadSharp()) return `the image library could not be loaded (${sharpLoadError()})`;
  return null;
}

export const defaultVisionDeps: VisionDeps = {
  ...popplerPageRenderer,
  unavailable: rendererUnavailable,
  layoutText: (pdf, timeoutMs) => runExtractor('pdftotext', ['-layout', '-', '-'], pdf, { timeoutMs, lowPriority: true }),
  toImage: (pgm, maxSidePx) => pageImageDataUrl(pgm, maxSidePx),
  complete: (call) => orchestrationComplete(call),
};

let unavailableWarned = false;
let unmaskedWarned = false;

/** The log line, and the meaning of the estimate's `vision_unmasked_warning` flag. */
export const VISION_UNMASKED_WARNING = 'Vision transcription sends page images to the vision model unmasked: '
  + 'pseudonymization is force-enabled for file_search content in this configuration, but it masks text only';

/** Whether `mode` sends page images to the model while pseudonymization applies to file_search
 *  content (configService.isPseudonymizationForcedForFileSearch): the images are not masked. */
export function visionImagesUnmasked(mode: VisionMode): boolean {
  if (parseVisionMode(mode) === 'off') return false;
  try {
    return configService.isPseudonymizationForcedForFileSearch?.() === true;
  } catch {
    return false;
  }
}

/** Logs VISION_UNMASKED_WARNING when it applies, with `fields` (a store setting change). */
export function warnVisionUnmasked(mode: VisionMode, fields: Record<string, unknown>): void {
  if (visionImagesUnmasked(mode)) logger.warn('FileSearchVision', VISION_UNMASKED_WARNING, { ...fields, vision: mode });
}

/** Once per process when pages are sent while the warning applies. */
function warnUnmaskedOnce(): void {
  if (unmaskedWarned || !visionImagesUnmasked('all')) return;
  unmaskedWarned = true;
  logger.warn('FileSearchVision', VISION_UNMASKED_WARNING);
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface PdfVisionOptions {
  /** 'off' (or absent) returns the text untouched without any call. */
  mode: VisionMode;
  /** Reuse within one ingestion; a fresh one per call when omitted. */
  memo?: VisionMemo;
  /** The blob's sha256 (the memo key); hashed from the bytes when omitted. */
  sha256?: string;
  /** The caller's deadline (epoch ms) the per-file deadline takes its 40 % of. */
  deadline?: number;
  signal?: AbortSignal;
  settings?: Partial<VisionSettings>;
  /** Called once per call that spent tokens (a success, or an empty or truncated reply); for the
   *  `file_search/vision` usage events. */
  onCall?: (record: VisionCallRecord) => void;
}

export interface PdfVisionResult {
  /** The text with the transcribed pages replaced (the input itself when none was). */
  text: string;
  /** The 1-based pages whose text the model wrote, ascending: OCR must leave them alone
   *  (PdfOcrOptions.keepPages), however short they are. */
  transcribed: number[];
}

/**
 * pdftotext output with the pages `opts.mode` selects transcribed by the vision model (see the
 * module comment). Never throws: anything unexpected leaves the text as it was.
 */
export async function transcribePdfPages(
  text: string, pdf: Buffer, opts: PdfVisionOptions, deps: VisionDeps = defaultVisionDeps,
): Promise<PdfVisionResult> {
  const unchanged = { text, transcribed: [] };
  const mode = parseVisionMode(opts.mode);
  if (mode === 'off') return unchanged;
  try {
    const pages = splitPages(text);
    const count = pageCount(text);
    const settings = resolveVisionSettings(opts.settings);
    const now = deps.now ?? Date.now;
    const memo = opts.memo ?? new VisionMemo();
    const sha = opts.sha256 ?? crypto.createHash('sha256').update(pdf).digest('hex');
    let layoutPages: string[] | undefined;
    // The layout pass only finds more pages for auto; it is skipped when every page is decided
    // already (a re-chunk's second extraction) or nothing could be rendered anyway.
    const undecided = Array.from({ length: count }, (_, i) => i + 1).some((page) => !memo.has(sha, page));
    if (mode === 'auto' && undecided && deps.unavailable() === null) {
      try {
        const left = opts.deadline === undefined ? LAYOUT_TIMEOUT_MS : Math.max(1, opts.deadline - now());
        layoutPages = splitPages(await deps.layoutText(pdf, Math.min(LAYOUT_TIMEOUT_MS, left)));
      } catch (err) {
        logger.debug('FileSearchVision', 'The layout pass failed; auto mode selects by text amount only',
          { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const selected = selectVisionPages(mode, pages, count, layoutPages);
    if (selected.length === 0) return unchanged;
    memo.noteModel(settings.model);
    const open = selected.filter((page) => !memo.has(sha, page));
    if (open.length > 0) await transcribeOpen(pdf, open, sha, memo, settings, opts, deps, now);
    const transcribed: number[] = [];
    for (const page of selected) {
      const transcript = memo.get(sha, page);
      if (transcript) {
        pages[page - 1] = `${transcript}\n`;
        transcribed.push(page);
      }
    }
    return transcribed.length > 0 ? { text: joinPages(pages), transcribed } : unchanged;
  } catch (err) {
    logger.warn('FileSearchVision', 'Vision transcription of a PDF stopped unexpectedly; its pages keep their text',
      { error: err instanceof Error ? err.name : 'Error' });
    return unchanged;
  }
}

async function transcribeOpen(
  pdf: Buffer, open: number[], sha: string, memo: VisionMemo, settings: VisionSettings,
  opts: PdfVisionOptions, deps: VisionDeps, now: () => number,
): Promise<void> {
  const unavailable = deps.unavailable();
  if (unavailable !== null) {
    memo.noteUnavailable(unavailable);
    for (const page of open) memo.skipped(sha, page);
    if (!unavailableWarned) {
      unavailableWarned = true;
      logger.warn('FileSearchVision', `Vision transcription is unavailable on this gateway: ${unavailable}; pages fall back to OCR or their text layer`);
    }
    return;
  }

  const started = now();
  const state = memo.file(sha, () => {
    const left = opts.deadline === undefined ? Infinity : Math.max(0, opts.deadline - started);
    return started + Math.min(settings.fileDeadlineMs, Math.floor(SHARE_OF_REMAINING * left));
  });
  const consecutiveLimit = Math.max(MIN_CONSECUTIVE_FAILURES, CONSECUTIVE_FAILURES_PER_SLOT * settings.concurrency);

  const shouldStop = (): boolean => {
    if (!state.stopped) {
      if (opts.signal?.aborted) state.stopped = 'aborted';
      else if (state.budgetEnd - now() < MIN_PAGE_BUDGET_MS) state.stopped = 'deadline';
      else if (state.usage.input + state.usage.cachedRead >= settings.maxInputTokensPerFile) state.stopped = 'input_budget';
      else if (state.usage.output >= settings.maxOutputTokensPerFile) state.stopped = 'output_budget';
      else if (state.successes === 0 && state.failures >= FAILURES_BEFORE_GIVING_UP) state.stopped = 'failing';
      else if (state.consecutiveFailures >= consecutiveLimit) state.stopped = 'failing';
      if (state.stopped) memo.noteStopped(state.stopped);
    }
    return state.stopped !== undefined;
  };

  const record = (usage: CompletionUsage, elapsedMs: number) => {
    memo.addUsage(state, usage);
    if (!opts.onCall) return;
    try {
      opts.onCall({ model: settings.model, usage, elapsedMs });
    } catch (error: any) {
      logger.warn('FileSearchVision', `Vision usage sink failed and was ignored: ${error?.message}`);
    }
  };
  const modelFailed = () => {
    state.failures += 1;
    state.consecutiveFailures += 1;
  };
  const modelAnswered = () => {
    state.successes += 1;
    state.consecutiveFailures = 0;
  };

  const runOne = async (page: number): Promise<void> => {
    const left = () => {
      const ms = state.budgetEnd - now();
      if (ms <= 0) throw new Error(`no time left for page ${page}`);
      return ms;
    };
    let image: PageImage;
    try {
      const longSide = await deps.pageSize(pdf, page, Math.min(OCR_LIMITS.pageInfoTimeoutMs, left()));
      const dpi = longSide === null ? 0 : renderDpi(longSide, VISION_MAX_DPI, settings.maxSidePx);
      if (dpi < 1) throw new Error(`the size of page ${page} could not be read or is too large to render`);
      image = await deps.toImage(await deps.render(pdf, page, dpi, left()), settings.maxSidePx);
    } catch (err) {
      // A page that cannot be rendered says nothing about the model.
      memo.skipped(sha, page, true);
      logger.debug('FileSearchVision', 'Rendering a PDF page for vision failed; it keeps its text',
        { page, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (shouldStop()) {
      memo.skipped(sha, page);
      return;
    }
    const callStarted = now();
    try {
      const result = await deps.complete({
        model: settings.model,
        system: VISION_SYSTEM_PROMPT,
        messages: [{ text: pageMessage(page), images: [image.dataUrl] }],
        params: { temperature: 0, max_tokens: settings.maxOutputTokensPerPage },
        timeoutMs: Math.max(1, Math.min(settings.requestTimeoutMs, state.budgetEnd - now())),
        signal: opts.signal,
      });
      record(result.usage, result.elapsedMs);
      const transcript = sanitizeTranscription(result.text);
      if (transcript === BLANK_PAGE_REPLY) {
        modelAnswered();
        memo.skipped(sha, page);
      } else if (transcript) {
        modelAnswered();
        memo.done(sha, page, transcript);
      } else {
        modelFailed();
        memo.skipped(sha, page, true);
      }
    } catch (error: any) {
      // A reply cut at the output limit is a served model on a dense page: the page fails, the
      // stop counters see an answer.
      if (error instanceof CompletionError && error.reason === 'truncated') modelAnswered();
      else modelFailed();
      memo.skipped(sha, page, true);
      if (error instanceof CompletionError) {
        if (error.usage) record(error.usage, now() - callStarted);
        if (error.reason === 'no_deployment') state.stopped = state.stopped ?? 'no_deployment';
        if (error.reason === 'aborted') state.stopped = state.stopped ?? 'aborted';
        if (state.stopped) memo.noteStopped(state.stopped);
      }
      logger.debug('FileSearchVision', 'A vision call failed; the page keeps its text',
        { page, reason: error?.reason ?? 'error', status: error?.status });
    }
  };

  // The page cap counts pages sent for this file over the whole memo, in page order.
  const queue: number[] = [];
  for (const page of open) {
    if (state.admitted >= settings.maxPagesPerFile) {
      memo.skipped(sha, page);
    } else {
      state.admitted += 1;
      queue.push(page);
    }
  }
  if (queue.length > 0) warnUnmaskedOnce();
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const page = queue[next++];
      if (shouldStop()) {
        memo.skipped(sha, page);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await runOne(page);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(settings.concurrency, queue.length) }, worker));
  } finally {
    memo.addElapsed(now() - started);
  }
}

// ---------------------------------------------------------------------------
// Model check and estimate
// ---------------------------------------------------------------------------

/** A 16 × 16 white grey PNG: the model check's image. */
const PROBE_IMAGE = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQYlWP4jwYYRrYAAID5/wHE+Cb+AAAAAElFTkSuQmCC';

/**
 * Whether the vision model answers a transcription call with an image, asked with one tiny call
 * (a blank 16 × 16 image, the transcriber's prompt; `onCall` records what it spent).
 * 'unavailable' without a call when FILE_SEARCH_VISION=off (the lite gateway).
 * 'unavailable': no orchestration deployment, or the call was refused (HTTP 400, 404 or 422 — the
 * model is not served or does not take images), so every page would fail too. 'unknown': a
 * timeout, a 429 or 5xx, a network error. A reply of any kind, an empty or truncated one included,
 * is 'served'.
 */
export async function checkVisionModel(opts: {
  settings?: Partial<VisionSettings>;
  onCall?: (record: VisionCallRecord) => void;
  complete?: (call: CompletionCall) => Promise<CompletionResult>;
} = {}): Promise<{ model: string; result: 'served' | 'unavailable' | 'unknown' }> {
  const { model } = resolveVisionSettings(opts.settings);
  if (visionSwitchedOff()) return { model, result: 'unavailable' };
  const complete = opts.complete ?? orchestrationComplete;
  const record = (usage: CompletionUsage, elapsedMs: number) => {
    try {
      opts.onCall?.({ model, usage, elapsedMs });
    } catch (error: any) {
      logger.warn('FileSearchVision', `Vision usage sink failed and was ignored: ${error?.message}`);
    }
  };
  const started = Date.now();
  try {
    const reply = await complete({
      model,
      system: VISION_SYSTEM_PROMPT,
      messages: [{ text: pageMessage(1), images: [PROBE_IMAGE] }],
      params: { temperature: 0, max_tokens: 64 },
      timeoutMs: MODEL_CHECK_TIMEOUT_MS,
    });
    record(reply.usage, reply.elapsedMs);
    return { model, result: 'served' };
  } catch (error: any) {
    if (!(error instanceof CompletionError)) return { model, result: 'unknown' };
    if (error.usage) record(error.usage, Date.now() - started);
    if (error.reason === 'truncated' || error.reason === 'empty_response') return { model, result: 'served' };
    if (error.reason === 'no_deployment') return { model, result: 'unavailable' };
    if (error.reason === 'request_failed' && [400, 404, 422].includes(error.status ?? 0)) return { model, result: 'unavailable' };
    return { model, result: 'unknown' };
  }
}

/** Input tokens one page is estimated to send, image and prompt: the live probe (2026-10-09, an A4
 *  page at 1568 px) measured 1,235 on gemini-3.5-flash-lite and gemini-3.8-flash alike. */
export const ESTIMATED_INPUT_TOKENS_PER_PAGE = 1250;

/**
 * What transcribing `pages` selected pages of one file costs, by the transcriber's own caps: at
 * most `maxPagesPerFile` pages (fewer when the input ceiling stops it), each
 * ESTIMATED_INPUT_TOKENS_PER_PAGE in and at most `maxOutputTokensPerPage` out, the output bounded
 * by its ceiling plus the calls in flight. Pure.
 */
export function estimateVisionTokens(pages: number, settings: Partial<VisionSettings> = {}): {
  pages: number; input: number; outputUpperBound: number;
} {
  if (!(pages > 0)) return { pages: 0, input: 0, outputUpperBound: 0 };
  const d = VISION_DEFAULTS;
  const maxPages = positiveInt(settings.maxPagesPerFile, d.maxPagesPerFile);
  const perPageOut = positiveInt(settings.maxOutputTokensPerPage, d.maxOutputTokensPerPage);
  const inputCeiling = positiveInt(settings.maxInputTokensPerFile, d.maxInputTokensPerFile);
  const outputCeiling = positiveInt(settings.maxOutputTokensPerFile, d.maxOutputTokensPerFile);
  const concurrency = positiveInt(settings.concurrency, d.concurrency);
  const n = Math.min(Math.floor(pages), maxPages, Math.ceil(inputCeiling / ESTIMATED_INPUT_TOKENS_PER_PAGE));
  return {
    pages: n,
    input: n * ESTIMATED_INPUT_TOKENS_PER_PAGE,
    // Calls in flight when the output ceiling is reached still finish.
    outputUpperBound: Math.min(n * perPageOut, outputCeiling + concurrency * perPageOut),
  };
}

/** Forget the once-per-process warnings. Tests only. */
export function resetVisionWarningsForTests(): void {
  unavailableWarned = false;
  unmaskedWarned = false;
}
