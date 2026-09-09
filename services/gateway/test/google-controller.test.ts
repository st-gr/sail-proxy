/**
 * googleController: route choice (spec §5.4) and the handler's order of business.
 *
 * Everything below the controller is mocked — axios (native transport),
 * sapAIService (orchestration transport), modelService (catalogue),
 * configService, pluginExecutor and usageTracker — the same fake set
 * test/responses-controller.test.ts uses, so this suite exercises the real
 * wiring in googleController.ts rather than a reimplementation of it.
 *
 * The catalogue mock is faithful to the real model list: every deployment
 * appears TWICE, as the bare orchestration entry (no deploymentUrl) and as its
 * `--deployed` twin (which carries one). A mock that deployed both could not
 * tell a swap from a no-op.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const posted: any[] = [];
let nextPostRejection: any = null;
let nativeResponse: any = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 6, thoughtsTokenCount: 2, cachedContentTokenCount: 2 },
};
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any, cfg: any) => {
      posted.push({ url, body, cfg });
      if (nextPostRejection) {
        const err: any = new Error(nextPostRejection.message || 'upstream failed');
        if (nextPostRejection.response) err.response = nextPostRejection.response;
        if (nextPostRejection.code) err.code = nextPostRejection.code;
        nextPostRejection = null;
        return Promise.reject(err);
      }
      return Promise.resolve({ status: 200, data: nativeResponse });
    },
  },
}));

/**
 * The catalogue every route-choice case is read off. `--deployed` entries carry
 * a deploymentUrl and a provider; bare entries carry the orchestration
 * `allowedScenarios` (or not, which is what makes a model unroutable there).
 */
const CATALOGUE: Record<string, any> = {
  // Deployed Gemini chat model: bare entry with NO orchestration scenario, plus a Google twin.
  'gemini-3.5-flash': { id: 'gemini-3.5-flash', model: 'gemini-3.5-flash', owned_by: 'Google' },
  'gemini-3.5-flash--deployed': {
    id: 'gemini-3.5-flash--deployed', model: 'gemini-3.5-flash', provider: 'google',
    deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-flash',
    versions: [{ capabilities: ['chat', 'streaming', 'tools'] }],
  },
  // Undeployed Gemini: orchestration only.
  'gemini-2.0-legacy': {
    id: 'gemini-2.0-legacy', model: 'gemini-2.0-legacy', owned_by: 'Google',
    allowedScenarios: [{ scenarioId: 'orchestration' }],
  },
  // Claude, both entries. The deployment is a chat-completions one — not Google.
  'anthropic--claude-4.5-sonnet': {
    id: 'anthropic--claude-4.5-sonnet', model: 'anthropic--claude-4.5-sonnet', owned_by: 'Anthropic',
    allowedScenarios: [{ scenarioId: 'orchestration' }],
  },
  'anthropic--claude-4.5-sonnet--deployed': {
    id: 'anthropic--claude-4.5-sonnet--deployed', model: 'anthropic--claude-4.5-sonnet', provider: 'Anthropic',
    deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-sonnet',
  },
  // Embedding model reachable through orchestration AND deployed — orchestration wins (§5.4).
  'gemini-embedding': {
    id: 'gemini-embedding', model: 'gemini-embedding', owned_by: 'Google',
    allowedScenarios: [{ scenarioId: 'orchestration' }],
  },
  'gemini-embedding--deployed': {
    id: 'gemini-embedding--deployed', model: 'gemini-embedding', provider: 'google',
    deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-emb',
    versions: [{ capabilities: ['embedding'] }],
  },
  // Deployment-only embedding model: no orchestration scenario anywhere.
  'gemini-embedding-2': { id: 'gemini-embedding-2', model: 'gemini-embedding-2', owned_by: 'Google' },
  'gemini-embedding-2--deployed': {
    id: 'gemini-embedding-2--deployed', model: 'gemini-embedding-2', provider: 'google',
    deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-emb2',
    versions: [{ capabilities: ['embedding'] }],
  },
  // Neither deployed nor embedding-capable through orchestration.
  'gpt-realtime': { id: 'gpt-realtime', model: 'gpt-realtime', owned_by: 'OpenAI' },
};

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(CATALOGUE[m] || null),
    getAuthToken: () => Promise.resolve('tok'),
  },
}));

const configState: { hookConfig: any; substitutions: Record<string, string> } = {
  hookConfig: undefined, substitutions: {},
};
const hookConfigCalls: any[][] = [];
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_p: string, m: string) => configState.substitutions[m] || m,
    getHookConfig: (...a: any[]) => { hookConfigCalls.push(a); return configState.hookConfig; },
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'rg-test' }),
    getTimeout: () => 1000,
  },
  // Read by modelEntitlement, which the 403 path goes through.
  getTrustForwardedFor: () => false,
}));

const emitModelNotEntitled = jest.fn<any>().mockResolvedValue(undefined);
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitModelNotEntitled: (...a: any[]) => emitModelNotEntitled(...a) },
}));

let beforePlugins: (req: any, res: any, hooks: any) => Promise<any> = () => Promise.resolve({ stop: false });
let afterPlugins: (req: any, res: any, body: any, hooks: any) => Promise<any> = (_r, _s, body) => Promise.resolve(body);
const afterPluginBodies: any[] = [];
jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: (req: any, res: any, hooks: any) => beforePlugins(req, res, hooks),
  executeAfterPlugins: (req: any, res: any, body: any, hooks: any) => {
    afterPluginBodies.push(body);
    return afterPlugins(req, res, body, hooks);
  },
  executeStreamPlugins: () => Promise.resolve(undefined),
}));

const usageEvents: Array<[any, any, string, number]> = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({
    startTime: Date.now(), inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0,
  }),
  emitUsageEvent: (req: any, m: any, model: string, status: number) => {
    usageEvents.push([req, { ...m }, model, status]);
  },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0;
    m.cacheReadInputTokens += cacheRead || 0;
  },
}));

const orchestrationCalls: Array<{ kind: string; payload: any; model?: string }> = [];
let completion: any = {
  final_result: {
    choices: [{ message: { role: 'assistant', content: 'Hello from Sonnet' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } },
  },
};
let embedding: any = {
  final_result: { data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 11, total_tokens: 11 } },
};
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    completeChat: (payload: any) => {
      orchestrationCalls.push({ kind: 'completeChat', payload });
      return Promise.resolve(completion);
    },
    streamChatCompletion: async () => { /* covered by google-dispatch.test.ts */ },
    createEmbedding: (payload: any, model: string) => {
      orchestrationCalls.push({ kind: 'createEmbedding', payload, model });
      return Promise.resolve(embedding);
    },
  },
}));

import { chooseRoute, accountedModelId, handleGemini } from '../src/controllers/googleController';

const getDetails = (id: string): Promise<any> => Promise.resolve(CATALOGUE[id] || null);

function mockRes(): any {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[], ended: false, writableEnded: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.write = (s: string) => { r.writes.push(s); return true; };
  r.end = () => { r.ended = true; r.writableEnded = true; };
  r.headersSent = false;
  return r;
}

function mockReq(modelAndMethod: string, body: any = {}, extra: any = {}): any {
  return Object.assign(new EventEmitter(), {
    params: { modelAndMethod }, body, headers: {}, method: 'POST',
    originalUrl: `/google/v1beta/models/${modelAndMethod}`, ...extra,
  });
}

const CONTENTS = { contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }] };

beforeEach(() => {
  posted.length = 0;
  usageEvents.length = 0;
  orchestrationCalls.length = 0;
  afterPluginBodies.length = 0;
  hookConfigCalls.length = 0;
  emitModelNotEntitled.mockClear();
  nextPostRejection = null;
  configState.hookConfig = undefined;
  configState.substitutions = {};
  beforePlugins = () => Promise.resolve({ stop: false });
  afterPlugins = (_r: any, _s: any, body: any) => Promise.resolve(body);
  nativeResponse = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 6, thoughtsTokenCount: 2, cachedContentTokenCount: 2 },
  };
  completion = {
    final_result: {
      choices: [{ message: { role: 'assistant', content: 'Hello from Sonnet' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } },
    },
  };
  embedding = {
    final_result: { data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 11, total_tokens: 11 } },
  };
});

describe('chooseRoute (spec §5.4)', () => {
  it('bare Gemini name with a Google-provider twin → native on the twin', async () => {
    const route = await chooseRoute('gemini-3.5-flash', 'generateContent', getDetails);
    expect(route).toEqual({
      kind: 'native',
      deployment: {
        id: 'gemini-3.5-flash--deployed', baseModel: 'gemini-3.5-flash',
        deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-flash',
      },
    });
    expect(accountedModelId(route as any)).toBe('gemini-3.5-flash--deployed');
  });

  it('explicit --deployed Gemini name → native', async () => {
    const route = await chooseRoute('gemini-3.5-flash--deployed', 'streamGenerateContent', getDetails);
    expect(route?.kind).toBe('native');
    expect((route as any).deployment.id).toBe('gemini-3.5-flash--deployed');
  });

  it('explicit --deployed non-Google deployment → bridge on the BASE model name', async () => {
    const route = await chooseRoute('anthropic--claude-4.5-sonnet--deployed', 'generateContent', getDetails);
    expect(route).toEqual({ kind: 'bridge', modelName: 'anthropic--claude-4.5-sonnet' });
    expect(accountedModelId(route as any)).toBe('anthropic--claude-4.5-sonnet');
  });

  it('undeployed Gemini model → bridge', async () => {
    expect(await chooseRoute('gemini-2.0-legacy', 'generateContent', getDetails))
      .toEqual({ kind: 'bridge', modelName: 'gemini-2.0-legacy' });
  });

  it('bare Claude → bridge', async () => {
    expect(await chooseRoute('anthropic--claude-4.5-sonnet', 'generateContent', getDetails))
      .toEqual({ kind: 'bridge', modelName: 'anthropic--claude-4.5-sonnet' });
  });

  it('unknown model → null', async () => {
    expect(await chooseRoute('no-such-model', 'generateContent', getDetails)).toBeNull();
  });

  it('embedContent on a model with the orchestration scenario → orchestration, even with a Google twin', async () => {
    const route = await chooseRoute('gemini-embedding', 'embedContent', getDetails);
    expect(route).toEqual({ kind: 'embeddings-orchestration', modelName: 'gemini-embedding' });
    expect(accountedModelId(route as any)).toBe('gemini-embedding');
  });

  it('embedContent on a deployment-only embedding model → native on the twin', async () => {
    const route = await chooseRoute('gemini-embedding-2', 'embedContent', getDetails);
    expect(route?.kind).toBe('embeddings-native');
    expect((route as any).deployment.id).toBe('gemini-embedding-2--deployed');
    expect(accountedModelId(route as any)).toBe('gemini-embedding-2--deployed');
  });

  it('embedContent naming a deployment falls back to the BASE model\'s orchestration scenario', async () => {
    expect(await chooseRoute('gemini-embedding--deployed', 'embedContent', getDetails))
      .toEqual({ kind: 'embeddings-orchestration', modelName: 'gemini-embedding' });
  });

  it('embedContent naming a CHAT deployment whose base has no scenario → null', async () => {
    expect(await chooseRoute('gemini-3.5-flash--deployed', 'embedContent', getDetails)).toBeNull();
  });

  it('embedContent on a model that can embed nowhere → null', async () => {
    expect(await chooseRoute('gpt-realtime', 'embedContent', getDetails)).toBeNull();
  });
});

describe('handleGemini: refusals', () => {
  it('404s an unsupported method, naming the three supported ones', async () => {
    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:countTokens', CONTENTS), res, jest.fn() as any);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.status).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe(
      'Unsupported Gemini method in "gemini-3.5-flash:countTokens". This gateway serves '
      + 'generateContent, streamGenerateContent and embedContent.');
    expect(posted).toHaveLength(0);
  });

  it('404s a model that is not in the catalogue', async () => {
    const res = mockRes();
    await handleGemini(mockReq('no-such-model:generateContent', CONTENTS), res, jest.fn() as any);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: { code: 404, message: 'Model no-such-model is not available through this gateway', status: 'NOT_FOUND' },
    });
  });

  it('404s embedContent on a model that can embed nowhere', async () => {
    const res = mockRes();
    await handleGemini(mockReq('gpt-realtime:embedContent', { content: { parts: [{ text: 'x' }] } }), res, jest.fn() as any);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.message).toBe(
      'Model gpt-realtime does not support embedContent through this gateway. It has neither an '
      + 'orchestration embedding scenario nor a Google embedding deployment.');
  });

  it('403s a model outside the entitlement, in the Gemini error shape', async () => {
    const res = mockRes();
    const req = mockReq('gemini-3.5-flash:generateContent', CONTENTS, {
      unifiedAuth: { data: { entitlement: { catalogId: 'c1', catalogName: 'Team', mode: 'list', include: ['other'] } } },
    });
    await handleGemini(req, res, jest.fn() as any);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: 403,
        message: 'Model gemini-3.5-flash is not in your entitlement catalog "Team"',
        status: 'PERMISSION_DENIED',
      },
    });
    expect(posted).toHaveLength(0);
  });

  it('403s when only the SWAPPED-TO deployment is outside the entitlement', async () => {
    // The bare name is admitted but routing moved the request onto the twin — the parity
    // /openai/v1/responses established: a catalog listing only the bare id must not admit
    // the decorated deployment.
    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', CONTENTS, {
      unifiedAuth: { data: { entitlement: { catalogId: 'c1', catalogName: 'Team', mode: 'list', include: ['gemini-3.5-flash'] } } },
    }), res, jest.fn() as any);

    expect(res.statusCode).toBe(403);
    expect(res.body.error.message).toBe('Model gemini-3.5-flash--deployed is not in your entitlement catalog "Team"');
    expect(posted).toHaveLength(0);
  });

  it('403s when only the REQUESTED id is outside the entitlement, though the bridged base name is in', async () => {
    // The other direction: a `--deployed` id bridged under its base name. Admitting it
    // because the base is listed would let a catalog be side-stepped by decorating the name.
    const res = mockRes();
    await handleGemini(mockReq('anthropic--claude-4.5-sonnet--deployed:generateContent', CONTENTS, {
      unifiedAuth: { data: { entitlement: { catalogId: 'c1', catalogName: 'Team', mode: 'list', include: ['anthropic--claude-4.5-sonnet'] } } },
    }), res, jest.fn() as any);

    expect(res.statusCode).toBe(403);
    expect(res.body.error.message).toBe('Model anthropic--claude-4.5-sonnet--deployed is not in your entitlement catalog "Team"');
    expect(orchestrationCalls).toHaveLength(0);
  });

  it('lets a request through when BOTH the requested and the accounted id are entitled', async () => {
    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', CONTENTS, {
      unifiedAuth: { data: { entitlement: { catalogId: 'c1', catalogName: 'Team', mode: 'list', include: ['gemini-3.5-flash', 'gemini-3.5-flash--deployed'] } } },
    }), res, jest.fn() as any);

    expect(res.statusCode).toBe(200);
    expect(posted).toHaveLength(1);
  });

  it('raises the model_not_entitled security event for the accounted id on a 403', async () => {
    const req = mockReq('gemini-3.5-flash:generateContent', CONTENTS, {
      unifiedAuth: { authType: 'api_key', data: { keyId: 'k1', entitlement: { catalogId: 'c1', catalogName: 'Team', mode: 'list', include: ['gemini-3.5-flash'] } } },
      socket: { remoteAddress: '203.0.113.7' }, ip: '203.0.113.7', get: () => 'jest',
    });
    await handleGemini(req, mockRes(), jest.fn() as any);

    // The Gemini envelope is the only thing that differs from the other routes; a refused
    // credential must still be visible to the SIEM.
    expect(emitModelNotEntitled).toHaveBeenCalledTimes(1);
    expect(emitModelNotEntitled).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: 'k1', authType: 'api_key', model: 'gemini-3.5-flash--deployed',
      catalog: 'Team', catalogId: 'c1', endpoint: '/google/v1beta/models/gemini-3.5-flash:generateContent',
    }));
  });

  it('raises no security event for an entitled model', async () => {
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', CONTENTS), mockRes(), jest.fn() as any);
    expect(emitModelNotEntitled).not.toHaveBeenCalled();
  });

  it('substitutes the model name before choosing a route', async () => {
    configState.substitutions = { 'gemini-pro-latest': 'gemini-3.5-flash' };
    const res = mockRes();
    await handleGemini(mockReq('gemini-pro-latest:generateContent', CONTENTS), res, jest.fn() as any);
    expect(res.statusCode).toBe(200);
    expect(posted[0].url).toContain('/models/gemini-3.5-flash:generateContent');
  });
});

describe('handleGemini: hooks', () => {
  it('sets __endpoint and req.body.model for the plugin pipeline, then strips model before the upstream call', async () => {
    configState.hookConfig = [{ request: { match: ['*'], callback: { id: 'x' } } }];
    let seen: any = null;
    beforePlugins = (req: any) => { seen = { endpoint: req.__endpoint, model: req.body.model }; return Promise.resolve({ stop: false }); };

    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', { ...CONTENTS }), res, jest.fn() as any);

    expect(seen).toEqual({ endpoint: 'google', model: 'gemini-3.5-flash--deployed' });
    expect(hookConfigCalls[0]).toEqual(['gemini-3.5-flash--deployed', 'generateContent', 'google']);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.model).toBeUndefined();
    expect(posted[0].body.contents).toEqual(CONTENTS.contents);
  });

  it('strips req.body.model before the ORCHESTRATION call too', async () => {
    configState.hookConfig = [{ request: { match: ['*'], callback: { id: 'x' } } }];
    const req = mockReq('anthropic--claude-4.5-sonnet:generateContent', { ...CONTENTS });
    await handleGemini(req, mockRes(), jest.fn() as any);
    expect(orchestrationCalls).toHaveLength(1);
    expect(req.body.model).toBeUndefined();
  });

  it('returns a before-plugin short-circuit body verbatim', async () => {
    configState.hookConfig = [{ request: { match: ['*'], callback: { id: 'x' } } }];
    const cached = { candidates: [{ content: { role: 'model', parts: [{ text: 'cached' }] } }] };
    beforePlugins = () => Promise.resolve({ stop: true, response: cached });

    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', CONTENTS), res, jest.fn() as any);

    expect(res.body).toEqual(cached);
    expect(posted).toHaveLength(0);
    expect(orchestrationCalls).toHaveLength(0);
  });

  it('runs after-plugins on the final Gemini body', async () => {
    configState.hookConfig = [{ request: { match: ['*'], callback: { id: 'x' } } }];
    afterPlugins = (_r: any, _s: any, body: any) => Promise.resolve({ ...body, __touched: true });

    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', CONTENTS), res, jest.fn() as any);

    expect(afterPluginBodies[0].candidates[0].content.parts[0].text).toBe('hi');
    expect(res.body.__touched).toBe(true);
  });
});

describe('handleGemini: metering per transport', () => {
  it('native generateContent: usageMetadata 7 prompt (2 of it cached) / 6+2 out → 5 full-rate in', async () => {
    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', CONTENTS), res, jest.fn() as any);

    expect(res.statusCode).toBe(200);
    expect(posted[0].url).toBe('http://mock-sap/v2/inference/deployments/d-flash/models/gemini-3.5-flash:generateContent');
    expect(posted[0].cfg.headers['AI-Resource-Group']).toBe('rg-test');
    expect(posted[0].cfg.headers.Authorization).toBe('Bearer tok');
    const [, metrics, model, status] = usageEvents[0];
    expect(model).toBe('gemini-3.5-flash--deployed');
    expect(status).toBe(200);
    // INCLUSIVE: Google's promptTokenCount "is still the total effective prompt size meaning
    // this includes the number of tokens in the cached content", so the cached 2 come out of
    // the full-rate figure rather than being priced twice.
    expect(metrics.inputTokens).toBe(5);
    expect(metrics.outputTokens).toBe(8);
    expect(metrics.cacheReadInputTokens).toBe(2);
  });

  it('bridge generateContent: orchestration usage with cached tokens, accounted on the bare model', async () => {
    const res = mockRes();
    await handleGemini(mockReq('anthropic--claude-4.5-sonnet:generateContent', CONTENTS), res, jest.fn() as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.candidates[0].content.parts[0].text).toBe('Hello from Sonnet');
    expect(res.body.modelVersion).toBe('anthropic--claude-4.5-sonnet');
    const [, metrics, model] = usageEvents[0];
    expect(model).toBe('anthropic--claude-4.5-sonnet');
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.outputTokens).toBe(5);
    expect(metrics.cacheReadInputTokens).toBe(3);
  });

  it('embeddings via orchestration: prompt_tokens, one joined text, Gemini response shape', async () => {
    const res = mockRes();
    const body = { content: { parts: [{ text: 'alpha' }, { text: 'beta' }] } };
    await handleGemini(mockReq('gemini-embedding:embedContent', body), res, jest.fn() as any);

    expect(orchestrationCalls[0].kind).toBe('createEmbedding');
    expect(orchestrationCalls[0].payload).toEqual({
      config: { modules: { embeddings: { model: { name: 'gemini-embedding' } } } },
      input: { text: 'alpha\nbeta' },
    });
    expect(res.body).toEqual({ embedding: { values: [0.1, 0.2] } });
    const [, metrics, model] = usageEvents[0];
    expect(model).toBe('gemini-embedding');
    expect(metrics.inputTokens).toBe(11);
    expect(metrics.outputTokens).toBe(0);
  });

  it('native embeddings: ceil(chars/4) estimated input tokens, deployment id accounted', async () => {
    nativeResponse = { embedding: { values: [0.5] } };
    const res = mockRes();
    // 9 characters of text → ceil(9/4) = 3
    const body = { content: { parts: [{ text: 'abcde' }, { text: 'fghi' }] } };
    await handleGemini(mockReq('gemini-embedding-2:embedContent', body), res, jest.fn() as any);

    expect(posted[0].url).toBe('http://mock-sap/v2/inference/deployments/d-emb2/models/gemini-embedding-2:embedContent');
    expect(res.body).toEqual({ embedding: { values: [0.5] } });
    const [, metrics, model] = usageEvents[0];
    expect(model).toBe('gemini-embedding-2--deployed');
    expect(metrics.inputTokens).toBe(3);
  });
});

describe('handleGemini: errors', () => {
  it('translates an unsupported Gemini input into 400 INVALID_ARGUMENT naming the path', async () => {
    const res = mockRes();
    const body = { contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'gs://x' } }] }] };
    await handleGemini(mockReq('anthropic--claude-4.5-sonnet:generateContent', body), res, jest.fn() as any);

    expect(res.statusCode).toBe(400);
    expect(res.body.error.status).toBe('INVALID_ARGUMENT');
    expect(res.body.error.message).toContain('contents[0].parts[0].fileData');
    expect(orchestrationCalls).toHaveLength(0);
  });

  it('applies the documented limits on the NATIVE path too, before anything is posted', async () => {
    // The bridge enforces these by translating; a native deployment used to receive them
    // unchanged, so the same body was refused or served depending only on the router's pick.
    const cases: Array<[any, string]> = [
      [{ ...CONTENTS, tools: [{ googleSearch: {} }] }, 'tools[0].googleSearch'],
      [{ contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'gs://x' } }] }] }, 'contents[0].parts[0].fileData'],
      [{ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AA' } }] }] }, 'contents[0].parts[0].inlineData'],
      [{ ...CONTENTS, generationConfig: { candidateCount: 2 } }, 'generationConfig.candidateCount'],
      [{ contents: [] }, 'contents'],
    ];

    for (const [body, path] of cases) {
      posted.length = 0;
      const res = mockRes();
      await handleGemini(mockReq('gemini-3.5-flash:generateContent', body), res, jest.fn() as any);
      expect(res.statusCode).toBe(400);
      expect(res.body.error.status).toBe('INVALID_ARGUMENT');
      expect(res.body.error.message).toContain(path);
      expect(posted).toHaveLength(0);
    }
  });

  it('does not refuse an ordinary native request that only declares functions', async () => {
    const res = mockRes();
    const body = { ...CONTENTS, tools: [{ functionDeclarations: [{ name: 'send' }], googleSearch: null }] };
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', body), res, jest.fn() as any);
    expect(res.statusCode).toBe(200);
    // Validation must not rewrite the body: the deployment gets the caller's tools verbatim.
    expect(posted[0].body.tools).toEqual(body.tools);
  });

  it('relays an upstream 400 with its status and message, and still meters', async () => {
    nextPostRejection = {
      message: 'Request failed with status code 400',
      response: { status: 400, data: { error: 'BadRequest', message: "Subpath 'models/x:embedContent' is not allowed for model 'x'." } },
    };
    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', CONTENTS), res, jest.fn() as any);

    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain('is not allowed for model');
    expect(res.body.error.status).toBe('INVALID_ARGUMENT');
    expect(usageEvents[0][2]).toBe('gemini-3.5-flash--deployed');
    expect(usageEvents[0][3]).toBe(400);
  });

  it('turns a network failure into 502 UNAVAILABLE', async () => {
    nextPostRejection = { message: 'connect ECONNREFUSED 127.0.0.1:443', code: 'ECONNREFUSED' };
    const res = mockRes();
    await handleGemini(mockReq('gemini-3.5-flash:generateContent', CONTENTS), res, jest.fn() as any);

    expect(res.statusCode).toBe(502);
    expect(res.body.error.status).toBe('UNAVAILABLE');
    expect(usageEvents[0][3]).toBe(502);
  });
});
