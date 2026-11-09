/**
 * openaiController: every `emulateOpenAIStreamFromFullResponse` call site bills the completed
 * upstream request exactly once, with its real token counts (14b).
 *
 * When streaming emulation is configured, `handleChatCompletion` fetches a complete
 * non-streaming response and replays it to the client as SSE. The upstream call has finished
 * and was charged either way, so each of the four replay sites must end in exactly one usage
 * event carrying that response's counts:
 *
 *  - deployed model + emulation configured (the `--deployed` branch)
 *  - the up-front emulated path (sapAIService hands the full SAP response to onChunk)
 *  - streaming rejected mid-flight (`streamingNotSupported`) with emulation configured
 *  - streaming rejected with no emulation configured, headers already flushed (B9, Task 5)
 *
 * plus the plain non-streaming path, unchanged. Mocking scaffold mirrors
 * test/openai-stream-fallback.test.ts; sseWriter is real so the replay really runs to [DONE].
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(m.endsWith('--deployed')
      ? { id: m, owned_by: 'openai', provider: 'openai', deploymentUrl: 'https://deployed.example.com/v1', model: 'gpt-4o' }
      : { id: m, owned_by: 'anthropic' }),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

let emulate = false;
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    shouldEmulateStreaming: () => emulate,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getHookConfig: () => undefined,
    getConfig: () => ({}), // nothing forces pseudonymization
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getOpenAIDeploymentApiVersion: () => undefined,
  },
}));

jest.mock('../src/utils/modelUtils', () => ({
  mapModelParameters: (p: Record<string, any>) => ({ ...p }),
  getDefaultParameters: () => ({}),
}));

jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (_req: any, _res: any, body: any) => Promise.resolve(body),
}));

jest.mock('../src/utils/payloadLogger', () => ({
  savePayload: () => {},
}));

// SAP orchestration non-streaming shape: usage lives under final_result, cache counts under
// prompt_tokens_details, EXCLUSIVE of prompt_tokens (see foldExclusiveUsage).
const SAP_RESPONSE = {
  request_id: 'req-emu',
  final_result: {
    id: 'chatcmpl-emu', created: 1786000200, model: 'anthropic--claude-4.8-opus',
    choices: [{ index: 0, message: { role: 'assistant', content: 'short reply' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 11, completion_tokens: 13, total_tokens: 29,
      prompt_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 },
    },
  },
};

// Same response, but the model called a tool instead of answering in text.
const SAP_TOOL_RESPONSE = {
  request_id: 'req-emu-tool',
  final_result: {
    ...SAP_RESPONSE.final_result,
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  },
};

type StreamMode = 'emulated-chunk' | 'not-supported' | 'chunks' | 'cancel-mid' | 'canceled-chunk' | 'req-close-mid' | 'reject';
// For 'reject': the streaming call fails with this error before any chunk.
let streamRejection: any = null;
// The response of the request being driven: a real hang-up is its 'close' while unfinished.
let activeRes: any;
// For 'chunks': fed to onChunk one by one, as a native SAP stream would.
let streamChunks: any[] = [];
let streamMode: StreamMode = 'emulated-chunk';
let upstreamResponse: any = SAP_RESPONSE;
// Non-null: the non-streaming retry (completeChat) rejects with this error.
let completeChatError: any = null;
// Runs just before completeChat resolves (e.g. the client disconnecting meanwhile).
let beforeCompleteResolves: (() => void) | null = null;
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    streamChatCompletion: (_payload: any, onChunk: (c: any) => void, _signal: AbortSignal, clientReq: any) => {
      if (streamMode === 'chunks') {
        for (const c of streamChunks) onChunk(c);
        return Promise.resolve(undefined);
      }
      if (streamMode === 'cancel-mid') {
        // The client hangs up mid-stream (res 'close', unfinished): the controller's abort signal
        // fires, axios rejects with a CanceledError, and sapAIService rethrows it wrapped
        // (status 500, originalError).
        for (const c of streamChunks) onChunk(c);
        activeRes.emit('close');
        const canceled = Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED', __CANCEL__: true });
        return Promise.reject(Object.assign(new Error('SAP AI Core streaming failed: canceled'), { status: 500, originalError: canceled }));
      }
      if (streamMode === 'req-close-mid') {
        // On Node 20 the request emits 'close' once its body is consumed, mid-turn: not a hang-up.
        onChunk(streamChunks[0]);
        clientReq.emit('close');
        for (const c of streamChunks.slice(1)) onChunk(c);
        return Promise.resolve(undefined);
      }
      if (streamMode === 'canceled-chunk') {
        // The connection was already gone (clientReq.aborted): sapAIService hands the controller a
        // canceled chunk and resolves, without the controller's own abort signal having fired.
        for (const c of streamChunks) onChunk(c);
        onChunk({ canceled: true, message: 'Client connection already aborted' });
        return Promise.resolve(undefined);
      }
      if (streamMode === 'reject') return Promise.reject(streamRejection);
      if (streamMode === 'not-supported') {
        return Promise.reject(Object.assign(new Error('streaming not supported'), { streamingNotSupported: true }));
      }
      // What sapAIService does when req.useEmulatedStreaming is set: a non-streaming call whose
      // full response is handed to onChunk with the emulation flag.
      onChunk({ nonStreamingResponse: upstreamResponse, useEmulatedStreaming: true });
      return Promise.resolve(undefined);
    },
    completeChat: () => {
      if (completeChatError) return Promise.reject(completeChatError);
      beforeCompleteResolves?.();
      return Promise.resolve(upstreamResponse);
    },
  },
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: () => Promise.resolve({
      status: 200,
      data: {
        id: 'chatcmpl-dep', object: 'chat.completion', created: 1786000300, model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'deployed reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 17, completion_tokens: 19, total_tokens: 36 },
      },
    }),
  },
}));

const usageEvents: any[] = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0 }),
  // Snapshots the invoked tools at emit time: emitUsageEvent reads them off req then.
  emitUsageEvent: (...args: any[]) => {
    usageEvents.push([args[0], { ...args[1] }, args[2], args[3], [...(args[0]?.toolGovernance?.invoked?.keys() ?? [])]]);
  },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number, image?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0;
    m.cacheReadInputTokens += cacheRead || 0;
    m.imageInputTokens += image || 0;
  },
}));

import { handleChatCompletion } from '../src/controllers/openaiController';
import { imageTokensFromDimensions } from '../src/utils/imageDimensions';
import { functionTool } from '../src/toolGovernance/identity';

// Same 2x3 PNG fixture as openai-deployed-image-tokens.test.ts: signature + IHDR header only.
const PNG_2x3_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308', 'hex').toString('base64')}`;

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {} as Record<string, string>,
    writable: true, writableEnded: false, headersSent: false,
    chunks: [] as string[],
  });
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  // failSet: the next res.set throws, as Node's setHeader does with ERR_HTTP_HEADERS_SENT. Unlike
  // res.write (sseWriter swallows those), this throw propagates out of the emulator and res.json.
  r.failSet = false;
  r.set = (headers: Record<string, string>) => {
    if (r.failSet) {
      r.failSet = false;
      throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
    }
    Object.assign(r.headers, headers);
    return r;
  };
  r.status = (c: number) => { r.statusCode = c; return r; };
  // Like Express: res.json sets its content type (res.set) before writing the body.
  r.json = (b: any) => { r.set({ 'Content-Type': 'application/json' }); r.body = b; r.headersSent = true; r.writableEnded = true; return r; };
  // keepHeadersUnsent: flushHeaders leaves headersSent false, so the B9 fallback answers with res.json.
  r.keepHeadersUnsent = false;
  r.flushHeaders = () => { if (!r.keepHeadersUnsent) r.headersSent = true; };
  r.write = (chunk: string) => { r.chunks.push(chunk); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = {};
  r.query = {};
  return r;
}

// The emulator paces chunks with a real setTimeout(..., 30), so wait on wall-clock time.
async function flushUntil(cond: () => boolean, maxTries = 100): Promise<void> {
  for (let i = 0; i < maxTries && !cond(); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function drive(model: string, stream: boolean, opts: { content?: any; setup?: (req: any, res: any) => void } = {}) {
  const req = mockReq({ model, messages: [{ role: 'user', content: opts.content ?? 'hi' }], stream });
  // A governed request, as the toolGovernance middleware leaves it: nothing declared, nothing invoked yet.
  req.toolGovernance = { result: { decisions: new Map(), mode: 'monitor' }, declared: [], invoked: new Map(), family: 'openaiChat' };
  const res = mockRes();
  activeRes = res;
  opts.setup?.(req, res);
  const next = jest.fn();
  await handleChatCompletion(req, res, next);
  await flushUntil(() => res.writableEnded && usageEvents.length > 0);
  // Give any late second emit (a completion callback, a promise chain) time to show up.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  return { res, next };
}

/** The `error` object of the first SSE error frame written. */
function errorFrame(res: any): any {
  const block = res.chunks.join('').split('\n\n').find((b: string) => b.startsWith('data: {"error"'));
  return block ? JSON.parse(block.slice('data: '.length)).error : undefined;
}

function streamedText(res: any): string {
  return res.chunks.join('')
    .split('\n\n')
    .filter((b: string) => b.startsWith('data: ') && b !== 'data: [DONE]')
    .map((b: string) => JSON.parse(b.slice('data: '.length)))
    .map((f: any) => f.choices?.[0]?.delta?.content ?? '')
    .join('');
}

const SAP_FOLDED = { inputTokens: 11, outputTokens: 13, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 };

describe('openaiController: emulated streaming bills each completed request exactly once (14b)', () => {
  beforeEach(() => {
    usageEvents.length = 0;
    emulate = false;
    streamMode = 'emulated-chunk';
    upstreamResponse = SAP_RESPONSE;
    completeChatError = null;
    beforeCompleteResolves = null;
    streamChunks = [];
    process.env.IMAGE_TOKEN_OVERHEAD = '10';
  });

  it('deployed model with emulation configured: one usage event with the deployment counts', async () => {
    emulate = true;
    const { res } = await drive('gpt-4o--deployed', true);

    expect(streamedText(res)).toBe('deployed reply');
    expect(usageEvents).toHaveLength(1);
    const [, metrics, model, status] = usageEvents[0];
    expect(model).toBe('gpt-4o--deployed');
    expect(status).toBe(200);
    // This branch deliberately does not split cache (see the comment at its fold site).
    expect(metrics).toMatchObject({ inputTokens: 17, outputTokens: 19, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('up-front emulated path: one usage event with the SAP final_result counts', async () => {
    emulate = true;
    streamMode = 'emulated-chunk';
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(streamedText(res)).toBe('short reply');
    expect(usageEvents).toHaveLength(1);
    const [, metrics, model, status] = usageEvents[0];
    expect(model).toBe('anthropic--claude-4.8-opus');
    expect(status).toBe(200);
    expect(metrics).toMatchObject(SAP_FOLDED);
  });

  it('streaming rejected mid-flight, emulation configured: one usage event with the SAP counts', async () => {
    emulate = true;
    streamMode = 'not-supported';
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(streamedText(res)).toBe('short reply');
    expect(usageEvents).toHaveLength(1);
    const [, metrics, model, status] = usageEvents[0];
    expect(model).toBe('anthropic--claude-4.8-opus');
    expect(status).toBe(200);
    expect(metrics).toMatchObject(SAP_FOLDED);
  });

  it('streaming rejected mid-flight, no emulation (B9 replay): one usage event with the SAP counts', async () => {
    emulate = false;
    streamMode = 'not-supported';
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(streamedText(res)).toBe('short reply');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject(SAP_FOLDED);
  });

  it('up-front emulated path, OpenAI-family model: the inclusive prompt_tokens is billed net of the cache', async () => {
    emulate = true;
    streamMode = 'emulated-chunk';
    // OpenAI-family models count cached tokens INSIDE prompt_tokens (probe of 2026-09-30).
    upstreamResponse = {
      request_id: 'req-emu-gpt',
      final_result: {
        ...SAP_RESPONSE.final_result, model: 'gpt-4.1-nano-2025-04-14',
        usage: {
          prompt_tokens: 1978, completion_tokens: 1, total_tokens: 1979,
          prompt_tokens_details: { audio_tokens: 0, cached_tokens: 1792 },
        },
      },
    };
    await drive('gpt-4.1-nano', true);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject({
      inputTokens: 186, outputTokens: 1, cacheReadInputTokens: 1792, cacheCreationInputTokens: 0,
    });
  });

  it('non-streaming request (unchanged path): one usage event with the SAP counts', async () => {
    const { res } = await drive('anthropic--claude-4.8-opus', false);

    expect(res.body.choices[0].message.content).toBe('short reply');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject(SAP_FOLDED);
  });

  it('B9 replay of a vision request: the usage event carries the captured image tokens', async () => {
    emulate = false;
    streamMode = 'not-supported';
    await drive('anthropic--claude-4.8-opus', true, {
      content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: PNG_2x3_DATA_URL } }],
    });

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][1]).toMatchObject({ ...SAP_FOLDED, imageInputTokens: imageTokensFromDimensions(2, 3, 10) });
  });

  it('B9 retry succeeds after the client went away: one 200 event with the counts, no error event', async () => {
    emulate = false;
    streamMode = 'not-supported';
    let theRes: any;
    beforeCompleteResolves = () => { theRes.writableEnded = true; };
    await drive('anthropic--claude-4.8-opus', true, { setup: (_req, res) => { theRes = res; } });

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject(SAP_FOLDED);
  });

  it('B9 retry fails: exactly one error usage event with the upstream status', async () => {
    emulate = false;
    streamMode = 'not-supported';
    completeChatError = Object.assign(new Error('upstream unavailable'), { status: 503 });
    const { res, next } = await drive('anthropic--claude-4.8-opus', true);

    // Nothing was streamed before the retry failed: the error reaches the client with its own
    // status (Express's handler), not as "Error in non-streaming retry" inside a 200 stream.
    expect(errorFrame(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0] as any[])[0].status).toBe(503);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(503);
  });

  it('emulation retry fails: exactly one error usage event with the upstream status', async () => {
    emulate = true;
    streamMode = 'not-supported';
    completeChatError = Object.assign(new Error('upstream unavailable'), { status: 503 });
    const { res, next } = await drive('anthropic--claude-4.8-opus', true);

    expect(errorFrame(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0] as any[])[0].status).toBe(503);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(503);
  });

  it('emulation retry succeeds but the replay throws: still exactly one (200) usage event', async () => {
    emulate = true;
    streamMode = 'not-supported';
    // Emulated from the start, so nothing set headers yet: the replay's own res.set is the first
    // call and throws into the retry catch, after the completion was billed.
    const { next } = await drive('anthropic--claude-4.8-opus', true, { setup: (_req, r) => { r.failSet = true; } });

    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0] as any[])[0].message).toBe('Cannot set headers after they are sent to the client');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject(SAP_FOLDED);
  });

  it('B9 retry succeeds but delivering it throws: still exactly one (200) usage event', async () => {
    emulate = false;
    streamMode = 'not-supported';
    let theRes: any;
    // The preamble's res.set succeeds; the fallback's res.json (headers still unsent) throws.
    beforeCompleteResolves = () => { theRes.failSet = true; };
    const { next } = await drive('anthropic--claude-4.8-opus', true, {
      setup: (_req, r) => { theRes = r; r.keepHeadersUnsent = true; },
    });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_HTTP_HEADERS_SENT' }));
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject(SAP_FOLDED);
  });

  it('up-front emulated path whose billing transform throws after the replay: one 200 event with the readable counts', async () => {
    emulate = true;
    streamMode = 'emulated-chunk';
    // The replay never reads final_result.created; transformSAPResponseToOpenAI (the billing
    // step, after the replay) does, and throws on it here.
    const finalResult: any = { ...SAP_RESPONSE.final_result };
    Object.defineProperty(finalResult, 'created', { get() { throw new Error('malformed created'); }, enumerable: false });
    upstreamResponse = { request_id: 'req-emu-bad', final_result: finalResult };
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(streamedText(res)).toBe('short reply');
    expect(errorFrame(res)).toBeUndefined();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject(SAP_FOLDED);
  });

  it('up-front emulated path, upstream body without any choices: no invented assistant text', async () => {
    emulate = true;
    streamMode = 'emulated-chunk';
    upstreamResponse = { request_id: 'req-emu-empty', final_result: { ...SAP_RESPONSE.final_result, choices: [] } };
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(res.chunks.join('')).not.toContain('No content available');
    // Same as the non-streaming path for this body: an empty completion, billed with its usage.
    expect(streamedText(res)).toBe('');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject(SAP_FOLDED);
  });

  it.each([
    ['an object message with content', { content: 'from the message object' }, 'from the message object'],
    ['an object message with text', { text: 'from the text field' }, 'from the text field'],
    ['an object message without either', { code: 7, detail: 'x' }, ''],
  ])('up-front emulated path, unrecognized body with %s: replayed without throwing, no invented text', async (_name, message, expected) => {
    emulate = true;
    streamMode = 'emulated-chunk';
    upstreamResponse = { request_id: 'req-emu-obj', message };
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(errorFrame(res)).toBeUndefined();
    expect(streamedText(res)).toBe(expected);
    expect(res.chunks.join('')).not.toContain('[object Object]');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
  });

  it('up-front emulated path: tool calls in the upstream response are recorded before the emit', async () => {
    emulate = true;
    streamMode = 'emulated-chunk';
    upstreamResponse = SAP_TOOL_RESPONSE;
    await drive('anthropic--claude-4.8-opus', true);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][4]).toEqual([functionTool('get_weather')]);
  });

  it('emulation retry: tool calls in the upstream response are recorded before the emit', async () => {
    emulate = true;
    streamMode = 'not-supported';
    upstreamResponse = SAP_TOOL_RESPONSE;
    await drive('anthropic--claude-4.8-opus', true);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][4]).toEqual([functionTool('get_weather')]);
  });

  // An error chunk before any content arrives while nothing was sent: the client gets the
  // status and OpenAI's JSON error body, not a 200 stream carrying an error frame.
  it('native stream error chunk before content: HTTP status + JSON error, not "[object Object]"', async () => {
    streamMode = 'chunks';
    streamChunks = [{ error: true, message: 'rate limited upstream', status: 429, details: { raw: 'upstream body' } }];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(res.statusCode).toBe(429);
    expect(res.chunks).toEqual([]);
    expect(res.body).toEqual({ error: { message: 'rate limited upstream', type: 'rate_limit_error', code: 429, param: null } });
    // The stream promise resolves after an error chunk; the request still failed.
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(429);
  });

  it('native stream error chunk shaped { error: { code, message } }: the client gets that message and code', async () => {
    streamMode = 'chunks';
    // SAP's in-stream error event, passed through as the chunk (see anthropicResponseService).
    streamChunks = [{ error: { code: 429, message: 'orchestration rate limit' } }];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: { message: 'orchestration rate limit', type: 'rate_limit_error', code: 429, param: null } });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(429);
  });

  it('native stream error chunk with a non-HTTP error code: its message, billed as 500', async () => {
    streamMode = 'chunks';
    streamChunks = [{ error: { code: 'content_filter', message: 'blocked by the input filter' } }];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { message: 'blocked by the input filter', type: 'api_error', code: 500, param: null } });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(500);
  });

  it('native stream error chunk without a status after partial usage: one 500 event with the known counts', async () => {
    streamMode = 'chunks';
    streamChunks = [
      { final_result: { choices: [{ index: 0, delta: { content: 'par' }, finish_reason: null }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } } },
      { error: true, message: 'Stream error: socket hang up' },
    ];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(errorFrame(res)?.message).toBe('Stream error: socket hang up');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(500);
    expect(usageEvents[0][1]).toMatchObject({ inputTokens: 7, outputTokens: 2 });
  });

  it("native stream error chunk after content: one error frame in OpenAI's vocabulary, no [DONE] after it", async () => {
    streamMode = 'chunks';
    streamChunks = [
      { final_result: { choices: [{ index: 0, delta: { content: 'par' }, finish_reason: null }] } },
      { error: { code: 400, message: '400 - LLM Module: prompt is too long: 600024 tokens > 200000 maximum', intermediate_results: { templating: 'SECRET' } } },
      { done: true },
    ];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(res.statusCode).toBe(200);
    expect(errorFrame(res)).toEqual({ message: '400 - LLM Module: prompt is too long: 600024 tokens > 200000 maximum', type: 'invalid_request_error', code: 400, param: null });
    const wire = res.chunks.join('');
    expect(wire.indexOf('"error"')).toBeGreaterThan(wire.indexOf('par'));
    expect(wire).not.toContain('[DONE]');
    expect(wire).not.toContain('SECRET');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(400);
  });

  it('an error chunk with a bogus status is answered 500, never a thrown invalid status code', async () => {
    streamMode = 'chunks';
    streamChunks = [{ error: true, message: 'weird upstream', status: 'teapot' }];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { message: 'weird upstream', type: 'api_error', code: 500, param: null } });
    expect(usageEvents[0][3]).toBe(500);
  });

  it('a thrown upstream error with an out-of-range status is answered 500', async () => {
    streamMode = 'reject';
    streamRejection = Object.assign(new Error('odd failure'), { status: 9999, details: { status: 42 } });
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatchObject({ message: 'odd failure', code: 500, param: null });
    expect(usageEvents[0][3]).toBe(500);
  });

  it("SAP's templating chunk then its error: HTTP 400 JSON, the held empty chunk never written", async () => {
    streamMode = 'chunks';
    streamChunks = [
      { intermediate_results: { templating: [] }, final_result: { choices: [{ index: 0, delta: { content: '' } }] } },
      { error: { code: 400, message: '400 - LLM Module: prompt is too long: 600024 tokens > 200000 maximum' } },
    ];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(res.statusCode).toBe(400);
    expect(res.chunks).toEqual([]);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(res.body.error).toMatchObject({ type: 'invalid_request_error', code: 400 });
    expect(res.body.error.message).toContain('prompt is too long: 600024 tokens > 200000 maximum');
  });

  it('a held empty chunk is written after the role chunk once content arrives (wire order unchanged)', async () => {
    streamMode = 'chunks';
    streamChunks = [
      { intermediate_results: { templating: [] }, final_result: { choices: [{ index: 0, delta: { content: '' } }] } },
      { final_result: { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] } },
      { done: true },
    ];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    const frames = res.chunks.join('').split('\n\n').filter(Boolean);
    expect(frames).toHaveLength(4);
    expect(JSON.parse(frames[0].slice(6)).choices[0].delta).toEqual({ role: 'assistant' });
    expect(JSON.parse(frames[1].slice(6)).choices[0].delta.content).toBe('');
    expect(JSON.parse(frames[2].slice(6)).choices[0].delta.content).toBe('Hi');
    expect(frames[3]).toBe('data: [DONE]');
  });

  it('native stream chunk that fails to transform: the client gets the processing error text', async () => {
    streamMode = 'chunks';
    // A choice that is null makes transformSAPResponseToOpenAI throw while reading its delta.
    streamChunks = [{ final_result: { choices: [null] } }];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    // Nothing was streamed yet, so the failure is the HTTP answer.
    expect(res.statusCode).toBe(500);
    const frame = res.body.error;
    expect(frame.type).toBe('processing_error');
    expect(frame.message).toMatch(/^Error processing chunk: /);
    expect(frame.message).not.toContain('[object Object]');
  });

  it('client cancels mid-stream (wrapped CanceledError): one 499 event with the tokens so far, no error frame', async () => {
    streamMode = 'cancel-mid';
    streamChunks = [
      { final_result: { choices: [{ index: 0, delta: { content: 'par' }, finish_reason: null }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } } },
    ];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(errorFrame(res)).toBeUndefined();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(499);
    expect(usageEvents[0][1]).toMatchObject({ inputTokens: 7, outputTokens: 2 });
  });

  it('client cancel on a vision request: the 499 event carries the captured image tokens', async () => {
    streamMode = 'cancel-mid';
    streamChunks = [];
    await drive('anthropic--claude-4.8-opus', true, {
      content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: PNG_2x3_DATA_URL } }],
    });

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(499);
    expect(usageEvents[0][1]).toMatchObject({ imageInputTokens: imageTokensFromDimensions(2, 3, 10) });
  });

  it('canceled chunk, then the stream resolves: one 499 event and the chunk is never written as data', async () => {
    streamMode = 'canceled-chunk';
    streamChunks = [];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    // Only the role preamble reached the client as data, no transformed canceled chunk.
    const dataFrames = res.chunks.join('').split('\n\n').filter((b: string) => b.startsWith('data: {'));
    expect(dataFrames).toHaveLength(1);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(499);
  });

  it("the request's own 'close' mid-stream (Node 20, body consumed) is not a hang-up: one 200", async () => {
    streamMode = 'req-close-mid';
    streamChunks = [
      { final_result: { choices: [{ index: 0, delta: { content: 'do' }, finish_reason: null }] } },
      { final_result: { choices: [{ index: 0, delta: { content: 'ne' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } } },
      { done: true },
    ];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(streamedText(res)).toBe('done');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
  });

  it('native stream that completes normally: still one 200 event', async () => {
    streamMode = 'chunks';
    streamChunks = [
      { final_result: { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } } },
      { done: true },
    ];
    const { res } = await drive('anthropic--claude-4.8-opus', true);

    expect(streamedText(res)).toBe('done');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(200);
    expect(usageEvents[0][1]).toMatchObject({ inputTokens: 5, outputTokens: 1 });
  });
});
