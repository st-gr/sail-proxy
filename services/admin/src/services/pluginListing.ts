/**
 * GET /api/plugins: installed plugins with their versions, enabled state and what the gateways report,
 * plus the built-ins read-only (spec 2026-11-04 §7). Reads package summaries only, never the zips.
 */
import { isCompatible } from '@libs/plugin-package';
import type { PluginManifest } from '@libs/plugin-package';
import { getAdminVersion } from './adminVersion';
import { readGatewayStatus } from './pluginStatus';
import type { GatewayInstanceStatus, PluginStatusRule } from './pluginStatus';
import * as store from './pluginStore';

const parse = (text: string): Partial<PluginManifest> => {
  try { return JSON.parse(text) as PluginManifest; } catch { return {}; }
};

export type Builtin = { id: string; kind: 'shipped'; version: string; rules: PluginStatusRule[] };

/** Shipped plugins, merged over the instances. */
function builtinsOf(instances: GatewayInstanceStatus[]): Builtin[] {
  const found = new Map<string, Builtin>();
  const add = (b: Builtin): void => {
    const known = found.get(b.id);
    if (!known) found.set(b.id, b);
    else for (const r of b.rules) if (!known.rules.some((k) => k.id === r.id && k.strategy === r.strategy)) known.rules.push(r);
  };
  for (const i of instances) {
    i.plugins.filter((p) => p.kind === 'shipped').forEach((p) => add({ id: p.id, kind: 'shipped', version: p.version, rules: [...p.rules] }));
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function listPlugins(): Promise<Record<string, unknown>> {
  const [packages, enabled, gatewayStatus] = await Promise.all([store.listPackages(), store.readEnabledVersions(), readGatewayStatus()]);
  const adminVersion = getAdminVersion();
  const byId = new Map<string, typeof packages>();
  for (const p of packages) byId.set(p.pluginId, [...(byId.get(p.pluginId) ?? []), p]);

  const plugins = [...byId.entries()].map(([id, rows]) => ({
    id,
    enabledVersion: enabled.get(id) ?? null,
    versions: rows.map((r) => {
      const manifest = parse(r.manifest);
      let compatible = false;
      try { compatible = isCompatible({ gateway: String(manifest.gateway) }, adminVersion); } catch { /* unreadable range: not compatible */ }
      return {
        version: r.version, sha256: r.sha256, sizeBytes: r.sizeBytes, uploadedBy: r.createdBy, uploadedAt: r.createdAt,
        gateway: manifest.gateway ?? null, compatible, help: manifest.help ?? {}, hasSettings: !!manifest.settings,
      };
    }),
    status: gatewayStatus.instances.flatMap((i) => i.plugins.filter((p) => p.kind === 'installed' && p.id === id).map((p) => ({
      instance: i.instance, version: p.version, state: p.state, ...(p.error ? { error: p.error } : {}), rules: p.rules, at: i.at,
    }))),
  }));

  return {
    enabled: store.isInstallEnabled(),
    adminVersion,
    gatewayStatus,
    plugins,
    builtins: builtinsOf(gatewayStatus.instances),
  };
}
