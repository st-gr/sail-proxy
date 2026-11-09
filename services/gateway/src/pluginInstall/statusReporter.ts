import { getDefaultLogger } from '@libs/logger';
import type { PluginLoadReportEntry } from '../services/pluginLoader';
import type { SyncResult } from './sync';

const logger = getDefaultLogger();

export const PLUGIN_STATUS_TTL_SECONDS = 180;

export type PluginStatusRule = { id: string; strategy: string };

/**
 * One plugin on this gateway instance.
 *
 * `state`: `running` loaded without error. `installed` unpacked, not loaded yet
 * (the first load is still ahead). `failed` the sync or the load failed; `error`
 * says why. `incompatible` the wanted version does not fit this gateway.
 *
 * `version` is the wanted version when the sync reports the plugin, otherwise the
 * version on disk. `rules` is what is really registered, so a failed upgrade shows
 * the new version's error beside the rules of the previous version that still runs.
 */
export type PluginStatusRow = {
  id: string;
  version: string;
  kind: 'installed' | 'shipped';
  state: 'running' | 'installed' | 'failed' | 'incompatible';
  error?: string;
  rules: PluginStatusRule[];
};

/**
 * What a gateway instance writes to `sap-llm-gateway:plugin-status:<HOSTNAME or 'local'>`
 * as JSON, with a TTL of PLUGIN_STATUS_TTL_SECONDS, after every plugin reload and every
 * 60 s check. A missing key means this gateway is not responding. `at` is an ISO 8601
 * timestamp. `unpackDisabledReason` is set when this runtime does not unpack at all.
 */
export type PluginStatus = {
  gatewayVersion: string;
  at: string;
  unpackDisabledReason?: string;
  plugins: PluginStatusRow[];
};

/** The Valkey commands the reporter needs. */
export type PluginStatusStore = {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del?(key: string): Promise<unknown>;
};

export const pluginStatusKey = (): string => `sap-llm-gateway:plugin-status:${process.env.HOSTNAME || 'local'}`;

/**
 * Merge the last sync with the current load report. They meet on the folder name,
 * which the sync guarantees is the plugin id. Sync's failure wins over the loader's,
 * since it is about the version that was asked for.
 */
export function buildPluginStatus(
  sync: SyncResult | null,
  report: PluginLoadReportEntry[],
  gatewayVersion: string,
  now: Date = new Date(),
): PluginStatus {
  const syncRows = new Map((sync?.plugins ?? []).map(p => [p.id, p]));
  const plugins: PluginStatusRow[] = [];

  for (const entry of report) {
    const synced = entry.kind === 'installed' ? syncRows.get(entry.source) : undefined;
    if (synced) syncRows.delete(entry.source);
    const syncFailed = synced !== undefined && synced.state !== 'installed';
    const error = syncFailed ? synced.error : entry.error;
    plugins.push({
      id: entry.kind === 'installed' ? entry.source : entry.id ?? entry.source,
      version: synced?.version ?? entry.version ?? '',
      kind: entry.kind,
      state: syncFailed ? (synced.state as 'failed' | 'incompatible') : entry.error ? 'failed' : 'running',
      ...(error ? { error } : {}),
      rules: entry.rules,
    });
  }

  for (const synced of syncRows.values()) {
    plugins.push({
      id: synced.id,
      version: synced.version,
      kind: 'installed',
      state: synced.state,
      ...(synced.error ? { error: synced.error } : {}),
      rules: [],
    });
  }

  return {
    gatewayVersion,
    at: now.toISOString(),
    ...(sync?.unpackDisabledReason ? { unpackDisabledReason: sync.unpackDisabledReason } : {}),
    plugins,
  };
}

/** Best effort: without a store (standalone) this does nothing, and a Valkey failure is only logged. */
export async function writePluginStatus(store: PluginStatusStore | null, status: PluginStatus): Promise<void> {
  if (!store) return;
  try {
    await store.set(pluginStatusKey(), JSON.stringify(status), 'EX', PLUGIN_STATUS_TTL_SECONDS);
  } catch (error) {
    logger.warn('PluginInstall', `Could not write the plugin status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Remove this instance's key when the gateway shuts down, so a stopped instance is not listed as
 * running until the TTL ends. Best effort like the write; an instance that dies without shutting
 * down still drops out after PLUGIN_STATUS_TTL_SECONDS.
 */
export async function clearPluginStatus(store: PluginStatusStore | null): Promise<void> {
  if (!store?.del) return;
  try {
    await store.del(pluginStatusKey());
  } catch (error) {
    logger.warn('PluginInstall', `Could not remove the plugin status: ${error instanceof Error ? error.message : String(error)}`);
  }
}
