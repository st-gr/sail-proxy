/**
 * The orchestration replay paths on /openai/v1/chat/completions unmask before they replay: a model
 * listed in emulate_streaming_for_models, and both "streaming not supported" fallbacks, answer a
 * streaming client by replaying SAP's one-piece answer in ~15-character chunks. That answer is masked;
 * replaying it raw split every placeholder across chunks and sent it to the client masked (review
 * finding S6, 2026-11-08). The shipped hooks force pseudonymization on the openai endpoint.
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve({ id: m, owned_by: 'anthropic', provider: 'anthropic' }),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

const shippedHooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8')).api_config.hooks;
const mockConfig: any = { api_config: {} };
let mockEmulate = false;
jest.mock('../src/services/configService', () => {
  const svc = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: (modelId: string, subpath: string, endpoint?: string) => {
      const override = mockConfig.api_config.models?.overrides?.[modelId]?.hooks?.[subpath];
      if (override) return override;
      return endpoint ? mockConfig.api_config.hooks?.defaults?.[endpoint]?.[subpath] || null : null;
    },
    shouldEmulateStreaming: () => mockEmulate,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getOpenAIDeploymentApiVersion: () => undefined,
  };
  return { __esModule: true, default: svc, ...svc };
});
jest.mock('../src/utils/modelUtils', () => ({
  mapModelParameters: (p: Record<string, any>) => ({ ...p }),
  getDefaultParameters: () => ({}),
}));
jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {} }));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0 }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

const tokenIn = (body: any) => (JSON.stringify(body).match(/MASKED_[A-Z_]+_[0-9a-f]+/) || ['NO_TOKEN'])[0];
const sapAnswer = (payload: any) => ({
  final_result: {
    id: 'chatcmpl-s', object: 'chat.completion', created: 1, model: 'anthropic--claude-4-opus',
    choices: [{ index: 0, message: { role: 'assistant', content: `I will write to ${tokenIn(payload)} today.` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  },
});
let mockStreamMode: 'emulated' | 'not-supported' = 'emulated';
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    streamChatCompletion: async (payload: any, onChunk: any) => {
      if (mockStreamMode === 'not-supported') throw Object.assign(new Error('Streaming not supported for this model'), { streamingNotSupported: true });
      await onChunk({ nonStreamingResponse: sapAnswer(payload), useEmulatedStreaming: true });
    },
    completeChat: async (payload: any) => sapAnswer(payload),
  },
}));

import { handleChatCompletion } from '../src/controllers/openaiController';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');

const EMAIL = 'jane.roe@example.org';
function mockRes() {
  const r: any = Object.assign(new EventEmitter(), { statusCode: 200, body: undefined, headers: {}, writes: [] as string[], writable: true, writableEnded: false, headersSent: false });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => { r.headersSent = true; r.writes.push(String(s)); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}
function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body; r.headers = { 'content-type': 'application/json' }; r.query = {};
  return r;
}
const textOf = (res: any) => res.writes.join('').split('\n\n').filter((b: string) => b.startsWith('data: {'))
  .map((b: string) => JSON.parse(b.slice(6)).choices?.[0]?.delta?.content ?? '').join('');
async function drive() {
  const res = mockRes();
  await handleChatCompletion(mockReq({ model: 'anthropic--claude-4-opus', stream: true, messages: [{ role: 'user', content: `Please email ${EMAIL}.` }] }), res, jest.fn() as any);
  for (let i = 0; i < 400 && !res.writableEnded; i++) await new Promise((r) => setTimeout(r, 5));
  return res;
}

describe('orchestration replays are unmasked before they are written', () => {
  beforeAll(() => {
    (global as any).pluginRegistry = {};
    (pseudonymizationRules as any[]).forEach((rule: any, i: number) => { (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule; });
  });
  beforeEach(() => {
    mockConfig.api_config = { hooks: JSON.parse(JSON.stringify(shippedHooks)), models: { overrides: {} }, observability: {} };
    (global as any).matcherCache?.clear?.();
  });

  it('a model in emulate_streaming_for_models', async () => {
    mockEmulate = true; mockStreamMode = 'emulated';
    const res = await drive();
    expect(textOf(res)).toBe(`I will write to ${EMAIL} today.`);
    expect(res.writes.join('')).not.toMatch(/MASKED_/);
  });

  it('the "streaming not supported" fallback without emulation', async () => {
    mockEmulate = false; mockStreamMode = 'not-supported';
    const res = await drive();
    expect(textOf(res)).toBe(`I will write to ${EMAIL} today.`);
    expect(res.writes.join('')).not.toMatch(/MASKED_/);
  });

  it('the "streaming not supported" fallback with emulation configured', async () => {
    mockEmulate = true; mockStreamMode = 'not-supported';
    const res = await drive();
    expect(textOf(res)).toBe(`I will write to ${EMAIL} today.`);
    expect(res.writes.join('')).not.toMatch(/MASKED_/);
  });
});
