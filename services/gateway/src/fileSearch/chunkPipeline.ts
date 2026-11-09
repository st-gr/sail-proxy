// One file's way from its bytes to the chunk rows ingestion stores: extract,
// chunk by the effective chunking setting, write contexts. Shared by ingestion
// and the re-chunk job; embedding and the commit stay with the caller.
//
// - static: extractText + chunkText exactly as before W2 (byte-identical chunks;
//   no section, no context).
// - structure: extractStructuredText + chunkStructured in the chunker thread.
//   Every chunk stores its section, offset and heading path, and a context:
//   the heading path line, plus — when the setting is contextual — the context
//   writer's sentence(s), plus the table header a continuation piece of a table
//   starts after. A chunk without any of them has no context. The heading path
//   is stored as context also without the LLM, so a structure store's chunks are
//   found by their headings and embedded with them.
// - A chunk of only whitespace (a whitespace run longer than a chunk) is stored
//   for its section's rebuild but gets no context and no embedding.
// - Vision (opt-in: the setting's `vision` mode, off unless a store asks): the PDF
//   pages the mode selects are transcribed by a vision model before OCR
//   (visionTranscriber.ts), billed as `file_search/vision` to the caller.
// - Pages: a paged format's chunks (PDF; registry isPagedFile) carry the pages
//   of their first and last non-whitespace character (pages.ts), for both
//   strategies, computed beside the chunks — the chunk text is the same with or
//   without them. Every other format's chunks have none (null).
//
// The per-file limit (`limits.max_tokens_per_file`) is checked on the extracted
// text with the words × 1.3 estimate for both strategies, before any chunking:
// the same file is accepted or refused whatever its store's setting, and the
// check stays cheap enough to guard the chunker itself.
import { getDefaultLogger } from '@libs/logger';
import { getFileSearchConfig } from '../services/configService';
import { chunkText, estimateTokens } from './chunker';
import { ChunkingSetting, toStaticChunkingStrategy } from './chunkingSetting';
import { CONTEXT_WRITER_DEFAULTS, ContextWriterSettings, ContextWriterStop, writeChunkContexts } from './contextWriter';
import { ExtractOptions, extractStructuredText, extractText, isPagedFile } from './extractors/registry';
import type { OcrMemo } from './extractors/pdfOcr';
import { VisionMemo, visionModeOf } from './visionTranscriber';
import { isBlank } from './chunkRows';
import { staticChunkPages, structuredChunkPages } from './pages';
import { chunkStructuredOffThread } from './structureChunkThread';
import { completionUsageRecord, emitFileSearchUsage, FileSearchCaller, workerRequestId } from './usage';

const logger = getDefaultLogger();

/** Chunking a file slower than this is logged at info (always at debug). */
const SLOW_CHUNKING_MS = 1000;

/** Thrown when extracted text exceeds `limits.maxTokensPerFile`. Permanent —
 *  the file will never get smaller by retrying. */
export class FileTooLargeError extends Error {
  constructor(readonly tokens: number, readonly maxTokens: number) {
    super(`Extracted text is ~${tokens} tokens, exceeding the configured limit of ${maxTokens} tokens per file`);
    this.name = 'FileTooLargeError';
  }
}

/**
 * The most chunks a file may have: as many as fit 128 MiB of float32 vectors at the embedding
 * dimension (21,845 at 1536), and never fewer than a file at the per-file token limit has at the
 * default 800/400 setting (one chunk per 400 tokens: 12,500 at 5M tokens — so at 3072 and 4000
 * dimensions the ceiling is 12,500, ~146 / ~195 MiB of vectors, within the memory budget). A file
 * the limits let through at the default setting is never refused; only small chunk sizes on a large
 * file reach it, and the message says to choose a larger chunk size. A constant on purpose (no
 * configuration): it bounds what one file can make the gateway hold (the vectors until the commit;
 * memoryBudget.ts). Checked right after chunking — after extraction, so a PDF's OCR and vision pages
 * are already read (and paid) when a file is refused; before any context call and embedding.
 */
export const MAX_VECTOR_BYTES_PER_FILE = 128 * 1024 * 1024;
let vectorBytesPerFile = MAX_VECTOR_BYTES_PER_FILE;

export function maxChunksPerFile(dimensions: number, maxTokensPerFile: number): number {
  const byVectors = Math.floor(vectorBytesPerFile / (Math.max(1, dimensions) * 4));
  return Math.max(byVectors, Math.ceil(Math.max(0, maxTokensPerFile) / 400));
}

/** Test seam: a smaller vector budget per file (null = the constant). */
export function __setVectorBytesPerFileForTests(bytes: number | null): void {
  vectorBytesPerFile = bytes ?? MAX_VECTOR_BYTES_PER_FILE;
}

/** Thrown right after chunking when a file has more chunks than maxChunksPerFile allows, before
 *  any context call or embedding. Permanent — the same file chunks the same way again. */
export class FileHasTooManyChunksError extends Error {
  constructor(readonly chunks: number, readonly maxChunks: number, readonly dimensions: number) {
    super(`The file has ${chunks} chunks, more than the ${maxChunks} a file may have at ${dimensions} embedding dimensions. `
      + 'Choose a larger chunk size (max_tokens) or split the file.');
    this.name = 'FileHasTooManyChunksError';
  }
}

function assertChunkCeiling(chunks: number, dimensions: number, maxTokensPerFile: number): void {
  const max = maxChunksPerFile(dimensions, maxTokensPerFile);
  if (chunks > max) throw new FileHasTooManyChunksError(chunks, max, dimensions);
}

/** The extracted text's size, as the caller's memory reservation needs it. */
export interface ExtractedSize {
  /** UTF-16 units. */
  textChars: number;
  /** The per-file limit's estimate (words × 1.3). */
  estimatedTokens: number;
}

/** How many chunks a text of `estimatedTokens` is expected to give under `setting`, within the
 *  ceiling: one per (max_tokens − overlap) tokens. Structure chunks follow sections and may be more;
 *  the caller grows its reservation by the difference once it knows. */
export function estimatedChunkCount(
  estimatedTokens: number, setting: Pick<ChunkingSetting, 'max_tokens' | 'overlap_tokens'>, maxChunks: number,
): number {
  return Math.min(maxChunks, Math.ceil(Math.max(0, estimatedTokens) / Math.max(1, setting.max_tokens - setting.overlap_tokens)));
}

/** One chunk row as stored (`vector_store_chunks`). */
export interface PreparedChunk {
  ord: number;
  text: string;
  tokens: number;
  /** Structure only (else null): section ordinal, offset in it, heading path. */
  section: number | null;
  sectionOffset: number | null;
  headingPath: string | null;
  /** What the chunk is embedded and full-text matched with besides its text; never returned. */
  context: string | null;
  /** Paged formats only (else null): the pages (from 1) of the chunk's first and last character. */
  pageStart: number | null;
  pageEnd: number | null;
}

/** The context writer's spend on one file, for the job counters. */
export interface ContextTotals {
  model: string;
  /** Input tokens not read from a cache (cache writes included) → fs_jobs.context_input_tokens. */
  input: number;
  /** Input tokens read from a cache → fs_jobs.context_cached_tokens. */
  cachedRead: number;
  output: number;
  /** Chunks left without an LLM context → fs_jobs.context_failed_chunks. */
  failed: number;
  /** Why the writer stopped before trying every chunk (absent when it tried them all) → the file's
   *  context stop (contextStop.ts). */
  stopped?: ContextWriterStop;
}

export interface PreparedFile {
  chunks: PreparedChunk[];
  /** Present when the setting is contextual. */
  context?: ContextTotals;
}

export interface PrepareOptions {
  extractTimeoutMs: number;
  maxTokensPerFile: number;
  /** The caller's deadline (epoch ms): bounds the chunker thread, and the context writer gets
   *  at most half of what is left, so embedding keeps the other half. */
  deadline: number;
  /** Who pays the context calls (null: recorded nowhere, as for embeddings). */
  caller: FileSearchCaller | null;
  /** The largest dimension the chunks will be embedded with: sets the chunk ceiling (maxChunksPerFile). */
  embeddingDimensions: number;
  /** Called once the text is extracted and within the per-file limit, before chunking and any context
   *  call: the caller reserves its memory here (memoryBudget.ts) and may wait. */
  onExtracted?: (text: ExtractedSize) => Promise<void>;
  signal?: AbortSignal;
  /** PDF OCR reuse within one ingestion (a re-chunk extracts the file once per setting): the
   *  caller's memo and the blob's sha256. The OCR budget comes from `deadline`. */
  ocr?: { memo: OcrMemo; sha256: string };
  /** PDF vision reuse within one ingestion, like `ocr` (keyed by `ocr.sha256`). Whether vision runs
   *  at all is the setting's `vision` mode (visionModeOf; absent = off); its calls are billed to
   *  `caller` as `file_search/vision`, like the contexts. */
  vision?: { memo: VisionMemo };
}


/** The stored context of a structured chunk: heading path line, LLM sentence(s), table header — those present. */
export function chunkContext(
  headingPath: string | null | undefined, sentence: string | null | undefined, tableHeader?: string | null,
): string | null {
  const parts = [headingPath, sentence, tableHeader].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return parts.length > 0 ? parts.join('\n') : null;
}

function contextDeadlineMs(deadline: number): number {
  let configured: unknown;
  try {
    configured = getFileSearchConfig().contextual?.fileDeadlineMs;
  } catch {
    configured = undefined;
  }
  const base = typeof configured === 'number' && Number.isInteger(configured) && configured > 0
    ? configured : CONTEXT_WRITER_DEFAULTS.fileDeadlineMs;
  return Math.max(1, Math.min(base, Math.floor((deadline - Date.now()) / 2)));
}

/** Extract, chunk and (when contextual) contextualise one file by `setting`. Throws on an
 *  extraction failure, an oversized file or a chunker failure; a context failure never throws. */
export async function prepareFileChunks(
  filename: string, bytes: Buffer, setting: ChunkingSetting, opts: PrepareOptions,
): Promise<PreparedFile> {
  if (setting.type === 'static') {
    const text = await extractText(filename, bytes, extractOptions(opts, setting));
    const estimatedTokens = assertWithinLimit(text, opts.maxTokensPerFile);
    await opts.onExtracted?.({ textChars: text.length, estimatedTokens });
    const strategy = toStaticChunkingStrategy(setting);
    const staticChunks = chunkText(text, strategy);
    assertChunkCeiling(staticChunks.length, opts.embeddingDimensions, opts.maxTokensPerFile);
    const pages = isPagedFile(filename) ? staticChunkPages(text, strategy) : [];
    const chunks = staticChunks.map((c, i) => ({
      ord: c.ord, text: c.text, tokens: c.tokens, section: null, sectionOffset: null, headingPath: null, context: null,
      pageStart: pages[i]?.first ?? null, pageEnd: pages[i]?.last ?? null,
    }));
    return { chunks };
  }

  const { text, format } = await extractStructuredText(filename, bytes, extractOptions(opts, setting));
  const estimatedTokens = assertWithinLimit(text, opts.maxTokensPerFile);
  await opts.onExtracted?.({ textChars: text.length, estimatedTokens });
  const structured = await chunkStructuredOffThread(
    text,
    { maxTokens: setting.max_tokens, overlapTokens: setting.overlap_tokens, format },
    { countDocument: setting.contextual, timeoutMs: Math.max(1, opts.deadline - Date.now()) },
  );
  assertChunkCeiling(structured.chunks.length, opts.embeddingDimensions, opts.maxTokensPerFile);
  const timing = { chars: text.length, chunks: structured.chunks.length, ms: structured.elapsedMs, offThread: structured.offThread };
  if (structured.elapsedMs >= SLOW_CHUNKING_MS) logger.info('FileSearchChunking', 'Chunked a large file', timing);
  else logger.debug('FileSearchChunking', 'Chunked a file', timing);

  // Index-aligned with structured.chunks; whitespace-only chunks are never sent to the writer.
  const sentences: Array<string | null> = structured.chunks.map(() => null);
  let context: ContextTotals | undefined;
  if (setting.contextual) {
    const wanted = structured.chunks.map((c, i) => i).filter((i) => !isBlank(structured.chunks[i].text));
    const { caller } = opts;
    const settings: Partial<ContextWriterSettings> = { fileDeadlineMs: contextDeadlineMs(opts.deadline) };
    const result = await writeChunkContexts(text, wanted.map((i) => ({
      text: structured.chunks[i].text,
      headingPath: structured.chunks[i].headingPath,
      tableHeader: structured.chunks[i].tableHeader,
      start: structured.starts[i],
    })), {
      settings,
      documentTokens: structured.documentTokens,
      signal: opts.signal,
      // One usage event per call that spent tokens, billed like the file's embeddings.
      onCall: (r) => emitFileSearchUsage(caller, {
        ...completionUsageRecord('file_search/context', r.model, r.usage, r.elapsedMs),
        requestId: workerRequestId('context'),
      }),
    });
    wanted.forEach((chunkIndex, k) => { sentences[chunkIndex] = result.contexts[k]; });
    context = {
      model: result.model, input: result.usage.input, cachedRead: result.usage.cachedRead,
      output: result.usage.output, failed: result.failed, ...(result.stopped ? { stopped: result.stopped } : {}),
    };
  }

  const pages = isPagedFile(filename) ? structuredChunkPages(text, structured.chunks, structured.starts) : [];
  const chunks = structured.chunks.map((c, ord) => ({
    ord,
    text: c.text,
    tokens: c.tokens,
    section: c.section,
    sectionOffset: c.sectionOffset,
    headingPath: c.headingPath,
    context: isBlank(c.text) ? null : chunkContext(c.headingPath, sentences[ord], c.tableHeader),
    pageStart: pages[ord]?.first ?? null,
    pageEnd: pages[ord]?.last ?? null,
  }));
  return context ? { chunks, context } : { chunks };
}

function extractOptions(opts: PrepareOptions, setting: ChunkingSetting): ExtractOptions {
  const mode = visionModeOf(setting);
  const { caller } = opts;
  return {
    timeoutMs: opts.extractTimeoutMs,
    ocr: { ...opts.ocr, deadline: opts.deadline },
    ...(mode === 'off' ? {} : {
      vision: {
        mode,
        memo: opts.vision?.memo,
        sha256: opts.ocr?.sha256,
        deadline: opts.deadline,
        signal: opts.signal,
        // One usage event per call that spent tokens, billed like the file's contexts.
        onCall: (r) => emitFileSearchUsage(caller, {
          ...completionUsageRecord('file_search/vision', r.model, r.usage, r.elapsedMs),
          requestId: workerRequestId('vision'),
        }),
      },
    }),
  };
}

function assertWithinLimit(text: string, maxTokensPerFile: number): number {
  const totalTokens = estimateTokens(text);
  if (totalTokens > maxTokensPerFile) throw new FileTooLargeError(totalTokens, maxTokensPerFile);
  return totalTokens;
}
