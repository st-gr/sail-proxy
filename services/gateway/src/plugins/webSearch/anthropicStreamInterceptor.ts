/**
 * Reassemble a `web_search` tool call from an Anthropic SSE stream.
 *
 * webSearchPlugin's before-handler rewrites Anthropic's `web_search_20250305`
 * server tool into an ordinary function tool, because the SAP deployment has no
 * server-side tools. The model therefore emits a plain `tool_use` block whose
 * input arrives as `input_json_delta` fragments. Those frames must be WITHHELD:
 * forwarding them hands the client a call for a tool it never declared, which is
 * exactly today's bug (Claude Code sees the raw tool_use, no result block, and
 * no search count).
 *
 * State is per request. `observe` is called for every parsed frame in order.
 *
 * Contract — block tracking: web_search blocks are tracked BY INDEX in a map,
 * not in a single "current" slot. Anthropic content blocks can interleave
 * (e.g. parallel tool calls): a second web_search tool_use may open before the
 * first one's content_block_stop arrives. Keying state on the block's own
 * index means every frame belonging to a held web_search block is held no
 * matter how blocks interleave — an in-progress block's index is never
 * clobbered by another block starting, so its later delta/stop frames can
 * never fall through to 'pass' and leak a raw tool_use to the client.
 *
 * Contract — multiple pending calls: more than one web_search block can
 * complete within a single turn (parallel tool calls). Completed calls queue
 * in `takePending()` in the order their content_block_stop frames were
 * observed; each call to `takePending()` dequeues one. A caller that drains
 * it only once per turn, rather than after every observed frame, will still
 * see every call — nothing is overwritten or dropped.
 */

const WEB_SEARCH_TOOL_NAME = 'web_search';

export interface PendingSearch {
  toolUseId: string;
  query: string;
  blockIndex: number;
}

export interface WebSearchInterceptor {
  observe(frame: any): 'hold' | 'pass';
  takePending(): PendingSearch | null;
}

interface BlockState {
  toolUseId: string;
  accumulated: string;
}

export function createWebSearchInterceptor(): WebSearchInterceptor {
  /** web_search blocks currently being accumulated, keyed by their own block index. */
  const activeBlocks = new Map<number, BlockState>();
  const pendingQueue: PendingSearch[] = [];

  return {
    observe(frame: any): 'hold' | 'pass' {
      const type = frame?.type;

      if (type === 'content_block_start') {
        const block = frame.content_block || {};
        if (block.type === 'tool_use' && block.name === WEB_SEARCH_TOOL_NAME) {
          activeBlocks.set(frame.index, { toolUseId: block.id, accumulated: '' });
          return 'hold';
        }
        return 'pass';
      }

      const index = frame?.index;
      const state = activeBlocks.get(index);
      if (!state) return 'pass';

      if (type === 'content_block_delta') {
        if (frame.delta?.type === 'input_json_delta') {
          state.accumulated += frame.delta.partial_json ?? '';
        }
        return 'hold';
      }

      if (type === 'content_block_stop') {
        // A truncated stream leaves `accumulated` unparseable. Yield nothing
        // rather than searching for a half-read query — the frames stay held
        // either way, so a malformed call is dropped, never forwarded raw.
        try {
          const input = JSON.parse(state.accumulated);
          if (typeof input?.query === 'string' && input.query.length > 0) {
            pendingQueue.push({ toolUseId: state.toolUseId, query: input.query, blockIndex: index });
          }
        } catch {
          /* not valid JSON — no pending call */
        }
        activeBlocks.delete(index);
        return 'hold';
      }

      return 'pass';
    },

    takePending(): PendingSearch | null {
      return pendingQueue.length > 0 ? pendingQueue.shift()! : null;
    },
  };
}
