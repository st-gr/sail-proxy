/**
 * How each client spells the MCP tools it hosts itself, and how those spellings become identities.
 *
 * A client that runs its own MCP servers sends no `{type:'mcp'}` entry. Measured on this gateway's
 * payload log on 2026-09-18:
 *
 * - **Claude Code** declares every one of them as an ordinary tool named `mcp__server__tool` (40
 *   distinct among 57 declared tools). They are in the request, so strip mode can remove them.
 * - **Codex** declares none of them. They live inside its `exec` container tool and the model
 *   reaches them as `tools.mcp__server__tool` in the code it writes for that call.
 * - **opencode** declares them as `<server>_<tool>` (`probe_ping_probe` for tool `ping_probe` on
 *   server `probe`), with NOTHING in the payload marking them as MCP: the name and description look
 *   exactly like its built-in `webfetch` or `todowrite`. Governing them therefore needs the server
 *   names, which is why a client entry may carry `serverNames`.
 * - **pi** has no MCP support at all - extensions instead - and declared only its four built-in
 *   tools in every observed session.
 *
 * Normalising `mcp__server__tool` into `mcp:server/tool` is what lets one policy pattern
 * (`mcp:abap2ui5/*`) cover a locally hosted server and a remotely declared one alike. The
 * conventions are configuration (`platform.toolGovernance.mcpNaming`) rather than code, so a client
 * nobody has measured yet is a configuration change instead of a release.
 */
import { mcpTool } from './identity';
import type { ToolIdentity } from './identity';

export interface McpClientConvention {
  name: string;
  /** Matched against the request's user agent (case-insensitive, unanchored). */
  userAgent: string;
  /** Tools whose CALL BODY may reach nested MCP tools (codex's `exec`); empty for most clients. */
  containerTools: string[];
  /** How a nested call appears inside such a body; the first group is the tool's name. */
  nestedCallPattern?: string;
  /** Overrides the shared name pattern for a client that spells its MCP tools differently. */
  namePattern?: string;
  /**
   * The MCP servers this installation runs, for a client whose tool names carry no marker.
   * opencode offers `probe_ping_probe` for tool `ping_probe` on server `probe`, which is
   * indistinguishable from a built-in tool by shape alone - only the server name tells them apart.
   */
  serverNames?: string[];
}

export interface McpNaming {
  /** The shared name convention: group 1 is the server, group 2 is the tool. */
  namePattern: string;
  clients: McpClientConvention[];
}

/** Presets for the clients measured on this gateway; `platform.toolGovernance.mcpNaming` overrides them. */
export const DEFAULT_MCP_NAMING: McpNaming = {
  namePattern: '^mcp__(.+?)__(.+)$',
  clients: [
    { name: 'claude-code', userAgent: 'claude-cli', containerTools: [] },
    { name: 'codex', userAgent: 'codex-tui', containerTools: ['exec'], nestedCallPattern: 'tools\\.([A-Za-z0-9_]+)' },
    // opencode's MCP tools are `<server>_<tool>` with no marker: list the servers this installation
    // runs and they become mcp: identities; leave it empty and they stay ordinary function tools.
    { name: 'opencode', userAgent: 'opencode', containerTools: [], serverNames: [] },
    // pi has no MCP support (extensions instead); the entry documents that it was measured.
    { name: 'pi', userAgent: 'OpenAI/JS', containerTools: [] }
  ]
};

/** A convention with the shared naming folded in, so callers need one object. */
export interface ResolvedConvention extends McpClientConvention {
  namePattern: string;
}

const compile = (pattern: string | undefined, flags = ''): RegExp | null => {
  if (!pattern) return null;
  try { return new RegExp(pattern, flags); } catch { return null; }
};

/**
 * `mcp__server__tool` → `mcp:server/tool`, or `<server>_<tool>` → `mcp:server/tool` for a client
 * whose servers are listed in `serverNames`. Null for any other name.
 */
export function mcpIdentity(name: unknown, naming: { namePattern?: string; serverNames?: string[] }): ToolIdentity | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  const re = compile(naming.namePattern ?? DEFAULT_MCP_NAMING.namePattern);
  const m = re?.exec(name);
  if (m?.[1] && m[2]) return mcpTool(m[1], m[2]);
  for (const server of naming.serverNames ?? []) {
    const prefix = `${server}_`;
    if (server && name.startsWith(prefix) && name.length > prefix.length) {
      return mcpTool(server, name.slice(prefix.length));
    }
  }
  return null;
}

/**
 * The identity a declared or invoked tool should carry: a `function:` identity whose name follows
 * the MCP convention becomes an `mcp:` identity. Everything else is returned unchanged, so a hosted
 * tool, a container tool and an already-namespaced MCP tool all keep their identity.
 */
export function normaliseIdentity(identity: ToolIdentity, naming: { namePattern?: string; serverNames?: string[] }): ToolIdentity {
  if (!identity.startsWith('function:')) return identity;
  return mcpIdentity(identity.slice('function:'.length), naming) ?? identity;
}

/** The convention for a request's user agent; a client nobody matched governs declarations only. */
export function conventionFor(userAgent: unknown, naming: McpNaming): ResolvedConvention {
  const agent = typeof userAgent === 'string' ? userAgent.toLowerCase() : '';
  const match = agent
    ? naming.clients.find((c) => c.userAgent && agent.includes(c.userAgent.toLowerCase()))
    : undefined;
  return {
    name: match?.name ?? 'unknown',
    userAgent: match?.userAgent ?? '',
    containerTools: match?.containerTools ?? [],
    nestedCallPattern: match?.nestedCallPattern,
    serverNames: match?.serverNames ?? [],
    namePattern: match?.namePattern ?? naming.namePattern
  };
}

export const isContainerTool = (name: unknown, convention: ResolvedConvention): boolean =>
  typeof name === 'string' && convention.containerTools.includes(name);

/**
 * The MCP tools a container call reaches for, read out of the call body. Identifiers only: the
 * arguments are never inspected, never returned and never logged. Each tool appears once, in the
 * order it was first seen.
 */
export function nestedCallsIn(body: unknown, convention: ResolvedConvention): ToolIdentity[] {
  if (typeof body !== 'string' || body.length === 0) return [];
  const re = compile(convention.nestedCallPattern, 'g');
  if (!re) return [];
  const out: ToolIdentity[] = [];
  for (const m of body.matchAll(re)) {
    const identity = mcpIdentity(m[1], convention);
    if (identity && !out.includes(identity)) out.push(identity);
  }
  return out;
}
