/**
 * Tier 2: NER-based Entity Detection via wink-nlp
 *
 * Detects person names, organizations, and locations using wink-nlp's
 * English model. The model is loaded once at module initialization.
 */

import { EntityMatch, EntityConfig } from '../types';

// wink-nlp initialization (loaded once at module level)
let nlp: any = null;

function getNlp() {
  if (!nlp) {
    try {
      const winkNLP = require('wink-nlp');
      const model = require('wink-eng-lite-web-model');
      nlp = winkNLP(model);
    } catch (error: any) {
      console.error(`[pseudonymization] Failed to load wink-nlp: ${error.message}`);
      return null;
    }
  }
  return nlp;
}

// Mapping from wink-nlp entity types to our entity types
const NER_TYPE_MAP: Record<string, string> = {
  'PERSON': 'profile-person',
  'ORG': 'profile-org',
  'ORGANIZATION': 'profile-org',
  'GPE': 'profile-location',
  'LOC': 'profile-location',
  'LOCATION': 'profile-location',
  'PLACE': 'profile-location',
};

/**
 * Run NER detection on the given text
 */
export function detectNerEntities(text: string, enabledEntities: EntityConfig[]): EntityMatch[] {
  const enabledTypes = new Set(enabledEntities.filter(e => e.enabled !== false).map(e => e.type));

  // Check if any NER-detectable types are enabled
  const nerTypes = ['profile-person', 'profile-org', 'profile-location'];
  const anyEnabled = nerTypes.some(t => enabledTypes.has(t));
  if (!anyEnabled) return [];

  const engine = getNlp();
  if (!engine) return [];

  const matches: EntityMatch[] = [];

  try {
    const doc = engine.readDoc(text);
    const entities = doc.entities();

    // Collect unique entities from NER
    const nerEntities: Array<{ text: string; type: string }> = [];

    entities.each((entity: any) => {
      const entityType = entity.out(engine.its.type);
      const mappedType = NER_TYPE_MAP[entityType];

      if (!mappedType || !enabledTypes.has(mappedType)) return;

      const entityText = entity.out();
      if (!entityText || entityText.trim().length === 0) return;

      // Deduplicate
      if (!nerEntities.some(e => e.text === entityText && e.type === mappedType)) {
        nerEntities.push({ text: entityText, type: mappedType });
      }
    });

    // For each unique NER entity, find ALL occurrences in the text
    for (const nerEntity of nerEntities) {
      let searchFrom = 0;
      while (true) {
        const start = text.indexOf(nerEntity.text, searchFrom);
        if (start === -1) break;

        matches.push({
          original: nerEntity.text,
          type: nerEntity.type,
          start,
          end: start + nerEntity.text.length,
          priority: 2,
        });

        searchFrom = start + nerEntity.text.length;
      }
    }

    // For person detection: also check for sequences of proper nouns (capitalized words)
    // that wink-nlp may miss. This is a supplemental heuristic.
    // Once a name is found, search for ALL occurrences in the text.
    if (enabledTypes.has('profile-person')) {
      const tokens = doc.tokens();
      let currentName: string[] = [];
      const detectedNames = new Set<string>();

      // Common words that can be POS-tagged as PROPN at sentence start or mid-sentence
      const EXCLUDED_WORDS = new Set([
        'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your',
        'his', 'her', 'its', 'our', 'their', 'call', 'please', 'dear',
        'hello', 'hi', 'hey', 'thank', 'thanks', 'sorry', 'note', 'see',
        'also', 'just', 'here', 'there', 'today', 'now', 'then',
        'contact', 'local', 'regard', 'sincerely', 'best', 'next',
      ]);

      tokens.each((token: any) => {
        const tokenText = token.out();
        const pos = token.out(engine.its.pos);

        // Accept as part of a name: PROPN, not excluded, starts with uppercase
        const isNameToken = (pos === 'PROPN' || pos === 'NNP')
          && tokenText.length > 1
          && /^[A-Z]/.test(tokenText)
          && !EXCLUDED_WORDS.has(tokenText.toLowerCase());

        if (isNameToken) {
          currentName.push(tokenText);
        } else {
          if (currentName.length >= 2 && currentName.length <= 4) {
            const fullName = currentName.join(' ');
            if (!detectedNames.has(fullName)) {
              detectedNames.add(fullName);
              // Find ALL occurrences of this name in the text
              let searchFrom = 0;
              while (true) {
                const start = text.indexOf(fullName, searchFrom);
                if (start === -1) break;
                const alreadyDetected = matches.some(
                  m => m.start === start && m.end === start + fullName.length
                );
                if (!alreadyDetected) {
                  matches.push({
                    original: fullName,
                    type: 'profile-person',
                    start,
                    end: start + fullName.length,
                    priority: 2,
                  });
                }
                searchFrom = start + fullName.length;
              }
            }
          }
          currentName = [];
        }
      });

      // Handle trailing name at end of text
      if (currentName.length >= 2 && currentName.length <= 4) {
        const fullName = currentName.join(' ');
        if (!detectedNames.has(fullName)) {
          let searchFrom = 0;
          while (true) {
            const start = text.indexOf(fullName, searchFrom);
            if (start === -1) break;
            const alreadyDetected = matches.some(
              m => m.start === start && m.end === start + fullName.length
            );
            if (!alreadyDetected) {
              matches.push({
                original: fullName,
                type: 'profile-person',
                start,
                end: start + fullName.length,
                priority: 2,
              });
            }
            searchFrom = start + fullName.length;
          }
        }
      }
    }
  } catch (error: any) {
    console.error(`[pseudonymization] NER detection error: ${error.message}`);
  }

  return matches;
}
