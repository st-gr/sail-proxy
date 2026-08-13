/**
 * `handleNativeStreamingRequest` — the wiring, not the interception module.
 *
 * The module has its own suite (`anthropic-websearch-stream-wiring.test.ts`).
 * What only this level can cover:
 *
 *  - THE ORDERING. The 'data' listener is async — it awaits `executeStreamPlugins`
 *    before `streamParser.processChunk` — and Node does not wait for an async
 *    listener before emitting 'end'. Without the `chunkWork` chain that 'end'
 *    awaits, `finalize()` runs before the frames carrying the web_search call have
 *    been parsed at all: no pending call, no search, and `res.write` un-patched in
 *    time for the raw `tool_use` to go straight to the client. Silent, timing
 *    dependent, and the whole feature becomes a no-op. `executeStreamPlugins` is
 *    mocked SLOW here precisely to force that interleaving every run.
 *
 *  - THE THREE GATES. `useStreamParser`, `outputFormat === 'anthropic'`, and a
 *    request that actually declares web_search. A stream failing any of them must
 *    come out byte-identical to one the interception was never offered.
 *
 *  - The plugin-shaped logger adapter and the `maxSearches` wiring, neither of
 *    which the module can check for itself.
 *
 * axios is mocked: no deployment is called and no search leaves the process.
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

/** Wraps the real module so the gates can be asserted without stubbing behaviour. */
const installSpy = jest.fn();
jest.mock('../src/plugins/webSearch/anthropicWebSearchStream', () => {
  const actual = jest.requireActual('../src/plugins/webSearch/anthropicWebSearchStream') as any;
  return {
    __esModule: true,
    ...actual,
    installWebSearchStreamInterception: (opts: any) => {
      installSpy(opts);
      return actual.installWebSearchStreamInterception(opts);
    },
  };
});

/**
 * The stream plugin the real handler awaits before it writes anything. Slow on
 * purpose: every chunk suspends, so 'end' is always emitted while chunk work is
 * still outstanding. That is the exact interleaving the chunk queue exists for.
 */
const STREAM_PLUGIN_DELAY_MS = 25;
const streamPluginCalls: string[] = [];
jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeStreamPlugins: jest.fn(async (_req: any, _res: any, chunk: any) => {
    await new Promise((resolve) => setTimeout(resolve, STREAM_PLUGIN_DELAY_MS));
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

const CONTINUATION_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"usage":{"input_tokens":40,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Zig 0.16.0."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":40,"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

/**
 * The first turn's stream, handed back as a stream this file drives by hand.
 * `upstreamPending` — not a post count — decides which POST gets it: a test that
 * runs two requests would otherwise hand its second first-turn call the
 * continuation fixture.
 */
let upstreamStream: any;
let upstreamPending = false;
const postBodies: any[] = [];
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(async (_url: string, body: any) => {
      postBodies.push(body);
      if (upstreamPending) {
        upstreamPending = false;
        return { status: 200, data: upstreamStream, headers: {} };
      }
      const stream: any = new EventEmitter();
      stream.destroy = () => {};
      setImmediate(() => {
        stream.emit('data', Buffer.from(CONTINUATION_SSE));
        stream.emit('end');
      });
      return { status: 200, data: stream, headers: {} };
    }),
  },
}));

import { handleNativeStreamingRequest } from '../src/services/awsBedrockService';

/** Two chunks, split mid-turn so more than one is in flight when 'end' fires. */
const UPSTREAM_CHUNK_1 = [
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search","input":{}}}\n\n',
].join('');
const UPSTREAM_CHUNK_2 = [
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"zig version\\"}"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":10,"output_tokens":20}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join('');

const WEB_SEARCH_TOOLS = [{
  name: 'web_search',
  description: 'Search the web',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}];

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

function framesOf(res: any): any[] {
  return res.chunks.join('').split('\n\n')
    .map((b: string) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l: any) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Drive one native streaming request. The upstream stream emits both chunks and
 * then 'end' back to back, exactly as a real readable does — every 'data'
 * listener is still suspended inside the slow stream plugin when 'end' lands.
 */
async function runRequest(overrides: any = {}) {
  const res = mockRes();
  const req: any = new EventEmitter();
  req.originalUrl = '/anthropic/v1/messages';

  upstreamStream = new EventEmitter();
  upstreamStream.destroy = () => {};
  upstreamPending = true;

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
    ...overrides,
  } as any);

  // Let the handler reach `await axios.post` and attach its listeners.
  await new Promise((resolve) => setImmediate(resolve));

  upstreamStream.emit('data', Buffer.from(UPSTREAM_CHUNK_1));
  upstreamStream.emit('data', Buffer.from(UPSTREAM_CHUNK_2));
  upstreamStream.emit('end');

  // `await done` buys nothing: the handler resolves as soon as it has attached
  // its listeners, long before the stream it set up has finished. Wait on the
  // OUTCOME instead — `res.end()` is the last thing the 'end' listener does, so
  // `writableEnded` is the signal that the whole turn is complete. A fixed sleep
  // here was 150ms of headroom over ~55ms of work, which is thin on a loaded CI
  // box and fails as a confusing streamPluginCalls mismatch rather than a timeout.
  await done;
  await waitFor(() => res.writableEnded, 'the response to be ended');

  // Real requests emit 'close'; without it the handler's 15s ping interval is
  // never cleared and the suite leaks one timer per test (currently masked by
  // jest's forceExit).
  req.emit('close');
  return res;
}

/** Poll until `predicate` holds, so timing follows the work rather than a guess. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('handleNativeStreamingRequest — web_search stream wiring', () => {
  beforeEach(() => {
    searchCalls.length = 0;
    postBodies.length = 0;
    streamPluginCalls.length = 0;
    installSpy.mockClear();
    // Module-level and therefore shared: a continuation POST arriving late from a
    // previous test would otherwise consume the next test's upstream flag and
    // hand it the wrong stream.
    upstreamStream = undefined;
    upstreamPending = false;
  });

  it('finalizes only after the last chunk has been processed', async () => {
    const res = await runRequest();

    // Both chunks went through the slow plugin before anything was finalized —
    // if `end` had not awaited the chunk queue, the second one would still have
    // been in flight and the search would never have been discovered.
    expect(streamPluginCalls).toHaveLength(2);
    expect(searchCalls).toEqual(['zig version']);

    const frames = framesOf(res);
    expect(frames.filter((f) => f.type === 'content_block_start').map((f) => f.content_block.type))
      .toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
    // The raw call never reached the client...
    expect(res.chunks.join('')).not.toContain('"toolu_1"');
    expect(res.chunks.join('')).not.toContain('"type":"tool_use"');
    // ...and nothing was written after the terminal frame, which is what a
    // finalize that ran too early would have produced.
    expect(frames[frames.length - 1].type).toBe('message_stop');
    expect(frames.filter((f) => f.type === 'message_stop')).toHaveLength(1);
    expect(res.writableEnded).toBe(true);
  });

  it('leaves no keepalive timer behind', async () => {
    // The handler starts a 15s ping interval and clears it on req 'close'. A test
    // that never emits 'close' leaks one timer per test — six here — which
    // `forceExit: true` hides at the cost of the suite no longer being able to
    // tell a leak from a clean exit.
    const created: any[] = [];
    const cleared: any[] = [];
    const setSpy = jest.spyOn(global, 'setInterval')
      .mockImplementation(((fn: any, ms: any) => {
        const id = (jest.requireActual('timers') as any).setInterval(fn, ms);
        id.unref?.();
        created.push(id);
        return id;
      }) as any);
    const clearSpy = jest.spyOn(global, 'clearInterval')
      .mockImplementation(((id: any) => {
        cleared.push(id);
        return (jest.requireActual('timers') as any).clearInterval(id);
      }) as any);

    await runRequest();

    expect(created.length).toBeGreaterThan(0);   // the ping interval really was started
    for (const id of created) expect(cleared).toContain(id);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('reports the search count to the client through the real handler', async () => {
    const res = await runRequest();
    const deltas = framesOf(res).filter((f) => f.type === 'message_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].usage.server_tool_use).toEqual({ web_search_requests: 1, web_fetch_requests: 0 });
  });

  it('hands the module a plugin-shaped logger and the configured search cap', async () => {
    await runRequest();

    expect(installSpy).toHaveBeenCalledTimes(1);
    const opts: any = installSpy.mock.calls[0][0];
    expect(opts.maxSearches).toBe(MAX_SEARCHES);
    // `getDefaultLogger()` is component-first; the module calls `logger.info(msg)`.
    // Passing the wrong shape logs the message as the component name.
    for (const level of ['error', 'warn', 'info', 'debug', 'trace']) {
      expect(typeof opts.logger[level]).toBe('function');
      expect(() => opts.logger[level]('probe', { k: 1 })).not.toThrow();
    }
  });

  it('leaves the stream untouched when the request declares no web_search tool', async () => {
    const res = await runRequest({ requestBody: { tools: [{ name: 'Read', input_schema: {} }] } });

    expect(installSpy).not.toHaveBeenCalled();
    expect(searchCalls).toEqual([]);
    expect(postBodies).toHaveLength(1);          // the upstream call only, no continuation
    // Nothing was withheld: the model's own tool_use is on the wire verbatim.
    const wire = res.chunks.join('');
    expect(wire).toContain('"toolu_1"');
    expect(wire).toContain('"type":"tool_use"');
  });

  it('leaves a bedrock-format stream byte-identical to an un-offered one', async () => {
    // Same request twice under outputFormat 'bedrock': once declaring web_search,
    // once not. The gate must make no difference to a single byte.
    const withTool = await runRequest({ outputFormat: 'bedrock' });
    const gated = installSpy.mock.calls.length;
    installSpy.mockClear();
    const withoutTool = await runRequest({
      outputFormat: 'bedrock',
      requestBody: { tools: [{ name: 'Read', input_schema: {} }] },
    });

    expect(gated).toBe(0);
    expect(installSpy).not.toHaveBeenCalled();
    expect(searchCalls).toEqual([]);
    expect(withTool.chunks.join('')).toBe(withoutTool.chunks.join(''));
  });
});
