/**
 * Forced pseudonymization covers Claude Connection models on /anthropic/v1/messages (spec
 * 2026-10-23 §5.3): the provider receives the masked prompt, the streamed text reaches the client
 * unmasked, and a forced request whose hook chain would not run the plugin is refused with 503
 * `pseudonymization_hook_missing` before the provider is called.
 *
 * The controller, plugin executor, plugin loader, pseudonymization plugin and connection registry
 * are the REAL modules with the shipped hooks; the provider is a loopback fake.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
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
    getTimeout: () => 5000,
  };
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

jest.mock('../../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: jest.fn(async () => undefined) } }));
jest.mock('../../src/services/modelService', () => ({
  __esModule: true,
  default: { getModelDetails: async () => null, getAuthToken: async () => 'sap-token', modelSupportsStreaming: () => true },
}));
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: () => {}, isPayloadLoggingEnabled: () => false }));
jest.mock('../../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { connectionRegistry } from '../../src/connections/connectionRegistry';
import type { Connection } from '../../src/connections/types';
import { handleMessages } from '../../src/controllers/anthropicController';
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
  id: 'c-an', name: 'an', providerType: 'anthropic', isActive: true,
  settings: { baseUrl: fake.url }, credentials: { secret: 'sk-ant-test' },
  models: [{ modelId: 'claude-sonnet-4-5--an', upstreamModel: 'claude-sonnet-4-5', displayName: null, family: 'claude', capabilities: ['chat'], priced: true }],
});

const app = () => {
  const a = express();
  a.use(express.json());
  a.post('/v1/messages', (req: any, res, next) => {
    req.apiKeyInfo = { entitlement: { catalogId: 'c', catalogName: 'Overflow', mode: 'list', include: ['claude-sonnet-4-5--an'] } };
    return handleMessages(req, res, next);
  });
  return a;
};

const BODY = { model: 'claude-sonnet-4-5--an', max_tokens: 50, messages: [{ role: 'user', content: TEXT }] };
const ev = (type: string, extra: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const sentText = () => fake.requests.map((r) => r.body).join('\n');

/** The placeholder the plugin put into the prompt it sent upstream. */
const placeholderSent = () => /MASKED_EMAIL\w*/.exec(sentText())?.[0] ?? 'MASKED_EMAIL_1';

function forcedConfig() {
  const hooks = JSON.parse(JSON.stringify(shippedHooks));
  for (const entry of Object.values(hooks.defaults) as any[]) {
    if (entry?.pseudonymization) entry.pseudonymization.enabled = true;
  }
  return { hooks, models: { overrides: {} as Record<string, any> }, observability: {} };
}

beforeEach(() => {
  mockConfig.api_config = forcedConfig();
  (global as any).matcherCache?.clear?.();
  fake.requests.length = 0;
  connectionRegistry.setShadowed([]);
  connectionRegistry.setBackend({ fetch: async () => [connection()] });
  connectionRegistry.markStale();
});

describe('/anthropic/v1/messages on a Claude Connection model with pseudonymization forced', () => {
  it('the provider receives the masked prompt and the streamed text reaches the client unmasked', async () => {
    // The placeholder the plugin picks is deterministic for one email; learn it from a plain run first.
    fake.script([{ kind: 'json', body: { id: 'm', type: 'message', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }]);
    const plain = await request(app()).post('/v1/messages').send(BODY);
    expect(plain.status).toBe(200);
    expect(sentText()).not.toContain(EMAIL);
    expect(sentText()).toMatch(/MASKED_EMAIL/);
    const placeholder = placeholderSent();

    fake.requests.length = 0;
    fake.script([{ kind: 'sse', raw: true, frames: [
      ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `Sure, writing to ${placeholder} now.` } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
      ev('message_stop'),
    ] }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(r.status).toBe(200);
    expect(sentText()).not.toContain(EMAIL);
    expect(r.text).toContain(`Sure, writing to ${EMAIL} now.`);
    expect(r.text).not.toContain('MASKED_EMAIL');
  });

  it('a hook chain without the plugin: 503 pseudonymization_hook_missing, the provider is never called', async () => {
    for (const s of ['invoke', 'invoke-with-response-stream']) mockConfig.api_config.hooks.defaults.anthropic[s] = [];
    const r = await request(app()).post('/v1/messages').send(BODY);
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toContain('pseudonymization_hook_missing');
    expect(fake.requests).toHaveLength(0);
  });
});
