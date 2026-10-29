/**
 * Forced pseudonymization covers Connection models (spec 2026-10-23 §5.3): their traffic leaves the
 * SAP tenant, so on /openai/v1/chat/completions and /openai/v1/responses the provider receives the
 * masked prompt, and a forced request whose hook chain would not run the plugin is refused with 503
 * `pseudonymization_hook_missing` before the provider is called.
 *
 * The controllers, plugin executor, plugin loader, pseudonymization plugin and connection registry
 * are the REAL modules with the shipped hooks; the provider is a loopback fake.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }),
}));

const shippedHooks = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'api_config.json'), 'utf-8'),
).api_config.hooks;

const mockConfig: any = { api_config: {} };
jest.mock('../../src/services/configService', () => {
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
    getSupportsResponsesApi: () => undefined,
    getTimeout: () => 5000,
  };
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

jest.mock('../../src/services/modelService', () => ({
  __esModule: true,
  default: { getModelDetails: async () => null, getAuthToken: async () => 'sap-token', modelSupportsStreaming: () => true },
}));
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: () => {} }));
jest.mock('../../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { connectionRegistry } from '../../src/connections/connectionRegistry';
import type { Connection } from '../../src/connections/types';
import { handleChatCompletion } from '../../src/controllers/openaiController';
import { handleResponses } from '../../src/controllers/responsesController';
import pseudonymizationRules = require('../../src/plugins/pseudonymization/index');

const EMAIL = 'jane.roe@example.org';
const TEXT = `Please email ${EMAIL} about the invoice.`;

let fake: FakeProviderServer;
beforeAll(async () => {
  fake = await startFakeProviderServer();
  (global as any).pluginRegistry = {};
  (pseudonymizationRules as any[]).forEach((rule: any, i: number) => {
    (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule;
  });
});
afterAll(async () => { await fake.close(); });

const connection = (): Connection => ({
  id: 'c-oa', name: 'oa', providerType: 'openai', isActive: true,
  settings: { baseUrl: `${fake.url}/v1` }, credentials: { secret: 'sk-test' },
  models: [
    { modelId: 'gpt-4o--oa', upstreamModel: 'gpt-4o', displayName: null, family: 'openai', capabilities: ['chat'], priced: true },
    { modelId: 'gpt-5--oa', upstreamModel: 'gpt-5', displayName: null, family: 'openai', capabilities: ['chat'], priced: true },
  ],
});

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), { statusCode: 200, body: undefined, headers: {}, headersSent: false, writableEnded: false });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.getHeader = (k: string) => r.headers[k];
  r.end = () => { r.writableEnded = true; };
  return r;
}

function mockReq(body: any, url: string) {
  const r: any = new EventEmitter();
  Object.assign(r, { body, headers: { 'content-type': 'application/json' }, query: {}, params: {}, originalUrl: url, path: url, method: 'POST' });
  return r;
}

interface Route { name: string; subPaths: string[]; providerPath: string; run: () => Promise<any> }
const ROUTES: Route[] = [
  {
    name: 'chat completions', subPaths: ['invoke', 'invoke-with-response-stream'], providerPath: '/chat/completions',
    run: async () => {
      const res = mockRes();
      await handleChatCompletion(mockReq({ model: 'gpt-4o--oa', messages: [{ role: 'user', content: TEXT }] }, '/openai/v1/chat/completions'), res, jest.fn() as any);
      return res;
    },
  },
  {
    name: '/responses', subPaths: ['responses', 'responses-stream'], providerPath: '/responses',
    run: async () => {
      const res = mockRes();
      await handleResponses(mockReq({ model: 'gpt-5--oa', input: TEXT }, '/openai/v1/responses'), res, jest.fn() as any);
      return res;
    },
  },
];

/** The shipped hooks with every endpoint's force flag on. */
function forcedConfig() {
  const hooks = JSON.parse(JSON.stringify(shippedHooks));
  for (const entry of Object.values(hooks.defaults) as any[]) {
    if (entry?.pseudonymization) entry.pseudonymization.enabled = true;
  }
  return { hooks, models: { overrides: {} as Record<string, any> }, observability: {} };
}

const sentText = () => fake.requests.map((r) => r.body).join('\n');

beforeEach(() => {
  mockConfig.api_config = forcedConfig();
  (global as any).matcherCache?.clear?.();
  fake.requests.length = 0;
  fake.script([{ kind: 'json', body: {
    id: 'x', object: 'chat.completion', output: [], choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
  } }]);
  connectionRegistry.setShadowed([]);
  connectionRegistry.setBackend({ fetch: async () => [connection()] });
  connectionRegistry.markStale();
});

describe.each(ROUTES)('$name on a Connection model with pseudonymization forced', (route) => {
  it('the provider receives the masked prompt', async () => {
    const res = await route.run();
    expect(res.statusCode).toBe(200);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url).toContain(route.providerPath);
    expect(sentText()).not.toContain(EMAIL);
    expect(sentText()).toMatch(/MASKED_EMAIL/);
  });

  it('a hook chain without the plugin: 503 pseudonymization_hook_missing, the provider is never called', async () => {
    for (const s of route.subPaths) mockConfig.api_config.hooks.defaults.openai[s] = [];
    const res = await route.run();
    expect(res.statusCode).toBe(503);
    expect(res.body?.error?.code).toBe('pseudonymization_hook_missing');
    expect(fake.requests).toHaveLength(0);
  });
});
