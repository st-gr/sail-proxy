/**
 * googleDispatch: the two streaming transports and how an upstream failure is
 * shaped, exercised through `handleGemini` so the wiring under test is the real
 * one (headers, client-disconnect abort, metering) rather than a hand-rolled ctx.
 *
 * Fake streams are destroyed and every emit is awaited: a suite that leaves a
 * live EventEmitter behind reports open handles.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter, Readable } from 'stream';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const posted: any[] = [];
let streamHandle: any = null;
let nextPostRejection: any = null;
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any, cfg: any) => {
      posted.push({ url, body, cfg });
      if (nextPostRejection) {
        const err: any = new Error(nextPostRejection.message || 'upstream failed');
        if (nextPostRejection.response) err.response = nextPostRejection.response;
        if (nextPostRejection.code) err.code = nextPostRejection.code;
        nextPostRejection = null;
        return Promise.reject(err);
      }
      if (cfg?.responseType === 'stream') {
        const stream: any = new EventEmitter();
        stream.destroyed = false;
        stream.destroy = () => { stream.destroyed = true; stream.emit('close'); };
        streamHandle = stream;
        return Promise.resolve({ status: 200, data: stream });
      }
      return Promise.resolve({ status: 200, data: { candidates: [], usageMetadata: {} } });
    },
  },
}));

const CATALOGUE: Record<string, any> = {
  'gemini-3.5-flash': { id: 'gemini-3.5-flash', model: 'gemini-3.5-flash', owned_by: 'Google' },
  'gemini-3.5-flash--deployed': {
    id: 'gemini-3.5-flash--deployed', model: 'gemini-3.5-flash', provider: 'google',
    deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-flash',
  },
  'anthropic--claude-4.5-sonnet': {
    id: 'anthropic--claude-4.5-sonnet', model: 'anthropic--claude-4.5-sonnet', owned_by: 'Anthropic',
  },
};
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(CATALOGUE[m] || null),
    getAuthToken: () => Promise.resolve('tok'),
  },
}));

const configState: { hookConfig: any } = { hookConfig: undefined };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: () => configState.hookConfig,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'rg-test' }),
    getTimeout: () => 1000,
  },
}));

let afterPlugins: (req: any, res: any, body: any) => Promise<any> = (_r, _s, body) => Promise.resolve(body);
const afterPluginBodies: any[] = [];
jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (req: any, res: any, body: any) => {
    afterPluginBodies.push(body);
    return afterPlugins(req, res, body);
  },
  executeStreamPlugins: () => Promise.resolve(undefined),
}));

const usageEvents: Array<[any, any, string, number]> = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({
    startTime: Date.now(), inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0,
  }),
  emitUsageEvent: (req: any, m: any, model: string, status: number) => {
    usageEvents.push([req, { ...m }, model, status]);
  },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0;
    m.cacheReadInputTokens += cacheRead || 0;
  },
}));

/** Handles on the in-flight orchestration stream, so a test drives it chunk by chunk. */
const streamCalls: Array<{ payload: any; abortSignal: any; hookConfig: any }> = [];
let onOrchestrationChunk: ((chunk: any) => void | Promise<void>) | null = null;
let releaseStream: (() => void) | null = null;
let rejectStream: ((e: any) => void) | null = null;
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    completeChat: () => Promise.resolve({ final_result: { choices: [], usage: {} } }),
    createEmbedding: () => Promise.resolve({ final_result: { data: [], usage: { prompt_tokens: 0 } } }),
    streamChatCompletion: (payload: any, onChunk: any, abortSignal: any, _req: any, hookConfig: any) => {
      streamCalls.push({ payload, abortSignal, hookConfig });
      onOrchestrationChunk = onChunk;
      return new Promise<void>((resolve, reject) => { releaseStream = resolve; rejectStream = reject; });
    },
  },
}));

import { handleGemini } from '../src/controllers/googleController';

function mockRes(): any {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[],
    ended: false, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; r.headersSent = true; };
  r.write = (s: string) => { r.writes.push(s); return true; };
  r.end = () => { r.ended = true; r.writableEnded = true; };
  return r;
}

function mockReq(modelAndMethod: string, body: any = {}): any {
  return Object.assign(new EventEmitter(), {
    params: { modelAndMethod }, body, headers: {}, method: 'POST',
    originalUrl: `/google/v1beta/models/${modelAndMethod}`,
  });
}

/** Poll a few event-loop turns for async setup (model lookup, auth token, axios.post) to settle. */
async function flushUntil(cond: () => boolean, maxTries = 50): Promise<void> {
  for (let i = 0; i < maxTries && !cond(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const CONTENTS = { contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }] };

beforeEach(() => {
  posted.length = 0;
  usageEvents.length = 0;
  streamCalls.length = 0;
  afterPluginBodies.length = 0;
  streamHandle = null;
  nextPostRejection = null;
  onOrchestrationChunk = null;
  releaseStream = null;
  rejectStream = null;
  configState.hookConfig = undefined;
  afterPlugins = (_r: any, _s: any, body: any) => Promise.resolve(body);
});

describe('dispatchNative: streaming', () => {
  it('pipes upstream SSE bytes verbatim under Gemini streaming headers, and meters the last usage', async () => {
    const res = mockRes();
    const done = handleGemini(mockReq('gemini-3.5-flash:streamGenerateContent', CONTENTS), res, jest.fn() as any);
    await flushUntil(() => !!streamHandle);

    expect(posted[0].url).toBe(
      'http://mock-sap/v2/inference/deployments/d-flash/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
    expect(posted[0].cfg.responseType).toBe('stream');
    expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('no-cache');
    expect(res.headers.Connection).toBe('keep-alive');
    expect(res.headers['X-Accel-Buffering']).toBe('no');

    const first = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\n\n';
    const last = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],'
      + '"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":6,"thoughtsTokenCount":2,"cachedContentTokenCount":2}}\n\n';
    streamHandle.emit('data', Buffer.from(first));
    streamHandle.emit('data', Buffer.from(last));
    streamHandle.emit('end');
    await done;

    expect(res.writes.join('')).toBe(first + last);
    const [, metrics, model, status] = usageEvents[0];
    expect(model).toBe('gemini-3.5-flash--deployed');
    expect(status).toBe(200);
    // Google counts INCLUSIVE: promptTokenCount 7 already contains the 2 cached tokens, so
    // full-rate input is 7 − 2. Folding 7 raw alongside a cacheRead of 2 billed the cached
    // prefix at both rates.
    expect(metrics.inputTokens).toBe(5);
    expect(metrics.outputTokens).toBe(8);
    expect(metrics.cacheReadInputTokens).toBe(2);
    expect(res.ended).toBe(true);
  });

  it('destroys the upstream stream when the client disconnects, and still meters', async () => {
    const res = mockRes();
    const done = handleGemini(mockReq('gemini-3.5-flash:streamGenerateContent', CONTENTS), res, jest.fn() as any);
    await flushUntil(() => !!streamHandle);

    streamHandle.emit('data', Buffer.from('data: {"candidates":[]}\n\n'));
    res.emit('close');
    await done;

    expect(streamHandle.destroyed).toBe(true);
    expect(usageEvents[0][3]).toBe(499);
  });

  it('relays an upstream 400 body (a stream) as a Gemini 400 before any byte is written', async () => {
    nextPostRejection = {
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: Readable.from([JSON.stringify({
          error: 'BadRequest', message: "Subpath 'models/x:streamGenerateContent' is not allowed for model 'x'.",
        })]),
      },
    };
    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:streamGenerateContent', CONTENTS), res, jest.fn() as any);

    expect(res.statusCode).toBe(400);
    expect(res.body.error.status).toBe('INVALID_ARGUMENT');
    expect(res.body.error.message).toContain('is not allowed for model');
    expect(usageEvents[0][3]).toBe(400);
  });

  it('turns a transport failure into 502 UNAVAILABLE', async () => {
    nextPostRejection = { message: 'socket hang up', code: 'ECONNRESET' };
    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:streamGenerateContent', CONTENTS), res, jest.fn() as any);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toEqual({ code: 502, message: 'socket hang up', status: 'UNAVAILABLE' });
    expect(usageEvents[0][3]).toBe(502);
  });
});

describe('dispatchBridge: streaming', () => {
  it('writes the translator\'s Gemini frames and meters the translator\'s usage, not the frames', async () => {
    const res = mockRes();
    const done = handleGemini(mockReq('anthropic--claude-4.5-sonnet:streamGenerateContent', CONTENTS), res, jest.fn() as any);
    await flushUntil(() => !!onOrchestrationChunk);

    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(streamCalls[0].payload.config.modules.prompt_templating.model.name).toBe('anthropic--claude-4.5-sonnet');
    expect(streamCalls[0].payload.config.stream).toEqual({ enabled: true, chunk_size: 200 });

    await onOrchestrationChunk!({ final_result: { choices: [{ delta: { content: 'Hel' } }] } });
    await onOrchestrationChunk!({
      final_result: {
        choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 5 } },
      },
    });
    releaseStream!();
    await done;

    const wire = res.writes.join('');
    expect(wire).toContain('"text":"Hel"');
    expect(wire).toContain('"finishReason":"STOP"');
    // The CLIENT-facing frame is Gemini-shaped, so the cache read is inside promptTokenCount
    // (12 + 5); the BILLING metrics below stay in SAP's exclusive regime (12 full-rate + 5
    // cache-read as separate line items). Two regimes, one turn — that is the conversion.
    expect(wire).toContain('"promptTokenCount":17');
    expect(wire).toContain('"cachedContentTokenCount":5');
    const [, metrics, model, status] = usageEvents[0];
    expect(model).toBe('anthropic--claude-4.5-sonnet');
    expect(status).toBe(200);
    expect(metrics.inputTokens).toBe(12);
    expect(metrics.outputTokens).toBe(4);
    expect(metrics.cacheReadInputTokens).toBe(5);
    expect(res.ended).toBe(true);
  });

  it('meters BOTH orchestration cache counters — write and read — alongside full-rate input', async () => {
    const res = mockRes();
    const done = handleGemini(mockReq('anthropic--claude-4.5-sonnet:streamGenerateContent', CONTENTS), res, jest.fn() as any);
    await flushUntil(() => !!onOrchestrationChunk);

    // SAP reports all three EXCLUSIVE of each other on this payload shape, and admin's cost
    // SQL prices cache-write as its own line item — a hardcoded 0 here under-bills the turn.
    await onOrchestrationChunk!({
      final_result: {
        choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 5, cache_creation_tokens: 9 },
        },
      },
    });
    releaseStream!();
    await done;

    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.outputTokens).toBe(4);
    expect(metrics.cacheCreationInputTokens).toBe(9);
    expect(metrics.cacheReadInputTokens).toBe(5);
    // Same turn, the other regime: the client's frame reports ONE prompt of 14 + 5 + 9.
    expect(res.writes.join('')).toContain('"promptTokenCount":28');
  });

  it('runs after-plugins on every translated frame, so masking sees Gemini shapes', async () => {
    configState.hookConfig = [{ request: { match: ['*'], callback: { id: 'x' } } }];
    afterPlugins = (_r: any, _s: any, body: any) => {
      const part = body?.candidates?.[0]?.content?.parts?.[0];
      if (part && typeof part.text === 'string') part.text = part.text.toUpperCase();
      return Promise.resolve(body);
    };

    const res = mockRes();
    const done = handleGemini(mockReq('anthropic--claude-4.5-sonnet:streamGenerateContent', CONTENTS), res, jest.fn() as any);
    await flushUntil(() => !!onOrchestrationChunk);

    // The orchestration hookConfig is deliberately NOT handed to streamChatCompletion:
    // plugins must see translated Gemini frames, never raw orchestration chunks.
    expect(streamCalls[0].hookConfig).toBeUndefined();

    await onOrchestrationChunk!({ final_result: { choices: [{ delta: { content: 'hel' }, finish_reason: 'stop' }] } });
    releaseStream!();
    await done;

    expect(afterPluginBodies[0].candidates[0].content.parts[0].text).toBe('HEL');
    expect(res.writes.join('')).toContain('"text":"HEL"');
  });

  it('aborts the orchestration call when the client disconnects', async () => {
    const res = mockRes();
    const done = handleGemini(mockReq('anthropic--claude-4.5-sonnet:streamGenerateContent', CONTENTS), res, jest.fn() as any);
    await flushUntil(() => streamCalls.length > 0);

    expect(streamCalls[0].abortSignal.aborted).toBe(false);
    res.emit('close');
    expect(streamCalls[0].abortSignal.aborted).toBe(true);

    releaseStream!();
    await done;
    expect(usageEvents[0][3]).toBe(499);
  });

  it('reports a mid-stream orchestration failure as a Gemini error frame and meters the failure', async () => {
    const res = mockRes();
    const done = handleGemini(mockReq('anthropic--claude-4.5-sonnet:streamGenerateContent', CONTENTS), res, jest.fn() as any);
    await flushUntil(() => !!onOrchestrationChunk);

    await onOrchestrationChunk!({ final_result: { choices: [{ delta: { content: 'partial' } }] } });
    const err: any = new Error('orchestration exploded');
    err.status = 503;
    rejectStream!(err);
    await done;

    expect(res.writes.join('')).toContain('"code":503');
    expect(res.ended).toBe(true);
    expect(usageEvents[0][3]).toBe(503);
  });
});
