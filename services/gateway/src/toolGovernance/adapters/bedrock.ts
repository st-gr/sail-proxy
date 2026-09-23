/**
 * AWS Bedrock (spec 2026-09-22 §4). Two body shapes reach the Bedrock route: Converse
 * (`toolConfig.tools[].toolSpec`, model-independent) and invoke, whose body is the model's own.
 * An invoke body carrying `anthropic_version` is an Anthropic Messages body and is handled by the
 * Anthropic adapter; any other invoke body (Nova, Llama…) declares no tools and passes through.
 *
 * Responses reach the client either Anthropic-shaped (`content_block_start` with a `tool_use`) or
 * in Bedrock's native event shape (`contentBlockStart.start.toolUse`); both are read.
 */
import { functionTool, UNKNOWN_SOURCE } from '../identity';
import type { ToolIdentity } from '../identity';
import { arr, str } from './types';
import type { ResultSource, ToolAdapter } from './types';
import { anthropicAdapter } from './anthropic';
import { carriesNotice, stripNotice } from '../stripNotice';

const isAnthropic = (body: any): boolean => typeof body?.anthropic_version === 'string';
/** The stream parser invents this name for a tool block whose start event it never saw. */
const PLACEHOLDER_TOOL = 'auto_detected_tool';

const specName = (t: any): string | null => str(t?.toolSpec?.name);
const usedTools = (body: any): boolean =>
  arr(body?.messages).some((m: any) => arr(m?.content).some((b: any) => b?.toolUse || b?.toolResult));

function converseCalls(message: any): ToolIdentity[] {
  const out: ToolIdentity[] = [];
  for (const b of arr(message?.content)) { const n = str(b?.toolUse?.name); if (n && n !== PLACEHOLDER_TOOL) out.push(functionTool(n)); }
  return out;
}

function chunkTools(chunk: any): ToolIdentity[] {
  const native = str(chunk?.contentBlockStart?.start?.toolUse?.name);
  if (native) return native === PLACEHOLDER_TOOL ? [] : [functionTool(native)];
  return anthropicAdapter.invokedToolsFromChunk(chunk).filter((id) => id !== functionTool(PLACEHOLDER_TOOL));
}

export const bedrockAdapter: ToolAdapter = {
  family: 'bedrock',
  declaredTools(body) {
    if (isAnthropic(body)) return anthropicAdapter.declaredTools(body);
    return arr(body?.toolConfig?.tools).map(specName).filter((n): n is string => !!n).map(functionTool);
  },
  forcedTool(body) {
    if (isAnthropic(body)) return anthropicAdapter.forcedTool(body);
    const n = str(body?.toolConfig?.toolChoice?.tool?.name);
    return n ? functionTool(n) : null;
  },
  stripTools(body, blocked, narrow) {
    if (isAnthropic(body)) return anthropicAdapter.stripTools(body, blocked, narrow);
    if (!Array.isArray(body?.toolConfig?.tools)) return { ...body };
    const tools = body.toolConfig.tools.filter((t: any) => { const n = specName(t); return !n || !blocked.has(functionTool(n)); });
    const out = { ...body };
    // toolChoice lives inside toolConfig; with no tools left the whole block goes.
    if (tools.length === 0) { delete out.toolConfig; return out; }
    const cfg: any = { ...body.toolConfig, tools };
    const forced = str(cfg.toolChoice?.tool?.name);
    if (forced && !tools.some((t: any) => specName(t) === forced)) delete cfg.toolChoice;
    out.toolConfig = cfg;
    return out;
  },
  stripRefusal(body, blocked) {
    if (isAnthropic(body) || !Array.isArray(body?.toolConfig?.tools) || !usedTools(body)) return null;
    const left = body.toolConfig.tools.filter((t: any) => { const n = specName(t); return !n || !blocked.has(functionTool(n)); });
    return left.length === 0
      ? 'every tool of this request is withheld, and Bedrock refuses a conversation that already used tools without any tool definitions'
      : null;
  },
  noteStrippedTools(body, blocked, taintedBy = []) {
    if (isAnthropic(body)) return anthropicAdapter.noteStrippedTools(body, blocked, taintedBy);
    if (blocked.length === 0) return body;
    const system = arr(body?.system);
    if (system.some((b: any) => carriesNotice(b?.text))) return body;
    return { ...body, system: [...system, { text: stripNotice(blocked, taintedBy) }] };
  },
  nestedInvokedTools() { return []; },
  invokedTools(payload) {
    if (payload?.output?.message) return converseCalls(payload.output.message);
    return anthropicAdapter.invokedTools(payload).filter((id) => id !== functionTool(PLACEHOLDER_TOOL));
  },
  invokedToolsFromChunk(chunk) { return chunkTools(chunk); },
  invokedToolsFromStream(text) {
    const out: ToolIdentity[] = [];
    for (const line of String(text ?? '').split('\n')) {
      const payload = (line.startsWith('data:') ? line.slice(5) : line).trim();
      if (!payload.startsWith('{')) continue;
      try { out.push(...chunkTools(JSON.parse(payload))); } catch { /* partial frame */ }
    }
    return out;
  },
  resultSources(body) {
    if (isAnthropic(body)) return anthropicAdapter.resultSources(body);
    const calls = new Map<string, ResultSource>();
    const out: ResultSource[] = [];
    for (const m of arr(body?.messages)) for (const b of arr(m?.content)) {
      const use = b?.toolUse; const result = b?.toolResult;
      if (use && str(use.toolUseId) && str(use.name)) calls.set(use.toolUseId, { identity: functionTool(use.name), args: () => JSON.stringify(use.input ?? {}) });
      else if (result) { const id = str(result.toolUseId); out.push((id && calls.get(id)) || { identity: UNKNOWN_SOURCE, args: '' }); }
    }
    return out;
  },
  rejectionBody(message) { return { message }; },
  rejectionHeaders() { return { 'x-amzn-ErrorType': 'AccessDeniedException' }; }
};
