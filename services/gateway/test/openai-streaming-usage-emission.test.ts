/**
 * openaiController: single-emission invariant for the streaming final usage
 * chunk (#5 follow-up).
 *
 * Task 5 (see openai-streaming-usage.test.ts for the pure-function unit
 * coverage of `usageChunk` / `transformSAPResponseToOpenAI`) added a
 * client-opt-in final usage chunk on the native streaming path, written
 * immediately before `[DONE]` at TWO call sites in `handleChatCompletion`:
 * the mid-callback `chunk.done` marker branch, and the post-promise
 * "stream completed successfully" branch. Only one of those sites should
 * ever actually fire the write, because the second one is guarded by
 * `if (!res.writableEnded)` — and `sseWriter.writeDone` synchronously ends
 * the response. That guarantee currently rests entirely on that cross-file
 * timing (mocked here to reproduce it faithfully: see the `writeDone` mock
 * below), with no prior test pinning it down. A future change to either
 * site's ordering, or to `writeDone`'s end-of-response side effect, could
 * silently double-emit the usage chunk (or drop it) with nothing failing.
 *
 * This suite drives the real streaming `onChunk` callback through the
 * `chunk.done` marker (exactly like a real terminal SAP chunk would) and
 * asserts, at the `sseWriter` mock boundary, that exactly one `[DONE]` and
 * exactly one usage chunk are written, in that order, when the client opts
 * in — and that zero usage chunks are written when it does not. Mocking
 * scaffold mirrors test/openai-usage-folding.test.ts (same modules stubbed,
 * same capture-the-onChunk-callback / resolvable-streaming-promise pattern).
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
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
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

let capturedOnChunk: ((chunk: any) => void | Promise<void>) | null = null;
let resolveStreamingPromise: (() => void) | null = null;

jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    completeChat: () => Promise.reject(new Error('completeChat not stubbed for this test')),
    streamChatCompletion: (_payload: any, onChunk: any) => {
      capturedOnChunk = onChunk;
      return new Promise<void>((resolve) => { resolveStreamingPromise = resolve; });
    },
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

// The module under test is checked here at the `sseWriter` boundary, not the
// raw `res.write` boundary, so `writeChunk`/`writeDone`/`writeError` are
// jest.fn()s we can inspect directly. `writeDone` sets `res.writableEnded =
// true` to faithfully reproduce production sequencing (the real
// implementation calls `res.end()`) — this is what makes the controller's
// own `if (!res.writableEnded)` guard at the post-promise completion site
// actually skip on the second pass, exactly as it does in production.
jest.mock('../src/utils/sseWriter', () => ({
  writeChunk: jest.fn(),
  writeDone: jest.fn((res: any) => { res.writableEnded = true; }),
  writeError: jest.fn(),
}));

import { handleChatCompletion } from '../src/controllers/openaiController';
import * as sseWriter from '../src/utils/sseWriter';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {},
    writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.set = (headers: Record<string, string>) => { Object.assign(r.headers, headers); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (_s: string) => true;
  r.end = () => { r.ended = true; r.writableEnded = true; };
  return r;
}

function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = {};
  r.query = {};
  return r;
}

async function flushUntil(cond: () => boolean, maxTries = 50): Promise<void> {
  for (let i = 0; i < maxTries && !cond(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Parsed args of every writeChunk(res, jsonString) call. */
function writtenChunks(): any[] {
  return (sseWriter.writeChunk as jest.Mock).mock.calls.map((call: any[]) => JSON.parse(call[1] as string));
}

/** A usage chunk per usageChunk()'s contract: empty choices, a usage field. */
function isUsageChunk(c: any): boolean {
  return Array.isArray(c.choices) && c.choices.length === 0 && c.usage !== undefined;
}

describe('openaiController: single-emission invariant for the streaming final usage chunk (#5)', () => {
  beforeEach(() => {
    usageEvents.length = 0;
    capturedOnChunk = null;
    resolveStreamingPromise = null;
    (sseWriter.writeChunk as jest.Mock).mockClear();
    (sseWriter.writeDone as jest.Mock).mockClear();
    (sseWriter.writeError as jest.Mock).mockClear();
  });

  async function driveStream(streamOptions: any) {
    const req = mockReq({
      model: 'anthropic--claude-4.8-opus',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      ...(streamOptions !== undefined ? { stream_options: streamOptions } : {}),
    });
    const res = mockRes();

    await handleChatCompletion(req, res, () => {});
    await flushUntil(() => capturedOnChunk !== null);

    // Content/delta chunk carrying the SAP-side usage that accounting reads.
    await capturedOnChunk!({
      final_result: {
        id: 'chatcmpl-1', created: 1786000000, model: 'anthropic--claude-4.8-opus',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
    });

    // Terminal marker — this is the mid-callback branch under test. In
    // production this is where the stream actually ends: writeDone's
    // res.end() (mocked here as res.writableEnded = true) makes the LATER
    // post-promise completion branch's own writeDone a no-op.
    await capturedOnChunk!({ done: true });

    resolveStreamingPromise!();
    await flushUntil(() => usageEvents.length > 0);

    return res;
  }

  it('opted in: exactly one usage chunk is written, exactly once before the single [DONE]', async () => {
    await driveStream({ include_usage: true });

    const chunks = writtenChunks();
    const usageChunks = chunks.filter(isUsageChunk);
    expect(usageChunks).toHaveLength(1);
    expect(usageChunks[0].usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });

    // Content/delta chunks never carry usage.
    const contentChunk = chunks.find((c) => c.choices?.[0]?.delta?.content === 'hi');
    expect(contentChunk.usage).toBeUndefined();

    // [DONE] fired exactly once — the post-promise completion site's own
    // writeDone no-oped behind `if (!res.writableEnded)`.
    expect((sseWriter.writeDone as jest.Mock).mock.calls).toHaveLength(1);

    // Ordering: the usage chunk lands before [DONE], not after.
    const usageChunkCallIndex = chunks.findIndex(isUsageChunk);
    const usageCallOrder = (sseWriter.writeChunk as jest.Mock).mock.invocationCallOrder[usageChunkCallIndex];
    const doneCallOrder = (sseWriter.writeDone as jest.Mock).mock.invocationCallOrder[0];
    expect(usageCallOrder).toBeLessThan(doneCallOrder);
  });

  it('not opted in (stream_options omitted): zero usage chunks, still exactly one [DONE]', async () => {
    await driveStream(undefined);

    const chunks = writtenChunks();
    expect(chunks.filter(isUsageChunk)).toHaveLength(0);
    expect((sseWriter.writeDone as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('not opted in (include_usage: false): zero usage chunks, still exactly one [DONE]', async () => {
    await driveStream({ include_usage: false });

    const chunks = writtenChunks();
    expect(chunks.filter(isUsageChunk)).toHaveLength(0);
    expect((sseWriter.writeDone as jest.Mock).mock.calls).toHaveLength(1);
  });
});
