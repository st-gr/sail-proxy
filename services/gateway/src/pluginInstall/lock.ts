/**
 * One lock for every plugin reload, so reloads run one at a time. A sync stays
 * outside it (see syncPlugins). Deliberately free of imports: it is used by
 * configService and by the pluginInstall modules, which must not form a cycle.
 */
let tail: Promise<unknown> | null = null;

/**
 * Run `fn` once every earlier holder has finished. A rejection releases the
 * lock and is passed to the caller. When the lock is free `fn` starts
 * synchronously, so a caller that does not await still sees the synchronous
 * part of `fn` run in order.
 *
 * NOT re-entrant: calling this from inside `fn` (reloadPluginModules does) and
 * waiting for it deadlocks every later holder. Inside the lock, use
 * reloadPluginsInsideLock.
 */
export function withPluginLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = (): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const run: Promise<T> = tail === null ? start() : tail.then(start, start);
  const mine: Promise<unknown> = run.then(
    () => undefined,
    () => undefined,
  );
  tail = mine;
  void mine.then(() => {
    if (tail === mine) tail = null;
  });
  return run;
}
