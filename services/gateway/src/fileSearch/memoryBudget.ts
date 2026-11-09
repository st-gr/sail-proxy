// A process-wide memory reservation for files being chunked and embedded. Ingestion and the
// re-embed/re-chunk worker hold a whole file on the main thread from its extraction to its commit:
// the extracted text, its chunks and the chunks' vectors. Right after extraction — before chunking
// and before any context call — the caller reserves, waiting while the budget is full, the text
// part (textReserveBytes) and an ESTIMATE of the vectors of every chunk set and model the claim will
// embed (chunkPipeline.ts estimatedChunkCount: one chunk per max_tokens − overlap tokens, within the
// chunk ceiling). After chunking it settles each set to the real figure: a smaller one is returned
// at once; a larger one (structure chunks follow sections and may be more) grows the reservation by
// the difference only, without waiting, logged — bounded by the chunk ceiling. So the vectors are
// admitted with the text, nothing is paid for and then thrown away by a wait, and the budget is
// exceeded at most by such differences. A wait is bounded: by the caller's `until` (half of what is
// left of its deadline, so the work keeps the other half — a claim never outlives its lease because
// of a wait) and by the worker's stop signal; either ends it with FileSearchMemoryBusyError, which
// the workers hand back without spending an attempt (like a busy pool, workQueue.ts
// BUSY_HANDBACK_SET) up to MAX_MEMORY_HANDBACKS times per file. Every way out releases (commit,
// failure, stale commit, cancel, out of memory: the callers' finally; a release is idempotent, so a
// catch may release early and the finally again). Waiters are granted in arrival order. A
// reservation larger than the whole budget proceeds when nothing else is held, so no file waits
// forever; the chunk ceiling (chunkPipeline.ts maxChunksPerFile) keeps such a reservation bounded.
//
// The budget: a quarter of process.constrainedMemory() (the container's limit), between 256 MiB and
// 1 GiB; 512 MiB when no limit is known.
//
// Arithmetic, a 2 GiB gateway (Kyma), budget 512 MiB:
// - 1536 dimensions, 4 ingestion loops each on a largest file (64 Mi characters of extracted text —
//   the extractors' output cap — at the ceiling of 21,845 chunks): one file reserves 3 × 128 MiB
//   (its text as UTF-16, its chunks, their embedding inputs) + 21,845 × 1536 × 4 B = 128 MiB of
//   vectors = 512 MiB, the whole budget: the four run from extraction to commit one at a time.
// - 4000 dimensions, 4 files of ~6 Mi characters cut into 100-token chunks (12,500 chunks each, the
//   ceiling): each reserves 36 MiB text + 12,500 × 4000 × 4 ≈ 191 MiB vectors up front ≈ 227 MiB, so
//   two are admitted (454 MiB) and the others wait; a re-chunk's second set doubles a file's estimate.
// A waiting file holds its extracted text only (≤ 128 MiB as UTF-16), not its chunks. Typical files
// (1 MiB of text, ~600 chunks at 1536: ~10 MiB) never wait.
import { FileSearchBusyError } from './dbBusy';

/** A wait for the memory budget ended (its time bound, or the worker stopping): handed back like a busy pool. */
export class FileSearchMemoryBusyError extends FileSearchBusyError {
  constructor(readonly reason: 'timeout' | 'stopping') {
    super();
    this.message = reason === 'timeout'
      ? 'file_search is busy: the memory for this file did not become free in time. It is retried.'
      : 'file_search is stopping: the file waited for memory and is retried later.';
    this.name = 'FileSearchMemoryBusyError';
  }
}

/** Why a claim was handed back: the database pool, or the memory budget. */
export function busyReason(error: FileSearchBusyError): string {
  if (!(error instanceof FileSearchMemoryBusyError)) return 'the database pool is busy';
  return error.reason === 'stopping' ? 'the worker is stopping' : 'the memory budget stayed full';
}

const MiB = 1024 * 1024;
const FLOOR = 256 * MiB;
const CEILING = 1024 * MiB;
const UNKNOWN = 512 * MiB;

export function memoryBudgetBytes(constrained: number | undefined = process.constrainedMemory?.()): number {
  // 0/undefined: no limit known; some Node versions report an unconstrained process as ~2^64.
  if (!constrained || !Number.isFinite(constrained) || constrained > 2 ** 40) return UNKNOWN;
  return Math.min(CEILING, Math.max(FLOOR, Math.floor(constrained / 4)));
}

/** A file's text part: three times its text as UTF-16 (the text, the chunks cut from it, their
 *  embedding inputs). Reserved per chunk set, right after extraction. */
export function textReserveBytes(textChars: number): number {
  return 3 * 2 * textChars;
}

/** A chunk set's vectors with one model, as float32. Grown after chunking. */
export function vectorReserveBytes(chunks: number, dimensions: number): number {
  return chunks * dimensions * 4;
}

export interface MemoryReservation {
  /** Adds to this reservation without waiting (a chunk count above the estimate, a stale commit's extra model). */
  grow(bytes: number): void;
  /** Returns part of this reservation (the real figure below the estimate); never below zero. */
  shrink(bytes: number): void;
  /** grow or shrink by `delta`. */
  adjust(delta: number): void;
  /** Returns the whole reservation; a second call does nothing. */
  release(): void;
}

interface Waiter { bytes: number; grant: (r: MemoryReservation) => void }

let budget = memoryBudgetBytes();
/** The ingest worker's stop signal (ingestWorker.ts start/stop): every wait without its own signal ends with it. */
let stopSignal: AbortSignal | undefined;

export function setMemoryWaitStopSignal(signal: AbortSignal | undefined): void {
  stopSignal = signal;
}

/** Clears the stop signal only when it is still `signal`: a worker started while an older one was
 *  still draining keeps its own. */
export function clearMemoryWaitStopSignal(signal: AbortSignal): void {
  if (stopSignal === signal) stopSignal = undefined;
}

/** Memory handbacks a claim gets without spending an attempt: after that a memory wait that times out
 *  spends the attempt like any transient failure, so sustained memory pressure cannot re-pay a
 *  file's OCR and vision pages forever (counted in last_error.memory_handbacks). */
export const MAX_MEMORY_HANDBACKS = 3;
let used = 0;
let holders = 0;
const waiting: Waiter[] = [];

function makeReservation(bytes: number): MemoryReservation {
  let held = bytes;
  let released = false;
  used += held;
  holders += 1;
  return {
    grow(more: number) {
      if (released || !(more > 0)) return;
      held += more;
      used += more;
    },
    shrink(less: number) {
      if (released || !(less > 0)) return;
      const by = Math.min(less, held);
      held -= by;
      used -= by;
      pump();
    },
    adjust(delta: number) {
      if (delta > 0) this.grow(delta);
      else this.shrink(-delta);
    },
    release() {
      if (released) return;
      released = true;
      used -= held;
      holders -= 1;
      pump();
    },
  };
}

function fits(bytes: number): boolean {
  return holders === 0 || used + bytes <= budget;
}

function pump(): void {
  while (waiting.length > 0 && fits(waiting[0].bytes)) {
    const next = waiting.shift()!;
    next.grant(makeReservation(next.bytes));
  }
}

/**
 * Reserves `bytes`, waiting (in arrival order) while the budget is full: at most until `until`
 * (epoch ms) and while `signal` (default: the worker's stop signal) is not aborted — either ends the wait with FileSearchMemoryBusyError
 * and leaves the queue.
 */
export function reserveMemory(
  bytes: number, opts: { until?: number; signal?: AbortSignal } = {},
): Promise<MemoryReservation> {
  const size = Math.max(0, Math.ceil(bytes) || 0);
  if (waiting.length === 0 && fits(size)) return Promise.resolve(makeReservation(size));
  const signal = opts.signal ?? stopSignal;
  return new Promise<MemoryReservation>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const waiter: Waiter = { bytes: size, grant: (r) => { done(); resolve(r); } };
    const leave = (reason: 'timeout' | 'stopping') => {
      const at = waiting.indexOf(waiter);
      if (at < 0) return; // granted meanwhile
      waiting.splice(at, 1);
      done();
      reject(new FileSearchMemoryBusyError(reason));
      pump(); // the head may fit now
    };
    const onAbort = () => leave('stopping');
    waiting.push(waiter);
    if (signal?.aborted) { leave('stopping'); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.until !== undefined) {
      timer = setTimeout(() => leave('timeout'), Math.max(0, opts.until - Date.now()));
      timer.unref();
    }
  });
}

/**
 * One claim's reservation, in parts (a chunk set's text and vectors). The first reserve() waits for
 * all parts named so far, as estimates; settle() then sets a part to its real figure — shrinking
 * freely, growing only by the difference and without waiting (bounded by the chunk ceiling). A
 * part reserved later (another chunk set, a stale commit's extra model) is added without waiting.
 */
export class FileMemory {
  private reservation: MemoryReservation | null = null;
  private readonly parts = new Map<string, number>();

  /** `deadline`: the claim's (epoch ms); a wait lasts at most half of what is left of it then (waitUntil). */
  constructor(private readonly deadline: number) {}

  async reserve(parts: Array<{ key: string; bytes: number }>): Promise<void> {
    if (!this.reservation) {
      const fresh = parts.filter((p) => !this.parts.has(p.key));
      const total = fresh.reduce((n, p) => n + p.bytes, 0);
      this.reservation = await reserveMemory(total, { until: waitUntil(this.deadline) });
      for (const p of fresh) this.parts.set(p.key, p.bytes);
      return;
    }
    for (const p of parts) this.settle(p.key, p.bytes);
  }

  /** Sets `key` to `bytes`; returns how far it went above what was reserved for it (0 when not). */
  settle(key: string, bytes: number): number {
    const before = this.parts.get(key) ?? 0;
    this.parts.set(key, bytes);
    this.reservation?.adjust(bytes - before);
    return Math.max(0, bytes - before);
  }

  release(): void {
    this.reservation?.release();
  }
}

/** Until when a caller with `deadline` (epoch ms) waits for memory: half of what is left, so the work keeps the other half. */
export function waitUntil(deadline: number): number {
  const now = Date.now();
  return now + Math.max(0, Math.floor((deadline - now) / 2));
}

/** Test seam: a budget in bytes (null = from the container) and an empty state; the current state. */
export const __memoryBudgetForTests = {
  reset(bytes: number | null): void {
    budget = bytes ?? memoryBudgetBytes();
    used = 0;
    holders = 0;
    waiting.splice(0);
  },
  state(): { budget: number; used: number; holders: number; waiting: number; stopSignal: AbortSignal | undefined } {
    return { budget, used, holders, waiting: waiting.length, stopSignal };
  },
};
