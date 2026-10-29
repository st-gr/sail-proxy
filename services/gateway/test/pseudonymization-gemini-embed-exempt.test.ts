/**
 * Embeddings are never pseudonymized (maintainer ruling): Gemini embedContent under a forced
 * configuration goes on unmasked and is never refused for masking, whether or not its hook chain
 * lists the pseudonymization plugin; the chain's other plugins still run. generateContent under
 * the same configuration is refused or masked (pseudonymization-forced-no-hooks.test.ts covers the
 * other routes).
 *
 * Real executor, loader and plugin; configService, modelService and sapAIService are mocked.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }),
}));

const mockConfig: any = { api_config: {} };
jest.mock('../src/services/configService', () => {
  const svc: Record<string, any> = {
    getConfig: () => mockConfig,
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: (modelId: string, subpath: string, endpoint?: string) => {
      const override = mockConfig.api_config.models?.overrides?.[modelId]?.hooks?.[subpath];
      if (override) return override;
      return endpoint ? mockConfig.api_config.hooks?.defaults?.[endpoint]?.[subpath] || null : null;
    },
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getTimeout: () => 1000,
  };
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: { getModelDetails: (m: string) => Promise.resolve(require('./forcedRouteHarness').catalogueDetails(m)) },
}));

const upstream: jest.Mock<any> = jest.fn();
const serviceStub = () => new Proxy({}, { get: (_t, k: string) => (k === '__esModule' ? undefined : (...a: any[]) => upstream(k, ...a)) });
jest.mock('../src/services/sapAIService', () => ({ __esModule: true, default: serviceStub() }));
jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => upstream('axios.post', ...a) } }));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0 }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { handleGemini } from '../src/controllers/googleController';
import { EMAIL, ENDPOINTS, PSEUDONYMIZATION_HOOK, TEXT, configFor, mockReq, registerPlugins, route, run } from './forcedRouteHarness';

const NOOP = 'testNoopPlugin';
const NOOP_HOOK = { request: { callback: { id: NOOP }, match: ['header:contentTypeJson'] } };
const noopRuns: any[] = [];

/** Every endpoint forced, both models forced per model, with the given chains on both models. */
function forcedGoogle(embedChain: any[] | null, chatChain: any[] | null = null) {
  const config = configFor(ENDPOINTS);
  const hooks: Record<string, any> = {};
  if (embedChain) hooks.embedContent = embedChain;
  if (chatChain) hooks.generateContent = chatChain;
  for (const model of ['gemini-embedding', 'gpt-4o']) {
    config.models.overrides[model] = { pseudonymization: { enabled: true, method: 'pseudonymization' }, hooks };
  }
  return config;
}

let embedReq: any;
const embed = () => {
  embedReq = mockReq({ content: { parts: [{ text: TEXT }] } },
    '/google/v1beta/models/gemini-embedding:embedContent', { modelAndMethod: 'gemini-embedding:embedContent' });
  return run(handleGemini, embedReq);
};

beforeEach(() => {
  registerPlugins({ [NOOP]: async (ctx: any) => { noopRuns.push(ctx.req); return { stop: false }; } });
  (global as any).matcherCache?.clear?.();
  noopRuns.length = 0;
  upstream.mockReset();
  upstream.mockImplementation((seam: string) => (seam === 'createEmbedding'
    ? Promise.resolve({ final_result: { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 5 } } })
    : Promise.reject(new Error('upstream not reachable in this test'))));
});

describe('embeddings are never pseudonymized: Gemini embedContent', () => {
  it.each([
    ['no hook chain', null],
    ['a hook chain that lists the pseudonymization plugin', [PSEUDONYMIZATION_HOOK]],
    ['a hook chain with another plugin and the pseudonymization plugin', [NOOP_HOOK, PSEUDONYMIZATION_HOOK]],
  ])('forced, %s: 200, SAP embeds the original text', async (_name, embedChain) => {
    mockConfig.api_config = forcedGoogle(embedChain as any[] | null);
    const res = await embed();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ embedding: { values: [0.1, 0.2] } });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((upstream.mock.calls[0][1] as any).input.text).toBe(TEXT);
    // The plugin never ran on it (it leaves its state on every request it handles).
    expect(embedReq.__pseudonymization).toBeUndefined();
    expect(embedReq.__pseudonymizationForced).toBeUndefined();
    // The rest of the chain still runs.
    expect(noopRuns).toHaveLength((embedChain as any[] | null)?.includes(NOOP_HOOK) ? 1 : 0);
  });

  it('generateContent with the same configuration and no chain: refused', async () => {
    mockConfig.api_config = forcedGoogle(null);
    const res = await route('Gemini generateContent').run();
    expect(res.statusCode).toBe(503);
    expect(res.body?.error?.code).toBe('pseudonymization_hook_missing');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('generateContent with the same configuration and a chain: masked before SAP', async () => {
    mockConfig.api_config = forcedGoogle(null, [PSEUDONYMIZATION_HOOK]);
    await route('Gemini generateContent').run();
    expect(upstream).toHaveBeenCalled();
    expect(JSON.stringify(upstream.mock.calls.map((c: any[]) => c[1]))).not.toContain(EMAIL);
  });
});
