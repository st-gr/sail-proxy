import type { ToolIdentity } from '../identity';
import type { ResolvedConvention } from '../mcpNaming';

/**
 * A tool whose output is in the request, and the argument text of the call that produced it. The
 * text may be a function that renders it on demand: only a container tool's arguments are ever
 * read, so an adapter holding structured input need not stringify every historical call.
 */
export interface ResultSource { identity: ToolIdentity; args: string | (() => string); }

/** The argument text of a result source, rendered if it is lazy. */
export const argsText = (args: ResultSource['args']): string => (typeof args === 'function' ? args() : args);

/**
 * One adapter per API family: how a request declares tools, how a response reports the tools
 * the model invoked, and the family's own 403 body. Every function is pure over plain objects
 * and must never throw on a malformed body — return [] / null / the input instead.
 */
export interface ToolAdapter {
  family: 'anthropic' | 'openaiChat' | 'responses' | 'gemini' | 'bedrock';
  declaredTools(body: any): ToolIdentity[];
  /** The identity a tool_choice forces, or null for auto/any/none/absent. */
  forcedTool(body: any): ToolIdentity | null;
  /**
   * A NEW body without the blocked identities; the input is not mutated. `narrow` (server → tool
   * names) limits a bare MCP server declaration to those names (spec 2026-09-22 §2.2); families
   * without server-side MCP declarations ignore it.
   */
  stripTools(body: any, blocked: Set<ToolIdentity>, narrow?: Map<string, string[]>): any;
  /**
   * A NEW body whose system channel tells the model which tools were removed (strip mode only).
   * Empty `blocked`, or a body that already carries the note, returns the body unchanged.
   */
  noteStrippedTools(body: any, blocked: ToolIdentity[], taintedBy?: ToolIdentity[]): any;
  /** Invoked identities in a complete (non-streaming) response, one entry per call. */
  invokedTools(payload: any): ToolIdentity[];
  /**
   * MCP tools reached INSIDE a container tool's call, for a client that hosts its own servers
   * (codex's `exec`). Identifiers only: the call's arguments are never returned. `[]` for a family
   * or a client with no container tools. `payload` is the whole response, or the raw SSE text.
   */
  nestedInvokedTools(payload: any, convention: ResolvedConvention): ToolIdentity[];
  /** Invoked identities that START in one parsed stream chunk (deltas continuing a call yield []). */
  invokedToolsFromChunk(chunk: any): ToolIdentity[];
  /** Invoked identities in an accumulated raw SSE text (families whose controller keeps the text). */
  invokedToolsFromStream(text: string): ToolIdentity[];
  /**
   * The tools whose OUTPUT the request carries (spec 2026-09-22 §3.2), one entry per result, each
   * paired with the call that produced it. A result whose call is not in the request is
   * UNKNOWN_SOURCE. Raw identities: the middleware applies the client's naming convention.
   */
  resultSources(body: any): ResultSource[];
  rejectionBody(message: string): any;
  /** Extra response headers on the family's 403 (AWS SDKs read the error type from a header). */
  rejectionHeaders?(): Record<string, string>;
  /**
   * A reason to REFUSE the request instead of stripping `blocked`, when the stripped body would be one
   * the upstream rejects outright; null to strip as usual.
   */
  stripRefusal?(body: any, blocked: Set<ToolIdentity>): string | null;
}

export const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
export const str = (v: any): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Generic SSE walker: every `data: {json}` line parsed, non-JSON lines skipped. */
export function sseChunks(text: string): any[] {
  const out: any[] = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch { /* partial or non-JSON frame */ }
  }
  return out;
}
