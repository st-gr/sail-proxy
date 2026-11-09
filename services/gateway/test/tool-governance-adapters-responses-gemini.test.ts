import { responsesAdapter } from '../src/toolGovernance/adapters/responses';
import { geminiAdapter } from '../src/toolGovernance/adapters/gemini';
import { adapterFor } from '../src/toolGovernance/adapters';

describe('responses adapter', () => {
  const body = {
    model: 'gpt', input: 'hi',
    tools: [
      { type: 'function', name: 'a' },
      { type: 'web_search_preview' },
      { type: 'mcp', server_label: 'github', server_url: 'https://example.invalid', allowed_tools: ['create_issue', 'list_issues'] },
      { type: 'mcp', server_label: 'jira', server_url: 'https://example.invalid' }
    ],
    tool_choice: { type: 'mcp', server_label: 'github', name: 'create_issue' }
  };
  it('declares function, hosted, mcp server and mcp tool identities', () => {
    expect(responsesAdapter.declaredTools(body)).toEqual([
      'function:a', 'hosted:web_search_preview', 'mcp:github', 'mcp:github/create_issue', 'mcp:github/list_issues', 'mcp:jira'
    ]);
  });
  /**
   * A typed Responses tool can carry its own name: codex declares its shell as
   * { type: 'custom', name: 'exec' } and its collaboration tools as
   * { type: 'namespace', name: 'collaboration' }. Recording only the TYPE hid which tool it was
   * (every custom tool read as "hosted:custom") and made a policy unable to name one of them. The
   * type identity is kept beside the named one, exactly as an MCP server is kept beside its tools,
   * so a policy can block one custom tool or all of them.
   */
  it('keeps the name of a typed tool that carries one, beside its type', () => {
    const named = { tools: [{ type: 'custom', name: 'exec' }, { type: 'namespace', name: 'collaboration' }] };
    expect(responsesAdapter.declaredTools(named)).toEqual([
      'hosted:custom', 'hosted:custom/exec', 'hosted:namespace', 'hosted:namespace/collaboration'
    ]);
    // blocking one named tool leaves the other declarations of the same type alone
    const kept = responsesAdapter.stripTools(
      { tools: [{ type: 'custom', name: 'exec' }, { type: 'custom', name: 'apply_patch' }] },
      new Set(['hosted:custom/exec'])
    );
    expect(kept.tools).toEqual([{ type: 'custom', name: 'apply_patch' }]);
    // blocking the type blocks every custom tool
    const none = responsesAdapter.stripTools(
      { tools: [{ type: 'custom', name: 'exec' }, { type: 'custom', name: 'apply_patch' }] },
      new Set(['hosted:custom'])
    );
    expect(none.tools).toBeUndefined();
  });
  it('names the tool behind a custom_tool_call invocation', () => {
    expect(responsesAdapter.invokedTools({ output: [{ type: 'custom_tool_call', name: 'exec' }] })).toEqual(['hosted:custom/exec']);
  });
  it('reports the forced tool for function and mcp choices', () => {
    expect(responsesAdapter.forcedTool(body)).toBe('mcp:github/create_issue');
    expect(responsesAdapter.forcedTool({ tool_choice: { type: 'function', name: 'a' } })).toBe('function:a');
    expect(responsesAdapter.forcedTool({ tool_choice: 'auto' })).toBeNull();
  });
  it('strips a whole server, narrows allowed_tools, drops a hosted tool', () => {
    const out = responsesAdapter.stripTools(body, new Set(['hosted:web_search_preview', 'mcp:jira', 'mcp:github/list_issues']));
    expect(out.tools).toEqual([
      { type: 'function', name: 'a' },
      { type: 'mcp', server_label: 'github', server_url: 'https://example.invalid', allowed_tools: ['create_issue'] }
    ]);
    const objForm = responsesAdapter.stripTools({ tools: [{ type: 'mcp', server_label: 'g', allowed_tools: { tool_names: ['x', 'y'] } }] }, new Set(['mcp:g/x']));
    expect(objForm.tools[0].allowed_tools).toEqual({ tool_names: ['y'] });
  });
  it('reads invoked tools from output items and from captured SSE text', () => {
    const payload = { output: [
      { type: 'message' }, { type: 'function_call', name: 'a' }, { type: 'mcp_call', server_label: 'github', name: 'create_issue' },
      { type: 'mcp_list_tools', server_label: 'github' }, { type: 'web_search_call' }, { type: 'computer_call' }
    ] };
    // computer_call is spelled computer_use_preview when the request declares it (HOSTED_CALL_TYPES)
    expect(responsesAdapter.invokedTools(payload)).toEqual(['function:a', 'mcp:github/create_issue', 'hosted:web_search', 'hosted:computer_use_preview']);
    const sse = 'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","name":"a"}}\n\n' +
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"a"}}\n\ndata: [DONE]\n';
    expect(responsesAdapter.invokedToolsFromStream(sse)).toEqual(['function:a']);
  });
  it('narrows an allowed_tools tool_choice and drops a forcing choice once nothing survives', () => {
    const choiceBody = {
      tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }],
      tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }] }
    };
    const narrowed = responsesAdapter.stripTools(choiceBody, new Set(['function:a']));
    expect(narrowed.tool_choice).toEqual({ type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'b' }] });
    expect(choiceBody.tool_choice.tools).toHaveLength(2); // input untouched
    const gone = responsesAdapter.stripTools(choiceBody, new Set(['function:a', 'function:b']));
    expect(gone.tools).toBeUndefined();
    expect(gone.tool_choice).toBeUndefined();
    const one = { tools: [{ type: 'function', name: 'a' }] };
    expect(responsesAdapter.stripTools({ ...one, tool_choice: 'required' }, new Set(['function:a'])).tool_choice).toBeUndefined();
    expect(responsesAdapter.stripTools({ ...one, tool_choice: 'auto' }, new Set(['function:a'])).tool_choice).toBe('auto');
    expect(responsesAdapter.stripTools({ ...one, tool_choice: 'none' }, new Set(['function:a'])).tool_choice).toBe('none');
  });
  it('builds the invalid_request_error body', () => {
    expect(responsesAdapter.rejectionBody('nope').error.code).toBe('tool_not_entitled');
  });
});

describe('gemini adapter', () => {
  const body = {
    contents: [],
    tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }, { functionDeclarations: [{ name: 'c' }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['b'] } }
  };
  it('declares function declarations across tool entries', () => {
    expect(geminiAdapter.declaredTools(body)).toEqual(['function:a', 'function:b', 'function:c']);
  });
  it('reports a forced tool only for ANY with exactly one allowed name', () => {
    expect(geminiAdapter.forcedTool(body)).toBe('function:b');
    expect(geminiAdapter.forcedTool({ toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['a', 'b'] } } })).toBeNull();
    expect(geminiAdapter.forcedTool({ toolConfig: { functionCallingConfig: { mode: 'AUTO' } } })).toBeNull();
  });
  it('strips declarations and drops emptied tool entries', () => {
    const out = geminiAdapter.stripTools(body, new Set(['function:a', 'function:c']));
    expect(out.tools).toEqual([{ functionDeclarations: [{ name: 'b' }] }]);
    expect(out.toolConfig).toEqual(body.toolConfig);
  });
  it('narrows allowedFunctionNames to the surviving declarations and drops an emptied ANY toolConfig', () => {
    const forced = { tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }], toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['a', 'b'] } } };
    const narrowed = geminiAdapter.stripTools(forced, new Set(['function:a']));
    expect(narrowed.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['b'] });
    const emptied = geminiAdapter.stripTools(forced, new Set(['function:a', 'function:b']));
    expect(emptied.tools).toBeUndefined();
    expect(emptied.toolConfig).toBeUndefined();
    const auto = geminiAdapter.stripTools({ ...forced, toolConfig: { functionCallingConfig: { mode: 'AUTO', allowedFunctionNames: ['a'] } } }, new Set(['function:a']));
    expect(auto.toolConfig.functionCallingConfig).toEqual({ mode: 'AUTO' });
    expect(forced.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['a', 'b']); // input untouched
  });
  it('reads invoked function calls from responses and chunks', () => {
    const payload = { candidates: [{ content: { parts: [{ text: 'x' }, { functionCall: { name: 'a', args: {} } }] } }] };
    expect(geminiAdapter.invokedTools(payload)).toEqual(['function:a']);
    expect(geminiAdapter.invokedToolsFromChunk(payload)).toEqual(['function:a']);
    expect(geminiAdapter.invokedToolsFromChunk({ candidates: [{ content: { parts: [{ text: 'y' }] } }] })).toEqual([]);
  });
  it('builds the PERMISSION_DENIED body', () => {
    expect(geminiAdapter.rejectionBody('nope')).toEqual({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'nope' } });
  });
});

describe('adapterFor', () => {
  it('returns each family adapter', () => {
    expect(adapterFor('responses')).toBe(responsesAdapter);
    expect(adapterFor('gemini')).toBe(geminiAdapter);
    expect(adapterFor('anthropic').family).toBe('anthropic');
    expect(adapterFor('openaiChat').family).toBe('openaiChat');
  });
});
