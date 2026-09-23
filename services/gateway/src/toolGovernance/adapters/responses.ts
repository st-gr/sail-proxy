import { functionTool, hostedTool, hostedNamedTool, mcpServer, mcpTool, UNKNOWN_SOURCE } from '../identity';
import type { ToolIdentity } from '../identity';
import { arr, str, sseChunks } from './types';
import { appendNotice, carriesNotice } from '../stripNotice';
import { isContainerTool, nestedCallsIn } from '../mcpNaming';
import type { ResolvedConvention } from '../mcpNaming';
import type { ToolAdapter, ResultSource } from './types';

/** `allowed_tools` is either a string array or `{ tool_names: string[] }`. */
function allowedToolNames(t: any): string[] {
  const a = t?.allowed_tools;
  if (Array.isArray(a)) return a.filter((n: any) => typeof n === 'string');
  return arr(a?.tool_names).filter((n: any) => typeof n === 'string');
}

/**
 * A typed Responses tool can carry its own name - codex declares its shell as
 * `{type:'custom',name:'exec'}` and its collaboration tools as
 * `{type:'namespace',name:'collaboration'}`. The type alone hid which tool it was (every custom
 * tool read as `hosted:custom`) and left a policy unable to name one of them, so the named identity
 * is recorded BESIDE the type, the way an MCP server is recorded beside its tools: a policy can
 * then block `hosted:custom/exec` alone or `hosted:custom` for all of them.
 */
function declaredOf(t: any): ToolIdentity[] {
  const type = str(t?.type);
  if (!type) return [];
  if (type === 'function') { const n = str(t.name); return n ? [functionTool(n)] : []; }
  if (type === 'mcp') {
    const label = str(t.server_label);
    if (!label) return [];
    return [mcpServer(label), ...allowedToolNames(t).map((n) => mcpTool(label, n))];
  }
  const name = str(t.name);
  return name ? [hostedTool(type), hostedNamedTool(type, name)] : [hostedTool(type)];
}

/**
 * Hosted output items are named `<type>_call`, and for most hosted tools dropping that suffix
 * gives back the declared tool type (`web_search_call` → `web_search`). Where the two spellings
 * differ, the alias maps the call type onto the DECLARED type name, so a policy written against
 * the name an administrator sees in the request also matches the invocation. The generic suffix
 * strip stays the fallback for every hosted tool not listed here.
 */
const HOSTED_CALL_TYPES: Record<string, string> = { computer_call: 'computer_use_preview' };

function outputItemIdentity(item: any): ToolIdentity | null {
  const type = str(item?.type);
  if (!type) return null;
  if (type === 'function_call') { const n = str(item.name); return n ? functionTool(n) : null; }
  if (type === 'mcp_call') { const s = str(item.server_label); const n = str(item.name); return s && n ? mcpTool(s, n) : null; }
  // A custom tool's invocation carries the tool's name, and the declaration is `hosted:custom/<name>`.
  if (type === 'custom_tool_call') { const n = str(item.name); return n ? hostedNamedTool('custom', n) : hostedTool('custom'); }
  if (type.endsWith('_call')) return hostedTool(HOSTED_CALL_TYPES[type] ?? type.slice(0, -'_call'.length));
  return null;   // message, reasoning, mcp_list_tools, mcp_approval_request …
}

export const responsesAdapter: ToolAdapter = {
  family: 'responses',
  declaredTools(body) { return arr(body?.tools).flatMap(declaredOf); },
  forcedTool(body) {
    const tc = body?.tool_choice;
    if (!tc || typeof tc !== 'object') return null;
    if (tc.type === 'function' && str(tc.name)) return functionTool(tc.name);
    if (tc.type === 'mcp' && str(tc.server_label)) return str(tc.name) ? mcpTool(tc.server_label, tc.name) : mcpServer(tc.server_label);
    return null;
  },
  stripTools(body, blocked, narrow = new Map<string, string[]>()) {
    if (!Array.isArray(body?.tools)) return { ...body };
    const tools: any[] = [];
    for (const t of body.tools) {
      const type = str(t?.type);
      if (type === 'mcp' && str(t.server_label)) {
        if (blocked.has(mcpServer(t.server_label))) continue;
        const names = allowedToolNames(t);
        const limit = narrow.get(t.server_label);
        if (limit !== undefined && names.length === 0) {
          if (limit.length > 0) tools.push({ ...t, allowed_tools: limit });
          continue;
        }
        const kept = names.filter((n) => !blocked.has(mcpTool(t.server_label, n)));
        if (kept.length === names.length) { tools.push(t); continue; }
        const copy = { ...t };
        copy.allowed_tools = Array.isArray(t.allowed_tools) ? kept : { ...t.allowed_tools, tool_names: kept };
        tools.push(copy);
        continue;
      }
      const ids = declaredOf(t);
      if (ids.some((id) => blocked.has(id))) continue;
      tools.push(t);
    }
    const out = { ...body };
    if (tools.length > 0) out.tools = tools; else delete out.tools;
    // A tool_choice left pointing at something that is no longer declared is a dangling forced
    // reference the upstream rejects. With nothing left to call, only 'auto'/'none' survive; an
    // `allowed_tools` choice is narrowed to the entries that survived and dropped when empty.
    // The single-named forced case never reaches here — evaluate() turns that into a rejection.
    const tc = out.tool_choice;
    if (out.tools === undefined) {
      if (tc === 'required' || (tc && typeof tc === 'object')) delete out.tool_choice;
    } else if (tc && typeof tc === 'object' && str(tc.type) === 'allowed_tools' && Array.isArray(tc.tools)) {
      const surviving = new Set<ToolIdentity>(tools.flatMap(declaredOf));
      const kept = tc.tools.filter((t: any) => declaredOf(t).some((id) => surviving.has(id)));
      if (kept.length > 0) out.tool_choice = { ...tc, tools: kept }; else delete out.tool_choice;
    }
    return out;
  },
  noteStrippedTools(body, blocked, taintedBy = []) {
    if (blocked.length === 0 || carriesNotice(body?.instructions)) return body;
    return { ...body, instructions: appendNotice(body?.instructions, blocked, taintedBy) };
  },
  invokedTools(payload) {
    const out: ToolIdentity[] = [];
    for (const item of arr(payload?.output)) { const id = outputItemIdentity(item); if (id) out.push(id); }
    return out;
  },
  /**
   * A container tool's call carries the program the model wrote, and the MCP tools it reaches are
   * `tools.<identifier>` inside it. The gateway rewrites custom tools into function tools before
   * the upstream call, so the container comes back as a `function_call` whatever it was declared as.
   */
  nestedInvokedTools(payload, convention) {
    if (convention.containerTools.length === 0) return [];
    const items = typeof payload === 'string'
      ? sseChunks(payload).filter((c) => c?.type === 'response.output_item.done').map((c) => c.item)
      : arr(payload?.output);
    const out: ToolIdentity[] = [];
    for (const item of items) {
      if (!isContainerTool(str(item?.name), convention)) continue;
      const body = typeof item?.arguments === 'string' ? item.arguments
        : typeof item?.input === 'string' ? item.input : '';
      for (const identity of nestedCallsIn(body, convention)) {
        if (!out.includes(identity)) out.push(identity);
      }
    }
    return out;
  },
  invokedToolsFromChunk(chunk) {
    if (chunk?.type !== 'response.output_item.done') return [];
    const id = outputItemIdentity(chunk.item);
    return id ? [id] : [];
  },
  invokedToolsFromStream(text) { return sseChunks(text).flatMap((c) => responsesAdapter.invokedToolsFromChunk(c)); },
  resultSources(body) {
    const calls = new Map<string, ResultSource>();
    const out: ResultSource[] = [];
    for (const item of arr(body?.input)) {
      const type = str(item?.type);
      if (!type) continue;
      const callId = str(item.call_id);
      if (type === 'function_call') {
        const name = str(item.name);
        if (callId && name) calls.set(callId, { identity: functionTool(name), args: typeof item.arguments === 'string' ? item.arguments : '' });
      } else if (type === 'custom_tool_call') {
        const name = str(item.name);
        if (callId && name) calls.set(callId, { identity: hostedNamedTool('custom', name), args: typeof item.input === 'string' ? item.input : '' });
      } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
        out.push((callId && calls.get(callId)) || { identity: UNKNOWN_SOURCE, args: '' });
      } else if (type === 'mcp_call') {
        const s = str(item.server_label); const n = str(item.name);
        if (s && n && item.output !== undefined && item.output !== null) out.push({ identity: mcpTool(s, n), args: '' });
      } else if (type.endsWith('_call')) {
        out.push({ identity: hostedTool(HOSTED_CALL_TYPES[type] ?? type.slice(0, -'_call'.length)), args: '' });
      }
    }
    return out;
  },
  rejectionBody(message) { return { error: { message, type: 'invalid_request_error', code: 'tool_not_entitled' } }; }
};
