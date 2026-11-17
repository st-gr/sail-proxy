/**
 * The one queue every configuration hand-over of this admin process to the gateway goes through
 * (config-service.ts): "read the active configuration, lay the logging settings over it, publish"
 * runs to completion before the next one begins, so the last event the gateway receives carries the
 * newest committed configuration.
 *
 * - Each hand-over has its own timeout, counted from the moment it starts. When it runs out the
 *   caller gets 'Event publish timeout', the queue moves on, and the hand-over is told it was given
 *   up (isAbandoned), so that a read that finishes late does not publish an older state after a
 *   newer one.
 * - A hand-over that fails or times out never blocks or fails the ones behind it.
 * - A caller whose kind (key) already has a hand-over waiting (not yet started) shares that one: it
 *   reads the newest state when it runs, which includes what the second caller committed. So the
 *   queue holds at most one running hand-over and one waiting hand-over per kind, also while Valkey
 *   is down and every hand-over times out.
 */
const TIMEOUT_MESSAGE = 'Event publish timeout';

type Task<T> = (isAbandoned: () => boolean) => T | Promise<T>;

interface Entry {
  key: string;
  task: Task<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class HandOverQueue {
  private readonly waiting: Entry[] = [];
  private running = false;

  constructor(private readonly timeoutMs: number) {}

  /** The hand-overs running and waiting. */
  get length(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  /** Queues `task` (or joins the waiting one of the same key) and resolves with its outcome. */
  run<T>(key: string, task: Task<T>): Promise<T> {
    const joined = this.waiting.find((entry) => entry.key === key);
    if (joined) return joined.promise as Promise<T>;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    this.waiting.push({ key, task, promise, resolve, reject });
    void this.drain();
    return promise as Promise<T>;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let entry: Entry | undefined;
      while ((entry = this.waiting.shift())) await this.runOne(entry);
    } finally {
      this.running = false;
    }
  }

  /** Settles the entry with its outcome or the timeout, whichever comes first; never rejects. */
  private runOne(entry: Entry): Promise<void> {
    return new Promise<void>((done) => {
      let settled = false;
      let abandoned = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
        done();
      };
      const timer = setTimeout(() => settle(() => { abandoned = true; entry.reject(new Error(TIMEOUT_MESSAGE)); }), this.timeoutMs);
      let result: Promise<unknown>;
      try {
        result = Promise.resolve(entry.task(() => abandoned));
      } catch (error) {
        result = Promise.reject(error);
      }
      result.then(
        (value) => settle(() => entry.resolve(value)),
        (error) => settle(() => entry.reject(error))
      );
    });
  }
}
