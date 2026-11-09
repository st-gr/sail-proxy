/**
 * A foundation model the orchestration refuses ("Model name '<m>' is not supported", HTTP 400) while
 * a deployment of it runs: /openai/v1/chat/completions serves the request through the model's
 * `--deployed` twin instead of failing (found in the 0.11.0 rollout with gpt-6.1-sol), and later
 * requests for that name go to the twin directly. Without a running twin, SAP's 400 is passed on.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

// Running twins and their provider: none for gpt-6-luna; anthropic--claude-x's twin is an Anthropic
// deployment (not served by the deployed chat path); gpt-q, gpt-m and gpt-t have OpenAI twins.
const TWINS: Record<string, string> = {
  'gpt-6.1-sol--deployed': 'openai', 'gpt-6-astra--deployed': 'openai', 'anthropic--claude-x--deployed': 'anthropic',
  'gpt-q--deployed': 'openai', 'gpt-m--deployed': 'openai', 'gpt-t--deployed': 'openai',
};
const mockConfig: any = { api_config: {} };
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => {
      if (m.endsWith('--deployed')) {
        return TWINS[m]
          ? Promise.resolve({ id: m, owned_by: TWINS[m], provider: TWINS[m], deploymentUrl: 'https://deployed.example.com/v1', model: m.replace(/--deployed$/, '') })
          : Promise.reject(Object.assign(new Error(`Model ${m} not found`), { status: 404 }));
      }
      return Promise.resolve({ id: m, owned_by: 'openai', provider: 'openai' });
    },
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

jest.mock('../src/services/configService', () => {
  const svc = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: () => null,
    shouldEmulateStreaming: () => true,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getOpenAIDeploymentApiVersion: () => undefined,
  };
  return { __esModule: true, default: svc, ...svc };
});

jest.mock('../src/utils/modelUtils', () => ({
  mapModelParameters: (p: Record<string, any>) => ({ ...p }),
  getDefaultParameters: () => ({}),
}));

jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (_req: any, _res: any, body: any) => Promise.resolve(body),
}));

jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {} }));

const refusal = (model: string) => Object.assign(new Error('Request failed with status code 400'), {
  status: 400,
  details: { body: JSON.stringify({ error: { code: 400, message: `400 - Request Body: Model name '${model}' is not supported. Model name must be one of: gpt-5.` } }) },
});
const mockOrchestration = { complete: 0, stream: 0 };
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    completeChat: (payload: any) => {
      mockOrchestration.complete += 1;
      return Promise.reject(refusal(payload.config.modules.prompt_templating.model.name));
    },
    streamChatCompletion: (payload: any) => {
      mockOrchestration.stream += 1;
      return Promise.reject(refusal(payload.config.modules.prompt_templating.model.name));
    },
  },
}));

const deploymentCalls: string[] = [];
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string) => {
      deploymentCalls.push(url);
      return Promise.resolve({
        status: 200,
        data: {
          id: 'chatcmpl-d', object: 'chat.completion', model: 'gpt-6.1-sol', created: 1,
          choices: [{ index: 0, message: { role: 'assistant', content: 'from the deployment' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        },
      });
    },
  },
}));

jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0 }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { handleChatCompletion } from '../src/controllers/openaiController';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[],
    writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => { r.writes.push(s); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = { 'content-type': 'application/json' };
  r.query = {};
  return r;
}

async function chat(model: string, stream = false, setup?: (req: any) => void) {
  const req = mockReq({ model, messages: [{ role: 'user', content: 'hi' }], stream });
  if (setup) setup(req);
  const res = mockRes();
  const next = jest.fn();
  await handleChatCompletion(req, res, next);
  for (let i = 0; i < 200 && !res.writableEnded && next.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { res, next };
}

describe('openaiController: a model the orchestration refuses is served by its --deployed twin', () => {
  it('non-streaming: the deployment answers instead of the 400', async () => {
    const { res, next } = await chat('gpt-6.1-sol');
    expect(next).not.toHaveBeenCalled();
    expect(res.body?.choices?.[0]?.message?.content).toBe('from the deployment');
    expect(deploymentCalls.at(-1)).toMatch(/^https:\/\/deployed\.example\.com\/v1\/chat\/completions/);
  });

  it('a later request for that name goes to the deployment directly', async () => {
    const before = mockOrchestration.complete;
    const { res } = await chat('gpt-6.1-sol');
    expect(res.body?.choices?.[0]?.message?.content).toBe('from the deployment');
    expect(mockOrchestration.complete).toBe(before);
  });

  it('streaming: the deployment\'s answer is streamed to the client', async () => {
    const { res, next } = await chat('gpt-6-astra', true);
    expect(next).not.toHaveBeenCalled();
    const frames = res.writes.join('').split('\n\n').filter((b: string) => b.startsWith('data: ')).map((b: string) => b.slice(6));
    const content = frames.filter((f: string) => f !== '[DONE]').map((f: string) => JSON.parse(f).choices?.[0]?.delta?.content ?? '').join('');
    expect(content).toBe('from the deployment');
    expect(frames.at(-1)).toBe('[DONE]');
  });

  it('without a running deployment, SAP\'s 400 is passed on', async () => {
    const { res, next } = await chat('gpt-6-luna');
    expect(res.body).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0] as any[])[0].status).toBe(400);
  });

  it('a twin the deployed chat path does not serve (an Anthropic deployment) is not used: SAP\'s 400 is passed on', async () => {
    // Live 2026-11-08: anthropic--claude-4-opus was re-routed to its Anthropic twin and answered
    // "designed for embeddings" instead of SAP's refusal.
    const { next } = await chat('anthropic--claude-x');
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0] as any[])[0].status).toBe(400);
  });

  it('a twin outside the caller\'s entitlement is not used: SAP\'s 400, not a 403 for a model the client never named', async () => {
    const { res, next } = await chat('gpt-q', false, (req) => { req.apiKeyInfo = { entitlement: { mode: 'list', catalogId: 'c', catalogName: 'C', include: ['gpt-q'] } }; });
    expect(res.statusCode).not.toBe(403);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0] as any[])[0].status).toBe(400);
  });

  it('a plain model with its own masking or hook settings is not silently served with the twin\'s', async () => {
    // (A forced pseudonymization override would stop this mock-plugin request fail-closed before
    // the orchestration; a hook override of the plain name takes the same rule.)
    mockConfig.api_config = { models: { overrides: { 'gpt-m': { hooks: { invoke: { note: 'own chain for the plain name' } } } } } };
    try {
      const { next } = await chat('gpt-m');
      expect(next).toHaveBeenCalledTimes(1);
      expect((next.mock.calls[0] as any[])[0].status).toBe(400);
    } finally {
      mockConfig.api_config = {};
    }
  });

  it('a remembered refusal expires after an hour: the orchestration is asked again', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now);
      await chat('gpt-t');
      const asked = mockOrchestration.complete;
      clock.mockReturnValue(now + 61 * 60 * 1000);
      await chat('gpt-t');
      expect(mockOrchestration.complete).toBe(asked + 1);
    } finally {
      clock.mockRestore();
    }
  });
});
