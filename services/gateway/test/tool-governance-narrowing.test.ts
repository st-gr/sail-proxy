/**
 * Narrowing a bare MCP server declaration (spec 2026-09-22 §2.2), and scoped allows through the
 * middleware for a client that declares its MCP tools as functions (Claude Code: mcp__server__tool).
 */
import { responsesAdapter } from '../src/toolGovernance/adapters/responses';
import { anthropicAdapter } from '../src/toolGovernance/adapters/anthropic';
import { toolGovernance } from '../src/toolGovernance/middleware';

jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitToolNotEntitled: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/services/configService', () => ({ getTrustForwardedFor: () => false, getConfig: () => ({}) }));

const narrow = new Map([['github', ['get_issue', 'list_issues']]]);

describe('responses stripTools with narrow', () => {
  it('writes the names into a bare mcp entry and leaves other tools alone', () => {
    const body = { tools: [{ type: 'mcp', server_label: 'github', server_url: 'https://mcp.example.invalid' }, { type: 'function', name: 'read' }] };
    const out = responsesAdapter.stripTools(body, new Set(), narrow);
    expect(out.tools[0].allowed_tools).toEqual(['get_issue', 'list_issues']);
    expect(out.tools[1]).toEqual({ type: 'function', name: 'read' });
    expect(body.tools[0]).not.toHaveProperty('allowed_tools');   // input not mutated
  });
  it('an entry that already lists tools is left to per-tool stripping', () => {
    const body = { tools: [{ type: 'mcp', server_label: 'github', allowed_tools: ['get_issue'] }] };
    expect(responsesAdapter.stripTools(body, new Set(), narrow).tools[0].allowed_tools).toEqual(['get_issue']);
  });
  it('an empty limit drops the entry', () => {
    const body = { tools: [{ type: 'mcp', server_label: 'github' }] };
    expect(responsesAdapter.stripTools(body, new Set(), new Map([['github', []]]))).not.toHaveProperty('tools');
  });
});

/**
 * The current MCP connector (beta `mcp-client-2025-11-20`) has no `tool_configuration.allowed_tools`
 * field on `mcp_servers[]`. Tool access is limited on the paired `tools[]` entry
 * `{type:'mcp_toolset', mcp_server_name, default_config, configs}` instead - see the doc comment on
 * `anthropic.ts`. These tests exercise that shape.
 */
describe('anthropic stripTools/declaredTools with the mcp_toolset shape', () => {
  it('writes an allowlist into a bare toolset, and leaves an unnarrowed server + toolset untouched', () => {
    const body = {
      mcp_servers: [
        { type: 'url', name: 'github', url: 'https://mcp.example.invalid' },
        { type: 'url', name: 'github2', url: 'https://mcp2.example.invalid' }
      ],
      tools: [
        { type: 'mcp_toolset', mcp_server_name: 'github' },
        { type: 'mcp_toolset', mcp_server_name: 'github2' }
      ]
    };
    const out = anthropicAdapter.stripTools(body, new Set(), new Map([['github', ['get_issue', 'list_issues']]]));
    expect(out.tools[0]).toEqual({
      type: 'mcp_toolset', mcp_server_name: 'github',
      default_config: { enabled: false },
      configs: { get_issue: { enabled: true }, list_issues: { enabled: true } }
    });
    expect(out.tools[1]).toEqual(body.tools[1]);
    expect(out.mcp_servers[1]).toEqual(body.mcp_servers[1]);
    // input not mutated
    expect(body.tools[0]).toEqual({ type: 'mcp_toolset', mcp_server_name: 'github' });
  });
  it('intersects the limit with tools the client already enabled, never adding one it did not', () => {
    const body = {
      mcp_servers: [{ type: 'url', name: 'github', url: 'https://mcp.example.invalid' }],
      tools: [{
        type: 'mcp_toolset', mcp_server_name: 'github',
        default_config: { enabled: false },
        configs: { get_issue: { enabled: true, defer_loading: true }, delete_repo: { enabled: true } }
      }]
    };
    const out = anthropicAdapter.stripTools(body, new Set(), new Map([['github', ['get_issue', 'list_issues']]]));
    expect(out.tools[0].configs).toEqual({
      get_issue: { enabled: true, defer_loading: true },
      delete_repo: { enabled: false }
      // list_issues not added: the client never enabled it
    });
  });
  it('an empty limit drops both the server and its toolset', () => {
    const body = {
      mcp_servers: [{ type: 'url', name: 'github', url: 'https://mcp.example.invalid' }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'github' }]
    };
    const out = anthropicAdapter.stripTools(body, new Set(), new Map([['github', []]]));
    expect(out).not.toHaveProperty('tools');
    expect(out).not.toHaveProperty('mcp_servers');
  });
  it('a server with no paired toolset (deprecated beta shape) is left unchanged', () => {
    const body = { mcp_servers: [{ type: 'url', name: 'github', url: 'https://mcp.example.invalid' }] };
    expect(anthropicAdapter.stripTools(body, new Set(), new Map([['github', ['get_issue']]]))).toEqual(body);
  });
  it('a blocked server (no narrow) removes both the server entry and its toolset', () => {
    const body = {
      mcp_servers: [{ type: 'url', name: 'github', url: 'https://mcp.example.invalid' }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'github' }, { type: 'function', name: 'read' }]
    };
    const out = anthropicAdapter.stripTools(body, new Set(['mcp:github']));
    expect(out.tools).toEqual([{ type: 'function', name: 'read' }]);
    expect(out).not.toHaveProperty('mcp_servers');
  });
  it('declaredTools skips the mcp_toolset entry - the server identity comes from mcp_servers[]', () => {
    const body = {
      mcp_servers: [{ type: 'url', name: 'github', url: 'https://mcp.example.invalid' }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'github' }]
    };
    expect(anthropicAdapter.declaredTools(body)).toEqual(['mcp:github']);
  });
});

function makeRes() { const r: any = { statusCode: 0 }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; }
const policy = { policyId: 'p', policyName: 'Scoped', mode: 'strip', allow: ['mcp:github/get_issue'], deny: [] };

describe('middleware with a scoped allow', () => {
  it('Claude Code: strips the unlisted github tool only, keeps another server and plain functions', () => {
    const req: any = {
      body: { model: 'claude', messages: [], tools: [
        { name: 'mcp__github__get_issue', input_schema: {} }, { name: 'mcp__github__delete_repo', input_schema: {} },
        { name: 'mcp__jira__create_ticket', input_schema: {} }, { name: 'Bash', input_schema: {} }
      ] },
      get: (h: string) => (h === 'user-agent' ? 'claude-cli/2.0.1 (external, cli)' : undefined),
      originalUrl: '/anthropic/v1/messages', method: 'POST',
      unifiedAuth: { authType: 'api_key', data: { keyId: 'k1', toolPolicy: policy } }
    };
    const next = jest.fn();
    toolGovernance(anthropicAdapter)(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.body.tools.map((t: any) => t.name)).toEqual(['mcp__github__get_issue', 'mcp__jira__create_ticket', 'Bash']);
  });
  it('narrows a bare Responses mcp entry through the middleware', () => {
    const req: any = {
      body: { model: 'gpt', input: 'hi', tools: [{ type: 'mcp', server_label: 'github', server_url: 'https://mcp.example.invalid' }] },
      get: () => 'jest', originalUrl: '/openai/v1/responses', method: 'POST',
      unifiedAuth: { authType: 'api_key', data: { keyId: 'k1', toolPolicy: policy } }
    };
    const next = jest.fn();
    toolGovernance(responsesAdapter)(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.body.tools[0].allowed_tools).toEqual(['get_issue']);
    expect(req.toolGovernance.result.decisions.get('mcp:github')).toBe('stripped');
  });
});
