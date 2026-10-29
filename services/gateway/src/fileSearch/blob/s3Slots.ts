/**
 * Bounds the external-storage (S3) requests made while holding a file_search database connection.
 *
 * A retain PUTs inside its transaction, the migration's switch reads its copy back under the lock,
 * and the sweeper deletes an object before its COMMIT: each holds a pooled connection for the whole
 * S3 request (up to the S3 transfer deadline). Unbounded, a slow S3 would hold every connection of
 * the pool (10, see db.ts) and stall search, listing and ingestion with it. At most
 * S3_SLOTS such requests run at once per process; the rest of the pool stays free for everything
 * else.
 *
 * A slot is ALWAYS taken before the connection, never while holding one: a waiter holds no
 * connection and no lock, so slot holders and connection holders cannot wait on each other in a
 * cycle. Code that learns only under the lock that it needs S3 throws NeedsS3SlotError after
 * rolling back; withS3SlotIfNeeded then runs it again holding a slot.
 */

/** No slot became free within the wait: the storage is too slow or too busy right now. */
export class S3SlotBusyError extends Error {
  constructor(readonly storage: string) {
    super('too many storage requests in flight');
    this.name = 'S3SlotBusyError';
  }
}

/** Concurrent S3 requests under a connection, per process (the pool has 10 connections). */
export const S3_SLOTS = 3;

/**
 * How long an upload waits for a slot before it answers 503 (the same budget as a wait for a pool
 * connection: see db.ts). Background work (sweeper, migration) waits without a limit.
 */
export const S3_SLOT_WAIT_MS = 15_000;

let free = S3_SLOTS;
const waiters: Array<() => void> = [];

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else free += 1;
}

async function acquire(waitMs: number | null, storage: string): Promise<void> {
  if (free > 0) {
    free -= 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const grant = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    waiters.push(grant);
    if (waitMs !== null) {
      timer = setTimeout(() => {
        const i = waiters.indexOf(grant);
        if (i >= 0) waiters.splice(i, 1);
        reject(new S3SlotBusyError(storage));
      }, waitMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

/** Runs `work` holding a slot (released in finally). `waitMs` null: wait without a limit. */
export async function withS3Slot<T>(work: () => Promise<T>, opts: { waitMs?: number | null; storage?: string } = {}): Promise<T> {
  await acquire(opts.waitMs === undefined ? null : opts.waitMs, opts.storage ?? 's3');
  try {
    return await work();
  } finally {
    release();
  }
}

/** Thrown (after its ROLLBACK and connection release) by work that found under the lock that it needs S3. */
export class NeedsS3SlotError extends Error {
  constructor() {
    super('this operation needs an S3 slot');
    this.name = 'NeedsS3SlotError';
  }
}

/**
 * `attempt(holding)`: with `needed`, runs once holding a slot. Otherwise runs without one; if that
 * throws NeedsS3SlotError, runs again holding a slot.
 */
export async function withS3SlotIfNeeded<T>(
  needed: boolean, attempt: (holding: boolean) => Promise<T>, opts: { waitMs?: number | null; storage?: string } = {},
): Promise<T> {
  if (needed) return withS3Slot(() => attempt(true), opts);
  try {
    return await attempt(false);
  } catch (e) {
    if (!(e instanceof NeedsS3SlotError)) throw e;
    return withS3Slot(() => attempt(true), opts);
  }
}

/** Slots free and waiters queued, for tests. */
export function s3SlotStateForTests(): { free: number; waiting: number } {
  return { free, waiting: waiters.length };
}
