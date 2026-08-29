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
import { detectOrgLocationEntities } from './orgLocationDetector';
import { isTechnicalSpan, EXEMPT_FROM_SUPPRESSION } from './technicalContext';
import {
  isCapsPersonCandidate,
  resolveThresholds,
  scoreMatch,
  thresholdFor,
} from './confidence';
import { compileAllowlist, isAllowlisted } from './allowlist';
import { FIRST_NAMES } from '../dictionaries/firstNames';

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

  // Tier 1: Organisation (legal-form suffixes) and location (configured gazetteer).
  // Same priority as structural regex: this must outrank the NER person heuristic,
  // which otherwise labels configured locations as `profile-person`.
  allMatches.push(...detectOrgLocationEntities(text, config));

  // Tier 2: NER
  allMatches.push(...detectNerEntities(text, config.entities));

  // Tier 3: Dictionary. Gets the matches found so far: the categories whose terms are
  // ordinary English words only mask in the neighbourhood of a person, and a person
  // detected by an earlier tier is the strongest evidence of that.
  allMatches.push(...detectDictionaryEntities(text, config.entities, allMatches));

  // Never re-mask an existing placeholder: drop any match overlapping one.
  const reserved = placeholderSpans(text);
  const notPlaceholder = reserved.length === 0
    ? allMatches
    : allMatches.filter(m => !reserved.some(s => m.start < s.end && m.end > s.start));

  // Filter allow-list
  const filtered = notPlaceholder.filter(m => !isAllowed(m.original, config.allow_list));

  // Technical-context suppression: drop candidates that are part of the text's machinery
  // (object names, SQL, JSON keys, paths, code) rather than a value about a person. Runs
  // BEFORE overlap resolution so a vetoed span cannot shadow a real one that overlaps it,
  // and never touches operator intent or checksum-validated PII (EXEMPT_FROM_SUPPRESSION).
  //
  // One conversion (`isCapsPersonCandidate`): a SHOUTED NAME carrying person evidence is
  // scored rather than vetoed. The veto reads `JOHN SMITH` and `RSPROCESS INFOAREA` the
  // same way; the score does not. Nothing else is lifted, and a lifted span still has to
  // clear the threshold below — see confidence.ts.
  const surviving = filtered.filter(
    m => EXEMPT_FROM_SUPPRESSION.has(m.type)
      || !isTechnicalSpan(text, m.start, m.end).technical
      || isCapsPersonCandidate(m, text, FIRST_NAMES),
  );

  // Operator allow-list: `pseudonymization.allowlist`'s terms and patterns, applied AFTER the
  // veto and BEFORE scoring. Deliberately in that position — an allowed span is a decision this
  // deployment has already made, so it must outrank every piece of evidence the scorer could
  // find for masking it, and it must not be spent vetoing a span the veto would have dropped
  // anyway. A hit is final: nothing below can bring the span back.
  const allowlist = compileAllowlist(config.allowlist);
  const permitted = allowlist === undefined
    ? surviving
    : surviving.filter(m => !isAllowlisted(m.original, allowlist));

  // Confidence: every surviving candidate is re-scored from the evidence around it, then
  // measured against its category's threshold. Each candidate is scored from ITS OWN
  // surroundings only — nothing about the request as a whole enters the score, so how many
  // other values a text carries can never change whether this one is masked.
  const ctx = { firstNames: FIRST_NAMES };
  const thresholds = resolveThresholds(config);
  const confident = permitted
    .map(m => ({ ...m, confidence: scoreMatch(m, text, ctx) }))
    .filter(m => m.confidence >= thresholdFor(m.type, thresholds));

  // Resolve overlaps
  return resolveOverlaps(confident);
}
