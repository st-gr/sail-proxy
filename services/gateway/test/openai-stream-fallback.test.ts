/**
 * openaiController: streaming -> non-streaming fallback after SSE headers were
 * flushed (B9, docs/superpowers/plans/2026-09-25-review-fixes/B.md).
 *
 * When a model claims streaming support but the upstream rejects it mid-flight
 * (`err.streamingNotSupported`) and no emulation is configured for that model,
 * `handleChatCompletion` retries the request as non-streaming. But by the time
 * that retry runs, the SSE preamble (headers + the initial role chunk) was
 * already flushed for the original streaming attempt. Calling `res.json(...)`
 * at that point throws `ERR_HTTP_HEADERS_SENT` (Express's `res.json` calls
 * `res.set`, which calls Node's `setHeader`, which throws once headers are
 * sent) — the client was left with the role chunk, then a silent EOF: no
 * content, no `[DONE]`, and no usage event for a completion that the upstream
 * had already produced.
 *
 * This suite drives the real fallback path with a mock upstream (streaming
 * rejects with `streamingNotSupported`, the non-streaming retry succeeds) and
 * a `res` mock that reproduces Node's header-already-sent throw, exactly like
 * production. It consumes the REAL `sseWriter` output (not mocked, unlike
 * test/openai-streaming-usage-emission.test.ts) so the assertions cover the
 * actual bytes written to the client. Mocking scaffold otherwise mirrors
 * test/openai-usage-folding.test.ts and test/openai-streaming-usage-emission.test.ts.
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
    getModelDetails: () => Promise.resolve({ id: 'anthropic--claude-4.8-opus', owned_by: 'anthropic' }),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    // No emulation configured anywhere in this suite — this is what forces the
    // handleChatCompletion catch(err.streamingNotSupported) into the "else"
    // (plain non-streaming fallback) branch under test, never the emulation branch.
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    // Read by the forced-pseudonymization check: nothing forces masking here.
    getConfig: () => ({}),
    getHookConfig: () => undefined,
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

const FALLBACK_RESPONSE = {
  final_result: {
    id: 'chatcmpl-fallback', created: 1786000100, model: 'anthropic--claude-4.8-opus',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello from fallback' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  },
};

jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    // Rejects to simulate a model that claims streaming support but the
    // upstream refuses it mid-flight, exactly the trigger for the
    // catch(err.streamingNotSupported) branch.
    streamChatCompletion: () => Promise.reject(Object.assign(new Error('streaming not supported'), { streamingNotSupported: true })),
    completeChat: () => Promise.resolve(FALLBACK_RESPONSE),
  },
}));

const usageEvents: any[] = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: (...args: any[]) => { usageEvents.push([args[0], { ...args[1] }, args[2], args[3]]); },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0;
    m.cacheReadInputTokens += cacheRead || 0;
  },
}));

// sseWriter is deliberately NOT mocked — this suite consumes the real SSE
// bytes written to `res.write`, the same way a real client would.
import { handleChatCompletion } from '../src/controllers/openaiController';

/**
 * Reproduces the two Node/Express behaviours the bug depends on:
 *  - `setHeader` throws ERR_HTTP_HEADERS_SENT once headers were sent
 *    (`flushHeaders` or a prior `res.json`/`write` sets that flag).
 *  - Express's `res.json` calls `res.set(...)` (-> `setHeader`) before
 *    writing the body, so it throws in exactly the same way in this mock
 *    as it does in production.
 */
function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {} as Record<string, string>,
    writable: true, writableEnded: false, headersSent: false,
    chunks: [] as string[],
  });
  r.setHeader = (k: string, v: string) => {
    if (r.headersSent) {
      const e: any = new Error('Cannot set headers after they are sent to the client');
      e.code = 'ERR_HTTP_HEADERS_SENT';
      throw e;
    }
    r.headers[k] = v;
  };
  r.set = (headers: Record<string, string>) => {
    Object.entries(headers).forEach(([k, v]) => r.setHeader(k, v));
    return r;
  };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => {
    r.set({ 'Content-Type': 'application/json; charset=utf-8' }); // throws if headersSent, exactly like Express
    r.body = b;
    r.headersSent = true;
    r.writableEnded = true;
    return r;
  };
  r.flushHeaders = () => { r.headersSent = true; };
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

// The fallback's SSE delivery (emulateOpenAIStreamFromFullResponse) paces
// content chunks with a real `setTimeout(..., 30)` between each one, so
// draining it needs real wall-clock waits, not just microtask flushes.
async function flushUntil(cond: () => boolean, maxTries = 100): Promise<void> {
  for (let i = 0; i < maxTries && !cond(); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** Every `data: ...` SSE frame written, in order; `[DONE]` kept as the literal string. */
function writtenFrames(res: any): any[] {
  const raw = res.chunks.join('');
  return raw
    .split('\n\n')
    .filter((block: string) => block.startsWith('data: '))
    .map((block: string) => block.slice('data: '.length))
    .map((data: string) => (data === '[DONE]' ? '[DONE]' : JSON.parse(data)));
}

describe('openaiController: non-streaming fallback after SSE headers were flushed (B9)', () => {
  beforeEach(() => {
    usageEvents.length = 0;
  });

  async function driveFallback(streamOptions?: any) {
    const req = mockReq({
      model: 'anthropic--claude-4.8-opus',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      ...(streamOptions !== undefined ? { stream_options: streamOptions } : {}),
    });
    const res = mockRes();
    const next = jest.fn();

    await handleChatCompletion(req, res, next);
    // The streaming attempt's headers + role chunk are flushed synchronously
    // before any await; the retry (completeChat + fallback delivery) runs in
    // later microtasks off the streamingPromise.catch chain.
    await flushUntil(() => res.writableEnded || usageEvents.length > 0);
    await flushUntil(() => res.writableEnded);

    return { res, next };
  }

  it('headers already sent: delivers the fallback as SSE chunks + [DONE], with no thrown error', async () => {
    const { res, next } = await driveFallback({ include_usage: true });

    // Sanity: the bug only reproduces once headers were actually flushed
    // before the fallback ran.
    expect(res.headersSent).toBe(true);

    const frames = writtenFrames(res);

    // The fallback delivery paces content over several delta chunks (like the
    // full-response emulator it reuses), so assert on the concatenated text.
    const joinedContent = frames
      .filter((f: any) => f !== '[DONE]' && f.choices?.[0]?.delta?.content !== undefined)
      .map((f: any) => f.choices[0].delta.content)
      .join('');
    expect(joinedContent).toBe('hello from fallback');

    const finishFrame = frames.find((f: any) => f !== '[DONE]' && f.choices?.[0]?.finish_reason === 'stop');
    expect(finishFrame).toBeDefined();

    const usageFrame = frames.find((f: any) => f !== '[DONE]' && Array.isArray(f.choices) && f.choices.length === 0 && f.usage);
    expect(usageFrame).toBeDefined();
    expect(usageFrame.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });

    expect(frames[frames.length - 1]).toBe('[DONE]');

    // The response must actually end — no hung connection, no thrown
    // ERR_HTTP_HEADERS_SENT reaching Express's error handler.
    expect(res.writableEnded).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('headers already sent: the retried completion is billed exactly once', async () => {
    await driveFallback({ include_usage: true });

    expect(usageEvents).toHaveLength(1);
    const [, metrics, model, statusCode] = usageEvents[0];
    expect(model).toBe('anthropic--claude-4.8-opus');
    expect(statusCode).toBe(200);
    expect(metrics.inputTokens).toBe(5);
    expect(metrics.outputTokens).toBe(7);
  });

  it('client did not opt into stream_options.include_usage: no usage chunk, still ends with [DONE]', async () => {
    const { res } = await driveFallback(undefined);

    const frames = writtenFrames(res);
    const usageFrame = frames.find((f: any) => f !== '[DONE]' && Array.isArray(f.choices) && f.choices.length === 0 && f.usage);
    expect(usageFrame).toBeUndefined();
    expect(frames[frames.length - 1]).toBe('[DONE]');

    // Usage is still billed internally even though the client didn't ask to see it.
    expect(usageEvents).toHaveLength(1);
  });
});
