/**
 * Detection Pipeline Orchestrator
 *
 * Runs all detection tiers, applies allow-list filtering, and resolves overlaps.
 * Priority order: custom (0) > regex (1) > NER (2) > dictionary (3)
 * Within same tier: longest match wins.
 */

import { EntityMatch, MaskingConfig } from '../types';
import { detectCustomEntities } from './customDetector';
import { detectRegexEntities } from './regexDetectors';
import { detectNerEntities } from './nerDetector';
import { detectDictionaryEntities } from './dictionaryDetector';

/**
 * Matches placeholders that ALREADY exist in the text so they are never re-masked.
 * Covers the `MASKED_<TYPE>_<id>` family and the URL-shaped `masked-url-<id>.invalid`
 * form. Re-masking a placeholder produces layered tokens ("keeps getting re-masked")
 * that can never be unmasked back to the original value.
 */
const EXISTING_PLACEHOLDER = /MASKED_[A-Z_]+_[0-9a-f]+|(?:(?:https?|wss?|ftps?):\/\/)?masked-url-\d+\.invalid/g;

/** Spans in `text` occupied by placeholders that must be excluded from detection. */
function placeholderSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  EXISTING_PLACEHOLDER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXISTING_PLACEHOLDER.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * Check if a match is in the allow list
 */
function isAllowed(matchedText: string, allowList?: string[]): boolean {
  if (!allowList || allowList.length === 0) return false;

  const lowerMatch = matchedText.toLowerCase();
  for (const term of allowList) {
    if (lowerMatch === term.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve overlapping matches: keep higher priority, then longer match
 */
function resolveOverlaps(matches: EntityMatch[]): EntityMatch[] {
  if (matches.length <= 1) return matches;

  // Sort by priority ASC (lower number = higher priority), then length DESC, then start ASC
  const sorted = [...matches].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aLen = a.end - a.start;
    const bLen = b.end - b.start;
    if (aLen !== bLen) return bLen - aLen;
    return a.start - b.start;
  });

  const accepted: EntityMatch[] = [];

  for (const match of sorted) {
    const overlaps = accepted.some(
      a => match.start < a.end && match.end > a.start
    );
    if (!overlaps) {
      accepted.push(match);
    }
  }

  // Return sorted by start position for left-to-right replacement
  return accepted.sort((a, b) => a.start - b.start);
}

/**
 * Main detection pipeline: run all detectors, filter, and resolve overlaps
 */
export function detectEntities(text: string, config: MaskingConfig): EntityMatch[] {
  const allMatches: EntityMatch[] = [];

  // Tier 0: Custom regex (highest priority)
  allMatches.push(...detectCustomEntities(text, config.custom_entities));

  // Tier 1: Structural regex
  allMatches.push(...detectRegexEntities(text, config.entities));

  // Tier 2: NER
  allMatches.push(...detectNerEntities(text, config.entities));

  // Tier 3: Dictionary
  allMatches.push(...detectDictionaryEntities(text, config.entities));

  // Never re-mask an existing placeholder: drop any match overlapping one.
  const reserved = placeholderSpans(text);
  const notPlaceholder = reserved.length === 0
    ? allMatches
    : allMatches.filter(m => !reserved.some(s => m.start < s.end && m.end > s.start));

  // Filter allow-list
  const filtered = notPlaceholder.filter(m => !isAllowed(m.original, config.allow_list));

  // Resolve overlaps
  return resolveOverlaps(filtered);
}
