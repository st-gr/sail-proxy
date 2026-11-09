import { functionTool } from '../identity';
import type { ToolIdentity } from '../identity';
import { arr, str, sseChunks } from './types';
import { carriesNotice, stripNotice } from '../stripNotice';
import type { ToolAdapter, ResultSource } from './types';

function callsIn(payload: any): ToolIdentity[] {
  const out: ToolIdentity[] = [];
  for (const c of arr(payload?.candidates)) for (const p of arr(c?.content?.parts)) { const n = str(p?.functionCall?.name); if (n) out.push(functionTool(n)); }
  return out;
}

export const geminiAdapter: ToolAdapter = {
  family: 'gemini',
  declaredTools(body) {
    const out: ToolIdentity[] = [];
    for (const t of arr(body?.tools)) for (const d of arr(t?.functionDeclarations)) { const n = str(d?.name); if (n) out.push(functionTool(n)); }
    return out;
  },
  forcedTool(body) {
    const cfg = body?.toolConfig?.functionCallingConfig;
    const names = arr(cfg?.allowedFunctionNames);
    return cfg?.mode === 'ANY' && names.length === 1 && str(names[0]) ? functionTool(names[0]) : null;
  },
  stripTools(body, blocked) {
    if (!Array.isArray(body?.tools)) return { ...body };
    const tools: any[] = [];
    for (const t of body.tools) {
      if (!Array.isArray(t?.functionDeclarations)) { tools.push(t); continue; }
      const decls = t.functionDeclarations.filter((d: any) => { const n = str(d?.name); return !n || !blocked.has(functionTool(n)); });
      if (decls.length > 0) tools.push({ ...t, functionDeclarations: decls });
    }
    const out = { ...body };
    if (tools.length > 0) out.tools = tools; else delete out.tools;
    // A forced `allowedFunctionNames` entry that survives as a name with no declaration left is a
    // dangling reference: Gemini rejects the request (or calls a function the caller never
    // declared). Narrow the list to the surviving declarations, drop the key when nothing is left,
    // and drop the whole toolConfig when mode ANY would then force a choice out of an empty set.
    const cfg = out.toolConfig?.functionCallingConfig;
    if (Array.isArray(cfg?.allowedFunctionNames)) {
      const surviving = new Set<string>();
      for (const t of tools) for (const d of arr(t?.functionDeclarations)) { const n = str(d?.name); if (n) surviving.add(n); }
      const kept = cfg.allowedFunctionNames.filter((n: any) => typeof n === 'string' && surviving.has(n));
      const nextCfg: any = { ...cfg };
      if (kept.length > 0) nextCfg.allowedFunctionNames = kept; else delete nextCfg.allowedFunctionNames;
      if (kept.length === 0 && cfg.mode === 'ANY') delete out.toolConfig;
      else out.toolConfig = { ...out.toolConfig, functionCallingConfig: nextCfg };
    }
    return out;
  },
  noteStrippedTools(body, blocked, taintedBy = []) {
    if (blocked.length === 0) return body;
    const parts = arr(body?.systemInstruction?.parts);
    if (parts.some((p: any) => carriesNotice(p?.text))) return body;
    return { ...body, systemInstruction: { ...(body?.systemInstruction ?? {}), parts: [...parts, { text: stripNotice(blocked, taintedBy) }] } };
  },
  // No client of this family hosts its MCP tools behind a container tool.
  nestedInvokedTools() { return []; },
  invokedTools(payload) { return callsIn(payload); },
  invokedToolsFromChunk(chunk) { return callsIn(chunk); },
  invokedToolsFromStream(text) { return sseChunks(text).flatMap(callsIn); },
  resultSources(body) {
    const out: ResultSource[] = [];
    for (const c of arr(body?.contents)) for (const p of arr(c?.parts)) {
      const name = str(p?.functionResponse?.name);
      if (name) out.push({ identity: functionTool(name), args: '' });
    }
    return out;
  },
  rejectionBody(message) { return { error: { code: 403, status: 'PERMISSION_DENIED', message } }; }
};
