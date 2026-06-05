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

  // Filter allow-list
  const filtered = allMatches.filter(m => !isAllowed(m.original, config.allow_list));

  // Resolve overlaps
  return resolveOverlaps(filtered);
}
