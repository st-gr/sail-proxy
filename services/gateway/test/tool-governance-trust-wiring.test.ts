/**
 * The trust chain end to end inside the gateway (spec 2026-09-22 §3.3-§3.4): sources normalised with
 * the client's convention, container results expanded to their nested MCP calls, the notice, the
 * event's reason and sources, the usage fold, and the call gate.
 */
import { toolGovernance } from '../src/toolGovernance/middleware';
import { toolsForEvent, recordInvokedTools, gateContext, recordNestedTools } from '../src/toolGovernance/record';
import { anthropicAdapter } from '../src/toolGovernance/adapters/anthropic';
import { responsesAdapter } from '../src/toolGovernance/adapters/responses';
import { deniedNestedIn } from '../src/toolGovernance/callGate';
import securityEventEmitter from '../src/services/securityEventEmitter';

jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitToolNotEntitled: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/services/configService', () => ({ getTrustForwardedFor: () => false, getConfig: () => ({}) }));

const emit = securityEventEmitter.emitToolNotEntitled as jest.Mock;
const policy = (mode: string, over: any = {}) => ({ policyId: 'p', policyName: 'Trust', mode, allow: [], deny: [],
  sensitive: ['function:Bash', 'mcp:mail/*'], untrusted: ['mcp:browser/*', 'hosted:web_search'], ...over });
function makeRes() { const r: any = { statusCode: 0 }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; }
const claudeReq = (p: any) => ({
  body: { model: 'claude', system: 'be brief', tools: [{ name: 'Bash', input_schema: {} }, { name: 'Read', input_schema: {} }], messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__browser__fetch', input: { url: 'https://example.invalid' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'page' }] }
  ] },
  get: (h: string) => (h === 'user-agent' ? 'claude-cli/2.0.1' : undefined), originalUrl: '/anthropic/v1/messages', method: 'POST',
  unifiedAuth: { authType: 'api_key', data: { keyId: 'k1', toolPolicy: p } }
}) as any;

beforeEach(() => emit.mockClear());

describe('middleware with the trust chain', () => {
  it('strip: Bash is removed after a browser result, the notice names the source, the event says trust_chain', () => {
    const req = claudeReq(policy('strip')); const next = jest.fn();
    toolGovernance(anthropicAdapter)(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.body.tools.map((t: any) => t.name)).toEqual(['Read']);
    expect(req.body.system).toContain('content from mcp:browser/fetch');
    expect(emit.mock.calls[0][0]).toMatchObject({ mode: 'strip', reason: 'trust_chain', sources: ['mcp:browser/fetch'], identities: ['function:Bash'] });
  });
  it('the usage fold records the reason and the sources', () => {
    const req = claudeReq(policy('strip'));
    toolGovernance(anthropicAdapter)(req, makeRes(), jest.fn());
    recordInvokedTools(req, ['function:Read']);
    const tools = toolsForEvent(req)!;
    expect(tools).toContainEqual({ identity: 'function:Bash', facet: 'declared', count: 1, decision: 'stripped', reason: 'trust_chain' });
    expect(tools).toContainEqual({ identity: 'mcp:browser/fetch', facet: 'source', count: 1, decision: 'allowed' });
    expect(tools.find((t) => t.identity === 'function:Read' && t.facet === 'declared')).not.toHaveProperty('reason');
  });
  it('reject with a mixed denial: 403, both reasons in the message, event reason mixed', () => {
    const req = claudeReq(policy('reject', { deny: ['function:Read'] })); const res = makeRes(); const next = jest.fn();
    toolGovernance(anthropicAdapter)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.message).toContain('tools not permitted by policy: function:Read');
    expect(res.body.error.message).toContain('contains content from mcp:browser/fetch: function:Bash');
    expect(emit.mock.calls[0][0]).toMatchObject({ mode: 'reject', reason: 'mixed' });
    expect(emit.mock.calls[0][0].tools).toContainEqual({ identity: 'function:Bash', facet: 'declared', decision: 'rejected', reason: 'trust_chain' });
  });
  it('a non-container call\'s input is never stringified', () => {
    let stringified = 0;
    const req = claudeReq(policy('strip'));
    req.body.messages[0].content[0].input = { url: 'https://example.invalid', toJSON() { stringified++; return {}; } };
    toolGovernance(anthropicAdapter)(req, makeRes(), jest.fn());
    expect(req.toolGovernance.result.taintedBy).toEqual(['mcp:browser/fetch']);
    expect(stringified).toBe(0);
  });
  it('no untrusted result: nothing withheld, no event', () => {
    const req = claudeReq(policy('strip')); req.body.messages = [];
    toolGovernance(anthropicAdapter)(req, makeRes(), jest.fn());
    expect(req.body.tools).toHaveLength(2);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('container results and the call gate', () => {
  const codexReq = (p: any) => ({
    body: { model: 'gpt', tools: [{ type: 'custom', name: 'exec' }], input: [
      { type: 'custom_tool_call', call_id: 'x1', name: 'exec', input: 'const page = await tools.mcp__browser__fetch({})' },
      { type: 'custom_tool_call_output', call_id: 'x1', output: 'page' }
    ] },
    get: (h: string) => (h === 'user-agent' ? 'codex-tui/0.40' : undefined), originalUrl: '/openai/v1/responses', method: 'POST',
    unifiedAuth: { authType: 'api_key', data: { keyId: 'k1', toolPolicy: p } }
  }) as any;
  it('a nested browser call inside a replayed exec counts as a source, and the gate then refuses a nested mail call', () => {
    const req = codexReq(policy('strip', { sensitive: ['mcp:mail/*'] }));
    toolGovernance(responsesAdapter)(req, makeRes(), jest.fn());
    expect(req.toolGovernance.result.taintedBy).toEqual(['mcp:browser/fetch']);
    const ctx = gateContext(req)!;
    const call = { type: 'function_call', name: 'exec', arguments: 'await tools.mcp__mail__send({to:"alex@example.invalid"})' };
    expect(deniedNestedIn(call, ctx.convention, ctx.blocks)).toEqual(['mcp:mail/send']);
    recordNestedTools(req, ['mcp:mail/send']);
    expect(toolsForEvent(req)).toContainEqual({ identity: 'mcp:mail/send', facet: 'invoked', count: 1, decision: 'detected' });
  });
  it('without a taint the same nested call passes the gate', () => {
    const req = codexReq(policy('strip', { sensitive: ['mcp:mail/*'] })); req.body.input = [];
    toolGovernance(responsesAdapter)(req, makeRes(), jest.fn());
    const ctx = gateContext(req)!;
    expect(deniedNestedIn({ type: 'function_call', name: 'exec', arguments: 'tools.mcp__mail__send({})' }, ctx.convention, ctx.blocks)).toEqual([]);
  });
  /**
   * Monitor never refuses a call (2026-09-18 host-executed spec): the same taint that strips under
   * Strip mode must leave the gate empty under Monitor, so the nested call passes - it is still
   * recorded `detected`, because recordNestedTools judges every mode against effectiveBlocks.
   */
  it('monitor + trust chain: the gate passes the nested call and still records it detected', () => {
    const req = codexReq(policy('monitor', { sensitive: ['mcp:mail/*'] }));
    toolGovernance(responsesAdapter)(req, makeRes(), jest.fn());
    expect(req.toolGovernance.result.taintedBy).toEqual(['mcp:browser/fetch']);
    const ctx = gateContext(req)!;
    expect(ctx.blocks).toEqual([]);
    const call = { type: 'function_call', name: 'exec', arguments: 'await tools.mcp__mail__send({to:"alex@example.invalid"})' };
    expect(deniedNestedIn(call, ctx.convention, ctx.blocks)).toEqual([]);
    recordNestedTools(req, ['mcp:mail/send']);
    expect(toolsForEvent(req)).toContainEqual({ identity: 'mcp:mail/send', facet: 'invoked', count: 1, decision: 'detected' });
  });
  it('monitor + plain policy deny: the gate passes the nested call and still records it detected', () => {
    const req = codexReq(policy('monitor', { deny: ['mcp:mail/*'] })); req.body.input = [];
    toolGovernance(responsesAdapter)(req, makeRes(), jest.fn());
    const ctx = gateContext(req)!;
    expect(ctx.blocks).toEqual([]);
    const call = { type: 'function_call', name: 'exec', arguments: 'await tools.mcp__mail__send({to:"alex@example.invalid"})' };
    expect(deniedNestedIn(call, ctx.convention, ctx.blocks)).toEqual([]);
    recordNestedTools(req, ['mcp:mail/send']);
    expect(toolsForEvent(req)).toContainEqual({ identity: 'mcp:mail/send', facet: 'invoked', count: 1, decision: 'detected' });
  });
});
