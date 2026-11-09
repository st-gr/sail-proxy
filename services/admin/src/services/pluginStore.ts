/**
 * The plugin package store (spec 2026-11-04 §5, §7, §8): PluginPackages holds every uploaded
 * version, PluginStates names the enabled one. Plain statements through cds.run, each its own
 * transaction. Enabling and removing a version are the exceptions: each is one short local transaction
 * of database statements only (never a gateway call or other async work), which locks the package row
 * first, so an enable can never leave a state naming a version a remove deleted.
 *
 * Lists never select `contentBase64`; only `readPackageContent` does, for one package.
 */
import { isUniqueViolation } from '../utils/dbErrors';

const cds = require('@sap/cds');

export { isUniqueViolation };

export const PACKAGES = 'sap.llm.gateway.admin.PluginPackages';
export const STATES = 'sap.llm.gateway.admin.PluginStates';

/** `INSTALLED_PLUGINS_ENABLED`: unset, or anything but `false`, means on. Built-ins are exempt. */
export function isInstallEnabled(): boolean {
  return String(process.env.INSTALLED_PLUGINS_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

export type PackageSummary = {
  pluginId: string;
  version: string;
  sha256: string;
  manifest: string;
  sizeBytes: number;
  createdAt: string;
  createdBy: string;
};

export type NewPackage = { pluginId: string; version: string; sha256: string; manifest: string; contentBase64: string; sizeBytes: number };

const SUMMARY_COLUMNS = ['pluginId', 'version', 'sha256', 'manifest', 'sizeBytes', 'createdAt', 'createdBy'];

export const listPackages = (): Promise<PackageSummary[]> =>
  cds.run(cds.ql.SELECT.from(PACKAGES).columns(...SUMMARY_COLUMNS).orderBy('pluginId', 'version'));

export const findPackage = async (pluginId: string, version: string): Promise<PackageSummary | undefined> =>
  (await cds.run(cds.ql.SELECT.one.from(PACKAGES).columns(...SUMMARY_COLUMNS).where({ pluginId, version }))) ?? undefined;

export const readPackageContent = async (pluginId: string, version: string): Promise<{ sha256: string; contentBase64: string } | undefined> =>
  (await cds.run(cds.ql.SELECT.one.from(PACKAGES).columns('sha256', 'contentBase64').where({ pluginId, version }))) ?? undefined;

export const insertPackage = (pkg: NewPackage, actor: string): Promise<unknown> =>
  cds.run(cds.ql.INSERT.into(PACKAGES).entries({ ...pkg, createdBy: actor, modifiedBy: actor }));

export const deletePackage = (pluginId: string, version: string): Promise<unknown> =>
  cds.run(cds.ql.DELETE.from(PACKAGES).where({ pluginId, version }));

/** pluginId -> enabled version, for the plugins that have one. */
export async function readEnabledVersions(): Promise<Map<string, string>> {
  const rows: { pluginId: string; enabledVersion: string | null }[] = await cds.run(cds.ql.SELECT.from(STATES).columns('pluginId', 'enabledVersion'));
  return new Map(rows.filter((r) => r.enabledVersion).map((r) => [r.pluginId, r.enabledVersion as string]));
}

/** Set the enabled version, or null to disable. */
export async function setEnabledVersion(pluginId: string, version: string | null, actor: string): Promise<void> {
  const existing = await cds.run(cds.ql.SELECT.one.from(STATES).columns('pluginId').where({ pluginId }));
  if (existing) {
    await cds.run(cds.ql.UPDATE(STATES).set({ enabledVersion: version, modifiedBy: actor }).where({ pluginId }));
  } else {
    await cds.run(cds.ql.INSERT.into(STATES).entries({ pluginId, enabledVersion: version, createdBy: actor, modifiedBy: actor }));
  }
}

/** What the gateway is told to install: each enabled version that has a stored package. */
export async function wantedPlugins(): Promise<{ id: string; version: string; sha256: string }[]> {
  const enabled = await readEnabledVersions();
  if (enabled.size === 0) return [];
  const rows: { pluginId: string; version: string; sha256: string }[] =
    await cds.run(cds.ql.SELECT.from(PACKAGES).columns('pluginId', 'version', 'sha256'));
  return rows.filter((r) => enabled.get(r.pluginId) === r.version).map((r) => ({ id: r.pluginId, version: r.version, sha256: r.sha256 }));
}

/**
 * The manifest text of each enabled version (no package content), keyed by plugin id. Empty while
 * INSTALLED_PLUGINS_ENABLED is off: the gateways are then told about no plugin, so none counts as enabled.
 */
export async function readEnabledManifests(): Promise<Map<string, { version: string; manifest: string }>> {
  const result = new Map<string, { version: string; manifest: string }>();
  if (!isInstallEnabled()) return result;
  const enabled = await readEnabledVersions();
  if (enabled.size === 0) return result;
  const rows: { pluginId: string; version: string; manifest: string }[] =
    await cds.run(cds.ql.SELECT.from(PACKAGES).columns('pluginId', 'version', 'manifest'));
  for (const row of rows) if (enabled.get(row.pluginId) === row.version) result.set(row.pluginId, { version: row.version, manifest: row.manifest });
  return result;
}

export const deleteState = (pluginId: string): Promise<unknown> => cds.run(cds.ql.DELETE.from(STATES).where({ pluginId }));

export async function countPackages(pluginId: string): Promise<number> {
  const rows: { version: string }[] = await cds.run(cds.ql.SELECT.from(PACKAGES).columns('version').where({ pluginId }));
  return rows.length;
}

export type EnableOutcome =
  | { status: 'enabled'; pkg: PackageSummary; previous: string | null }
  | { status: 'missing' }
  | { status: 'refused'; pkg: PackageSummary };

/** Enable a stored version if `accept` allows it (a synchronous check). One transaction, package row locked first. */
export const enableVersion = (pluginId: string, version: string, actor: string, accept: (pkg: PackageSummary) => boolean): Promise<EnableOutcome> =>
  cds.tx(async (tx: any): Promise<EnableOutcome> => {
    const pkg: PackageSummary | undefined = await tx.run(cds.ql.SELECT.one.from(PACKAGES).columns(...SUMMARY_COLUMNS).where({ pluginId, version }).forUpdate());
    if (!pkg) return { status: 'missing' };
    if (!accept(pkg)) return { status: 'refused', pkg };
    const state = await tx.run(cds.ql.SELECT.one.from(STATES).columns('pluginId', 'enabledVersion').where({ pluginId }));
    if (state) {
      await tx.run(cds.ql.UPDATE(STATES).set({ enabledVersion: version, modifiedBy: actor }).where({ pluginId }));
    } else {
      await tx.run(cds.ql.INSERT.into(STATES).entries({ pluginId, enabledVersion: version, createdBy: actor, modifiedBy: actor }));
    }
    return { status: 'enabled', pkg, previous: state?.enabledVersion ?? null };
  });

export type RemoveOutcome = { status: 'removed'; pkg: PackageSummary } | { status: 'missing' } | { status: 'enabled' };

/** Remove a stored version unless it is the enabled one; the last version takes the state row with it. One transaction, package row locked first. */
export const removeStoredVersion = (pluginId: string, version: string): Promise<RemoveOutcome> =>
  cds.tx(async (tx: any): Promise<RemoveOutcome> => {
    const pkg: PackageSummary | undefined = await tx.run(cds.ql.SELECT.one.from(PACKAGES).columns(...SUMMARY_COLUMNS).where({ pluginId, version }).forUpdate());
    if (!pkg) return { status: 'missing' };
    const state = await tx.run(cds.ql.SELECT.one.from(STATES).columns('enabledVersion').where({ pluginId }));
    if (state?.enabledVersion === version) return { status: 'enabled' };
    await tx.run(cds.ql.DELETE.from(PACKAGES).where({ pluginId, version }));
    const left: unknown[] = await tx.run(cds.ql.SELECT.from(PACKAGES).columns('version').where({ pluginId }));
    if (left.length === 0) await tx.run(cds.ql.DELETE.from(STATES).where({ pluginId }));
    return { status: 'removed', pkg };
  });
