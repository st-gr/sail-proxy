import { toolGovernance, policyBlocksFromRequest } from '../src/toolGovernance/middleware';
import { recordInvokedTools, toolsForEvent } from '../src/toolGovernance/record';
import { openaiChatAdapter } from '../src/toolGovernance/adapters/openaiChat';
import securityEventEmitter from '../src/services/securityEventEmitter';

jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitToolNotEntitled: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/services/configService', () => ({ getTrustForwardedFor: () => false }));

const policy = (mode: 'monitor' | 'strip' | 'reject', deny: string[] = []) => ({ policyId: 'p', policyName: 'Team', mode, allow: [], deny });
const body = () => ({ model: 'gpt', messages: [], tools: [{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'b' } }] });
function makeReq(user: any, key?: any, extra: any = {}) {
  return { body: body(), originalUrl: '/openai/v1/chat/completions', method: 'POST', get: () => 'jest', debugRequestId: 'r1',
    unifiedAuth: { authType: 'api_key', data: { keyId: 'k1', email: 'u@test.com', toolPolicy: user, keyToolPolicy: key } }, ...extra } as any;
}
function makeRes() { const r: any = { statusCode: 0, body: undefined }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; }

describe('policyBlocksFromRequest', () => {
  it('reads both blocks from unifiedAuth and tolerates their absence', () => {
    expect(policyBlocksFromRequest(makeReq(policy('monitor'), policy('strip')))).toEqual({
      user: { ...policy('monitor'), sensitive: [], untrusted: [] }, key: { ...policy('strip'), sensitive: [], untrusted: [] }
    });
    expect(policyBlocksFromRequest({ unifiedAuth: { data: {} } })).toEqual({ user: null, key: null });
    expect(policyBlocksFromRequest({ unifiedAuth: { data: { toolPolicy: { mode: 'nonsense' } } } }).user).toBeNull();
  });
  it('governs administrators too: a policy assigned to them, or to their key, binds', () => {
    const req = makeReq(policy('reject', ['function:*']));
    req.unifiedAuth.data.user = { email: 'u@test.com', status: 'active', roles: ['admin'], limits: {} };
    expect(policyBlocksFromRequest(req)).toEqual({ user: { ...policy('reject', ['function:*']), sensitive: [], untrusted: [] }, key: null });
    const res = makeRes(); const next = jest.fn();
    toolGovernance(openaiChatAdapter)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('toolGovernance middleware', () => {
  beforeEach(() => jest.clearAllMocks());
  it('monitor: passes the body untouched and records decisions', () => {
    const req = makeReq(policy('monitor', ['function:b'])); const res = makeRes(); const next = jest.fn();
    toolGovernance(openaiChatAdapter)(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body.tools).toHaveLength(2);
    expect(req.toolGovernance.result.decisions.get('function:b')).toBe('monitored');
    expect(securityEventEmitter.emitToolNotEntitled).not.toHaveBeenCalled();
  });
  it('strip: removes denied tools and emits one security event', () => {
    const req = makeReq(policy('strip', ['function:b'])); const res = makeRes(); const next = jest.fn();
    toolGovernance(openaiChatAdapter)(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body.tools).toEqual([{ type: 'function', function: { name: 'a' } }]);
    expect(securityEventEmitter.emitToolNotEntitled).toHaveBeenCalledTimes(1);
    expect((securityEventEmitter.emitToolNotEntitled as jest.Mock).mock.calls[0][0]).toMatchObject({ identities: ['function:b'], mode: 'strip', policy: 'Team', credentialId: 'k1', authType: 'api_key' });
    // strip lets the request run, so its usage event records the stripped tools: no tools here
    expect((securityEventEmitter.emitToolNotEntitled as jest.Mock).mock.calls[0][0].tools).toBeUndefined();
  });
  it('strip: the stripped request tells the model which tools were removed', () => {
    const req = makeReq(policy('strip', ['function:b']));
    req.body.messages = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }];
    const next = jest.fn();
    toolGovernance(openaiChatAdapter)(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body.tools).toEqual([{ type: 'function', function: { name: 'a' } }]);
    expect(req.body.messages[0].content).toContain('[tool policy]');
    expect(req.body.messages[0].content).toContain('function:b');
    expect(req.body.messages[0].content.startsWith('Be brief.')).toBe(true);
  });

  /**
   * Claude Code declares each of its locally hosted MCP tools as an ordinary tool named
   * `mcp__server__tool`. The middleware normalises that into `mcp:server/tool`, so a policy written
   * as `mcp:abap2ui5/*` governs it - and strip removes it from the request under the name the
   * client used, which is the only name the adapter can find in the body.
   */
  it('normalises a client-hosted MCP tool name and strips it under its original spelling', () => {
    const req = makeReq(policy('strip', ['mcp:abap2ui5/*']));
    req.body.tools = [
      { type: 'function', function: { name: 'mcp__abap2ui5__api_reference' } },
      { type: 'function', function: { name: 'Bash' } }
    ];
    req.headers = { 'user-agent': 'claude-cli/2.1.270 (external, cli)' };
    req.get = (h: string) => req.headers[h.toLowerCase()];
    toolGovernance(openaiChatAdapter)(req, makeRes(), jest.fn());
    expect(req.toolGovernance.declared).toEqual(['mcp:abap2ui5/api_reference', 'function:Bash']);
    expect(req.toolGovernance.result.decisions.get('mcp:abap2ui5/api_reference')).toBe('stripped');
    expect(req.body.tools).toEqual([{ type: 'function', function: { name: 'Bash' } }]);
  });

  it('reject: answers 403 in the family shape and does not call next', () => {
    const req = makeReq(policy('reject', ['function:a'])); const res = makeRes(); const next = jest.fn();
    toolGovernance(openaiChatAdapter)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('tool_not_entitled');
    expect(res.body.error.message).toContain('function:a');
    expect(res.body.error.message).toContain('Team');
    expect(securityEventEmitter.emitToolNotEntitled).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'reject', model: 'gpt',
      // a rejected request emits no usage event, so the refused identities ride the security event
      tools: [{ identity: 'function:a', facet: 'declared', decision: 'rejected', reason: 'policy' }]
    }));
  });
  it('fails open without a block and without tools', () => {
    const req = makeReq(undefined); const res = makeRes(); const next = jest.fn();
    toolGovernance(openaiChatAdapter)(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.toolGovernance.result.mode).toBe('monitor');
    const empty = makeReq(policy('reject', ['function:*']), undefined, { body: { model: 'gpt', messages: [] } }); const next2 = jest.fn();
    toolGovernance(openaiChatAdapter)(empty, makeRes(), next2);
    expect(next2).toHaveBeenCalledWith();
  });
  it('fails open when the adapter throws', () => {
    const broken = { ...openaiChatAdapter, declaredTools: () => { throw new Error('boom'); } };
    const req = makeReq(policy('reject', ['function:*'])); const res = makeRes(); const next = jest.fn();
    toolGovernance(broken)(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.toolGovernance).toBeUndefined();
  });
  it('reject: does not call next when the 403 send itself throws', () => {
    const req = makeReq(policy('reject', ['function:a']));
    const res: any = { status: () => res, json: () => { throw new Error('connection gone'); } };
    const next = jest.fn();
    expect(() => toolGovernance(openaiChatAdapter)(req, res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
  });
  it('fails open when stripTools throws', () => {
    const broken = { ...openaiChatAdapter, stripTools: () => { throw new Error('boom'); } };
    const req = makeReq(policy('strip', ['function:b'])); const res = makeRes(); const next = jest.fn();
    toolGovernance(broken)(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body.tools).toEqual([{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'b' } }]);
    expect(req.toolGovernance).toBeUndefined();
  });
});

describe('record', () => {
  it('collects invoked tools and folds declared and invoked entries for the usage event', () => {
    const req = makeReq(policy('strip', ['function:b'])); toolGovernance(openaiChatAdapter)(req, makeRes(), jest.fn());
    recordInvokedTools(req, ['function:a', 'function:a', 'function:zzz']);
    expect(toolsForEvent(req)).toEqual([
      { identity: 'function:a', facet: 'declared', count: 1, decision: 'allowed' },
      { identity: 'function:b', facet: 'declared', count: 1, decision: 'stripped', reason: 'policy' },
      { identity: 'function:a', facet: 'invoked', count: 2, decision: 'allowed' },
      { identity: 'function:zzz', facet: 'invoked', count: 1, decision: 'unlisted' }
    ]);
  });
  /**
   * The observed defect: codex declares its shell as a custom tool named `exec` and a hosted web
   * search, the gateway rewrites both into function tools for SAP AI Core, and the model's
   * invocations therefore arrive as `function:exec` / `function:web_search`. Recorded literally,
   * each became a SECOND inventory row marked "unlisted" while the declared row kept a count of
   * zero invocations - so the inventory said nothing about what was actually called.
   */
  it('records an invoked function call under the declaration it belongs to', () => {
    const req = makeReq(policy('strip', ['hosted:web_search']));
    req.body.tools = [{ type: 'function', function: { name: 'wait' } }];
    req.toolGovernance = undefined;
    toolGovernance(openaiChatAdapter)(req, makeRes(), jest.fn());
    req.toolGovernance.declared = ['hosted:custom', 'hosted:custom/exec', 'hosted:web_search', 'function:wait'];
    req.toolGovernance.result.decisions = new Map<string, any>([
      ['hosted:custom', 'allowed'], ['hosted:custom/exec', 'allowed'],
      ['hosted:web_search', 'stripped'], ['function:wait', 'allowed']
    ]);
    recordInvokedTools(req, ['function:exec', 'function:web_search', 'function:wait', 'function:rm_rf']);
    const invoked = toolsForEvent(req)!.filter((e) => e.facet === 'invoked');
    expect(invoked).toEqual([
      { identity: 'hosted:custom/exec', facet: 'invoked', count: 1, decision: 'allowed' },
      { identity: 'hosted:web_search', facet: 'invoked', count: 1, decision: 'stripped' },
      { identity: 'function:wait', facet: 'invoked', count: 1, decision: 'allowed' },
      { identity: 'function:rm_rf', facet: 'invoked', count: 1, decision: 'unlisted' }
    ]);
  });
  it('is a no-op on requests the middleware never saw', () => {
    const req: any = {}; recordInvokedTools(req, ['function:a']);
    expect(toolsForEvent(req)).toBeUndefined();
  });
});
