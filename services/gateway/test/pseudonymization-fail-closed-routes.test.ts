/**
 * Every route that runs the plugin chain turns a forced-masking failure into 503
 * `pseudonymization_failed` and never calls the upstream: orchestration chat, deployed chat,
 * OpenRouter chat, /responses and Anthropic messages.
 *
 * The plugin executor, plugin loader and pseudonymization plugin are the REAL modules with the
 * shipped hooks; the detector entry point is wrapped so it throws. configService, modelService
 * and every upstream seam (axios, sapAIService, anthropicService, awsBedrockService) are mocked,
 * and the upstream spies must stay untouched.
 */
import { describe, it, expect, jest, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

const logged: any[] = [];
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...a: any[]) => logged.push(a), warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
  }),
}));

const shippedHooks = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8'),
).api_config.hooks;

const mockConfig: any = { api_config: {} };
jest.mock('../src/services/configService', () => {
  const svc: Record<string, any> = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: (modelId: string, subpath: string, endpoint?: string) => {
      const override = mockConfig.api_config.models?.overrides?.[modelId]?.hooks?.[subpath];
      if (override) return override;
      return endpoint ? mockConfig.api_config.hooks?.defaults?.[endpoint]?.[subpath] || null : null;
    },
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getSupportsResponsesApi: () => undefined,
    getTimeout: () => 1000,
  };
  // Any other reader the controllers consult before the plugins answers "not configured".
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(
      m.startsWith('claude')
        ? { id: m, owned_by: 'anthropic', provider: 'anthropic' }
        : m.endsWith('--deployed')
          ? { id: m, owned_by: 'openai', provider: 'openai', deploymentUrl: 'https://deployed.example.com/v1', model: m.replace(/--deployed$/, '') }
          : { id: m, owned_by: 'openai', provider: 'openai' },
    ),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

const upstream = jest.fn((..._a: any[]) => Promise.reject(new Error('upstream must not be called')));
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => upstream('axios.post', ...a), get: (...a: any[]) => upstream('axios.get', ...a) },
}));
const serviceStub = () => new Proxy({}, { get: (_t, k: string) => (k === '__esModule' ? undefined : (...a: any[]) => upstream(k, ...a)) });
jest.mock('../src/services/sapAIService', () => ({ __esModule: true, default: serviceStub() }));
jest.mock('../src/services/anthropicService', () => ({ __esModule: true, default: serviceStub() }));
jest.mock('../src/services/awsBedrockService', () => ({ __esModule: true, default: serviceStub() }));

jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {} }));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({
    startTime: Date.now(), inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0,
  }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

let mockDetectorThrows = false;
jest.mock('../src/pluginSupport/pseudonymization/detectors', () => {
  const actual: any = jest.requireActual('../src/pluginSupport/pseudonymization/detectors');
  return {
    ...actual,
    detectEntities: (text: string, ...rest: any[]) => {
      if (mockDetectorThrows) throw new Error(`detector failed on: ${text}`);
      return actual.detectEntities(text, ...rest);
    },
  };
});

// wink-nlp wrapped so a test can fail its load (the NER detector then has no engine) or make
// detection throw at run time. nerDetector caches the engine after the first successful load,
// so the load-failure tests run FIRST in this file and assert that a load was attempted.
let mockWinkLoadFails = false;
let mockWinkLoadAttempts = 0;
let mockNerThrows = false;
jest.mock('wink-nlp', () => {
  const actual: any = jest.requireActual('wink-nlp');
  return (...args: any[]) => {
    mockWinkLoadAttempts++;
    if (mockWinkLoadFails) throw new Error('wink-nlp failed to load');
    const inst = actual(...args);
    return new Proxy(inst, {
      get: (t: any, k: string) => (k === 'readDoc' && mockNerThrows
        ? () => { throw new Error('ner failed'); }
        : t[k]),
    });
  };
});

import { handleChatCompletion } from '../src/controllers/openaiController';
import { handleGemini } from '../src/controllers/googleController';
import { executeBeforePlugins } from '../src/services/pluginExecutor';
import { handleChatCompletions as handleOpenRouterChat } from '../src/controllers/openRouterController';
import { handleResponses } from '../src/controllers/responsesController';
import { handleMessages } from '../src/controllers/anthropicController';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');

const EMAIL = 'jane.roe@example.org';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[],
    writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.getHeader = (k: string) => r.headers[k];
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => { r.writes.push(s); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

function mockReq(body: any, url = '/') {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = { 'content-type': 'application/json' };
  r.query = {};
  r.params = {};
  r.originalUrl = url;
  r.path = url;
  r.method = 'POST';
  return r;
}

const PERSON = 'Lena Marquardt';
const userMessage = [{ role: 'user', content: `Please ask ${PERSON} to email ${EMAIL} about the invoice.` }];

const ROUTES: Array<[string, () => Promise<any>]> = [
  ['orchestration chat', async () => {
    const res = mockRes();
    await handleChatCompletion(mockReq({ model: 'gpt-4o', messages: userMessage }, '/openai/v1/chat/completions'), res, jest.fn() as any);
    return res;
  }],
  ['deployed chat', async () => {
    const res = mockRes();
    await handleChatCompletion(mockReq({ model: 'gpt-4o--deployed', messages: userMessage }, '/openai/v1/chat/completions'), res, jest.fn() as any);
    return res;
  }],
  ['OpenRouter chat', async () => {
    const res = mockRes();
    await handleOpenRouterChat(mockReq({ model: 'openai/gpt-4o--deployed', messages: userMessage }, '/openrouter/api/v1/chat/completions'), res, jest.fn() as any);
    return res;
  }],
  ['/responses', async () => {
    const res = mockRes();
    await handleResponses(mockReq({ model: 'gpt-5--deployed', input: `Please ask ${PERSON} to email ${EMAIL} about the invoice.` }, '/openai/v1/responses'), res, jest.fn() as any);
    return res;
  }],
  ['Google generateContent (per-model hook)', async () => {
    // No hooks.defaults.google ships: the chain runs here only through a per-model hook.
    mockConfig.api_config.models.overrides['gpt-4o'] = {
      ...(mockConfig.api_config.models.overrides['gpt-4o'] || {}),
      hooks: { generateContent: [{ request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:contentTypeJson'] } }] },
    };
    const res = mockRes();
    const req = mockReq({ contents: [{ role: 'user', parts: [{ text: `Please ask ${PERSON} to email ${EMAIL} about the invoice.` }] }] },
      '/google/v1beta/models/gpt-4o:generateContent');
    req.params = { modelAndMethod: 'gpt-4o:generateContent' };
    await handleGemini(req, res, jest.fn() as any);
    return res;
  }],
  ['Anthropic messages', async () => {
    const res = mockRes();
    await handleMessages(mockReq({ model: 'claude-sonnet-4', max_tokens: 64, messages: userMessage }, '/anthropic/v1/messages'), res, jest.fn() as any);
    return res;
  }],
];

function registerPlugin() {
  (global as any).pluginRegistry = {};
  (pseudonymizationRules as any[]).forEach((rule: any, i: number) => {
    (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule;
  });
}

function shippedConfig(forced: boolean) {
  const hooks = JSON.parse(JSON.stringify(shippedHooks));
  for (const entry of Object.values(hooks.defaults) as any[]) {
    if (entry?.pseudonymization) entry.pseudonymization.enabled = forced;
  }
  return {
    hooks,
    // The Google route is forced per model (no hooks.defaults.google).
    models: { overrides: forced ? { 'gpt-4o': { pseudonymization: { enabled: true } } } : {} },
    observability: {},
  };
}

// FIRST: nerDetector caches the engine after its first successful load.
describe('forced: the NER model cannot be loaded', () => {
  beforeAll(registerPlugin);
  beforeEach(() => {
    mockConfig.api_config = shippedConfig(true);
    (global as any).matcherCache?.clear?.();
    mockDetectorThrows = false;
    mockWinkLoadFails = true;
    mockNerThrows = false;
    upstream.mockClear();
    logged.length = 0;
  });
  afterAll(() => { mockWinkLoadFails = false; });

  it.each(ROUTES)('%s: 503 pseudonymization_failed, upstream never called', async (_name, run) => {
    const attempts = mockWinkLoadAttempts;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await run();
      expect(mockWinkLoadAttempts).toBeGreaterThan(attempts);
      expect(res.statusCode).toBe(503);
      expect(res.body?.error?.code).toBe('pseudonymization_failed');
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('not forced: the request is masked without NER and goes on', async () => {
    mockConfig.api_config = shippedConfig(false);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const req = mockReq({
        model: 'gpt-4o', messages: JSON.parse(JSON.stringify(userMessage)),
        masking: { method: 'pseudonymization', entities: [{ type: 'profile-email' }, { type: 'profile-person' }] },
      });
      (req as any).__endpoint = 'openai';
      const res = mockRes();
      const attempts = mockWinkLoadAttempts;
      const result = await executeBeforePlugins(req, res, [{ request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:contentTypeJson'] } }]);
      expect(mockWinkLoadAttempts).toBeGreaterThan(attempts);
      expect(result.stop).toBe(false);
      expect(res.body).toBeUndefined();
      expect(JSON.stringify(req.body)).not.toContain(EMAIL);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('forced: NER detection throws', () => {
  beforeAll(registerPlugin);
  beforeEach(() => {
    mockConfig.api_config = shippedConfig(true);
    (global as any).matcherCache?.clear?.();
    mockDetectorThrows = false;
    mockWinkLoadFails = false;
    mockNerThrows = true;
    upstream.mockClear();
    logged.length = 0;
  });
  afterAll(() => { mockNerThrows = false; });

  it.each(ROUTES)('%s: 503 pseudonymization_failed, upstream never called', async (_name, run) => {
    const res = await run();
    expect(res.statusCode).toBe(503);
    expect(res.body?.error?.code).toBe('pseudonymization_failed');
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).not.toContain(PERSON);
  });
});

describe('a forced-masking failure is refused on every route that runs the plugin chain', () => {
  beforeAll(() => {
    (global as any).pluginRegistry = {};
    (pseudonymizationRules as any[]).forEach((rule: any, i: number) => {
      (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule;
    });
  });

  beforeEach(() => {
    mockConfig.api_config = shippedConfig(true);
    (global as any).matcherCache?.clear?.();
    mockDetectorThrows = true;
    upstream.mockClear();
    logged.length = 0;
  });

  it.each(ROUTES)('%s: 503 pseudonymization_failed, upstream never called', async (_name, run) => {
    const res = await run();

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: { message: expect.any(String), type: 'api_error', code: 'pseudonymization_failed' },
    });
    expect(JSON.stringify(res.body)).not.toContain(EMAIL);
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).not.toContain(EMAIL);
  });

  // The control: the same harness reaches the upstream when masking is not forced, so the
  // assertions above are about the refusal, not about a harness that never gets that far.
  it.each(ROUTES)('%s: not forced, the request reaches the upstream', async (_name, run) => {
    mockConfig.api_config = shippedConfig(false);
    const res = await run();

    expect(res.body?.error?.code).not.toBe('pseudonymization_failed');
    expect(upstream).toHaveBeenCalled();
  });
});

// Orchestration chat and Anthropic: a forced request whose hook chain resolves but has no
// pseudonymizationPlugin is refused by the controller's check (pseudonymization_hook_missing)
// before the chain runs, not sent upstream unmasked. (The executor's own backstop, for a chain
// that changes under the check, is covered in pseudonymization-forced-will-run.test.ts.)
describe('forced: the hook chain resolves but has no pseudonymization plugin', () => {
  const NOOP = 'testNoopPlugin';
  const UNMARKED_ROUTES = ROUTES.filter(([name]) => name === 'orchestration chat' || name === 'Anthropic messages');

  function withoutPseudonymization(forced: boolean) {
    const config = shippedConfig(forced);
    for (const entry of Object.values(config.hooks.defaults) as any[]) {
      for (const [key, chain] of Object.entries(entry)) {
        if (key === 'pseudonymization' || !Array.isArray(chain)) continue;
        entry[key] = (chain as any[]).map((h) => (h?.request?.callback?.id === 'pseudonymizationPlugin'
          ? { request: { ...h.request, callback: { id: NOOP } } }
          : h));
      }
    }
    return config;
  }

  beforeAll(() => {
    registerPlugin();
    (global as any).pluginRegistry[`${NOOP}_before_x`] = {
      id: NOOP, strategy: 'before', match: [], handler: async () => ({ stop: false }),
    };
  });
  beforeEach(() => {
    (global as any).matcherCache?.clear?.();
    mockDetectorThrows = false;
    mockWinkLoadFails = false;
    mockNerThrows = false;
    upstream.mockClear();
    logged.length = 0;
  });

  it.each(UNMARKED_ROUTES)('%s: 503 pseudonymization_hook_missing, upstream never called', async (_name, run) => {
    mockConfig.api_config = withoutPseudonymization(true);
    const res = await run();
    expect(res.statusCode).toBe(503);
    expect(res.body?.error?.code).toBe('pseudonymization_hook_missing');
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(UNMARKED_ROUTES)('%s: not forced, the request reaches the upstream', async (_name, run) => {
    mockConfig.api_config = withoutPseudonymization(false);
    const res = await run();
    expect(res.body?.error?.code).not.toBe('pseudonymization_failed');
    expect(upstream).toHaveBeenCalled();
  });
});
