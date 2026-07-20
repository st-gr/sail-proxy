/**
 * BedrockStreamParser — Anthropic-format passthrough framing tests.
 *
 * SAP native invoke-with-response-stream for deployed Anthropic models emits
 * events ALREADY in Anthropic Messages format ({"type":"content_block_delta",...}).
 * These must reach the client with proper `event: <type>` SSE framing. Before the
 * passthrough branch existed, every such event fell through to the raw
 * `data:`-only fallback (no `event:` header), which claude-cli >= 2.1.215 cannot
 * parse — clients perceived every stream as a lost connection (ECONNRESET) and
 * fell back to non-streaming retries.
 *
 * Fixtures mirror the shape of the captured failing stream (synthetic values).
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

import BedrockStreamParser from '../src/utils/bedrockStreamParser';

function makeRes() {
  const written: string[] = [];
  const res: any = {
    writable: true,
    writableEnded: false,
    write: (chunk: any) => { written.push(String(chunk)); return true; },
    end: () => { res.writableEnded = true; },
    setHeader: () => {},
    headersSent: false,
  };
  return { res, written };
}

/** Split the concatenated SSE output into blocks and parse each. */
function parseSseBlocks(written: string[]) {
  const raw = written.join('');
  return raw
    .split('\n\n')
    .filter(b => b.trim())
    .map(block => {
      const eventMatch = block.match(/^event: ([^\n]+)\n/);
      const dataMatch = block.match(/data: (.+)$/s);
      let json: any = null;
      try { json = dataMatch ? JSON.parse(dataMatch[1]) : null; } catch { /* leave null */ }
      return {
        eventName: eventMatch ? eventMatch[1] : null,
        data: json,
        rawBlock: block,
      };
    });
}

const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;

/** Synthetic tool-call stream in the exact shape SAP sends (data-only blocks). */
function toolCallStreamChunks(): string[] {
  const chunks: string[] = [];
  chunks.push(sse({
    type: 'message_start',
    message: {
      id: 'msg_synth_01', type: 'message', role: 'assistant',
      model: 'claude-test', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  }));
  chunks.push(sse({
    type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'toolu_synth_1', name: 'Write', input: {} },
  }));
  for (let i = 0; i < 5; i++) {
    chunks.push(sse({
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: `"part${i}":${i},` },
    }));
  }
  chunks.push(sse({ type: 'content_block_stop', index: 0 }));
  chunks.push(sse({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: {
      input_tokens: 3, cache_creation_input_tokens: 161525, cache_read_input_tokens: 0,
      output_tokens: 114, output_tokens_details: { thinking_tokens: 0 },
    },
    context_management: { applied_edits: [] },
  }));
  chunks.push(sse({
    type: 'message_stop',
    'amazon-bedrock-invocationMetrics': {
      inputTokenCount: 3, outputTokenCount: 114, invocationLatency: 6326,
      firstByteLatency: 6152, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 161525,
    },
  }));
  return chunks;
}

describe('BedrockStreamParser Anthropic passthrough framing', () => {
  it('frames every already-Anthropic event with an `event:` header (tool-call stream, incident shape)', () => {
    const { res, written } = makeRes();
    const parser = new BedrockStreamParser('claude-test', 'invoke-with-response-stream', 'anthropic');
    for (const chunk of toolCallStreamChunks()) parser.processChunk(chunk, res);

    const blocks = parseSseBlocks(written);
    expect(blocks.length).toBeGreaterThanOrEqual(9);
    for (const b of blocks) {
      // No bare `data:`-only blocks — every block carries `event: <name>` …
      expect(b.eventName).toBeTruthy();
      // … and the name matches the payload's type
      expect(b.data?.type).toBe(b.eventName);
    }
    // Order preserved
    const names = blocks.map(b => b.eventName);
    expect(names[0]).toBe('message_start');
    expect(names[1]).toBe('content_block_start');
    expect(names[names.length - 2]).toBe('message_delta');
    expect(names[names.length - 1]).toBe('message_stop');
    expect(names.filter(n => n === 'content_block_delta')).toHaveLength(5);
  });

  it('emits exactly one clean message_stop (metrics stripped for anthropic output) and records usage in streamState', () => {
    const { res, written } = makeRes();
    const parser = new BedrockStreamParser('claude-test', 'invoke-with-response-stream', 'anthropic');
    for (const chunk of toolCallStreamChunks()) parser.processChunk(chunk, res);

    const blocks = parseSseBlocks(written);
    const stops = blocks.filter(b => b.eventName === 'message_stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].data['amazon-bedrock-invocationMetrics']).toBeUndefined();

    const state: any = (parser as any).streamState;
    expect(state.finalOutputTokens).toBe(114);
    expect(state.finalCacheCreationTokens).toBe(161525);
    expect(state.terminalMessageStopEmitted).toBe(true);
  });

  it('keeps invocation metrics on message_stop for bedrock output format', () => {
    const { res, written } = makeRes();
    const parser = new BedrockStreamParser('claude-test', 'invoke-with-response-stream', 'bedrock');
    for (const chunk of toolCallStreamChunks()) parser.processChunk(chunk, res);

    const stops = parseSseBlocks(written).filter(b => b.eventName === 'message_stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].data['amazon-bedrock-invocationMetrics']).toBeDefined();
    expect(stops[0].data['amazon-bedrock-invocationMetrics'].outputTokenCount).toBe(114);
  });

  it('frames a text_delta stream (non-tool path)', () => {
    const { res, written } = makeRes();
    const parser = new BedrockStreamParser('claude-test', 'invoke-with-response-stream', 'anthropic');
    const chunks = [
      sse({ type: 'message_start', message: { id: 'msg_synth_02', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }),
      sse({ type: 'content_block_stop', index: 0 }),
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
      sse({ type: 'message_stop' }),
    ];
    for (const c of chunks) parser.processChunk(c, res);

    const blocks = parseSseBlocks(written);
    for (const b of blocks) {
      expect(b.eventName).toBeTruthy();
      expect(b.data?.type).toBe(b.eventName);
    }
    const text = blocks.filter(b => b.eventName === 'content_block_delta').map(b => b.data.delta.text).join('');
    expect(text).toBe('Hello world');
    expect(blocks[blocks.length - 1].eventName).toBe('message_stop');
  });

  it('handles an SSE block split across two network chunks', () => {
    const { res, written } = makeRes();
    const parser = new BedrockStreamParser('claude-test', 'invoke-with-response-stream', 'anthropic');
    const whole = toolCallStreamChunks().join('');
    // Split mid-JSON inside a delta block
    const cut = whole.indexOf('partial_json') + 20;
    parser.processChunk(whole.slice(0, cut), res);
    parser.processChunk(whole.slice(cut), res);

    const blocks = parseSseBlocks(written);
    for (const b of blocks) {
      expect(b.eventName).toBeTruthy();
      expect(b.data?.type).toBe(b.eventName);
    }
    expect(blocks.filter(b => b.eventName === 'message_stop')).toHaveLength(1);
  });
});
