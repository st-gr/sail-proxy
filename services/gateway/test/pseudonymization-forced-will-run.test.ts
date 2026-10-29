/**
 * "Forced" means the pseudonymization plugin actually runs. When the configuration forces masking
 * for a request (hooks.defaults.<endpoint>.pseudonymization or the model's own
 * models.overrides.<model>.pseudonymization), deployed chat and /responses refuse with 503
 * `pseudonymization_hook_missing` unless the plugin chain the executor would run for this request
 * contains pseudonymizationPlugin: a hook resolves, it lists the plugin, its match fits the
 * request, and the plugin is registered. Not forced, a request without the plugin goes on unmasked.
 *
 * Also: on a forced route the caller's own `masking` config may only widen the forced entity set.
 *
 * The controllers, plugin executor, plugin loader and pseudonymization plugin are the REAL
 * modules with the shipped hooks; configService, modelService and axios are mocked.
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }),
}));

const shippedHooks = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8'),
).api_config.hooks;

const mockConfig: any = { api_config: {} };
let mockConfigReadThrows = false;
jest.mock('../src/services/configService', () => {
  const svc: Record<string, any> = {
    getConfig: () => {
      if (mockConfigReadThrows) throw new Error('configuration unavailable');
      return mockConfig;
    },
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
    // The real lookup: the model's own hooks first, then hooks.defaults[endpoint]. It reads the
    // config object directly, so a test can make getConfig() throw and still resolve a hook.
    getHookConfig: (modelId: string, subpath: string, endpoint?: string) => {
      const override = mockConfig.api_config.models?.overrides?.[modelId]?.hooks?.[subpath];
      if (override) return override;
      return endpoint ? mockConfig.api_config.hooks?.defaults?.[endpoint]?.[subpath] || null : null;
    },
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getOpenAIDeploymentApiVersion: () => undefined,
    getSupportsResponsesApi: () => undefined,
    getTimeout: () => 1000,
  };
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    // Only the `--deployed` ids have a deployment: a bare `gpt-5` on /responses is served by its twin.
    getModelDetails: (m: string) => Promise.resolve(m.endsWith('--deployed')
      ? { id: m, owned_by: 'openai', provider: 'openai', deploymentUrl: 'https://deployed.example.com/v1', model: m.replace(/--deployed$/, '') }
      : { id: m, owned_by: 'openai', provider: 'openai' }),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

/** Deployment stub: records what it was sent and answers like the deployment would. */
const sent: any[] = [];
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any) => {
      sent.push(JSON.parse(JSON.stringify(body)));
      const data = url.endsWith('/responses')
        ? { id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-5', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
        : {
          id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4o', created: 1,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        };
      return Promise.resolve({ status: 200, data, headers: {} });
    },
  },
}));

jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {} }));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({
    startTime: Date.now(), inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0,
  }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { handleChatCompletion } from '../src/controllers/openaiController';
import { handleResponses } from '../src/controllers/responsesController';
import { executeBeforePlugins } from '../src/services/pluginExecutor';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');

const EMAIL = 'jane.roe@example.org';
const SITE = 'https://intranet.example.com/team';

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

function mockReq(body: any, url: string) {
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

const TEXT = `Please email ${EMAIL} about the invoice INV-4711.`;

interface Route { name: string; model: string; subPaths: string[]; run: () => Promise<any> }
const ROUTES: Route[] = [
  {
    name: 'deployed chat', model: 'gpt-4o--deployed', subPaths: ['invoke', 'invoke-with-response-stream'],
    run: async () => {
      const res = mockRes();
      await handleChatCompletion(mockReq({ model: 'gpt-4o--deployed', messages: [{ role: 'user', content: TEXT }] },
        '/openai/v1/chat/completions'), res, jest.fn() as any);
      return res;
    },
  },
  {
    name: '/responses', model: 'gpt-5--deployed', subPaths: ['responses', 'responses-stream'],
    run: async () => {
      const res = mockRes();
      await handleResponses(mockReq({ model: 'gpt-5--deployed', input: TEXT }, '/openai/v1/responses'), res, jest.fn() as any);
      return res;
    },
  },
];

function registerPlugin() {
  (global as any).pluginRegistry = {};
  (pseudonymizationRules as any[]).forEach((rule: any, i: number) => {
    (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule;
  });
}

/** The shipped hooks, with every endpoint's force flag set as asked. */
function shippedConfig(forced: boolean) {
  const hooks = JSON.parse(JSON.stringify(shippedHooks));
  for (const entry of Object.values(hooks.defaults) as any[]) {
    if (entry?.pseudonymization) entry.pseudonymization.enabled = forced;
  }
  return { hooks, models: { overrides: {} as Record<string, any> }, observability: {} };
}

const sentText = () => JSON.stringify(sent);

function expectHookMissing(res: any) {
  expect(res.statusCode).toBe(503);
  expect(res.body?.error?.type).toBe('api_error');
  expect(res.body?.error?.code).toBe('pseudonymization_hook_missing');
  expect(sent).toHaveLength(0);
}

beforeAll(registerPlugin);
beforeEach(() => {
  mockConfig.api_config = shippedConfig(true);
  mockConfigReadThrows = false;
  (global as any).matcherCache?.clear?.();
  sent.length = 0;
});

describe.each(ROUTES)('$name: forced pseudonymization requires the plugin to run', (route) => {
  it('forced by the route with the shipped hooks: masked and 200', async () => {
    const res = await route.run();
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sentText()).not.toContain(EMAIL);
    expect(sentText()).toMatch(/MASKED_EMAIL/);
  });

  it('a per-model hook override without the plugin: 503', async () => {
    const other = [{ request: { callback: { id: 'responsesImagePlugin' }, match: ['header:contentTypeJson'] } }];
    mockConfig.api_config.models.overrides[route.model] = { hooks: Object.fromEntries(route.subPaths.map((s) => [s, other])) };
    expectHookMissing(await route.run());
  });

  it('an empty hook list for the subpath: 503', async () => {
    for (const s of route.subPaths) mockConfig.api_config.hooks.defaults.openai[s] = [];
    expectHookMissing(await route.run());
  });

  it('a pseudonymization hook whose match does not fit the request: 503', async () => {
    const cliOnly = [{ request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:x-app=cli'] } }];
    for (const s of route.subPaths) mockConfig.api_config.hooks.defaults.openai[s] = cliOnly;
    expectHookMissing(await route.run());
  });

  it('forced only by the model, the route not forced and no hook: 503', async () => {
    mockConfig.api_config = shippedConfig(false);
    for (const s of route.subPaths) delete mockConfig.api_config.hooks.defaults.openai[s];
    mockConfig.api_config.models.overrides[route.model] = { pseudonymization: { enabled: true } };
    expectHookMissing(await route.run());
  });

  it('forced only by the model with the shipped hooks: masked and 200', async () => {
    mockConfig.api_config = shippedConfig(false);
    mockConfig.api_config.models.overrides[route.model] = { pseudonymization: { enabled: true } };
    const res = await route.run();
    expect(res.statusCode).toBe(200);
    expect(sentText()).not.toContain(EMAIL);
  });

  it('the plugin is not registered (the executor would skip it): 503', async () => {
    (global as any).pluginRegistry = {};
    try {
      expectHookMissing(await route.run());
    } finally {
      registerPlugin();
    }
  });

  it('the configuration cannot be read (the executor cannot match the hook): 503', async () => {
    mockConfigReadThrows = true;
    const res = await route.run();
    expect(res.statusCode).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('not forced and no plugin hook: 200, sent unmasked', async () => {
    mockConfig.api_config = shippedConfig(false);
    for (const s of route.subPaths) delete mockConfig.api_config.hooks.defaults.openai[s];
    const res = await route.run();
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sentText()).toContain(EMAIL);
  });
});

describe('a caller masking config cannot narrow forced masking', () => {
  const PSEUDO_HOOK = { request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:contentTypeJson'] } };
  const body = (masking: any) => ({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: `Please email ${EMAIL} and see ${SITE} for details.` }],
    masking,
  });
  const run = async (b: any) => {
    const req = mockReq(b, '/openai/v1/chat/completions');
    req.__endpoint = 'openai';
    const res = mockRes();
    const result = await executeBeforePlugins(req, res, [PSEUDO_HOOK]);
    return { req, res, result, text: JSON.stringify(req.body.messages) };
  };

  it('forced: a caller list naming only profile-url still masks the forced email', async () => {
    const { result, text } = await run(body({ method: 'pseudonymization', entities: [{ type: 'profile-url' }] }));
    expect(result.stop).toBe(false);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(SITE);
  });

  it('forced: a caller entry disabling profile-email does not unmask it', async () => {
    const { result, text } = await run(body({
      method: 'pseudonymization',
      entities: [{ type: 'profile-url' }, { type: 'profile-email', enabled: false }],
    }));
    expect(result.stop).toBe(false);
    expect(text).not.toContain(EMAIL);
  });

  it('forced: a caller allow list cannot exempt a forced value', async () => {
    const { text } = await run(body({ method: 'pseudonymization', entities: [{ type: 'profile-email' }], allow_list: [EMAIL] }));
    expect(text).not.toContain(EMAIL);
  });

  it('forced: a caller config that disables every entity is refused', async () => {
    const { res, result } = await run(body({ method: 'pseudonymization', entities: [{ type: 'profile-email', enabled: false }] }));
    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
  });

  it('forced: the operator-disabled categories stay off only if the caller does not ask for them', async () => {
    // The route disables profile-url; a caller may still widen masking to it.
    mockConfig.api_config.hooks.defaults.openai.pseudonymization.entities = { 'profile-url': false };
    const { text } = await run(body({ method: 'pseudonymization', entities: [{ type: 'profile-url' }] }));
    expect(text).not.toContain(SITE);
    expect(text).not.toContain(EMAIL);
  });

  it('not forced: the caller config is used as given (only profile-url masked)', async () => {
    mockConfig.api_config = shippedConfig(false);
    const { text } = await run(body({ method: 'pseudonymization', entities: [{ type: 'profile-url' }] }));
    expect(text).toContain(EMAIL);
    expect(text).not.toContain(SITE);
  });
});

describe('forced is read on the model that serves the request', () => {
  const runBareGpt5 = async () => {
    const res = mockRes();
    await handleResponses(mockReq({ model: 'gpt-5', input: TEXT }, '/openai/v1/responses'), res, jest.fn() as any);
    return res;
  };

  it('/responses: a bare model served by its forced --deployed twin is masked', async () => {
    mockConfig.api_config = shippedConfig(false);
    mockConfig.api_config.models.overrides['gpt-5--deployed'] = { pseudonymization: { enabled: true } };
    const res = await runBareGpt5();
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sentText()).not.toContain(EMAIL);
  });

  it('/responses: the same with no plugin hook is refused', async () => {
    mockConfig.api_config = shippedConfig(false);
    for (const s of ['responses', 'responses-stream']) delete mockConfig.api_config.hooks.defaults.openai[s];
    mockConfig.api_config.models.overrides['gpt-5--deployed'] = { pseudonymization: { enabled: true } };
    expectHookMissing(await runBareGpt5());
  });
});

describe('the executor refuses a forced request the pseudonymization plugin did not see', () => {
  const REWRITER = 'testHeaderRewriter';
  beforeEach(() => {
    registerPlugin();
    (global as any).pluginRegistry[`${REWRITER}_before_x`] = {
      id: REWRITER, strategy: 'before', match: [],
      // An admin-ordered plugin before masking that rewrites the field the masking hook matches on.
      handler: async ({ req }: any) => { req.headers['content-type'] = 'text/plain'; return { stop: false }; },
    };
  });

  it('deployed chat: an earlier plugin makes the masking hook miss: 503, nothing sent', async () => {
    const chain = [
      { request: { callback: { id: REWRITER }, match: ['header:contentTypeJson'] } },
      { request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:contentTypeJson'] } },
    ];
    mockConfig.api_config.models.overrides['gpt-4o--deployed'] = { hooks: { invoke: chain } };
    const res = await ROUTES[0].run();
    expect(res.statusCode).toBe(503);
    expect(res.body?.error?.code).toBe('pseudonymization_failed');
    expect(sent).toHaveLength(0);
  });

  it('deployed chat: the same chain with masking first is masked and sent', async () => {
    const chain = [
      { request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:contentTypeJson'] } },
      { request: { callback: { id: REWRITER }, match: ['header:contentTypeJson'] } },
    ];
    mockConfig.api_config.models.overrides['gpt-4o--deployed'] = { hooks: { invoke: chain } };
    const res = await ROUTES[0].run();
    expect(res.statusCode).toBe(200);
    expect(sentText()).not.toContain(EMAIL);
  });
});

describe('forced: the caller can add patterns and categories but not choose their placeholders', () => {
  const PSEUDO_HOOK = { request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:contentTypeJson'] } };
  const run = async (masking: any) => {
    const req = mockReq({ model: 'gpt-4o', messages: [{ role: 'user', content: `${TEXT} See ${SITE}.` }], masking }, '/openai/v1/chat/completions');
    req.__endpoint = 'openai';
    const res = mockRes();
    const result = await executeBeforePlugins(req, res, [PSEUDO_HOOK]);
    return { res, result, text: JSON.stringify(req.body.messages) };
  };

  it('only custom_entities, no entity list: the forced set plus the pattern', async () => {
    const { result, text } = await run({ custom_entities: [{ pattern: 'INV-\\d+', placeholder: 'X' }] });
    expect(result.stop).toBe(false);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('INV-4711');
  });

  it('an empty entity list: the forced set, not a refusal', async () => {
    const { result, text } = await run({ method: 'pseudonymization', entities: [] });
    expect(result.stop).toBe(false);
    expect(text).not.toContain(EMAIL);
  });

  it('caller placeholders and replacement settings are dropped', async () => {
    const { text } = await run({
      entities: [{ type: 'profile-url', replacement_strategy: 'constant', replacement_value: 'CALLER_URL_TAG' }],
      custom_entities: [{ pattern: 'INV-\\d+', placeholder: 'CALLER_INV_TAG' }],
    });
    expect(text).not.toContain('INV-4711');
    expect(text).not.toContain(SITE);
    expect(text).not.toContain('CALLER_INV_TAG');
    expect(text).not.toContain('CALLER_URL_TAG');
  });
});
