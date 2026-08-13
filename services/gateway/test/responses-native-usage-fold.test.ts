/**
 * responsesController: native-path fold-site coverage for T4b (the widened
 * `__responsesExtraUsage` accumulator's 4-category split reaching the usage metrics).
 *
 * A separate file rather than an addition to `responses-controller.test.ts`: that file's
 * gate for this task is to keep passing UNEDITED (its continuation fixtures carry no
 * `input_tokens_details`, so the fold change is arithmetically invisible to them). Mocking
 * style is lifted from it — same axios/modelService/configService fakes and the same
 * mockRes()/mockReq() shapes — so this suite exercises the real fold sites in
 * `responsesController.ts` (the native, non-orchestration branch), not a reimplementation
 * of them. `test/responses-orchestration-dispatch.test.ts` covers the bridge's own two
 * fold sites the same way; `test/usage-folding.test.ts` covers the subtraction arithmetic
 * itself, in `noteExtraUsage`.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

let streamHandle: (EventEmitter & { destroy: () => void }) | null = null;
// Overridable per test so the cache-write regression coverage below can exercise
// `applyResponsesUsage`'s real read site with a real upstream body, not a reimplementation.
let baseUsage: any = { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 2 } };
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (_url: string, _body: any, cfg: any) => {
      if (cfg?.responseType === 'stream') {
        const stream: any = new EventEmitter();
        stream.destroy = () => { stream.emit('close'); };
        streamHandle = stream;
        return Promise.resolve({ status: 200, data: stream });
      }
      return Promise.resolve({
        status: 200,
        data: {
          id: 'resp_1', object: 'response', status: 'completed', output: [],
          // Base fold (applyResponsesUsage / foldInclusiveUsage): full-rate remainder
          // max(0, 5 - 2 - 0) = 3, cache-read 2.
          usage: baseUsage,
        },
      });
    },
  },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(
      m === 'gpt-5.3-codex--deployed'
        ? { id: m, model: 'gpt-5.3-codex', owned_by: 'OpenAI', deploymentUrl: 'http://mock-sap/deployments/abc' }
        : null
    ),
    getAuthToken: () => Promise.resolve('tok'),
  },
}));

const configState: any = { hookConfig: undefined };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportsResponsesApi: () => undefined,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getTimeout: () => 1000,
    getHookConfig: () => configState.hookConfig,
    isPseudonymizationForced: () => false,
    getConfig: () => ({}),
  },
}));

// Configurable after-plugin behavior, same pattern as responses-controller.test.ts: the
// only way to prove the fold reads __responsesExtraUsage AFTER a plugin has accumulated
// onto it during the after-chain, for the non-streaming branch.
let afterPlugins: (req: any, res: any, body: any) => Promise<any> =
  (_req: any, _res: any, body: any) => Promise.resolve(body);
jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (req: any, res: any, body: any) => afterPlugins(req, res, body),
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

import { handleResponses } from '../src/controllers/responsesController';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[], ended: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.write = (s: string) => {
    if (r.writableEnded) throw new Error('write after end');
    r.writes.push(s);
    return true;
  };
  r.end = () => { r.ended = true; r.writableEnded = true; };
  r.writableEnded = false;
  return r;
}

function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = {};
  return r;
}

async function flushUntil(cond: () => boolean, maxTries = 50): Promise<void> {
  for (let i = 0; i < maxTries && !cond(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('responsesController: native-path fold sites (T4b)', () => {
  beforeEach(() => {
    usageEvents.length = 0;
    streamHandle = null;
    configState.hookConfig = undefined;
    afterPlugins = (_req: any, _res: any, body: any) => Promise.resolve(body);
    baseUsage = { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 2 } };
  });

  /**
   * applyResponsesUsage (responsesController.ts): the actual regression this task fixes. The
   * real OpenAI/ChatGPT Responses API — and our own deployed path — names the cache-write
   * count `cache_write_tokens` (see RESPONSES-API-COMPLIANCE.md and the captured deployment
   * payload cited in usageFolding.ts's readCacheWriteTokens). Before this fix, this function
   * hardcoded the cache-creation argument to `foldInclusiveUsage` as 0 and never read the field
   * at all, so a real deployment response's cache-write count was silently dropped from billing.
   */
  it('folds a real upstream cache_write_tokens into the usage metrics — the fix for a bug that previously read this as 0, non-streaming', async () => {
    baseUsage = {
      input_tokens: 9561, output_tokens: 27,
      input_tokens_details: { cache_write_tokens: 3000, cached_tokens: 0 },
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'hi' });
    const res = mockRes();
    await handleResponses(req, res, () => {});

    const metrics = usageEvents[0][1];
    // Inclusive fold: full-rate input = max(0, 9561 - 0 cached - 3000 write) = 6561.
    expect(metrics.inputTokens).toBe(6561);
    expect(metrics.outputTokens).toBe(27);
    expect(metrics.cacheCreationInputTokens).toBe(3000);
    expect(metrics.cacheReadInputTokens).toBe(0);
  });

  it('still folds the legacy cache_creation_tokens name for an upstream that has not caught up, non-streaming', async () => {
    baseUsage = {
      input_tokens: 9561, output_tokens: 27,
      input_tokens_details: { cache_creation_tokens: 3000, cached_tokens: 0 },
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'hi' });
    const res = mockRes();
    await handleResponses(req, res, () => {});

    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(6561);
    expect(metrics.cacheCreationInputTokens).toBe(3000);
  });

  it('folds a real upstream cache_write_tokens on the streaming transport too', async () => {
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'hi', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
    streamHandle!.emit('data', Buffer.from(frame({
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: 'resp_1', status: 'completed',
        usage: {
          input_tokens: 9561, output_tokens: 27,
          input_tokens_details: { cache_write_tokens: 3000, cached_tokens: 0 },
          total_tokens: 9588,
        },
      },
    })));
    streamHandle!.emit('end');

    await handlerPromise;

    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(6561);
    expect(metrics.cacheCreationInputTokens).toBe(3000);
  });

  it('folds the accumulator\'s cache-creation/cache-read split into the usage metrics, non-streaming', async () => {
    configState.hookConfig = [{ request: { callback: { id: 'stand-in-for-the-hosted-tool-engine' } } }];
    afterPlugins = (req: any, _res: any, body: any) => {
      const extra = req.__responsesExtraUsage;
      extra.input_tokens += 14;
      extra.output_tokens += 8;
      extra.cache_creation_tokens = (extra.cache_creation_tokens || 0) + 29000;
      extra.cache_read_tokens = (extra.cache_read_tokens || 0) + 21292;
      return Promise.resolve(body);
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'hi' });
    const res = mockRes();
    await handleResponses(req, res, () => {});

    const metrics = usageEvents[0][1];
    // Base 3/2 (5 - 2 cached) plus the continuation's 14/8 full-rate remainder.
    expect(metrics.inputTokens).toBe(3 + 14);
    expect(metrics.outputTokens).toBe(2 + 8);
    expect(metrics.cacheCreationInputTokens).toBe(29000);
    // Base cache-read (2, from the first call) plus the continuation's 21292.
    expect(metrics.cacheReadInputTokens).toBe(2 + 21292);
  });

  it('folds the accumulator\'s cache-creation/cache-read split into the usage metrics, streaming', async () => {
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'hi', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    // Simulates the hosted-tool engine's continuation having already split a round's
    // usage onto __responsesExtraUsage via noteExtraUsage, before the primary stream ends.
    const extra = (req as any).__responsesExtraUsage;
    extra.input_tokens += 14;
    extra.output_tokens += 8;
    extra.cache_creation_tokens = 29000;
    extra.cache_read_tokens = 21292;

    const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
    streamHandle!.emit('data', Buffer.from(frame({
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: 'resp_1', status: 'completed',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    })));
    streamHandle!.emit('end');

    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    const metrics = usageEvents[0][1];
    // Base 5/2 (no cache activity on the primary frame) plus the continuation's 14/8.
    expect(metrics.inputTokens).toBe(5 + 14);
    expect(metrics.outputTokens).toBe(2 + 8);
    expect(metrics.cacheCreationInputTokens).toBe(29000);
    expect(metrics.cacheReadInputTokens).toBe(21292);
  });
});
