/**
 * The live view's timer. A run starts `intervalMs` after the previous one has finished, so two runs
 * never overlap; while the page is hidden no timer is set; after stop() or dispose() a run that is
 * still going schedules nothing, and its `isCurrent()` turns false, so it merges nothing. While
 * `canRun()` says no (the view is not on the page, for example the shell shows its Home) a tick only
 * checks again after the interval. The timer functions are injected (setTimeout/clearTimeout in the
 * browser, a hand-driven clock under jest).
 */

export interface PollerOptions {
  intervalMs: number;
  /** isCurrent(): false once the poller was stopped, restarted or disposed after this run began. */
  run: (isCurrent: () => boolean) => Promise<void>;
  /** Whether a tick may fetch now; default always. */
  canRun?: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** Runs now unless a run is going (the next one is scheduled from its end). */
  runNow(): void;
  setHidden(hidden: boolean): void;
  isRunning(): boolean;
  dispose(): void;
}

export function createPoller(options: PollerOptions): Poller {
  let active = false;
  let hidden = false;
  let disposed = false;
  let busy = false;
  let timer: unknown = null;
  let token = 0;

  const clear = () => {
    if (timer !== null) options.clearTimer(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (active && !hidden && !disposed && !busy) timer = options.setTimer(tick, options.intervalMs);
  };
  function tick(): void {
    timer = null;
    if (!active || hidden || disposed || busy) return;
    if (options.canRun && !options.canRun()) {
      schedule();
      return;
    }
    busy = true;
    const mine = token;
    options.run(() => mine === token && active && !disposed).catch(() => undefined).then(() => {
      busy = false;
      schedule();
    });
  }

  return {
    start() {
      if (disposed) return;
      token++;
      active = true;
      schedule();
    },
    stop() {
      token++;
      active = false;
      clear();
    },
    runNow() {
      clear();
      tick();
    },
    setHidden(value: boolean) {
      hidden = value;
      if (hidden) clear();
      else if (active && !busy && !disposed) tick();
    },
    isRunning: () => active && !disposed,
    dispose() {
      token++;
      disposed = true;
      active = false;
      clear();
    }
  };
}
