/**
 * The Bedrock adapter (spec 2026-09-22 §4): Converse bodies natively, Anthropic-shaped invoke bodies
 * by delegation, anything else passes through without tools.
 */
import { bedrockAdapter } from '../src/toolGovernance/adapters/bedrock';
import { toolGovernance } from '../src/toolGovernance/middleware';

jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitToolNotEntitled: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/services/configService', () => ({ getTrustForwardedFor: () => false, getConfig: () => ({}) }));

const converse = () => ({
  system: [{ text: 'be brief' }],
  messages: [{ role: 'user', content: [{ text: 'hi' }] }],
  toolConfig: { tools: [{ toolSpec: { name: 'shell', inputSchema: { json: {} } } }, { toolSpec: { name: 'read', inputSchema: { json: {} } } }], toolChoice: { tool: { name: 'shell' } } }
});

describe('Converse', () => {
  it('declares, forces, strips and notes', () => {
    expect(bedrockAdapter.declaredTools(converse())).toEqual(['function:shell', 'function:read']);
    expect(bedrockAdapter.forcedTool(converse())).toBe('function:shell');
    const out = bedrockAdapter.stripTools(converse(), new Set(['function:shell']));
    expect(out.toolConfig.tools.map((t: any) => t.toolSpec.name)).toEqual(['read']);
    expect(out.toolConfig).not.toHaveProperty('toolChoice');
    expect(bedrockAdapter.stripTools(converse(), new Set(['function:shell', 'function:read']))).not.toHaveProperty('toolConfig');
    const noted = bedrockAdapter.noteStrippedTools(converse(), ['function:shell']);
    expect(noted.system).toHaveLength(2);
    expect(bedrockAdapter.noteStrippedTools(noted, ['function:shell']).system).toHaveLength(2);
  });
  it('pairs toolResult with toolUse', () => {
    const body = { messages: [
      { role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: 'fetch_page', input: { url: 'x' } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'u1', content: [{ text: 'page' }] } }, { toolResult: { toolUseId: 'u9', content: [] } }] }
    ] };
    expect(bedrockAdapter.resultSources(body).map((s) => s.identity)).toEqual(['function:fetch_page', 'function:<unknown>']);
  });
  it('stringifies a toolUse input only when its args are read', () => {
    let stringified = 0;
    const input = { url: 'x', toJSON() { stringified++; return { url: 'x' }; } };
    const out = bedrockAdapter.resultSources({ messages: [
      { role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: 'fetch_page', input } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'u1', content: [] } }] }
    ] });
    expect(stringified).toBe(0);
    expect((out[0].args as () => string)()).toBe('{"url":"x"}');
  });
  it('refuses rather than strips every tool from a conversation that already used tools', () => {
    const body = { ...converse(), messages: [{ role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: 'read', input: {} } }] }] };
    expect(bedrockAdapter.stripRefusal!(body, new Set(['function:shell', 'function:read']))).toContain('already used tools');
    expect(bedrockAdapter.stripRefusal!(body, new Set(['function:shell']))).toBeNull();
    expect(bedrockAdapter.stripRefusal!(converse(), new Set(['function:shell', 'function:read']))).toBeNull();
  });
  it('invoked tools from a response and from native stream events; the auto-detected placeholder is ignored', () => {
    expect(bedrockAdapter.invokedTools({ output: { message: { content: [{ text: 'x' }, { toolUse: { toolUseId: 'u', name: 'read', input: {} } }] } } })).toEqual(['function:read']);
    expect(bedrockAdapter.invokedToolsFromChunk({ contentBlockStart: { start: { toolUse: { toolUseId: 'u', name: 'read' } } } })).toEqual(['function:read']);
    const sse = 'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"read","input":{}}}\n\n'
      + 'data: {"contentBlockStart":{"start":{"toolUse":{"toolUseId":"u","name":"shell"}}}}\n\n'
      + 'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"a","name":"auto_detected_tool","input":{}}}\n\n';
    expect(bedrockAdapter.invokedToolsFromStream(sse)).toEqual(['function:read', 'function:shell']);
  });
});

describe('Anthropic invoke bodies delegate', () => {
  const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 10, tools: [{ name: 'shell', input_schema: {} }], messages: [] };
  it('declares and strips like the Anthropic adapter', () => {
    expect(bedrockAdapter.declaredTools(body)).toEqual(['function:shell']);
    expect(bedrockAdapter.stripTools(body, new Set(['function:shell']))).not.toHaveProperty('tools');
    expect(bedrockAdapter.invokedTools({ content: [{ type: 'tool_use', id: 't', name: 'shell', input: {} }] })).toEqual(['function:shell']);
  });
  it('other invoke bodies declare nothing and pass through', () => {
    const nova = { messages: [{ role: 'user', content: [{ text: 'hi' }] }], inferenceConfig: { maxTokens: 10 } };
    expect(bedrockAdapter.declaredTools(nova)).toEqual([]);
    expect(bedrockAdapter.stripTools(nova, new Set(['function:x']))).toEqual(nova);
  });
});

describe('refusal shape through the middleware', () => {
  function makeRes() { const r: any = { statusCode: 0, headers: {} }; r.status = (c: number) => { r.statusCode = c; return r; }; r.set = (k: string, v: string) => { r.headers[k] = v; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; }
  const req = (mode: string, b: any) => ({ body: b, get: () => 'aws-sdk-js/3', originalUrl: '/model/x/converse', method: 'POST',
    unifiedAuth: { authType: 'aws_credential', data: { credentialId: 'c1', toolPolicy: { policyId: 'p', policyName: 'Team', mode, allow: [], deny: ['function:*'] } } } }) as any;
  it('a reject is a 403 AccessDeniedException', () => {
    const res = makeRes();
    toolGovernance(bedrockAdapter)(req('reject', converse()), res, jest.fn());
    expect(res.statusCode).toBe(403);
    expect(res.headers['x-amzn-ErrorType']).toBe('AccessDeniedException');
    expect(typeof res.body.message).toBe('string');
  });
  it('a strip that would empty a tool conversation is refused the same way', () => {
    const res = makeRes(); const next = jest.fn();
    // No toolChoice here (unlike converse()): a forced tool that the policy also strips is already
    // rejected by evaluate()'s own forced-tool rule, under a different reason - this test is about
    // the Bedrock-specific rule (an already-tool-using conversation with nothing left to call).
    const b = { system: converse().system, toolConfig: { tools: converse().toolConfig.tools },
      messages: [{ role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: 'read', input: {} } }] }] };
    toolGovernance(bedrockAdapter)(req('strip', b), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toContain('already used tools');
  });
});
