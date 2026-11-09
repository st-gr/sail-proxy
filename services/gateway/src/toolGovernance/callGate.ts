/**
 * The call gate: stops a tool call the policy forbids before the client can execute it.
 *
 * Declaration-side strip covers every tool a request declares. It cannot cover a tool the client
 * hosts itself and reaches inside its own container tool - codex writes a program for `exec` that
 * calls `tools.mcp__server__tool`, and that tool never appears in the request. The model's CALL,
 * though, passes through this gateway on its way back, so that is where such a call is stopped.
 *
 * What the gate does NOT do: it never edits the arguments of a call, and it never removes a nested
 * call from inside a program. The granularity is the whole container call, because a denied
 * identifier sits in code that may also do legitimate work. A suppressed call is replaced by a
 * message saying so, so the turn stays valid for the client rather than ending in a silent gap.
 *
 * Streaming is the delicate part. The denied identifier only becomes visible once the call's
 * arguments are complete, so every frame belonging to a container call is HELD until then and
 * either flushed untouched or dropped in favour of the refusal. Frames that belong to anything else
 * pass through byte for byte, including across chunk boundaries.
 */
import { isContainerTool, nestedCallsIn } from './mcpNaming';
import type { ResolvedConvention } from './mcpNaming';
import { deniedBy } from './evaluate';
import type { ToolIdentity, ToolPolicyBlock } from './identity';

export const REFUSAL_PREFIX = '[tool policy] Refused:';

const str = (v: any): string => (typeof v === 'string' ? v : '');

/** The denied MCP tools a container call reaches; `[]` for anything else. */
export function deniedNestedIn(item: any, convention: ResolvedConvention, blocks: ToolPolicyBlock[]): ToolIdentity[] {
  if (!item || blocks.length === 0 || !isContainerTool(str(item.name), convention)) return [];
  const body = str(item.arguments) || str(item.input);
  return nestedCallsIn(body, convention).filter((identity) => blocks.some((b) => deniedBy(b, identity)));
}

const refusalText = (identities: ToolIdentity[]): string =>
  `${REFUSAL_PREFIX} this call reaches ${identities.join(', ')}, which the tool policy does not permit,`
  + ` so it was not executed. Do not try again; tell the user it is not permitted.`;

/** The message item that replaces a suppressed call, in the shape the Responses API uses. */
export function refusalItem(itemId: string, identities: ToolIdentity[]): any {
  return {
    id: `${itemId}_refused`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: refusalText(identities), annotations: [] }]
  };
}

/** Non-streaming: a denied container call in `output` becomes a refusal message. */
export function gateResponseBody(
  payload: any, convention: ResolvedConvention, blocks: ToolPolicyBlock[]
): { body: any; suppressed: ToolIdentity[] } {
  const items = Array.isArray(payload?.output) ? payload.output : null;
  if (!items || blocks.length === 0 || convention.containerTools.length === 0) return { body: payload, suppressed: [] };
  const suppressed: ToolIdentity[] = [];
  const output = items.map((item: any) => {
    const found = deniedNestedIn(item, convention, blocks);
    if (found.length === 0) return item;
    for (const identity of found) if (!suppressed.includes(identity)) suppressed.push(identity);
    return refusalItem(str(item.id) || 'call', found);
  });
  return suppressed.length === 0 ? { body: payload, suppressed } : { body: { ...payload, output }, suppressed };
}

interface Frame { raw: string; event: any; }

/** Splits the buffer into whole SSE frames, leaving any partial tail behind. */
function takeFrames(buffer: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf('\n\n');
    if (end === -1) break;
    const raw = rest.slice(0, end + 2);
    rest = rest.slice(end + 2);
    let event: any = null;
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { event = JSON.parse(payload); } catch { /* not JSON: forwarded untouched */ }
    }
    frames.push({ raw, event });
  }
  return { frames, rest };
}

const itemIdOf = (event: any): string =>
  str(event?.item_id) || str(event?.item?.id) || '';

/**
 * A stateful filter over the upstream SSE bytes. `push` returns what may be forwarded now; `flush`
 * returns whatever was still held when the stream ended (a call whose arguments never completed is
 * forwarded rather than swallowed).
 */
export function createCallGate(convention: ResolvedConvention, blocks: ToolPolicyBlock[]) {
  const active = convention.containerTools.length > 0 && blocks.length > 0;
  const suppressed: ToolIdentity[] = [];
  const held = new Map<string, { name: string; frames: string[] }>();   // item id -> its own frames, waiting for the arguments
  const dropped = new Map<string, ToolIdentity[]>();   // item id -> what it was refused for
  let buffer = '';

  const record = (identities: ToolIdentity[]): void => {
    for (const identity of identities) if (!suppressed.includes(identity)) suppressed.push(identity);
  };

  /** The terminal frame lists the turn's items: a dropped call is replaced there too. */
  const rewriteCompleted = (frame: Frame): string => {
    const items = frame.event?.response?.output;
    if (!Array.isArray(items) || dropped.size === 0) return frame.raw;
    const output = items.map((item: any) => {
      const found = dropped.get(str(item?.id));
      return found ? refusalItem(str(item.id) || 'call', found) : item;
    });
    const event = { ...frame.event, response: { ...frame.event.response, output } };
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  };

  const refusalFrames = (itemId: string, identities: ToolIdentity[]): string => {
    const item = refusalItem(itemId, identities);
    const emit = (event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    return emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } })
      + emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text })
      + emit({ type: 'response.output_item.done', output_index: 0, item });
  };

  return {
    push(chunk: string): string {
      if (!active) return chunk;
      buffer += chunk;
      const { frames, rest } = takeFrames(buffer);
      buffer = rest;
      let out = '';
      for (const frame of frames) {
        const event = frame.event;
        const type = str(event?.type);
        const id = itemIdOf(event);

        if (type === 'response.output_item.added' && isContainerTool(str(event?.item?.name), convention)) {
          held.set(id, { name: str(event.item.name), frames: [frame.raw] });   // hold until the arguments are complete
          continue;
        }
        // Once a call is dropped, every later frame of its own is dropped too: the arguments and
        // the item itself both still carry the identifier that was refused.
        if (id && dropped.has(id) && type !== 'response.completed' && type !== 'response.incomplete') continue;
        if (id && held.has(id)) {
          const call = held.get(id)!;
          call.frames.push(frame.raw);
          // The verdict can be reached on the arguments frame or on the item itself, whichever the
          // upstream sends first; the container's own name comes from the frame that opened it.
          const item = type === 'response.output_item.done' ? event?.item
            : type === 'response.function_call_arguments.done' ? { name: call.name, arguments: event?.arguments }
            : null;
          if (!item) continue;                            // still accumulating deltas
          const found = deniedNestedIn(item, convention, blocks);
          if (found.length === 0) {
            if (type !== 'response.output_item.done') continue;   // wait for the item itself
            out += call.frames.join('');
            held.delete(id);
            continue;
          }
          record(found);
          dropped.set(id, found);
          held.delete(id);
          out += refusalFrames(id, found);
          continue;
        }
        if (type === 'response.completed' || type === 'response.incomplete') {
          out += rewriteCompleted(frame);
          continue;
        }
        out += frame.raw;
      }
      return out;
    },
    /** Anything still held when the stream ends is forwarded: never swallow an undecided call. */
    flush(): string {
      if (!active) return '';
      let out = '';
      for (const call of held.values()) out += call.frames.join('');
      held.clear();
      out += buffer;
      buffer = '';
      return out;
    },
    suppressed(): ToolIdentity[] { return [...suppressed]; }
  };
}
