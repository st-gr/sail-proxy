import { functionTool, hostedTool, mcpServer, mcpTool, UNKNOWN_SOURCE } from '../identity';
import type { ToolIdentity } from '../identity';
import { arr, str, sseChunks } from './types';
import { appendNotice, carriesNotice, stripNotice } from '../stripNotice';
import type { ToolAdapter, ResultSource } from './types';

/** A tool entry with a versioned `type` (web_search_20250305, text_editor_20250124…) is a server tool. */
function toolIdentity(t: any): ToolIdentity | null {
  const type = str(t?.type);
  const name = str(t?.name);
  if (type && type !== 'custom') return hostedTool(type);
  return name ? functionTool(name) : null;
}

function openaiShapedCalls(payload: any): ToolIdentity[] {
  const out: ToolIdentity[] = [];
  for (const c of arr(payload?.choices)) for (const tc of arr(c?.message?.tool_calls)) { const n = str(tc?.function?.name); if (n) out.push(functionTool(n)); }
  return out;
}

function blockIdentity(b: any): ToolIdentity | null {
  switch (b?.type) {
    case 'tool_use': { const n = str(b.name); return n ? functionTool(n) : null; }
    case 'server_tool_use': { const n = str(b.name); return n ? hostedTool(n) : null; }
    case 'mcp_tool_use': { const s = str(b.server_name); const n = str(b.name); return s && n ? mcpTool(s, n) : null; }
    default: return null;
  }
}

/**
 * The MCP connector (beta header `mcp-client-2025-11-20`): a server is declared in `mcp_servers[]`
 * (connection only - `type`, `url`, `name`, `authorization_token`), and every server MUST be
 * referenced by exactly one paired `tools[]` entry `{type:'mcp_toolset', mcp_server_name}`. That
 * toolset, not the server entry, is where tool access is limited: `default_config: {enabled}` sets
 * the default for every tool on the server, and `configs` overrides it per tool name
 * (`{[toolName]: {enabled, defer_loading}}`). There is no `tool_configuration.allowed_tools` field
 * on `mcp_servers[]` in the current (non-deprecated) API - that shape does not exist. See
 * https://platform.claude.com/docs/en/agents-and-tools/mcp-connector.
 */
function mcpToolsetFor(tools: any[], serverName: string): any | undefined {
  return tools.find((t) => str(t?.type) === 'mcp_toolset' && str(t?.mcp_server_name) === serverName);
}

export const anthropicAdapter: ToolAdapter = {
  family: 'anthropic',
  declaredTools(body) {
    const out: ToolIdentity[] = [];
    // The mcp_toolset entry is the required pairing for an mcp_servers[] declaration, not a tool of
    // its own - the server identity comes from mcp_servers[].name below, so it is skipped here.
    for (const t of arr(body?.tools)) {
      if (str(t?.type) === 'mcp_toolset') continue;
      const id = toolIdentity(t); if (id) out.push(id);
    }
    for (const s of arr(body?.mcp_servers)) { const n = str(s?.name); if (n) out.push(mcpServer(n)); }
    return out;
  },
  forcedTool(body) {
    const tc = body?.tool_choice;
    if (tc?.type !== 'tool') return null;
    const name = str(tc.name);
    if (!name) return null;
    const declared = arr(body?.tools).find((t) => str(t?.name) === name);
    return declared ? toolIdentity(declared) ?? functionTool(name) : functionTool(name);
  },
  stripTools(body, blocked, narrow = new Map<string, string[]>()) {
    const toolsIn = arr(body?.tools);
    const serversIn = arr(body?.mcp_servers);

    // Per server name: drop it entirely, or (for narrowing) the toolset that replaces its paired
    // mcp_toolset entry. Decided up front so the tools[] pass below can act on both in one lookup.
    const dropServer = new Set<string>();
    const rewrittenToolset = new Map<string, any>();
    for (const s of serversIn) {
      const name = str(s?.name);
      if (!name) continue;
      if (blocked.has(mcpServer(name))) { dropServer.add(name); continue; }
      const limit = narrow.get(name);
      if (limit === undefined) continue;   // not narrowed: server and its toolset are untouched
      const toolset = mcpToolsetFor(toolsIn, name);
      if (!toolset) continue;              // no paired toolset (deprecated beta shape): leave as-is
      const configs = toolset?.configs ?? {};
      // A client-narrowed toolset (default_config.enabled === false) already names the tools it
      // enabled; the policy's limit can only take away from that set, never add to it. Otherwise
      // the policy's limit is the allowlist outright.
      const allowed = toolset?.default_config?.enabled === false
        ? Object.keys(configs).filter((n) => configs[n]?.enabled === true && limit.includes(n))
        : [...limit];
      if (allowed.length === 0) { dropServer.add(name); continue; }
      const newConfigs: Record<string, any> = {};
      for (const n of Object.keys(configs)) newConfigs[n] = { ...configs[n], enabled: allowed.includes(n) };
      for (const n of allowed) newConfigs[n] = { ...(configs[n] ?? {}), enabled: true };
      rewrittenToolset.set(name, { ...toolset, default_config: { ...(toolset.default_config ?? {}), enabled: false }, configs: newConfigs });
    }

    const out = { ...body };
    const tools: any[] = [];
    for (const t of toolsIn) {
      if (str(t?.type) === 'mcp_toolset') {
        const name = str(t?.mcp_server_name);
        if (name && dropServer.has(name)) continue;
        tools.push(name && rewrittenToolset.has(name) ? rewrittenToolset.get(name) : t);
        continue;
      }
      const id = toolIdentity(t);
      if (id && blocked.has(id)) continue;
      tools.push(t);
    }
    if (Array.isArray(body?.tools)) { if (tools.length > 0) out.tools = tools; else delete out.tools; }

    const servers = serversIn.filter((s) => { const n = str(s?.name); return !n || !dropServer.has(n); });
    if (Array.isArray(body?.mcp_servers)) { if (servers.length > 0) out.mcp_servers = servers; else delete out.mcp_servers; }
    return out;
  },
  noteStrippedTools(body, blocked, taintedBy = []) {
    if (blocked.length === 0) return body;
    const system = body?.system;
    if (Array.isArray(system)) {
      if (system.some((b: any) => carriesNotice(b?.text))) return body;
      return { ...body, system: [...system, { type: 'text', text: stripNotice(blocked, taintedBy) }] };
    }
    if (carriesNotice(system)) return body;
    return { ...body, system: appendNotice(system, blocked, taintedBy) };
  },
  // No client of this family hosts its MCP tools behind a container tool.
  nestedInvokedTools() { return []; },
  invokedTools(payload) {
    if (Array.isArray(payload?.choices)) return openaiShapedCalls(payload);   // emulated-stream final_result
    const out: ToolIdentity[] = [];
    for (const b of arr(payload?.content)) { const id = blockIdentity(b); if (id) out.push(id); }
    return out;
  },
  invokedToolsFromChunk(chunk) {
    if (chunk?.type !== 'content_block_start') return [];
    const id = blockIdentity(chunk.content_block);
    return id ? [id] : [];
  },
  invokedToolsFromStream(text) {
    return sseChunks(text).flatMap((c) => anthropicAdapter.invokedToolsFromChunk(c));
  },
  resultSources(body) {
    const calls = new Map<string, ResultSource>();
    const out: ResultSource[] = [];
    for (const m of arr(body?.messages)) {
      for (const b of arr(m?.content)) {
        const type = str(b?.type);
        if (!type) continue;
        const id = str(b.id);
        if (type === 'tool_use' && id && str(b.name)) calls.set(id, { identity: functionTool(b.name), args: () => JSON.stringify(b.input ?? {}) });
        else if (type === 'mcp_tool_use' && id && str(b.server_name) && str(b.name)) calls.set(id, { identity: mcpTool(b.server_name, b.name), args: () => JSON.stringify(b.input ?? {}) });
        else if (type === 'tool_result' || type === 'mcp_tool_result') {
          const ref = str(b.tool_use_id);
          out.push((ref && calls.get(ref)) || { identity: UNKNOWN_SOURCE, args: '' });
        } else if (type.endsWith('_tool_result')) {
          out.push({ identity: hostedTool(type.slice(0, -'_tool_result'.length)), args: '' });
        }
      }
    }
    return out;
  },
  rejectionBody(message) {
    return { type: 'error', error: { type: 'permission_error', message } };
  }
};
