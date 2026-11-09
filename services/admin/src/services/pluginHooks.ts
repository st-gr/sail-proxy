/**
 * Merging a plugin's suggested hooks (manifest `hooks`, spec 2026-11-04 §7) into an api_config.
 * Pure: the input is never changed; the caller stores the result as a new configuration.
 */
import { isDeepStrictEqual } from 'util';
import type { PluginManifest } from '@libs/plugin-package';

export class HookConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookConflictError';
  }
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** True when the manifest offers any definition or any hook to add. */
export function hasSuggestedHooks(manifest: Pick<PluginManifest, 'hooks'>): boolean {
  const hooks = manifest.hooks;
  if (!isRecord(hooks)) return false;
  const defaults = isRecord(hooks.defaults) ? Object.values(hooks.defaults) : [];
  return (isRecord(hooks.definitions) && Object.keys(hooks.definitions).length > 0)
    || defaults.some((provider) => isRecord(provider) && Object.values(provider).some((list) => Array.isArray(list) && list.length > 0));
}

export function mergeSuggestedHooks(
  apiConfig: Record<string, unknown>,
  manifest: Pick<PluginManifest, 'hooks'>,
): { apiConfig: Record<string, unknown>; warnings: string[] } {
  const merged: Record<string, any> = clone(apiConfig);
  const warnings: string[] = [];
  const suggested = isRecord(manifest.hooks) ? manifest.hooks : {};

  if (isRecord(suggested.definitions)) {
    for (const [id, definition] of Object.entries(suggested.definitions)) {
      const existing = merged.hooks?.definitions?.[id];
      if (existing !== undefined && !isDeepStrictEqual(existing, definition)) {
        throw new HookConflictError(`The configuration already defines the rule "${id}" differently.`);
      }
    }
    for (const [id, definition] of Object.entries(suggested.definitions)) {
      merged.hooks = isRecord(merged.hooks) ? merged.hooks : {};
      merged.hooks.definitions = isRecord(merged.hooks.definitions) ? merged.hooks.definitions : {};
      merged.hooks.definitions[id] = clone(definition);
    }
  }

  const subpaths = new Set<string>();
  if (isRecord(suggested.defaults)) {
    for (const [provider, lists] of Object.entries(suggested.defaults)) {
      if (!isRecord(lists)) continue;
      for (const [subpath, entries] of Object.entries(lists)) {
        if (!Array.isArray(entries)) continue;
        merged.hooks = isRecord(merged.hooks) ? merged.hooks : {};
        merged.hooks.defaults = isRecord(merged.hooks.defaults) ? merged.hooks.defaults : {};
        merged.hooks.defaults[provider] = isRecord(merged.hooks.defaults[provider]) ? merged.hooks.defaults[provider] : {};
        const list: unknown[] = Array.isArray(merged.hooks.defaults[provider][subpath]) ? merged.hooks.defaults[provider][subpath] : [];
        for (const entry of entries) if (!list.some((known) => isDeepStrictEqual(known, entry))) list.push(clone(entry));
        merged.hooks.defaults[provider][subpath] = list;
        if (entries.length > 0) subpaths.add(subpath);
      }
    }
  }

  const overrides = merged.models?.overrides;
  if (isRecord(overrides)) {
    for (const [model, override] of Object.entries(overrides)) {
      const own = isRecord(override) && isRecord(override.hooks) ? Object.keys(override.hooks).filter((s) => subpaths.has(s)) : [];
      if (own.length > 0) {
        warnings.push(`Model "${model}" has its own hook list for ${own.join(', ')}, which replaces the defaults: the plugin will not run there until you add its hooks to that list.`);
      }
    }
  }
  return { apiConfig: merged, warnings };
}
