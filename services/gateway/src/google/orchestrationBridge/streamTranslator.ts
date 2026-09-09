/**
 * Orchestration stream chunks → Gemini `streamGenerateContent` SSE frames.
 *
 * The streaming half of the Gemini bridge's response side
 * (responseTranslator.ts serves the blocking call, and the two must not
 * disagree — they share `geminiFinishReason`, `usageMetadataFromOrchestration`
 * and `geminiFunctionCallPart`). Input is whatever
 * `sapAIService.streamChatCompletion` hands its `onChunk` callback:
 * `StreamChunk`, i.e. the V2 envelope (`final_result.choices[0].delta`,
 * `.finish_reason`, `final_result.usage`) plus gateway-internal markers
 * (`{ done: true }` for SSE's `[DONE]`, `{ error, message }` for a failure).
 * The Responses bridge's streamTranslator.ts consumes exactly the same chunks;
 * `projectStreamError` is imported from there rather than re-derived, so both
 * routes filter an upstream error identically.
 *
 * Stateful for one turn — a tool call spans chunks — so it is a factory.
 * Otherwise pure: it returns SSE text for the controller to write and touches
 * no response object. `usage()` is what the controller meters.
 *
 * Frame shape follows a real Gemini stream: every frame is a whole
 * `GenerateContentResponse`, and `finishReason`/`usageMetadata` appear on the
 * last one only. See spec section 6 "Translation rules (bridge)" → Stream.
 */
import { sseBlock } from '../../utils/sseFraming';
// The upstream-error allow-list lives in one place for both bridges: it is
// what keeps `intermediate_results` — the fully templated prompt — out of a
// client-facing failure frame. See its own security note.
import { projectStreamError } from '../../responses/orchestrationBridge/streamTranslator';
import { geminiError } from '../../services/googleGeminiService';
import { geminiFinishReason, geminiFunctionCallPart, usageMetadataFromOrchestration } from './responseTranslator';

export interface GeminiStreamTranslator {
  /** Zero or more complete SSE frames for one orchestration chunk. */
  onChunk(chunk: any): string[];
  /** Flushes an open tool call and emits the final frame if no chunk did. */
  finish(): string[];
  /** The last orchestration `usage` seen, for accounting. */
  usage(): any | null;
}

/** A tool call still accumulating deltas. Gemini needs no call id — only name and args. */
interface OpenToolCall {
  index: number;
  name: any;
  args: string;
}

export function createGeminiStreamTranslator(opts: { modelName: string }): GeminiStreamTranslator {
  let lastUsage: any = null;
  let finishReason: string | null = null;
  let sawToolCall = false;
  /** Set once the terminal frame has gone out, so it can never go out twice. */
  let terminalEmitted = false;
  /** Set by an error chunk: the turn ended, and nothing more may be emitted. */
  let failed = false;
  /**
   * Set by `finish()`, and read together with `terminalEmitted`: sapAIService's
   * `stream.on('error')` listener stays attached past the stream loop, so a
   * transport error can still arrive after the turn was closed — either by
   * `finish()` or, earlier, by the chunk that carried `finish_reason`. Neither
   * may append an error frame to a stream the client already saw end.
   */
  let finished = false;
  let openCall: OpenToolCall | null = null;

  /**
   * One frame. `terminal` adds the two fields a Gemini client reads off the
   * last chunk of a stream: `finishReason` on the candidate and `usageMetadata`
   * alongside it. Usage is zero-filled rather than omitted when SAP reported
   * none, because a real Gemini final chunk always carries the object —
   * `usage()` still returns null, so accounting is not fooled by the zeros.
   */
  const frame = (parts: any[], terminal: boolean): string => sseBlock({
    candidates: [{
      content: { role: 'model', parts },
      ...(terminal ? { finishReason: geminiFinishReason(finishReason, sawToolCall) } : {}),
      index: 0,
    }],
    ...(terminal ? { usageMetadata: usageMetadataFromOrchestration(lastUsage) } : {}),
    modelVersion: opts.modelName,
  });

  /** The accumulated call as a finished `functionCall` part; clears the slot. */
  const closeOpenCall = (): any => {
    const call = openCall as OpenToolCall;
    openCall = null;
    return geminiFunctionCallPart(call.name, call.args);
  };

  return {
    onChunk(chunk: any): string[] {
      // A failure arrives as a chunk carrying `error` and nothing else — SAP's
      // own `{error:{code,message,location,request_id,intermediate_results}}`,
      // or the gateway's transport error `{error: true, message}` — so every
      // branch below would be a no-op for it and the turn would end silently:
      // a closed socket after a few text frames reads to a Gemini client as a
      // complete but truncated answer. One error frame in Gemini's REST shape
      // says why instead. A tool call still accumulating is dropped rather
      // than flushed: the client must not act on a call from a turn the model
      // never finished.
      const rawError = chunk?.error ?? chunk?.final_result?.error;
      if (rawError) {
        if (failed || finished || terminalEmitted) return [];
        failed = true;
        const projected = projectStreamError(rawError, typeof chunk?.message === 'string' ? chunk.message : undefined);
        // `code` is SAP's own when it sent a numeric one, then the chunk-level
        // HTTP status, then 502 — the same fallback the Responses bridge
        // records for an upstream failure that named no code.
        const code = projected?.code ?? (typeof chunk?.status === 'number' ? chunk.status : 502);
        return [sseBlock(geminiError(code, projected?.message ?? 'orchestration stream failed'))];
      }
      if (failed) return [];

      // sapAIService delivers the envelope wrapped in `final_result`; the
      // blocking sibling unwraps the same way, and both accept it bare.
      const body = chunk?.final_result ?? chunk ?? {};
      const choice = body?.choices?.[0];
      const delta = choice?.delta ?? {};

      // Recorded before the terminal guard: SAP puts usage on the chunk that
      // also carries `finish_reason` (measured — see the streaming capture in
      // test/fixtures/orchestration/cache-probe-result.md), but a variant that
      // sent it one chunk later must still meter exactly.
      if (body.usage) lastUsage = body.usage;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (terminalEmitted) return [];

      // Everything this chunk contributes to the stream. Collected rather than
      // emitted one part at a time so that a chunk which both delivers text and
      // ends the turn produces ONE frame carrying both, the way a real Gemini
      // stream ends — not a text frame followed by an empty terminal one.
      const parts: any[] = [];

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        parts.push({ text: delta.content });
      }

      // `delta.reasoning_content` (the shape the Responses bridge accumulates)
      // is deliberately not read: the spec drops reasoning on this route, and
      // Gemini's own thought parts are a different shape a client would render
      // as the answer.

      for (const call of delta.tool_calls || []) {
        const index = call?.index ?? 0;
        // Orchestration streams tool calls one at a time, in index order, so a
        // new index is the moment the previous call is complete — that is what
        // lets a Gemini client receive a whole `functionCall` part mid-stream
        // instead of waiting for the turn to end. An index that came back
        // would open a second call rather than reopening the closed one.
        if (openCall && index !== openCall.index) parts.push(closeOpenCall());
        if (!openCall) openCall = { index, name: undefined, args: '' };
        sawToolCall = true;
        if (call?.function?.name) openCall.name = call.function.name;
        if (call?.function?.arguments) openCall.args += call.function.arguments;
      }

      if (finishReason) {
        if (openCall) parts.push(closeOpenCall());
        terminalEmitted = true;
        return [frame(parts, true)];
      }
      return parts.length > 0 ? [frame(parts, false)] : [];
    },

    finish(): string[] {
      // Latch first, so a transport error arriving after this call finds the
      // turn already closed — see `finished`.
      finished = true;
      // The error frame already ended this turn, or a chunk carrying
      // `finish_reason` already emitted the terminal frame.
      if (failed || terminalEmitted) return [];
      terminalEmitted = true;
      const parts: any[] = [];
      if (openCall) parts.push(closeOpenCall());
      return [frame(parts, true)];
    },

    usage(): any | null {
      return lastUsage;
    },
  };
}
