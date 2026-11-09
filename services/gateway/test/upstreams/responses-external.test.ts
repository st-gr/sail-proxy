/**
 * /openai/v1/responses on a Connection model (spec 2026-10-23 §5.3): the existing native passthrough
 * (the path SAP deployments of GPT-5 use) with the connection's URL and headers, the body built
 * after the plugins, and `__responsesUpstream` pointing at the connection so a web-search
 * continuation follows it. No SAP token is fetched and no SAP model looked up.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: jest.fn(async () => undefined) } }));

const getModelDetails = jest.fn(async (_m: string) => null as any);
const getAuthToken = jest.fn(async () => 'sap-token');
jest.mock('../../src/services/modelService', () => ({
  __esModule: true,
  default: { getModelDetails: (m: string) => getModelDetails(m), getAuthToken: () => getAuthToken() },
}));

let hookConfig: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportsResponsesApi: () => undefined,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getTimeout: () => 5000,
    getHookConfig: () => hookConfig,
    isPseudonymizationForced: () => false,
    getConfig: () => ({}),
  },
}));

let afterPlugin: (req: any, body: any) => Promise<any> = async (_req, body) => body;
jest.mock('../../src/services/pluginExecutor', () => ({
  executeBeforePlugins: async (req: any) => { req.body.input = 'MASKED_PERSON_1'; return { stop: false }; },
  executeAfterPlugins: (req: any, _res: any, body: any) => afterPlugin(req, body),
}));
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: () => {} }));

const usageEvents: Array<{ req: any; metrics: any; model: string; status: number }> = [];
jest.mock('../../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: (req: any, metrics: any, model: string, status: number) => { usageEvents.push({ req, metrics: { ...metrics }, model, status }); },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0; m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0; m.cacheReadInputTokens += cacheRead || 0;
  },
}));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { connectionRegistry } from '../../src/connections/connectionRegistry';
import type { Connection } from '../../src/connections/types';
import { handleResponses } from '../../src/controllers/responsesController';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });

const azure = (): Connection => ({
  id: 'c-az', name: 'az', providerType: 'azure-openai', isActive: true,
  settings: { endpoint: fake.url, apiMode: 'v1', authMode: 'api-key' }, credentials: { secret: 'az-key' },
  models: [{ modelId: 'gpt-5--az', upstreamModel: 'my-deployment', displayName: null, family: 'openai', capabilities: ['chat'], priced: true }],
});

let lastReq: any;
const app = () => {
  const a = express();
  a.use(express.json());
  a.post('/v1/responses', (req: any, res, next) => {
    req.apiKeyInfo = { entitlement: { catalogId: 'c', catalogName: 'Overflow', mode: 'list', include: ['gpt-5--az', 'gpt-5.3-codex--deployed'] } };
    lastReq = req;
    return handleResponses(req, res, next);
  });
  return a;
};
const USAGE = { input_tokens: 50, output_tokens: 9, input_tokens_details: { cached_tokens: 20 } };

beforeEach(() => {
  fake.requests.length = 0;
  usageEvents.length = 0;
  hookConfig = { before: ['x'], after: ['y'] };
  afterPlugin = async (_req, body) => body;
  getModelDetails.mockClear(); getAuthToken.mockClear();
  connectionRegistry.setShadowed([]);
  connectionRegistry.setBackend({ fetch: async () => [azure()] });
});

describe('Responses API on a connection model', () => {
  it('non-streaming Responses go to the connection with the deployment name; no SAP token is fetched', async () => {
    fake.script([{ kind: 'json', body: { id: 'resp_1', object: 'response', model: 'my-deployment', status: 'completed', output: [], usage: USAGE } }]);
    const r = await request(app()).post('/v1/responses').send({ model: 'gpt-5--az', input: 'Jane Doe' });
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('gpt-5--az');
    expect(fake.requests[0].url).toBe('/openai/v1/responses');
    expect(fake.requests[0].headers['api-key']).toBe('az-key');
    const sent = JSON.parse(fake.requests[0].body);
    expect(sent.model).toBe('my-deployment');
    expect(sent.input).toBe('MASKED_PERSON_1');
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(getModelDetails).not.toHaveBeenCalled();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ model: 'gpt-5--az', status: 200, metrics: { inputTokens: 30, cacheReadInputTokens: 20, outputTokens: 9 } });
    expect(usageEvents[0].req.__externalUsage).toEqual({ provider: 'azure-openai', connectionId: 'c-az', upstreamModel: 'my-deployment' });
  });

  it('streaming Responses are forwarded frame by frame and usage folds from response.completed', async () => {
    const frames = [
      JSON.stringify({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }),
      JSON.stringify({ type: 'response.output_text.delta', delta: 'Hi' }),
      JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: USAGE } }),
    ];
    fake.script([{ kind: 'sse', frames }]);
    const r = await request(app()).post('/v1/responses').send({ model: 'gpt-5--az', input: 'x', stream: true });
    expect(r.status).toBe(200);
    expect(r.text).toContain('response.output_text.delta');
    expect(r.text).toContain('response.completed');
    await new Promise((res) => setTimeout(res, 20));
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 30, cacheReadInputTokens: 20, outputTokens: 9 });
  });

  it('__responsesUpstream carries the connection url and headers', async () => {
    let seen: any;
    afterPlugin = async (req, body) => { seen = req.__responsesUpstream; return body; };
    fake.script([{ kind: 'json', body: { id: 'resp_1', object: 'response', status: 'completed', output: [], usage: USAGE } }]);
    await request(app()).post('/v1/responses').send({ model: 'gpt-5--az', input: 'x' });
    expect(seen.url).toBe(`${fake.url}/openai/v1/responses`);
    expect(seen.headers['api-key']).toBe('az-key');
    expect(seen.payload.model).toBe('my-deployment');
  });

  it('an upstream 401 echoing the key is passed through redacted', async () => {
    fake.script([{ kind: 'status', status: 401, body: { error: { message: 'Access denied due to invalid key az-key', code: '401' } } }]);
    const r = await request(app()).post('/v1/responses').send({ model: 'gpt-5--az', input: 'x' });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toContain('az-key');
    expect(usageEvents.map((e) => e.status)).toEqual([401]);
  });

  it('a gpt-5 SAP deployed model still takes the native SAP path', async () => {
    getModelDetails.mockImplementation(async (m: string) => (m === 'gpt-5.3-codex--deployed'
      ? { id: m, model: 'gpt-5.3-codex', owned_by: 'OpenAI', deploymentUrl: `${fake.url}/sap/deployments/abc` } : null));
    fake.script([{ kind: 'json', body: { id: 'resp_2', object: 'response', status: 'completed', output: [], usage: USAGE } }]);
    const r = await request(app()).post('/v1/responses').send({ model: 'gpt-5.3-codex--deployed', input: 'x' });
    expect(r.status).toBe(200);
    expect(fake.requests[0].url).toBe('/sap/deployments/abc/responses');
    expect(fake.requests[0].headers.authorization).toBe('Bearer sap-token');
    expect(lastReq.__externalUsage).toBeUndefined();
    getModelDetails.mockImplementation(async () => null);
  });
});
