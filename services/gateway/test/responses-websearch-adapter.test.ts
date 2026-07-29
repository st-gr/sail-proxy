import { describe, it, expect } from '@jest/globals';
import {
  hasResponsesWebSearchTool,
  transformResponsesWebSearchTool,
  findPendingResponsesSearch,
  appendFunctionCallOutput,
  isWebSearchFunctionCall,
  parseQueryFromArguments,
  buildWebSearchCallItem,
  buildSearchMessageItem,
} from '../src/plugins/webSearch/responsesAdapter';

const RESULTS = [
  { title: 'Berlin weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry', date: 'July 2026' },
];

describe('responsesAdapter — tool rewrite', () => {
  it('detects a hosted web_search tool', () => {
    expect(hasResponsesWebSearchTool([{ type: 'web_search', external_web_access: false }])).toBe(true);
  });

  it('ignores a plain function tool named something else', () => {
    expect(hasResponsesWebSearchTool([{ type: 'function', name: 'exec_command' }])).toBe(false);
  });

  it('ignores a non-array tools value', () => {
    expect(hasResponsesWebSearchTool(undefined)).toBe(false);
    expect(hasResponsesWebSearchTool('web_search')).toBe(false);
  });

  it('rewrites the hosted tool into a flat function tool and leaves others untouched', () => {
    const body: any = { tools: [{ type: 'function', name: 'exec_command' }, { type: 'web_search', external_web_access: false }] };

    expect(transformResponsesWebSearchTool(body)).toBe(true);

    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]).toEqual({ type: 'function', name: 'exec_command' });
    expect(body.tools[1].type).toBe('function');
    expect(body.tools[1].name).toBe('web_search');
    expect(body.tools[1].parameters.required).toEqual(['query']);
  });

  it('reports no change when there is no hosted tool', () => {
    const body: any = { tools: [{ type: 'function', name: 'exec_command' }] };
    expect(transformResponsesWebSearchTool(body)).toBe(false);
  });

  it('drops the tools key entirely rather than sending an empty array', () => {
    const body: any = { tools: [] };
    transformResponsesWebSearchTool(body);
    expect('tools' in body).toBe(false);
  });
});

describe('responsesAdapter — pending searches', () => {
  it('finds a web_search call with no matching output', () => {
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' },
    ];

    expect(findPendingResponsesSearch(input)).toEqual({ callId: 'call_1', query: 'weather in Berlin' });
  });

  it('returns null when the call already has its output', () => {
    const input = [
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ];

    expect(findPendingResponsesSearch(input)).toBeNull();
  });

  it('ignores pending calls to other tools', () => {
    const input = [{ type: 'function_call', call_id: 'call_9', name: 'exec_command', arguments: '{}' }];
    expect(findPendingResponsesSearch(input)).toBeNull();
  });

  it('returns null for a string input', () => {
    expect(findPendingResponsesSearch('just a prompt')).toBeNull();
  });

  it('appends a function_call_output carrying the results', () => {
    const body: any = { input: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }] };

    appendFunctionCallOutput(body, 'call_1', RESULTS as any);

    const last = body.input[body.input.length - 1];
    expect(last.type).toBe('function_call_output');
    expect(last.call_id).toBe('call_1');
    expect(last.output).toContain('https://w.example/berlin');
  });
});

describe('responsesAdapter — output items', () => {
  it('identifies a web_search function call output item', () => {
    expect(isWebSearchFunctionCall({ type: 'function_call', name: 'web_search' })).toBe(true);
    expect(isWebSearchFunctionCall({ type: 'function_call', name: 'exec_command' })).toBe(false);
    expect(isWebSearchFunctionCall({ type: 'message' })).toBe(false);
  });

  it('parses the query from a JSON arguments string', () => {
    expect(parseQueryFromArguments('{"query":"weather in Berlin"}')).toBe('weather in Berlin');
  });

  it('returns an empty string for unparseable arguments', () => {
    expect(parseQueryFromArguments('{"quer')).toBe('');
    expect(parseQueryFromArguments(undefined)).toBe('');
  });

  it('builds a completed web_search_call item', () => {
    const item = buildWebSearchCallItem('weather in Berlin', 'ws_1');

    expect(item).toEqual({
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: { type: 'search', query: 'weather in Berlin' },
    });
  });

  it('builds a failed web_search_call item when asked', () => {
    expect(buildWebSearchCallItem('q', 'ws_1', 'failed').status).toBe('failed');
  });

  it('builds a message item with url_citation annotations', () => {
    const item = buildSearchMessageItem(RESULTS as any, 'weather in Berlin', 'msg_1');

    expect(item.type).toBe('message');
    expect(item.role).toBe('assistant');
    expect(item.status).toBe('completed');
    expect(item.content[0].type).toBe('output_text');
    expect(item.content[0].text).toContain('Berlin weather');
    expect(item.content[0].annotations[0]).toMatchObject({
      type: 'url_citation',
      url: 'https://w.example/berlin',
      title: 'Berlin weather',
    });
  });

  it('builds a message item that says so when there are no results', () => {
    const item = buildSearchMessageItem([], 'obscure query', 'msg_1');

    expect(item.content[0].text).toContain('No web search results');
    expect(item.content[0].annotations).toEqual([]);
  });
});
