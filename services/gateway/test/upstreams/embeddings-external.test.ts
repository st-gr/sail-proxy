/**
 * /openai/v1/embeddings on a Connection model (spec 2026-10-23 §5.3): the whole client body goes to
 * the connection (every input, not just the first: that limit is SAP's), the answer comes back with
 * the client's model id, and usage counts the prompt tokens as input.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: jest.fn(async () => undefined) } }));
jest.mock('../../src/services/configService', () => ({ __esModule: true, default: { getTimeout: () => 5000 } }));
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: () => {} }));

const getModelById = jest.fn(async (_m: string) => ({ id: 'text-embedding-3-small', versions: [{ capabilities: ['embedding'] }] }));
jest.mock('../../src/services/modelService', () => ({ __esModule: true, default: { getModelById: (m: string) => getModelById(m) } }));
const createEmbedding = jest.fn(async () => ({ final_result: { data: [{ embedding: [0.5], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } } }));
jest.mock('../../src/services/sapAIService', () => ({ __esModule: true, default: { createEmbedding: (...a: any[]) => (createEmbedding as any)(...a) } }));

const usageEvents: Array<{ req: any; metrics: any; model: string; status: number }> = [];
jest.mock('../../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: (req: any, metrics: any, model: string, status: number) => { usageEvents.push({ req, metrics: { ...metrics }, model, status }); },
  updateTokenCounts: (m: any, input: number, output: number) => { m.inputTokens += input || 0; m.outputTokens += output || 0; },
}));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { connectionRegistry } from '../../src/connections/connectionRegistry';
import type { Connection } from '../../src/connections/types';
import { handleEmbedding } from '../../src/controllers/embeddingController';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });

const conn = (): Connection => ({
  id: 'c-oa', name: 'oa', providerType: 'openai', isActive: true,
  settings: { baseUrl: `${fake.url}/v1` }, credentials: { secret: 'sk-emb' },
  models: [{ modelId: 'text-embedding-3-small--oa', upstreamModel: 'text-embedding-3-small', displayName: null, family: 'openai', capabilities: ['embedding'], priced: true }],
});
const app = () => {
  const a = express();
  a.use(express.json());
  a.post('/v1/embeddings', (req: any, res, next) => {
    req.apiKeyInfo = { entitlement: { catalogId: 'c', catalogName: 'Overflow', mode: 'list', include: ['text-embedding-3-small--oa', 'text-embedding-3-small'] } };
    return handleEmbedding(req, res, next);
  });
  return a;
};

beforeEach(() => {
  fake.requests.length = 0;
  usageEvents.length = 0;
  createEmbedding.mockClear();
  connectionRegistry.setShadowed([]);
  connectionRegistry.setBackend({ fetch: async () => [conn()] });
});

describe('embeddings on a connection model', () => {
  it('an input array of 3 reaches the connection whole and returns 3 embeddings', async () => {
    fake.script([{ kind: 'json', body: { object: 'list', model: 'text-embedding-3-small', data: [0, 1, 2].map((i) => ({ object: 'embedding', index: i, embedding: [i] })), usage: { prompt_tokens: 12, total_tokens: 12 } } }]);
    const r = await request(app()).post('/v1/embeddings').send({ model: 'text-embedding-3-small--oa', input: ['a', 'b', 'c'], dimensions: 256 });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(3);
    expect(r.body.model).toBe('text-embedding-3-small--oa');
    const sent = JSON.parse(fake.requests[0].body);
    expect(sent).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b', 'c'], dimensions: 256 });
    expect(fake.requests[0].url).toBe('/v1/embeddings');
    expect(createEmbedding).not.toHaveBeenCalled();
  });

  it('usage event: prompt tokens as input, origin external', async () => {
    fake.script([{ kind: 'json', body: { object: 'list', data: [], usage: { prompt_tokens: 12, total_tokens: 12 } } }]);
    await request(app()).post('/v1/embeddings').send({ model: 'text-embedding-3-small--oa', input: 'a' });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ model: 'text-embedding-3-small--oa', status: 200, metrics: { inputTokens: 12, outputTokens: 0 } });
    expect(usageEvents[0].req.__externalUsage.connectionId).toBe('c-oa');
  });

  it('upstream 400 passes through redacted', async () => {
    fake.script([{ kind: 'status', status: 400, body: { error: { message: 'bad input for key sk-emb', code: 'invalid_input' } } }]);
    const r = await request(app()).post('/v1/embeddings').send({ model: 'text-embedding-3-small--oa', input: 'a' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('sk-emb');
    expect(usageEvents.map((e) => e.status)).toEqual([400]);
  });

  it('an SAP embedding model still calls sapAIService.createEmbedding', async () => {
    const r = await request(app()).post('/v1/embeddings').send({ model: 'text-embedding-3-small', input: 'a' });
    expect(r.status).toBe(200);
    expect(createEmbedding).toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });
});
