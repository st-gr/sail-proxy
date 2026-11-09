/**
 * What the gateways report about their plugins (spec 2026-11-04 §7). Each gateway instance writes
 * a short-lived JSON key after every plugin reload and every 60 s check; the writer and the shape
 * are services/gateway/src/pluginInstall/statusReporter.ts (`PluginStatus`). The admin cannot import
 * the gateway, so the key prefix and the types are copied here and read defensively.
 */
import { quotaStateStore } from './quotaStateStore';

/** `sap-llm-gateway:plugin-status:<HOSTNAME or 'local'>` in the gateway. */
export const PLUGIN_STATUS_PREFIX = 'sap-llm-gateway:plugin-status:';

export type PluginStatusRule = { id: string; strategy: string };

export type PluginStatusRow = {
  id: string;
  version: string;
  kind: 'installed' | 'shipped';
  state: 'running' | 'installed' | 'failed' | 'incompatible';
  error?: string;
  rules: PluginStatusRule[];
};

export type GatewayInstanceStatus = {
  instance: string;
  gatewayVersion: string;
  at: string;
  unpackDisabledReason?: string;
  plugins: PluginStatusRow[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rulesOf = (v: unknown): PluginStatusRule[] =>
  (Array.isArray(v) ? v : []).filter(isRecord).map((r) => ({ id: str(r.id), strategy: str(r.strategy) })).filter((r) => r.id !== '');

/** One key's value as an instance, or null when it is not a status document. */
function toInstance(key: string, value: unknown): GatewayInstanceStatus | null {
  if (!isRecord(value) || !Array.isArray(value.plugins)) return null;
  return {
    instance: key.startsWith(PLUGIN_STATUS_PREFIX) ? key.slice(PLUGIN_STATUS_PREFIX.length) : key,
    gatewayVersion: str(value.gatewayVersion),
    at: str(value.at),
    ...(typeof value.unpackDisabledReason === 'string' ? { unpackDisabledReason: value.unpackDisabledReason } : {}),
    // A row's version can be empty (an unreadable CLI zip); keep it, never throw.
    plugins: value.plugins.filter(isRecord).map((p) => ({
      id: str(p.id),
      version: str(p.version),
      kind: p.kind === 'shipped' ? 'shipped' : 'installed',
      state: (['running', 'installed', 'failed', 'incompatible'] as const).find((s) => s === p.state) ?? 'failed',
      ...(typeof p.error === 'string' ? { error: p.error } : {}),
      rules: rulesOf(p.rules),
    })),
  };
}

/**
 * Every gateway instance's report. No key at all is `available: true` with no instances (the gateways
 * are not responding, or none has reported yet); no Valkey is `available: false`.
 */
export async function readGatewayStatus(): Promise<{ instances: GatewayInstanceStatus[]; available: boolean }> {
  const found = await quotaStateStore.scanJson(`${PLUGIN_STATUS_PREFIX}*`);
  if (found === null) return { instances: [], available: false };
  const instances = found.map((f) => toInstance(f.key, f.value)).filter((i): i is GatewayInstanceStatus => i !== null);
  return { instances, available: true };
}

/** Ids of plugins the gateways ship in the image. */
export function shippedIds(instances: GatewayInstanceStatus[]): Set<string> {
  const ids = new Set<string>();
  for (const i of instances) {
    i.plugins.filter((p) => p.kind === 'shipped').forEach((p) => ids.add(p.id));
  }
  return ids;
}

/** The rule ids the gateways report for one plugin. */
export function reportedRuleIds(instances: GatewayInstanceStatus[], pluginId: string): Set<string> {
  const ids = new Set<string>();
  for (const i of instances) i.plugins.filter((p) => p.id === pluginId).forEach((p) => p.rules.forEach((r) => ids.add(r.id)));
  return ids;
}
