/**
 * OCR and vision in the evaluation (W3): which PDF pages a vision mode would send, what that is
 * estimated to cost, and the vision calls ingestion actually made.
 *
 * - Page selection is the transcriber's own (`selectVisionPages` over pdftotext's pages and, for
 *   `auto`, its `-layout` pass), computed here from the corpus file before ingestion, so the meter can
 *   refuse a file before any image is sent, and --plan can show the calls without making them.
 * - Ingestion books what the calls reported: the transcriber bills each call as a `file_search/vision`
 *   usage event to the file's credential. The runner attaches the corpus with EVAL_CALLER as that
 *   credential and taps the usage emitter (standalone mode sends nothing anywhere), so every call's
 *   tokens reach the meter, also those of a file that did not complete.
 */
import { runExtractor } from '../../src/fileSearch/extractors/runners';
import { pageCount, splitPages } from '../../src/fileSearch/extractors/pdfOcr';
import { isPdfFile } from '../../src/fileSearch/extractors/registry';
import {
  estimateVisionTokens, resolveVisionSettings, selectVisionPages, VisionMode, VisionSettings,
} from '../../src/fileSearch/visionTranscriber';
import type { ContextTokens } from './costMeter';

/** The credential the corpus files are attached with when vision runs (never sent anywhere). */
export const EVAL_CALLER = { credentialId: 'file-search-eval', authType: 'api_key' } as const;

/** Output tokens one transcribed page is expected to take: gemini-3.5-flash-lite wrote 323–382 per
 *  A4 page in the live probe of 2026-10-09. For --plan only; the meter's ceiling uses the upper bound. */
export const EXPECTED_VISION_OUTPUT_TOKENS_PER_PAGE = 400;

const PDFTOTEXT_TIMEOUT_MS = 60_000;

/** A PDF's pages and the ones `mode` would send to the vision model (not yet capped). */
export async function visionPagesOf(filename: string, bytes: Buffer, mode: VisionMode): Promise<{ pages: number; selected: number[] }> {
  if (mode === 'off' || !isPdfFile(filename)) return { pages: 0, selected: [] };
  const text = await runExtractor('pdftotext', ['-', '-'], bytes, { timeoutMs: PDFTOTEXT_TIMEOUT_MS });
  const count = pageCount(text);
  const layout = mode === 'auto'
    ? splitPages(await runExtractor('pdftotext', ['-layout', '-', '-'], bytes, { timeoutMs: PDFTOTEXT_TIMEOUT_MS }))
    : undefined;
  return { pages: count, selected: selectVisionPages(mode, splitPages(text), count, layout) };
}

export interface FileVisionEstimate {
  model: string;
  /** Pages sent (capped by max_pages_per_file and the input ceiling): one call each. */
  pages: number;
  input: number;
  outputUpperBound: number;
  outputExpected: number;
}

/** What transcribing `selected` pages of one file is estimated to take, by the transcriber's caps. */
export function fileVisionEstimate(selected: number, settings: VisionSettings = resolveVisionSettings()): FileVisionEstimate {
  const e = estimateVisionTokens(selected, settings);
  return {
    model: settings.model, pages: e.pages, input: e.input, outputUpperBound: e.outputUpperBound,
    outputExpected: e.pages * EXPECTED_VISION_OUTPUT_TOKENS_PER_PAGE,
  };
}

/** A usage event as the emitter receives it (the fields read here). */
interface UsageEventLike {
  endpoint?: string; model?: string; inputTokens?: number; outputTokens?: number;
  cacheCreationInputTokens?: number; cacheReadInputTokens?: number;
}

/** Collects the `file_search/vision` usage events of a run; `take()` hands over what came since the last call. */
export class VisionUsageTap {
  private pending: ContextTokens & { calls: number } = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, calls: 0 };

  /** Replaces the emitter's `emit` (the runner is standalone: the original sends nothing anyway). */
  install(emitter: { emit: (event: any) => Promise<void> }): void {
    emitter.emit = async (event: UsageEventLike) => { this.record(event); };
  }

  record(event: UsageEventLike): void {
    if (event.endpoint !== 'file_search/vision') return;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    // The event splits input into full-rate and cache-write tokens; the meter books both as uncached.
    this.pending.inputTokens += n(event.inputTokens) + n(event.cacheCreationInputTokens);
    this.pending.cachedTokens += n(event.cacheReadInputTokens);
    this.pending.outputTokens += n(event.outputTokens);
    this.pending.calls += 1;
  }

  take(): ContextTokens & { calls: number } {
    const out = this.pending;
    this.pending = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, calls: 0 };
    return out;
  }
}
