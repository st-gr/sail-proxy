/**
 * Response Unmasker
 *
 * Scans response text for placeholder tokens and replaces them with original values.
 */

import { ReplacementMap } from './replacementMap';

/**
 * Unmask all placeholder tokens in text using the reverse map
 */
export function unmaskText(text: string, map: ReplacementMap): string {
  if (map.size === 0) return text;

  // Build regex from all known placeholders (escape special chars, sort by length DESC)
  const placeholders = Array.from(map.reverse.keys())
    .sort((a, b) => b.length - a.length);

  if (placeholders.length === 0) return text;

  // Build alternation regex for all known placeholders
  const escaped = placeholders.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(escaped.join('|'), 'g');

  return text.replace(regex, (match) => map.reverse.get(match) || match);
}

/**
 * Recursively walk an arbitrary JSON value and unmask placeholders in every string.
 * Used for tool_use.input objects (Anthropic) where placeholders may appear at any depth.
 * Mutates arrays/objects in-place; returns primitives unchanged.
 */
export function unmaskJsonValue(value: any, map: ReplacementMap): any {
  if (typeof value === 'string') return unmaskText(value, map);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = unmaskJsonValue(value[i], map);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = unmaskJsonValue(value[k], map);
    return value;
  }
  return value;
}
