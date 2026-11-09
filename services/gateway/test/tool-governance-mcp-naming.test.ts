/**
 * MCP naming conventions (src/toolGovernance/mcpNaming.ts).
 *
 * A client that runs its own MCP servers does not send `{type:'mcp'}`. Measured on this gateway's
 * payload log on 2026-09-18: Claude Code declares each of them as an ordinary tool named
 * `mcp__server__tool` (40 distinct among 57 declared tools), while codex declares none of them and
 * reaches them through its `exec` container tool as `tools.mcp__server__tool`.
 *
 * Normalising that name into the identity the policy model already has - `mcp:server/tool` - is
 * what makes one pattern, `mcp:abap2ui5/*`, cover a locally hosted server and a remotely declared
 * one alike. The conventions are configuration, not code, so a new client is an api_config change.
 */
import { mcpIdentity, normaliseIdentity, conventionFor, nestedCallsIn, DEFAULT_MCP_NAMING } from '../src/toolGovernance/mcpNaming';

describe('mcpIdentity', () => {
  const naming = DEFAULT_MCP_NAMING;

  it('splits a client-normalised MCP tool name into server and tool', () => {
    expect(mcpIdentity('mcp__abap2ui5__api_reference', naming)).toBe('mcp:abap2ui5/api_reference');
    // the server ends at the first double underscore; single ones belong to the names
    expect(mcpIdentity('mcp__codex_apps__sites_create_site', naming)).toBe('mcp:codex_apps/sites_create_site');
    expect(mcpIdentity('mcp__ps_exec_remote__run_powershell', naming)).toBe('mcp:ps_exec_remote/run_powershell');
  });

  it('leaves anything that is not the convention alone', () => {
    for (const name of ['Bash', 'read', 'mcp__onlyserver', 'mcp____', 'exec_command', '']) {
      expect(mcpIdentity(name, naming)).toBeNull();
    }
  });
});

describe('normaliseIdentity', () => {
  it('rewrites a function identity that carries an MCP name, and nothing else', () => {
    expect(normaliseIdentity('function:mcp__abap2ui5__api_reference', DEFAULT_MCP_NAMING)).toBe('mcp:abap2ui5/api_reference');
    expect(normaliseIdentity('function:Bash', DEFAULT_MCP_NAMING)).toBe('function:Bash');
    expect(normaliseIdentity('hosted:web_search', DEFAULT_MCP_NAMING)).toBe('hosted:web_search');
    expect(normaliseIdentity('mcp:github/create_issue', DEFAULT_MCP_NAMING)).toBe('mcp:github/create_issue');
    // a container tool keeps its own identity; what runs inside it is found separately
    expect(normaliseIdentity('hosted:custom/exec', DEFAULT_MCP_NAMING)).toBe('hosted:custom/exec');
  });
});

describe('conventionFor', () => {
  it('picks the client whose user agent matches, and falls back to the shared naming', () => {
    expect(conventionFor('codex-tui/0.149.1 (Mac OS 26.1.0)', DEFAULT_MCP_NAMING).containerTools).toEqual(['exec']);
    expect(conventionFor('claude-cli/2.1.270 (external, cli)', DEFAULT_MCP_NAMING).containerTools).toEqual([]);
    expect(conventionFor('curl/8.7.1', DEFAULT_MCP_NAMING).containerTools).toEqual([]);
    expect(conventionFor(undefined, DEFAULT_MCP_NAMING).containerTools).toEqual([]);
    // every client shares the same name pattern, so normalisation never depends on the agent
    expect(conventionFor('anything', DEFAULT_MCP_NAMING).namePattern).toBe(DEFAULT_MCP_NAMING.namePattern);
  });
});

describe('nestedCallsIn', () => {
  const codex = conventionFor('codex-tui/0.149.1', DEFAULT_MCP_NAMING);

  it('finds the MCP tools a container call reaches for, identifiers only', () => {
    const body = 'const r = await tools.mcp__ps_exec_remote__run_powershell({ script: "Get-Process" });\n'
      + 'await tools.exec_command({ cmd: "ls" });';
    expect(nestedCallsIn(body, codex)).toEqual(['mcp:ps_exec_remote/run_powershell']);
  });

  it('reports each tool once and ignores a client without container tools', () => {
    const body = 'await tools.mcp__a__x(); await tools.mcp__a__x(); await tools.mcp__b__y();';
    expect(nestedCallsIn(body, codex)).toEqual(['mcp:a/x', 'mcp:b/y']);
    expect(nestedCallsIn(body, conventionFor('claude-cli/2.1.270', DEFAULT_MCP_NAMING))).toEqual([]);
  });

  it('never throws on a body that is not code', () => {
    for (const body of [undefined, null, '', 42, {}, '{"json":true}'] as any[]) {
      expect(nestedCallsIn(body, codex)).toEqual([]);
    }
  });
});

describe('the shipped presets', () => {
  it('cover the clients measured on this gateway and leave the unmeasured ones empty', () => {
    const names = DEFAULT_MCP_NAMING.clients.map((c) => c.name);
    expect(names).toEqual(['claude-code', 'codex', 'opencode', 'pi']);
    const byName = Object.fromEntries(DEFAULT_MCP_NAMING.clients.map((c) => [c.name, c]));
    // codex is the only measured client that hides its MCP tools behind a container
    expect(byName.codex.containerTools).toEqual(['exec']);
    expect(byName['claude-code'].containerTools).toEqual([]);
    // pi has no MCP support at all; opencode has it but marks nothing, so its servers must be named
    expect(byName.pi.containerTools).toEqual([]);
    expect(byName.pi.serverNames).toBeUndefined();
    expect(byName.opencode.serverNames).toEqual([]);
  });

  /**
   * Measured with a throwaway MCP server called `probe`: opencode offers its tools as
   * `probe_ping_probe` and `probe_echo_probe` among its own `bash`, `read` and `webfetch`, with no
   * marker of any kind. Only the server name separates the two kinds.
   */
  it('names an opencode MCP tool once its server is configured, and leaves the built-ins alone', () => {
    const opencode = conventionFor('opencode/1.18.25', {
      ...DEFAULT_MCP_NAMING,
      clients: DEFAULT_MCP_NAMING.clients.map((c) => (c.name === 'opencode' ? { ...c, serverNames: ['probe', 'github'] } : c))
    });
    expect(normaliseIdentity('function:probe_ping_probe', opencode)).toBe('mcp:probe/ping_probe');
    expect(normaliseIdentity('function:github_create_issue', opencode)).toBe('mcp:github/create_issue');
    for (const builtin of ['function:webfetch', 'function:todowrite', 'function:bash', 'function:read']) {
      expect(normaliseIdentity(builtin, opencode)).toBe(builtin);
    }
    // without the server list nothing is claimed: an unmarked name stays a function tool
    expect(normaliseIdentity('function:probe_ping_probe', conventionFor('opencode/1.18.25', DEFAULT_MCP_NAMING)))
      .toBe('function:probe_ping_probe');
  });
});
