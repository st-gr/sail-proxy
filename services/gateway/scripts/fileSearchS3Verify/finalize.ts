/**
 * The end of a verification run, on every exit path: the steps (S3 cleanup, guard removal, pool,
 * container, temporary directory) run once, each in its own try, so one failing step never skips
 * the next. SIGINT/SIGTERM run the same steps once and exit non-zero.
 */
export interface FinalStep {
  name: string;
  run(): Promise<void> | void;
}

/** Runs `steps` in order on the first call; later calls return the first call's result. */
export function onceFinalizer(steps: FinalStep[], log: (m: string) => void): () => Promise<string[]> {
  let running: Promise<string[]> | null = null;
  return () => {
    if (!running) {
      running = (async () => {
        const failed: string[] = [];
        for (const step of steps) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await step.run();
          } catch (error: any) {
            failed.push(step.name);
            log(`${step.name} failed: ${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0]}`);
          }
        }
        return failed;
      })();
    }
    return running;
  };
}

export interface SignalTarget {
  once(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown;
}

/**
 * On SIGINT (exit 130) or SIGTERM (exit 143): log, run `finalize`, then exit. A second signal while
 * it runs is ignored by `once` and the finalizer's own once-semantics.
 */
export function onSignals(
  finalize: () => Promise<string[]>, exit: (code: number) => void, log: (m: string) => void,
  target: SignalTarget = process,
): void {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    target.once(signal, () => {
      log(`${signal}: cleaning up before exiting`);
      finalize().finally(() => exit(code));
    });
  }
}
