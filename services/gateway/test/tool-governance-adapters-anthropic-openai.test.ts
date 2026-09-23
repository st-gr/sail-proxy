import { anthropicAdapter } from '../src/toolGovernance/adapters/anthropic';
import { openaiChatAdapter } from '../src/toolGovernance/adapters/openaiChat';

describe('anthropic adapter', () => {
  const body = {
    model: 'claude', messages: [],
    tools: [{ name: 'jira_create', input_schema: {} }, { type: 'web_search_20250305', name: 'web_search' }],
    mcp_servers: [{ type: 'url', name: 'github', url: 'https://example.invalid/mcp' }],
    tool_choice: { type: 'tool', name: 'jira_create' }
  };
  it('declares function, hosted and mcp identities', () => {
    expect(anthropicAdapter.declaredTools(body)).toEqual(['function:jira_create', 'hosted:web_search', 'mcp:github']);
    expect(anthropicAdapter.declaredTools({})).toEqual([]);
  });
  it('reports the forced tool', () => {
    expect(anthropicAdapter.forcedTool(body)).toBe('function:jira_create');
    expect(anthropicAdapter.forcedTool({ tool_choice: { type: 'auto' } })).toBeNull();
  });
  it('classifies a forced server tool the same way declaredTools does', () => {
    expect(anthropicAdapter.forcedTool({ ...body, tool_choice: { type: 'tool', name: 'web_search' } })).toBe('hosted:web_search');
    expect(anthropicAdapter.forcedTool(body)).toBe('function:jira_create');
  });
  it('strips blocked entries and leaves the rest intact', () => {
    const out = anthropicAdapter.stripTools(body, new Set(['hosted:web_search', 'mcp:github']));
    expect(out.tools).toEqual([{ name: 'jira_create', input_schema: {} }]);
    expect(out.mcp_servers).toBeUndefined();
    expect(out.tool_choice).toEqual(body.tool_choice);
    expect(body.tools).toHaveLength(2); // input untouched
  });
  it('reads invoked tools from a message and from stream chunks', () => {
    const msg = { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'jira_create' }, { type: 'server_tool_use', name: 'web_search' }, { type: 'mcp_tool_use', server_name: 'github', name: 'create_issue' }] };
    expect(anthropicAdapter.invokedTools(msg)).toEqual(['function:jira_create', 'hosted:web_search', 'mcp:github/create_issue']);
    expect(anthropicAdapter.invokedToolsFromChunk({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'jira_create' } })).toEqual(['function:jira_create']);
    expect(anthropicAdapter.invokedToolsFromChunk({ type: 'content_block_delta' })).toEqual([]);
    expect(anthropicAdapter.invokedTools({ choices: [{ message: { tool_calls: [{ function: { name: 'x' } }] } }] })).toEqual(['function:x']);
  });
  it('builds the permission_error body', () => {
    expect(anthropicAdapter.rejectionBody('nope')).toEqual({ type: 'error', error: { type: 'permission_error', message: 'nope' } });
  });
  it('reads invoked tools from accumulated SSE text', () => {
    const text = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"jira_create"}}',
      'not-a-data-line',
      'data: {"type":"content_block_delta"}',
      'data: [DONE]',
      ''
    ].join('\n');
    expect(anthropicAdapter.invokedToolsFromStream(text)).toEqual(['function:jira_create']);
  });
});

describe('openai chat adapter', () => {
  const body = {
    model: 'gpt', messages: [],
    tools: [{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'b' } }],
    tool_choice: { type: 'function', function: { name: 'b' } }
  };
  it('declares tools and legacy functions', () => {
    expect(openaiChatAdapter.declaredTools(body)).toEqual(['function:a', 'function:b']);
    expect(openaiChatAdapter.declaredTools({ functions: [{ name: 'legacy' }] })).toEqual(['function:legacy']);
  });
  it('reports the forced tool', () => {
    expect(openaiChatAdapter.forcedTool(body)).toBe('function:b');
    expect(openaiChatAdapter.forcedTool({ tool_choice: 'required' })).toBeNull();
    expect(openaiChatAdapter.forcedTool({ function_call: { name: 'legacy' } })).toBe('function:legacy');
  });
  it('strips blocked tools', () => {
    const out = openaiChatAdapter.stripTools(body, new Set(['function:a']));
    expect(out.tools).toEqual([{ type: 'function', function: { name: 'b' } }]);
    const legacy = openaiChatAdapter.stripTools({ functions: [{ name: 'l' }, { name: 'm' }] }, new Set(['function:l']));
    expect(legacy.functions).toEqual([{ name: 'm' }]);
  });
  it('drops an emptied tools array', () => {
    expect(openaiChatAdapter.stripTools(body, new Set(['function:a', 'function:b'])).tools).toBeUndefined();
  });
  it('drops a forcing tool_choice/function_call once nothing is left to call, and keeps auto/none', () => {
    const all = new Set(['function:a', 'function:b']);
    expect(openaiChatAdapter.stripTools(body, all).tool_choice).toBeUndefined();
    expect(openaiChatAdapter.stripTools({ ...body, tool_choice: 'required' }, all).tool_choice).toBeUndefined();
    expect(openaiChatAdapter.stripTools({ ...body, tool_choice: 'auto' }, all).tool_choice).toBe('auto');
    expect(openaiChatAdapter.stripTools({ ...body, tool_choice: 'none' }, all).tool_choice).toBe('none');
    // a choice that still has its tool keeps it
    expect(openaiChatAdapter.stripTools(body, new Set(['function:a'])).tool_choice).toEqual(body.tool_choice);
    const legacy = openaiChatAdapter.stripTools({ functions: [{ name: 'l' }], function_call: { name: 'l' } }, new Set(['function:l']));
    expect(legacy.functions).toBeUndefined();
    expect(legacy.function_call).toBeUndefined();
  });
  it('reads invoked tools from responses and chunks', () => {
    expect(openaiChatAdapter.invokedTools({ choices: [{ message: { tool_calls: [{ function: { name: 'a' } }, { function: { name: 'a' } }] } }] })).toEqual(['function:a', 'function:a']);
    expect(openaiChatAdapter.invokedToolsFromChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'a', arguments: '' } }] } }] })).toEqual(['function:a']);
    expect(openaiChatAdapter.invokedToolsFromChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] })).toEqual([]);
  });
  it('builds the invalid_request_error body', () => {
    expect(openaiChatAdapter.rejectionBody('nope')).toEqual({ error: { message: 'nope', type: 'invalid_request_error', code: 'tool_not_entitled' } });
  });
  it('reads invoked tools from accumulated SSE text', () => {
    const text = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"a","arguments":""}}]}}]}',
      'not-a-data-line',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}',
      'data: [DONE]',
      ''
    ].join('\n');
    expect(openaiChatAdapter.invokedToolsFromStream(text)).toEqual(['function:a']);
  });
});
