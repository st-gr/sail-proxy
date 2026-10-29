/**
 * responsesController: dispatch onto the SAP orchestration bridge.
 *
 * A catalogue model with no direct deployment (e.g. anthropic--claude-4.8-opus)
 * now goes through requestTranslator/responseTranslator/streamTranslator instead
 * of receiving a 400. Mocking style is lifted straight from
 * test/responses-controller.test.ts — same axios/modelService/configService
 * fakes and the same mockRes() shape — so this suite exercises the real dispatch
 * wiring in responsesController.ts, not a reimplementation of it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

// The native path's transport. Orchestration models must never reach this.
const posted: any[] = [];
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any, cfg: any) => {
      posted.push({ url, body, cfg });
      return Promise.resolve({ status: 200, data: { id: 'resp_1', object: 'response', status: 'completed', output: [] } });
    },
  },
}));

// Per-test cache-capability knob for the Anthropic catalogue model, reset in beforeEach.
// Feeds configService's getSupportsPromptCaching mock below (the model-level flag) —
// dispatchOrchestration resolves caching via configService now, not a field read
// straight off modelDetails.
let cacheFlag: boolean | undefined;
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(
      m === 'gpt-5.3-codex--deployed'
        ? { id: m, model: 'gpt-5.3-codex', owned_by: 'OpenAI', deploymentUrl: 'http://mock-sap/deployments/abc' }
        // Bare codex entry — the gateway lists every deployment twice, and the
        // sibling-swap test needs this to exist so the swap has something to fetch.
        : m === 'gpt-5.3-codex'
          ? { id: m, model: m, owned_by: 'OpenAI' }
          : m === 'anthropic--claude-4.8-opus'
            ? { id: m, model: m, owned_by: 'Anthropic' }
            // An OpenAI-family catalogue model with no deployment: served by this bridge, and
            // its SAP usage is INCLUSIVE (cached tokens counted inside prompt_tokens).
            : m === 'gpt-4.1-nano'
              ? { id: m, model: m, owned_by: 'OpenAI' }
              // A catalogue id whose name reads as another family than the SAP-side model
              // it resolves to: the cache regime must follow `model`, not the id.
              : m === 'claude-house-alias'
                ? { id: m, model: 'gpt-4.1-nano', owned_by: 'OpenAI' }
            // Deployed, but on a route this bridge does not serve — a chat-completions-only
            // deployment, standing in for "has a --deployed twin that cannot speak Responses."
            // The sibling swap must not adopt this even though it has a deploymentUrl.
            : m === 'anthropic--claude-4.8-opus--deployed'
              ? { id: m, model: m, owned_by: 'Anthropic', deploymentUrl: 'http://mock-sap/deployments/opus-chat-only' }
              : null
    ),
    getAuthToken: () => Promise.resolve('tok'),
  },
}));

// Per-test hook config, so the "plugins must not see raw orchestration chunks"
// assertion can drive a route that HAS plugins. Reset in beforeEach.
let hookConfigForRoute: any;
// jest.fn() (not a plain arrow) so the shared-verdict test can assert the CALL
// COUNT: dispatchOrchestration must resolve caching once per request and reuse
// it for the continuation builder, not re-resolve on every applyCacheBreakpoints
// call site.
const getSupportsPromptCaching = jest.fn((_provider?: string, modelName?: string) => (
  modelName ? cacheFlag : undefined
));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportsResponsesApi: () => undefined,   // no flag either way: heuristic decides
    getSupportsPromptCaching: (provider?: string, modelName?: string) => getSupportsPromptCaching(provider, modelName),
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getTimeout: () => 1000,
    getHookConfig: () => hookConfigForRoute,
    getConfig: () => ({}),
  },
}));

// Per-test after-plugin override, reset in beforeEach. Lets a test simulate a plugin
// (e.g. the hosted-tool engine's continuation) mutating __responsesExtraUsage DURING the
// after-chain — the only way to exercise the non-streaming fold site, which has no
// idle-hook equivalent to the streaming branch's `__responsesWebSearchIdle`.
let afterPluginsBehavior: ((req: any, res: any, body: any) => Promise<any>) | null = null;
jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (req: any, res: any, body: any) => (
    afterPluginsBehavior ? afterPluginsBehavior(req, res, body) : Promise.resolve(body)
  ),
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

// The orchestration transport. Configurable per test: `orchestrationResult` for the
// non-streaming call, `orchestrationChunks` for the streaming one.
const orchestrationCalls: Array<{ kind: 'non-streaming' | 'streaming'; payload: any; hookConfig?: any }> = [];
let orchestrationResult: any = {
  final_result: {
    choices: [{ message: { role: 'assistant', content: 'Hello from Opus' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 },
  },
};
let orchestrationChunks: any[] = [];
// When set, the streaming upstream delivers nothing until it resolves (a slow first token).
let streamGate: Promise<void> | null = null;
// When set, the corresponding transport call rejects instead of succeeding — shaped like
// sapAIService's real CustomError (`.status`/`.details`, no `.response`), reset in beforeEach.
let nonStreamingRejection: any = null;
let streamRejection: any = null;
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    callSAPAIOrchestration: (payload: any) => {
      orchestrationCalls.push({ kind: 'non-streaming', payload });
      if (nonStreamingRejection) return Promise.reject(nonStreamingRejection);
      return Promise.resolve(orchestrationResult);
    },
    streamChatCompletion: async (
      payload: any, onChunk: (chunk: any) => void,
      _abortSignal?: any, _clientReq?: any, hookConfig?: any,
    ) => {
      orchestrationCalls.push({ kind: 'streaming', payload, hookConfig });
      if (streamRejection) throw streamRejection;  // fails before any chunk is delivered
      if (streamGate) await streamGate;
      for (const chunk of orchestrationChunks) {
        await onChunk(chunk);
      }
    },
    // dispatchOrchestration stashes this on the request for the hosted-tool engine's own
    // continuation POSTs — unrelated to callSAPAIOrchestration/streamChatCompletion above,
    // but every orchestration dispatch now calls it up front, so it must resolve here too.
    getOrchestrationEndpoint: () => Promise.resolve({
      url: 'http://mock-sap/deployments/abc/v2/completion',
      headers: { Authorization: 'Bearer tok', 'AI-Resource-Group': 'default', 'Content-Type': 'application/json' },
    }),
  },
}));

import { handleResponses } from '../src/controllers/responsesController';
import { noteExtraUsage } from '../src/utils/usageFolding';

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

describe('responsesController: orchestration dispatch', () => {
  beforeEach(() => {
    posted.length = 0;
    usageEvents.length = 0;
    orchestrationCalls.length = 0;
    orchestrationChunks = [];
    nonStreamingRejection = null;
    streamRejection = null;
    cacheFlag = undefined;
    hookConfigForRoute = undefined;
    afterPluginsBehavior = null;
    getSupportsPromptCaching.mockClear();
    orchestrationResult = {
      final_result: {
        choices: [{ message: { role: 'assistant', content: 'Hello from Opus' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 },
      },
    };
  });

  it('reaches sapAIService, not axios, for a catalogue model with no direct deployment', async () => {
    const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'Say OK' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(orchestrationCalls).toHaveLength(1);
    expect(orchestrationCalls[0].kind).toBe('non-streaming');
    expect(posted).toHaveLength(0);
  });

  it('returns a Responses object with the model text in output[0], non-streaming', async () => {
    const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'Say OK' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(res.statusCode).toBe(200);
    expect(res.body.object).toBe('response');
    expect(res.body.output[0].type).toBe('message');
    expect(res.body.output[0].content[0].text).toBe('Hello from Opus');
  });

  it('folds the accumulator\'s cache-creation/cache-read split into the usage metrics, non-streaming (T4b)', async () => {
    // Base fold (recordOrchestrationUsage): prompt_tokens 14, completion_tokens 5, no cache
    // activity on the FIRST call — see beforeEach's default orchestrationResult. The
    // after-plugin chain then simulates the hosted-tool engine's continuation having
    // already split a round's usage onto __responsesExtraUsage via noteExtraUsage.
    hookConfigForRoute = [{ request: { callback: { id: 'stand-in-for-the-hosted-tool-engine' } } }];
    afterPluginsBehavior = (req: any, _res: any, body: any) => {
      const extra = req.__responsesExtraUsage;
      extra.input_tokens += 14;
      extra.output_tokens += 8;
      extra.cache_creation_tokens = (extra.cache_creation_tokens || 0) + 29000;
      extra.cache_read_tokens = (extra.cache_read_tokens || 0) + 21292;
      return Promise.resolve(body);
    };

    const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(14 + 14);     // 14 base + 14 continuation full-rate
    expect(metrics.outputTokens).toBe(5 + 8);       // 5 base + 8 continuation
    expect(metrics.cacheCreationInputTokens).toBe(29000);
    expect(metrics.cacheReadInputTokens).toBe(21292);
  });

  it('OpenAI-family model: bills the inclusive prompt_tokens net of the cache, and the client usage stays inclusive', async () => {
    // Live probe of 2026-09-30 (gpt-4.1-nano via orchestration): prompt_tokens 1978 on the
    // cold and the cached call, cached_tokens 0 -> 1792 — the cache is inside prompt_tokens.
    orchestrationResult = {
      final_result: {
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1978, completion_tokens: 1, total_tokens: 1979,
          prompt_tokens_details: { audio_tokens: 0, cached_tokens: 1792 },
        },
      },
    };
    const req: any = { body: { model: 'gpt-4.1-nano', input: 'Say OK' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(orchestrationCalls).toHaveLength(1);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][1]).toMatchObject({
      inputTokens: 186, outputTokens: 1, cacheReadInputTokens: 1792, cacheCreationInputTokens: 0,
    });
    expect(res.body.usage).toEqual({
      input_tokens: 1978,
      input_tokens_details: { cached_tokens: 1792, cache_write_tokens: 0 },
      output_tokens: 1,
      total_tokens: 1979,
    });
  });

  it('opens the streaming reply with response.created and closes with exactly one response.completed', async () => {
    orchestrationChunks = [
      { choices: [{ delta: { content: 'Hi ' } }] },
      { choices: [{ delta: { content: 'there' } }] },
    ];
    const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'Say hi', stream: true }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(orchestrationCalls).toHaveLength(1);
    expect(orchestrationCalls[0].kind).toBe('streaming');
    expect(posted).toHaveLength(0);

    const frames = res.writes.map((w: string) => JSON.parse(w.replace(/^data: /, '').trim()));
    expect(frames[0].type).toBe('response.created');
    const completed = frames.filter((f: any) => f.type === 'response.completed');
    expect(completed).toHaveLength(1);
    expect(frames[frames.length - 1].type).toBe('response.completed');

    // Framing alone is not the contract — the client has to receive the model's WORDS.
    // Asserting only the frame types let a regression that dropped every delta pass.
    expect(frames.filter((f: any) => f.type === 'response.output_text.delta').map((f: any) => f.delta))
      .toEqual(['Hi ', 'there']);
    expect(completed[0].response.output[0].content[0].text).toBe('Hi there');

    // And the socket has to be CLOSED. Deleting res.end() left every streaming client
    // hanging on an open connection with the whole suite still green, because nothing
    // anywhere asserted res.ended — which mockRes() has tracked all along.
    expect(res.ended).toBe(true);
  });

  // Critical 2: the streaming branch skipped the continuation lifecycle that
  // `forwardStream` documents as load-bearing. These pin the two halves of it that are
  // observable from here — the usage fold, and the client-disconnect abort.
  describe('streaming lifecycle', () => {
    it('folds usage carried on a streaming chunk — deleting the fold must not stay green', async () => {
      // No chunk in any other streaming test carries `usage`, so recordOrchestrationUsage
      // returned on its first line and deleting the call outright passed the suite.
      // Same live-measured EXCLUSIVE numbers as the non-streaming folds below.
      orchestrationChunks = [
        { final_result: { choices: [{ delta: { content: 'Hi' } }] } },
        {
          final_result: {
            choices: [{ delta: {} }],
            usage: {
              prompt_tokens: 14,
              completion_tokens: 8,
              total_tokens: 22,
              prompt_tokens_details: { cached_tokens: 17692, cache_creation_tokens: 0 },
            },
          },
        },
      ];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(usageEvents).toHaveLength(1);
      const metrics = usageEvents[0][1];
      expect(metrics.inputTokens).toBe(14);              // as reported: nothing subtracted
      expect(metrics.cacheReadInputTokens).toBe(17692);
      expect(metrics.outputTokens).toBe(8);
      expect(res.ended).toBe(true);
    });

    it('folds __responsesExtraUsage, so a continuation round\'s tokens are billed', async () => {
      // The accumulator the hosted-tool engine `+=`es onto. It was allocated for this
      // branch and then never read by it, so every continuation round was free.
      orchestrationChunks = [{ final_result: { choices: [{ delta: { content: 'Hi' } }] } }];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      // Stands in for the engine's continuation, which lands while the idle wait runs.
      (res as any).__responsesWebSearchIdle = () => {
        req.__responsesExtraUsage.input_tokens += 40;
        req.__responsesExtraUsage.output_tokens += 7;
        return Promise.resolve();
      };
      await handleResponses(req, res, () => {});

      const metrics = usageEvents[0][1];
      expect(metrics.inputTokens).toBe(40);
      expect(metrics.outputTokens).toBe(7);
    });

    it('folds the accumulator\'s cache-creation/cache-read split into the usage metrics, streaming (T4b)', async () => {
      // Stands in for `noteExtraUsage` having already split a continuation round's usage
      // onto the accumulator — this test is about the FOLD SITE (responsesController's
      // `updateTokenCounts(usageMetrics, extra.input_tokens, ..., extra.cache_creation_tokens
      // || 0, extra.cache_read_tokens || 0)`), not the subtraction arithmetic itself, which
      // `usage-folding.test.ts` covers directly.
      orchestrationChunks = [{ final_result: { choices: [{ delta: { content: 'Hi' } }] } }];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      (res as any).__responsesWebSearchIdle = () => {
        const extra = req.__responsesExtraUsage;
        extra.input_tokens += 14;
        extra.output_tokens += 8;
        extra.cache_creation_tokens = (extra.cache_creation_tokens || 0) + 29000;
        extra.cache_read_tokens = (extra.cache_read_tokens || 0) + 21292;
        return Promise.resolve();
      };
      await handleResponses(req, res, () => {});

      const metrics = usageEvents[0][1];
      expect(metrics.inputTokens).toBe(14);
      expect(metrics.outputTokens).toBe(8);
      expect(metrics.cacheCreationInputTokens).toBe(29000);
      expect(metrics.cacheReadInputTokens).toBe(21292);
    });

    it('waits for the continuation to finish before emitting usage and closing the socket', async () => {
      orchestrationChunks = [{ final_result: { choices: [{ delta: { content: 'Hi' } }] } }];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      const order: string[] = [];
      (res as any).__responsesWebSearchIdle = () => new Promise<void>((resolve) => {
        setTimeout(() => { order.push('continuation-finished'); resolve(); }, 20);
      });
      const realEnd = res.end;
      res.end = () => { order.push('res.end'); return realEnd(); };
      usageEvents.length = 0;

      await handleResponses(req, res, () => {});

      expect(usageEvents).toHaveLength(1);
      expect(order).toEqual(['continuation-finished', 'res.end']);
    });

    it('never hands the plugin chain a raw orchestration chunk', async () => {
      // sapAIService's 5th argument makes it run executeStreamPlugins on the raw buffer
      // and executeAfterPlugins on EVERY PARSED CHUNK. Every plugin the real
      // `responses-stream` config lists registers an `after` handler written against a
      // Responses RESPONSE OBJECT, and this route has never had after-plugins at all —
      // the native forwardStream deliberately runs none. Plugins do see this stream, via
      // the res.write chain the before-plugins patched, already translated.
      hookConfigForRoute = [{ request: { callback: { id: 'pseudonymizationPlugin' }, match: [] } }];
      orchestrationChunks = [{ final_result: { choices: [{ delta: { content: 'Hi' } }] } }];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      await handleResponses(req, mockRes(), () => {});

      expect(orchestrationCalls[0].kind).toBe('streaming');
      expect(orchestrationCalls[0].hookConfig).toBeUndefined();
    });

    it('aborts the continuation when the client disconnects mid-stream', async () => {
      // Without this a codex abort — which happens routinely — left the engine's
      // continuation loop opening further orchestration calls nobody would read.
      let aborted = false;
      orchestrationChunks = [{ final_result: { choices: [{ delta: { content: 'Hi' } }] } }];
      const req: any = Object.assign(new EventEmitter(), {
        body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {},
      });
      const res = mockRes();
      (res as any).__responsesWebSearchAbort = () => { aborted = true; };
      (res as any).__responsesWebSearchIdle = () => {
        // The client hangs up while the continuation is still outstanding.
        res.emit('close');
        return Promise.resolve();
      };
      await handleResponses(req, res, () => {});

      expect(aborted).toBe(true);
    });
  });

  it('still takes the native path for a deployed model — sapAIService is never called', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'Say OK' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(orchestrationCalls).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('http://mock-sap/deployments/abc/responses');
    expect(res.statusCode).toBe(200);
  });

  it('turns an UnsupportedInputItemError into a 400 whose body names the item type', async () => {
    const req: any = {
      body: { model: 'anthropic--claude-4.8-opus', input: [{ type: 'computer_call', id: 'x' }] },
      headers: {},
    };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(orchestrationCalls).toHaveLength(0);
    expect(posted).toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('computer_call');
  });

  // Review round 1, Important 1: SSE headers must not be committed before the upstream
  // call is known to actually be producing bytes — otherwise a call that fails before
  // its first chunk still reaches the outer catch with headers already sent, and the
  // JSON error body goes out mislabelled text/event-stream.
  it('does not commit SSE headers when the orchestration stream fails before its first chunk', async () => {
    streamRejection = new Error('deployment unreachable');

    const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'Say hi', stream: true }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(res.headers['Content-Type']).toBeUndefined();
    expect(res.writes).toHaveLength(0);
    // Falls through to the ordinary JSON error path, not a mid-stream frame.
    expect(res.statusCode).toBe(500);
    expect(res.body.error.message).toBe('deployment unreachable');
  });

  // Review round 1, Important 2: sapAIService throws a CustomError (`.status`/`.details`,
  // no `.response`) — the shared catch must read `.status` as a fallback so an orchestration
  // failure is reported with its real status, not flattened to 500.
  it('reports the real upstream status and body for a non-streaming orchestration failure', async () => {
    const err: any = new Error('SAP AI Core rejected the request');
    err.status = 429;
    err.details = { error: 'RateLimited', message: 'slow down' };
    nonStreamingRejection = err;

    const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'Say OK' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('RateLimited');
    expect(res.body.error.message).toBe('slow down');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(429);   // billed against the real status, not 500
  });

  // Review round 1, Important 3: the exact arithmetic this plan already got wrong TWICE
  // — and the numbers below are the third derivation, this time from a controlled probe
  // rather than a single capture.
  //
  // These constants used to be 16303 / 16292 / 11, asserting that /openai/v1/responses
  // counted prompt_tokens INCLUSIVE of both cache categories and that folding therefore
  // had to SUBTRACT them. Those numbers were really measured — but against a payload that
  // carried the system message TWICE, once cache-marked and once not. The four-arm probe
  // at test/fixtures/orchestration/bridge-cache-probe-result.md isolated that: arm A0
  // (the duplicated payload) reproduces the inclusive shape, 15903 = 15892 + 11, while
  // arm A2 (system message in the template only, which is what this bridge now sends)
  // reports prompt_tokens FLAT at 14 across the write and the read turn while the cache
  // field goes 0 -> 17692. EXCLUSIVE. So the fold ADDS, and the numbers below are A2's.
  //
  // The re-derivation was pre-declared before the fix was written; these constants
  // changing is the expected outcome of de-duplicating the payload, not a regression.
  it('folds orchestration usage EXCLUSIVELY on the Responses bridge, never subtracting the cached count — real measured numbers', async () => {
    // Arm A2, run 2 (the cache-READ turn): prompt_tokens 14, cached_tokens 17692.
    // completion_tokens 8 rather than the probe's 4 only so a fold that lost the
    // output count cannot coincide with anything else in this file.
    orchestrationResult = {
      final_result: {
        choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 14,
          completion_tokens: 8,
          total_tokens: 22,
          prompt_tokens_details: { cached_tokens: 17692, cache_creation_tokens: 0 },
        },
      },
    };
    const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(usageEvents).toHaveLength(1);
    const metrics = usageEvents[0][1];
    // 14, NOT max(0, 14 - 17692) = 0. Subtracting on this source does not merely
    // mis-split the categories, it erases the whole full-rate side of the turn —
    // which is why the fold flip had to ship in the same commit as the de-dup.
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.cacheReadInputTokens).toBe(17692);
    expect(metrics.cacheCreationInputTokens).toBe(0);
    expect(metrics.outputTokens).toBe(8);
  });

  it('folds orchestration usage on a cache-WRITE turn — the write is a separate line item, not a deduction', async () => {
    // Arm A2, run 1 (the cache-WRITE turn): prompt_tokens 14, cache_creation_tokens
    // 17692, cached_tokens 0 (nothing to read yet). Admin's cost SQL prices
    // cache-creation separately from full-rate input (costRecalculationService.ts's
    // buildUpdateSQL) and ADDS the four categories, so the write belongs in its own
    // bucket beside an untouched inputTokens — 14 either way, exactly as on the read turn.
    orchestrationResult = {
      final_result: {
        choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 14,
          completion_tokens: 8,
          total_tokens: 22,
          prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 17692 },
        },
      },
    };
    const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.cacheReadInputTokens).toBe(0);
    expect(metrics.cacheCreationInputTokens).toBe(17692);
    expect(metrics.outputTokens).toBe(8);
  });

  // Anthropic models now default ON (owner's ruling — see promptCachingSupport.ts):
  // a model with no config flag at all still gets breakpoints, because the measured
  // safety asymmetry (gpt-5-mini via SAP orchestration: HTTP 200, cached_tokens 0,
  // silently ignored) makes a wrong `true` free and a wrong `false` a per-turn cost.
  // Only an explicit config `false` (the exception, e.g. claude-3-haiku) turns it off.
  describe('cache breakpoint wiring', () => {
    // `instructions` is what puts a system message in the payload at all, and hence
    // what makes the breakpoint reachable. Post-de-duplication that message lives in
    // prompt.template and nowhere else, so that is where these assertions look.
    const bodyWithInstructions = { model: 'anthropic--claude-4.8-opus', instructions: 'You are helpful.', input: 'hi' };
    const templateOf = (payload: any) => payload.config.modules.prompt_templating.prompt.template;

    it('adds a cache_control breakpoint by default when the model has not declared supports_prompt_caching (Anthropic default)', async () => {
      cacheFlag = undefined;
      const req: any = { body: bodyWithInstructions, headers: {} };
      await handleResponses(req, mockRes(), () => {});

      const sys = templateOf(orchestrationCalls[0].payload)[0];
      expect(sys.role).toBe('system');
      expect(sys.content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('adds a cache_control breakpoint on the TEMPLATE system message when the model declares supports_prompt_caching', async () => {
      cacheFlag = true;
      const req: any = { body: bodyWithInstructions, headers: {} };
      await handleResponses(req, mockRes(), () => {});

      const sys = templateOf(orchestrationCalls[0].payload)[0];
      expect(sys.role).toBe('system');
      expect(sys.content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('adds no cache_control when the model explicitly declares supports_prompt_caching: false — the config-exception path', async () => {
      cacheFlag = false;
      const req: any = { body: bodyWithInstructions, headers: {} };
      await handleResponses(req, mockRes(), () => {});

      expect(JSON.stringify(orchestrationCalls[0].payload)).not.toContain('cache_control');
    });

    it('sends the system block ONCE, marked, end to end — one copy on the wire', async () => {
      // The whole point of the de-duplication, asserted at the wiring level rather
      // than per-module: what the transport actually receives. Two copies (one marked,
      // one not) is arm A0 of the probe and the source of the inclusive-looking usage;
      // two copies both marked is arm A1, which pays to cache the text twice.
      cacheFlag = true;
      const req: any = { body: bodyWithInstructions, headers: {} };
      await handleResponses(req, mockRes(), () => {});

      const payload = orchestrationCalls[0].payload;
      expect(payload.messages_history.filter((m: any) => m.role === 'system')).toEqual([]);
      expect((JSON.stringify(payload).match(/You are helpful\./g) || [])).toHaveLength(1);
      expect((JSON.stringify(payload).match(/cache_control/g) || [])).toHaveLength(1);
      expect(templateOf(payload)).toHaveLength(1);
    });
  });

  describe('the continuation context stashed for the hosted-tool engine', () => {
    /** Drive one orchestration dispatch and hand back what it stashed on the request. */
    async function stashFor(body: any): Promise<any> {
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', ...body }, headers: {} };
      await handleResponses(req, mockRes(), () => {});
      return req.__responsesUpstream;
    }

    it('applies the engine\'s relaxed tool_choice to the continuation payload', async () => {
      const upstream = await stashFor({ tool_choice: 'required' });
      const next: any = upstream.buildContinuationPayload([], { toolChoice: 'auto' });
      expect(next.config.modules.prompt_templating.model.params.tool_choice).toBe('auto');
      // The first turn keeps what the client asked for; only continuations are relaxed.
      expect(orchestrationCalls[0].payload.config.modules.prompt_templating.model.params.tool_choice)
        .toBe('required');
    });

    it('omits tool_choice entirely when the engine relaxed it to nothing', async () => {
      const upstream = await stashFor({});
      const next: any = upstream.buildContinuationPayload([], { toolChoice: undefined });
      expect(next.config.modules.prompt_templating.model.params).not.toHaveProperty('tool_choice');
    });

    it('translates a continuation REPLY, on both transports', async () => {
      // Critical 1: the reply-side twins of the builder. Without them the engine handled
      // an orchestration envelope as if it were Responses-shaped.
      const upstream = await stashFor({});
      const translated = upstream.translateContinuationResponse({
        final_result: {
          choices: [{ message: { content: 'continued' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        },
      });
      expect(translated.object).toBe('response');
      expect(translated.output[0].content[0].text).toBe('continued');
      expect(translated.usage.input_tokens).toBe(7);

      const streamTranslator = upstream.createContinuationStreamTranslator();
      const blocks = streamTranslator.onBlock(
        'data: {"final_result":{"choices":[{"delta":{"content":"continued"}}]}}\n\n'
      );
      const types = blocks.map((b: string) => JSON.parse(b.replace(/^data: /, '').trim()).type);
      expect(types).toContain('response.output_text.delta');
    });

    it('keys the cache regime on the SAP-side model, not the catalogue id, for the first turn AND every continuation', async () => {
      // `claude-house-alias` resolves to gpt-4.1-nano, whose SAP usage is INCLUSIVE (probe of
      // 2026-09-30). Billing the first turn and translating a continuation must agree on that;
      // keying the translator on the id would read it as Claude (exclusive) and add the cache
      // back into input_tokens, which noteExtraUsage would then bill as full-rate input.
      const inclusiveUsage = {
        prompt_tokens: 1978, completion_tokens: 1, total_tokens: 1979,
        prompt_tokens_details: { audio_tokens: 0, cached_tokens: 1792 },
      };
      orchestrationResult = {
        final_result: { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: inclusiveUsage },
      };
      const req: any = { body: { model: 'claude-house-alias', input: 'hi' }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(orchestrationCalls[0].payload.config.modules.prompt_templating.model.name).toBe('gpt-4.1-nano');
      expect(usageEvents[0][1]).toMatchObject({ inputTokens: 186, cacheReadInputTokens: 1792 });
      expect(res.body.model).toBe('claude-house-alias');
      expect(res.body.usage.input_tokens).toBe(1978);

      const upstream = req.__responsesUpstream;
      const translated = upstream.translateContinuationResponse({
        final_result: { choices: [{ message: { content: 'continued' }, finish_reason: 'stop' }], usage: inclusiveUsage },
      });
      expect(translated.usage.input_tokens).toBe(1978);
      noteExtraUsage(req, translated.usage);
      expect(req.__responsesExtraUsage).toMatchObject({ input_tokens: 186, cache_read_tokens: 1792 });

      const streamTranslator = upstream.createContinuationStreamTranslator();
      const blocks: string[] = [
        ...streamTranslator.onBlock(`data: ${JSON.stringify({ final_result: {
          choices: [{ delta: { content: 'continued' }, finish_reason: 'stop' }], usage: inclusiveUsage,
        } })}\n\n`),
        ...streamTranslator.finish(),
      ];
      const completed = blocks
        .map((b: string) => JSON.parse(b.replace(/^event: .*\n/, '').replace(/^data: /, '').trim()))
        .find((f: any) => f.type === 'response.completed');
      expect(completed.response.usage.input_tokens).toBe(1978);
    });

    it('shares one prompt-caching verdict between the first turn and every continuation, not a fresh resolution each time', async () => {
      // `instructions` gives both the first turn and the continuation a system message to
      // mark, so a broken re-resolution can't hide behind "nothing to mark either way".
      cacheFlag = undefined;   // no config flag set: Anthropic default resolves to true
      const req: any = {
        body: { model: 'anthropic--claude-4.8-opus', instructions: 'You are helpful.', input: 'hi' },
        headers: {},
      };
      await handleResponses(req, mockRes(), () => {});
      const upstream = req.__responsesUpstream;

      // Exactly two calls for the WHOLE request — one for the model flag, one for the
      // provider flag — resolved once and shared. A regression that re-resolved per
      // applyCacheBreakpoints call site would double this once a continuation is built.
      const callsAfterFirstTurn = getSupportsPromptCaching.mock.calls.length;
      expect(callsAfterFirstTurn).toBe(2);

      const continuationPayload: any = upstream.buildContinuationPayload([], {});
      expect(getSupportsPromptCaching.mock.calls.length).toBe(callsAfterFirstTurn);

      // Both turns agree: the first turn's request and the continuation's both carry the
      // breakpoint from the same verdict, not a first-turn-caches/continuation-doesn't split.
      expect(JSON.stringify(orchestrationCalls[0].payload)).toContain('cache_control');
      expect(JSON.stringify(continuationPayload)).toContain('cache_control');
    });
  });

  // Review round 2, escalated finding: the sibling swap ran unconditionally on any
  // deployed --deployed twin, so anthropic--claude-4.8-opus — the model this whole
  // plan exists to serve — got swapped onto its deployed-but-chat-completions-only
  // sibling and refused, instead of staying on the bare, undeployed entry that
  // routes to orchestration. The swap must only adopt a sibling that can actually
  // serve the Responses API natively.
  describe('sibling-swap gate', () => {
    it('leaves a bare orchestration model on the bridge, with the BARE model name in the payload, when its --deployed sibling cannot serve the Responses API', async () => {
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'Say OK' }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(orchestrationCalls).toHaveLength(1);
      expect(orchestrationCalls[0].kind).toBe('non-streaming');
      expect(posted).toHaveLength(0);
      expect(res.statusCode).toBe(200);
      // The --deployed suffix is the gateway's own decoration; orchestration does
      // not know it and must never see it.
      expect(orchestrationCalls[0].payload.config.modules.prompt_templating.model.name).toBe('anthropic--claude-4.8-opus');
    });

    it('still swaps a bare name for a --deployed sibling that CAN serve the Responses API, and routes native — the codex case must not regress', async () => {
      const req: any = { body: { model: 'gpt-5.3-codex', input: 'Say OK' }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(orchestrationCalls).toHaveLength(0);
      expect(posted).toHaveLength(1);
      expect(posted[0].url).toBe('http://mock-sap/deployments/abc/responses');
      expect(posted[0].body.model).toBe('gpt-5.3-codex');   // alias replaced, unchanged from before this round
      expect(res.statusCode).toBe(200);
    });

    it('still refuses an explicitly requested --deployed name that cannot serve the Responses API (scope boundary: the swap is conditional, explicit requests are not)', async () => {
      const req: any = { body: { model: 'anthropic--claude-4.8-opus--deployed', input: 'Say OK' }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(orchestrationCalls).toHaveLength(0);
      expect(posted).toHaveLength(0);
      expect(res.statusCode).toBe(400);
    });
  });

  /**
   * A turn that dies mid-stream must be recorded as a failure. ApiKeyUsage.statusCode is
   * persisted (services/admin/src/db/schema/api-keys.cds:92) and six queries in
   * admin-service.ts derive errorCount from `statusCode >= 400`, so a failure written as
   * 200 is invisible in every error-rate figure. The HTTP status stays 200 because SSE
   * headers are flushed before the failure is known — only the RECORD changes.
   */
  describe('usage accounting for a failed stream', () => {
    const sapError = {
      error: {
        request_id: '479128d1-ac71-914a-9cd1-b70e52d0c58a',
        code: 400,
        message: "400 - LLM Module: openai does not support parameters: ['tool_choice'], for model=gpt-5.6-sol",
        location: 'LLM Module',
      },
    };

    it('records the upstream status, not 200, when the stream fails', async () => {
      orchestrationChunks = [sapError];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0][3]).toBe(400);
    });

    it('records 502 when the upstream failure carries no numeric code', async () => {
      orchestrationChunks = [{ error: { message: 'upstream exploded' } }];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(usageEvents[0][3]).toBe(502);
    });

    it('still records 200 for a stream that completes normally', async () => {
      orchestrationChunks = [
        { choices: [{ delta: { content: 'Hi ' } }] },
        { choices: [{ delta: { content: 'there' } }] },
      ];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(usageEvents[0][3]).toBe(200);
    });

    it('keeps the tokens consumed before the failure — a failed turn is still billed', async () => {
      orchestrationChunks = [
        { choices: [{ delta: { content: 'partial' } }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } },
        sapError,
      ];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(usageEvents[0][3]).toBe(400);
      const metrics = usageEvents[0][1];
      expect(metrics.inputTokens).toBe(11);
      expect(metrics.outputTokens).toBe(4);
    });

    // SAP answers HTTP 200 and sends its rejection as the first chunk after templating:
    // nothing was streamed yet, so the client gets the status and the error envelope, the
    // way the Responses API rejects a request it never started — not response.created,
    // response.in_progress and response.failed inside a 200 stream.
    it('a failure before any content is the HTTP status and the OpenAI error envelope, no frames', async () => {
      orchestrationChunks = [
        { intermediate_results: { templating: [] }, final_result: { choices: [{ index: 0, delta: { content: '' } }] } },
        sapError,
      ];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(res.writes).toEqual([]);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatchObject({
        message: "400 - LLM Module: openai does not support parameters: ['tool_choice'], for model=gpt-5.6-sol",
        type: 'invalid_request_error',
        code: 400,
      });
      expect(usageEvents[0][3]).toBe(400);
    });

    it('a slow first chunk: response.created + response.in_progress at the start deadline, then the turn', async () => {
      jest.useFakeTimers();
      try {
        let release!: () => void;
        streamGate = new Promise<void>((resolve) => { release = resolve; });
        orchestrationChunks = [{ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }];
        const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
        const res = mockRes();
        const done = handleResponses(req, res, () => {});
        for (let i = 0; i < 50; i++) await Promise.resolve();

        jest.advanceTimersByTime(9_999);
        expect(res.writes).toEqual([]);
        jest.advanceTimersByTime(1);
        const early = res.writes.map((w: string) => JSON.parse(w.replace(/^data: /, '').trim()).type);
        expect(early).toEqual(['response.created', 'response.in_progress']);

        release();
        await done;
        const types = res.writes.map((w: string) => JSON.parse(w.replace(/^data: /, '').trim()).type);
        expect(types.filter((t: string) => t === 'response.created')).toHaveLength(1);
        expect(types[types.length - 1]).toBe('response.completed');
        expect(types).toContain('response.output_text.delta');
      } finally {
        streamGate = null;
        jest.useRealTimers();
      }
    });

    it('a failure after content still writes response.failed, and no response.completed', async () => {
      orchestrationChunks = [{ choices: [{ delta: { content: 'partial' } }] }, sapError];
      const req: any = { body: { model: 'anthropic--claude-4.8-opus', input: 'hi', stream: true }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(res.statusCode).toBe(200);
      const frames = res.writes.map((w: string) => JSON.parse(w.replace(/^data: /, '').trim()));
      expect(frames.filter((f: any) => f.type === 'response.failed')).toHaveLength(1);
      expect(frames.filter((f: any) => f.type === 'response.completed')).toHaveLength(0);
    });
  });
});
