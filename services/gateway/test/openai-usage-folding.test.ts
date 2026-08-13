/**
 * openaiController: chat-completions orchestration path fold-site coverage (T5).
 *
 * Defect 2 of the usage-accounting audit: `handleChatCompletion` never read
 * `prompt_tokens_details` anywhere, so cached/cache-creation tokens reached the
 * client's JSON verbatim but never reached the gateway's usage metrics. Fixed by
 * routing every fold site through `foldExclusiveUsage` (src/utils/usageFolding.ts),
 * which this suite deliberately does NOT mock — only `usageTracker`'s
 * `updateTokenCounts` is mocked (to a plain accumulator), so these tests exercise
 * the real fold arithmetic, not a reimplementation of it. Mirrors the mocking style
 * of test/responses-native-usage-fold.test.ts.
 *
 * Regime: EXCLUSIVE. Measured live on POST /openai/v1/chat/completions, 2026-08-07
 * (test/fixtures/orchestration/cache-probe-result.md): prompt_tokens stayed flat at
 * 14 across two identical calls while prompt_tokens_details.cached_tokens went
 * 0 -> 29004 (and 0 -> 32004 in the narrative-prefix run). Streaming chat never
 * emits cache_creation_tokens (same fixture, Q3) — the streaming fixture below
 * deliberately omits that field rather than inventing one this path never produces.
 *
 * The `--deployed` model branch (last test below) is NOT covered by that live
 * measurement — it bypasses SAP orchestration and axios.posts a real
 * OpenAI-compatible provider endpoint directly, whose documented cache-token
 * contract is INCLUSIVE, not EXCLUSIVE. That test asserts the deliberate
 * no-split behavior on that branch, not the EXCLUSIVE fold the rest of this
 * file covers.
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
    getModelDetails: (m: string) => m && m.endsWith('--deployed')
      ? Promise.resolve({
          id: m, owned_by: 'openai', provider: 'openai',
          deploymentUrl: 'https://deployed.example.com/v1', model: 'gpt-4o',
        })
      : Promise.resolve({ id: 'anthropic--claude-4.8-opus', owned_by: 'anthropic' }),
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

let mockCompleteChat: (payload: any, debugRequestId?: string) => Promise<any> = () =>
  Promise.reject(new Error('completeChat not stubbed for this test'));
let capturedOnChunk: ((chunk: any) => void | Promise<void>) | null = null;
let resolveStreamingPromise: (() => void) | null = null;

jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    completeChat: (payload: any, debugRequestId?: string) => mockCompleteChat(payload, debugRequestId),
    streamChatCompletion: (_payload: any, onChunk: any) => {
      capturedOnChunk = onChunk;
      return new Promise<void>((resolve) => { resolveStreamingPromise = resolve; });
    },
  },
}));

// Only used by the deployed-model branch (--deployed models bypass sapAIService
// entirely and axios.post the provider's own /chat/completions directly).
let mockAxiosPost: (url: string, body: any, cfg: any) => Promise<any> = () =>
  Promise.reject(new Error('axios.post not stubbed for this test'));
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any, cfg: any) => mockAxiosPost(url, body, cfg),
  },
}));

// Real usageFolding.ts is NOT mocked — only its own dependency, updateTokenCounts,
// is, as a plain accumulator. This is what lets these tests exercise the real
// foldExclusiveUsage arithmetic reached from the controller's fold sites.
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

import { handleChatCompletion } from '../src/controllers/openaiController';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[],
    writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.set = (headers: Record<string, string>) => { Object.assign(r.headers, headers); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => {
    if (r.writableEnded) throw new Error('write after end');
    r.writes.push(s);
    return true;
  };
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

function sapNonStreamingResult(usage: any) {
  return {
    final_result: {
      id: 'chatcmpl-1', created: 1786000000, model: 'anthropic--claude-4.8-opus',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage,
    },
  };
}

describe('openaiController: chat-completions orchestration fold sites (T5)', () => {
  beforeEach(() => {
    usageEvents.length = 0;
    capturedOnChunk = null;
    resolveStreamingPromise = null;
    mockCompleteChat = () => Promise.reject(new Error('completeChat not stubbed for this test'));
    mockAxiosPost = () => Promise.reject(new Error('axios.post not stubbed for this test'));
  });

  it('non-streaming read turn: bills prompt_tokens as-is and cache-READ as a separate line item, never subtracted', async () => {
    mockCompleteChat = () => Promise.resolve(sapNonStreamingResult({
      completion_tokens: 4, prompt_tokens: 14, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 29004, cache_creation_tokens: 0 },
    }));

    const req = mockReq({ model: 'anthropic--claude-4.8-opus', messages: [{ role: 'user', content: 'hi' }] });
    const res = mockRes();
    await handleChatCompletion(req, res, () => {});

    expect(usageEvents).toHaveLength(1);
    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.outputTokens).toBe(4);
    expect(metrics.cacheReadInputTokens).toBe(29004);
    expect(metrics.cacheCreationInputTokens).toBe(0);
    // Client-facing JSON forwards SAP usage verbatim — untouched by the fold.
    expect(res.body.usage).toEqual({
      completion_tokens: 4, prompt_tokens: 14, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 29004, cache_creation_tokens: 0 },
    });
  });

  it('non-streaming write turn: bills prompt_tokens as-is and cache-CREATION as a separate line item', async () => {
    mockCompleteChat = () => Promise.resolve(sapNonStreamingResult({
      completion_tokens: 4, prompt_tokens: 14, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 29004 },
    }));

    const req = mockReq({ model: 'anthropic--claude-4.8-opus', messages: [{ role: 'user', content: 'hi' }] });
    const res = mockRes();
    await handleChatCompletion(req, res, () => {});

    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.cacheCreationInputTokens).toBe(29004);
    expect(metrics.cacheReadInputTokens).toBe(0);
  });

  it('non-streaming: a details-less usage object folds exactly as today (backward compat)', async () => {
    mockCompleteChat = () => Promise.resolve(sapNonStreamingResult({
      completion_tokens: 5, prompt_tokens: 14, total_tokens: 19,
    }));

    const req = mockReq({ model: 'anthropic--claude-4.8-opus', messages: [{ role: 'user', content: 'hi' }] });
    const res = mockRes();
    await handleChatCompletion(req, res, () => {});

    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.outputTokens).toBe(5);
    expect(metrics.cacheCreationInputTokens).toBe(0);
    expect(metrics.cacheReadInputTokens).toBe(0);
  });

  it('streaming: only the FINAL chunk carries usage; earlier chunks contribute nothing; no cache_creation_tokens on this path', async () => {
    const req = mockReq({ model: 'anthropic--claude-4.8-opus', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const res = mockRes();

    // handleChatCompletion does not await its own streaming .then()/.catch() chain
    // (it is fire-and-forget internally), so the returned promise resolves once the
    // stream is set up, not once it completes. Wait on usageEvents instead of on the
    // handler's own promise for the terminal state.
    await handleChatCompletion(req, res, () => {});
    await flushUntil(() => capturedOnChunk !== null);

    // Chunk 1: role-only, no usage key at all.
    await capturedOnChunk!({
      final_result: {
        id: 'chatcmpl-1', created: 1786000000, model: 'anthropic--claude-4.8-opus',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
    });
    // Chunk 2: content delta, usage explicitly null (matches the live capture).
    await capturedOnChunk!({
      final_result: {
        id: 'chatcmpl-1', created: 1786000000, model: 'gpt-4',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
        usage: null,
      },
    });
    // Chunk 3 (final): the only usage-bearing chunk. No cache_creation_tokens field —
    // this is the measured shape; streaming chat never emits it.
    await capturedOnChunk!({
      final_result: {
        id: 'chatcmpl-1', created: 1786000000, model: 'anthropic--claude-4.8-opus',
        choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
        usage: {
          completion_tokens: 8, prompt_tokens: 28, total_tokens: 36,
          prompt_tokens_details: { cached_tokens: 58128 },
        },
      },
    });

    resolveStreamingPromise!();
    await flushUntil(() => usageEvents.length > 0);

    expect(usageEvents).toHaveLength(1);
    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(28);
    expect(metrics.outputTokens).toBe(8);
    expect(metrics.cacheReadInputTokens).toBe(58128);
    expect(metrics.cacheCreationInputTokens).toBe(0);
  });

  it('deployed-model branch: cache tokens are NOT split even when the response carries prompt_tokens_details, because this producer\'s regime is unverified', async () => {
    mockAxiosPost = () => Promise.resolve({
      status: 200,
      data: {
        id: 'chatcmpl-1', object: 'chat.completion', created: 1786000000, model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: {
          completion_tokens: 4, prompt_tokens: 14, total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 12 },
        },
      },
    });

    const req = mockReq({ model: 'gpt-4o--deployed', messages: [{ role: 'user', content: 'hi' }] });
    const res = mockRes();
    await handleChatCompletion(req, res, () => {});

    expect(usageEvents).toHaveLength(1);
    const metrics = usageEvents[0][1];
    // Full prompt_tokens is billed as-is, but cached_tokens is NOT split out —
    // unlike the SAP-orchestration sites above, this branch's regime (INCLUSIVE
    // vs EXCLUSIVE) has no live capture backing it, so splitting would risk
    // double-counting against prompt_tokens.
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.cacheReadInputTokens).toBe(0);
    expect(metrics.cacheCreationInputTokens).toBe(0);
    // Client-facing JSON forwards the provider's usage verbatim — untouched by the fold.
    expect(res.body.usage).toEqual({
      completion_tokens: 4, prompt_tokens: 14, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 12 },
    });
  });
});
