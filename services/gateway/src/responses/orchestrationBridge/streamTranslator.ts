/**
 * Orchestration stream chunks → Responses SSE frames.
 *
 * codex reads the Responses event stream, so a turn must open with
 * `response.created`, wrap text in item/content-part frames, and close with
 * exactly one `response.completed`. Orchestration gives us chat deltas, which
 * carry none of that structure — this module supplies it.
 *
 * Framing reuses `sseBlock` from `utils/sseFraming` rather than rolling its own:
 * a real captured Responses frame is a bare `data: {json}\n\n` block with no
 * `event:` line (see responsesController's `extractStreamUsage` and the
 * `sseBlock` call sites in `hostedTool/engine.ts`) — an `event:` line would be
 * Anthropic's wire format, not this one, and a second copy of framing logic is
 * exactly the bug `sseFraming.ts` was extracted to prevent.
 *
 * Stateful for one turn, so it is a factory rather than free functions. Pure
 * otherwise: it returns SSE text for the caller to write, and touches no
 * response object itself.
 */
import * as crypto from 'crypto';
import { sseBlock } from '../../utils/sseFraming';
// The SAME mappings the blocking sibling uses. These two describe one turn and must not
// disagree about how it ended, nor about what it cost — see statusForFinishReason's and
// translateUsage's own comments.
import { statusForFinishReason, translateUsage } from './responseTranslator';

function itemId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export interface StreamTranslatorOptions {
  model: string;
  responseId: string;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

export function createResponsesStreamTranslator(opts: StreamTranslatorOptions) {
  let seq = 0;
  let opened = false;
  let textOpen = false;
  let text = '';
  let messageItemId = '';
  /**
   * Reasoning arrives BEFORE the answer, incrementally, as
   * `delta.reasoning_content: [{content, signature}]` — measured, see the
   * "Streamed `reasoning_content`" section of
   * test/fixtures/orchestration/reasoning-probe-results.md. Each text delta
   * carries an EMPTY signature and one terminal delta carries the whole thing;
   * the signature is not emitted either way (see `reasoningOutputItem`), so
   * only the text is accumulated here.
   */
  let reasoningText = '';
  let reasoningItemId = '';
  let reasoningClosed = false;
  /**
   * The message's `output_index`. Not a constant 0: when the model thinks, the
   * reasoning item takes index 0 and the message follows at 1 — the order the
   * deployed route emits (its reasoning item is `output_index: 0`, ahead of the
   * message). Fixed at the moment the message opens, by which time it is known
   * whether reasoning came first, and reused by every later message frame so
   * the `added`/`delta`/`done` run cannot disagree with itself.
   */
  let messageIndex = 0;
  let usage: any = null;
  /** The last non-null `finish_reason` any chunk carried. Decides the terminal frame. */
  let finishReason: string | null = null;
  const toolCalls = new Map<number, ToolCallAccumulator>();

  const block = (frame: any): string => sseBlock({ ...frame, sequence_number: seq++ });

  /**
   * `usage` from the last chunk that carried it, or undefined if none ever did.
   * `finish()` passes `zeroFillIfMissing: true` because `response.completed` is
   * terminal — real Responses semantics say a terminal frame always carries
   * usage (see `responseTranslator.ts`), and `JSON.stringify` would otherwise
   * drop the key outright, leaving codex to dereference `usage.input_tokens`
   * off `undefined`. `response.created`/`response.in_progress` stay `undefined`
   * on purpose: they are not terminal, usage genuinely is not known yet, and no
   * client reads usage off an in-progress frame.
   */
  const responseEnvelope = (status: string, output: any[], zeroFillIfMissing = false): any => ({
    id: opts.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: opts.model,
    status,
    ...(status === 'incomplete'
      ? { incomplete_details: statusForFinishReason(finishReason).incomplete }
      : {}),
    output,
    // Must agree with responseTranslator.ts's usage shape — a client reading
    // either path reads the same fields (previously established by review). It
    // is now literally the same function, so the two cannot drift: the exclusive
    // -> inclusive conversion and the zero-fill both live in translateUsage, and
    // the zero-fill is just translateUsage of nothing.
    usage: usage
      ? translateUsage(usage)
      : zeroFillIfMissing
        ? translateUsage(undefined)
        : undefined,
    error: null,
  });

  /**
   * The finished reasoning item, or null if the model never thought.
   *
   * Built here rather than at either call site because both need it: the text
   * path closes reasoning as soon as the answer starts, and `finish()` closes
   * a turn that thought and then produced only a tool call, or nothing.
   *
   * A summary that trims to nothing yields an item with an EMPTY summary
   * rather than no item at all — once `added` has gone out, index 0 is spoken
   * for and the message has already been shifted to 1, so dropping it would
   * leave a client with an item that opened and never closed.
   */
  const reasoningItem = (): any | null => {
    if (!reasoningItemId) return null;
    const summaryText = reasoningText.trim();
    return {
      type: 'reasoning', id: reasoningItemId,
      summary: summaryText.length > 0 ? [{ type: 'summary_text', text: summaryText }] : [],
      content: [],
    };
  };

  /**
   * Close the reasoning summary and then the item, at most once.
   *
   * The summary's `text`/`part.done` frames go out BEFORE the item's, mirroring
   * how the message path closes its content part before its own item — a client
   * that tracks parts should never see the owning item close first.
   */
  const closeReasoning = (out: string[]): any | null => {
    const item = reasoningItem();
    if (!item || reasoningClosed) return item;
    reasoningClosed = true;
    const summaryText = reasoningText.trim();
    if (summaryText.length > 0) {
      out.push(block({
        type: 'response.reasoning_summary_text.done',
        item_id: reasoningItemId, output_index: 0, summary_index: 0,
        text: summaryText,
      }));
      out.push(block({
        type: 'response.reasoning_summary_part.done',
        item_id: reasoningItemId, output_index: 0, summary_index: 0,
        part: { type: 'summary_text', text: summaryText },
      }));
    }
    out.push(block({ type: 'response.output_item.done', output_index: 0, item }));
    return item;
  };

  const open = (out: string[]): void => {
    if (opened) return;
    opened = true;
    out.push(block({ type: 'response.created', response: responseEnvelope('in_progress', []) }));
    out.push(block({ type: 'response.in_progress', response: responseEnvelope('in_progress', []) }));
  };

  return {
    onChunk(chunk: any): string[] {
      const out: string[] = [];
      const body = chunk?.final_result ?? chunk ?? {};
      const choice = body?.choices?.[0];
      const delta = choice?.delta ?? {};

      if (body.usage) usage = body.usage;
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      open(out);

      // Reasoning first, so its `added` frame precedes the message's and the
      // indices come out in the order the deployed route uses.
      if (Array.isArray(delta.reasoning_content)) {
        const chunkText = delta.reasoning_content
          .map((b: any) => (typeof b?.content === 'string' ? b.content : ''))
          .join('');
        if (chunkText.length > 0) {
          if (!reasoningItemId) {
            reasoningItemId = itemId('rs');
            // `added` carries an EMPTY summary because the text is still
            // streaming; the completed summary goes out on `done`. That is the
            // deployed route's own pattern — its reasoning `added` frame holds
            // a shorter `encrypted_content` than its `done` frame.
            out.push(block({
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'reasoning', id: reasoningItemId, summary: [], content: [] },
            }));
            out.push(block({
              type: 'response.reasoning_summary_part.added',
              item_id: reasoningItemId, output_index: 0, summary_index: 0,
              part: { type: 'summary_text', text: '' },
            }));
          }
          reasoningText += chunkText;
          // The frames codex actually RENDERS from. Emitting only the item
          // (added/done) delivers the reasoning — measured: codex ingests it
          // and replays our own summary_text back on the next turn — but shows
          // nothing, because its TUI is driven by the incremental frames. Its
          // binary carries the matching event variants `reasoning_summary_part_added`,
          // `reasoning_summary_delta` and `reasoning_summary_done`.
          out.push(block({
            type: 'response.reasoning_summary_text.delta',
            item_id: reasoningItemId, output_index: 0, summary_index: 0,
            delta: chunkText,
          }));
        }
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textOpen) {
          // Close reasoning BEFORE opening the message, so items close in the
          // order they opened. The deployed route does exactly this — its
          // captured frame run is reasoning added(0), reasoning done(0),
          // message added(1) — whereas holding reasoning open until finish()
          // produced added(0), added(1), done(0), done(1): an interleaving no
          // real server emits. Thinking always precedes the answer, so the
          // first text delta is the moment reasoning is known to be over.
          closeReasoning(out);
          textOpen = true;
          messageItemId = itemId('msg');
          messageIndex = reasoningItemId ? 1 : 0;
          out.push(block({
            type: 'response.output_item.added',
            output_index: messageIndex,
            item: { type: 'message', id: messageItemId, role: 'assistant', status: 'in_progress', content: [] },
          }));
          out.push(block({
            type: 'response.content_part.added',
            item_id: messageItemId, output_index: messageIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          }));
        }
        text += delta.content;
        out.push(block({
          type: 'response.output_text.delta',
          item_id: messageItemId, output_index: messageIndex, content_index: 0,
          delta: delta.content,
        }));
      }

      for (const call of delta.tool_calls || []) {
        const idx = call.index ?? 0;
        const acc = toolCalls.get(idx) || { id: '', name: '', args: '' };
        if (call.id) acc.id = call.id;
        if (call.function?.name) acc.name = call.function.name;
        if (call.function?.arguments) acc.args += call.function.arguments;
        toolCalls.set(idx, acc);
      }

      return out;
    },

    finish(): string[] {
      const out: string[] = [];
      open(out);
      const output: any[] = [];

      // Already closed by the text path on a turn that produced an answer;
      // this closes a turn that thought and then went straight to a tool call,
      // or stopped. Either way the item leads `output`, matching index 0.
      const reasoning = closeReasoning(out);
      if (reasoning) output.push(reasoning);

      if (textOpen) {
        out.push(block({
          type: 'response.output_text.done',
          item_id: messageItemId, output_index: messageIndex, content_index: 0, text,
        }));
        out.push(block({
          type: 'response.content_part.done',
          item_id: messageItemId, output_index: messageIndex, content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        }));
        const messageItem = {
          type: 'message', id: messageItemId, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
        output.push(messageItem);
        out.push(block({ type: 'response.output_item.done', output_index: messageIndex, item: messageItem }));
      }

      let index = output.length;
      for (const acc of toolCalls.values()) {
        const item = {
          type: 'function_call', id: itemId('fc'), call_id: acc.id,
          name: acc.name, arguments: acc.args, status: 'completed',
        };
        output.push(item);
        out.push(block({ type: 'response.output_item.added', output_index: index, item }));
        out.push(block({ type: 'response.output_item.done', output_index: index, item }));
        index += 1;
      }

      // The terminal EVENT follows the status, not the other way round: real OpenAI ends a
      // truncated or filtered turn with `response.incomplete`, and a `response.completed`
      // frame whose `response.status` says `incomplete` contradicts itself. Both types are
      // in TERMINAL_RESPONSE_TYPES, so every reader of this stream — the controller's usage
      // extractor and the hosted-tool engine alike — already recognises them equally, and
      // the engine correctly declines to continue a turn that did not finish.
      const { status } = statusForFinishReason(finishReason);
      out.push(block({
        type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
        response: responseEnvelope(status, output, true),
      }));
      return out;
    },
  };
}

/**
 * The same translator, driven by raw orchestration SSE *blocks* rather than
 * parsed chunks.
 *
 * `responsesController` reads orchestration through `sapAIService`, which parses
 * the wire for it and hands over decoded chunks — so it uses
 * `createResponsesStreamTranslator` directly. The hosted-tool engine does not:
 * it POSTs its continuation calls itself, with `responseType: 'stream'`, and so
 * holds the raw bytes. Without this adapter it would have to re-implement
 * orchestration's wire format (`data: {json}` blocks closed by `data: [DONE]`)
 * inside a plugin, which is exactly the second-translator duplication this
 * module exists to prevent.
 *
 * Returns Responses SSE blocks, ready for the engine's own frame pipeline.
 * A block that is a comment, a keep-alive, the `[DONE]` sentinel or simply
 * unparseable yields no frames rather than throwing: whatever else arrived on
 * that stream is still the round's answer.
 */
export function createOrchestrationBlockTranslator(opts: StreamTranslatorOptions) {
  const translator = createResponsesStreamTranslator(opts);

  return {
    onBlock(rawBlock: string): string[] {
      const line = rawBlock.split('\n').find((l) => l.startsWith('data:'));
      if (!line) return [];
      const data = line.slice(line.indexOf(':') + 1).trim();
      if (!data || data === '[DONE]') return [];
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        return [];
      }
      return translator.onChunk(chunk);
    },
    /** The closing frames for the turn. Always emitted, even if no block parsed. */
    finish(): string[] {
      return translator.finish();
    },
  };
}
