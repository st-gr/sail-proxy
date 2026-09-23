import { functionTool, UNKNOWN_SOURCE } from '../identity';
import type { ToolIdentity } from '../identity';
import { arr, str, sseChunks } from './types';
import { appendNotice, carriesNotice, stripNotice } from '../stripNotice';
import type { ToolAdapter, ResultSource } from './types';

export const openaiChatAdapter: ToolAdapter = {
  family: 'openaiChat',
  declaredTools(body) {
    const out: ToolIdentity[] = [];
    for (const t of arr(body?.tools)) { const n = str(t?.function?.name); if (n) out.push(functionTool(n)); }
    for (const f of arr(body?.functions)) { const n = str(f?.name); if (n) out.push(functionTool(n)); }
    return out;
  },
  forcedTool(body) {
    const tc = body?.tool_choice;
    if (tc && typeof tc === 'object' && str(tc.function?.name)) return functionTool(tc.function.name);
    const fc = body?.function_call;
    if (fc && typeof fc === 'object' && str(fc.name)) return functionTool(fc.name);
    return null;
  },
  stripTools(body, blocked) {
    const out = { ...body };
    if (Array.isArray(body?.tools)) {
      const tools = body.tools.filter((t: any) => { const n = str(t?.function?.name); return !n || !blocked.has(functionTool(n)); });
      if (tools.length > 0) out.tools = tools; else delete out.tools;
    }
    if (Array.isArray(body?.functions)) {
      const fns = body.functions.filter((f: any) => { const n = str(f?.name); return !n || !blocked.has(functionTool(n)); });
      if (fns.length > 0) out.functions = fns; else delete out.functions;
    }
    // A choice that still demands a call once nothing is left to call is a dangling forced
    // reference the upstream rejects: drop `'required'` and the named-object form, but leave
    // `'auto'`/`'none'`, which are valid with no tools at all. The single-named forced case never
    // reaches here — evaluate() turns that into a rejection.
    const forcing = (v: any): boolean => v === 'required' || (!!v && typeof v === 'object');
    if (Array.isArray(body?.tools) && out.tools === undefined && forcing(out.tool_choice)) delete out.tool_choice;
    if (Array.isArray(body?.functions) && out.functions === undefined && forcing(out.function_call)) delete out.function_call;
    return out;
  },
  /**
   * The note is merged into the first system message, or inserted as a new FIRST message - never
   * appended at the end: a system message that follows a tool message is refused by some providers
   * behind SAP AI Core (Mistral).
   */
  noteStrippedTools(body, blocked, taintedBy = []) {
    if (blocked.length === 0) return body;
    const messages = arr(body?.messages);
    if (messages.some((m: any) => m?.role === 'system' && carriesNotice(m?.content))) return body;
    const first = messages.findIndex((m: any) => m?.role === 'system' && typeof m?.content === 'string');
    if (first >= 0) {
      const copy = [...messages];
      copy[first] = { ...messages[first], content: appendNotice(messages[first].content, blocked, taintedBy) };
      return { ...body, messages: copy };
    }
    return { ...body, messages: [{ role: 'system', content: stripNotice(blocked, taintedBy) }, ...messages] };
  },
  // No client of this family hosts its MCP tools behind a container tool.
  nestedInvokedTools() { return []; },
  invokedTools(payload) {
    const out: ToolIdentity[] = [];
    for (const c of arr(payload?.choices)) {
      for (const tc of arr(c?.message?.tool_calls)) { const n = str(tc?.function?.name); if (n) out.push(functionTool(n)); }
      const fc = c?.message?.function_call; if (str(fc?.name)) out.push(functionTool(fc.name));
    }
    return out;
  },
  invokedToolsFromChunk(chunk) {
    const out: ToolIdentity[] = [];
    for (const c of arr(chunk?.choices)) for (const tc of arr(c?.delta?.tool_calls)) { const n = str(tc?.function?.name); if (n) out.push(functionTool(n)); }
    return out;
  },
  invokedToolsFromStream(text) {
    return sseChunks(text).flatMap((c) => openaiChatAdapter.invokedToolsFromChunk(c));
  },
  resultSources(body) {
    const calls = new Map<string, ResultSource>();
    const out: ResultSource[] = [];
    for (const m of arr(body?.messages)) {
      if (m?.role === 'assistant') {
        for (const tc of arr(m.tool_calls)) {
          const id = str(tc?.id); const name = str(tc?.function?.name);
          if (id && name) calls.set(id, { identity: functionTool(name), args: typeof tc.function.arguments === 'string' ? tc.function.arguments : '' });
        }
      } else if (m?.role === 'tool') {
        const id = str(m.tool_call_id);
        out.push((id && calls.get(id)) || { identity: UNKNOWN_SOURCE, args: '' });
      } else if (m?.role === 'function') {
        const name = str(m.name);
        out.push({ identity: name ? functionTool(name) : UNKNOWN_SOURCE, args: '' });
      }
    }
    return out;
  },
  rejectionBody(message) {
    return { error: { message, type: 'invalid_request_error', code: 'tool_not_entitled' } };
  }
};
