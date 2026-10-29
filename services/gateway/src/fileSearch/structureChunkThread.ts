// Runs the structure chunker off the main event loop.
//
// chunkStructured is synchronous and CPU-bound: 0.1–3.5 s per MB of extracted
// text (measured in Task 2; mixed whitespace is the slowest), and a plain-text
// file is one section, so yielding between sections would not help. In the
// gateway's process that would stall every request for that long, so ingestion
// chunks in one worker thread, started on first use and kept for the process.
//
// Files wait in a queue here and go to the thread one at a time (the ingest
// loops still extract, write contexts and embed concurrently), so a file's
// time limit starts when the thread starts on it, not while it waits. A file
// over its limit stops the thread and fails alone (transient, retried); the
// files behind it go to a fresh thread. A thread that crashes on a file fails
// that file alone the same way. The thread is unref'd while idle.
//
// If the thread cannot be started — its entry file is missing (warned once,
// then always in-process), or it fails before its chunker has loaded (it posts
// `ready` then; Node's 'online' event comes before a load error) — the files are
// chunked in-process, as before this module existed, up to IN_PROCESS_MAX_CHARS
// (a longer text fails transiently and waits for the thread), and a new start is tried
// after a back-off (1 s, doubling to 60 s), so a passing start failure does not
// disable the thread for good. A thread that neither posts `ready` nor fails
// within READY_TIMEOUT_MS (30 s) counts as a failed start the same way: it is
// stopped and its file runs in-process.
//
// The thread runs with a heap limit (CHUNKER_RESOURCE_LIMITS): a file whose chunking needs more
// fails permanently (StructureChunkOutOfMemoryError: a retry needs the same memory) and ends the
// thread, not the gateway; the files behind it go to a fresh thread. A thread that runs out of
// memory before it is ready fails the file it holds the same way (never in-process).
import * as fs from 'fs';
import * as path from 'path';
import { ResourceLimits, Worker } from 'worker_threads';
import { getDefaultLogger } from '@libs/logger';
import { chunkStructuredWithSections, countTokens, StructuredChunk, StructuredChunkOptions } from './structureChunker';
import { workerHeapLimitMb } from './heapLimit';

const logger = getDefaultLogger();

export interface StructureChunkResult {
  chunks: StructuredChunk[];
  /** Each chunk's offset in the document (UTF-16 units), index-aligned with `chunks`. */
  starts: number[];
  /** countTokens(text), when asked for. */
  documentTokens?: number;
  /** Time spent chunking (in the thread, or in-process). */
  elapsedMs: number;
  offThread: boolean;
}

/** The thread did not finish the file within the caller's time limit; it was stopped. Transient. */
export class StructureChunkTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Chunking the file took longer than ${timeoutMs} ms`);
    this.name = 'StructureChunkTimeoutError';
  }
}

/** No chunker thread is available now and the text is too long to chunk on the event loop
 *  (IN_PROCESS_MAX_CHARS). Transient: the thread is tried again after its back-off. */
export class StructureChunkThreadUnavailableError extends Error {
  constructor(readonly chars: number) {
    super(`The chunker thread is not available; a text of ${chars} characters is not chunked in-process (at most ${IN_PROCESS_MAX_CHARS})`);
    this.name = 'StructureChunkThreadUnavailableError';
  }
}

/**
 * The longest text chunked in-process when no thread is available: 2 Mi characters. In-process
 * chunking blocks every request for its whole run (0.1–3.5 s per MB measured, a one-paragraph text
 * far more: 4 MiB took 120 s) and uses the main heap without the thread's limit (up to ~17 MB a MiB:
 * ~35 MB at the limit). Most documents are well below it (2 Mi characters are ~300,000 words);
 * a longer one waits for the thread (a transient failure, retried).
 */
export const IN_PROCESS_MAX_CHARS = 2 * 1024 * 1024;

/** Chunking the file needed more heap than the chunker thread may use; the thread ended. Permanent. */
export class StructureChunkOutOfMemoryError extends Error {
  constructor(readonly limitMb: number | undefined) {
    super(`Chunking the file needs more memory than the chunker may use (${limitMb ?? '?'} MB)`);
    this.name = 'StructureChunkOutOfMemoryError';
  }
}

/**
 * The chunker thread's old-generation heap, in MB: a fifth of the memory the process may use
 * (process.constrainedMemory(): the container's limit), between 256 and 384 MB; 384 when no limit
 * is known — the Office reader's rule, one helper for both (heapLimit.ts).
 *
 * Sized with scripts/structure-chunk-memory.ts (the compiled worker, the smallest structure chunks
 * 100/50 and a document token count, i.e. the most chunks; smallest passing limit in 16 MB steps):
 * the largest text the limits let through — 32 MiB of Markdown (max_file_bytes; deep headings,
 * 5,000-row tables, a 4 MiB code block, just under the 5M-token estimate) needs 144 MB; 64 MiB (the
 * extractors' output cap, which a compressed document can reach) 192 MB, 304 MB with one character
 * outside Latin-1 (V8 then stores two bytes a character: curly quotes suffice); one 64 MiB "word"
 * without whitespace 320 / 384 MB. So 384 reads all of them. What it refuses: hundreds of thousands
 * of two-line sections need ~17 MB per MiB of text (8 MiB 144 MB, 16 MiB 272 MB), so such a file
 * over ~22 MiB fails permanently instead of taking ~1 GB.
 *
 * The 2 GiB gateway (Kyma's limit): V8 gives the main thread ~1 GB of heap there (measured 1048 MB
 * in a 2 GiB container) and gave this thread the same before it had a limit. Now each of the two
 * threads is at most 384 + 48 MB (heap_size_limit of a 384/32 thread: 432 MB), 864 MB together, and
 * their baseline (tokenizer, reader) is ~30–50 MB of it. That leaves ~1.18 GB for the main heap and
 * everything off-heap (blobs, Buffers, tesseract, ~250–350 MB at worst): enough while the main heap
 * stays under ~0.85 GB. The main heap is not capped below V8's default (no --max-old-space-size):
 * a lower cap would only turn a main-thread peak the pod could hold into a crash. What a file makes
 * the main heap hold is bounded instead: at most maxChunksPerFile chunks (128 MiB of float32
 * vectors, chunkPipeline.ts) and a process-wide reservation of vectors and text while files are
 * embedded (memoryBudget.ts, its own arithmetic).
 */
export function chunkerHeapLimitMb(constrained: number | undefined = process.constrainedMemory?.()): number {
  return workerHeapLimitMb(constrained);
}

/** The chunker thread's limits; running out fails the file permanently. */
export const CHUNKER_RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  maxOldGenerationSizeMb: chunkerHeapLimitMb(),
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
});

interface Job {
  text: string;
  opts: StructuredChunkOptions;
  countDocument: boolean;
  timeoutMs?: number;
  resolve: (r: StructureChunkResult) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

interface Thread {
  worker: Worker;
  /** The worker loaded its chunker and said so (Node's 'online' comes before a load error). */
  ready: boolean;
  /** Runs until `ready`: a thread that never says so is a failed start. */
  readyTimer?: NodeJS.Timeout;
}

const START_BACKOFF_MAX_MS = 60_000;
let startBackoffBaseMs = 1000;
let readyTimeoutMs = 30_000;
let resourceLimits: ResourceLimits = CHUNKER_RESOURCE_LIMITS;

let thread: Thread | null = null;
let current: Job | null = null;
const queue: Job[] = [];
/** The entry file is missing: never try again in this process. */
let entryMissing = false;
let startFailures = 0;
let nextStartAt = 0;
let entryOverride: string | null = null;

/** The worker entry: compiled JavaScript beside this file, or the TypeScript source
 *  (run through ts-node) when this module itself runs from TypeScript (ts-node, ts-jest). */
function workerEntry(): string {
  if (entryOverride) return entryOverride;
  return path.join(__dirname, `structureChunkWorker.${__filename.endsWith('.ts') ? 'ts' : 'js'}`);
}

function inProcess(job: Job): void {
  if (job.text.length > IN_PROCESS_MAX_CHARS) {
    job.reject(new StructureChunkThreadUnavailableError(job.text.length));
    return;
  }
  const started = Date.now();
  try {
    const { chunks, sections } = chunkStructuredWithSections(job.text, job.opts);
    job.resolve({
      chunks,
      starts: chunks.map((c) => sections[c.section].start + c.sectionOffset),
      documentTokens: job.countDocument ? countTokens(job.text) : undefined,
      elapsedMs: Date.now() - started,
      offThread: false,
    });
  } catch (error: any) {
    job.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** A thread, if one runs or may be started now; null = chunk in-process. */
function ensureThread(): Thread | null {
  if (thread) return thread;
  if (entryMissing || Date.now() < nextStartAt) return null;
  const entry = workerEntry();
  if (!fs.existsSync(entry)) {
    entryMissing = true;
    logger.warn('StructureChunker', `The chunker thread's file ${entry} is missing; chunking in-process`);
    return null;
  }
  let worker: Worker;
  try {
    worker = entry.endsWith('.ts')
      ? new Worker(
        `require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });\nrequire(${JSON.stringify(entry)});`,
        { eval: true, resourceLimits },
      )
      : new Worker(entry, { resourceLimits });
  } catch (error: any) {
    startFailed(error);
    return null;
  }
  const t: Thread = { worker, ready: false };
  thread = t;
  t.readyTimer = setTimeout(() => {
    if (thread !== t || t.ready) return;
    thread = null;
    const job = current;
    current = null;
    if (job?.timer) clearTimeout(job.timer);
    startFailed(new Error(`it did not become ready within ${readyTimeoutMs} ms`));
    if (job) queue.unshift(job);
    t.worker.terminate().catch(() => {});
    pump();
  }, readyTimeoutMs);
  t.readyTimer.unref();
  worker.on('message', (msg: any) => {
    if (thread !== t) return;
    if (msg?.ready === true) {
      t.ready = true;
      if (t.readyTimer) clearTimeout(t.readyTimer);
      startFailures = 0;
      if (current) armTimer(current);
      return;
    }
    if (!current) return;
    const job = current;
    current = null;
    if (job.timer) clearTimeout(job.timer);
    if (msg?.ok) {
      job.resolve({
        chunks: msg.chunks, starts: msg.starts, documentTokens: msg.documentTokens, elapsedMs: msg.elapsedMs, offThread: true,
      });
    } else {
      job.reject(new Error(msg?.message ?? 'The chunker thread failed'));
    }
    pump();
  });
  const ended = (error: Error & { code?: string }) => {
    if (t.readyTimer) clearTimeout(t.readyTimer);
    if (thread !== t) return; // stopped on purpose (a timeout, close)
    thread = null;
    const job = current;
    current = null;
    if (job?.timer) clearTimeout(job.timer);
    if (error.code === 'ERR_WORKER_OUT_OF_MEMORY' && job) {
      // Also before `ready`: the file was already posted, and a thread that runs out of memory
      // must not hand it to the main heap instead.
      if (!t.ready) startFailed(error);
      logger.warn('StructureChunker',
        `A file needed more memory than the chunker thread may use (${resourceLimits.maxOldGenerationSizeMb} MB); it fails`);
      job.reject(new StructureChunkOutOfMemoryError(resourceLimits.maxOldGenerationSizeMb));
    } else if (!t.ready) {
      // Failed before its chunker loaded: the thread cannot start (now). Its file runs in-process.
      startFailed(error);
      if (job) queue.unshift(job);
    } else if (job) {
      logger.warn('StructureChunker', `The chunker thread failed on a file: ${error.message}`);
      job.reject(error);
    }
    pump();
  };
  worker.on('error', (error) => ended(error));
  worker.on('exit', (code) => ended(new Error(`The chunker thread exited (code ${code})`)));
  worker.unref();
  return t;
}

function startFailed(error: Error): void {
  startFailures += 1;
  const backoff = Math.min(START_BACKOFF_MAX_MS, startBackoffBaseMs * 2 ** (startFailures - 1));
  nextStartAt = Date.now() + backoff;
  logger.warn('StructureChunker',
    `The chunker thread could not start (${error.message}); chunking in-process, next try in ${backoff} ms`);
}

/** The file's time limit runs from when the (started) thread takes it. */
function armTimer(job: Job): void {
  if (job.timeoutMs === undefined || job.timer) return;
  const t = thread!;
  const timeoutMs = Math.max(1, job.timeoutMs);
  job.timer = setTimeout(() => {
    if (current !== job || thread !== t) return;
    current = null;
    thread = null;
    job.reject(new StructureChunkTimeoutError(timeoutMs));
    t.worker.terminate().catch(() => {});
    pump(); // the queued files go to a fresh thread
  }, timeoutMs);
  job.timer.unref();
}

function pump(): void {
  while (!current && queue.length > 0) {
    const t = ensureThread();
    if (!t) {
      inProcess(queue.shift()!);
      continue;
    }
    const job = queue.shift()!;
    current = job;
    t.worker.ref();
    t.worker.postMessage({ id: 1, text: job.text, opts: job.opts, countDocument: job.countDocument });
    if (t.ready) armTimer(job);
    return;
  }
  if (!current && thread) thread.worker.unref();
}

/**
 * chunkStructured(text, opts) in the chunker thread, with each chunk's document offset and,
 * when `countDocument` is set, the document's token count. Rejects when the thread fails on
 * this file or does not finish it within `timeoutMs` of starting on it (the thread is then
 * stopped and the files behind it go to a fresh one).
 */
export function chunkStructuredOffThread(
  text: string, opts: StructuredChunkOptions, options: { countDocument?: boolean; timeoutMs?: number } = {},
): Promise<StructureChunkResult> {
  return new Promise<StructureChunkResult>((resolve, reject) => {
    queue.push({ text, opts, countDocument: options.countDocument === true, timeoutMs: options.timeoutMs, resolve, reject });
    pump();
  });
}

/** Stops the chunker thread (shutdown, tests). The file in it rejects; queued files stay queued for a next thread. */
export async function closeStructureChunkThread(): Promise<void> {
  const t = thread;
  thread = null;
  const job = current;
  current = null;
  if (job) {
    if (job.timer) clearTimeout(job.timer);
    job.reject(new Error('The chunker thread was stopped'));
  }
  if (t) {
    if (t.readyTimer) clearTimeout(t.readyTimer);
    await t.worker.terminate();
  }
}

/** Test seam: another worker entry (null = the default), the start back-off base, the ready
 *  time limit, the heap limits (a thread started afterwards takes them), and a fresh state. */
export function __configureForTests(opts: {
  entry?: string | null; startBackoffMs?: number; readyTimeoutMs?: number; resourceLimits?: ResourceLimits;
}): void {
  if (opts.entry !== undefined) entryOverride = opts.entry;
  if (opts.startBackoffMs !== undefined) startBackoffBaseMs = opts.startBackoffMs;
  if (opts.readyTimeoutMs !== undefined) readyTimeoutMs = opts.readyTimeoutMs;
  if (opts.resourceLimits !== undefined) resourceLimits = opts.resourceLimits;
  entryMissing = false;
  startFailures = 0;
  nextStartAt = 0;
}

/** Test seam (the memory script): the running thread's Worker, for its heap statistics; null when none runs. */
export const __workerForTests = (): Worker | null => thread?.worker ?? null;
