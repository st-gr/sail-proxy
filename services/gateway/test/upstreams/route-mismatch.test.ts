/**
 * Every inference route that cannot serve a Connection model refuses it (spec 2026-10-23 §5.3,
 * §5.4) instead of handing it to SAP: /anthropic answers 400 for an OpenAI-family model (a
 * Claude-family one is served by its connection, see messages-dispatch.test.ts), /aws-bedrock and
 * /google answer 400.
 * The image, SAP-RPT and realtime routes resolve an SAP deployment before anything else, which a
 * Connection model never has, so they answer 404 without new code: pinned here on that resolver.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: jest.fn(async () => undefined) } }));

const sapCalls: string[] = [];
const getModelDetails = jest.fn(async (id: string) => { sapCalls.push(`details:${id}`); return null; });
jest.mock('../../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (id: string) => getModelDetails(id),
    getModels: async () => { sapCalls.push('models'); return { object: 'list', data: [] }; },
    getAuthToken: async () => { sapCalls.push('token'); return 'sap-token'; },
    modelSupportsStreaming: () => true,
  },
  getModels: async () => { sapCalls.push('models'); return { object: 'list', data: [] }; },
}));
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: () => undefined,
    getTimeout: () => 5000,
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    isPseudonymizationForced: () => false,
    getConfig: () => ({}),
    get: () => undefined,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
  },
}));
jest.mock('axios', () => {
  const fail = async (url: string) => { sapCalls.push(`axios:${url}`); throw new Error('no upstream in this test'); };
  return { __esModule: true, default: { post: fail, get: fail, request: fail, create: () => ({ post: fail, get: fail, request: fail }) } };
});
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: () => {}, isPayloadLoggingEnabled: () => false }));
jest.mock('../../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { connectionRegistry } from '../../src/connections/connectionRegistry';
import type { Connection } from '../../src/connections/types';
import { externalModelEntry } from '../../src/connections/mergeExternalModels';
import { resolveDeployedTwin } from '../../src/utils/deployedTwin';
import { handleMessages } from '../../src/controllers/anthropicController';
import { handleBedrockRequest } from '../../src/controllers/awsBedrockController';
import { handleGemini } from '../../src/controllers/googleController';

const openaiConn = (): Connection => ({
  id: 'c-oa', name: 'oa', providerType: 'openai', isActive: true, settings: { baseUrl: 'http://127.0.0.1:1/v1' }, credentials: { secret: 'sk-x' },
  models: [{ modelId: 'gpt-4o-mini--oa', upstreamModel: 'gpt-4o-mini', displayName: null, family: 'openai', capabilities: ['chat'], priced: true }],
});
const anthropicConn = (): Connection => ({
  id: 'c-an', name: 'an', providerType: 'anthropic', isActive: true, settings: { baseUrl: 'http://127.0.0.1:1' }, credentials: { secret: 'sk-ant-x' },
  models: [{ modelId: 'claude-sonnet-4-5--an', upstreamModel: 'claude-sonnet-4-5', displayName: null, family: 'claude', capabilities: ['chat'], priced: true }],
});
const ENTITLED = { catalogId: 'c', catalogName: 'Overflow', mode: 'list', include: ['gpt-4o-mini--oa', 'claude-sonnet-4-5--an'] };

const app = (path: string, handler: any) => {
  const a = express();
  a.use(express.json());
  a.post(path, (req: any, res, next) => { req.apiKeyInfo = { entitlement: ENTITLED }; return handler(req, res, next); });
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: { message: err.message } }));
  return a;
};

beforeEach(() => {
  sapCalls.length = 0;
  connectionRegistry.setShadowed([]);
  connectionRegistry.setBackend({ fetch: async () => [openaiConn(), anthropicConn()] });
});

describe('routes that cannot serve a connection model refuse it', () => {
  it('/anthropic/v1/messages: an OpenAI-family model is 400 in the Anthropic shape, naming the chat route', async () => {
    const r = await request(app('/v1/messages', handleMessages)).post('/v1/messages')
      .send({ model: 'gpt-4o-mini--oa', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(400);
    expect(r.body.type).toBe('error');
    expect(r.body.error.message).toContain('/openai/v1/chat/completions');
    expect(sapCalls).toEqual([]);
  });

  it('/anthropic/v1/messages: a Claude-family connection model goes to its connection, not SAP', async () => {
    const r = await request(app('/v1/messages', handleMessages)).post('/v1/messages')
      .send({ model: 'claude-sonnet-4-5--an', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    // The connection points at an unreachable port: the request was dispatched there (axios is stubbed
    // to fail and records the URL), and it is not the 503 placeholder of the era before B2.
    expect(sapCalls).toEqual(['axios:http://127.0.0.1:1/v1/messages']);
    expect(r.body.error?.message ?? '').not.toContain('cannot be served on this route yet');
  });

  it('/aws-bedrock invoke: 400 model_route_mismatch', async () => {
    const r = await request(app('/model/:modelId/:subpath', handleBedrockRequest)).post('/model/gpt-4o-mini--oa/invoke')
      .send({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('model_route_mismatch');
    expect(sapCalls).toEqual([]);
  });

  it('/google generateContent: 400 in the Gemini envelope', async () => {
    const r = await request(app('/v1beta/models/:modelAndMethod', handleGemini)).post('/v1beta/models/gpt-4o-mini--oa:generateContent')
      .send({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 400, status: 'INVALID_ARGUMENT' });
    expect(sapCalls).toEqual([]);
  });

  it('images, SAP-RPT and realtime: a connection model has no SAP deployment twin, so they answer 404 before any SAP call', async () => {
    const entry = externalModelEntry(openaiConn(), openaiConn().models[0]);
    const twin = await resolveDeployedTwin('gpt-4o-mini--oa', async (id) => (id === 'gpt-4o-mini--oa' ? entry : null));
    expect(twin).toBeNull();
  });
});
