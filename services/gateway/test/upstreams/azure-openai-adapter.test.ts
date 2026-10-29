/**
 * The `azure-openai` connection adapter (spec 2026-10-23 §5.2): the v1 API or the per-deployment
 * API with an api-version, the deployment name as the model, an `api-key` header or an Entra bearer
 * token (client-credential flow, cached until five minutes before expiry).
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() }) }));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { adapterFor } from '../../src/upstreams';
import { clearEntraTokenCache } from '../../src/upstreams/azureEntraToken';
import type { Connection } from '../../src/connections/types';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => { fake.requests.length = 0; clearEntraTokenCache(); process.env.AZURE_AUTHORITY_HOST = fake.url; });
afterEach(() => { delete process.env.AZURE_AUTHORITY_HOST; });

const azure = (settings: Record<string, string | null> = {}, secret = 's3cret'): Connection => ({
  id: 'c-az', name: 'az', providerType: 'azure-openai', isActive: true,
  settings: { endpoint: `${fake.url}/`, apiMode: 'v1', apiVersion: null, authMode: 'api-key', tenantId: null, clientId: null, ...settings },
  credentials: { secret }, models: [],
});
const entra = (extra: Record<string, string | null> = {}) => azure({ authMode: 'entra-client-secret', tenantId: 'tenant-1', clientId: 'client-1', ...extra });

describe('azure-openai adapter', () => {
  it('azure v1 api-key', async () => {
    const adapter = adapterFor(azure())!;
    const chat = await adapter.buildRequest('chat', { model: 'gpt-4o--az', messages: [] }, 'my-deployment');
    expect(chat.url).toBe(`${fake.url}/openai/v1/chat/completions`);
    expect(chat.headers['api-key']).toBe('s3cret');
    expect(chat.headers).not.toHaveProperty('Authorization');
    expect(chat.body.model).toBe('my-deployment');
    expect((await adapter.buildRequest('responses', {}, 'my-deployment')).url).toBe(`${fake.url}/openai/v1/responses`);
    expect((await adapter.buildRequest('embeddings', {}, 'emb-dep')).url).toBe(`${fake.url}/openai/v1/embeddings`);
  });

  it('azure deployments mode puts the deployment in the path and the api-version in the query', async () => {
    const adapter = adapterFor(azure({ apiMode: 'deployments', apiVersion: '2024-10-21' }))!;
    expect((await adapter.buildRequest('chat', {}, 'my dep')).url)
      .toBe(`${fake.url}/openai/deployments/my%20dep/chat/completions?api-version=2024-10-21`);
    expect((await adapter.buildRequest('embeddings', {}, 'emb')).url)
      .toBe(`${fake.url}/openai/deployments/emb/embeddings?api-version=2024-10-21`);
    const responses = await adapter.buildRequest('responses', {}, 'my-deployment');
    expect(responses.url).toBe(`${fake.url}/openai/responses?api-version=2024-10-21`);
    expect(responses.body.model).toBe('my-deployment');
  });

  it('azure entra: one token request, cached, form fields', async () => {
    fake.route('/tenant-1/oauth2/v2.0/token', [{ kind: 'json', body: { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' } }]);
    const adapter = adapterFor(entra())!;
    const first = await adapter.buildRequest('chat', {}, 'dep');
    const second = await adapter.buildRequest('chat', {}, 'dep');
    const tokenCalls = fake.requests.filter((r) => r.url === '/tenant-1/oauth2/v2.0/token');
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(tokenCalls[0].body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials', client_id: 'client-1', client_secret: 's3cret',
      scope: 'https://cognitiveservices.azure.com/.default',
    });
    expect(first.headers.Authorization).toBe('Bearer tok-1');
    expect(second.headers.Authorization).toBe('Bearer tok-1');
    expect(first.headers).not.toHaveProperty('api-key');
  });

  it('a token inside the five-minute margin is fetched again', async () => {
    fake.route('/tenant-1/oauth2/v2.0/token', [{ kind: 'json', body: { access_token: 'tok-short', expires_in: 200 } }]);
    const adapter = adapterFor(entra())!;
    await adapter.buildRequest('chat', {}, 'dep');
    await adapter.buildRequest('chat', {}, 'dep');
    expect(fake.requests.filter((r) => r.url === '/tenant-1/oauth2/v2.0/token')).toHaveLength(2);
  });

  it('a rotated secret fetches a new token', async () => {
    fake.route('/tenant-1/oauth2/v2.0/token', [{ kind: 'json', body: { access_token: 'tok-1', expires_in: 3600 } }]);
    await adapterFor(entra())!.buildRequest('chat', {}, 'dep');
    await adapterFor({ ...entra(), credentials: { secret: 'rotated' } })!.buildRequest('chat', {}, 'dep');
    expect(fake.requests.filter((r) => r.url === '/tenant-1/oauth2/v2.0/token')).toHaveLength(2);
  });

  it('a refused token request fails buildRequest without echoing the secret', async () => {
    fake.route('/tenant-1/oauth2/v2.0/token', [{ kind: 'status', status: 401, body: { error: 'invalid_client', error_description: 'bad secret s3cret' } }]);
    const error = await adapterFor(entra())!.buildRequest('chat', {}, 'dep').catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain('s3cret');
    expect(error.status).toBe(401);
  });

  it('testConnection: v1 models, and deployments mode with its api-version', async () => {
    fake.script([{ kind: 'json', body: { data: [] } }]);
    expect(await adapterFor(azure())!.testConnection()).toEqual({ ok: true });
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: '/openai/v1/models' });
    expect(fake.requests[0].headers['api-key']).toBe('s3cret');
    await adapterFor(azure({ apiMode: 'deployments', apiVersion: '2024-10-21' }))!.testConnection();
    expect(fake.requests[1].url).toBe('/openai/models?api-version=2024-10-21');
  });

  it('testConnection: a refused Entra token is unauthorized', async () => {
    fake.route('/tenant-1/oauth2/v2.0/token', [{ kind: 'status', status: 401, body: { error: 'invalid_client' } }]);
    expect(await adapterFor(entra())!.testConnection()).toEqual({ ok: false, error: { reason: 'unauthorized', status: 401 } });
  });

  it('listModels: the deployments list; a 404 (retired on newer resources) is empty', async () => {
    fake.script([{ kind: 'json', body: { data: [{ id: 'gpt-4o-prod' }, { id: 'emb' }] } }]);
    expect(await adapterFor(azure())!.listModels()).toEqual(['gpt-4o-prod', 'emb']);
    expect(fake.requests[0].url).toBe('/openai/deployments?api-version=2022-12-01');
    fake.script([{ kind: 'status', status: 404 }]);
    expect(await adapterFor(azure())!.listModels()).toEqual([]);
  });

  it('secrets() holds the secret and, after an entra call, the token', async () => {
    fake.route('/tenant-1/oauth2/v2.0/token', [{ kind: 'json', body: { access_token: 'tok-9', expires_in: 3600 } }]);
    const adapter = adapterFor(entra())!;
    expect(adapter.secrets()).toEqual(['s3cret']);
    await adapter.buildRequest('chat', {}, 'dep');
    expect(adapter.secrets()).toEqual(['s3cret', 'tok-9']);
  });
});
