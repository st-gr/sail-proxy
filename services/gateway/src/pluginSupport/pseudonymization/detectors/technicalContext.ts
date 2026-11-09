/**
 * Technical-context classifier.
 *
 * A veto stage, not a detector: it answers "is this candidate span part of the TEXT'S
 * MACHINERY rather than a value about a person?". The incident behind it (spec
 * 2026-08-25-pseudonymization-precision) was a request built from BW/ABAP object names
 * and SQL in which 110 distinct values were masked — object names, request ids and SQL
 * column names, almost none of them PII. Saturation on that scale pushed the model into
 * inventing its own MASKED_ tokens, which the client then executed.
 *
 * Two rules keep this from becoming a second false-positive machine of its own:
 *
 *  - It only ever REMOVES masking, and never for the types in EXEMPT_FROM_SUPPRESSION —
 *    operator intent (custom rules) and checksum/format-validated PII stay unconditional.
 *    A mail address is a mail address inside a code fence too.
 *  - It is pure and text-only: no wink-nlp, no config, no I/O. `detectEntities` and the
 *    chunk-masking path can both call it, and it is trivially testable.
 *
 * Cost: the per-text scans (fences, URLs, SQL statements, quoted literals) are built once
 * and cached for the most recent text, so classifying N spans of one request stays one
 * pass over the text plus O(N) range lookups — not N passes.
 */

import { EntityMatch } from '../types';
import { HONORIFICS_AND_SALUTATIONS } from './nerDetector';

export type TechnicalReason =
  | 'identifier'
  | 'camelCase'
  | 'code-fence'
  | 'sql'
  | 'json-key'
  | 'url'
  | 'path'
  | 'glued';

export interface TechnicalSpanVerdict {
  technical: boolean;
  reason?: TechnicalReason;
}

/**
 * Types the classifier must never veto.
 *
 *  - `custom`: a Tier-0 operator rule is explicit intent. If an operator says a permit
 *    number is PII, a permit number that looks like an identifier is still PII.
 *  - email / ip / url / iban / credit card / ssn / itin: format- or checksum-validated.
 *    Their patterns are selective enough that "it appears in code" is not evidence
 *    against them — a credential file is exactly where they show up.
 *  - org / location: the same operator-intent argument as `custom`, one tier down. Neither
 *    detector guesses: an organisation needs a configured legal-form suffix, a location
 *    needs a literal the operator put in the gazetteer. Both are opt-in and ship empty or
 *    off. A configured place name written in capitals ("SPRINGFIELD") is a location, not
 *    an object name, and the ALL-CAPS shape rule below would otherwise silently drop it.
 *  - username-password: a secret is OPAQUE BY CONSTRUCTION. `SECRETVALUE`,
 *    `MY_SECRET_KEY`, a 20-character access key and `correctHorseBatteryStaple` are exactly
 *    the shapes the identifier and camelCase rules match, so running them over a
 *    credential unmasks every well-formed secret — the most dangerous possible failure of
 *    this classifier. The rule is already trigger-anchored in its own pattern (`password:`,
 *    `Authorization:`, `Bearer`), which is the evidence the shape can never supply.
 */
export const EXEMPT_FROM_SUPPRESSION: ReadonlySet<string> = new Set([
  'custom',
  'profile-email',
  'profile-ip-address',
  'profile-url',
  'profile-iban',
  'profile-credit-card-number',
  'profile-ssn',
  'profile-itin',
  'profile-org',
  'profile-location',
  'profile-username-password',
]);

interface Range { start: number; end: number }

/** Fenced code blocks: ``` … ``` (an unterminated fence runs to the end of the text). */
const FENCE = /```/g;
/** Absolute URLs, plus the scheme-less `www.` form the URL detector also recognises. */
const URL_TOKEN = /(?:(?:https?|wss?|ftps?):\/\/|www\.)[^\s<>"'`{}|\\^\[\]]+/g;
/**
 * A SQL statement START. Uppercase only, deliberately: lower-case "select" and "update"
 * are ordinary English verbs, and anchoring on them would suppress prose. The bare
 * SELECT/UPDATE forms additionally require their partner keyword inside the statement
 * (FROM / SET), so "SELECT the option you want" is not a statement.
 */
const SQL_START = /\b(?:SELECT|UPDATE|INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|CREATE\s+(?:TABLE|VIEW|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|VIEW|INDEX)|TRUNCATE\s+TABLE)\b/g;
/** Double-quoted literals, and single-quoted ones that are not an English apostrophe. */
const DOUBLE_QUOTED = /"([^"\n]*)"/g;
const SINGLE_QUOTED = /(?<![A-Za-z0-9])'([^'\n]*)'(?![A-Za-z])/g;

/**
 * `ZPC_FICA_TRAN_DAILY`, `Some_Value2`, `CHAIN_ID`: a word joined by underscores. Case is
 * not constrained — a mixed-case underscore name is no more a person's name than an
 * upper-case one.
 */
const UNDERSCORE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;
/**
 * `RSPROCESS`, `INFOAREA`, `DATAPAKID`: an upper-case WORD of at least four letters. Four,
 * not two, so initials and short acronyms in prose ("JS", "US") are left to the detectors.
 * This is the rule with the widest reach — a name SHOUTED in a header ("JOHN SMITH") is
 * vetoed by it; see the false-negative note in the task report.
 */
const ALL_CAPS_WORD = /^[A-Z]{4,}$/;
/**
 * `DGCSH86VQSKEXIK70LO0HJI3A`: a long opaque upper-case run mixing letters and digits.
 *
 * The length floor is what separates a request id from the STRUCTURED IDs the regex tier
 * detects. A DEA number (`AB1234563`), a UK NI number (`AB123456C`), a passport
 * (`X1234567`) and a driving licence are all short upper-case letter+digit runs; a
 * four-character floor vetoed every one of them. Twenty, specifically, clears the longest
 * of them — the 18-character Mexican CURP — with room to spare.
 */
const OPAQUE_UPPER_ID = /^[A-Z][A-Z0-9]{19,}$/;
/**
 * `getUserName`: lower-case first token, at least one inner capital. Deliberately NOT
 * PascalCase — `McDonald`, `DeShawn` and `O'Brien` are names, not code.
 */
const CAMEL_CASE_TOKEN = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;

/** Characters that end a bare token. Quotes included: a quoted value is its own token. */
const TOKEN_BOUNDARY = /[\s"'`,;()\[\]{}<>]/;

interface ContextIndex {
  fences: Range[];
  urls: Range[];
  sql: Range[];
  quoted: Range[];
}

let cachedText: string | null = null;
let cachedIndex: ContextIndex | null = null;

function collect(pattern: RegExp, text: string, group = 0): Range[] {
  const ranges: Range[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const value = m[group];
    if (value === undefined) continue;
    const offset = group === 0 ? m.index : m.index + m[0].indexOf(value);
    ranges.push({ start: offset, end: offset + value.length });
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return ranges;
}

function fenceRanges(text: string): Range[] {
  const marks = collect(FENCE, text);
  const ranges: Range[] = [];
  for (let i = 0; i < marks.length; i += 2) {
    const close = marks[i + 1];
    ranges.push({ start: marks[i].start, end: close ? close.end : text.length });
  }
  return ranges;
}

/**
 * A SQL statement runs from its opening keyword to the first `;`, or — when the statement
 * carries no terminator — to the end of its line. Anything looser turns one stray SELECT
 * into a licence to suppress the rest of the document.
 */
function sqlRanges(text: string): Range[] {
  const ranges: Range[] = [];
  SQL_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SQL_START.exec(text)) !== null) {
    const start = m.index;
    const lineEnd = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
    const semicolon = text.indexOf(';', start);
    const end = semicolon !== -1 && semicolon < lineEnd ? semicolon + 1 : lineEnd;
    const statement = text.slice(start, end);

    // The bare verbs need their partner keyword before this counts as SQL.
    if (/^SELECT\b/.test(statement) && !/\bFROM\b/.test(statement)) continue;
    if (/^UPDATE\b/.test(statement) && !/\bSET\b/.test(statement)) continue;

    ranges.push({ start, end });
  }
  return ranges;
}

function indexFor(text: string): ContextIndex {
  if (cachedText === text && cachedIndex) return cachedIndex;
  cachedIndex = {
    fences: fenceRanges(text),
    urls: collect(URL_TOKEN, text),
    sql: sqlRanges(text),
    quoted: [...collect(DOUBLE_QUOTED, text, 1), ...collect(SINGLE_QUOTED, text, 1)],
  };
  cachedText = text;
  return cachedIndex;
}

function within(ranges: Range[], start: number, end: number): boolean {
  return ranges.some(r => start >= r.start && end <= r.end);
}

/** The whitespace/punctuation-delimited token the span sits in. */
function enclosingToken(text: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && !TOKEN_BOUNDARY.test(text[from - 1])) from--;
  let to = end;
  while (to < text.length && !TOKEN_BOUNDARY.test(text[to])) to++;
  return text.slice(from, to);
}

/**
 * A path, not prose. Requires a leading `/`, `./`, `~/` or a drive letter, or at least two
 * separators — so "and/or" and "he/she" are not paths, while `/var/log/Alice` and
 * `src/plugins/Alice.ts` are.
 */
function isPathToken(token: string): boolean {
  if (/^[A-Za-z]:\\/.test(token) || token.includes('\\\\')) return true;
  if (!token.includes('/')) return false;
  if (/^[~.]{0,2}\//.test(token)) return true;
  return (token.match(/\//g) || []).length >= 2;
}

/** `"customer":` — the span is a JSON/YAML key, so its text names a field, not a person. */
function isJsonKey(text: string, start: number, end: number): boolean {
  const opensQuoted = start > 0 && (text[start - 1] === '"' || text[start - 1] === "'");
  if (!opensQuoted) return false;
  return /^["']\s*:/.test(text.slice(end));
}

/**
 * Glued to code punctuation: `Smith(`, `Smith.Jones`, `NAME=`, `ns::Smith`, and — the
 * common one after the PROPN-run heuristic cuts a run out of the middle of an object name
 * — `INFOAREA ZFI` immediately followed by `_GLOBAL`.
 *
 * Two asymmetries are deliberate. A trailing `.` only counts when a word character follows
 * it, or the most ordinary position for a name in prose — the end of a sentence — would be
 * exempted. And only a `=` AFTER the span counts (the span is a key): a `=` before it means
 * the span is the assigned VALUE, which is precisely what `password=<secret>` produces.
 */
function isGlued(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';

  if (after === '(' || after === '=' || after === '_') return true;
  if (before === '_') return true;
  if (text.slice(start - 2, start) === '::' || text.slice(end, end + 2) === '::') return true;
  if (after === '.' && /[A-Za-z0-9_]/.test(text[end + 1] ?? '')) return true;
  if (before === '.' && /[A-Za-z0-9_]/.test(text[start - 2] ?? '')) return true;
  return false;
}

/**
 * A short upper-case token — `ZFI`, `ZCO`, `BW`, and the `J.`/`R.` of an initialled name.
 * Evidence for NOTHING: three characters cannot tell an SAP namespace prefix from a
 * person's initial, and guessing either way is wrong somewhere obvious.
 */
const SHORT_UPPER_TOKEN = /^[A-Z][A-Z0-9]{0,2}$/;

/** Shape verdict for ONE whitespace-delimited token: technical, neutral, or evidence-free. */
type TokenVerdict = TechnicalReason | 'neutral' | null;

function tokenShape(token: string): TokenVerdict {
  const bare = token.replace(/^[^A-Za-z0-9_]+/, '').replace(/[^A-Za-z0-9_]+$/, '');
  if (bare.length === 0) return null;
  if (UNDERSCORE_IDENTIFIER.test(bare)) return 'identifier';
  if (ALL_CAPS_WORD.test(bare) || OPAQUE_UPPER_ID.test(bare)) return 'identifier';
  if (CAMEL_CASE_TOKEN.test(bare)) return 'camelCase';
  if (SHORT_UPPER_TOKEN.test(bare)) return 'neutral';
  return null;
}

/**
 * Is the span at [start, end) part of the text's machinery rather than a value?
 *
 * Order matters: surrounding context is checked before span shape, so a SQL column name
 * reports `sql` rather than `identifier` — the reason is what an operator reads in a
 * precision report, and "it was in a SQL statement" is the more useful fact.
 */
export function isTechnicalSpan(text: string, start: number, end: number): TechnicalSpanVerdict {
  const span = text.slice(start, end);
  if (span.trim().length === 0) return { technical: false };

  const index = indexFor(text);

  if (within(index.fences, start, end)) return { technical: true, reason: 'code-fence' };

  // The URL and path rules protect a name that appears as a SEGMENT of an address
  // ("/var/log/Alice"). A span that IS the whole token is the address itself, and what to
  // do with it belongs to the detector that claimed it — a Windows path is a perfectly
  // ordinary password, and `profile-url` masks URLs on purpose.
  const token = enclosingToken(text, start, end);
  if (span !== token) {
    if (within(index.urls, start, end)) return { technical: true, reason: 'url' };
    if (isPathToken(token)) return { technical: true, reason: 'path' };
  }

  if (isJsonKey(text, start, end)) return { technical: true, reason: 'json-key' };

  // A quoted literal is DATA, not code — `WHERE OWNER = 'Smith'` is exactly where a real
  // name hides in a SQL statement. Only the structural rules are skipped for it; a quoted
  // object name is still recognised by its shape below.
  if (!within(index.quoted, start, end)) {
    if (within(index.sql, start, end)) return { technical: true, reason: 'sql' };
    if (isGlued(text, start, end)) return { technical: true, reason: 'glued' };
  }

  // Shape: no token of the span may be evidence AGAINST, and at least one must be evidence
  // FOR. The PROPN-run heuristic welds neighbouring identifiers into one pseudo-name
  // ("DAILY RSPROCESS ZCUBE"), which this catches; a run mixing a real name with an
  // identifier is left to the detectors.
  //
  // Neutral tokens are why this is not a plain `every(technical)`: a three-letter SAP
  // namespace prefix in the middle of a run ("RSPROCESS INFOAREA ZFI DGCSH8…") used to
  // clear the whole run and hand it back to the person detector. They cannot veto on their
  // own either — "Dr. J. R. Smith" is initials plus a name, and must still mask.
  const shapes = span.trim().split(/\s+/).map(tokenShape);
  const technical = shapes.filter((s): s is TechnicalReason => s !== null && s !== 'neutral');
  if (technical.length > 0 && shapes.every(s => s !== null)) {
    return { technical: true, reason: technical.includes('identifier') ? 'identifier' : 'camelCase' };
  }

  return { technical: false };
}

/**
 * Is the span inside a code fence or a SQL statement?
 *
 * The CONTEXT half of `isTechnicalSpan`, published on its own so `confidence.ts` can apply
 * the spec's -0.3 code/SQL adjustment to the spans the veto let through — the exempt types,
 * and a person candidate lifted out of the ALL-CAPS veto.
 *
 * A quoted literal is excluded, exactly as it is in the veto: `WHERE OWNER = 'Smith'` is
 * DATA inside a statement, and that is the form a real name takes in a SQL dump. Penalising
 * it would cost the one SQL case worth masking.
 */
export function inCodeContext(text: string, start: number, end: number): boolean {
  const index = indexFor(text);
  if (within(index.quoted, start, end)) return false;
  return within(index.fences, start, end) || within(index.sql, start, end);
}

const triggerCache = new Map<readonly string[], RegExp>();

function triggerRegex(words: readonly string[]): RegExp {
  let regex = triggerCache.get(words);
  if (!regex) {
    const alternation = words
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
      .join('|');
    regex = new RegExp(`\\b(?:${alternation})\\b`, 'i');
    triggerCache.set(words, regex);
  }
  return regex;
}

/**
 * Does one of `words` appear in the `window` characters BEFORE `start`?
 *
 * The StarCoder rule, and the same bargain the DEA and routing-number detectors already
 * make in regexDetectors.ts: a pattern that is weak on its own (a run of alphanumerics)
 * only masks when the text says what the value is. Backwards only — a label follows its
 * value far too rarely to be worth the false positives.
 *
 * Pass the SAME array instance each time (a module-level constant): the compiled regex is
 * cached per array identity.
 */
export function hasTriggerWord(
  text: string,
  start: number,
  words: readonly string[],
  window = 100,
): boolean {
  if (words.length === 0) return true;
  const from = Math.max(0, start - window);
  return triggerRegex(words).test(text.slice(from, start));
}

/**
 * Honorifics and salutations that mark the neighbourhood as being about a person.
 *
 * Exported for `confidence.ts`, which reads the SAME list in a narrower window (40
 * characters, the spec's honorific adjustment) — one list, two windows, rather than two
 * lists that drift.
 */
export const PERSON_CONTEXT_WORDS: readonly string[] = [
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'madam', 'lady',
  'herr', 'frau', 'monsieur', 'madame', 'dear', 'contact', 'attn', 'regards',
  ...HONORIFICS_AND_SALUTATIONS,
];

const PERSON_CONTEXT_WINDOW = 60;

/**
 * Is this span in the neighbourhood of a PERSON?
 *
 * Gate for the dictionary categories whose terms are ordinary English words —
 * "Independent", "Moderate", "Liberal", "Progressive" are political affiliations in a
 * personnel note and noise everywhere else. Evidence accepted: an honorific or salutation
 * within 60 characters before, or an already-detected person within 60 characters either
 * side (the dictionary tier runs last, so those matches exist by then).
 */
export function hasPersonContext(
  text: string,
  start: number,
  end: number,
  matches: EntityMatch[],
): boolean {
  if (hasTriggerWord(text, start, PERSON_CONTEXT_WORDS, PERSON_CONTEXT_WINDOW)) return true;
  return matches.some(m =>
    m.type === 'profile-person'
    && m.start < end + PERSON_CONTEXT_WINDOW
    && m.end > start - PERSON_CONTEXT_WINDOW,
  );
}
