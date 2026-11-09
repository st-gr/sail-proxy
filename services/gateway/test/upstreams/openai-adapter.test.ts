/**
 * The `openai` connection adapter (spec 2026-10-23 §5.2): near passthrough, Bearer plus the optional
 * organization and project headers, the client's model id swapped for the upstream one. The
 * connection test answers a reason code, never the upstream's text.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() }) }));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { adapterFor } from '../../src/upstreams';
import type { Connection } from '../../src/connections/types';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => { fake.requests.length = 0; });

const openai = (settings: Record<string, string | null> = {}, credentials: Connection['credentials'] = { secret: 'sk-test' }): Connection => ({
  id: 'c-oa', name: 'oa', providerType: 'openai', isActive: true,
  settings: { baseUrl: `${fake.url}/v1/`, organization: null, project: null, ...settings },
  credentials, models: [],
});

describe('openai adapter', () => {
  it('openai chat request: url, bearer, org/project headers, model swapped', async () => {
    const adapter = adapterFor(openai({ organization: 'org-1', project: 'proj-1' }))!;
    const clientBody = { model: 'gpt-4o-mini--oa', messages: [] };
    const request = await adapter.buildRequest('chat', clientBody, 'gpt-4o-mini');
    expect(request.url).toBe(`${fake.url}/v1/chat/completions`);
    expect(request.headers.Authorization).toBe('Bearer sk-test');
    expect(request.headers['OpenAI-Organization']).toBe('org-1');
    expect(request.headers['OpenAI-Project']).toBe('proj-1');
    expect(request.body.model).toBe('gpt-4o-mini');
    expect(clientBody.model).toBe('gpt-4o-mini--oa');
  });

  it('leaves out the organization and project headers when unset; responses and embeddings urls', async () => {
    const adapter = adapterFor(openai())!;
    const chat = await adapter.buildRequest('chat', { model: 'x' }, 'gpt-4o');
    expect(chat.headers).not.toHaveProperty('OpenAI-Organization');
    expect(chat.headers).not.toHaveProperty('OpenAI-Project');
    expect((await adapter.buildRequest('responses', { model: 'x' }, 'gpt-4o')).url).toBe(`${fake.url}/v1/responses`);
    expect((await adapter.buildRequest('embeddings', { model: 'x' }, 'text-embedding-3-small')).url).toBe(`${fake.url}/v1/embeddings`);
  });

  it('testConnection maps statuses and never echoes the upstream message', async () => {
    const adapter = adapterFor(openai())!;
    fake.script([{ kind: 'status', status: 401, body: { error: { message: 'Incorrect API key provided: sk-test', code: 'invalid_api_key' } } }]);
    const unauthorized = await adapter.testConnection();
    expect(unauthorized).toEqual({ ok: false, error: { reason: 'unauthorized', status: 401 } });
    expect(JSON.stringify(unauthorized)).not.toContain('sk-test');
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
    expect(fake.requests[0].headers.authorization).toBe('Bearer sk-test');

    fake.script([{ kind: 'status', status: 500, body: { error: { message: 'boom', code: 'server_error' } } }]);
    expect(await adapter.testConnection()).toEqual({ ok: false, error: { reason: 'upstream_error', status: 500, code: 'server_error' } });
    fake.script([{ kind: 'status', status: 403 }]);
    expect(await adapter.testConnection()).toEqual({ ok: false, error: { reason: 'forbidden', status: 403 } });
    fake.script([{ kind: 'status', status: 404 }]);
    expect(await adapter.testConnection()).toEqual({ ok: false, error: { reason: 'not_found', status: 404 } });
    fake.script([{ kind: 'json', body: { data: [] } }]);
    expect(await adapter.testConnection()).toEqual({ ok: true });
  });

  it('testConnection: a closed port is unreachable', async () => {
    const adapter = adapterFor(openai({ baseUrl: 'http://127.0.0.1:1/v1' }))!;
    expect(await adapter.testConnection()).toEqual({ ok: false, error: { reason: 'unreachable' } });
  });

  it('listModels returns the ids', async () => {
    fake.script([{ kind: 'json', body: { data: [{ id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }] } }]);
    expect(await adapterFor(openai())!.listModels()).toEqual(['gpt-4o-mini', 'text-embedding-3-small']);
  });

  it('adapterFor: null for sap-ai-core and missing credentials', () => {
    expect(adapterFor(openai({}, null))).toBeNull();
    expect(adapterFor({ ...openai(), providerType: 'sap-ai-core' })).toBeNull();
  });

  it('secrets() holds the secret', () => {
    expect(adapterFor(openai())!.secrets()).toEqual(['sk-test']);
  });
});
