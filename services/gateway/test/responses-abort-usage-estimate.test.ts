/**
 * responsesController: the mid-stream-abort billing hole.
 *
 * Measured in test/fixtures/codex-custom-tools/RESPONSES-API-COMPLIANCE.md ("Mid-stream
 * abort against OUR gateway"): usage on this route lives only on the terminal
 * `response.completed` frame. When a client disconnects mid-stream, that frame never
 * arrives, `applyResponsesUsage` is never called, and the 499 usage event billed zero
 * tokens for a turn that really generated content (measured: 236 output_text.delta
 * frames, ~1,258 characters, billed as 0/0).
 *
 * `estimateAbortedUsage` (responsesController.ts) is the fallback: on the close/abort
 * path, when no real usage was folded, tokenize what was actually streamed (captured
 * SSE deltas) and the request's own input, using the same gpt-tokenizer-backed
 * tokenCountService already used in production by countTokensController. Mocking style
 * and mockRes()/mockReq() are lifted from responses-native-usage-fold.test.ts, itself
 * lifted from responses-controller.test.ts — same fakes, so this suite exercises the
 * real fold/estimate sites in responsesController.ts, not a reimplementation of them.
 * tokenCountService is intentionally NOT mocked (except for one spy in the failure
 * test): the point is to prove the real tokenizer produces non-zero counts.
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

let streamHandle: (EventEmitter & { destroy: () => void }) | null = null;
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
      return Promise.resolve({ status: 200, data: { id: 'resp_1', object: 'response', status: 'completed', output: [] } });
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

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportsResponsesApi: () => undefined,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getTimeout: () => 1000,
    getHookConfig: () => undefined,
    isPseudonymizationForced: () => false,
    getConfig: () => ({}),
  },
}));

jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (_req: any, _res: any, body: any) => Promise.resolve(body),
}));

const usageEvents: any[] = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  // Snapshot at call time, same as the protected suite's mock — metrics is a live
  // object the controller keeps mutating, so a live reference would mask ordering bugs.
  emitUsageEvent: (...args: any[]) => { usageEvents.push([args[0], { ...args[1] }, args[2], args[3]]); },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0;
    m.cacheReadInputTokens += cacheRead || 0;
  },
}));

import { handleResponses } from '../src/controllers/responsesController';
import tokenCountService from '../src/services/tokenCountService';

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

const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;

const REQUEST_INPUT = [{
  type: 'message', role: 'user',
  content: [{ type: 'input_text', text: 'Explain how photosynthesis works in plants, in as much detail as you can.' }],
}];

const STREAMED_CHUNKS = [
  'Photosynthesis is the process by which green plants, algae, and some bacteria ',
  'convert light energy, usually from the sun, into chemical energy stored in glucose. ',
  'It takes place mainly in the chloroplasts of plant cells, which contain the pigment ',
  'chlorophyll that absorbs sunlight, primarily in the blue and red wavelengths.',
];

describe('responsesController: local usage estimate on mid-stream abort', () => {
  beforeAll(async () => {
    await tokenCountService.waitForPreload();
  }, 30000);

  beforeEach(() => {
    usageEvents.length = 0;
    streamHandle = null;
  });

  it('derives non-zero input AND output tokens locally when the client disconnects after real content streamed', async () => {
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: REQUEST_INPUT, stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    for (const delta of STREAMED_CHUNKS) {
      streamHandle!.emit('data', Buffer.from(frame({
        type: 'response.output_text.delta', sequence_number: 1, output_index: 0, delta,
      })));
    }

    res.emit('close'); // client hangs up mid-stream — no response.completed frame ever arrives
    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    const [, metrics, model, statusCode] = usageEvents[0];
    expect(statusCode).toBe(499);
    expect(model).toBe('gpt-5.3-codex--deployed');
    expect(metrics.outputTokens).toBeGreaterThan(0);
    expect(metrics.inputTokens).toBeGreaterThan(0);
    // Marked as a local derivation, not a provider-reported figure.
    expect(metrics.usageEstimated).toBe(true);
  });

  it('derives non-zero output tokens from response.custom_tool_call_input.delta frames on abort', async () => {
    // codex's custom-tools mechanism (freeform tool input, not the standard
    // function_call_arguments.delta JSON-args channel) — measured as the MORE
    // frequent of the two delta types this repo has actually captured against
    // this endpoint (1018 + 381 occurrences vs. output_text.delta's 1569 + 109;
    // see test/fixtures/codex-custom-tools/{responses-api-compliance-capture.json,
    // gpt-5.6-sol-custom-tool-capture.json}). Omitting it undercounts exactly
    // the mechanism this whole set exists to catch.
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: REQUEST_INPUT, stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    const customToolChunks = [
      '{"command": ["bash", "-lc", "grep -rn ',
      'photosynthesis src/ --include=*.md ',
      '| head -n 50"]}',
    ];
    for (const delta of customToolChunks) {
      streamHandle!.emit('data', Buffer.from(frame({
        type: 'response.custom_tool_call_input.delta', sequence_number: 1, output_index: 0, delta,
      })));
    }

    res.emit('close'); // client hangs up mid-stream — no response.completed frame ever arrives
    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    const [, metrics, , statusCode] = usageEvents[0];
    expect(statusCode).toBe(499);
    expect(metrics.outputTokens).toBeGreaterThan(0);
    expect(metrics.usageEstimated).toBe(true);
  });

  it('leaves a normally-completed stream untouched — provider numbers win, no estimate marker', async () => {
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: REQUEST_INPUT, stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    for (const delta of STREAMED_CHUNKS) {
      streamHandle!.emit('data', Buffer.from(frame({
        type: 'response.output_text.delta', sequence_number: 1, output_index: 0, delta,
      })));
    }
    streamHandle!.emit('data', Buffer.from(frame({
      type: 'response.completed', sequence_number: 2,
      response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 19, output_tokens: 33 } },
    })));
    streamHandle!.emit('end');

    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    const [, metrics, , statusCode] = usageEvents[0];
    expect(statusCode).toBe(200);
    // The real provider figures, not a locally-tokenized estimate of the same text.
    expect(metrics.inputTokens).toBe(19);
    expect(metrics.outputTokens).toBe(33);
    expect(metrics.usageEstimated).toBeUndefined();
  });

  it('degrades to zero tokens without losing the usage event when tokenization throws', async () => {
    const spy = jest.spyOn(tokenCountService, 'getTokenCount').mockRejectedValueOnce(new Error('boom'));
    try {
      const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: REQUEST_INPUT, stream: true });
      const res = mockRes();

      const handlerPromise = handleResponses(req, res, () => {});
      await flushUntil(() => streamHandle !== null);

      streamHandle!.emit('data', Buffer.from(frame({
        type: 'response.output_text.delta', sequence_number: 1, output_index: 0, delta: STREAMED_CHUNKS[0],
      })));
      res.emit('close');
      await handlerPromise;

      expect(usageEvents).toHaveLength(1);
      const [, metrics, , statusCode] = usageEvents[0];
      expect(statusCode).toBe(499);
      expect(metrics.inputTokens).toBe(0);
      expect(metrics.outputTokens).toBe(0);
      expect(metrics.usageEstimated).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

});
