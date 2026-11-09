/**
 * The containment in force for a request, keyed by its replacement map.
 *
 * The map is the one object every unmask site already holds - the plugin's own handlers, the SSE
 * interceptor, the hosted-tool engine's continuation rounds - so hanging the containment on it
 * reaches all of them without threading a parameter through a dozen signatures, and a finished
 * request's entry dies with its map. No entry means no containment (`unknown_placeholders: off`,
 * anonymization, or a request that masked nothing).
 */
import type { ReplacementMap } from './replacementMap';
import type { ContainmentOptions } from './unknownPlaceholders';

const byMap = new WeakMap<ReplacementMap, ContainmentOptions>();

export function registerContainment(map: ReplacementMap, options: ContainmentOptions): void {
  byMap.set(map, options);
}

export function containmentOf(map: ReplacementMap | undefined | null): ContainmentOptions | undefined {
  return map ? byMap.get(map) : undefined;
}
