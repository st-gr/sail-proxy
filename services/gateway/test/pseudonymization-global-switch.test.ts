/**
 * The global switch `api_config.observability.pseudonymization.enabled` gates forced
 * pseudonymization: only the boolean `true` lets the endpoint and model flags enforce masking.
 * A caller's own request (`masking` block, trigger word) works either way, and a configuration
 * that cannot be read is still treated as forced.
 *
 * Unit tests on readForceSource, then every plugin-running route under global Off and the
 * Off -> On change. Real executor, loader and plugin; configService, modelService and the
 * upstream seams are mocked (same preamble as pseudonymization-forced-no-hooks.test.ts).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }),
}));

const mockConfig: any = { api_config: {} };
let getConfigThrows = false;
jest.mock('../src/services/configService', () => {
  const svc: Record<string, any> = {
    getConfig: () => { if (getConfigThrows) throw new Error('config unreadable'); return mockConfig; },
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

import { handleChatCompletion } from '../src/controllers/openaiController';
import { readForceSource, checkForcedPseudonymization } from '../src/pluginSupport/pseudonymization/forcedRun';
import { MUST_RUN_FLAG } from '../src/pluginSupport/pseudonymization/failClosed';
import {
  EMAIL, TEXT, ENDPOINTS, PSEUDONYMIZATION_HOOK, ROUTES, configFor, registerPlugins, route, run, mockReq,
} from './forcedRouteHarness';

/** Build a configuration with flags set; `globalEnabled === undefined` omits the key. */
function cfg(globalEnabled: unknown, endpoints: string[], models: string[] = []): any {
  const config: any = {
    hooks: { defaults: Object.fromEntries(endpoints.map((e) => [e, { pseudonymization: { enabled: true } }])) },
    models: { overrides: Object.fromEntries(models.map((m) => [m, { pseudonymization: { enabled: true } }])) },
    observability: { pseudonymization: {} },
  };
  if (globalEnabled !== undefined) config.observability.pseudonymization.enabled = globalEnabled;
  return config;
}

beforeEach(() => {
  getConfigThrows = false;
  registerPlugins();
  (global as any).matcherCache?.clear?.();
  upstream.mockReset();
  upstream.mockImplementation(() => Promise.reject(new Error('upstream not reachable in this test')));
});

describe('readForceSource under the global switch', () => {
  const req = (endpoint: string, model = 'gpt-4o', routes: string[] = []): any =>
    ({ __endpoint: endpoint, __routeEndpoints: routes, body: { model } });

  it.each([[undefined], [false], ['true'], [1], [null]])('global %p: an enabled endpoint flag forces nothing', (g) => {
    mockConfig.api_config = cfg(g, ['openai']);
    expect(readForceSource(req('openai'))).toBeNull();
  });
  it('no observability.pseudonymization block: forces nothing', () => {
    mockConfig.api_config = { hooks: { defaults: { openai: { pseudonymization: { enabled: true } } } } };
    expect(readForceSource(req('openai'))).toBeNull();
  });
  it('global true: the endpoint flag forces', () => {
    mockConfig.api_config = cfg(true, ['openai']);
    expect(readForceSource(req('openai'))?.source).toBe('endpoint');
  });
  it('global true, openai off, anthropic on: only anthropic is forced', () => {
    mockConfig.api_config = cfg(true, ['anthropic']);
    expect(readForceSource(req('openai'))).toBeNull();
    expect(readForceSource(req('anthropic'))?.source).toBe('endpoint');
  });
  it('model flag: forced under true, not under false', () => {
    mockConfig.api_config = cfg(true, [], ['m1--deployed']);
    expect(readForceSource(req('openai', 'm1--deployed'))?.source).toBe('model');
    mockConfig.api_config = cfg(false, [], ['m1--deployed']);
    expect(readForceSource(req('openai', 'm1--deployed'))).toBeNull();
  });
  it('route endpoint (Bedrock through the Anthropic flow): forced under true, not under false', () => {
    mockConfig.api_config = cfg(true, ['aws-bedrock']);
    expect(readForceSource(req('anthropic', 'bedrock-claude', ['aws-bedrock']))?.source).toBe('endpoint');
    mockConfig.api_config = cfg(false, ['aws-bedrock']);
    expect(readForceSource(req('anthropic', 'bedrock-claude', ['aws-bedrock']))).toBeNull();
  });
  it('a configuration that cannot be read is still forced', () => {
    getConfigThrows = true;
    expect(() => readForceSource(req('openai'))).toThrow();
    const r = req('openai');
    expect(checkForcedPseudonymization(r, null).forced).toBe(true);
    expect(r[MUST_RUN_FLAG]).toBe(true);
  });
  it('no answer is remembered across a configuration change', () => {
    const r = req('openai');
    mockConfig.api_config = cfg(false, ['openai']);
    expect(readForceSource(r)).toBeNull();
    mockConfig.api_config = cfg(true, ['openai']);
    expect(readForceSource(req('openai'))?.source).toBe('endpoint');
    expect(readForceSource(r)?.source).toBe('endpoint');
  });
  it('global Off: the check does not mark the request as must-run', () => {
    mockConfig.api_config = cfg(false, ['openai']);
    const r = req('openai');
    const check = checkForcedPseudonymization(r, null);
    expect(check.forced).toBe(false);
    expect(r[MUST_RUN_FLAG]).toBeUndefined();
  });
});

/** Everything the upstream seams received (deployed routes send through axios.post(url, body)). */
const upstreamPayloads = () => JSON.stringify(upstream.mock.calls);
const chainsWithPlugin = () => Object.fromEntries(ENDPOINTS.map((e) => [e, {
  invoke: [PSEUDONYMIZATION_HOOK], converse: [PSEUDONYMIZATION_HOOK], 'converse-stream': [PSEUDONYMIZATION_HOOK],
  'invoke-with-response-stream': [PSEUDONYMIZATION_HOOK],
}]));
const MASKING_BLOCK = { method: 'pseudonymization', entities: [{ type: 'profile-email' }] };
const CHAT_ROUTE = 'orchestration chat';

/** An orchestration chat request through the real controller; the mocked SAP seam echoes its input. */
async function chat(content: string, extra: any = {}) {
  upstream.mockImplementation(async (name: string, payload: any) => {
    if (name !== 'completeChat') throw new Error('upstream not reachable in this test');
    const template = payload.config.modules.prompt_templating.prompt.template;
    const echoed = template.filter((m: any) => m.role === 'user').map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ');
    return { final_result: { id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: echoed }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
  });
  const res = await run(handleChatCompletion, mockReq({ model: 'gpt-4o', messages: [{ role: 'user', content }], ...extra }, '/openai/v1/chat/completions'));
  return { res };
}

describe('routes under global Off', () => {
  it.each(ROUTES.map((r) => [r.name]))('%s: flags on, no pseudonymization hook - not refused, sent unmasked', async (name) => {
    mockConfig.api_config = configFor(ENDPOINTS, {}, false);
    const res = await route(name).run();
    expect(res.statusCode).not.toBe(503);
    expect(JSON.stringify(res.body ?? '')).not.toContain('pseudonymization_hook_missing');
    expect(upstream).toHaveBeenCalled();
    expect(upstreamPayloads()).toContain(EMAIL);
  });

  it.each(ROUTES.map((r) => [r.name]))('%s: flags on, hook wired, no caller intent - sent unmasked', async (name) => {
    mockConfig.api_config = configFor(ENDPOINTS, chainsWithPlugin(), false);
    const res = await route(name).run();
    expect(res.body?.error?.code).not.toBe('pseudonymization_failed');
    expect(upstream).toHaveBeenCalled();
    expect(upstreamPayloads()).toContain(EMAIL);
    expect(upstreamPayloads()).not.toContain('MASKED_EMAIL_');
  });

  it('a masking block still masks, and the answer is unmasked again', async () => {
    mockConfig.api_config = configFor(ENDPOINTS, chainsWithPlugin(), false);
    const { res } = await chat(TEXT, { masking: MASKING_BLOCK });
    expect(upstream).toHaveBeenCalled();
    expect(upstreamPayloads()).toContain('MASKED_EMAIL_');
    expect(upstreamPayloads()).not.toContain(EMAIL);
    expect(JSON.stringify(res.body)).toContain(EMAIL);
  });

  it('the trigger word still masks', async () => {
    mockConfig.api_config = configFor(ENDPOINTS, chainsWithPlugin(), false);
    await chat(`<sail-proxy:pseudonymization:on> ${TEXT}`);
    expect(upstream).toHaveBeenCalled();
    expect(upstreamPayloads()).not.toContain(EMAIL);
  });

  it('after switching On, the next request is enforced', async () => {
    mockConfig.api_config = configFor(['openai'], {}, false);
    expect((await route(CHAT_ROUTE).run()).statusCode).not.toBe(503);
    upstream.mockClear();
    mockConfig.api_config = configFor(['openai'], {}, true);
    const res = await route(CHAT_ROUTE).run();
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('pseudonymization_hook_missing');
    expect(upstream).not.toHaveBeenCalled();
  });
});
