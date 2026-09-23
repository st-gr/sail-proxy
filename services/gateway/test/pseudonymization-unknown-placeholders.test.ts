/**
 * Placeholders the model INVENTS (src/plugins/pseudonymization/unknownPlaceholders.ts).
 *
 * Incident, 2026-09-21, request k80nbbxr6 (claude-opus-4-8, streamed): the model was sent 52
 * distinct person placeholders and answered with a well-formed 53rd that had never existed. The
 * id was no copy error - its nearest real neighbour differed in five of eight digits. The request
 * carried the plugin's own instruction ("NEVER invent, guess, or construct a new MASKED_* token"),
 * and the model wrote one anyway: a prompt is advice, not a control.
 *
 * Nothing caught it. Unmasking is a lookup in the replacement map that falls back to the text as it
 * stands, so an unknown placeholder passed through with no log, no event and no repair, reached the
 * client, was written into an artifact, and came back in the next 27 requests. Measured over every
 * logged pseudonymized response: 56 of 7,230 carry such a placeholder, rising from 0.1% to 2.4% as
 * the request holds more of them, in every model family.
 *
 * Three earlier fixes (c590f9d5, 62873de7, 74f24cb5) attributed "a token leaked" to a placeholder
 * split across stream frames. This incident shows that reassembly working - the placeholder next to
 * the invented one arrived split across two deltas and was unmasked - so the split was never the
 * cause here, and no reassembly fix could have reached it.
 */
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';
import { StreamUnmaskBuffer } from '../src/plugins/pseudonymization/streamBuffer';
import { unmaskText } from '../src/plugins/pseudonymization/unmasker';
import { containUnknownPlaceholders, withheldText, placeholdersIn, resolveUnknownPlaceholderMode } from '../src/plugins/pseudonymization/unknownPlaceholders';

/** A map holding exactly the placeholders the model WAS sent. */
function mapWith(entries: Record<string, string>): ReplacementMap {
  const map = new ReplacementMap('pseudonymization');
  for (const [placeholder, original] of Object.entries(entries)) {
    map.forward.set(original, placeholder);
    map.reverse.set(placeholder, original);
  }
  return map;
}

// Synthetic: the real placeholder of the incident is the hash of a real person's name, and an
// eight-digit truncated hash is trivially reversed against a list of names.
const KNOWN = 'MASKED_PERSON_40817263';
const INVENTED = 'MASKED_PERSON_23935247';

describe('placeholdersIn', () => {
  it('finds every well-formed placeholder, whatever its type', () => {
    expect(placeholdersIn(`a ${KNOWN} b MASKED_EMAIL_ADDRESS_11223344 c https://masked-url-12345678.invalid/x`))
      .toEqual([KNOWN, 'MASKED_EMAIL_ADDRESS_11223344', 'https://masked-url-12345678.invalid']);
    expect(placeholdersIn('MASKED_ is not one, nor is MASKED_PERSON_, nor plain text')).toEqual([]);
  });
});

describe('containUnknownPlaceholders', () => {
  const known = new Set([KNOWN]);

  it('replaces a placeholder that is in no map and reports it', () => {
    const { text, unknown } = containUnknownPlaceholders(`I have ${KNOWN}, ${INVENTED}.`, known, new Set());
    expect(text).toBe(`I have ${KNOWN}, ${withheldText(INVENTED)}.`);
    expect(unknown).toEqual([INVENTED]);
  });

  it('says what kind of value was withheld, never the placeholder itself', () => {
    expect(withheldText('MASKED_PERSON_1')).toBe('[name withheld]');
    expect(withheldText('MASKED_EMAIL_ADDRESS_1')).toBe('[email address withheld]');
    expect(withheldText('https://masked-url-12345678.invalid')).toBe('[link withheld]');
    expect(withheldText('MASKED_SOMETHING_NEW_1')).toBe('[value withheld]');
    for (const p of ['MASKED_PERSON_1', 'MASKED_EMAIL_ADDRESS_1', 'https://masked-url-1.invalid']) {
      expect(withheldText(p)).not.toContain('MASKED');
    }
  });

  /**
   * A placeholder the CLIENT sent is not an invention: a developer discussing this plugin, a test
   * file the model has just read, or residue from an earlier turn are all "verbatim in this
   * conversation", which is exactly what the injected instruction permits. Rewriting those would
   * corrupt source code the model is editing.
   */
  it('leaves alone a placeholder the client itself sent in this request', () => {
    const inbound = new Set(['MASKED_PERSON_11']);
    const { text, unknown } = containUnknownPlaceholders(`expect('MASKED_PERSON_11') and ${INVENTED}`, known, inbound);
    expect(text).toBe(`expect('MASKED_PERSON_11') and ${withheldText(INVENTED)}`);
    expect(unknown).toEqual([INVENTED]);
  });

  it('is the identity when every placeholder is known, and on text without any', () => {
    expect(containUnknownPlaceholders(`only ${KNOWN}`, known, new Set())).toEqual({ text: `only ${KNOWN}`, unknown: [] });
    expect(containUnknownPlaceholders('plain prose', known, new Set())).toEqual({ text: 'plain prose', unknown: [] });
  });
});

describe('the operator switch', () => {
  it('withholds by default and accepts only its three values', () => {
    expect(resolveUnknownPlaceholderMode(undefined)).toBe('withhold');
    expect(resolveUnknownPlaceholderMode('withhold')).toBe('withhold');
    expect(resolveUnknownPlaceholderMode('report')).toBe('report');
    expect(resolveUnknownPlaceholderMode('off')).toBe('off');
    // an unreadable value must never quietly turn the control off
    for (const bad of ['Off', 'none', '', 42, null, {}]) expect(resolveUnknownPlaceholderMode(bad)).toBe('withhold');
  });

  it('reports without touching the text in report mode', () => {
    const { text, unknown } = containUnknownPlaceholders(`a ${INVENTED} b`, new Set([KNOWN]), new Set(), false);
    expect(text).toBe(`a ${INVENTED} b`);
    expect(unknown).toEqual([INVENTED]);
  });
});

describe('unmaskText with containment (non-streaming)', () => {
  it('unmasks what it knows and withholds what it was never given', () => {
    const map = mapWith({ [KNOWN]: 'Alex Example' });
    const unknown: string[] = [];
    const out = unmaskText(`presenters: ${KNOWN}, ${INVENTED}.`, map, { inbound: new Set(), onUnknown: (u) => unknown.push(...u) });
    expect(out).toBe('presenters: Alex Example, [name withheld].');
    expect(unknown).toEqual([INVENTED]);
  });

  it('keeps its old behaviour for callers that do not ask for containment', () => {
    const map = mapWith({ [KNOWN]: 'Alex Example' });
    expect(unmaskText(`${KNOWN}, ${INVENTED}`, map)).toBe(`Alex Example, ${INVENTED}`);
  });
});

describe('StreamUnmaskBuffer with containment', () => {
  /**
   * The exact delta boundaries SAP sent for k80nbbxr6. The known placeholder is split across two
   * deltas and the invented one across three, with a lone "M" opening it at the end of a delta.
   */
  const DELTAS = [' I have Pat Example', ', MASKED_PER', 'SON_40817263, M', 'ASKED_PERSON', '_23935247. Corre', 'ct any titles.'];

  it('reproduces the incident: the invented placeholder never reaches the client', () => {
    const map = mapWith({ [KNOWN]: 'Alex Example' });
    const unknown: string[] = [];
    const buffer = new StreamUnmaskBuffer(map, { inbound: new Set(), onUnknown: (u) => unknown.push(...u) });
    const out = DELTAS.map((d) => buffer.append(d)).join('') + buffer.flush();
    expect(out).toBe(' I have Pat Example, Alex Example, [name withheld]. Correct any titles.');
    expect(out).not.toContain('MASKED');
    expect(unknown).toEqual([INVENTED]);
  });

  /**
   * An unknown placeholder must be held until its id is complete, exactly as a known one is: the
   * digits can arrive in the NEXT delta, and replacing `MASKED_PERSON_2393` early would leave
   * `5247` behind as stray text.
   */
  it('holds an unknown placeholder whose digits are still arriving', () => {
    const map = mapWith({ [KNOWN]: 'Alex Example' });
    const buffer = new StreamUnmaskBuffer(map, { inbound: new Set(), onUnknown: () => undefined });
    let out = buffer.append('see MASKED_PERSON_2393');
    expect(out).toBe('see ');
    out += buffer.append('5247 now');
    out += buffer.flush();
    expect(out).toBe('see [name withheld] now');
  });

  it('holds an unknown placeholder that ends the stream, and resolves it on flush', () => {
    const map = mapWith({ [KNOWN]: 'Alex Example' });
    const buffer = new StreamUnmaskBuffer(map, { inbound: new Set(), onUnknown: () => undefined });
    expect(buffer.append(`ends with ${INVENTED}`) + buffer.flush()).toBe('ends with [name withheld]');
  });

  it('releases a complete placeholder even when the start of another follows it directly', () => {
    const map = mapWith({ [KNOWN]: 'Alex Example' });
    const buffer = new StreamUnmaskBuffer(map, { inbound: new Set(), onUnknown: () => undefined });
    // the id is over at "MASK": only that fragment may be held, not the placeholder before it
    expect(buffer.append(`by ${KNOWN}MASK`)).toBe('by Alex Example');
    expect(buffer.flush()).toBe('MASK');
  });

  it('does not retain ordinary prose just because it contains capitals or underscores', () => {
    const map = mapWith({ [KNOWN]: 'Alex Example' });
    const buffer = new StreamUnmaskBuffer(map, { inbound: new Set(), onUnknown: () => undefined });
    expect(buffer.append('SOME_CONSTANT = 1; ')).toBe('SOME_CONSTANT = 1; ');
  });

  it('keeps its old behaviour for callers that do not ask for containment', () => {
    const map = mapWith({ [KNOWN]: 'Alex Example' });
    const buffer = new StreamUnmaskBuffer(map);
    const out = DELTAS.map((d) => buffer.append(d)).join('') + buffer.flush();
    expect(out).toContain(INVENTED);
  });
});
