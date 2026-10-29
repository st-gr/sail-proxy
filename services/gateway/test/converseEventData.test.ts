/**
 * parseConverseEventData reads the data of one emulated Converse stream event:
 * JSON, or a literal whose strings may be single-quoted (Python-style). It
 * must never evaluate the input.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { parseConverseEventData } from '../src/utils/converseEventData';

describe('parseConverseEventData', () => {
  afterEach(() => { delete (globalThis as any).__pwned; });

  it('parses JSON', () => {
    expect(parseConverseEventData('{"messageStop":{"stopReason":"end_turn"}}'))
      .toEqual({ messageStop: { stopReason: 'end_turn' } });
  });

  it('parses single-quoted strings, keeping apostrophes and escapes', () => {
    expect(parseConverseEventData(`{'delta': {'text': "It's"}, 'n': 1.5, 'list': ['a\\'b', 'c\\\\d', 'e\\nf', '\\u00e9', '\\x41', 'say "hi"']}`))
      .toEqual({ delta: { text: "It's" }, n: 1.5, list: ["a'b", 'c\\d', 'e\nf', 'é', 'A', 'say "hi"'] });
  });

  it('leaves a single quote inside a double-quoted string alone, and vice versa', () => {
    expect(parseConverseEventData(`{"a": "x'y", 'b': 'p"q'}`)).toEqual({ a: "x'y", b: 'p"q' });
  });

  it.each([
    '(() => { globalThis.__pwned = 1; return {} })()',
    '{"a": (globalThis.__pwned = 1)}',
    "{'a': (globalThis.__pwned = 1)}",
    '{a: 1}',
    "{'a': 'unterminated}",
    "{'a': '\\q'}",
    '',
  ])('rejects %j without evaluating it', (input) => {
    expect(() => parseConverseEventData(input)).toThrow();
    expect((globalThis as any).__pwned).toBeUndefined();
  });
});
