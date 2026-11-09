/**
 * Scoped allow lists (spec 2026-09-22 §2). An allow pattern `mcp:<server>/<tool>` limits that
 * server's tools and nothing else; every other allow pattern is global and keeps today's meaning
 * (empty allows everything, non-empty requires a match). Deny still beats every allow.
 */
import { deniedBy, evaluate, serverLimit } from '../src/toolGovernance/evaluate';
import { mcpServerOnly, mcpToolServer, scopedServerOf } from '../src/toolGovernance/identity';
import type { ToolPolicyBlock } from '../src/toolGovernance/identity';

const block = (over: Partial<ToolPolicyBlock> = {}): ToolPolicyBlock =>
  ({ policyId: 'p1', policyName: 'Scoped', mode: 'strip', allow: [], deny: [], ...over });

describe('scope helpers', () => {
  it('a pattern is scoped only with a literal server and a tool part', () => {
    expect(scopedServerOf('mcp:github/get_issue')).toBe('github');
    expect(scopedServerOf('mcp:github/get_*')).toBe('github');
    expect(scopedServerOf('mcp:github/*')).toBe('github');
    expect(scopedServerOf('mcp:github')).toBeNull();
    expect(scopedServerOf('mcp:git*')).toBeNull();
    expect(scopedServerOf('mcp:*')).toBeNull();
    expect(scopedServerOf('function:shell')).toBeNull();
  });
  it('tells a server tool from a bare server', () => {
    expect(mcpToolServer('mcp:github/get_issue')).toBe('github');
    expect(mcpToolServer('mcp:github')).toBeNull();
    expect(mcpServerOnly('mcp:github')).toBe('github');
    expect(mcpServerOnly('mcp:github/get_issue')).toBeNull();
    expect(mcpServerOnly('function:x')).toBeNull();
  });
});

describe('deniedBy with scoped allows', () => {
  it('a policy made only of scoped allows limits that server and nothing else', () => {
    const b = block({ allow: ['mcp:github/get_issue'] });
    expect(deniedBy(b, 'mcp:github/get_issue')).toBe(false);
    expect(deniedBy(b, 'mcp:github/delete_repo')).toBe(true);
    expect(deniedBy(b, 'mcp:jira/create_ticket')).toBe(false);
    expect(deniedBy(b, 'function:shell')).toBe(false);
    expect(deniedBy(b, 'hosted:web_search')).toBe(false);
    expect(deniedBy(b, 'mcp:github')).toBe(false);
  });
  it('global allows still restrict everything that no scoped allow covers', () => {
    const b = block({ allow: ['mcp:github/get_issue', 'function:read'] });
    expect(deniedBy(b, 'mcp:github/get_issue')).toBe(false);
    expect(deniedBy(b, 'function:read')).toBe(false);
    expect(deniedBy(b, 'function:shell')).toBe(true);
    expect(deniedBy(b, 'mcp:jira/create_ticket')).toBe(true);
  });
  it('mcp:<server>/* allows every tool of that server', () => {
    const b = block({ allow: ['mcp:github/*'] });
    expect(deniedBy(b, 'mcp:github/delete_repo')).toBe(false);
    expect(deniedBy(b, 'function:shell')).toBe(false);
  });
  it('a prefix scoped allow matches by prefix', () => {
    const b = block({ allow: ['mcp:github/get_*'] });
    expect(deniedBy(b, 'mcp:github/get_issue')).toBe(false);
    expect(deniedBy(b, 'mcp:github/delete_repo')).toBe(true);
  });
  it('deny beats a scoped allow', () => {
    expect(deniedBy(block({ allow: ['mcp:github/get_issue'], deny: ['mcp:github/get_issue'] }), 'mcp:github/get_issue')).toBe(true);
  });
  it('without any scoped allow the rule is exactly the old one', () => {
    expect(deniedBy(block({ allow: [] }), 'function:x')).toBe(false);
    expect(deniedBy(block({ allow: ['function:a'] }), 'function:b')).toBe(true);
    expect(deniedBy(block({ allow: ['mcp:github'] }), 'mcp:github/get_issue')).toBe(true);
  });
});

describe('serverLimit', () => {
  it('names, prefix, or unlimited', () => {
    expect(serverLimit(block({ allow: ['mcp:github/get_issue', 'mcp:github/list_issues'] }), 'github')).toEqual(['get_issue', 'list_issues']);
    expect(serverLimit(block({ allow: ['mcp:github/get_*'] }), 'github')).toBe('prefix');
    expect(serverLimit(block({ allow: ['mcp:github/*', 'mcp:github/get_issue'] }), 'github')).toBeNull();
    expect(serverLimit(block({ allow: ['function:x'] }), 'github')).toBeNull();
  });
});

describe('evaluate narrows a bare server declaration', () => {
  const limited = block({ allow: ['mcp:github/get_issue', 'mcp:github/list_issues'] });
  it('strip: the server stays, narrowed to the listed tools', () => {
    const r = evaluate(['mcp:github', 'function:read'], limited, null, null);
    expect(r.narrow.get('github')).toEqual(['get_issue', 'list_issues']);
    expect(r.decisions.get('mcp:github')).toBe('stripped');
    expect(r.decisions.get('function:read')).toBe('allowed');
    expect(r.blocked).toEqual([]);
    expect(r.reject).toBe(false);
  });
  it('a key policy narrows its owner further (intersection)', () => {
    const r = evaluate(['mcp:github'], limited, block({ allow: ['mcp:github/get_issue'] }), null);
    expect(r.narrow.get('github')).toEqual(['get_issue']);
  });
  it('a prefix cannot be rendered as names: recorded monitored, nothing narrowed', () => {
    const r = evaluate(['mcp:github'], block({ allow: ['mcp:github/get_*'] }), null, null);
    expect(r.narrow.size).toBe(0);
    expect(r.decisions.get('mcp:github')).toBe('monitored');
  });
  it('reject: the bare server would expose unlisted tools, so the request is refused', () => {
    const r = evaluate(['mcp:github'], block({ mode: 'reject', allow: ['mcp:github/get_issue'] }), null, null);
    expect(r.reject).toBe(true);
    expect(r.reason).toContain('mcp:github');
    expect(r.decisions.get('mcp:github')).toBe('rejected');
  });
  it('monitor: recorded, nothing narrowed', () => {
    const r = evaluate(['mcp:github'], block({ mode: 'monitor', allow: ['mcp:github/get_issue'] }), null, null);
    expect(r.narrow.size).toBe(0);
    expect(r.decisions.get('mcp:github')).toBe('monitored');
  });
  it('mcp:<server>/* is unlimited: allowed and not narrowed', () => {
    const r = evaluate(['mcp:github'], block({ allow: ['mcp:github/*'] }), null, null);
    expect(r.narrow.size).toBe(0);
    expect(r.decisions.get('mcp:github')).toBe('allowed');
  });
  it('without any policy there is nothing to narrow', () => {
    expect(evaluate(['mcp:github'], null, null, null).narrow.size).toBe(0);
  });
});
