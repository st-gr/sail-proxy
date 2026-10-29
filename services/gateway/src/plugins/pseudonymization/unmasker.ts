/**
 * Response Unmasker
 *
 * Scans response text for placeholder tokens and replaces them with original values.
 */

import { ReplacementMap } from './replacementMap';
import { containUnknownPlaceholders } from './unknownPlaceholders';
import type { ContainmentOptions } from './unknownPlaceholders';
import { mapJsonStringLiterals } from '../../utils/jsonStringLeaves';

/**
 * The alternation regex over a map's placeholders, cached per map.
 *
 * Rebuilding it per call is what made unmaskJsonValue quadratic-feeling on a large
 * body: it walks EVERY string in the tree, and a request with a hundred masked values
 * paid a hundred-branch regex compilation for each one (~4.6ms on a single terminal
 * Responses frame).
 *
 * WHY `reverse.size` IS A SUFFICIENT CACHE KEY — do not "simplify" this check away.
 * It is NOT that the map stops changing before the first unmask: it does not.
 * `fileSearch/chunkMasking.ts`'s `maskThroughRequestMap` mints placeholders on this same
 * request map during TOOL EXECUTION, which can happen mid-stream, i.e. between two
 * unmask calls. The key holds for a different reason — the regex is built from the KEY
 * SET alone, and that set is append-only:
 *   - every write to `reverse` is a `set` (replacementMap.ts:122,130; replacer.ts:142);
 *     nothing deletes or clears it, ever;
 *   - each is guarded by a `forward.has(originalValue)` short-circuit
 *     (replacementMap.ts:74-76; replacer.ts:139), so a value already mapped never
 *     re-enters;
 *   - therefore any change to the key set changes `reverse.size`, and the cache misses.
 * `fabricated_data` mode used to be an exception: `generateFakeValue` gives up probing
 * after 10 attempts (fabricatedData.ts:67-70) and can still return a colliding fake, which
 * would have overwritten an existing reverse entry (a same-size write the cache key could
 * not see). `replacer.ts` now detects that collision before writing and falls back to the
 * content-hash placeholder instead, which is unique by construction — so every write to
 * `reverse` is unconditionally a new key, and the invariant above holds without exception.
 *
 * WeakMap so a finished request's regex dies with its map.
 */
const regexByMap = new WeakMap<ReplacementMap, { size: number; regex: RegExp | null }>();

function placeholderRegex(map: ReplacementMap): RegExp | null {
  const cached = regexByMap.get(map);
  if (cached && cached.size === map.reverse.size) return cached.regex;

  // Escape special chars, sort by length DESC so a longer placeholder wins over a
  // shorter one it starts with.
  const placeholders = Array.from(map.reverse.keys()).sort((a, b) => b.length - a.length);
  const regex = placeholders.length === 0
    ? null
    : new RegExp(placeholders.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

  regexByMap.set(map, { size: map.reverse.size, regex });
  return regex;
}

/**
 * Unmask all placeholder tokens in text using the reverse map
 */
export function unmaskText(text: string, map: ReplacementMap, containment?: ContainmentOptions): string {
  if (map.size === 0) return text;

  // A placeholder the model INVENTED is in no map and can never be resolved. It is withheld
  // BEFORE the known ones are resolved, so a restored original is never itself scanned for
  // placeholder shapes (see unknownPlaceholders.ts for the incident and the measurements).
  let source = text;
  if (containment) {
    const contained = containUnknownPlaceholders(text, map.reverse, containment.inbound, containment.withhold !== false);
    if (contained.unknown.length > 0) containment.onUnknown(contained.unknown);
    source = contained.text;
  }

  const regex = placeholderRegex(map);
  if (!regex) return source;

  // The regex is shared across calls now; String.replace resets lastIndex itself, but
  // being explicit keeps that independent of how the cached object got here.
  regex.lastIndex = 0;
  return source.replace(regex, (match) => map.reverse.get(match) || match);
}

/**
 * Recursively walk an arbitrary JSON value and unmask placeholders in every string.
 * Used for tool_use.input objects (Anthropic) where placeholders may appear at any depth.
 * Mutates arrays/objects in-place; returns primitives unchanged.
 */
export function unmaskJsonValue(value: any, map: ReplacementMap, containment?: ContainmentOptions): any {
  if (typeof value === 'string') return unmaskText(value, map, containment);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = unmaskJsonValue(value[i], map, containment);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = unmaskJsonValue(value[k], map, containment);
    return value;
  }
  return value;
}

/**
 * Unmask a tool call's JSON-text arguments literal by literal (object keys included): each
 * string literal holding a placeholder is re-encoded with the restored value, so a value
 * containing `"` or `\` stays valid JSON and every other byte, large numbers included, stays
 * as the model wrote it. Arguments that are not JSON (a truncated call) are restored as text.
 */
export function unmaskJsonArguments(text: string, map: ReplacementMap, containment?: ContainmentOptions): string {
  if (map.size === 0) return text;
  const unmask = (s: string) => unmaskText(s, map, containment);
  return mapJsonStringLiterals(text, unmask) ?? unmask(text);
}

/**
 * unmaskJsonValue for a whole response body or stream frame: the same walk, except that a
 * string under an `arguments` key (OpenAI `function.arguments`, Responses
 * `function_call.arguments`) is JSON text and goes through unmaskJsonArguments.
 */
export function unmaskResponseBody(value: any, map: ReplacementMap, containment?: ContainmentOptions): any {
  if (typeof value === 'string') return unmaskText(value, map, containment);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = unmaskResponseBody(value[i], map, containment);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      value[k] = k === 'arguments' && typeof value[k] === 'string'
        ? unmaskJsonArguments(value[k], map, containment)
        : unmaskResponseBody(value[k], map, containment);
    }
    return value;
  }
  return value;
}
