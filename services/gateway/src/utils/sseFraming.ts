/**
 * Shared SSE block framing for the Responses-route `res.write` interceptors.
 *
 * A plugin that rewrites frames on a live Responses stream has the same three problems
 * every time: `res.write` boundaries have nothing to do with SSE block boundaries, a
 * block's payload is one `data: ` line among possibly several lines, and a block whose
 * frame was NOT rewritten has to reach the client byte-for-byte identical. These four
 * helpers are that machinery, extracted from `responsesWebSearchPlugin` (where they were
 * module-private and revised across three phases) once a second interceptor —
 * `responsesNamespaceToolsPlugin`'s — needed exactly the same behavior. A second copy of
 * framing logic that subtle is a bug waiting to happen, so there is only one.
 *
 * Pure: no I/O, no config, no logging, no state. Every interceptor keeps its own `tail`.
 *
 * @see plugins/responsesWebSearchPlugin.ts - suppress/inject/continuation interceptor
 * @see plugins/responsesNamespaceToolsPlugin.ts - namespace re-nesting interceptor
 */

/**
 * The terminal event types that end a Responses turn: each carries the full final
 * `response.output` array and the turn's `usage`.
 *
 * `.incomplete` is not an edge case — it is what a deployment sends when
 * `max_output_tokens` is hit mid-turn, and Codex CLI sets `max_output_tokens` on every
 * request. Matching `response.completed` alone once billed such a turn zero tokens.
 *
 * Exported `ReadonlySet` deliberately: this is module-level state shared by two res.write
 * interceptors and the controller, all of which only ever call `.has()`. Handing three
 * consumers a mutable Set is a foot-gun with no upside.
 */
export const TERMINAL_RESPONSE_TYPES: ReadonlySet<string> =
  new Set(['response.completed', 'response.incomplete', 'response.failed']);

/**
 * Re-frame arbitrary write boundaries into whole `data: {json}\n\n` blocks.
 *
 * `tail` is whatever came after the last complete block and MUST be carried into the next
 * call's `pending` — a frame split across two writes is the normal case, not an edge one.
 */
export function splitBlocks(pending: string): { blocks: string[]; tail: string } {
  const parts = pending.split('\n\n');
  const tail = parts.pop() ?? '';
  return { blocks: parts.map(p => `${p}\n\n`), tail };
}

/** The parsed frame of a block, or null for a comment, keep-alive or unparseable payload. */
export function parseFrame(block: string): any | null {
  const line = block.split('\n').find(l => l.startsWith('data: '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(6));
  } catch {
    return null;
  }
}

/** Serialise a frame as a complete SSE block. */
export function sseBlock(frame: any): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/**
 * Rebuild an SSE block after a transformation may have rewritten its frame, preserving
 * every non-"data:" line (an `event:` or `id:` line, most commonly) from the original
 * block. Returns the original block completely unchanged, byte-for-byte, whenever the
 * transformation made no change — identity of `substitutedFrame` against `originalFrame`
 * is the signal, so a transformation that mutates in place must report its change some
 * other way. That is the common case for every stream the calling plugin does not care
 * about, so it must stay cheap and lossless.
 */
export function rebuildBlockWithSubstitution(rawBlock: string, originalFrame: any, substitutedFrame: any): string {
  if (substitutedFrame === originalFrame) return rawBlock;
  return rawBlock
    .split('\n')
    .map(line => (line.startsWith('data: ') ? `data: ${JSON.stringify(substitutedFrame)}` : line))
    .join('\n');
}
