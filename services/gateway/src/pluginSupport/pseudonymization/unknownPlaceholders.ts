/**
 * Placeholders the model invents.
 *
 * A model does not reliably copy an eight-digit id out of a long context. Measured over every
 * logged pseudonymized response (2026-09-21): 56 of 7,230 carried a well-formed placeholder the
 * model had never been sent - 0.1% when the request held up to ten of them, 2.4% above 150, in every
 * model family - and that is WITH the injected instruction that forbids exactly this. Most were
 * entirely new ids rather than copy errors, so there is nothing to repair them towards.
 *
 * Unmasking is a lookup that falls back to the text as it stands, so such a placeholder used to
 * reach the client untouched: no log, no event. There it is worse than noise. It names nobody, it
 * can never be resolved, and once it is in the client's history it comes back with every later
 * request and the model treats it as genuine.
 *
 * So an unknown placeholder is contained here instead: replaced by a plain statement of what kind of
 * value was withheld, and reported. Two things are deliberately NOT unknown. A placeholder in the
 * request's own map is resolved as before. A placeholder the CLIENT sent in this request is left
 * alone: a developer discussing this plugin, a test file the model has just read, or residue from an
 * earlier turn are all "verbatim in this conversation", which the injected instruction permits, and
 * rewriting them would corrupt source code the model is editing.
 */

/** Every well-formed placeholder: `MASKED_<TYPE>_<id>`, and the URL-shaped `masked-url-<id>.invalid`. */
const PLACEHOLDER_SHAPE = /(?:https?:\/\/)?masked-url-[0-9a-f]+\.invalid|MASKED_[A-Z]+(?:_[A-Z]+)*_[0-9a-f]+/g;

/**
 * A tail that may still grow into a placeholder: `MASKED_PERSON_2393` whose remaining digits arrive
 * in the next stream delta, or the bare `masked-url-12` of a host. Anchored at the end of the text.
 *
 * It follows the placeholder's own grammar - type words, then ONE run of id digits - rather than
 * "anything after MASKED_": in `MASKED_EMAIL_12345678MASK` the id is over, the placeholder is
 * complete, and the trailing `MASK` is the possible start of the NEXT one, which the buffer's
 * prefix rule holds on its own. Reading the whole run as one open placeholder held back a
 * placeholder that was ready to be resolved.
 */
const OPEN_PLACEHOLDER_TAIL = /(?:(?:https?:\/\/)?masked-url-[0-9a-f]*(?:\.[a-z]*)?|MASKED_(?:[A-Z]+_)*(?:[A-Z]*|[0-9a-f]*))$/;

/** No real placeholder is longer; bounds how much a stream may hold back for one. */
export const MAX_OPEN_TAIL = 96;

export function placeholdersIn(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.match(PLACEHOLDER_SHAPE) ?? [];
}

const WITHHELD: Array<[RegExp, string]> = [
  [/^MASKED_PERSON_/, 'name'],
  [/^MASKED_EMAIL(?:_ADDRESS)?_/, 'email address'],
  [/^MASKED_PHONE(?:_NUMBER)?_/, 'phone number'],
  [/^MASKED_(?:ORG|ORGANIZATION)_/, 'organisation'],
  [/^MASKED_(?:LOCATION|ADDRESS)_/, 'location'],
  [/masked-url-/, 'link']
];

/** What the reader sees in place of a placeholder that names nothing. Never contains the token. */
export function withheldText(placeholder: string): string {
  const kind = WITHHELD.find(([shape]) => shape.test(placeholder))?.[1] ?? 'value';
  return `[${kind} withheld]`;
}

/**
 * Replaces every placeholder that is neither in the request's map (`known`) nor something the
 * client itself sent (`inbound`). `unknown` lists each replaced placeholder once, in order.
 */
export function containUnknownPlaceholders(
  text: string, known: ReadonlySet<string> | ReadonlyMap<string, unknown>, inbound: ReadonlySet<string>,
  withhold = true
): { text: string; unknown: string[] } {
  if (typeof text !== 'string' || text.length === 0) return { text, unknown: [] };
  const unknown: string[] = [];
  const out = text.replace(PLACEHOLDER_SHAPE, (match) => {
    if (known.has(match) || inbound.has(match)) return match;
    if (!unknown.includes(match)) unknown.push(match);
    return withhold ? withheldText(match) : match;
  });
  return { text: out, unknown };
}

/**
 * `withhold` (default) replaces and reports; `report` only reports, for a deployment whose own
 * developers write new placeholders into test fixtures through the gateway; `off` restores the old
 * pass-through. An unreadable value means `withhold`: a typo must never turn the control off.
 */
export type UnknownPlaceholderMode = 'withhold' | 'report' | 'off';

export function resolveUnknownPlaceholderMode(configured: unknown): UnknownPlaceholderMode {
  return configured === 'report' || configured === 'off' ? configured : 'withhold';
}

/**
 * Where a still-open placeholder begins at the end of `text`, or -1. A stream must hold from there:
 * replacing `MASKED_PERSON_2393` before `5247` arrives would leave the rest of the id behind.
 */
export function openPlaceholderStart(text: string): number {
  const window = text.slice(-MAX_OPEN_TAIL);
  const m = OPEN_PLACEHOLDER_TAIL.exec(window);
  if (!m || m[0].length === 0) return -1;
  return text.length - window.length + m.index;
}

/** How a caller asks for containment; without it the unmask functions behave as they always have. */
export interface ContainmentOptions {
  /** Placeholders present in the client's own request: never treated as invented. */
  inbound: ReadonlySet<string>;
  /** Called with the placeholders that were found, once per unmask call that found any. */
  onUnknown: (placeholders: string[]) => void;
  /** False in `report` mode: the placeholders are reported and the text is left as it is. */
  withhold?: boolean;
}
