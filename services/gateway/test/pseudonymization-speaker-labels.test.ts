/**
 * Transcript speaker labels, and the given names they vouch for.
 *
 * Found while tracing incident k80nbbxr6 (2026-09-21). The request carried a meeting transcript,
 * and person detection barely ran on it. The only detector of personal names is a run of two or
 * more capitalised tokens, so of the three written forms in that one request:
 *
 *   "Given Surname"             4 occurrences   all masked
 *   "Surname, Given:" label    83 occurrences   NONE masked - the comma splits the run in two
 *   given name alone           16 occurrences   NONE masked - one token is never a run
 *
 * Two of the three people in it never appeared as "Given Surname" at all, so every mention of them
 * went to the provider in clear. The names below are invented; the layout is the transcript's.
 */
import { describe, it, expect } from '@jest/globals';
import { detectEntities } from '../src/plugins/pseudonymization/detectors';
import { MaskingConfig } from '../src/plugins/pseudonymization/types';
import pluginRules from '../src/plugins/pseudonymization';

const personOnly: MaskingConfig = { method: 'pseudonymization', entities: [{ type: 'profile-person' }] };
const people = (text: string) =>
  detectEntities(text, personOnly).filter((m) => m.type === 'profile-person').map((m) => m.original);

// WebVTT-style export: cue number, tab, "Surname, Given:" and the words spoken.
const TRANSCRIPT = [
  '00:21:55.799 --> 00:23:01.079',
  '5\tOkafor, Lena: copy. I do have a copy. Yeah.',
  '00:23:40.240 --> 00:24:40.839',
  '13\tBrandt, Milo: I was looking through the outline.',
  '00:25:12.960 --> 00:25:34.640',
  '21\tOkafor, Lena: Should they call it a platform? I know Milo, you were going to say something.',
  '00:38:11.880 --> 00:38:27.239',
  '109\tBrandt, Milo: Yeah, I agree, Lena. I do not think so.',
].join('\n');

describe('speaker labels', () => {
  it('masks both parts of a "Surname, Given:" label, on every line that carries one', () => {
    const found = people(TRANSCRIPT);
    for (const part of ['Okafor', 'Lena', 'Brandt', 'Milo']) expect(found).toContain(part);
    // the label's punctuation is not part of anybody's name
    expect(found.some((p) => p.includes(',') || p.includes(':'))).toBe(false);
  });

  it('accepts a label without a cue number once it repeats, with a two-word or particled surname', () => {
    const text = 'Van Doorn, Petra: first point.\nde la Cruz, Ines: second point.\nVan Doorn, Petra: third.\nde la Cruz, Ines: fourth.';
    const found = people(text);
    expect(found).toEqual(expect.arrayContaining(['Van Doorn', 'Petra', 'de la Cruz', 'Ines']));
  });

  /**
   * Rows of `City, Country: value` have the label's shape on every line, but no line repeats and
   * none carries a cue. Masking them would hand the model placeholders where its data should be.
   */
  it('does not read a list of places as speakers', () => {
    const text = 'Paris, France: 2.1 million\nBerlin, Germany: 3.6 million\nMadrid, Spain: 3.2 million';
    expect(people(text)).toEqual([]);
  });

  /**
   * One line shaped like a label is not a transcript. "Paris, France: the capital" has the same
   * shape, and so does a bibliography entry; only the repetition of the structure says "speakers".
   */
  it('does not read a single label-shaped line as a speaker', () => {
    expect(people('Paris, France: the capital of the country.')).toEqual([]);
    expect(people('Summary, Details: see the attached sheet.\nNothing else here.')).toEqual([]);
  });

  it('never takes ordinary label words for a name, however often they repeat', () => {
    const text = 'Note, Important: read this first.\nWarning, Final: last reminder.\nNote, Important: again.';
    expect(people(text)).toEqual([]);
  });
});

describe('a name a label vouches for is masked wherever it stands alone', () => {
  const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before')?.handler;
  const mockLogger: any = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

  async function mask(messages: any[]) {
    const req: any = { body: { messages, masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] } } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    return { sent: JSON.stringify(req.body.messages), map: req.__pseudonymizationMap };
  }

  it('sends none of the names to the provider: not in the labels, not in the prose, not in a later turn', async () => {
    const { sent } = await mask([
      { role: 'user', content: `Here is the transcript.\n${TRANSCRIPT}` },
      { role: 'assistant', content: 'Understood. Lena chaired the meeting and Milo took notes.' },
      { role: 'user', content: 'Put Lena and Milo on the title slide.' },
    ]);
    for (const name of ['Okafor', 'Lena', 'Brandt', 'Milo']) expect(sent).not.toContain(name);
  });

  /**
   * The label and the bare mention must carry the SAME placeholder. A speaker called one thing in
   * the label and another in the sentence that addresses them would cost the model the link between
   * the two - and every extra distinct placeholder raises the rate at which a model invents one.
   */
  it('uses one placeholder for a given name in its label and on its own', async () => {
    const { sent, map } = await mask([{ role: 'user', content: TRANSCRIPT }]);
    const milo = map.forward.get('Milo');
    expect(milo).toMatch(/^MASKED_PERSON_\d+$/);
    expect(sent).toContain(`, ${milo}:`);                            // in the label
    expect(sent).toContain(`I know ${milo}, you were`);              // on its own
  });

  it('restores every name exactly, labels and punctuation included', async () => {
    const { sent, map } = await mask([{ role: 'user', content: TRANSCRIPT }]);
    let restored: string = JSON.parse(sent)[0].content;
    for (const [placeholder, original] of map.reverse) restored = restored.split(placeholder).join(original);
    expect(restored).toBe(TRANSCRIPT);
  });

  /**
   * Standing alone, a given name that is also an everyday word is NOT propagated: "Will you send
   * it?" and "in May" must survive a transcript with a speaker called Will or May. The label itself
   * is still masked - its structure is the evidence there, not the word.
   */
  it('masks an everyday-word name in its label but leaves the word alone elsewhere', async () => {
    const text = 'Harlan, Will: I can send it.\nOkafor, May: Will you send it in May?\nHarlan, Will: Yes.\nOkafor, May: Good.';
    const { sent } = await mask([{ role: 'user', content: text }]);
    const body: string = JSON.parse(sent)[0].content;
    expect(body).toContain('Will you send it in May?');
    expect(body).not.toContain('Harlan, Will:');
    expect(body).not.toContain('Okafor, May:');
    expect(body).not.toContain('Harlan');
  });

  it('never masks inside a longer word or an identifier', async () => {
    const text = 'Okafor, Lena: see Lenaville and lena_config.\nBrandt, Milo: fine.';
    const { sent } = await mask([{ role: 'user', content: text }]);
    const body: string = JSON.parse(sent)[0].content;
    expect(body).toContain('Lenaville');
    expect(body).toContain('lena_config');
  });
});
