/**
 * The trust chain (spec 2026-09-22 §3.3): once a request carries output from an untrusted source,
 * every declared sensitive tool is treated as denied under the merged mode, with reason trust_chain.
 */
import { evaluate } from '../src/toolGovernance/evaluate';
import { stripNotice, STRIP_NOTICE_MARKER } from '../src/toolGovernance/stripNotice';
import { policyBlocksFromRequest, toolGovernance } from '../src/toolGovernance/middleware';
import { responsesAdapter } from '../src/toolGovernance/adapters/responses';
import type { ToolPolicyBlock } from '../src/toolGovernance/identity';

jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitToolNotEntitled: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/services/configService', () => ({ getTrustForwardedFor: () => false, getConfig: () => ({}) }));

const block = (over: Partial<ToolPolicyBlock> = {}): ToolPolicyBlock => ({
  policyId: 'p1', policyName: 'Trust', mode: 'strip', allow: [], deny: [],
  sensitive: ['function:shell', 'mcp:mail/send*'], untrusted: ['hosted:web_search', 'mcp:browser/*'], ...over
});
const declared = ['function:shell', 'function:read', 'mcp:mail/send_message'];

describe('trust chain in evaluate', () => {
  it('no untrusted source: nothing changes', () => {
    const r = evaluate(declared, block(), null, null, ['function:read']);
    expect(r.taintedBy).toEqual([]);
    expect([...r.decisions.values()]).toEqual(['allowed', 'allowed', 'allowed']);
  });
  it('strip: sensitive tools are stripped with reason trust_chain; others stay', () => {
    const r = evaluate(declared, block(), null, null, ['mcp:browser/fetch', 'function:read']);
    expect(r.taintedBy).toEqual(['mcp:browser/fetch']);
    expect(r.blocked.sort()).toEqual(['function:shell', 'mcp:mail/send_message']);
    expect(r.decisions.get('function:read')).toBe('allowed');
    expect(r.reasons.get('function:shell')).toBe('trust_chain');
    expect(r.reject).toBe(false);
  });
  it('monitor: recorded as monitored with the reason, nothing stripped', () => {
    const r = evaluate(declared, block({ mode: 'monitor' }), null, null, ['hosted:web_search']);
    expect(r.decisions.get('function:shell')).toBe('monitored');
    expect(r.reasons.get('function:shell')).toBe('trust_chain');
    expect(r.blocked).toEqual([]);
  });
  it('reject: refused, and the reason names the source', () => {
    const r = evaluate(declared, block({ mode: 'reject' }), null, null, ['hosted:web_search']);
    expect(r.reject).toBe(true);
    expect(r.reason).toContain('contains content from hosted:web_search');
  });
  it('a mixed refusal names both reasons', () => {
    const r = evaluate(['function:rm', 'function:shell'], block({ mode: 'reject', deny: ['function:rm'] }), null, null, ['hosted:web_search']);
    expect(r.reasons.get('function:rm')).toBe('policy');
    expect(r.reasons.get('function:shell')).toBe('trust_chain');
    expect(r.reason).toContain('tools not permitted by policy: function:rm');
    expect(r.reason).toContain('contains content from hosted:web_search: function:shell');
  });
  it('labels merge by union across user and key', () => {
    const r = evaluate(['function:deploy'], block({ sensitive: [] }), block({ policyId: 'k', sensitive: ['function:deploy'], untrusted: [] }), null, ['mcp:browser/fetch']);
    expect(r.blocked).toEqual(['function:deploy']);
  });
  it('forcing a withheld tool turns strip into a rejection', () => {
    const r = evaluate(declared, block(), null, 'function:shell', ['mcp:browser/fetch']);
    expect(r.reject).toBe(true);
    expect(r.reason).toContain('withheld while the conversation contains content from mcp:browser/fetch');
  });
  it('a block without labels (older admin) never taints', () => {
    const r = evaluate(declared, { policyId: 'p', policyName: 'Old', mode: 'strip', allow: [], deny: [] }, null, null, ['hosted:web_search']);
    expect(r.taintedBy).toEqual([]);
    expect(r.blocked).toEqual([]);
  });
  it('policy denials carry reason policy', () => {
    const r = evaluate(['function:rm'], block({ deny: ['function:rm'] }), null, null, []);
    expect(r.reasons.get('function:rm')).toBe('policy');
  });
});

/**
 * A bare `mcp:<server>` declaration exposes every tool of the server without naming one, so the
 * trust chain cannot find a sensitive tool among its declared identities. A narrowed server loses
 * its sensitive names; an un-narrowed one is withheld whole when a sensitive pattern names the server.
 */
describe('trust chain and a bare MCP server', () => {
  const mail = (over: Partial<ToolPolicyBlock> = {}) => block({ sensitive: ['mcp:mail/send*'], ...over });
  const tainted = ['hosted:web_search'];
  it('a narrowed server loses its sensitive names', () => {
    const r = evaluate(['mcp:mail'], mail({ allow: ['mcp:mail/send', 'mcp:mail/read'] }), null, null, tainted);
    expect(r.narrow.get('mail')).toEqual(['read']);
    expect(r.reasons.get('mcp:mail')).toBe('trust_chain');
    expect(r.decisions.get('mcp:mail')).toBe('stripped');
    expect(r.blocked).toEqual([]);
  });
  it('a narrowed server whose only names are sensitive is narrowed to nothing', () => {
    const r = evaluate(['mcp:mail'], mail({ allow: ['mcp:mail/send'] }), null, null, tainted);
    expect(r.narrow.get('mail')).toEqual([]);
    expect(r.reasons.get('mcp:mail')).toBe('trust_chain');
  });
  it('an un-narrowed bare server a sensitive pattern names is withheld', () => {
    const r = evaluate(['mcp:mail'], mail(), null, null, tainted);
    expect(r.blocked).toEqual(['mcp:mail']);
    expect(r.reasons.get('mcp:mail')).toBe('trust_chain');
    expect(r.decisions.get('mcp:mail')).toBe('stripped');
  });
  it('prefix patterns covering the server withhold it too', () => {
    for (const p of ['mcp:*', 'mcp:ma*', 'mcp:mail/*', 'mcp:mail']) {
      expect(evaluate(['mcp:mail'], mail({ sensitive: [p] }), null, null, tainted).blocked).toEqual(['mcp:mail']);
    }
  });
  it('a bare server no sensitive pattern names stays allowed', () => {
    const r = evaluate(['mcp:jira'], mail({ sensitive: ['mcp:mail/*'] }), null, null, tainted);
    expect(r.decisions.get('mcp:jira')).toBe('allowed');
    expect(r.blocked).toEqual([]);
  });
  it('without an untrusted source nothing changes', () => {
    const bare = evaluate(['mcp:mail'], mail(), null, null, ['function:read']);
    expect(bare.decisions.get('mcp:mail')).toBe('allowed');
    const narrowed = evaluate(['mcp:mail'], mail({ allow: ['mcp:mail/send', 'mcp:mail/read'] }), null, null, []);
    expect(narrowed.narrow.get('mail')).toEqual(['send', 'read']);
    expect(narrowed.reasons.has('mcp:mail')).toBe(false);
  });
  it('monitor: recorded as monitored with reason trust_chain, nothing blocked', () => {
    const r = evaluate(['mcp:mail'], mail({ mode: 'monitor' }), null, null, tainted);
    expect(r.decisions.get('mcp:mail')).toBe('monitored');
    expect(r.reasons.get('mcp:mail')).toBe('trust_chain');
    expect(r.blocked).toEqual([]);
  });
  it('reject: refused with the trust wording', () => {
    const r = evaluate(['mcp:mail'], mail({ mode: 'reject' }), null, null, tainted);
    expect(r.reject).toBe(true);
    expect(r.reason).toBe('tools not permitted while the conversation contains content from hosted:web_search: mcp:mail');
  });
  it('strip: forcing the withheld server is a rejection with the trust wording', () => {
    const r = evaluate(['mcp:mail'], mail(), null, 'mcp:mail', tainted);
    expect(r.reject).toBe(true);
    expect(r.reason).toContain('withheld while the conversation contains content from hosted:web_search');
  });
  it('middleware: a Responses bare mcp entry is removed after an untrusted result', () => {
    const req: any = {
      body: { model: 'gpt', tools: [{ type: 'mcp', server_label: 'mail', server_url: 'https://mcp.example.invalid' }], input: [
        { type: 'function_call', call_id: 'f1', name: 'fetch_page', arguments: '{}' },
        { type: 'function_call_output', call_id: 'f1', output: 'page' }
      ] },
      get: () => undefined, originalUrl: '/openai/v1/responses', method: 'POST',
      unifiedAuth: { authType: 'api_key', data: { keyId: 'k1', toolPolicy: mail({ untrusted: ['function:fetch_page'] }) } }
    };
    const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const next = jest.fn();
    toolGovernance(responsesAdapter)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body.tools).toBeUndefined();
    expect(req.toolGovernance.result.reasons.get('mcp:mail')).toBe('trust_chain');
  });
});

describe('notice with sources', () => {
  it('names the sources, sorted, and keeps the marker', () => {
    const text = stripNotice(['function:shell'], ['mcp:browser/fetch', 'hosted:web_search']);
    expect(text).toContain(STRIP_NOTICE_MARKER);
    expect(text).toContain('content from hosted:web_search, mcp:browser/fetch');
    expect(stripNotice(['function:shell'])).not.toContain('content from');
  });
});

describe('policyBlocksFromRequest', () => {
  it('keeps label lists and tolerates malformed ones', () => {
    const good = block();
    const bad = { ...block(), sensitive: 'function:shell' };
    const r = policyBlocksFromRequest({ unifiedAuth: { data: { toolPolicy: good, keyToolPolicy: bad } } });
    expect(r.user?.sensitive).toEqual(['function:shell', 'mcp:mail/send*']);
    expect(r.key?.sensitive).toEqual([]);
  });
});
