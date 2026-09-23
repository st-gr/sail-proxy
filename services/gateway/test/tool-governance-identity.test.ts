import { functionTool, hostedTool, hostedNamedTool, mcpServer, mcpTool, matches, matchesAny, resolveInvoked, PATTERN_SYNTAX, MODE_RANK } from '../src/toolGovernance/identity';

describe('tool identities', () => {
  it('builds namespaced identities', () => {
    expect(functionTool('jira_create')).toBe('function:jira_create');
    expect(hostedTool('web_search')).toBe('hosted:web_search');
    expect(hostedTool('web_search_20250305')).toBe('hosted:web_search');
    expect(hostedTool('computer_use_preview')).toBe('hosted:computer_use_preview');
    expect(mcpServer('github')).toBe('mcp:github');
    expect(mcpTool('github', 'create_issue')).toBe('mcp:github/create_issue');
    expect(hostedNamedTool('custom', 'exec')).toBe('hosted:custom/exec');
  });

  /**
   * The gateway rewrites a Responses request's hosted and custom tools into plain function tools
   * before it reaches SAP AI Core, so EVERY invocation comes back as a function call: a custom tool
   * declared as `exec` is invoked as `function:exec`, and a hosted `web_search` as
   * `function:web_search`. Without reconciliation each of those lands in the inventory as a second,
   * "unlisted" row instead of raising the counter of the tool that was actually declared - and its
   * decision is lost, because an unlisted identity carries no policy decision.
   */
  it('resolves an invoked function call onto the declared tool of the same name', () => {
    const declared = ['hosted:custom', 'hosted:custom/exec', 'function:wait', 'hosted:web_search'];
    expect(resolveInvoked('function:exec', declared)).toBe('hosted:custom/exec');
    expect(resolveInvoked('function:web_search', declared)).toBe('hosted:web_search');
    // an exact declaration always wins over a same-named one in another namespace
    expect(resolveInvoked('function:wait', declared)).toBe('function:wait');
    // nothing was declared under that name: it stays what the response said, and counts as unlisted
    expect(resolveInvoked('function:rm_rf', declared)).toBe('function:rm_rf');
    // ambiguity is never guessed
    expect(resolveInvoked('function:x', ['hosted:a/x', 'mcp:s/x'])).toBe('function:x');
    expect(resolveInvoked('mcp:s/x', ['hosted:a/x'])).toBe('mcp:s/x');
  });
  it('matches exact identities and trailing wildcards only', () => {
    expect(matches('function:jira_create', 'function:jira_create')).toBe(true);
    expect(matches('function:jira_create', 'function:jira_created')).toBe(false);
    expect(matches('function:jira_*', 'function:jira_create')).toBe(true);
    expect(matches('function:jira_*', 'function:jira_')).toBe(true);
    expect(matches('function:*', 'function:anything')).toBe(true);
    expect(matches('function:*', 'hosted:web_search')).toBe(false);
    expect(matches('mcp:github/*', 'mcp:github/create_issue')).toBe(true);
    expect(matches('mcp:github', 'mcp:github/create_issue')).toBe(false);
    expect(matches('Function:jira_create', 'function:jira_create')).toBe(false);
  });
  it('matchesAny over a list', () => {
    expect(matchesAny(['hosted:*', 'function:a'], 'function:a')).toBe(true);
    expect(matchesAny([], 'function:a')).toBe(false);
  });
  it('accepts only the documented pattern syntax', () => {
    for (const ok of ['function:x', 'hosted:web_search', 'mcp:github', 'mcp:github/*', 'function:jira_*', 'function:*', 'hosted:*', 'mcp:*']) expect(PATTERN_SYNTAX.test(ok)).toBe(true);
    for (const bad of ['x', 'function:', 'function:a*b', 'tool:x', 'function:a b', 'function:*a', 'mcp:*/*']) expect(PATTERN_SYNTAX.test(bad)).toBe(false);
  });
  it('ranks modes reject > strip > monitor', () => {
    expect(MODE_RANK.reject).toBeGreaterThan(MODE_RANK.strip);
    expect(MODE_RANK.strip).toBeGreaterThan(MODE_RANK.monitor);
  });
});
