/**
 * The context writer for contextual chunking: one model call per chunk writes one or two
 * sentences that place the chunk in its document; ingestion stores them beside the chunk and
 * searches them with it. Settings: `file_search.contextual` (configService). Whether a store
 * uses contexts at all is the store's chunking setting, not this module's business.
 *
 * Each call (orchestrationCompletion.ts):
 *   system   — CONTEXT_SYSTEM_PROMPT, fixed;
 *   message 1 — the document, `<document>…</document>`, identical for every chunk of a file, so
 *               a model with prompt caching reads it from the cache after the first call
 *               (Claude gets an explicit breakpoint on it; OpenAI-family and Gemini cache a
 *               repeated prefix on their own);
 *   message 2 — the chunk's heading path and table header (when it has them) and the chunk.
 *
 * Window rule. A document of at most `maxDocumentTokens` tokens is sent whole. A longer one is
 * cut into FIXED windows of `maxDocumentTokens` worth of characters (the document's own
 * characters-per-token ratio), each starting half a window after the previous one, the last
 * one ending at the document's end; each window is snapped to whole lines. A chunk gets the
 * window whose middle is nearest the chunk's middle: it contains every chunk up to half a
 * window long, and consecutive chunks share a window, so the cache still works per window.
 *
 * Best-effort (plan decision Q7): a failed, timed-out, empty or truncated call leaves that chunk
 * without a context and counts it; the writer never throws and never fails a file. It stops
 * early — the remaining chunks counted as failed — when no deployment exists, when the first few
 * calls all failed (the model is most likely not served), after max(4, 2 × concurrency)
 * failures in a row (an outage mid-file), at the soft per-file deadline or once the file has spent
 * `maxInputTokensPerFile` input tokens (calls in flight finish, no new one starts), or when the
 * caller's signal aborts. `estimateContextTokens` predicts a file's spend by the same rule.
 *
 * The first chunk runs alone, so its call writes the cache before the rest read it; then at
 * most `concurrency` calls run at once. Never logs document, chunk or context text.
 */
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import { countTokens } from './structureChunker';
import {
  CompletionCall, CompletionError, CompletionResult, CompletionUsage, orchestrationComplete,
} from './orchestrationCompletion';

const logger = getDefaultLogger();

export interface ContextWriterSettings {
  model: string;
  /** Largest document sent whole; a longer one is sent as a window of this many tokens. */
  maxDocumentTokens: number;
  /** Calls in flight at once, after the first. */
  concurrency: number;
  /** Timeout of one call. */
  requestTimeoutMs: number;
  /** Soft deadline for one file, from the writer's start. */
  fileDeadlineMs: number;
  /** Input tokens (cached reads included) one file may spend; no call starts once they are spent. */
  maxInputTokensPerFile: number;
}

export const CONTEXT_WRITER_DEFAULTS: Readonly<ContextWriterSettings> = Object.freeze({
  model: 'gemini-3.5-flash-lite',
  maxDocumentTokens: 32000,
  concurrency: 4,
  requestTimeoutMs: 30000,
  fileDeadlineMs: 360000,
  maxInputTokensPerFile: 20000000,
});

/** A chunk as the structure chunker produces it; `start` = its offset in the document, when known. */
export interface ContextChunk {
  text: string;
  headingPath?: string | null;
  tableHeader?: string;
  start?: number;
}

export interface ContextCallRecord {
  model: string;
  usage: CompletionUsage;
  elapsedMs: number;
}

export interface ContextWriterOptions {
  settings?: Partial<ContextWriterSettings>;
  /** The document's token count, when the caller has it (else counted here). */
  documentTokens?: number;
  signal?: AbortSignal;
  /** Called once per call that spent tokens (a success, or an empty reply); for usage events. */
  onCall?: (record: ContextCallRecord) => void;
  /** Test seam; default orchestrationComplete. */
  complete?: (call: CompletionCall) => Promise<CompletionResult>;
  /** Test seam; default Date.now. */
  now?: () => number;
}

export type ContextWriterStop = 'deadline' | 'budget' | 'no_deployment' | 'failing' | 'aborted';

export interface ContextWriterResult {
  /** Index-aligned with the chunks; null = no context for that chunk. */
  contexts: Array<string | null>;
  /** Chunks left without a context (= the nulls in `contexts`). */
  failed: number;
  /** Sum over all calls, in orchestrationCompletion.ts's split. */
  usage: CompletionUsage;
  model: string;
  /** Why the writer stopped before trying every chunk; absent when it tried them all. */
  stopped?: ContextWriterStop;
}

export const CONTEXT_SYSTEM_PROMPT =
  'You write short contexts for chunks of a document, to improve search retrieval of each chunk. ' +
  'Given the document (or an excerpt of it) and one chunk, reply with one or two sentences, in the ' +
  "document's language, that situate the chunk within the document: what it is about and where it " +
  'belongs. Reply with the context only: no preamble, no quotes, no lists, no markdown.';

const CHUNK_INSTRUCTION =
  'Give a short succinct context to situate this chunk within the overall document for the purposes ' +
  'of improving search retrieval of the chunk. Answer only with the succinct context and nothing else.';

/** Upper bound of one reply, in tokens (two sentences need far less). */
const MAX_OUTPUT_TOKENS = 200;
/** Upper bound of a stored context, in characters. */
export const MAX_CONTEXT_CHARS = 600;
/** Calls that may fail before any succeeded, before the writer gives up on the file. */
const FAILURES_BEFORE_GIVING_UP = 3;
/** Consecutive failures after which the writer gives up even after successes (an outage or a 429
 *  storm in the middle of a file): 2 per concurrent slot, at least MIN_CONSECUTIVE_FAILURES. */
const CONSECUTIVE_FAILURES_PER_SLOT = 2;
const MIN_CONSECUTIVE_FAILURES = 4;
/** A window edge moves to a line boundary only within this share of the window. */
const SNAP_SHARE = 0.1;

const positiveInt = (v: unknown, fallback: number, min = 1): number =>
  (typeof v === 'number' && Number.isInteger(v) && v >= min ? v : fallback);

function resolveSettings(override?: Partial<ContextWriterSettings>): ContextWriterSettings {
  let configured: Partial<ContextWriterSettings> = {};
  try {
    configured = configService.getFileSearchConfig().contextual ?? {};
  } catch {
    configured = {};
  }
  const raw = { ...configured, ...(override ?? {}) };
  const d = CONTEXT_WRITER_DEFAULTS;
  return {
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : d.model,
    maxDocumentTokens: positiveInt(raw.maxDocumentTokens, d.maxDocumentTokens),
    concurrency: positiveInt(raw.concurrency, d.concurrency),
    requestTimeoutMs: positiveInt(raw.requestTimeoutMs, d.requestTimeoutMs),
    fileDeadlineMs: positiveInt(raw.fileDeadlineMs, d.fileDeadlineMs),
    maxInputTokensPerFile: positiveInt(raw.maxInputTokensPerFile, d.maxInputTokensPerFile),
  };
}

/** The fixed windows (character spans) of a document of `length` chars for windows of `size` chars. */
export function documentWindows(length: number, size: number): Array<{ start: number; end: number }> {
  if (length <= size) return [{ start: 0, end: length }];
  const stride = Math.max(1, Math.floor(size / 2));
  const n = 1 + Math.ceil((length - size) / stride);
  const out: Array<{ start: number; end: number }> = [];
  for (let k = 0; k < n; k++) {
    const start = Math.min(k * stride, length - size);
    out.push({ start, end: start + size });
  }
  return out;
}

function snapToLines(doc: string, start: number, end: number): string {
  const slack = Math.floor((end - start) * SNAP_SHARE);
  let s = start;
  if (s > 0) {
    const nl = doc.indexOf('\n', s - 1);
    if (nl !== -1 && nl + 1 - s <= slack && nl + 1 < end) s = nl + 1;
  }
  let e = end;
  if (e < doc.length) {
    const nl = doc.lastIndexOf('\n', e);
    if (nl !== -1 && e - nl <= slack && nl > s) e = nl;
  }
  return doc.slice(s, e);
}

/** The document message for each chunk, by the window rule in this file's header. */
function documentMessages(document: string, chunks: ContextChunk[], documentTokens: number, maxTokens: number): string[] {
  if (documentTokens <= maxTokens) {
    const whole = `<document>\n${document}\n</document>`;
    return chunks.map(() => whole);
  }
  const size = Math.max(1, Math.floor(maxTokens * (document.length / Math.max(1, documentTokens))));
  const windows = documentWindows(document.length, size);
  const stride = Math.max(1, Math.floor(size / 2));
  const cache = new Map<number, string>();
  let cursor = 0;
  return chunks.map((chunk) => {
    let start = typeof chunk.start === 'number' && document.startsWith(chunk.text, chunk.start) ? chunk.start : -1;
    if (start < 0) start = document.indexOf(chunk.text, cursor);
    if (start < 0) start = document.indexOf(chunk.text);
    if (start < 0) start = Math.min(cursor, document.length);
    else cursor = start + 1;
    const middle = start + chunk.text.length / 2;
    const k = Math.min(windows.length - 1, Math.max(0, Math.round((middle - size / 2) / stride)));
    let message = cache.get(k);
    if (message === undefined) {
      message = `<document_excerpt>\n${snapToLines(document, windows[k].start, windows[k].end)}\n</document_excerpt>`;
      cache.set(k, message);
    }
    return message;
  });
}

function chunkMessage(chunk: ContextChunk): string {
  const parts: string[] = [];
  if (chunk.headingPath) parts.push(`Section: ${chunk.headingPath}`);
  if (chunk.tableHeader) parts.push(`Table header:\n${chunk.tableHeader}`);
  parts.push(`Here is the chunk we want to situate within the whole document:\n<chunk>\n${chunk.text}\n</chunk>`);
  parts.push(CHUNK_INSTRUCTION);
  return parts.join('\n\n');
}

const WRAPPING_QUOTES: Array<[string, string]> = [['"', '"'], ["'", "'"], ['“', '”'], ['„', '“'], ['«', '»'], ['`', '`']];
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“„«(])/u;

/** A model reply → the stored context: one or two sentences of plain text, at most MAX_CONTEXT_CHARS. Null when nothing is left. */
export function sanitizeContext(reply: string): string | null {
  let text = reply
    .split(/\r?\n/)
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/, ''))
    .join('\n');
  text = text.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^context\s*:\s*/i, '');
  for (let changed = true; changed;) {
    changed = false;
    for (const [open, close] of WRAPPING_QUOTES) {
      if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, text.length - close.length).trim();
        changed = true;
      }
    }
  }
  if (!text) return null;
  const sentences = text.split(SENTENCE_BREAK);
  if (sentences.length > 2) text = sentences.slice(0, 2).join(' ');
  if (text.length > MAX_CONTEXT_CHARS) {
    const cut = text.slice(0, MAX_CONTEXT_CHARS + 1);
    const space = cut.lastIndexOf(' ');
    text = (space > 0 ? cut.slice(0, space) : cut.slice(0, MAX_CONTEXT_CHARS)).trim();
  }
  return text || null;
}

/** Tokens one call adds besides the document and the chunk: instruction, framing, a heading line. */
const HEADING_ALLOWANCE_TOKENS = 20;
let promptOverheadTokens: number | undefined;
function promptOverhead(): number {
  if (promptOverheadTokens === undefined) {
    promptOverheadTokens = countTokens(CONTEXT_SYSTEM_PROMPT)
      + countTokens(chunkMessage({ text: '' }))
      + countTokens('<document_excerpt>\n\n</document_excerpt>')
      + HEADING_ALLOWANCE_TOKENS;
  }
  return promptOverheadTokens;
}

export interface ContextTokenEstimate {
  /** Input tokens the file's context calls send (cached reads included: the prompt as sent). */
  input: number;
  /** Output tokens at most (every call at the reply limit). */
  outputUpperBound: number;
  /** Calls the estimate counts (fewer than the chunks when the per-file input ceiling stops it). */
  calls: number;
}

/**
 * What writing contexts for one file costs, by the writer's own rule, for an estimate shown before
 * a (re-)chunk: each call sends the document (whole when it fits `maxDocumentTokens`, else a window
 * of that size), its chunk (the chunks together are about the document) and a fixed overhead; the
 * per-file input ceiling caps the calls. Pure; `settings` default to the writer's defaults.
 */
export function estimateContextTokens(
  documentTokens: number, chunkCount: number, settings: Partial<ContextWriterSettings> = {},
): ContextTokenEstimate {
  if (!(chunkCount > 0) || !(documentTokens >= 0)) return { input: 0, outputUpperBound: 0, calls: 0 };
  const d = CONTEXT_WRITER_DEFAULTS;
  const maxDocumentTokens = positiveInt(settings.maxDocumentTokens, d.maxDocumentTokens);
  const ceiling = positiveInt(settings.maxInputTokensPerFile, d.maxInputTokensPerFile);
  const perCall = Math.min(documentTokens, maxDocumentTokens) + promptOverhead() + documentTokens / chunkCount;
  const calls = Math.min(chunkCount, Math.ceil(ceiling / perCall));
  return { input: Math.round(calls * perCall), outputUpperBound: calls * MAX_OUTPUT_TOKENS, calls };
}

const addUsage = (a: CompletionUsage, b: CompletionUsage): CompletionUsage => ({
  input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cachedRead: a.cachedRead + b.cachedRead, output: a.output + b.output,
});

/** How long `checkContextModel` waits for its one call. */
const MODEL_CHECK_TIMEOUT_MS = 15_000;

/**
 * Whether the configured context model answers a context call, asked with one tiny call (the
 * writer's own system prompt and parameters, a few tokens; `onCall` records what it spent).
 * 'unavailable': no orchestration deployment, or the call was refused (HTTP 400, 404 or 422 —
 * the model is not served, or refuses the writer's parameters), so every context call would
 * fail too. 'unknown': a timeout, a 429 or 5xx, a network error; the caller may go on. A reply
 * of any kind, an empty or truncated one included, is 'served'.
 */
export async function checkContextModel(opts: Pick<ContextWriterOptions, 'onCall' | 'complete'> = {}): Promise<{
  model: string; result: 'served' | 'unavailable' | 'unknown';
}> {
  const { model } = resolveSettings();
  const complete = opts.complete ?? orchestrationComplete;
  const record = (usage: CompletionUsage, elapsedMs: number) => {
    try {
      opts.onCall?.({ model, usage, elapsedMs });
    } catch (error: any) {
      logger.warn('ContextWriter', `Context usage sink failed and was ignored: ${error?.message}`);
    }
  };
  const started = Date.now();
  try {
    const reply = await complete({
      model,
      system: CONTEXT_SYSTEM_PROMPT,
      messages: [{ text: '<document>\nModel check.\n</document>' }, { text: chunkMessage({ text: 'Model check.' }) }],
      params: { temperature: 0, max_tokens: MAX_OUTPUT_TOKENS },
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

/**
 * Write a context for every chunk of `document`. Resolves with one entry per chunk (null where
 * none was written), the failed count, the token totals and why it stopped early, if it did.
 * Never rejects.
 */
export async function writeChunkContexts(
  document: string, chunks: ContextChunk[], opts: ContextWriterOptions = {},
): Promise<ContextWriterResult> {
  const settings = resolveSettings(opts.settings);
  const contexts: Array<string | null> = chunks.map(() => null);
  let usage: CompletionUsage = { input: 0, cacheWrite: 0, cachedRead: 0, output: 0 };
  if (chunks.length === 0) return { contexts, failed: 0, usage, model: settings.model };

  const complete = opts.complete ?? orchestrationComplete;
  const now = opts.now ?? Date.now;
  const started = now();
  let stopped: ContextWriterStop | undefined;
  let successes = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  const consecutiveLimit = Math.max(MIN_CONSECUTIVE_FAILURES, CONSECUTIVE_FAILURES_PER_SLOT * settings.concurrency);

  let docMessages: string[];
  try {
    const documentTokens = opts.documentTokens ?? countTokens(document);
    docMessages = documentMessages(document, chunks, documentTokens, settings.maxDocumentTokens);
  } catch (error: any) {
    logger.warn('ContextWriter', 'Could not prepare the document; no contexts for this file', { error: error?.message });
    return { contexts, failed: chunks.length, usage, model: settings.model };
  }

  const record = (u: CompletionUsage, elapsedMs: number) => {
    usage = addUsage(usage, u);
    if (!opts.onCall) return;
    try {
      opts.onCall({ model: settings.model, usage: u, elapsedMs });
    } catch (error: any) {
      logger.warn('ContextWriter', `Context usage sink failed and was ignored: ${error?.message}`);
    }
  };

  const shouldStop = (): boolean => {
    if (stopped) return true;
    if (opts.signal?.aborted) stopped = 'aborted';
    else if (now() - started >= settings.fileDeadlineMs) stopped = 'deadline';
    else if (usage.input + usage.cachedRead >= settings.maxInputTokensPerFile) stopped = 'budget';
    else if (successes === 0 && failures >= FAILURES_BEFORE_GIVING_UP) stopped = 'failing';
    else if (consecutiveFailures >= consecutiveLimit) stopped = 'failing';
    return stopped !== undefined;
  };

  const runOne = async (i: number): Promise<void> => {
    const callStarted = now();
    try {
      const result = await complete({
        model: settings.model,
        system: CONTEXT_SYSTEM_PROMPT,
        messages: [{ text: docMessages[i] }, { text: chunkMessage(chunks[i]) }],
        params: { temperature: 0, max_tokens: MAX_OUTPUT_TOKENS },
        timeoutMs: settings.requestTimeoutMs,
        signal: opts.signal,
      });
      record(result.usage, result.elapsedMs);
      const context = sanitizeContext(result.text);
      if (context) {
        contexts[i] = context;
        successes++;
        consecutiveFailures = 0;
      } else {
        failures++;
        consecutiveFailures++;
      }
    } catch (error: any) {
      failures++;
      consecutiveFailures++;
      if (error instanceof CompletionError) {
        if (error.usage) record(error.usage, now() - callStarted);
        if (error.reason === 'no_deployment') stopped = 'no_deployment';
        if (error.reason === 'aborted') stopped = 'aborted';
      }
      logger.debug('ContextWriter', 'Context call failed; the chunk stays without a context', {
        reason: error?.reason ?? 'error', status: error?.status,
      });
    }
  };

  let next = 0;
  if (!shouldStop()) await runOne(next++);
  const worker = async () => {
    while (next < chunks.length && !shouldStop()) {
      // eslint-disable-next-line no-await-in-loop
      await runOne(next++);
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, chunks.length) }, worker));

  const failed = contexts.filter((c) => c === null).length;
  const summary = {
    model: settings.model, chunks: chunks.length, failed, stopped,
    inputTokens: usage.input, cachedTokens: usage.cachedRead, outputTokens: usage.output,
  };
  if (stopped === 'no_deployment' || stopped === 'failing' || stopped === 'budget') {
    logger.warn('ContextWriter', 'Context writer gave up on this file; its chunks are stored without contexts', summary);
  } else if (failed > 0) {
    logger.info('ContextWriter', 'Some chunks were stored without a context', summary);
  } else {
    logger.debug('ContextWriter', 'Contexts written', summary);
  }
  return { contexts, failed, usage, model: settings.model, ...(stopped ? { stopped } : {}) };
}
