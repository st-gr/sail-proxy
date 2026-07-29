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
 * Minimum length of a detected value for it to be propagated (masked at ALL its
 * exact occurrences across the request). Short values are masked only where a
 * detector actually fired — propagating them risks carpet-masking common strings.
 */
export const MIN_PROPAGATION_LENGTH = 12;

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Propagate already-minted masks to EVERY exact occurrence of each detected value
 * across the request's string nodes — including places no detector fired (e.g. a
 * secret that was caught as `token=<secret>` in one node but rode through as
 * `Authorization: Bearer <secret>` in another). This is the primary security fix:
 * one value → one token → masked everywhere.
 *
 * Operates on parsed string nodes (system + messages subtree), so JSON-escaping in
 * embedded tool_result strings is a non-issue. For values containing `"` or `\`, the
 * JSON-escaped form is also searched (an identical secret embedded inside a
 * JSON-in-string blob is escaped there). Mutates `body` in place; returns the number
 * of occurrences replaced.
 */
export function propagateMaskedValues(
  body: any,
  map: ReplacementMap,
  opts: { minLength?: number } = {}
): number {
  const minLength = opts.minLength ?? MIN_PROPAGATION_LENGTH;

  // Build (needle → placeholder) pairs. Include the JSON-escaped form of any value
  // containing escapable characters so it also matches inside JSON-in-string blobs.
  const needles: Array<{ text: string; placeholder: string }> = [];
  for (const [value, placeholder] of map.forward) {
    if (typeof value !== 'string' || value.length < minLength) continue;
    needles.push({ text: value, placeholder });
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value && escaped.length >= minLength) {
      needles.push({ text: escaped, placeholder });
    }
  }
  if (needles.length === 0) return 0;

  // Longest needle first so a value that is a substring of another is not shadowed.
  needles.sort((a, b) => b.text.length - a.text.length);
  const byText = new Map(needles.map(n => [n.text, n.placeholder]));
  const alternation = new RegExp(
    needles.map(n => n.text.replace(REGEX_META, '\\$&')).join('|'),
    'g'
  );

  let replaced = 0;
  const replaceInString = (s: string): string =>
    s.replace(alternation, (matchStr, offset: number, whole: string) => {
      // Word-boundary guard: don't fire mid-identifier when the value's own edge is
      // a word char and the adjacent text char is too (would corrupt an identifier).
      const before = whole[offset - 1];
      const after = whole[offset + matchStr.length];
      if (WORD_CHAR.test(matchStr[0]) && before !== undefined && WORD_CHAR.test(before)) return matchStr;
      if (WORD_CHAR.test(matchStr[matchStr.length - 1]) && after !== undefined && WORD_CHAR.test(after)) return matchStr;
      replaced++;
      return byText.get(matchStr) ?? matchStr;
    });

  const walk = (value: any): any => {
    if (typeof value === 'string') return replaceInString(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i]);
      return value;
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) value[k] = walk(value[k]);
      return value;
    }
    return value;
  };

  if (body?.system !== undefined) body.system = walk(body.system);
  if (Array.isArray(body?.messages)) walk(body.messages);
  if (body?.instructions !== undefined) body.instructions = walk(body.instructions);
  if (body?.input !== undefined) body.input = walk(body.input);

  return replaced;
}

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
