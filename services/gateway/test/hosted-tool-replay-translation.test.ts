import { webSearchDescriptor } from '../src/plugins/webSearch/descriptor';
import { fileSearchDescriptor } from '../src/plugins/fileSearch/descriptor';
import { descriptorForReplayedCallItem } from '../src/plugins/hostedTool/registry';
import { buildReplayFunctionCall } from '../src/plugins/hostedTool/replayTranslation';
import '../src/plugins/responsesWebSearchPlugin';
import '../src/plugins/responsesFileSearchPlugin';

describe('replayQueryFrom', () => {
  it('recovers a web_search query from the action the client replays', () => {
    const item = { type: 'web_search_call', id: 'ws_a', status: 'completed',
      action: { type: 'search', query: 'latest AI news today' } };
    expect(webSearchDescriptor.replayQueryFrom!(item)).toBe('latest AI news today');
  });

  it('recovers a file_search query from queries[0], since the tool takes a singular query', () => {
    const item = { type: 'file_search_call', id: 'fs_a', status: 'completed', queries: ['quarterly revenue'] };
    expect(fileSearchDescriptor.replayQueryFrom!(item)).toBe('quarterly revenue');
  });

  it('yields empty string rather than throwing on a malformed item', () => {
    expect(webSearchDescriptor.replayQueryFrom!({ type: 'web_search_call' })).toBe('');
    expect(fileSearchDescriptor.replayQueryFrom!({ type: 'file_search_call', queries: [] })).toBe('');
  });
});

describe('descriptorForReplayedCallItem', () => {
  it('maps a replayed hosted call item to its descriptor by <type>_call', () => {
    expect(descriptorForReplayedCallItem({ type: 'web_search_call' })?.type).toBe('web_search');
    expect(descriptorForReplayedCallItem({ type: 'file_search_call' })?.type).toBe('file_search');
  });

  it('ignores a function_call — that is the other lookup', () => {
    expect(descriptorForReplayedCallItem({ type: 'function_call', name: 'web_search' })).toBeUndefined();
  });
});

describe('rehydratePayload', () => {
  it('passes web_search results through unchanged — nothing about them is request-scoped', () => {
    const results = [{ title: 'T', url: 'u', snippet: 's', content: 'c' }];
    expect(webSearchDescriptor.rehydratePayload!(results, {} as any)).toEqual(results);
  });

  it('re-masks file_search hits with the REPLAYING request\'s map, not the cached text', () => {
    // Shaped like a real SearchHit (`content` is a parts array — see fileSearch/search.ts and
    // descriptor.ts's `textOf`), not a bare `text` field: the wrong shape lets `toWireResults`
    // silently render an empty string and this test would pass vacuously either way.
    const cached = { hits: [{ fileId: 'f1', filename: 'a.md', score: 1, attributes: {},
      content: [{ type: 'text', text: 'Contact alice@example.com about it' }] }],
      queries: ['contact'] };
    const { ReplacementMap } = require('../src/plugins/pseudonymization/replacementMap');
    const map = new ReplacementMap('pseudonymization');
    const out: any = fileSearchDescriptor.rehydratePayload!(cached, {
      replacementMap: map, maskingConfig: undefined, logger: console,
    } as any);
    expect(out.maskedResults[0].text).not.toContain('alice@example.com');
    expect(out.maskedResults[0].text).toMatch(/MASKED_EMAIL_\d+/);
    expect(out.hits[0].content[0].text).toContain('alice@example.com');
  });
});

describe('buildReplayFunctionCall', () => {
  it('rebuilds the function_call the model would have emitted, reusing the item id as call_id', () => {
    const item = { type: 'web_search_call', id: 'ws_abc1234', status: 'completed',
      action: { type: 'search', query: 'latest AI news today' } };
    expect(buildReplayFunctionCall(webSearchDescriptor, item, 'latest AI news today')).toEqual({
      type: 'function_call',
      call_id: 'ws_abc1234',
      name: 'web_search',
      arguments: JSON.stringify({ query: 'latest AI news today' }),
    });
  });

  it('uses the descriptor\'s own function name, so file_search rebuilds as file_search', () => {
    const item = { type: 'file_search_call', id: 'fs_abc1234', status: 'completed', queries: ['revenue'] };
    expect(buildReplayFunctionCall(fileSearchDescriptor, item, 'revenue').name).toBe('file_search');
  });
});
