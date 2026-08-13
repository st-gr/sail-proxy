/**
 * T8 of the usage-accounting audit: defect 4, the web_search continuation's
 * tokens were never billed, AND the usage event fired at the first turn's
 * `message_stop` — before `await webSearchStream.finalize()` even ran the
 * continuation that produced them.
 *
 * `anthropicWebSearchStream.ts` had zero usage-tracking calls despite its own
 * module header claiming it "report[ed] usage". The fix: an `onUsage`
 * callback the module invokes once per continuation round (never for the
 * first turn, which `handleNativeStreamingRequest`'s raw-metrics listener
 * already folds), wired here through `foldExclusiveUsage` (Anthropic-native
 * continuation frames are EXCLUSIVE — additive, never subtracted), plus a
 * lifecycle reorder: when interception is active, the early emit at
 * `message_stop` is suppressed and the event fires exactly once after
 * `finalize()` resolves.
 *
 * This suite drives `handleNativeStreamingRequest` end to end — the real
 * `anthropicWebSearchStream` module runs unmocked, so `onUsage` is exercised
 * for real, not stubbed. Only `usageTracker`'s `emitUsageEvent`/
 * `updateTokenCounts` are mocked (to a spy + a plain accumulator, mirroring
 * test/openai-usage-folding.test.ts), so `foldExclusiveUsage` and
 * `foldRawBedrockStreamUsage` run their real arithmetic. axios is mocked: no
 * deployment is called and no search leaves the process.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

const searchCalls: string[] = [];
jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  __esModule: true,
  executeWebSearch: jest.fn(async (query: string) => {
    searchCalls.push(query);
    return [{
      title: 'Zig Downloads',
      url: 'https://ziglang.org/download/',
      snippet: 'Zig 0.16.0 is current',
      content: 'Zig 0.16.0 is the current release, published in 2026.',
      date: 'February 13, 2026',
    }];
  }),
}));

const streamPluginCalls: string[] = [];
jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeStreamPlugins: jest.fn(async (_req: any, _res: any, chunk: any) => {
    streamPluginCalls.push(chunk.toString());
    return chunk;
  }),
  executeAfterPlugins: jest.fn(async () => undefined),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: { getAuthToken: jest.fn(async () => 'tok') },
}));

const MAX_SEARCHES = 4;
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getTimeout: () => 5000,
    getWebSearchMaxSearches: () => MAX_SEARCHES,
  },
}));

jest.mock('../src/utils/payloadLogger', () => ({
  __esModule: true,
  savePayload: jest.fn(),
}));

// Real usageFolding.ts is NOT mocked — only its own dependency, updateTokenCounts,
// is, as a plain accumulator (mirrors test/openai-usage-folding.test.ts). This is
// what lets this suite exercise the real foldExclusiveUsage/foldRawBedrockStreamUsage
// arithmetic reached from awsBedrockService's fold sites.
const usageEvents: Array<{ metrics: any; model: any; statusCode: any }> = [];
jest.mock('../src/utils/usageTracker', () => ({
  __esModule: true,
  emitUsageEvent: (...args: any[]) => {
    usageEvents.push({ metrics: { ...args[1] }, model: args[2], statusCode: args[3] });
  },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens = (m.cacheCreationInputTokens || 0) + (cacheCreation || 0);
    m.cacheReadInputTokens = (m.cacheReadInputTokens || 0) + (cacheRead || 0);
  },
}));

/** The continuation turn the deployment returns once it has the search results. */
const CONTINUATION_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"usage":{"input_tokens":40,"output_tokens":0,"cache_creation_input_tokens":5,"cache_read_input_tokens":100}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Zig 0.16.0."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":40,"output_tokens":9,"cache_creation_input_tokens":5,"cache_read_input_tokens":100}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

/**
 * Round 1 of a TWO-round continuation: the model, handed the first search's
 * results, asks for a SECOND search instead of answering. No cache fields
 * here — deliberately different from `CONTINUATION_SSE`'s round-2 numbers, so
 * a fold that summed the wrong round's cache fields would be caught too.
 */
const ROUND1_CONTINUATION_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"usage":{"input_tokens":40,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"web_search","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"zig release date\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":40,"output_tokens":12}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

/**
 * First turn's stream, ONE SSE block per emitted chunk — the shape
 * test/bedrock-stream-anthropic-passthrough.test.ts's own fixtures use, and
 * required here: awsBedrockService's raw-metrics extraction regex
 * (`chunkStr.match(/data: (.*?)(?:\n\n|\n$|$)/s)`) reads only the FIRST
 * `data:` block in whatever string it is handed, so a chunk batching several
 * blocks together — as e.g. bedrock-native-stream-websearch-wiring.test.ts
 * does to exercise a DIFFERENT concern (the chunk-queue ordering) — would
 * silently miss `message_stop`'s `amazon-bedrock-invocationMetrics` if it
 * were not the chunk's only block. `message_stop` carries that envelope, the
 * field awsBedrockService's own 'data' listener keys its usage extraction on,
 * confirmed live (see `foldRawBedrockStreamUsage`'s doc comment in
 * src/services/awsBedrockService.ts).
 */
function toChunks(frames: any[]): string[] {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
}

const UPSTREAM_FRAMES = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"zig version"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 20 } },
  {
    type: 'message_stop',
    'amazon-bedrock-invocationMetrics': {
      inputTokenCount: 10, outputTokenCount: 20, invocationLatency: 500, firstByteLatency: 200,
      cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0,
    },
  },
];

/** A plain turn with no tool call at all — the non-websearch control path. */
const PLAIN_FRAMES = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 20 } },
  {
    type: 'message_stop',
    'amazon-bedrock-invocationMetrics': {
      inputTokenCount: 10, outputTokenCount: 20, invocationLatency: 500, firstByteLatency: 200,
      cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0,
    },
  },
];

const WEB_SEARCH_TOOLS = [{
  name: 'web_search',
  description: 'Search the web',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}];

let upstreamStream: any;
let upstreamPending = false;
const postBodies: any[] = [];
/** When armed, the continuation's axios.post does not resolve until released. */
let continuationGate: Promise<void> = Promise.resolve();
let releaseContinuationGate: (() => void) | null = null;
function armContinuationGate(): void {
  continuationGate = new Promise((resolve) => { releaseContinuationGate = resolve; });
}

/** When set, the continuation POST rejects instead of streaming a response. */
let continuationFails = false;

/**
 * Queued SSE for successive continuation POSTs, one shift per round — the
 * same pattern test/anthropic-websearch-stream-wiring.test.ts uses for its
 * own "runs a second round" case. Empty (the default) means every
 * continuation round gets the single-round `CONTINUATION_SSE` fixture.
 */
let postResponses: string[] = [];

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(async (_url: string, body: any) => {
      postBodies.push(body);
      if (upstreamPending) {
        upstreamPending = false;
        return { status: 200, data: upstreamStream, headers: {} };
      }
      await continuationGate;
      if (continuationFails) throw new Error('502 from SAP');
      const sse = postResponses.length > 0 ? postResponses.shift()! : CONTINUATION_SSE;
      const stream: any = new EventEmitter();
      stream.destroy = () => {};
      setImmediate(() => {
        stream.emit('data', Buffer.from(sse));
        stream.emit('end');
      });
      return { status: 200, data: stream, headers: {} };
    }),
  },
}));

import { handleNativeStreamingRequest } from '../src/services/awsBedrockService';

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

function usageMetrics() {
  return { startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

/** Poll until `predicate` holds, so timing follows the work rather than a guess. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function runRequest(overrides: any = {}) {
  const res = mockRes();
  const req: any = new EventEmitter();
  req.originalUrl = '/anthropic/v1/messages';

  upstreamStream = new EventEmitter();
  upstreamStream.destroy = () => {};
  upstreamPending = true;

  const metrics = overrides.usageMetrics || usageMetrics();

  const done = handleNativeStreamingRequest({
    targetUrl: 'https://sap.example/v2/inference/deployments/d1/invoke-with-response-stream',
    requestBody: {
      anthropic_version: 'bedrock-2023-05-31',
      messages: [{ role: 'user', content: 'zig version' }],
      tools: WEB_SEARCH_TOOLS,
      ...(overrides.requestBody || {}),
    },
    authToken: 'tok',
    headers: {},
    debugRequestId: '',
    req,
    res,
    modelDetails: { id: 'claude-test' } as any,
    modelId: 'claude-test',
    subpath: 'invoke-with-response-stream',
    hookConfig: { rules: [] },
    outputFormat: 'anthropic',
    usageMetrics: metrics,
    ...overrides,
  } as any);

  await new Promise((resolve) => setImmediate(resolve));

  const upstream = overrides.upstream || toChunks(UPSTREAM_FRAMES);
  for (const chunk of upstream) upstreamStream.emit('data', Buffer.from(chunk));
  upstreamStream.emit('end');

  return { res, req, done, metrics };
}

async function finish(ctx: { res: any; req: any; done: Promise<void> }): Promise<void> {
  await ctx.done;
  await waitFor(() => ctx.res.writableEnded, 'the response to be ended');
  ctx.req.emit('close');
}

describe('handleNativeStreamingRequest — web_search continuation billing (T8)', () => {
  beforeEach(() => {
    searchCalls.length = 0;
    postBodies.length = 0;
    streamPluginCalls.length = 0;
    usageEvents.length = 0;
    upstreamStream = undefined;
    upstreamPending = false;
    continuationGate = Promise.resolve();
    releaseContinuationGate = null;
    continuationFails = false;
    postResponses = [];
  });

  it('bills the continuation: event totals = first turn + continuation, cache fields included', async () => {
    const ctx = await runRequest();
    await finish(ctx);

    expect(usageEvents).toHaveLength(1);
    const [event] = usageEvents;
    // First turn (input 10, output 20) + continuation (input 40, output 9,
    // cache_creation 5, cache_read 100), folded additively — EXCLUSIVE regime,
    // never subtracted.
    expect(event.metrics.inputTokens).toBe(50);
    expect(event.metrics.outputTokens).toBe(29);
    expect(event.metrics.cacheCreationInputTokens).toBe(5);
    expect(event.metrics.cacheReadInputTokens).toBe(100);
    expect(event.model).toBe('claude-test');
    expect(event.statusCode).toBe(200);
  });

  it('emits nothing at the first message_stop and exactly one event after finalize', async () => {
    armContinuationGate();
    const ctx = await runRequest();

    // The first turn's message_stop (carrying amazon-bedrock-invocationMetrics)
    // has been processed by the time the continuation POST is attempted — the
    // continuation is gated open, proving finalize() is mid-flight — yet no
    // event has been emitted. `postBodies` also holds the first turn's OWN
    // POST (pushed the instant handleNativeStreamingRequest starts), so the
    // continuation's arrival is the SECOND entry, not the first.
    await waitFor(() => postBodies.length === 2, 'the continuation POST to be attempted');
    expect(usageEvents).toHaveLength(0);

    releaseContinuationGate?.();
    await finish(ctx);

    expect(usageEvents).toHaveLength(1);
  });

  it('leaves the non-websearch path emitting at message_stop, unchanged', async () => {
    const ctx = await runRequest({
      requestBody: { tools: [{ name: 'Read', input_schema: {} }] },
      upstream: toChunks(PLAIN_FRAMES),
    });

    // No web_search declared: no continuation, so nothing to await — the event
    // must already be there as soon as the first (only) turn's message_stop
    // has been processed, well before 'end' or finalize even run.
    await waitFor(() => usageEvents.length === 1, 'the message_stop emit');
    // Only the first (only) turn's own POST — no continuation was ever attempted.
    expect(postBodies).toHaveLength(1);

    await finish(ctx);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].metrics.inputTokens).toBe(10);
    expect(usageEvents[0].metrics.outputTokens).toBe(20);
  });

  it('bills a multi-round continuation: totals = first turn + round 1 + round 2, cache fields included', async () => {
    // Round 1 asks for a second search instead of answering; round 2 finally
    // answers. Each round's `onUsage` call must fold ADDITIVELY — a caller
    // that instead kept only the LAST round's numbers would silently drop
    // both the first turn's and round 1's tokens from the bill.
    postResponses = [ROUND1_CONTINUATION_SSE, CONTINUATION_SSE];

    const ctx = await runRequest();
    await finish(ctx);

    expect(searchCalls).toEqual(['zig version', 'zig release date']);
    expect(postBodies).toHaveLength(3); // first turn + round 1 + round 2
    expect(usageEvents).toHaveLength(1);

    const [event] = usageEvents;
    // First turn (10/20) + round 1 (40/12, no cache) + round 2 (40/9,
    // cache_creation 5, cache_read 100).
    expect(event.metrics.inputTokens).toBe(90);
    expect(event.metrics.outputTokens).toBe(41);
    expect(event.metrics.cacheCreationInputTokens).toBe(5);
    expect(event.metrics.cacheReadInputTokens).toBe(100);
  });

  it('emits exactly one event with first-turn usage only when web_search is declared but never called this turn', async () => {
    // Unlike the non-websearch test above, `tools` here still declares
    // web_search (the default from `runRequest`) — interception is ARMED
    // (`webSearchStream` truthy, so the early message_stop emit is
    // suppressed) — but the model's only turn is plain text, so `heldAnything`
    // never flips true and `finalize()` returns immediately without running
    // any continuation round. The deferred post-finalize emit must still fire
    // exactly once, promptly, on first-turn usage alone.
    const ctx = await runRequest({ upstream: toChunks(PLAIN_FRAMES) });

    await waitFor(() => usageEvents.length === 1, 'the deferred post-finalize emit');

    // Structural proof `onUsage` was never invoked: it is only ever called
    // from inside `streamContinuation`, which only runs for a queued search —
    // and none was queued, so no continuation POST was attempted and no
    // search ran.
    expect(searchCalls).toEqual([]);
    expect(postBodies).toHaveLength(1); // the first (only) turn's own POST

    await finish(ctx);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].metrics.inputTokens).toBe(10);
    expect(usageEvents[0].metrics.outputTokens).toBe(20);
    expect(usageEvents[0].metrics.cacheCreationInputTokens).toBe(0);
    expect(usageEvents[0].metrics.cacheReadInputTokens).toBe(0);
  });

  it('still emits with first-turn usage when the continuation POST fails', async () => {
    continuationFails = true;
    const ctx = await runRequest();
    await finish(ctx);

    expect(usageEvents).toHaveLength(1);
    // The continuation never produced a round to bill; only the first turn's
    // tokens are present. Zero events would be the regression this covers.
    expect(usageEvents[0].metrics.inputTokens).toBe(10);
    expect(usageEvents[0].metrics.outputTokens).toBe(20);
    expect(usageEvents[0].metrics.cacheCreationInputTokens).toBe(0);
    expect(usageEvents[0].metrics.cacheReadInputTokens).toBe(0);
  });
});
