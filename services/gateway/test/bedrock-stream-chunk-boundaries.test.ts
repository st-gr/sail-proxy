/**
 * Bedrock streaming handlers must parse SSE events, not network chunks (B5, B6).
 *
 * Upstream TCP chunks do not line up with SSE events: two events can arrive in
 * one chunk, and one event can be split across two. Both stream handlers in
 * awsBedrockService used to run a first-match regex over each chunk, so:
 *
 *  - B5, emulated Converse stream (`handleEmulatedStreamingRequest`): only the
 *    first `data:` event of a chunk was handled. A coalesced text delta was
 *    dropped, and `messageStop` + `metadata` in one chunk lost the terminal
 *    `message_stop` and the usage fold.
 *  - B6, native invoke-with-response-stream (`handleNativeStreamingRequest`):
 *    usage was folded only when the FIRST event of the chunk carrying
 *    `amazon-bedrock-invocationMetrics` was the `message_stop`. SAP's final
 *    `message_delta` + `message_stop` commonly share a chunk, so no usage event.
 *  - BedrockStreamParser routed a mid-JSON fragment (a chunk without `data:` or
 *    `event:`) to its raw-text branch instead of the SSE parser, so a split event
 *    reached the client as garbage text and the event itself was lost.
 *
 * Invariant checked for every stream: the client receives the full text, exactly
 * one `message_stop`, and the request emits exactly one usage event.
 *
 * Chunks go through the real handlers and the real parsers; only axios (the
 * upstream), the logger, config and payload logging are stubbed, and
 * `emitUsageEvent` is wrapped so its calls can be counted.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { createParser } from 'eventsource-parser';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getTimeout: () => 5000,
    getWebSearchMaxSearches: () => 4,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap' }),
  },
}));

jest.mock('../src/utils/payloadLogger', () => ({
  __esModule: true,
  savePayload: jest.fn(),
}));

const usageEvents: any[] = [];
jest.mock('../src/utils/usageTracker', () => {
  const actual = jest.requireActual('../src/utils/usageTracker') as any;
  return {
    __esModule: true,
    ...actual,
    emitUsageEvent: (...args: any[]) => { usageEvents.push(args); },
  };
});

let upstreamStream: any;
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(async () => ({ status: 200, data: upstreamStream, headers: {} })),
  },
}));

import { handleEmulatedStreamingRequest, handleNativeStreamingRequest } from '../src/services/awsBedrockService';
import { createUsageMetrics } from '../src/utils/usageTracker';

function mockRes() {
  const r: any = new EventEmitter();
  r.chunks = [] as string[];
  r.headersSent = false;
  r.writable = true;
  r.writableEnded = false;
  r.setHeader = () => {};
  r.write = (s: any) => { r.chunks.push(s.toString()); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** What the client saw: every SSE event (name + parsed data) and the concatenated text. */
function clientView(res: any) {
  const events: Array<{ name: string | undefined; data: any }> = [];
  const parser = createParser({
    onEvent: (ev) => {
      let data: any = ev.data;
      try { data = JSON.parse(ev.data); } catch { /* keep the raw string */ }
      events.push({ name: ev.event, data });
    },
  });
  parser.feed(res.chunks.join(''));
  const text = events
    .filter((e) => e.data?.type === 'content_block_delta' && e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
  const messageStops = events.filter((e) => e.name === 'message_stop' || e.data?.type === 'message_stop');
  return { events, text, messageStops };
}

/** Split a string in the middle of its JSON so neither half is a whole SSE event. */
function splitMidJson(s: string, marker: string): [string, string] {
  const at = s.indexOf(marker);
  if (at < 0) throw new Error(`marker ${marker} not in ${s}`);
  return [s.slice(0, at), s.slice(at)];
}

async function runEmulated(chunks: string[], usageMetrics: any) {
  const res = mockRes();
  const req: any = new EventEmitter();
  req.originalUrl = '/bedrock/model/anthropic.claude/invoke-with-response-stream';

  upstreamStream = new EventEmitter();
  upstreamStream.destroy = () => {};

  const done = handleEmulatedStreamingRequest({
    targetUrl: 'https://sap.example/v2/inference/deployments/d1/converse-stream',
    requestBody: { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
    authToken: 'tok',
    headers: {},
    debugRequestId: '',
    req,
    res,
    modelDetails: { id: 'claude-test' } as any,
    modelId: 'claude-test',
    subpath: 'converse-stream',
    originalSubpath: 'invoke-with-response-stream',
    originalModelId: 'claude-test',
    hookConfig: undefined,
    usageMetrics,
  } as any);

  await new Promise((resolve) => setImmediate(resolve));
  for (const chunk of chunks) upstreamStream.emit('data', Buffer.from(chunk));
  upstreamStream.emit('end');
  await done;
  await waitFor(() => res.writableEnded, 'the response to be ended');
  req.emit('close');
  return res;
}

async function runNative(chunks: string[], usageMetrics: any) {
  const res = mockRes();
  const req: any = new EventEmitter();
  req.originalUrl = '/anthropic/v1/messages';

  upstreamStream = new EventEmitter();
  upstreamStream.destroy = () => {};

  const done = handleNativeStreamingRequest({
    targetUrl: 'https://sap.example/v2/inference/deployments/d1/invoke-with-response-stream',
    requestBody: { anthropic_version: 'bedrock-2023-05-31', messages: [{ role: 'user', content: 'hi' }] },
    authToken: 'tok',
    headers: {},
    debugRequestId: '',
    req,
    res,
    modelDetails: { id: 'claude-test' } as any,
    modelId: 'claude-test',
    subpath: 'invoke-with-response-stream',
    hookConfig: undefined,
    outputFormat: 'anthropic',
    usageMetrics,
  } as any);

  await new Promise((resolve) => setImmediate(resolve));
  for (const chunk of chunks) upstreamStream.emit('data', Buffer.from(chunk));
  upstreamStream.emit('end');
  await done;
  await waitFor(() => res.writableEnded, 'the response to be ended');
  req.emit('close');
  return res;
}

const data = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
const named = (obj: any) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

describe('emulated Converse stream: SSE events, not network chunks (B5)', () => {
  beforeEach(() => { usageEvents.length = 0; upstreamStream = undefined; });

  const messageStart = data({ messageStart: { role: 'assistant' } });
  const delta = (text: string) => data({ contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } });
  const blockStop = data({ contentBlockStop: { contentBlockIndex: 0 } });
  const messageStop = data({ messageStop: { stopReason: 'end_turn' } });
  const metadata = data({ metadata: { usage: { inputTokens: 15, outputTokens: 60 }, metrics: { latencyMs: 900 } } });

  it('handles two events coalesced in one chunk', async () => {
    const usageMetrics = createUsageMetrics();
    const res = await runEmulated(
      [messageStart, delta('Hel') + delta('lo'), blockStop, messageStop, metadata],
      usageMetrics,
    );
    const view = clientView(res);
    expect(view.text).toBe('Hello');
    expect(view.messageStops).toHaveLength(1);
    expect(usageEvents).toHaveLength(1);
  });

  it('handles messageStop + metadata in one chunk: one message_stop, usage folded once', async () => {
    const usageMetrics = createUsageMetrics();
    const res = await runEmulated([messageStart, delta('Hello'), blockStop, messageStop + metadata], usageMetrics);
    const view = clientView(res);
    expect(view.text).toBe('Hello');
    expect(view.messageStops).toHaveLength(1);
    expect(usageMetrics.inputTokens).toBe(15);
    expect(usageMetrics.outputTokens).toBe(60);
    expect(usageEvents).toHaveLength(1);
  });

  it('reassembles one event split across two chunks', async () => {
    const usageMetrics = createUsageMetrics();
    const [a, b] = splitMidJson(delta('lo'), 'lo"');
    const [m1, m2] = splitMidJson(metadata, 'outputTokens');
    const res = await runEmulated([messageStart, delta('Hel'), a, b, blockStop, messageStop, m1, m2], usageMetrics);
    const view = clientView(res);
    expect(view.text).toBe('Hello');
    expect(view.messageStops).toHaveLength(1);
    expect(usageMetrics.inputTokens).toBe(15);
    expect(usageMetrics.outputTokens).toBe(60);
    expect(usageEvents).toHaveLength(1);
  });

  it('ends an event at a chunk that carries only its terminating blank line', async () => {
    const usageMetrics = createUsageMetrics();
    const hel = delta('Hel');
    const res = await runEmulated(
      [messageStart, hel.slice(0, -1), '\n', delta('lo'), blockStop, messageStop, metadata],
      usageMetrics,
    );
    const view = clientView(res);
    expect(view.text).toBe('Hello');
    expect(view.messageStops).toHaveLength(1);
    expect(usageEvents).toHaveLength(1);
  });

  it('still handles a final event that ends without its blank line', async () => {
    const usageMetrics = createUsageMetrics();
    const res = await runEmulated([messageStart, delta('Hello'), blockStop, messageStop, metadata.trimEnd()], usageMetrics);
    expect(clientView(res).messageStops).toHaveLength(1);
    expect(usageMetrics.inputTokens).toBe(15);
    expect(usageEvents).toHaveLength(1);
  });

  it('folds usage once when it appears in both metadata and a message_stop with invocation metrics', async () => {
    const usageMetrics = createUsageMetrics();
    const stopWithMetrics = data({
      type: 'message_stop',
      'amazon-bedrock-invocationMetrics': { inputTokenCount: 15, outputTokenCount: 60 },
    });
    await runEmulated([messageStart, delta('Hello'), blockStop, messageStop, metadata + stopWithMetrics], usageMetrics);
    expect(usageMetrics.inputTokens).toBe(15);
    expect(usageMetrics.outputTokens).toBe(60);
    expect(usageEvents).toHaveLength(1);
  });
});

describe('native invoke-with-response-stream: SSE events, not network chunks (B6)', () => {
  beforeEach(() => { usageEvents.length = 0; upstreamStream = undefined; });

  const messageStart = named({
    type: 'message_start',
    message: {
      id: 'msg_synth_01', type: 'message', role: 'assistant', model: 'claude-test',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const blockStart = named({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const delta = (text: string) => named({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  const blockStop = named({ type: 'content_block_stop', index: 0 });
  const messageDelta = named({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 47 } });
  const messageStop = named({
    type: 'message_stop',
    'amazon-bedrock-invocationMetrics': {
      inputTokenCount: 1, outputTokenCount: 47, invocationLatency: 3262, firstByteLatency: 3143,
      cacheReadInputTokenCount: 147942, cacheWriteInputTokenCount: 953,
    },
  });

  function expectUsageFoldedOnce(usageMetrics: any) {
    expect(usageMetrics.inputTokens).toBe(1);
    expect(usageMetrics.outputTokens).toBe(47);
    expect(usageMetrics.cacheReadInputTokens).toBe(147942);
    expect(usageMetrics.cacheCreationInputTokens).toBe(953);
    expect(usageEvents).toHaveLength(1);
  }

  it('bills a final message_stop that ends without its blank line', async () => {
    for (const tail of ['', '\n']) {
      usageEvents.length = 0;
      const usageMetrics = createUsageMetrics();
      const res = await runNative(
        [messageStart, blockStart, delta('Hello'), blockStop, messageDelta, messageStop.trimEnd() + tail],
        usageMetrics,
      );
      const view = clientView(res);
      expect(view.text).toBe('Hello');
      expect(view.messageStops).toHaveLength(1);
      expectUsageFoldedOnce(usageMetrics);
    }
  });

  it('bills a message_delta + message_stop that share one chunk', async () => {
    const usageMetrics = createUsageMetrics();
    const res = await runNative([messageStart, blockStart, delta('Hello'), blockStop, messageDelta + messageStop], usageMetrics);
    const view = clientView(res);
    expect(view.text).toBe('Hello');
    expect(view.messageStops).toHaveLength(1);
    expectUsageFoldedOnce(usageMetrics);
  });

  it('handles two events coalesced in one chunk', async () => {
    const usageMetrics = createUsageMetrics();
    const res = await runNative(
      [messageStart + blockStart, delta('Hel') + delta('lo'), blockStop, messageDelta, messageStop],
      usageMetrics,
    );
    const view = clientView(res);
    expect(view.text).toBe('Hello');
    expect(view.messageStops).toHaveLength(1);
    expectUsageFoldedOnce(usageMetrics);
  });

  it('reassembles one event split across two chunks (text delta and message_stop)', async () => {
    const usageMetrics = createUsageMetrics();
    const [a, b] = splitMidJson(delta('lo'), 'lo"');
    const [s1, s2] = splitMidJson(messageStop, 'outputTokenCount');
    const res = await runNative(
      [messageStart, blockStart, delta('Hel'), a, b, blockStop, messageDelta, s1, s2],
      usageMetrics,
    );
    const view = clientView(res);
    expect(view.text).toBe('Hello');
    expect(view.messageStops).toHaveLength(1);
    // No fragment of the split JSON may reach the client as text or a raw frame.
    expect(res.chunks.join('')).not.toMatch(/^lo"/m);
    expectUsageFoldedOnce(usageMetrics);
  });

  it('ends an event at a chunk that carries only its terminating blank line', async () => {
    const usageMetrics = createUsageMetrics();
    const hel = delta('Hel');
    const res = await runNative(
      [messageStart, blockStart, hel.slice(0, -1), '\n', delta('lo'), blockStop, messageDelta, messageStop],
      usageMetrics,
    );
    const view = clientView(res);
    expect(view.text).toBe('Hello');
    expect(view.messageStops).toHaveLength(1);
    expectUsageFoldedOnce(usageMetrics);
  });
});

/**
 * The emulated Converse stream used to parse each event's data with
 * `Function("use strict"; return (<data>))()`, so upstream bytes ran as
 * JavaScript. Data must be parsed, never evaluated: an event that is not a
 * JSON (or single-quoted literal) object is skipped and the stream continues.
 */
describe('emulated Converse stream: event data is parsed, never evaluated', () => {
  beforeEach(() => {
    usageEvents.length = 0;
    upstreamStream = undefined;
    delete (globalThis as any).__pwned;
  });
  afterEach(() => { delete (globalThis as any).__pwned; });

  const messageStart = data({ messageStart: { role: 'assistant' } });
  const delta = (text: string) => data({ contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } });
  const blockStop = data({ contentBlockStop: { contentBlockIndex: 0 } });
  const messageStop = data({ messageStop: { stopReason: 'end_turn' } });
  const metadata = data({ metadata: { usage: { inputTokens: 15, outputTokens: 60 }, metrics: { latencyMs: 900 } } });

  it.each([
    ['an IIFE', 'data: (() => { globalThis.__pwned = 1; return {} })()\n\n'],
    ['an assignment inside an object literal', 'data: {"a": (globalThis.__pwned = 1)}\n\n'],
    ['an assignment beside a single-quoted key', "data: {'contentBlockDelta': (globalThis.__pwned = 1)}\n\n"],
  ])('does not execute %s; skips it and keeps streaming', async (_label, hostile) => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const usageMetrics = createUsageMetrics();
      const res = await runEmulated(
        [messageStart, delta('Hel'), hostile, delta('lo'), blockStop, messageStop, metadata],
        usageMetrics,
      );
      expect((globalThis as any).__pwned).toBeUndefined();
      const view = clientView(res);
      expect(view.text).toBe('Hello');
      expect(view.messageStops).toHaveLength(1);
      expect(usageEvents).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('still reads single-quoted (Python-style) event data without evaluating it', async () => {
    const usageMetrics = createUsageMetrics();
    const res = await runEmulated(
      [
        "data: {'messageStart': {'role': 'assistant'}}\n\n",
        `data: {'contentBlockDelta': {'delta': {'text': "It's "}, 'contentBlockIndex': 0}}\n\n`,
        "data: {'contentBlockDelta': {'delta': {'text': 'a \\'quoted\\' word'}, 'contentBlockIndex': 0}}\n\n",
        "data: {'contentBlockStop': {'contentBlockIndex': 0}}\n\n",
        "data: {'messageStop': {'stopReason': 'end_turn'}}\n\n",
        "data: {'metadata': {'usage': {'inputTokens': 15, 'outputTokens': 60}, 'metrics': {'latencyMs': 900}}}\n\n",
      ],
      usageMetrics,
    );
    const view = clientView(res);
    expect(view.text).toBe("It's a 'quoted' word");
    expect(view.messageStops).toHaveLength(1);
    expect(usageMetrics.inputTokens).toBe(15);
    expect(usageEvents).toHaveLength(1);
  });
});
