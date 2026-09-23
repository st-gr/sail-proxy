import { evaluate, decideInvoked, deniedBy } from '../src/toolGovernance/evaluate';
import type { ToolPolicyBlock } from '../src/toolGovernance/identity';

const block = (o: Partial<ToolPolicyBlock>): ToolPolicyBlock => ({ policyId: 'p1', policyName: 'Default', mode: 'monitor', allow: [], deny: [], ...o });

describe('deniedBy', () => {
  it('deny beats allow; empty allow means everything not denied', () => {
    expect(deniedBy(block({}), 'function:a')).toBe(false);
    expect(deniedBy(block({ deny: ['function:a'] }), 'function:a')).toBe(true);
    expect(deniedBy(block({ allow: ['function:a'], deny: ['function:a'] }), 'function:a')).toBe(true);
    expect(deniedBy(block({ allow: ['function:a'] }), 'function:b')).toBe(true);
    expect(deniedBy(block({ allow: ['function:*'] }), 'function:b')).toBe(false);
  });
});

describe('evaluate', () => {
  const declared = ['function:a', 'function:b', 'mcp:github'];
  it('fails open without any block', () => {
    const r = evaluate(declared, null, null, null);
    expect(r.mode).toBe('monitor');
    expect(r.reject).toBe(false);
    expect([...r.decisions.values()]).toEqual(['allowed', 'allowed', 'allowed']);
    expect(r.policyNames).toEqual([]);
  });
  it('monitor records denied identities as monitored and never rejects', () => {
    const r = evaluate(declared, block({ deny: ['mcp:*'] }), null, null);
    expect(r.decisions.get('mcp:github')).toBe('monitored');
    expect(r.decisions.get('function:a')).toBe('allowed');
    expect(r.blocked).toEqual([]);
    expect(r.reject).toBe(false);
  });
  it('strip lists denied identities as blocked', () => {
    const r = evaluate(declared, block({ mode: 'strip', allow: ['function:*'] }), null, null);
    expect(r.decisions.get('mcp:github')).toBe('stripped');
    expect(r.blocked).toEqual(['mcp:github']);
    expect(r.reject).toBe(false);
  });
  it('strip rejects when tool_choice forces a stripped tool', () => {
    const r = evaluate(declared, block({ mode: 'strip', deny: ['function:b'] }), null, 'function:b');
    expect(r.reject).toBe(true);
    expect(r.reason).toMatch(/tool_choice/);
    expect(r.decisions.get('function:b')).toBe('rejected');
  });
  it('reject rejects the request on any denied identity', () => {
    const r = evaluate(declared, block({ mode: 'reject', deny: ['function:a'] }), null, null);
    expect(r.reject).toBe(true);
    expect(r.decisions.get('function:a')).toBe('rejected');
    expect(r.decisions.get('function:b')).toBe('allowed');
  });
  it('merges user and key policies: both must allow, stricter mode wins', () => {
    const user = block({ policyName: 'U', mode: 'monitor', allow: ['function:*', 'mcp:*'] });
    const key = block({ policyId: 'k', policyName: 'K', mode: 'strip', deny: ['mcp:github'] });
    const r = evaluate(declared, user, key, null);
    expect(r.mode).toBe('strip');
    expect(r.decisions.get('mcp:github')).toBe('stripped');
    expect(r.decisions.get('function:a')).toBe('allowed');
    expect(r.policyNames).toEqual(['U', 'K']);
  });
  it('does not reject on an empty declaration', () => {
    expect(evaluate([], block({ mode: 'reject', deny: ['function:*'] }), null, null).reject).toBe(false);
  });
});

describe('decideInvoked', () => {
  it('follows the declared decision, unlisted otherwise', () => {
    const r = evaluate(['function:a', 'function:b'], block({ mode: 'strip', deny: ['function:b'] }), null, null);
    expect(decideInvoked(r, 'function:a')).toBe('allowed');
    expect(decideInvoked(r, 'function:b')).toBe('stripped');
    expect(decideInvoked(r, 'function:zzz')).toBe('unlisted');
  });
});
