import { createPoller } from '../webapp/model/poller';

/** A hand-driven clock: the poller gets these instead of setTimeout and clearTimeout. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    set: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clear: (id: unknown) => { pending.delete(id as number); },
    pending,
    fire() { const [id, t] = [...pending.entries()][0]; pending.delete(id); t.fn(); }
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createPoller', () => {
  it('runs every interval after the previous run has finished, never two at once', async () => {
    const timers = fakeTimers();
    let release: () => void = () => undefined;
    let runs = 0;
    const poller = createPoller({ intervalMs: 2000, run: () => { runs++; return new Promise<void>((r) => { release = r; }); }, setTimer: timers.set, clearTimer: timers.clear });
    poller.start();
    expect(timers.pending.size).toBe(1);
    expect([...timers.pending.values()][0].ms).toBe(2000);
    timers.fire();
    expect(runs).toBe(1);
    expect(timers.pending.size).toBe(0);  // no next timer while the run is going
    poller.runNow();                      // and no second run either
    expect(runs).toBe(1);
    release();
    await flush();
    expect(timers.pending.size).toBe(1);
    poller.dispose();
  });

  it('stop clears the timer and a run that finishes after stop schedules nothing', async () => {
    const timers = fakeTimers();
    let release: () => void = () => undefined;
    const poller = createPoller({ intervalMs: 2000, run: () => new Promise<void>((r) => { release = r; }), setTimer: timers.set, clearTimer: timers.clear });
    poller.start();
    timers.fire();
    poller.stop();
    release();
    await flush();
    expect(timers.pending.size).toBe(0);
    expect(poller.isRunning()).toBe(false);
  });

  it('pauses while hidden and runs at once when shown again', async () => {
    const timers = fakeTimers();
    let runs = 0;
    const poller = createPoller({ intervalMs: 2000, run: async () => { runs++; }, setTimer: timers.set, clearTimer: timers.clear });
    poller.start();
    poller.setHidden(true);
    expect(timers.pending.size).toBe(0);
    poller.setHidden(false);
    expect(runs).toBe(1);
    await flush();
    expect(timers.pending.size).toBe(1);
    poller.dispose();
    expect(timers.pending.size).toBe(0);
  });

  it('does not start while hidden, and showing a stopped poller starts nothing', () => {
    const timers = fakeTimers();
    let runs = 0;
    const poller = createPoller({ intervalMs: 2000, run: async () => { runs++; }, setTimer: timers.set, clearTimer: timers.clear });
    poller.setHidden(true);
    poller.start();
    expect(timers.pending.size).toBe(0);
    poller.stop();
    poller.setHidden(false);
    expect(runs).toBe(0);
    expect(timers.pending.size).toBe(0);
  });

  it('keeps going after a failed run', async () => {
    const timers = fakeTimers();
    const poller = createPoller({ intervalMs: 2000, run: async () => { throw new Error('offline'); }, setTimer: timers.set, clearTimer: timers.clear });
    poller.start();
    timers.fire();
    await flush();
    expect(timers.pending.size).toBe(1);
    poller.dispose();
  });

  it('after dispose nothing starts again', () => {
    const timers = fakeTimers();
    const poller = createPoller({ intervalMs: 2000, run: async () => undefined, setTimer: timers.set, clearTimer: timers.clear });
    poller.dispose();
    poller.start();
    poller.runNow();
    poller.setHidden(false);
    expect(timers.pending.size).toBe(0);
  });
});

describe('createPoller, leaving the page and stopping', () => {
  it('skips a run while canRun says no (the view is not on the page) and keeps checking, then runs again once it says yes', async () => {
    const timers = fakeTimers();
    let shown = false;
    let runs = 0;
    const poller = createPoller({ intervalMs: 2000, run: async () => { runs++; }, setTimer: timers.set, clearTimer: timers.clear, canRun: () => shown });
    poller.start();
    timers.fire();
    expect(runs).toBe(0);
    expect(timers.pending.size).toBe(1);
    shown = true;
    timers.fire();
    expect(runs).toBe(1);
    poller.dispose();
  });

  it('a run in flight learns that it is no longer current once Live is switched off, so it merges nothing', async () => {
    const timers = fakeTimers();
    let release: () => void = () => undefined;
    let current: (() => boolean) | null = null;
    const poller = createPoller({ intervalMs: 2000, run: (isCurrent) => { current = isCurrent; return new Promise<void>((r) => { release = r; }); }, setTimer: timers.set, clearTimer: timers.clear });
    poller.start();
    timers.fire();
    expect(current!()).toBe(true);
    poller.stop();
    expect(current!()).toBe(false);
    poller.start();
    expect(current!()).toBe(false);   // a new start does not revive the old run
    release();
    await flush();
    poller.dispose();
  });
});
