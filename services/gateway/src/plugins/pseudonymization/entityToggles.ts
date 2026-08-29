/**
 * Entity-category toggles for the pseudonymizationPlugin.
 *
 * api_config.json can enable/disable masking categories with boolean maps
 * ({ "<category>": true|false }) at three layers: global
 * (api_config.observability.pseudonymization.entities), per endpoint
 * (api_config.hooks.defaults.<endpoint>.pseudonymization.entities), and per model
 * (api_config.models.overrides.<model>.pseudonymization.entities). Later layers win.
 *
 * These toggles configure the plugin's DEFAULT entity set (force-config and
 * triggerword activation) only. They do not activate masking by themselves —
 * the plugin must be wired into the hook chain and an activation source must
 * fire — and an explicit caller-supplied body `masking` config is used as-is.
 */

import { EntityConfig } from './types';
import { getDefaultLogger } from '@libs/logger';

/**
 * Categories that are KNOWN and toggleable but not enabled by default.
 *
 * `applyEntityToggles` encodes enabled-ness as presence in the entity array, so
 * "off by default" means absent from DEFAULT_MASKING_CONFIG. That alone would also
 * drop the name from the known set below, and an operator's `"profile-org": true`
 * would be rejected as an unknown toggle — silently no masking, which is the exact
 * failure these categories already had. Listing them here keeps off-by-default and
 * toggleable independent.
 */
export const OPT_IN_ENTITY_TYPES: readonly string[] = [
  'profile-org',
  'profile-location',
  'profile-ip-address',
];

/** All category types the plugin understands, for toggle validation. */
export function buildKnownEntityTypes(defaults: EntityConfig[]): Set<string> {
  return new Set([...defaults.map(e => e.type), 'profile-sensitive-data', ...OPT_IN_ENTITY_TYPES]);
}

// Unknown toggle keys already warned about (one WARN per key per process, not per request).
const warnedUnknownToggles = new Set<string>();

/**
 * Apply a toggle map to a base entity list. `false` removes the category,
 * `true` adds it if absent; categories not mentioned keep their current state.
 * Unknown category names are ignored with a single WARN — a typo can never
 * crash request handling or silently widen masking. Pure — returns a new array.
 */
export function applyEntityToggles(
  base: EntityConfig[],
  toggles: Record<string, boolean> | null | undefined,
  knownTypes: Set<string>
): EntityConfig[] {
  if (!toggles || typeof toggles !== 'object') return base;

  let result = base.slice();
  for (const [type, enabled] of Object.entries(toggles)) {
    if (typeof enabled !== 'boolean') continue;
    if (!knownTypes.has(type)) {
      if (!warnedUnknownToggles.has(type)) {
        warnedUnknownToggles.add(type);
        getDefaultLogger().warn('Pseudonymization',
          `Ignoring unknown entity toggle '${type}' in api_config.json pseudonymization config (known types: ${Array.from(knownTypes).join(', ')})`);
      }
      continue;
    }
    if (enabled === false) {
      result = result.filter(e => e.type !== type);
    } else if (!result.some(e => e.type === type)) {
      result.push({ type });
    }
  }
  return result;
}
