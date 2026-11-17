/**
 * The one in-process queue every configuration hand-over to the gateway goes through
 * (services/handOverQueue.ts): one at a time, in order, each with its own timeout, a failed or
 * timed-out one never blocking or failing the ones behind it, and a waiting one shared by a second
 * caller of the same kind (it reads the newest state when it runs).
 */
import { HandOverQueue } from '../../../src/services/handOverQueue';

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));

describe('HandOverQueue', () => {
  afterEach(() => jest.useRealTimers());

  it('runs one hand-over at a time, in the order they were queued', async () => {
    const queue = new HandOverQueue(3000);
    const log: string[] = [];
    const first = deferred();
    const a = queue.run('a', async () => { log.push('a start'); await first.promise; log.push('a end'); return 'A'; });
    const b = queue.run('b', async () => { log.push('b start'); return 'B'; });
    await tick();
    expect(log).toEqual(['a start']);
    first.resolve();
    expect(await a).toBe('A');
    expect(await b).toBe('B');
    expect(log).toEqual(['a start', 'a end', 'b start']);
  });

  it('a hand-over that hangs is given up after its timeout and the next one runs afterwards', async () => {
    jest.useFakeTimers();
    const queue = new HandOverQueue(3000);
    let abandoned: () => boolean = () => false;
    const hanging = queue.run('a', (isAbandoned) => { abandoned = isAbandoned; return new Promise(() => undefined); });
    const hangingOutcome = hanging.then(() => 'resolved', (e: Error) => e.message);
    let nextRan = false;
    const next = queue.run('b', async () => { nextRan = true; return 'B'; });
    await jest.advanceTimersByTimeAsync(2900);
    expect(nextRan).toBe(false);
    expect(abandoned()).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    expect(await hangingOutcome).toBe('Event publish timeout');
    expect(abandoned()).toBe(true);
    expect(await next).toBe('B');
    expect(nextRan).toBe(true);
  });

  it('the timeout of each hand-over starts when it starts, not when it was queued', async () => {
    jest.useFakeTimers();
    const queue = new HandOverQueue(3000);
    const first = queue.run('a', () => new Promise((r) => setTimeout(() => r('A'), 2500)));
    const second = queue.run('b', () => new Promise((r) => setTimeout(() => r('B'), 2500)));
    await jest.advanceTimersByTimeAsync(5100);
    expect(await first).toBe('A');
    expect(await second).toBe('B');
  });

  it('a hand-over that waits behind a slow one is not reported as timed out when it then publishes in time', async () => {
    jest.useFakeTimers();
    const queue = new HandOverQueue(3000);
    const slow = queue.run('activated', () => new Promise((r) => setTimeout(() => r('slow'), 2900)));
    let outcome: string | undefined;
    const waiting = queue.run('settings', () => new Promise((r) => setTimeout(() => r('published'), 1000)))
      .then((v) => { outcome = v as string; }, (e: Error) => { outcome = e.message; });
    await jest.advanceTimersByTimeAsync(3100); // 3 s after it was queued: still running, not timed out
    expect(outcome).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(await slow).toBe('slow');
    expect(outcome).toBe('published');
  });

  it('a hand-over that rejects does not fail the next', async () => {
    const queue = new HandOverQueue(3000);
    const failing = queue.run('a', async () => { throw new Error('Connection is closed.'); });
    const next = queue.run('b', async () => 'B');
    await expect(failing).rejects.toThrow('Connection is closed.');
    expect(await next).toBe('B');
  });

  it('a hand-over that throws synchronously does not stop the queue', async () => {
    const queue = new HandOverQueue(3000);
    const failing = queue.run('a', () => { throw new Error('boom'); });
    await expect(failing).rejects.toThrow('boom');
    expect(await queue.run('b', async () => 'B')).toBe('B');
  });

  it('a second caller of the same kind shares the waiting hand-over instead of queueing another', async () => {
    const queue = new HandOverQueue(3000);
    const first = deferred();
    const running = queue.run('settings', async () => { await first.promise; return 1; });
    await tick();
    const calls: string[] = [];
    const waiting = queue.run('settings', async () => { calls.push('waiting'); return 2; });
    const joined = queue.run('settings', async () => { calls.push('joined'); return 3; });
    expect(queue.length).toBe(2); // the running one and one waiting one
    first.resolve();
    expect(await running).toBe(1);
    expect(await waiting).toBe(2);
    expect(await joined).toBe(2);
    expect(calls).toEqual(['waiting']);
  });

  it('a running hand-over is never joined: a new caller of the same kind queues behind it', async () => {
    const queue = new HandOverQueue(3000);
    const first = deferred();
    const running = queue.run('a', async () => { await first.promise; return 'old'; });
    await tick();
    const after = queue.run('a', async () => 'new');
    first.resolve();
    expect(await running).toBe('old');
    expect(await after).toBe('new');
  });

  it('stays bounded while every hand-over times out: one running and at most one waiting per kind', async () => {
    jest.useFakeTimers();
    const queue = new HandOverQueue(3000);
    const outcomes: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      for (const kind of ['activated', 'rollback', 'changed', 'settings']) {
        outcomes.push(queue.run(kind, () => new Promise(() => undefined)).catch(() => undefined));
      }
    }
    expect(queue.length).toBeLessThanOrEqual(5);
    await jest.advanceTimersByTimeAsync(5 * 3000 + 100);
    await Promise.all(outcomes);
    expect(queue.length).toBe(0);
  });
});
