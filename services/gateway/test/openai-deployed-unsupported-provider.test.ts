/**
 * openaiController: a `--deployed` chat model whose provider is neither OpenAI nor
 * Perplexity is refused with a 400 before the deployment is called (the raw OpenAI body
 * used to be posted to the bare deployment URL first).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

let mockProvider = 'anthropic';
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve({
      id: m, owned_by: mockProvider, provider: mockProvider,
      deploymentUrl: 'https://deployed.example.com/v1', model: 'upstream-model',
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

const mockAxiosPostSpy = jest.fn();
let mockAxiosPost: (url: string, body: any, cfg: any) => Promise<any> = () => { return Promise.reject(new Error('axios.post must not be called')); };
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any, cfg: any) => { mockAxiosPostSpy(url); return mockAxiosPost(url, body, cfg); },
  },
}));

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

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), { statusCode: 200, body: undefined, headers: {}, writableEnded: false, headersSent: false });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.set = () => r;
  r.setHeader = () => {};
  return r;
}

function mockReq(body: any, extra: Record<string, any> = {}) {
  const r: any = new EventEmitter();
  r.body = body; r.headers = {}; r.query = {};
  Object.assign(r, extra);
  return r;
}

describe('openaiController: unsupported deployment provider', () => {
  beforeEach(() => { usageEvents.length = 0; mockAxiosPostSpy.mockClear(); });

  it.each(['anthropic', 'google'])('refuses a %s deployment with 400 model_not_supported and never calls it', async (provider) => {
    mockProvider = provider;
    const res = mockRes();
    const next = jest.fn();
    await handleChatCompletion(mockReq({ model: `${provider}--thing--deployed`, messages: [{ role: 'user', content: 'hi' }] }), res, next as any);
    expect(mockAxiosPostSpy).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(res.body.error.code).toBe('model_not_supported');
    expect(res.body.error.message).toContain(`${provider} deployment`);
    if (provider === 'anthropic') expect(res.body.error.message).toContain('/anthropic/v1/messages');
  });

  it.each(['unknown', ''])('names a provider-less deployment "non-OpenAI-compatible" (provider %p)', async (provider) => {
    mockProvider = provider;
    const res = mockRes();
    await handleChatCompletion(mockReq({ model: 'mystery--deployed', messages: [{ role: 'user', content: 'hi' }] }), res, jest.fn() as any);
    expect(mockAxiosPostSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('is a non-OpenAI-compatible deployment');
    expect(res.body.error.message).not.toContain('a unknown');
  });

  it('applies on the OpenRouter route too', async () => {
    mockProvider = 'anthropic';
    const res = mockRes();
    await handleChatCompletion(
      mockReq({ model: 'anthropic--thing--deployed', messages: [{ role: 'user', content: 'hi' }] }, { isOpenRouterRequest: true }),
      res, jest.fn() as any);
    expect(mockAxiosPostSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('model_not_supported');
  });

  it('still calls an OpenAI-compatible deployment', async () => {
    mockProvider = 'openai';
    mockAxiosPost = () => Promise.resolve({ status: 200, data: { id: 'x', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
    const res = mockRes();
    await handleChatCompletion(mockReq({ model: 'gpt-4o--deployed', messages: [{ role: 'user', content: 'hi' }] }), res, jest.fn() as any);
    expect(mockAxiosPostSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
