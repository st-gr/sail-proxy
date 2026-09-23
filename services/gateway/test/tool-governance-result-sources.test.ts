/**
 * Which tools' OUTPUT a request carries (spec 2026-09-22 §3.2): each result paired with the call
 * that produced it. Identities come out raw (as the client spelled them); the middleware normalises.
 */
import { openaiChatAdapter } from '../src/toolGovernance/adapters/openaiChat';
import { responsesAdapter } from '../src/toolGovernance/adapters/responses';
import { anthropicAdapter } from '../src/toolGovernance/adapters/anthropic';
import { geminiAdapter } from '../src/toolGovernance/adapters/gemini';

const ids = (sources: { identity: string }[]) => sources.map((s) => s.identity);

describe('openaiChat resultSources', () => {
  it('pairs tool messages with the assistant call, unknown ids become <unknown>', () => {
    const body = { messages: [
      { role: 'user', content: 'look it up' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__browser__fetch', arguments: '{"url":"https://example.invalid"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'page text' },
      { role: 'tool', tool_call_id: 'gone', content: 'old result' }
    ] };
    const out = openaiChatAdapter.resultSources(body);
    expect(ids(out)).toEqual(['function:mcp__browser__fetch', 'function:<unknown>']);
    expect(out[0].args).toBe('{"url":"https://example.invalid"}');
  });
  it('legacy function messages carry their own name; garbage yields nothing', () => {
    expect(ids(openaiChatAdapter.resultSources({ messages: [{ role: 'function', name: 'lookup', content: 'x' }] }))).toEqual(['function:lookup']);
    expect(openaiChatAdapter.resultSources({ messages: 'nope' })).toEqual([]);
    expect(openaiChatAdapter.resultSources(undefined)).toEqual([]);
  });
});

describe('responses resultSources', () => {
  it('function and custom call outputs pair by call_id; mcp and hosted calls count directly', () => {
    const body = { input: [
      { type: 'function_call', call_id: 'f1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'f1', output: 'ok' },
      { type: 'custom_tool_call', call_id: 'x1', name: 'exec', input: 'tools.mcp__github__get_issue({})' },
      { type: 'custom_tool_call_output', call_id: 'x1', output: 'issue' },
      { type: 'mcp_call', server_label: 'browser', name: 'fetch', arguments: '{}', output: 'page' },
      { type: 'mcp_call', server_label: 'browser', name: 'fetch', arguments: '{}' },
      { type: 'web_search_call', id: 'ws1', status: 'completed' },
      { type: 'function_call_output', call_id: 'missing', output: 'x' },
      { type: 'message', role: 'user', content: 'hi' }
    ] };
    const out = responsesAdapter.resultSources(body);
    expect(ids(out)).toEqual(['function:read', 'hosted:custom/exec', 'mcp:browser/fetch', 'hosted:web_search', 'function:<unknown>']);
    expect(out[1].args).toBe('tools.mcp__github__get_issue({})');
  });
  it('a string input carries no results', () => {
    expect(responsesAdapter.resultSources({ input: 'hello' })).toEqual([]);
  });
});

describe('anthropic resultSources', () => {
  it('tool_result pairs with tool_use; server results map to their hosted tool; mcp results to their server', () => {
    const body = { messages: [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
        { type: 'mcp_tool_use', id: 'm1', server_name: 'browser', name: 'fetch', input: {} },
        { type: 'mcp_tool_result', tool_use_id: 'm1', content: [] }
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'files' },
        { type: 'tool_result', tool_use_id: 'nope', content: 'x' }
      ] }
    ] };
    const out = anthropicAdapter.resultSources(body);
    expect(ids(out)).toEqual(['hosted:web_search', 'mcp:browser/fetch', 'function:Bash', 'function:<unknown>']);
    expect(typeof out[2].args).toBe('function');
    expect((out[2].args as () => string)()).toBe('{"command":"ls"}');
  });
  it('a call\'s input is stringified only when its args are read', () => {
    let stringified = 0;
    const input = { command: 'ls', toJSON() { stringified++; return { command: 'ls' }; } };
    const out = anthropicAdapter.resultSources({ messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'files' }] }
    ] });
    expect(stringified).toBe(0);
    expect((out[0].args as () => string)()).toBe('{"command":"ls"}');
    expect(stringified).toBe(1);
  });
  it('a string message content carries no results', () => {
    expect(anthropicAdapter.resultSources({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([]);
  });
});

describe('gemini resultSources', () => {
  it('functionResponse parts name themselves', () => {
    const body = { contents: [
      { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search', response: {} } }, { text: 'thanks' }] }
    ] };
    expect(ids(geminiAdapter.resultSources(body))).toEqual(['function:search']);
  });
});
