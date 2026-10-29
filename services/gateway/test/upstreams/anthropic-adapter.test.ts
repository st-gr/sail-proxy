/**
 * The `anthropic` connection adapter: x-api-key, anthropic-version and the client's anthropic-beta
 * on /v1/messages, a paginated model list, and a connection test that answers a reason code only.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: jest.fn() }));
jest.mock('../../src/services/configService', () => ({ __esModule: true, default: { getTimeout: () => 5000 }, getTimeout: () => 5000 }));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { adapterFor } from '../../src/upstreams';
import { callUpstream, sendUpstreamError } from '../../src/upstreams/upstreamCall';
import type { Connection } from '../../src/connections/types';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => { fake.requests.length = 0; });

const anthropic = (settings: Record<string, string | null> = {}, credentials: Connection['credentials'] = { secret: 'sk-ant-test' }): Connection => ({
  id: 'c-an', name: 'an', providerType: 'anthropic', isActive: true,
  settings: { baseUrl: `${fake.url}/`, ...settings },
  credentials, models: [],
});

describe('anthropic adapter', () => {
  it('buildRequest sets key, version and beta', async () => {
    const adapter = adapterFor(anthropic())!;
    const clientBody = { model: 'claude-x--an', max_tokens: 1, messages: [] };
    const request = await adapter.buildRequest('messages', clientBody, 'claude-sonnet-4', { 'anthropic-beta': 'tools-2024-04-04' });
    expect(request.url).toBe(`${fake.url}/v1/messages`);
    expect(request.headers['x-api-key']).toBe('sk-ant-test');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.headers['anthropic-beta']).toBe('tools-2024-04-04');
    expect(request.body.model).toBe('claude-sonnet-4');
    expect(clientBody.model).toBe('claude-x--an');

    const joined = await adapter.buildRequest('messages', clientBody, 'm', { 'anthropic-beta': ['a', 'b'] });
    expect(joined.headers['anthropic-beta']).toBe('a,b');
    expect(await adapter.buildRequest('messages', clientBody, 'm', {})).not.toHaveProperty('headers.anthropic-beta');
    expect((await adapter.buildRequest('messages', clientBody, 'm')).headers).not.toHaveProperty('anthropic-beta');

    const pinned = await adapterFor(anthropic({ anthropicVersion: '2023-01-01' }))!.buildRequest('messages', clientBody, 'm');
    expect(pinned.headers['anthropic-version']).toBe('2023-01-01');
  });

  it('buildRequest refuses other routes', async () => {
    await expect(adapterFor(anthropic())!.buildRequest('chat', {}, 'm')).rejects.toThrow();
  });

  it('listModels follows pagination', async () => {
    fake.script([
      { kind: 'json', body: { data: [{ id: 'a' }], has_more: true, last_id: 'a' } },
      { kind: 'json', body: { data: [{ id: 'b' }], has_more: false } },
    ]);
    expect(await adapterFor(anthropic())!.listModels()).toEqual(['a', 'b']);
    expect(fake.requests[0].url).toBe('/v1/models?limit=1000');
    expect(fake.requests[1].url).toContain('after_id=a');
    expect(fake.requests[0].headers['x-api-key']).toBe('sk-ant-test');
  });

  it('listModels stops when the cursor repeats', async () => {
    fake.script([{ kind: 'json', body: { data: [{ id: 'a' }], has_more: true, last_id: 'a' } }]);
    expect(await adapterFor(anthropic())!.listModels()).toEqual(['a']);
  });

  it('testConnection maps statuses', async () => {
    const adapter = adapterFor(anthropic())!;
    fake.script([{ kind: 'json', body: { data: [] } }]);
    expect(await adapter.testConnection()).toEqual({ ok: true });
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: '/v1/models?limit=1' });
    fake.script([{ kind: 'status', status: 401 }]);
    expect(await adapter.testConnection()).toEqual({ ok: false, error: { reason: 'unauthorized', status: 401 } });
  });

  it('adapterFor serves anthropic, and secrets() holds the key', () => {
    expect(adapterFor(anthropic())).not.toBeNull();
    expect(adapterFor(anthropic({}, null))).toBeNull();
    expect(adapterFor(anthropic())!.secrets()).toEqual(['sk-ant-test']);
  });

  it('a refused key is redacted', async () => {
    const adapter = adapterFor(anthropic())!;
    fake.script([{ kind: 'status', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-test' } } }]);
    const app = express();
    app.post('/', async (r: any, res) => {
      try { await callUpstream(await adapter.buildRequest('messages', { model: 'x' }, 'm'), { stream: false }); res.json({}); } catch (e) { await sendUpstreamError(r, res, e, adapter, 'anthropic'); }
    });
    const r = await request(app).post('/');
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).toContain('[REDACTED]');
    expect(JSON.stringify(r.body)).not.toContain('sk-ant-test');
  });
});
