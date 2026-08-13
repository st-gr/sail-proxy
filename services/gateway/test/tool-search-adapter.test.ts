/**
 * Shapes here are verbatim from real codex 0.147.0 traffic against api.openai.com,
 * recorded in test/fixtures/codex-custom-tools/tool-search-capture.md. Nothing is invented.
 */
import { describe, it, expect } from '@jest/globals';
import {
  translateToolSearchTool,
  translateToolSearchOutputItems,
  restoreToolSearchCall,
  restoreToolSearchItems,
  resolveToolSearchMode,
  DEFAULT_TOOL_SEARCH_MODE,
  TOOL_SEARCH_TOOL_NAME,
} from '../src/plugins/toolSearch/adapter';

/** The captured declaration: four keys, and NO `name`. */
const toolSearchDecl = () => ({
  type: 'tool_search',
  execution: 'client',
  description: '# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of tools to return. Defaults to 8.' },
      query: { type: 'string', description: 'Search query for deferred tools.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
});

describe('translateToolSearchTool', () => {
  it('rewrites the declaration into a function tool, supplying the missing name', () => {
    const body: any = { tools: [{ type: 'function', name: 'exec_command' }, toolSearchDecl()] };
    const r = translateToolSearchTool(body, 'translate');

    expect(r).toEqual({ changed: true, translated: true, dropped: false });
    expect(body.tools[1]).toEqual({
      type: 'function',
      name: TOOL_SEARCH_TOOL_NAME,
      description: toolSearchDecl().description,
      parameters: toolSearchDecl().parameters,
    });
  });

  it('drops `execution`, which is not a field a function tool may carry', () => {
    const body: any = { tools: [toolSearchDecl()] };
    translateToolSearchTool(body, 'translate');
    expect(body.tools[0].execution).toBeUndefined();
  });

  it('tolerates a declaration with no `execution` — one capture omits it', () => {
    const decl: any = toolSearchDecl();
    delete decl.execution;
    const body: any = { tools: [decl] };
    expect(translateToolSearchTool(body, 'translate').translated).toBe(true);
    expect(body.tools[0].type).toBe('function');
  });

  it('removes the tool in strip mode and deletes an emptied tools array', () => {
    const body: any = { tools: [toolSearchDecl()] };
    const r = translateToolSearchTool(body, 'strip');
    expect(r).toEqual({ changed: true, translated: false, dropped: true });
    expect(body.tools).toBeUndefined();
  });

  it('is a no-op when no tool_search is present', () => {
    const body: any = { tools: [{ type: 'function', name: 'exec_command' }] };
    expect(translateToolSearchTool(body, 'translate').changed).toBe(false);
    expect(body.tools).toHaveLength(1);
  });

  it('resolves an unknown mode to the default', () => {
    expect(resolveToolSearchMode('nonsense')).toBe(DEFAULT_TOOL_SEARCH_MODE);
    expect(DEFAULT_TOOL_SEARCH_MODE).toBe('translate');
  });
});

describe('translateToolSearchOutputItems', () => {
  /** The captured output item, with a populated `tools` array of namespace wrappers. */
  const outputItem = () => ({
    type: 'tool_search_output',
    id: 'tso_019ff30e-f030-70a2-b22f-544e804b5699',
    call_id: 'call_1jyP3Ac7IS5Hnl92l4Kxgc2N',
    status: 'completed',
    execution: 'client',
    tools: [{
      type: 'namespace',
      name: 'mcp__capturedocs',
      description: 'Tools in the mcp__capturedocs namespace.',
      tools: [
        { type: 'function', name: 'capture_read_document', strict: false, defer_loading: true, parameters: {} },
        { type: 'function', name: 'capture_list_documents', strict: false, defer_loading: true, parameters: {} },
      ],
    }],
    internal_chat_message_metadata_passthrough: { turn_id: '019ff30e-e926-75e2-ab04-6a7c1b5f771c' },
  });

  it('converts it to a function_call_output preserving call_id', () => {
    const body: any = { input: [outputItem()] };
    expect(translateToolSearchOutputItems(body)).toBe(1);
    expect(body.input[0].type).toBe('function_call_output');
    expect(body.input[0].call_id).toBe('call_1jyP3Ac7IS5Hnl92l4Kxgc2N');
  });

  it('DROPS the tso_-prefixed id, which upstream rejects once the type is rewritten', () => {
    // The apply_patch work hit exactly this with a ctco_ id:
    // "Invalid 'input[8].id': 'ctco_…'. Expected an ID that begins with 'fc'."
    const body: any = { input: [outputItem()] };
    translateToolSearchOutputItems(body);
    expect(body.input[0].id).toBeUndefined();
  });

  it('summarises the discovered tools, flattening namespace wrappers', () => {
    const body: any = { input: [outputItem()] };
    translateToolSearchOutputItems(body);
    expect(JSON.parse(body.input[0].output)).toEqual({
      tools: [
        { name: 'capture_read_document', namespace: 'mcp__capturedocs' },
        { name: 'capture_list_documents', namespace: 'mcp__capturedocs' },
      ],
    });
  });

  it('handles an empty tools array, which is what an API-key session really returns', () => {
    const item: any = { ...outputItem(), tools: [] };
    const body: any = { input: [item] };
    translateToolSearchOutputItems(body);
    expect(JSON.parse(body.input[0].output)).toEqual({ tools: [] });
  });

  it('leaves unrelated items alone', () => {
    const body: any = { input: [{ type: 'message', role: 'user', content: 'hi' }] };
    expect(translateToolSearchOutputItems(body)).toBe(0);
    expect(body.input[0].type).toBe('message');
  });

  it('converts a replayed tool_search_call, whose omission killed the turn live', () => {
    // Found by running real codex against the gateway: converting only the OUTPUT left the
    // replayed CALL to fail the next turn with
    //   "Unsupported Responses input item type: tool_search_call"
    // Shape verbatim from tool-search-capture.md.
    const body: any = {
      input: [{
        id: 'tsc_04b2930e83ec9e9d016a7ba6d119e4819ba3a0b559971d5fe7',
        type: 'tool_search_call',
        status: 'completed',
        arguments: { query: 'documents', limit: 8 },
        call_id: 'call_TjzTAr0Vbhygn4xbIYWmIuHw',
        execution: 'client',
      }],
    };
    expect(translateToolSearchOutputItems(body)).toBe(1);
    expect(body.input[0].type).toBe('function_call');
    expect(body.input[0].name).toBe(TOOL_SEARCH_TOOL_NAME);
    // Object -> JSON string, the direction that feeds a function-tool upstream.
    expect(body.input[0].arguments).toBe('{"query":"documents","limit":8}');
    expect(body.input[0].call_id).toBe('call_TjzTAr0Vbhygn4xbIYWmIuHw');
    expect(body.input[0].id).toBeUndefined();      // tsc_ prefix would be rejected
  });

  it('converts a replayed call/output PAIR, which is how codex actually replays them', () => {
    const body: any = {
      input: [
        { type: 'tool_search_call', id: 'tsc_1', call_id: 'call_1', arguments: { query: 'q' } },
        { type: 'tool_search_output', id: 'tso_1', call_id: 'call_1', tools: [] },
      ],
    };
    expect(translateToolSearchOutputItems(body)).toBe(2);
    expect(body.input.map((i: any) => i.type)).toEqual(['function_call', 'function_call_output']);
    expect(body.input[0].call_id).toBe(body.input[1].call_id);   // pairing survives
  });

  it('degrades a call with no usable arguments to {} rather than emitting undefined', () => {
    const body: any = { input: [{ type: 'tool_search_call', call_id: 'c' }] };
    translateToolSearchOutputItems(body);
    expect(body.input[0].arguments).toBe('{}');
  });
});

describe('restoreToolSearchCall', () => {
  it('turns the function_call back into a tool_search_call with OBJECT arguments', () => {
    // The asymmetry that matters: function_call.arguments is a STRING,
    // tool_search_call.arguments is an OBJECT.
    const item: any = {
      id: 'fc_1', type: 'function_call', status: 'completed',
      call_id: 'call_TjzTAr0Vbhygn4xbIYWmIuHw',
      name: TOOL_SEARCH_TOOL_NAME,
      arguments: '{"query":"documents","limit":8}',
    };
    expect(restoreToolSearchCall(item)).toBe(true);
    expect(item.type).toBe('tool_search_call');
    expect(item.arguments).toEqual({ query: 'documents', limit: 8 });
    expect(item.call_id).toBe('call_TjzTAr0Vbhygn4xbIYWmIuHw');
    expect(item.name).toBeUndefined();
    expect(item.execution).toBe('client');
  });

  it('maps the streamed empty-arguments item to {}, as the captured in_progress item carries', () => {
    const item: any = { type: 'function_call', name: TOOL_SEARCH_TOOL_NAME, arguments: '' };
    expect(restoreToolSearchCall(item)).toBe(true);
    expect(item.arguments).toEqual({});
  });

  it('degrades unparseable arguments to {} rather than throwing', () => {
    const item: any = { type: 'function_call', name: TOOL_SEARCH_TOOL_NAME, arguments: '{"query":' };
    expect(restoreToolSearchCall(item)).toBe(true);
    expect(item.arguments).toEqual({});
  });

  it('does not overwrite an execution the model already set', () => {
    const item: any = { type: 'function_call', name: TOOL_SEARCH_TOOL_NAME, arguments: '{}', execution: 'server' };
    restoreToolSearchCall(item);
    expect(item.execution).toBe('server');
  });

  it('leaves any other function call completely alone', () => {
    const item: any = { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' };
    expect(restoreToolSearchCall(item)).toBe(false);
    expect(item.type).toBe('function_call');
    expect(item.arguments).toBe('{"cmd":"ls"}');
  });

  it('counts restorations across an output array and tolerates a non-array', () => {
    const output = [
      { type: 'message' },
      { type: 'function_call', name: TOOL_SEARCH_TOOL_NAME, arguments: '{"query":"x"}' },
      { type: 'function_call', name: 'exec_command', arguments: '{}' },
    ];
    expect(restoreToolSearchItems(output)).toBe(1);
    expect((output[1] as any).type).toBe('tool_search_call');
    expect((output[2] as any).type).toBe('function_call');
    expect(restoreToolSearchItems(undefined)).toBe(0);
  });
});
