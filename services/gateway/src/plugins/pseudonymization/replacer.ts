/**
 * Text Replacer
 *
 * Applies detected entity matches to text, replacing originals with placeholders.
 * Processes matches in reverse order of position to preserve character offsets.
 */

import { EntityMatch, MaskingConfig, EntityConfig } from './types';
import { ReplacementMap } from './replacementMap';
import { generateFakeValue } from './fabricatedData';
import { detectEntities } from './detectors';

/**
 * Get the replacement strategy for an entity type from config
 */
function getStrategy(entityType: string, config: MaskingConfig): 'constant' | 'fabricated_data' {
  const entityConfig = config.entities.find(e => e.type === entityType);
  return entityConfig?.replacement_strategy || 'constant';
}

/**
 * Get custom prefix for an entity type from config
 */
function getCustomPrefix(entityType: string, config: MaskingConfig): string | undefined {
  const entityConfig = config.entities.find(e => e.type === entityType);
  return entityConfig?.replacement_value;
}

/**
 * Replace all detected entities in text with their placeholders
 * Returns the masked text
 */
export function replaceEntities(
  text: string,
  matches: EntityMatch[],
  map: ReplacementMap,
  config: MaskingConfig
): string {
  if (matches.length === 0) return text;

  // Process in reverse order to preserve character offsets
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let result = text;

  for (const match of sorted) {
    const strategy = getStrategy(match.type, config);
    const customPrefix = match.placeholder || getCustomPrefix(match.type, config);

    let placeholder: string;

    if (strategy === 'fabricated_data' && config.method === 'pseudonymization') {
      // For fabricated data: generate a fake value that serves as the placeholder
      const fake = generateFakeValue(match.type, match.original, map);
      // Store in map for reverse lookup
      if (!map.forward.has(match.original)) {
        map.forward.set(match.original, fake);
        map.reverse.set(fake, match.original);
      }
      placeholder = map.forward.get(match.original)!;
    } else {
      placeholder = map.getPlaceholder(match.type, match.original, customPrefix);
    }

    // Assign placeholder back to the match for masking_info
    match.placeholder = placeholder;

    result = result.slice(0, match.start) + placeholder + result.slice(match.end);
  }

  return result;
}

/**
 * Recursively walk an arbitrary JSON value and mask PII in every string.
 * Used for tool_use.input objects in prior assistant turns when a conversation is replayed.
 * Mutates arrays/objects in-place; returns primitives unchanged.
 *
 * Returns the count of masked entities so callers can report.
 */
export function maskJsonValue(
  value: any,
  map: ReplacementMap,
  config: MaskingConfig,
  collected?: EntityMatch[]
): { value: any; entities: EntityMatch[] } {
  const entities = collected || [];

  if (typeof value === 'string') {
    const detected = detectEntities(value, config);
    if (detected.length > 0) {
      entities.push(...detected);
      return { value: replaceEntities(value, detected, map, config), entities };
    }
    return { value, entities };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = maskJsonValue(value[i], map, config, entities);
      value[i] = r.value;
    }
    return { value, entities };
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const r = maskJsonValue(value[k], map, config, entities);
      value[k] = r.value;
    }
    return { value, entities };
  }
  return { value, entities };
}
