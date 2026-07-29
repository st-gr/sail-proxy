import { describe, it, expect } from '@jest/globals';
import {
  normalizeInputToItems,
  buildFunctionCallOutput,
} from '../src/plugins/webSearch/continuation';

const RESULTS = [
  { title: 'Node releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'LTS list', content: 'Node 22 is Active LTS', date: 'July 2026' },
] as any;

describe('normalizeInputToItems', () => {
  it('wraps a bare string prompt as a user message item', () => {
    expect(normalizeInputToItems('hello there')).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello there' }] },
    ]);
  });

  it('returns an item array unchanged', () => {
    const items = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    expect(normalizeInputToItems(items)).toEqual(items);
  });

  it('returns an empty array for null or undefined', () => {
    expect(normalizeInputToItems(undefined)).toEqual([]);
    expect(normalizeInputToItems(null)).toEqual([]);
  });
});

describe('buildFunctionCallOutput', () => {
  it('pairs the output to the call by call_id and carries the results', () => {
    const out = buildFunctionCallOutput('call_1', RESULTS);

    expect(out.type).toBe('function_call_output');
    expect(out.call_id).toBe('call_1');
    const parsed = JSON.parse(out.output);
    expect(parsed.results[0].url).toBe('https://nodejs.org/en/about/previous-releases');
    expect(parsed.results[0].title).toBe('Node releases');
  });

  it('serialises an empty result set without throwing', () => {
    expect(JSON.parse(buildFunctionCallOutput('call_1', []).output)).toEqual({ results: [] });
  });
});
