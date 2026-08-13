/**
 * Accumulating a web_search tool call out of an Anthropic SSE stream.
 *
 * The upstream deployment does not know about server tools: webSearchPlugin's
 * before-handler rewrites `web_search_20250305` into an ordinary `web_search`
 * function tool, so what arrives is a plain `tool_use` block whose input streams
 * as `input_json_delta` fragments. This module turns those fragments back into a
 * query, and tells the caller which frames must NOT reach the client — a raw
 * tool_use for a tool the client never declared is exactly what Claude Code
 * cannot make sense of today.
 */
import { describe, it, expect } from '@jest/globals';
import { createWebSearchInterceptor } from '../src/plugins/webSearch/anthropicStreamInterceptor';

function toolUseStart(index: number, id = 'toolu_1', name = 'web_search') {
  return { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } };
}
function jsonDelta(index: number, partial: string) {
  return { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } };
}

describe('createWebSearchInterceptor', () => {
  it('accumulates a split input_json_delta into one query and holds every frame of the block', () => {
    const i = createWebSearchInterceptor();
    expect(i.observe(toolUseStart(0))).toBe('hold');
    expect(i.observe(jsonDelta(0, '{"que'))).toBe('hold');
    expect(i.observe(jsonDelta(0, 'ry": "zig version"}'))).toBe('hold');
    expect(i.observe({ type: 'content_block_stop', index: 0 })).toBe('hold');

    expect(i.takePending()).toEqual({ toolUseId: 'toolu_1', query: 'zig version', blockIndex: 0 });
  });

  it('returns the pending call only once', () => {
    const i = createWebSearchInterceptor();
    i.observe(toolUseStart(0));
    i.observe(jsonDelta(0, '{"query":"x"}'));
    i.observe({ type: 'content_block_stop', index: 0 });

    expect(i.takePending()).not.toBeNull();
    expect(i.takePending()).toBeNull();
  });

  it('passes through blocks that are not the web_search tool', () => {
    const i = createWebSearchInterceptor();
    expect(i.observe({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })).toBe('pass');
    expect(i.observe({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })).toBe('pass');
    expect(i.observe({ type: 'content_block_stop', index: 0 })).toBe('pass');
    expect(i.takePending()).toBeNull();
  });

  it('passes through a tool_use for a DIFFERENT tool, which belongs to the client', () => {
    const i = createWebSearchInterceptor();
    expect(i.observe(toolUseStart(0, 'toolu_9', 'Bash'))).toBe('pass');
    expect(i.observe(jsonDelta(0, '{"command":"ls"}'))).toBe('pass');
    expect(i.observe({ type: 'content_block_stop', index: 0 })).toBe('pass');
    expect(i.takePending()).toBeNull();
  });

  it('yields no pending call when the accumulated input is not valid JSON, and still holds every frame', () => {
    // A truncated stream must not produce a search for a half-parsed query —
    // and, just as importantly, must not fall through to 'pass' either.
    // "can't parse it, so there's nothing to hide, forward it raw" would leak
    // the truncated tool_use straight to a client that never declared the tool.
    const i = createWebSearchInterceptor();
    expect(i.observe(toolUseStart(0))).toBe('hold');
    expect(i.observe(jsonDelta(0, '{"query": "unterm'))).toBe('hold');
    expect(i.observe({ type: 'content_block_stop', index: 0 })).toBe('hold');
    expect(i.takePending()).toBeNull();
  });

  it('tracks the right block when a text block precedes the tool call', () => {
    const i = createWebSearchInterceptor();
    expect(i.observe({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })).toBe('pass');
    expect(i.observe({ type: 'content_block_stop', index: 0 })).toBe('pass');
    expect(i.observe(toolUseStart(1))).toBe('hold');
    expect(i.observe(jsonDelta(1, '{"query":"q"}'))).toBe('hold');
    expect(i.observe({ type: 'content_block_stop', index: 1 })).toBe('hold');
    expect(i.takePending()).toEqual({ toolUseId: 'toolu_1', query: 'q', blockIndex: 1 });
  });

  it('holds every frame of an interleaved web_search block, even when a second one starts before the first stops', () => {
    // Anthropic can interleave content blocks (parallel tool calls): a second
    // web_search tool_use may open before the first one's content_block_stop
    // arrives. A single "current block" slot would be clobbered by the second
    // start, so the first block's later delta/stop frames would fail the
    // index check and fall through to 'pass' — leaking a raw tool_use to a
    // client that never declared the tool. Both blocks must stay held
    // start-to-finish regardless of how they interleave.
    const i = createWebSearchInterceptor();
    expect(i.observe(toolUseStart(0, 'toolu_1'))).toBe('hold');
    expect(i.observe(toolUseStart(1, 'toolu_2'))).toBe('hold');
    expect(i.observe(jsonDelta(0, '{"query":"first"}'))).toBe('hold');
    expect(i.observe(jsonDelta(1, '{"query":"second"}'))).toBe('hold');
    expect(i.observe({ type: 'content_block_stop', index: 0 })).toBe('hold');
    expect(i.observe({ type: 'content_block_stop', index: 1 })).toBe('hold');

    expect(i.takePending()).toEqual({ toolUseId: 'toolu_1', query: 'first', blockIndex: 0 });
    expect(i.takePending()).toEqual({ toolUseId: 'toolu_2', query: 'second', blockIndex: 1 });
  });

  it('queues a second completed web_search call in the same turn rather than dropping it', () => {
    // A single pending "slot" overwritten by the second content_block_stop
    // before the first is read would silently discard a search that ran.
    // Draining once here, after both calls finished, must still surface both.
    const i = createWebSearchInterceptor();
    i.observe(toolUseStart(0, 'toolu_1'));
    i.observe(jsonDelta(0, '{"query":"first"}'));
    i.observe({ type: 'content_block_stop', index: 0 });

    i.observe(toolUseStart(1, 'toolu_2'));
    i.observe(jsonDelta(1, '{"query":"second"}'));
    i.observe({ type: 'content_block_stop', index: 1 });

    expect(i.takePending()).toEqual({ toolUseId: 'toolu_1', query: 'first', blockIndex: 0 });
    expect(i.takePending()).toEqual({ toolUseId: 'toolu_2', query: 'second', blockIndex: 1 });
    expect(i.takePending()).toBeNull();
  });
});
