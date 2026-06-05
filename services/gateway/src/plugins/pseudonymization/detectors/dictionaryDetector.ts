/**
 * Tier 3: Dictionary-based Entity Detection
 *
 * Matches against curated word lists using case-insensitive whole-word boundary
 * matching. Builds a single combined regex per dictionary for efficient single-pass
 * matching.
 */

import { EntityMatch, EntityConfig } from '../types';
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
 * Run dictionary detection on the given text
 */
export function detectDictionaryEntities(text: string, enabledEntities: EntityConfig[]): EntityMatch[] {
  const enabledTypes = new Set(enabledEntities.filter(e => e.enabled !== false).map(e => e.type));
  const sensitiveDataEnabled = enabledTypes.has('profile-sensitive-data');

  const matches: EntityMatch[] = [];

  for (const dict of compiledDictionaries) {
    if (!enabledTypes.has(dict.type) && !sensitiveDataEnabled) {
      continue;
    }

    dict.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = dict.regex.exec(text)) !== null) {
      matches.push({
        original: match[0],
        type: dict.type,
        start: match.index,
        end: match.index + match[0].length,
        priority: 3, // Tier 3: dictionary
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
      });
    }
  }

  return matches;
}
