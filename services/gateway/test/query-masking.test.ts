import { describe, it, expect } from '@jest/globals';
import { remaskSearchQuery, remaskResponsesItems } from '../src/plugins/webSearch/queryMasking';
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';

/**
 * These use the REAL ReplacementMap, never a hand-built stand-in. The defect these
 * guard against lived precisely in the gap between the two directions of that class,
 * so a fake map shaped the way the helper expects would have proved nothing.
 */
function reqWith(map: ReplacementMap): any {
  return { __pseudonymizationMap: map };
}

describe('remaskSearchQuery', () => {
  it('re-masks a plain entity value', () => {
    const map = new ReplacementMap('pseudonymization');
    const token = map.getPlaceholder('profile-email', 'john@test.com');

    expect(remaskSearchQuery(reqWith(map), 'company behind john@test.com'))
      .toBe(`company behind ${token}`);
  });

  it('re-masks a URL the model reproduced WITHOUT its scheme', () => {
    const map = new ReplacementMap('pseudonymization');
    const token = map.getPlaceholder('profile-url', 'https://acme-internal-secret.example.com', 'MASKED_URL');

    // The class deliberately stores a scheme-less alias so a model that drops the
    // scheme still unmasks — which means unmasking can emit the bare origin.
    const bareOrigin = 'acme-internal-secret.example.com';
    const bareToken = token.replace(/^https?:\/\//, '');
    expect(map.reverse.get(bareToken)).toBe(bareOrigin);
    expect(map.forward.has(bareOrigin)).toBe(false);   // no forward inverse — the whole point

    expect(remaskSearchQuery(reqWith(map), `what is on ${bareOrigin}`))
      .toBe(`what is on ${bareToken}`);
  });

  it('still re-masks the same URL when the scheme is present', () => {
    const map = new ReplacementMap('pseudonymization');
    const token = map.getPlaceholder('profile-url', 'https://acme-internal-secret.example.com', 'MASKED_URL');

    expect(remaskSearchQuery(reqWith(map), 'summarise https://acme-internal-secret.example.com/docs'))
      .toBe(`summarise ${token}/docs`);
  });

  it('replaces the longest overlapping value first', () => {
    const map = new ReplacementMap('pseudonymization');
    const email = map.getPlaceholder('profile-email', 'john@test.com');
    const domain = map.getPlaceholder('profile-org', 'test.com');

    const out = remaskSearchQuery(reqWith(map), 'mail john@test.com and site test.com');

    expect(out).toBe(`mail ${email} and site ${domain}`);
    expect(out).not.toContain('john@');
  });

  it('leaves the query untouched when there is no map', () => {
    expect(remaskSearchQuery({}, 'company behind john@test.com'))
      .toBe('company behind john@test.com');
  });

  it('leaves the query untouched when the map is empty', () => {
    expect(remaskSearchQuery(reqWith(new ReplacementMap('pseudonymization')), 'nothing to mask'))
      .toBe('nothing to mask');
  });

  it('works under the anonymization method, where reverse is empty', () => {
    const map = new ReplacementMap('anonymization');
    const token = map.getPlaceholder('profile-email', 'john@test.com');

    expect(map.reverse.size).toBe(0);
    expect(remaskSearchQuery(reqWith(map), 'mail john@test.com')).toBe(`mail ${token}`);
  });
});

describe('remaskResponsesItems', () => {
  it('leaves encrypted_content, id and call_id byte-identical even when a short masked original is a substring of them', () => {
    const map = new ReplacementMap('pseudonymization');
    // A short original — the exact class of value a dictionary/NER entity type like
    // profile-gender or profile-nationality routinely mints, and the reviewer's
    // reported failure mode — has a real chance of turning up as a substring inside a
    // long, opaque base64 blob purely by coincidence.
    map.getPlaceholder('profile-gender', 'male');

    const encryptedContent = 'gAAAAABmZmaleXk9pQ0lVSk1URXhKUTBGVVNVSU8maledGhlcmVzdA==';
    const items = [
      { type: 'reasoning', id: 'rs_male_1', summary: [], encrypted_content: encryptedContent },
      { type: 'function_call', id: 'fc_1', call_id: 'call_male_1', name: 'web_search', arguments: '{"query":"q"}' },
    ];

    const out = remaskResponsesItems(items, reqWith(map));

    expect(out[0].encrypted_content).toBe(encryptedContent);   // byte-identical
    expect(out[0].id).toBe('rs_male_1');
    expect(out[1].id).toBe('fc_1');
    expect(out[1].call_id).toBe('call_male_1');
  });

  it('remasks content.text, content.refusal, a bare string content, arguments, output, and summary.text', () => {
    const map = new ReplacementMap('pseudonymization');
    const token = map.getPlaceholder('profile-email', 'john@test.com');

    const items = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'mail john@test.com', annotations: [] }] },
      { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'cannot share john@test.com' }] },
      // A legal Responses input shape: `content` as a bare string rather than an array
      // of parts — the one field in this set with no dedicated coverage before this.
      { type: 'message', role: 'user', content: 'mail john@test.com' },
      { type: 'function_call', call_id: 'c1', arguments: '{"query":"mail john@test.com"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'found john@test.com' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking about john@test.com' }] },
    ];

    const out = remaskResponsesItems(items, reqWith(map));

    expect(out[0].content[0].text).toBe(`mail ${token}`);
    expect(out[1].content[0].refusal).toBe(`cannot share ${token}`);
    expect(out[2].content).toBe(`mail ${token}`);
    expect(out[3].arguments).toBe(`{"query":"mail ${token}"}`);
    expect(out[4].output).toBe(`found ${token}`);
    expect(out[5].summary[0].text).toBe(`thinking about ${token}`);
  });

  it('does not mutate the caller\'s item or part objects', () => {
    const map = new ReplacementMap('pseudonymization');
    map.getPlaceholder('profile-email', 'john@test.com');

    const original = [{ type: 'message', content: [{ type: 'output_text', text: 'mail john@test.com' }] }];
    const snapshot = JSON.parse(JSON.stringify(original));

    remaskResponsesItems(original, reqWith(map));

    expect(original).toEqual(snapshot);
  });

  it('leaves items untouched when there is no map', () => {
    const items = [{ type: 'message', content: [{ type: 'output_text', text: 'mail john@test.com' }] }];
    expect(remaskResponsesItems(items, {})).toEqual(items);
  });

  it('passes through a non-array input unchanged', () => {
    expect(remaskResponsesItems(undefined as any, {})).toBeUndefined();
  });
});
