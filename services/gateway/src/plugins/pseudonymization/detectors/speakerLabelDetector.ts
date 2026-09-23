/**
 * Transcript speaker labels: `Surname, Given:` at the head of a line.
 *
 * Why this detector exists. The only detector of personal names is a run of two or more
 * capitalised tokens (nerDetector.ts). A meeting transcript writes its speakers as
 * `Okafor, Lena:` - the comma splits the run into two single tokens, and a single token is never
 * a run. In the request behind incident k80nbbxr6 that form occurred 83 times and was masked
 * zero times; two of the three people in it never appeared as `Given Surname` at all, so every
 * mention of them went to the provider in clear.
 *
 * The evidence here is STRUCTURE, not vocabulary: a line that opens with `Surname, Given:`,
 * optionally behind a cue number, in a text where that happens again. One such line proves
 * nothing - `Paris, France: the capital` has the same shape, and so has a list of
 * `City, Country: value` rows - so a label only counts when the text shows it is a transcript:
 * the same label appears on a second line (speakers talk more than once), or the line carries a
 * cue (a leading cue number, or a `-->` timestamp line directly above it).
 *
 * The two parts are emitted as SEPARATE matches. `Okafor, Lena:` becomes
 * `<surname>, <given>:` with the punctuation left in place, which keeps the round trip exact and,
 * more importantly, gives the given name the same placeholder it gets where it stands alone
 * ("I know Lena, you were going to say"). One span for the whole label would give the model two
 * unrelated placeholders for one person, and every extra distinct placeholder raises the rate at
 * which a model invents one.
 *
 * `propagate` marks these parts as vouched for by structure, which is what lets the request-wide
 * pass (replacer.ts) mask them where they stand alone. A capitalised run is NOT marked: it scores
 * on the threshold and includes `Visual Studio` and `New York`, whose parts must never travel.
 */
import { EntityMatch, EntityConfig } from '../types';
import { DETECTOR_CONFIDENCE } from './confidenceScores';
import { EXCLUDED_WORDS, SHOUTED_PROSE_WORDS } from './nerDetector';

/** Lower-case particles a surname may open with: `van Doorn`, `de la Cruz`, `bin Salem`. */
const PARTICLE = '(?:van|von|de|der|den|del|della|di|da|la|le|du|bin|al|el|ter|ten)';
const WORD = "\\p{Lu}[\\p{L}'’-]+";

/**
 * Line start, an optional cue number, `Surname, Given:`. The surname is one to three words,
 * optionally behind particles; the given name one or two. The colon must end the label.
 */
const LABEL_LINE = new RegExp(
  `^([ \\t]*(?:\\d+[ \\t]+)?)((?:${PARTICLE} ){0,2}${WORD}(?: ${WORD}){0,2}), (${WORD}(?: ${WORD})?):(?=\\s|$)`,
  'gmu',
);

/** A WebVTT/SRT timing line: what stands directly above a cue's text. */
const TIMESTAMP_LINE = /-->/;

/**
 * Words that head a line before a colon without naming anyone. Beside the two shared sets:
 * the everyday headings of notes and documents.
 */
const LABEL_WORDS = new Set([
  'summary', 'details', 'detail', 'overview', 'agenda', 'minutes', 'notes', 'topic', 'topics',
  'question', 'answer', 'comment', 'comments', 'result', 'results', 'input', 'output', 'example',
  'step', 'section', 'chapter', 'part', 'table', 'figure', 'source', 'date', 'time', 'location',
  'title', 'name', 'address', 'city', 'state', 'country', 'total', 'subtotal', 'yes', 'no',
]);

const isOrdinaryWord = (word: string): boolean => {
  const w = word.toLowerCase();
  return EXCLUDED_WORDS.has(w) || SHOUTED_PROSE_WORDS.has(w) || LABEL_WORDS.has(w);
};

interface Label { surname: string; given: string; surnameStart: number; givenStart: number; cued: boolean; }

function labelsIn(text: string): Label[] {
  const labels: Label[] = [];
  LABEL_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_LINE.exec(text)) !== null) {
    const [, lead, surname, given] = m;
    if ([...surname.split(' '), ...given.split(' ')].some(isOrdinaryWord)) continue;
    const surnameStart = m.index + lead.length;
    const givenStart = surnameStart + surname.length + 2;
    // A cue: a number ahead of the label, or a timing line directly above this one.
    const lineStart = m.index;
    const previousLine = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, Math.max(lineStart - 1, 0));
    const cued = /\d/.test(lead) || TIMESTAMP_LINE.test(previousLine);
    labels.push({ surname, given, surnameStart, givenStart, cued });
  }
  return labels;
}

export function detectSpeakerLabels(text: string, enabledEntities: EntityConfig[]): EntityMatch[] {
  const enabled = enabledEntities.some((e) => e.type === 'profile-person' && e.enabled !== false);
  if (!enabled || !text.includes(':')) return [];

  const labels = labelsIn(text);
  if (labels.length < 2) return [];

  const occurrences = new Map<string, number>();
  for (const l of labels) {
    const key = `${l.surname}, ${l.given}`;
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }

  const matches: EntityMatch[] = [];
  for (const l of labels) {
    const repeats = (occurrences.get(`${l.surname}, ${l.given}`) ?? 0) >= 2;
    if (!repeats && !l.cued) continue;
    for (const [original, start] of [[l.surname, l.surnameStart], [l.given, l.givenStart]] as Array<[string, number]>) {
      matches.push({
        original,
        type: 'profile-person',
        start,
        end: start + original.length,
        // The structure is the evidence, so it outranks the capitalised-run heuristic (2).
        priority: 1,
        confidence: DETECTOR_CONFIDENCE.speakerLabel,
        propagate: true,
      });
    }
  }
  return matches;
}

/**
 * Given names and surnames that are, far more often, ordinary English words. In a LABEL they are
 * still masked - the structure is the evidence there - but they never travel: a transcript with a
 * speaker called Will must not turn "Will you send it?" into a placeholder, nor one called May
 * every "in May". Capitalisation cannot tell the two apart at the head of a sentence.
 *
 * The same reasoning, and largely the same words, as the entries deliberately left OUT of the
 * given-name dictionary (dictionaries/firstNames.ts).
 */
export const EVERYDAY_WORD_NAMES = new Set([
  'will', 'may', 'june', 'april', 'august', 'art', 'hope', 'mark', 'grace', 'rose', 'faith', 'joy',
  'bill', 'rob', 'pat', 'sue', 'drew', 'chase', 'hunter', 'summer', 'autumn', 'dawn', 'frank',
  'jack', 'rich', 'gene', 'ray', 'dean', 'don', 'lee', 'long', 'young', 'white', 'black', 'brown',
  'green', 'gray', 'grey', 'king', 'price', 'cook', 'baker', 'hill', 'wood', 'woods', 'field',
  'fields', 'stone', 'banks', 'rivers', 'page', 'power', 'powers', 'best', 'love', 'day', 'bell',
  'ford', 'chance', 'miles', 'major', 'sky', 'lane', 'penny', 'carol', 'holly', 'ivy', 'iris',
  'olive', 'amber', 'ruby', 'jade', 'pearl', 'crystal', 'angel', 'christian', 'destiny', 'harmony',
  'trinity', 'victor', 'earnest', 'curt', 'nick', 'bob', 'herb', 'cliff', 'dale', 'glen', 'heath',
]);

/** The shortest name that may travel: two letters is an initialism or a word, not a name. */
const MIN_PART_LENGTH = 3;

/**
 * The names from `matches` that may be masked wherever they stand alone: those a speaker label
 * vouched for, minus the ones that are everyday words. A multi-word part ("Van Doorn") travels
 * whole, never word by word.
 */
export function propagatableNames(matches: EntityMatch[]): Set<string> {
  const names = new Set<string>();
  for (const m of matches) {
    if (!m.propagate || m.type !== 'profile-person') continue;
    if (m.original.length < MIN_PART_LENGTH) continue;
    if (EVERYDAY_WORD_NAMES.has(m.original.toLowerCase())) continue;
    names.add(m.original);
  }
  return names;
}
