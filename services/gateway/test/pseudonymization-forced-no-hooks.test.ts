/**
 * A request masking is forced for never reaches the upstream unmasked because no hook chain would
 * run the pseudonymization plugin for it: every route that runs the plugin chain refuses it with
 * 503 `pseudonymization_hook_missing` (gateway error format) before any upstream call.
 * Orchestration chat, OpenRouter chat, deployed chat, /responses, Anthropic messages (orchestration
 * and deployed), Gemini generateContent / streamGenerateContent, and Bedrock (deployed, and served
 * through the /anthropic flow, where the aws-bedrock force flag still applies).
 *
 * The plugin executor, plugin loader and pseudonymization plugin are the REAL modules;
 * configService, modelService and every upstream seam (axios, sapAIService, anthropicService,
 * awsBedrockService) are mocked. Gemini embedContent: pseudonymization-gemini-embed-exempt.test.ts.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }),
}));

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
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(require('./forcedRouteHarness').catalogueDetails(m)),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

const upstream: jest.Mock<any> = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => upstream('axios.post', ...a), get: (...a: any[]) => upstream('axios.get', ...a) },
}));
const serviceStub = () => new Proxy({}, { get: (_t, k: string) => (k === '__esModule' ? undefined : (...a: any[]) => upstream(k, ...a)) });
jest.mock('../src/services/sapAIService', () => ({ __esModule: true, default: serviceStub() }));
jest.mock('../src/services/anthropicService', () => ({ __esModule: true, default: serviceStub() }));
jest.mock('../src/services/awsBedrockService', () => ({ __esModule: true, default: serviceStub() }));

jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {}, isPayloadLoggingEnabled: () => false }));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({
    startTime: Date.now(), inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0,
  }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { EMAIL, ENDPOINTS, PSEUDONYMIZATION_HOOK, ROUTES, configFor, registerPlugins, route, shippedHooks } from './forcedRouteHarness';

const REWRITER = 'testHeaderRewriter';
const NOOP = 'testNoopPlugin';
const rewriterHook = { request: { callback: { id: REWRITER }, match: ['header:contentTypeJson'] } };
const noopHook = { request: { callback: { id: NOOP }, match: ['header:contentTypeJson'] } };
const cases = ROUTES.map((r) => [r.name, r] as const);

const upstreamArgs = () => JSON.stringify(upstream.mock.calls);
/** What each upstream call sends: the request body handed to awsBedrockService, else the call's payload. */
const upstreamPayloads = () => JSON.stringify(upstream.mock.calls.map((c: any[]) => c[1]?.requestBody ?? c[1]));
const shipped = () => ({ hooks: JSON.parse(JSON.stringify(shippedHooks)), models: { overrides: {} }, observability: {} });

function expectRefused(res: any, code = 'pseudonymization_hook_missing') {
  expect(res.statusCode).toBe(503);
  expect(res.body).toEqual({ error: { message: expect.any(String), type: 'api_error', code } });
  expect(upstream).not.toHaveBeenCalled();
}

beforeEach(() => {
  registerPlugins({
    [NOOP]: async () => ({ stop: false }),
    // An admin-ordered plugin before masking that rewrites the field the masking hook matches on.
    [REWRITER]: async ({ req }: any) => { req.headers['content-type'] = 'text/plain'; return { stop: false }; },
  });
  (global as any).matcherCache?.clear?.();
  upstream.mockReset();
  upstream.mockImplementation(() => Promise.reject(new Error('upstream not reachable in this test')));
});

describe('forced pseudonymization with no hook chain configured', () => {
  it.each(cases)('%s, every endpoint forced: 503 pseudonymization_hook_missing, upstream never called', async (_n, r) => {
    mockConfig.api_config = configFor(ENDPOINTS);
    expectRefused(await r.run());
  });

  it.each(cases)('%s, only its own endpoint forced: 503 pseudonymization_hook_missing', async (_n, r) => {
    mockConfig.api_config = configFor([r.endpoint]);
    expectRefused(await r.run());
  });

  // The control: the same harness reaches the upstream when masking is not forced.
  it.each(cases)('%s, not forced: the request reaches the upstream unchanged', async (_n, r) => {
    mockConfig.api_config = configFor([]);
    const res = await r.run();
    expect(res.body?.error?.code).not.toBe('pseudonymization_hook_missing');
    expect(upstream).toHaveBeenCalled();
    expect(upstreamArgs()).toContain(EMAIL);
  });
});

// A configuration stored before the converse chains shipped: Bedrock converse on a deployment
// has no chain that runs the plugin and is refused, never sent unmasked.
it('Bedrock converse on a deployment, forced, with invoke chains only: refused', async () => {
  const config = shipped();
  delete config.hooks.defaults['aws-bedrock'].converse;
  delete config.hooks.defaults['aws-bedrock']['converse-stream'];
  mockConfig.api_config = config;
  expect(mockConfig.api_config.hooks.defaults['aws-bedrock'].pseudonymization.enabled).toBe(true);
  expectRefused(await route('Bedrock converse, deployed').run());
});

// The shipped hooks run the plugin on these routes: forced masking reaches the upstream masked,
// the deployed Anthropic branch included (its before-chain runs ahead of the deployment branch).
describe('forced, with the shipped hooks: the upstream receives the masked request', () => {
  it.each(['orchestration chat', 'Anthropic messages', 'Anthropic messages, deployed', 'Bedrock invoke, deployed', 'Bedrock converse, deployed'])('%s', async (name) => {
    mockConfig.api_config = shipped();
    const res = await route(name).run();
    expect(res.body?.error?.code).not.toBe('pseudonymization_hook_missing');
    expect(upstream).toHaveBeenCalled();
    expect(upstreamPayloads()).toContain('MASKED_EMAIL_');
    expect(upstreamPayloads()).not.toContain(EMAIL);
  });
});

// A Bedrock model without a deployment is served by the /anthropic flow, under the anthropic
// hooks; forcing aws-bedrock alone must still force it.
describe('Bedrock through orchestration, only aws-bedrock forced', () => {
  const ROUTE_NAMES = ['Bedrock converse, through orchestration', 'Bedrock invoke, through orchestration'];

  it.each(ROUTE_NAMES)('%s, anthropic chain without the plugin: 503 pseudonymization_hook_missing', async (name) => {
    mockConfig.api_config = configFor(['aws-bedrock'], { anthropic: { invoke: [noopHook] } });
    expectRefused(await route(name).run());
  });

  it.each(ROUTE_NAMES)('%s, anthropic chain with the plugin: masked before the upstream', async (name) => {
    mockConfig.api_config = configFor(['aws-bedrock'], { anthropic: { invoke: [PSEUDONYMIZATION_HOOK] } });
    await route(name).run();
    expect(upstream).toHaveBeenCalled();
    expect(upstreamPayloads()).toContain('MASKED_EMAIL_');
    expect(upstreamPayloads()).not.toContain(EMAIL);
  });

  it('not forced anywhere, same chain without the plugin: reaches the upstream', async () => {
    mockConfig.api_config = configFor([], { anthropic: { invoke: [noopHook] } });
    await route('Bedrock converse, through orchestration').run();
    expect(upstream).toHaveBeenCalled();
  });
});

// The executor's backstop: the chain passes the controller's check, but an earlier plugin changes
// what the masking hook matches on, so the plugin is never reached.
describe('forced: an earlier plugin makes the masking hook miss', () => {
  it('orchestration chat: 503 pseudonymization_failed, upstream never called', async () => {
    mockConfig.api_config = configFor(['openai'], { openai: { invoke: [rewriterHook, PSEUDONYMIZATION_HOOK] } });
    expectRefused(await route('orchestration chat').run(), 'pseudonymization_failed');
  });

  it('Bedrock through orchestration: 503 pseudonymization_failed in the gateway error format', async () => {
    mockConfig.api_config = configFor(['aws-bedrock'], { anthropic: { invoke: [rewriterHook, PSEUDONYMIZATION_HOOK] } });
    expectRefused(await route('Bedrock converse, through orchestration').run(), 'pseudonymization_failed');
  });

  it('orchestration chat, masking first: masked and sent', async () => {
    mockConfig.api_config = configFor(['openai'], { openai: { invoke: [PSEUDONYMIZATION_HOOK, rewriterHook] } });
    await route('orchestration chat').run();
    expect(upstream).toHaveBeenCalled();
    expect(upstreamPayloads()).not.toContain(EMAIL);
  });
});
