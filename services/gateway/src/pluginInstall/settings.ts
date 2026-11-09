import { readPluginManifest } from './sync';

/** Defaults by plugin; a plugin may ask per request, so the disk is read once per load. */
const defaultsCache = new Map<string, Record<string, unknown>>();

/** The loader calls this at the start of every load, so a reload always sees the manifests on disk. */
export function clearPluginSettingsCache(): void {
  defaultsCache.clear();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function defaultsOf(id: string, pluginsDir: string): Record<string, unknown> {
  const key = `${pluginsDir}\u0000${id}`;
  let defaults = defaultsCache.get(key);
  if (!defaults) {
    defaults = readPluginManifest(pluginsDir, id)?.settings?.defaults ?? {};
    defaultsCache.set(key, defaults);
  }
  return defaults;
}

/**
 * A plugin's settings: `stored` over its manifest's defaults, shallow merge. Works for
 * shipped and installed plugins alike. A stored value that is not an object counts as
 * absent, since standalone configuration is hand-edited and not validated. The caller
 * gets its own copy of everything, so it cannot change the next caller's defaults or
 * the live configuration.
 */
export function resolvePluginSettings(id: string, stored: unknown, pluginsDir: string): Record<string, unknown> {
  return { ...structuredClone(defaultsOf(id, pluginsDir)), ...(isRecord(stored) ? structuredClone(stored) : {}) };
}
