/**
 * Forced pseudonymization on /openai/v1/chat/completions with a Claude model served through
 * orchestration: when the last message carries block content, the SAP prompt template holds the
 * client's system message. That template must carry the masked system prompt, never a copy of the
 * real one taken before the plugin ran.
 *
 * The plugin executor, plugin loader and pseudonymization plugin are the REAL modules with the
 * shipped hooks; configService, modelService and the upstream seams are mocked.
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

import { handleChatCompletion } from '../src/controllers/openaiController';
import { EMAIL, mockReq, registerPlugins, run, shippedHooks } from './forcedRouteHarness';

const shipped = () => ({ hooks: JSON.parse(JSON.stringify(shippedHooks)), models: { overrides: {} }, observability: {} });
/** The orchestration payloads handed to sapAIService. */
const sapPayloads = () => upstream.mock.calls.map((c: any[]) => c[1]);

beforeEach(() => {
  registerPlugins();
  (global as any).matcherCache?.clear?.();
  upstream.mockReset();
  upstream.mockImplementation(() => Promise.reject(new Error('upstream not reachable in this test')));
  mockConfig.api_config = shipped();
});

describe('forced, Claude model on orchestration chat, block content in the last message', () => {
  it.each([
    ['string system message', `Customer contact: ${EMAIL}`],
    ['block system message', [{ type: 'text', text: `Customer contact: ${EMAIL}` }]],
  ])('%s: the SAP prompt template carries the masked system prompt', async (_n, systemContent) => {
    expect(mockConfig.api_config.hooks.defaults.openai.pseudonymization.enabled).toBe(true);
    const body = {
      model: 'claude-sonnet-4',
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: [{ type: 'text', text: `Write to ${EMAIL}` }] },
      ],
    };
    await run(handleChatCompletion, mockReq(body, '/openai/v1/chat/completions'));

    expect(upstream).toHaveBeenCalled();
    const [payload] = sapPayloads();
    const template = payload.config.modules.prompt_templating.prompt.template;
    expect(template[0].role).toBe('system');
    expect(JSON.stringify(template)).toContain('MASKED_EMAIL_');
    expect(JSON.stringify(sapPayloads())).not.toContain(EMAIL);
  });

  it('no system message: the default system prompt is used', async () => {
    const body = { model: 'claude-sonnet-4', messages: [{ role: 'user', content: [{ type: 'text', text: `Write to ${EMAIL}` }] }] };
    await run(handleChatCompletion, mockReq(body, '/openai/v1/chat/completions'));

    const [payload] = sapPayloads();
    expect(payload.config.modules.prompt_templating.prompt.template).toEqual([{ role: 'system', content: 'You are a helpful assistant.' }]);
    expect(JSON.stringify(sapPayloads())).not.toContain(EMAIL);
  });
});
