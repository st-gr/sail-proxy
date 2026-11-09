/**
 * Tier 3: Dictionary-based Entity Detection
 *
 * Matches against curated word lists using case-insensitive whole-word boundary
 * matching. Builds a single combined regex per dictionary for efficient single-pass
 * matching.
 */

import { EntityMatch, EntityConfig } from '../types';
import { hasPersonContext } from './technicalContext';
import { DETECTOR_CONFIDENCE } from './confidenceScores';
import { NATIONALITIES } from '../dictionaries/nationalities';
import { ETHNICITIES } from '../dictionaries/ethnicities';
import { GENDERS } from '../dictionaries/genders';
import { RELIGIONS } from '../dictionaries/religions';
import { POLITICAL_GROUPS } from '../dictionaries/politicalGroups';
import { SEXUAL_ORIENTATIONS } from '../dictionaries/sexualOrientations';
import { TRADE_UNIONS } from '../dictionaries/tradeUnions';

interface DictionaryDef {
  type: string;
  terms: string[];
}

const DICTIONARIES: DictionaryDef[] = [
  { type: 'profile-nationality', terms: NATIONALITIES },
  { type: 'profile-ethnicity', terms: ETHNICITIES },
  { type: 'profile-gender', terms: GENDERS },
  { type: 'profile-religious-group', terms: RELIGIONS },
  { type: 'profile-political-group', terms: POLITICAL_GROUPS },
  { type: 'profile-sexual-orientation', terms: SEXUAL_ORIENTATIONS },
  { type: 'profile-trade-union', terms: TRADE_UNIONS },
];

// Pre-compiled combined regex per dictionary (built once at module load)
const compiledDictionaries: Array<{ type: string; regex: RegExp }> = [];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build combined regexes at module load time
for (const dict of DICTIONARIES) {
  if (dict.terms.length === 0) continue;
  // Sort by length descending so longer terms match first
  const sorted = [...dict.terms].sort((a, b) => b.length - a.length);
  const pattern = sorted.map(escapeRegex).join('|');
  compiledDictionaries.push({
    type: dict.type,
    regex: new RegExp(`\\b(${pattern})\\b`, 'gi'),
  });
}

// Trade union "Local" pattern
const localPattern = /\bLocal\s+\d+\b/g;

/**
 * Dictionaries whose terms are ordinary English words — POLITICAL_GROUPS carries
 * "Independent", "Moderate", "Liberal", "Progressive", "Green Party". In a personnel note
 * those are affiliations; in a release note or a BW chain listing they are noise, and the
 * incident of 2026-08-25 masked two of them out of pure technical text. Terms in these
 * categories only mask with person context nearby (spec: pseudonymization-precision).
 *
 * `profile-pronouns-gender` is listed although no dictionary produces it today (its only
 * producer is the already context-anchored regex): if a pronoun word-list is ever added,
 * it inherits the gate instead of silently shipping unanchored.
 */
const PERSON_CONTEXT_REQUIRED = new Set(['profile-political-group', 'profile-pronouns-gender']);

/**
 * Run dictionary detection on the given text.
 *
 * `priorMatches` are the candidates the earlier tiers produced; they are read only as
 * person-context evidence for PERSON_CONTEXT_REQUIRED categories, never modified.
 */
export function detectDictionaryEntities(
  text: string,
  enabledEntities: EntityConfig[],
  priorMatches: EntityMatch[] = [],
): EntityMatch[] {
  const enabledTypes = new Set(enabledEntities.filter(e => e.enabled !== false).map(e => e.type));
  const sensitiveDataEnabled = enabledTypes.has('profile-sensitive-data');

  const matches: EntityMatch[] = [];

  for (const dict of compiledDictionaries) {
    if (!enabledTypes.has(dict.type) && !sensitiveDataEnabled) {
      continue;
    }

    dict.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    const needsPerson = PERSON_CONTEXT_REQUIRED.has(dict.type);

    while ((match = dict.regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (needsPerson && !hasPersonContext(text, start, end, priorMatches)) continue;
      matches.push({
        original: match[0],
        type: dict.type,
        start,
        end,
        priority: 3, // Tier 3: dictionary
        // A word-list hit is exactly as strong as the word list is selective, and these
        // lists carry ordinary English words. 0.5 sits ON the default threshold: a
        // dictionary term masks by default, and stops masking the moment anything —
        // an ALL-CAPS shape, a saturated request — argues against it.
        confidence: DETECTOR_CONFIDENCE.dictionary,
      });
    }
  }

  // Trade union "Local NNN" pattern
  if (enabledTypes.has('profile-trade-union') || sensitiveDataEnabled) {
    localPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = localPattern.exec(text)) !== null) {
      matches.push({
        original: match[0],
        type: 'profile-trade-union',
        start: match.index,
        end: match.index + match[0].length,
        priority: 3,
        confidence: DETECTOR_CONFIDENCE.dictionary,
      });
    }
  }

  return matches;
}
