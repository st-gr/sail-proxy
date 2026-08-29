/**
 * Tier 2: NER-based Entity Detection via wink-nlp
 *
 * Detects person names, organizations, and locations using wink-nlp's
 * English model. The model is loaded once at module initialization.
 */

import { EntityMatch, EntityConfig } from '../types';
import { DETECTOR_CONFIDENCE } from './confidenceScores';

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

// Common words that can be POS-tagged as PROPN at sentence start or mid-sentence
// (capitalized by sentence position, not because they name anything). Shared with
// orgLocationDetector's leading-token trim so the two heuristics agree on what counts
// as ordinary prose rather than drifting apart.
// Spanish honorifics and salutations. Capitalised before a name, they otherwise join
// the run — which both mis-masks the title and lengthens the run toward the
// truncation ceiling in emitNameRun. Deliberately does NOT include Spanish articles
// ('el', 'la', 'los', 'las', 'un', 'una') or 'don'/'dona'/'doña'/'buenos'/'buenas':
// those words occur inside real compound surnames in this heuristic's target region
// ("De La Cruz", "La Rosa", "Los Santos"), so excluding them silently drops part or
// all of the name instead of just the title. Do not re-add them.
//
// Kept as its own named group (rather than folded straight into EXCLUDED_WORDS below)
// because orgLocationDetector's leading-token trim needs to protect these exact same
// words from being stripped off an organisation name that legitimately opens with one
// of them (e.g. "Hola Cafe Inc") — see ORG_LEADING_KEPT_WORDS there, which spreads this
// set in rather than hand-copying it, so a future addition here is automatically
// protected on the org side too.
export const HONORIFICS_AND_SALUTATIONS = new Set([
  'senor', 'senora', 'senorita', 'señor', 'señora', 'señorita',
  'sr', 'sra', 'srta',
  'estimado', 'estimada', 'atentamente', 'saludos', 'gracias', 'hola',
]);

export const EXCLUDED_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your',
  'his', 'her', 'its', 'our', 'their', 'call', 'please', 'dear',
  'hello', 'hi', 'hey', 'thank', 'thanks', 'sorry', 'note', 'see',
  'also', 'just', 'here', 'there', 'today', 'now', 'then',
  'contact', 'local', 'regard', 'sincerely', 'best', 'next',
  ...HONORIFICS_AND_SALUTATIONS,
]);

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
 * A capitalised run shorter than MIN is too ambiguous to treat as a name. A run longer
 * than MAX is NOT discarded — doing so was a silent miss: a five-token run produced
 * nothing at all, so a formal name carrying a title was simply never masked.
 */
const MIN_NAME_TOKENS = 2;
const MAX_NAME_TOKENS = 4;

/**
 * Ordinary English words that people SHOUT: log levels, header words, priority markers.
 *
 * EXCLUDED_WORDS keeps ordinary sentence words out of a capitalised run, but it is checked
 * lower-cased against words that are capitalised by SENTENCE POSITION. A shouted word is
 * capitalised for emphasis instead, and wink tags it PROPN, so `NOTICE Ferreira Nakamura`
 * and `INFO Ferreira Nakamura` came out as three-token "names" — the mask then covered the
 * shouted word too, and the ALL-CAPS confidence penalty (which cannot tell that span from
 * `IBM Watson Studio`) dropped the whole thing.
 *
 * Only the EDGES of a run are trimmed, and only these words: a brand or an initialism at the
 * edge (`IBM Watson Studio`) is left alone, and an all-capitals NAME (`JOHN SMITH`) is
 * untouched because no name is in this list. Entries must be generic English words —
 * anything that could be a surname or a given name belongs nowhere near it.
 *
 * `high` and `low` were in the list and were REMOVED in fix round 4: both are surnames, and
 * `Dear MARIA LOW,` masked nothing at all — the trim cut the run to one token and
 * `emitNameRun` then discarded it as too short. A test enumerates this set against the
 * given-name dictionary and a surname list, so a future addition fails loudly rather than
 * silently unmasking a person.
 */
export const SHOUTED_PROSE_WORDS = new Set([
  'notice', 'info', 'warn', 'warning', 'error', 'alert', 'urgent', 'important',
  'attention', 'fyi', 'asap', 'reminder', 'action', 'required', 'confidential',
  'internal', 'external', 'draft', 'final', 'update', 'subject', 'todo',
  'pending', 'approved', 'rejected', 'open', 'closed', 'critical', 'debug',
  'trace', 'fatal', 'status', 'medium',
]);

/** An ALL-CAPS word: what a shouted token looks like. */
const SHOUTED_TOKEN = /^[A-Z]{2,}$/;

/**
 * Drop shouted ordinary words from the FRONT and BACK of a capitalised run.
 *
 * A trim that would leave fewer than MIN_NAME_TOKENS tokens is not applied at all. The trim
 * exists to tidy a span, never to destroy a candidate: shrinking `MARIA LOW` to `MARIA` made
 * `emitNameRun` drop the run outright, so a word wrongly in the list above cost a whole
 * name rather than one token of it. Handing the untrimmed run back leaves the verdict to
 * scoring, which weighs the evidence instead of switching on one word.
 */
export function trimShoutedEdges(run: string[]): string[] {
  const isShout = (token: string) =>
    SHOUTED_TOKEN.test(token) && SHOUTED_PROSE_WORDS.has(token.toLowerCase());
  let from = 0;
  let to = run.length;
  while (from < to && isShout(run[from])) from++;
  while (to > from && isShout(run[to - 1])) to--;
  const trimmed = run.slice(from, to);
  return trimmed.length < MIN_NAME_TOKENS ? run : trimmed;
}

/**
 * Emit every occurrence of the name formed by `run`, truncating an over-long run to its
 * LAST MAX_NAME_TOKENS tokens.
 *
 * The tail, not the head, for two reasons. Titles and honorifics lead, so the tail is the
 * name. And placeholders are content-derived (replacementMap.ts), so a head-anchored slice
 * would mint a different placeholder for the same person depending on the words in front of
 * them — a token from one turn would then fail to resolve against another turn's map. This
 * only buys stability against LEADING context: "Ana Lucia Fernandez Ruiz Mendez" and
 * "<title> Ana Lucia Fernandez Ruiz Mendez" both truncate to "Lucia Fernandez Ruiz Mendez".
 * A trailing token that extends the run still shifts the window — the same name followed
 * by "Jr" truncates to "Fernandez Ruiz Mendez Jr" instead — so this is not span-stable
 * against trailing context, only leading context.
 *
 * One helper rather than two call sites: the mid-text and end-of-text branches were
 * near-verbatim copies and had already drifted (only one of them recorded the name in
 * `detectedNames`).
 */
function emitNameRun(
  rawRun: string[],
  text: string,
  matches: EntityMatch[],
  detectedNames: Set<string>,
): void {
  const run = trimShoutedEdges(rawRun);
  if (run.length < MIN_NAME_TOKENS) return;

  const tokens = run.length > MAX_NAME_TOKENS ? run.slice(-MAX_NAME_TOKENS) : run;
  const fullName = tokens.join(' ');
  if (detectedNames.has(fullName)) return;
  detectedNames.add(fullName);

  let searchFrom = 0;
  while (true) {
    const start = text.indexOf(fullName, searchFrom);
    if (start === -1) break;
    const alreadyDetected = matches.some(
      m => m.start === start && m.end === start + fullName.length,
    );
    if (!alreadyDetected) {
      matches.push({
        original: fullName,
        type: 'profile-person',
        start,
        end: start + fullName.length,
        priority: 2,
        // Two capitalised tokens and nothing else — the source of the incident's 234
        // PERSON masks, and also the only detector of personal names this plugin has (the
        // entity branch above never fires with the shipped model). It scores 0.5, ON the
        // default threshold, because the technical-context veto has already dropped the
        // identifiers, SQL and code it used to sweep up: what reaches scoring is a name
        // unless the surrounding text argues otherwise. See detectors/confidence.ts.
        confidence: DETECTOR_CONFIDENCE.propnRun,
      });
    }
    searchFrom = start + fullName.length;
  }
}

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
          // A model verdict, not just a capitalisation rule: worth more than the
          // supplemental run heuristic below, and less than a validated pattern.
          confidence: DETECTOR_CONFIDENCE.ner,
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
          emitNameRun(currentName, text, matches, detectedNames);
          currentName = [];
        }
      });

      // Handle a run still open at end of text.
      emitNameRun(currentName, text, matches, detectedNames);
    }
  } catch (error: any) {
    console.error(`[pseudonymization] NER detection error: ${error.message}`);
  }

  return matches;
}
