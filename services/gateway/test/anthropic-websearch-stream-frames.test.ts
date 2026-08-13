/**
 * What api.anthropic.com actually emits for a streaming web_search turn.
 *
 * Captured 2026-08-07 through mitmproxy from real `claude` against
 * api.anthropic.com (claude-haiku-4-5-20251001, web_search_20250305). This test
 * does not exercise gateway code yet — it PINS the golden so the builders in
 * Task 2 have something to be measured against, and so a future fixture refresh
 * that silently changes shape fails here rather than in production.
 *
 * `encrypted_content` / `encrypted_index` are truncated in the fixture: they are
 * opaque Anthropic-signed blobs, and nothing asserts their value.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import {
  serverToolUseFrames, webSearchResultFrames, serverToolUseId,
} from '../src/plugins/webSearch/anthropicStreamFrames';

function loadGolden(): any[] {
  const p = path.join(__dirname, 'fixtures/anthropic/websearch-golden.stream.jsonl');
  return fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('anthropic web_search golden stream', () => {
  it('opens with a server_tool_use block whose input streams as input_json_delta', () => {
    const g = loadGolden();
    const start = g.find((f) => f.type === 'content_block_start' && f.index === 0);
    expect(start.content_block).toEqual({
      type: 'server_tool_use',
      id: expect.stringMatching(/^srvtoolu_/),
      name: 'web_search',
      input: {},
    });
    const deltas = g.filter((f) => f.type === 'content_block_delta' && f.index === 0);
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) expect(d.delta.type).toBe('input_json_delta');
    const joined = deltas.map((d) => d.delta.partial_json).join('');
    expect(JSON.parse(joined)).toHaveProperty('query');
  });

  it('follows it with a web_search_tool_result block keyed to that tool id', () => {
    const g = loadGolden();
    const use = g.find((f) => f.type === 'content_block_start' && f.index === 0)!.content_block;
    const result = g.find((f) => f.type === 'content_block_start' && f.index === 1)!.content_block;

    expect(result.type).toBe('web_search_tool_result');
    expect(result.tool_use_id).toBe(use.id);
    expect(result.caller).toEqual({ type: 'direct' });
    expect(Array.isArray(result.content)).toBe(true);
    for (const r of result.content) {
      expect(r.type).toBe('web_search_result');
      expect(Object.keys(r).sort()).toEqual(
        ['encrypted_content', 'page_age', 'title', 'type', 'url'].sort(),
      );
    }
  });

  it('reports the search count in message_delta.usage.server_tool_use', () => {
    const g = loadGolden();
    const delta = g.find((f) => f.type === 'message_delta');
    expect(delta.usage.server_tool_use).toEqual({
      web_search_requests: 1,
      web_fetch_requests: 0,
    });
  });

  it('emits the model answer as text blocks after the result block', () => {
    const g = loadGolden();
    const blocks = g
      .filter((f) => f.type === 'content_block_start')
      .map((f) => f.content_block.type);
    expect(blocks[0]).toBe('server_tool_use');
    expect(blocks[1]).toBe('web_search_tool_result');
    expect(blocks.slice(2).every((t) => t === 'text')).toBe(true);
    expect(blocks.slice(2).length).toBeGreaterThan(0);
  });
});

describe('anthropicStreamFrames', () => {
  it('builds a server_tool_use block that matches the golden start frame', () => {
    const frames = serverToolUseFrames('srvtoolu_test123', 'Zig current stable version', 0);
    expect(frames[0]).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'server_tool_use', id: 'srvtoolu_test123', name: 'web_search', input: {} },
    });
    const deltas = frames.filter((f: any) => f.type === 'content_block_delta');
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) expect(d.delta.type).toBe('input_json_delta');
    expect(JSON.parse(deltas.map((d: any) => d.delta.partial_json).join(''))).toEqual({
      query: 'Zig current stable version',
    });
    expect(frames[frames.length - 1]).toEqual({ type: 'content_block_stop', index: 0 });
  });

  it('builds a web_search_tool_result whose entries carry exactly the golden keys', () => {
    const frames = webSearchResultFrames('srvtoolu_test123', [
      {
        title: 'Zig Downloads', url: 'https://ziglang.org/download/', snippet: 'Zig 0.16.0', date: 'February 13, 2026',
      } as any,
      { title: 'Zig News', url: 'https://ziglang.org/news/', snippet: 'undated post' } as any,
    ], 1);

    const start = frames[0];
    expect(start.type).toBe('content_block_start');
    expect(start.index).toBe(1);
    expect(start.content_block.type).toBe('web_search_tool_result');
    expect(start.content_block.tool_use_id).toBe('srvtoolu_test123');
    expect(start.content_block.caller).toEqual({ type: 'direct' });

    const [dated, undated] = start.content_block.content;
    expect(Object.keys(dated).sort()).toEqual(
      ['encrypted_content', 'page_age', 'title', 'type', 'url'].sort(),
    );
    expect(dated.type).toBe('web_search_result');
    expect(dated.title).toBe('Zig Downloads');
    expect(dated.url).toBe('https://ziglang.org/download/');
    // page_age carries SearchResult.date verbatim — the one substantive mapping
    // decision this module makes. Pinned here so a regression to a hardcoded
    // null, or to the brief's nonexistent `r.page_age`, fails this assertion.
    expect(dated.page_age).toBe('February 13, 2026');

    // The golden also has entries with no known date: page_age must still be
    // PRESENT and null, not dropped from the object.
    expect(Object.keys(undated).sort()).toEqual(
      ['encrypted_content', 'page_age', 'title', 'type', 'url'].sort(),
    );
    expect(undated).toHaveProperty('page_age', null);

    expect(frames[frames.length - 1]).toEqual({ type: 'content_block_stop', index: 1 });
  });

  it('mints a distinct srvtoolu_ id each call', () => {
    const a = serverToolUseId();
    const b = serverToolUseId();
    expect(a).toMatch(/^srvtoolu_[A-Za-z0-9]{16,}$/);
    expect(a).not.toBe(b);
  });
});
