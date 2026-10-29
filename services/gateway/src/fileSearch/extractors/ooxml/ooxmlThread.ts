// Runs the PowerPoint/Excel reader in a worker thread with a hard wall-clock limit and a heap limit.
//
// The reader's caps bound its work and it yields between slices, but each round of review found
// another synchronous step a crafted 2–3 KB file could stretch. In a worker such a step can only
// slow that thread: the gateway's event loop stays free, a file past its time limit is stopped
// (terminate()), and one that needs more heap than READER_RESOURCE_LIMITS allows ends the thread,
// not the gateway.
//
// Same pattern as structureChunkThread.ts: one thread per gateway process, started on first use,
// files queued and sent one at a time, the time limit armed when the started thread takes the file
// (timeoutMs + TIMER_GRACE_MS, so the reader's own deadline normally reports first). The thread
// says `ready` once its reader has loaded; a missing entry file (warned once, then always
// in-process), a load failure, or no `ready` within READY_TIMEOUT_MS counts as a failed start: the
// file is read in-process (the reader's own slicing and deadline) and a new start is tried after a
// back-off (1 s, doubling to 60 s). The thread is unref'd while idle.
//
// Outcomes: the reader's DocumentReadError / ExtractionTimeoutError come back as such; the hard
// limit is an ExtractionTimeoutError (transient, like a pandoc timeout: the retry budget ends a file
// that always times out as failed); running out of the heap limit is a DocumentReadError
// (permanent: a retry needs the same memory); a thread that dies otherwise fails that file
// transiently. The file's bytes are copied once into a buffer that is transferred (the caller's
// buffer stays usable: a re-chunk reads the same bytes twice).
import * as fs from 'fs';
import * as path from 'path';
import { ResourceLimits, Worker } from 'worker_threads';
import { getDefaultLogger } from '@libs/logger';
import { ExtractionTimeoutError } from '../runners';
import { DocumentReadError, OoxmlKind, OoxmlLimits } from './limits';
import { readPptx } from './pptx';
import { readXlsx } from './xlsx';
import type { OfficeReadReply, OfficeReadRequest } from './ooxmlWorker';
import { workerHeapLimitMb } from '../../heapLimit';

const logger = getDefaultLogger();

export type OfficeFormat = 'pptx' | 'xlsx';

/**
 * The reader thread's old-generation heap, in MB: a fifth of the memory the process may use
 * (process.constrainedMemory(): the container's limit), between 256 and 384 MB; 384 when no
 * limit is known. The heap a read needs grows with its cells and distinct strings, not with its
 * output: the heaviest plausible workbook (500 000 cells, all distinct ~90-character shared strings,
 * 31 MiB) peaked at 276 MB of heap, read at 256 MB and failed at 192 MB. So the floor still reads
 * it, and the ceiling keeps the thread at under a fifth of a 2 GiB gateway (Kyma's limit), whose
 * own heap is not capped.
 */
export function readerHeapLimitMb(constrained: number | undefined = process.constrainedMemory?.()): number {
  return workerHeapLimitMb(constrained); // heapLimit.ts, shared with the structure chunker
}

/** The reader thread's limits (see readerHeapLimitMb); running out fails the file permanently. */
export const READER_RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  maxOldGenerationSizeMb: readerHeapLimitMb(),
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
});

const TIMER_GRACE_MS = 1000;
const START_BACKOFF_MAX_MS = 60_000;

const KIND: Record<OfficeFormat, OoxmlKind> = { pptx: 'PowerPoint', xlsx: 'Excel' };

export interface OfficeReadOptions {
  timeoutMs?: number;
  /** Test seam: tighter reader limits. */
  limits?: Partial<OoxmlLimits>;
}

interface Job {
  format: OfficeFormat;
  bytes: Buffer;
  opts: OfficeReadOptions;
  resolve: (text: string) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

interface Thread { worker: Worker; ready: boolean; readyTimer?: NodeJS.Timeout }

let startBackoffBaseMs = 1000;
let readyTimeoutMs = 30_000;
/** How long the queue waits for a stopped thread to end before it goes on without the answer. */
let terminateWaitMs = 5000;
let resourceLimits: ResourceLimits = READER_RESOURCE_LIMITS;
let thread: Thread | null = null;
let current: Job | null = null;
const queue: Job[] = [];
let entryMissing = false;
let startFailures = 0;
let nextStartAt = 0;
let entryOverride: string | null = null;
let lastRunOnThread = false;
/** A stopped thread still ending: no new thread starts until it has. */
let stopping: Promise<unknown> | null = null;

function workerEntry(): string {
  if (entryOverride) return entryOverride;
  return path.join(__dirname, `ooxmlWorker.${__filename.endsWith('.ts') ? 'ts' : 'js'}`);
}

function inProcess(job: Job): void {
  lastRunOnThread = false;
  const read = job.format === 'pptx' ? readPptx : readXlsx;
  read(job.bytes, job.opts).then(job.resolve, job.reject);
}

function ensureThread(): Thread | null {
  if (thread) return thread;
  if (entryMissing || Date.now() < nextStartAt) return null;
  const entry = workerEntry();
  if (!fs.existsSync(entry)) {
    entryMissing = true;
    logger.warn('OfficeReader', `The reader thread's file ${entry} is missing; reading Office files in-process`);
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
      if (current) send(t, current);
      return;
    }
    if (!current) return;
    const job = current;
    current = null;
    if (job.timer) clearTimeout(job.timer);
    settle(job, msg as OfficeReadReply);
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
      job.reject(new DocumentReadError(KIND[job.format],
        `it needs more memory than the reader may use (${resourceLimits.maxOldGenerationSizeMb} MB)`));
    } else if (!t.ready) {
      startFailed(error);
      if (job) queue.unshift(job);
    } else if (job) {
      logger.warn('OfficeReader', `The reader thread failed on a file: ${error.message}`);
      job.reject(error);
    }
    pump();
  };
  worker.on('error', (error) => ended(error));
  worker.on('exit', (code) => ended(new Error(`The reader thread exited (code ${code})`)));
  worker.unref();
  return t;
}

function settle(job: Job, reply: OfficeReadReply): void {
  lastRunOnThread = true;
  if (reply.ok) job.resolve(reply.text);
  else if (reply.error === 'document') job.reject(new DocumentReadError(reply.kind, reply.reason));
  else if (reply.error === 'timeout') job.reject(new ExtractionTimeoutError(`the ${KIND[job.format]} reader`, job.opts.timeoutMs ?? 0));
  else job.reject(new Error(reply.message));
}

function startFailed(error: Error): void {
  startFailures += 1;
  const backoff = Math.min(START_BACKOFF_MAX_MS, startBackoffBaseMs * 2 ** (startFailures - 1));
  nextStartAt = Date.now() + backoff;
  logger.warn('OfficeReader', `The reader thread could not start (${error.message}); reading in-process, next try in ${backoff} ms`);
}

/** Hands the job to the ready thread and arms its hard limit. */
function send(t: Thread, job: Job): void {
  const copy = new ArrayBuffer(job.bytes.length);
  new Uint8Array(copy).set(job.bytes);
  const request: OfficeReadRequest = { format: job.format, bytes: copy, timeoutMs: job.opts.timeoutMs, limits: job.opts.limits };
  t.worker.postMessage(request, [copy]);
  if (job.opts.timeoutMs === undefined) return;
  const limitMs = Math.max(1, job.opts.timeoutMs) + TIMER_GRACE_MS;
  job.timer = setTimeout(() => {
    if (current !== job || thread !== t) return;
    current = null;
    thread = null;
    lastRunOnThread = true;
    logger.warn('OfficeReader', `Stopped the reader thread: a file ran past ${limitMs} ms`);
    job.reject(new ExtractionTimeoutError(`the ${KIND[job.format]} reader`, job.opts.timeoutMs ?? limitMs));
    // The queued files go to a fresh thread once the old one has ended: never two readers' heaps at once.
    // A terminate that never settles must not park the Office queue for good: wait a few seconds, then go on.
    stopping = Promise.race([t.worker.terminate().catch(() => 0), new Promise<void>((resolve) => setTimeout(resolve, terminateWaitMs).unref())]).then(() => {
      stopping = null;
      pump();
    });
  }, limitMs);
  job.timer.unref();
}

function pump(): void {
  if (stopping) return; // resumes when the old thread has ended
  while (!current && queue.length > 0) {
    const t = ensureThread();
    if (!t) {
      inProcess(queue.shift()!);
      continue;
    }
    const job = queue.shift()!;
    current = job;
    t.worker.ref();
    if (t.ready) send(t, job);
    return;
  }
  if (!current && thread) thread.worker.unref();
}

/** The Office file's Markdown (pptx.ts / xlsx.ts), read in the reader thread. */
export function readOfficeOffThread(format: OfficeFormat, bytes: Buffer, opts: OfficeReadOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    queue.push({ format, bytes, opts, resolve, reject });
    pump();
  });
}

/** Stops the reader thread (shutdown, tests). The file in it and every queued file reject. */
export async function closeOfficeReaderThread(): Promise<void> {
  const t = thread;
  thread = null;
  const job = current;
  current = null;
  if (job) {
    if (job.timer) clearTimeout(job.timer);
    job.reject(new Error('The Office reader was closed'));
  }
  for (const queued of queue.splice(0)) queued.reject(new Error('The Office reader was closed'));
  if (t) {
    if (t.readyTimer) clearTimeout(t.readyTimer);
    await t.worker.terminate();
  }
}

/** Test seam: another worker entry (null = the default), back-off base, ready limit, heap limits,
 *  and a fresh state; `lastRunOnThread` tells whether the last settled file ran in the thread. */
export function __configureForTests(opts: {
  entry?: string | null; startBackoffMs?: number; readyTimeoutMs?: number; resourceLimits?: ResourceLimits; terminateWaitMs?: number;
}): void {
  if (opts.entry !== undefined) entryOverride = opts.entry;
  if (opts.startBackoffMs !== undefined) startBackoffBaseMs = opts.startBackoffMs;
  if (opts.readyTimeoutMs !== undefined) readyTimeoutMs = opts.readyTimeoutMs;
  if (opts.resourceLimits !== undefined) resourceLimits = opts.resourceLimits;
  terminateWaitMs = opts.terminateWaitMs ?? 5000;
  entryMissing = false;
  startFailures = 0;
  nextStartAt = 0;
}

export const __lastRunOnThread = (): boolean => lastRunOnThread;
