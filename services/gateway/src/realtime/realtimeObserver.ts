import type { RawData } from 'ws';
import type { UsageMetrics } from '../types/usage';
import { functionTool } from '../toolGovernance/identity';
import type { ToolIdentity } from '../toolGovernance/identity';

/** The `response.usage` object of a Realtime `response.done` event (only the fields the gateway reads). */
export interface RealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

export type RealtimeFrame =
  | { kind: 'session.created'; sessionId: string | null }
  | { kind: 'response.created'; responseId: string | null }
  | { kind: 'response.done'; responseId: string | null; usage: RealtimeUsage | null }
  | { kind: 'error'; error: unknown }
  | { kind: 'other' };

export function rawToString(data: RawData | string): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
  return Buffer.from(data as Buffer).toString('utf8');
}

/**
 * Classifies one upstream frame for the observer. Only text frames are parsed and only four event
 * types matter; everything else — binary audio, other events, non-JSON — is `other`. Never throws.
 */
export function classifyFrame(data: RawData | string, isBinary: boolean): RealtimeFrame {
  if (isBinary) return { kind: 'other' };
  let event: any;
  try { event = JSON.parse(rawToString(data)); } catch { return { kind: 'other' }; }
  if (!event || typeof event !== 'object') return { kind: 'other' };
  switch (event.type) {
    case 'session.created':
      return { kind: 'session.created', sessionId: typeof event.session?.id === 'string' ? event.session.id : null };
    case 'response.created':
      return { kind: 'response.created', responseId: typeof event.response?.id === 'string' ? event.response.id : null };
    case 'response.done': {
      const usage = event.response?.usage;
      return {
        kind: 'response.done',
        responseId: typeof event.response?.id === 'string' ? event.response.id : null,
        usage: usage && typeof usage === 'object' ? usage : null,
      };
    }
    case 'error':
      return { kind: 'error', error: event.error };
    default:
      return { kind: 'other' };
  }
}

function parseJson(data: RawData | string): any | null {
  try { return JSON.parse(rawToString(data)); } catch { return null; }
}

/** Client `session.update` frames declare the session's function tools (monitor only; spec §7). */
export function declaredToolsFromSessionUpdate(data: RawData | string): ToolIdentity[] {
  const f = parseJson(data);
  if (f?.type !== 'session.update') return [];
  const tools = Array.isArray(f.session?.tools) ? f.session.tools : [];
  return tools.filter((t: any) => t?.type === 'function' && typeof t.name === 'string').map((t: any) => functionTool(t.name));
}

/** Upstream `response.done` frames list the calls the model made. */
export function invokedToolsFromResponseDone(data: RawData | string): ToolIdentity[] {
  const f = parseJson(data);
  if (f?.type !== 'response.done') return [];
  const output = Array.isArray(f.response?.output) ? f.response.output : [];
  return output.filter((i: any) => i?.type === 'function_call' && typeof i.name === 'string').map((i: any) => functionTool(i.name));
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const clamp = (v: number, max: number): number => Math.min(Math.max(v, 0), max);

/**
 * One usage record per `response.done` (spec 2026-09-15-audio-token-split-design.md §1).
 * `inputTokens` is the full-rate share (input minus cached), as every chat route emits it, so the
 * admin prices cached tokens once. Audio tokens are a subset of each total: the split never
 * changes `inputTokens`/`outputTokens`, only how the admin prices them. Cached audio counts as
 * cached, not as audio (decision 1), so it is subtracted from the audio input share.
 */
export function usageMetricsFromResponseDone(usage: RealtimeUsage, startTime: number): UsageMetrics {
  const details = usage.input_token_details;
  const cached = count(details?.cached_tokens);
  const cachedAudio = count(details?.cached_tokens_details?.audio_tokens);
  const inputTokens = Math.max(0, count(usage.input_tokens) - cached);
  const outputTokens = count(usage.output_tokens);
  return {
    startTime,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cached,
    audioInputTokens: clamp(count(details?.audio_tokens) - cachedAudio, inputTokens),
    audioOutputTokens: clamp(count(usage.output_token_details?.audio_tokens), outputTokens),
  };
}
