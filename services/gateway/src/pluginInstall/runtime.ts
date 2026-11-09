import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { setPluginsChangedHandler, setPluginsReloadedHandler } from '../services/configService';
import { DEFAULT_PLUGINS_DIR, getLoadReport, hasLoadedPlugins } from '../services/pluginLoader';
import { adminPackageSource } from './adminSource';
import { createFolderSource } from './folderSource';
import { getGatewayVersion } from './gatewayVersion';
import { withPluginLock } from './lock';
import { reloadPluginsInsideLock } from './reload';
import { buildPluginStatus, writePluginStatus, clearPluginStatus } from './statusReporter';
import type { PluginStatusStore } from './statusReporter';
import { syncPlugins, UNPACK_DISABLED_DEV } from './sync';
import type { PackageSource, SyncResult } from './sync';

const logger = getDefaultLogger();
const LOG = 'PluginInstall';

/** How long gateway startup waits for the admin's answer before going on with what is unpacked. */
const BOOT_WAIT_MS = 5_000;
/** First retry delay after a failed list at boot; doubles up to RETRY_MAX_MS. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const CHECK_INTERVAL_MS = 60_000;

export { UNPACK_DISABLED_DEV };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * False under ts-node: there the plugins folder is the tracked `src/plugins`, so an
 * unpack would dirty the repository. A compiled gateway run locally behaves like Docker.
 */
export function isUnpackAllowed(extensions: Record<string, unknown> = require.extensions): boolean {
  const tsNode = (process as unknown as Record<symbol, unknown>)[Symbol.for('ts-node.register.instance')];
  return !tsNode && !extensions['.ts'];
}

/**
 * Where packages come from. `watch` is for the admin only: it can change at any time.
 * The folder takes effect at the next start, and with neither the sync never runs, so
 * nothing already in the plugins folder is touched.
 */
export function resolvePluginSource(): { source: PackageSource | null; watch: boolean } {
  if (!isStandaloneMode() && process.env.ADMIN_SERVICE_URL) return { source: adminPackageSource, watch: true };
  if (process.env.PLUGINS_SOURCE_DIR) return { source: createFolderSource(path.resolve(process.env.PLUGINS_SOURCE_DIR)), watch: false };
  return { source: null, watch: false };
}

export type PluginRuntimeDeps = {
  source: PackageSource | null;
  watch: boolean;
  pluginsDir: string;
  gatewayVersion: string;
  unpackAllowed: boolean;
  bootWaitMs: number;
  retryBaseMs: number;
  checkIntervalMs: number;
  /** Called with the plugin lock held. */
  reloadInsideLock: () => Promise<void>;
  /** Whether the gateway's first plugin load already ran. */
  pluginsLoaded: () => boolean;
  report: (sync: SyncResult | null) => Promise<void>;
  onMarker: (handler: () => void) => void;
  onReloaded: (handler: () => void) => void;
};

function logSyncResult(result: SyncResult): void {
  if (result.unpackDisabledReason) logger.info(LOG, `Installed plugins are not unpacked: ${result.unpackDisabledReason}`);
  if (result.listFailed) logger.warn(LOG, `Could not get the wanted plugins, keeping what is installed: ${result.listFailed}`);
  if (result.error) logger.error(LOG, `Plugin sync problem: ${result.error}`);
  for (const plugin of result.plugins) {
    if (plugin.state === 'installed') logger.debug(LOG, `Plugin ${plugin.id} ${plugin.version} is installed`);
    else logger.error(LOG, `Plugin ${plugin.id} ${plugin.version} ${plugin.state}: ${plugin.error}`);
  }
}

/** Separated from the module-level wiring below so tests can run it against a temp folder and a fake source. */
export function createPluginRuntime(deps: PluginRuntimeDeps) {
  const { source } = deps;
  let lastSync: SyncResult | null = null;
  let inFlight: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let interval: NodeJS.Timeout | null = null;
  let wakeRetry: (() => void) | null = null;

  const report = async (): Promise<void> => {
    // Stopped: shutdown removes the status key, and a sync finishing late must not write it back.
    if (stopped) return;
    try {
      await deps.report(lastSync);
    } catch (error) {
      logger.warn(LOG, `Could not report the plugin status: ${message(error)}`);
    }
  };

  // The sync runs outside the plugin lock, one at a time through `check`: a slow download must
  // never delay the built-ins' first load or a config change (spec §5). A reload cannot see a
  // half-replaced folder, because syncPlugins only yields at source.list and source.fetch; each
  // swap between those is synchronous.
  //
  // A reload is needed only once the first load has run: until then that load reads the
  // folder itself, after the config arrived, so a plugin reading config at its module top
  // keeps seeing it. This one rule serves boot, background retries and later changes.
  const syncOnce = async (source: PackageSource): Promise<void> => {
    try {
      const result = await syncPlugins(source, {
        pluginsDir: deps.pluginsDir,
        gatewayVersion: deps.gatewayVersion,
        unpackAllowed: deps.unpackAllowed,
      });
      lastSync = result;
      logSyncResult(result);
      if (result.changed) {
        await withPluginLock(async () => {
          if (deps.pluginsLoaded()) await deps.reloadInsideLock();
        });
      }
    } finally {
      await report();
    }
  };

  /** One sync at a time. A request during a running one causes one follow-up, so no change is lost. */
  const check = (): Promise<void> => {
    if (!source) return Promise.resolve();
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        again = false;
        try {
          await syncOnce(source);
        } catch (error) {
          logger.error(LOG, `Plugin check failed: ${message(error)}`);
        }
      } while (again);
      inFlight = null;
    })();
    return inFlight;
  };

  const retryDelay = (ms: number) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(() => { wakeRetry = null; resolve(); }, ms);
      timer.unref();
      wakeRetry = () => { clearTimeout(timer); wakeRetry = null; resolve(); };
    });

  const checkUntilListed = async (): Promise<void> => {
    let delay = deps.retryBaseMs;
    await check();
    while (!stopped && lastSync?.listFailed) {
      await retryDelay(delay);
      if (stopped) return;
      delay = Math.min(delay * 2, RETRY_MAX_MS);
      await check();
    }
  };

  // Valkey subscribes while the gateway waits for its first configuration, so this is set at
  // boot: a marker arriving before startWatch must not wait for the timer.
  let listening = false;
  const listen = (): void => {
    if (!source || !deps.watch || listening) return;
    listening = true;
    deps.onMarker(() => { void check(); });
    deps.onReloaded(() => { void report(); });
  };

  return {
    check,

    /** Unpack at startup. The folder is local and waited for; the admin gets a brief wait, then retries in the background. */
    async boot(): Promise<void> {
      if (!source) return;
      if (!deps.watch) {
        await check();
        return;
      }
      listen();
      // This timer stays referenced: the retry timer is not, and nothing else may be keeping the process alive yet.
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<void>(resolve => { timer = setTimeout(resolve, deps.bootWaitMs); });
      await Promise.race([checkUntilListed(), waited]);
      clearTimeout(timer);
    },

    /** Follow the admin: its change marker, plus a timer so a missed marker still converges. */
    startWatch(): void {
      if (!source || !deps.watch || interval) return;
      listen();
      interval = setInterval(() => { void check(); }, deps.checkIntervalMs);
      interval.unref();
      void report();
    },

    stop(): void {
      stopped = true;
      if (interval) clearInterval(interval);
      interval = null;
      wakeRetry?.();
    },
  };
}

let statusStore: PluginStatusStore | null = null;

/** Where the status goes on Docker and Kyma; without one (standalone) the gateway log is the status. */
export function setPluginStatusStore(store: PluginStatusStore): void {
  statusStore = store;
}

let runtime: ReturnType<typeof createPluginRuntime> | null = null;

function defaultRuntime(): ReturnType<typeof createPluginRuntime> {
  if (runtime) return runtime;
  const gatewayVersion = getGatewayVersion();
  runtime = createPluginRuntime({
    ...resolvePluginSource(),
    pluginsDir: DEFAULT_PLUGINS_DIR,
    gatewayVersion,
    unpackAllowed: isUnpackAllowed(),
    bootWaitMs: BOOT_WAIT_MS,
    retryBaseMs: RETRY_BASE_MS,
    checkIntervalMs: CHECK_INTERVAL_MS,
    reloadInsideLock: () => reloadPluginsInsideLock(),
    pluginsLoaded: hasLoadedPlugins,
    report: sync => writePluginStatus(statusStore, buildPluginStatus(sync, getLoadReport(), gatewayVersion)),
    onMarker: setPluginsChangedHandler,
    onReloaded: setPluginsReloadedHandler,
  });
  return runtime;
}

/** Unpack what is wanted before the gateway's first plugin load. Never rejects and never stops startup. */
export const bootSyncPlugins = (): Promise<void> => defaultRuntime().boot();

/** Start following plugin changes, where the source can change while running. */
export const startPluginWatch = (): void => defaultRuntime().startWatch();

/** On shutdown: stop following changes, then remove this instance's status so it is not listed as running. */
export async function stopPluginWatch(): Promise<void> {
  runtime?.stop();
  await clearPluginStatus(statusStore);
}
