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
  default: {
    getModelDetails: (m: string) => Promise.resolve(require('./forcedRouteHarness').catalogueDetails(m)),
    getAuthToken: () => Promise.resolve('tok'),
  },
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

const IMAGE_MODEL = 'gemini-image--deployed';

/** Every endpoint forced, both models forced per model, with the given chains on both models. */
function forcedGoogle(embedChain: any[] | null, chatChain: any[] | null = null) {
  const config = configFor(ENDPOINTS);
  const hooks: Record<string, any> = {};
  if (embedChain) hooks.embedContent = embedChain;
  if (chatChain) hooks.generateContent = chatChain;
  for (const model of ['gemini-embedding', 'gpt-4o', IMAGE_MODEL]) {
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

// Image generation is never pseudonymized (maintainer ruling 2026-11-09): the model would draw the
// placeholder token. A request asking for images alone (generationConfig.responseModalities is
// IMAGE and nothing else) goes on with its prompt as sent, forced or not, and is never refused for
// masking. A request that also asks for text is a text request and is masked like one (ruling
// 2026-11-10): with IMAGE merely listed, a client could switch enforced masking off for any prompt.
describe('image generation is never pseudonymized: Gemini responseModalities IMAGE alone', () => {
  let imageReq: any;
  const generate = (method: string, generationConfig?: any) => {
    imageReq = mockReq({ contents: [{ role: 'user', parts: [{ text: TEXT }] }], ...(generationConfig ? { generationConfig } : {}) },
      `/google/v1beta/models/${IMAGE_MODEL}:${method}`, { modelAndMethod: `${IMAGE_MODEL}:${method}` });
    return run(handleGemini, imageReq);
  };
  const sentBodies = () => JSON.stringify(upstream.mock.calls.map((c: any[]) => c[2]));

  it.each([
    ['generateContent, no hook chain', 'generateContent', null],
    ['generateContent, a chain that lists the pseudonymization plugin', 'generateContent', [PSEUDONYMIZATION_HOOK]],
    ['streamGenerateContent, another plugin and the pseudonymization plugin', 'streamGenerateContent', [NOOP_HOOK, PSEUDONYMIZATION_HOOK]],
  ])('forced, %s: the deployment gets the prompt as sent', async (_name, method, chain) => {
    const config = forcedGoogle(null);
    if (chain) config.models.overrides[IMAGE_MODEL].hooks = { [method as string]: chain };
    mockConfig.api_config = config;
    const res = await generate(method as string, { responseModalities: ['IMAGE'] });
    expect(res.body?.error?.code).not.toBe('pseudonymization_hook_missing');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(sentBodies()).toContain(EMAIL);
    expect(sentBodies()).not.toContain('MASKED_');
    expect(imageReq.__pseudonymization).toBeUndefined();
    // The rest of the chain still runs.
    expect(noopRuns).toHaveLength((chain as any[] | null)?.includes(NOOP_HOOK) ? 1 : 0);
  });

  it.each([
    [['TEXT', 'IMAGE']],
    [['image', 'text']],
    [['IMAGE', 'AUDIO']],
  ])('asked for %j, with a chain: masked before the deployment, the client cannot opt out', async (responseModalities) => {
    const config = forcedGoogle(null);
    config.models.overrides[IMAGE_MODEL].hooks = { generateContent: [PSEUDONYMIZATION_HOOK] };
    mockConfig.api_config = config;
    await generate('generateContent', { responseModalities });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(sentBodies()).toContain('MASKED_EMAIL_');
    expect(sentBodies()).not.toContain(EMAIL);
  });

  it('asked for text and images, no chain: refused like a text request', async () => {
    mockConfig.api_config = forcedGoogle(null);
    const res = await generate('generateContent', { responseModalities: ['TEXT', 'IMAGE'] });
    expect(res.statusCode).toBe(503);
    expect(res.body?.error?.code).toBe('pseudonymization_hook_missing');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('the same model asked for text only, with a chain: masked before the deployment', async () => {
    const config = forcedGoogle(null);
    config.models.overrides[IMAGE_MODEL].hooks = { generateContent: [PSEUDONYMIZATION_HOOK] };
    mockConfig.api_config = config;
    await generate('generateContent');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(sentBodies()).toContain('MASKED_EMAIL_');
    expect(sentBodies()).not.toContain(EMAIL);
  });

  it('the same model asked for text only, no chain: refused', async () => {
    mockConfig.api_config = forcedGoogle(null);
    const res = await generate('generateContent');
    expect(res.statusCode).toBe(503);
    expect(res.body?.error?.code).toBe('pseudonymization_hook_missing');
    expect(upstream).not.toHaveBeenCalled();
  });
});

// Google's REST API also accepts snake_case field names; its own curl examples send
// `system_instruction`. The plugin reads `systemInstruction`, and a deployment gets the body as
// sent: under enforced masking the system text went out unmasked.
describe('enforced masking covers a snake_case system_instruction', () => {
  const SYSTEM = `Customer contact: ${EMAIL}`;
  const send = (model: string, body: any) => run(handleGemini,
    mockReq(body, `/google/v1beta/models/${model}:generateContent`, { modelAndMethod: `${model}:generateContent` }));
  const sent = () => JSON.stringify(upstream.mock.calls.map((c: any[]) => (c[0] === 'axios.post' ? c[2] : c[1])));

  it.each([
    ['an object with parts', { parts: [{ text: SYSTEM }] }],
    ['a bare string', SYSTEM],
  ])('on a deployment, %s: masked, and sent once under the documented name', async (_n, systemInstruction) => {
    const config = forcedGoogle(null);
    config.models.overrides[IMAGE_MODEL].hooks = { generateContent: [PSEUDONYMIZATION_HOOK] };
    mockConfig.api_config = config;
    await send(IMAGE_MODEL, { system_instruction: systemInstruction, contents: [{ role: 'user', parts: [{ text: 'Summarise.' }] }] });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(sent()).not.toContain(EMAIL);
    expect(sent()).toContain('MASKED_EMAIL_');
    const body = upstream.mock.calls[0][2] as any;
    expect(body.system_instruction).toBeUndefined();
    expect(body.systemInstruction).toBeDefined();
  });

  it('through orchestration: the system text reaches the model, masked', async () => {
    mockConfig.api_config = forcedGoogle(null, [PSEUDONYMIZATION_HOOK]);
    await send('gpt-4o', { system_instruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: 'Summarise.' }] }] });
    expect(upstream).toHaveBeenCalled();
    expect(sent()).not.toContain(EMAIL);
    expect(sent()).toContain('Customer contact: MASKED_EMAIL_');
  });

  it('both spellings in one request: refused, nothing sent', async () => {
    const config = forcedGoogle(null);
    config.models.overrides[IMAGE_MODEL].hooks = { generateContent: [PSEUDONYMIZATION_HOOK] };
    mockConfig.api_config = config;
    const res = await send(IMAGE_MODEL, {
      system_instruction: { parts: [{ text: SYSTEM }] },
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Summarise.' }] }],
    });
    expect(res.statusCode).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
