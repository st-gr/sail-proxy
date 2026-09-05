/**
 * openaiController: the `--deployed` model branch's image-token wiring (Task 9 review fix).
 *
 * `handleChatCompletion`'s "--deployed" branch (a SAP-hosted vision-capable deployment,
 * e.g. gpt-4o--deployed, called directly via axios rather than through SAP orchestration)
 * bypasses `transformRequestToSAPFormat` entirely — and until this fix, the
 * `collectChatImageRefs` call that feeds `imageTokenCapture.ts` lived only in the
 * non-deployed section reached AFTER this branch's early `return`. A deployed vision
 * model with an `image_url` in the request therefore never collected refs and
 * permanently billed `imageInputTokens: 0`.
 *
 * This suite proves, end to end and without mocking `imageTokenCapture.ts` itself:
 *  1. an `image_url` data-URL in the request IS reflected in the emitted usage event's
 *     `imageInputTokens` (the wiring bug is fixed), and
 *  2. the client response (`res.json`) is served BEFORE that computation completes —
 *     the hot-path guarantee still holds on this branch.
 *
 * Reuses the mocking pattern from openai-usage-folding.test.ts's own deployed-model
 * test, extended so the mocked `updateTokenCounts` also accumulates the 6th
 * (imageInputTokens) argument imageTokenCapture.ts's real, unmocked implementation calls.
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
    getModelDetails: (m: string) => Promise.resolve({
      id: m, owned_by: 'openai', provider: 'openai',
      deploymentUrl: 'https://deployed.example.com/v1', model: 'gpt-4o',
    }),
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

let mockAxiosPost: (url: string, body: any, cfg: any) => Promise<any> = () =>
  Promise.reject(new Error('axios.post not stubbed for this test'));
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any, cfg: any) => mockAxiosPost(url, body, cfg),
  },
}));

// `imageTokenCapture.ts` is NOT mocked -- this suite exercises its real setImmediate
// scheduling and real sniffImageDimensions/imageTokensFromDimensions math. Only its
// dependency, updateTokenCounts, is mocked (as a plain accumulator that now also
// handles the 6th, imageInputTokens, argument), same style as openai-usage-folding.test.ts.
const usageEvents: any[] = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({
    startTime: Date.now(), inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0,
  }),
  emitUsageEvent: (...args: any[]) => { usageEvents.push([args[0], { ...args[1] }, args[2], args[3]]); },
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

// Same 2x3 PNG fixture as image-dimensions.test.ts / image-token-capture.test.ts:
// signature + IHDR chunk, header bytes only.
const PNG_2x3_HEX = '89504e470d0a1a0a0000000d49484452000000020000000308';
const PNG_2x3_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_2x3_HEX, 'hex').toString('base64')}`;

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
  r.write = (s: string) => { r.writes.push(s); return true; };
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

describe('openaiController: --deployed branch image-token wiring', () => {
  beforeEach(() => {
    usageEvents.length = 0;
    process.env.IMAGE_TOKEN_OVERHEAD = '10';
    mockAxiosPost = () => Promise.resolve({
      status: 200,
      data: {
        id: 'chatcmpl-1', object: 'chat.completion', created: 1786000000, model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'It is a small image.' }, finish_reason: 'stop' }],
        usage: { completion_tokens: 4, prompt_tokens: 14, total_tokens: 18 },
      },
    });
  });

  it('collects the image_url ref, computes its tokens off the hot path, and folds them into the emitted usage event', async () => {
    const req = mockReq({
      model: 'gpt-4o--deployed',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: PNG_2x3_DATA_URL } },
        ],
      }],
    });
    const res = mockRes();

    await handleChatCompletion(req, res, () => {});

    // Hot-path guarantee: the client response is already served, but the deferred
    // image-token compute has not run yet -- so the usage event has not been emitted.
    expect(res.body).toBeDefined();
    expect(usageEvents).toHaveLength(0);

    await flushUntil(() => usageEvents.length > 0);

    expect(usageEvents).toHaveLength(1);
    const metrics = usageEvents[0][1];
    expect(metrics.imageInputTokens).toBe(imageTokensFromDimensions(2, 3, 10));
    // The rest of the fold is untouched by this fix.
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.outputTokens).toBe(4);
  });

  it('emits immediately, with imageInputTokens 0, when the deployed-model request carries no images', async () => {
    const req = mockReq({ model: 'gpt-4o--deployed', messages: [{ role: 'user', content: 'hi' }] });
    const res = mockRes();

    await handleChatCompletion(req, res, () => {});

    // No refs collected -> captureImageTokensAsync's onComplete fires synchronously,
    // so the emit is not deferred at all.
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][1].imageInputTokens).toBe(0);
  });
});
