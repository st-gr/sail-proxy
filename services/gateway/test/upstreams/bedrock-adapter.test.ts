/**
 * The `bedrock` connection adapter: Claude through the Bedrock invoke API, signed with SigV4 or a
 * Bedrock API key, a merged model list (foundation models and inference profiles), a connection test.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: jest.fn() }));
jest.mock('../../src/services/configService', () => {
  const service = {
    getTimeout: () => 5000,
    getSupportedBetaHeaders: () => ['context-1m-2025-08-07', 'interleaved-thinking-2025-05-14'],
    getExcludedBetaHeaders: () => ['interleaved-thinking-2025-05-14'],
  };
  return { __esModule: true, default: service, getTimeout: () => 5000 };
});

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { adapterFor } from '../../src/upstreams';
import { callUpstream, sendUpstreamError } from '../../src/upstreams/upstreamCall';
import { deriveSigningKey, parseSigV4AuthHeader, verifySigV4Request } from '../../src/utils/sigv4Verifier';
import type { Connection } from '../../src/connections/types';

// AWS's documented example credentials - not real.
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const PROFILE = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => { fake.requests.length = 0; });

const bedrock = (settings: Record<string, string | null> = {}, credentials: Connection['credentials'] = { secret: SECRET }): Connection => ({
  id: 'c-bd', name: 'bd', providerType: 'bedrock', isActive: true,
  settings: { region: 'us-east-1', runtimeEndpoint: fake.url, authMode: 'access-key', accessKeyId: 'AKIDEXAMPLE', ...settings },
  credentials, models: [],
});

describe('bedrock adapter', () => {
  it('invoke URL encodes the profile id', async () => {
    const adapter = adapterFor(bedrock())!;
    const plain = await adapter.buildRequest('messages', { model: 'x', max_tokens: 1, messages: [] }, PROFILE);
    expect(plain.url).toBe(`${fake.url}/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke`);
    const streaming = await adapter.buildRequest('messages', { model: 'x', stream: true, max_tokens: 1, messages: [] }, PROFILE);
    expect(streaming.url).toBe(`${fake.url}/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream`);
    await expect(adapter.buildRequest('chat', {}, PROFILE)).rejects.toThrow();
  });

  it('Accept matches the invoke flavour, and the fake server receives it', async () => {
    for (const mode of ['access-key', 'bearer']) {
      const adapter = adapterFor(bedrock({ authMode: mode }))!;
      const plain = await adapter.buildRequest('messages', { max_tokens: 1, messages: [] }, PROFILE);
      expect(plain.headers.Accept).toBe('application/json');
      const streaming = await adapter.buildRequest('messages', { stream: true, max_tokens: 1, messages: [] }, PROFILE);
      expect(streaming.headers.Accept).toBe('application/vnd.amazon.eventstream');
    }
    fake.route('/model/', [{ kind: 'json', body: {} }]);
    await callUpstream(await adapterFor(bedrock())!.buildRequest('messages', { max_tokens: 1, messages: [] }, PROFILE), { stream: false });
    expect(fake.requests[0].headers.accept).toBe('application/json');
  });

  it('body is Bedrock-shaped', async () => {
    const adapter = adapterFor(bedrock())!;
    const clientBody = { model: 'x--bd', stream: true, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] };
    const built = await adapter.buildRequest('messages', clientBody, PROFILE);
    expect(typeof built.body).toBe('string');
    expect(JSON.parse(built.body)).toEqual({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    expect(built.headers['Content-Type']).toBe('application/json');
    expect(clientBody.model).toBe('x--bd');
    const own = await adapter.buildRequest('messages', { anthropic_version: 'custom', max_tokens: 1, messages: [] }, PROFILE);
    expect(JSON.parse(own.body).anthropic_version).toBe('custom');
  });

  it('access-key signs with service bedrock', async () => {
    const adapter = adapterFor(bedrock())!;
    const built = await adapter.buildRequest('messages', { max_tokens: 1, messages: [] }, PROFILE);
    expect(built.headers.authorization).toContain('Credential=AKIDEXAMPLE/');
    expect(built.headers.authorization).toMatch(/\/us-east-1\/bedrock\/aws4_request/);
    expect(built.headers['x-amz-security-token']).toBeUndefined();
    const parsed = parseSigV4AuthHeader(built.headers.authorization);
    expect(parsed).not.toBeNull();
    const provider = { getSigningKey: async (_id: string, scope: any) => deriveSigningKey(SECRET, scope) };
    const req = {
      method: 'POST',
      originalUrl: new URL(built.url).pathname,
      rawBody: built.body,
      headers: { host: new URL(built.url).host, ...built.headers },
    };
    expect(await verifySigV4Request(req, parsed!, provider)).toBe(true);
    expect(await verifySigV4Request({ ...req, rawBody: built.body + ' ' }, parsed!, provider)).toBe(false);

    const session = await adapterFor(bedrock({}, { secret: SECRET, sessionToken: 'TOKEN123' }))!.buildRequest('messages', { max_tokens: 1, messages: [] }, PROFILE);
    expect(session.headers['x-amz-security-token']).toBe('TOKEN123');
  });

  it('bearer mode sends the API key', async () => {
    const adapter = adapterFor(bedrock({ authMode: 'bearer' }, { secret: 'bedrock-api-key-1' }))!;
    const built = await adapter.buildRequest('messages', { max_tokens: 1, messages: [] }, PROFILE);
    expect(built.headers.Authorization).toBe('Bearer bedrock-api-key-1');
    expect(built.headers).not.toHaveProperty('x-amz-date');
    expect(built.headers).not.toHaveProperty('authorization');
  });

  it('beta flags are filtered', async () => {
    const adapter = adapterFor(bedrock())!;
    const built = await adapter.buildRequest('messages', { max_tokens: 1, messages: [] }, PROFILE, {
      'anthropic-beta': 'context-1m-2025-08-07,interleaved-thinking-2025-05-14,made-up-flag',
    });
    expect(JSON.parse(built.body).anthropic_beta).toEqual(['context-1m-2025-08-07']);
    const none = await adapter.buildRequest('messages', { max_tokens: 1, messages: [], anthropic_beta: ['made-up-flag'] }, PROFILE);
    expect(JSON.parse(none.body)).not.toHaveProperty('anthropic_beta');
    const fromBody = await adapter.buildRequest('messages', { max_tokens: 1, messages: [], anthropic_beta: ['context-1m-2025-08-07'] }, PROFILE);
    expect(JSON.parse(fromBody.body).anthropic_beta).toEqual(['context-1m-2025-08-07']);
  });

  it('listModels merges foundation models and profiles', async () => {
    fake.route('/foundation-models', [{ kind: 'json', body: { modelSummaries: [{ modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0' }, { modelId: 'anthropic.claude-sonnet-4' }] } }]);
    fake.route('/inference-profiles', [
      { kind: 'json', body: { inferenceProfileSummaries: [{ inferenceProfileId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }, { inferenceProfileId: 'us.meta.llama3' }], nextToken: 'p2' } },
      { kind: 'json', body: { inferenceProfileSummaries: [{ inferenceProfileId: 'anthropic.claude-sonnet-4' }], nextToken: 'p2' } },
    ]);
    const models = await adapterFor(bedrock())!.listModels();
    expect(models).toEqual(['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-sonnet-4', 'anthropic.claude-haiku-4-5-20251001-v1:0']);
    const urls = fake.requests.map((r) => r.url);
    expect(urls).toContain('/foundation-models?byProvider=Anthropic');
    expect(urls).toContain('/inference-profiles?maxResults=1000&typeEquals=SYSTEM_DEFINED');
    expect(urls.some((u) => u.includes('nextToken=p2'))).toBe(true);
    expect(urls.filter((u) => u.startsWith('/inference-profiles')).length).toBe(2);
    expect(fake.requests[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('listModels stops on a nextToken cycle', async () => {
    fake.route('/foundation-models', [{ kind: 'json', body: { modelSummaries: [] } }]);
    fake.route('/inference-profiles', [
      { kind: 'json', body: { inferenceProfileSummaries: [{ inferenceProfileId: 'a.anthropic.claude-one' }], nextToken: 'p1' } },
      { kind: 'json', body: { inferenceProfileSummaries: [{ inferenceProfileId: 'a.anthropic.claude-two' }], nextToken: 'p2' } },
      { kind: 'json', body: { inferenceProfileSummaries: [{ inferenceProfileId: 'a.anthropic.claude-one' }], nextToken: 'p1' } },
      { kind: 'json', body: { inferenceProfileSummaries: [{ inferenceProfileId: 'a.anthropic.claude-three' }], nextToken: 'p2' } },
    ]);
    const models = await adapterFor(bedrock())!.listModels();
    expect(models).toEqual(['a.anthropic.claude-one', 'a.anthropic.claude-two']);
    expect(fake.requests.filter((r) => r.url.startsWith('/inference-profiles')).length).toBe(3);
  });

  it('runtimeEndpoint override serves both planes', async () => {
    fake.route('/foundation-models', [{ kind: 'json', body: { modelSummaries: [] } }]);
    const adapter = adapterFor(bedrock({ runtimeEndpoint: fake.url.replace('127.0.0.1', 'localhost') }))!;
    expect(await adapter.testConnection()).toEqual({ ok: true });
    expect(fake.requests[0].url).toBe('/foundation-models?byProvider=Anthropic');
    const swapped = adapterFor(bedrock({ runtimeEndpoint: 'https://bedrock-runtime.eu-west-1.example.test' }))!;
    expect((await swapped.buildRequest('messages', { max_tokens: 1, messages: [] }, 'm')).url).toBe('https://bedrock-runtime.eu-west-1.example.test/model/m/invoke');
  });

  it('a refused credential is redacted', async () => {
    const adapter = adapterFor(bedrock({ authMode: 'bearer' }, { secret: 'bedrock-api-key-1' }))!;
    fake.route('/model/', [{ kind: 'status', status: 403, body: { message: 'The security token included in the request is invalid: bedrock-api-key-1' } }]);
    const app = express();
    app.post('/', async (r: any, res) => {
      try { await callUpstream(await adapter.buildRequest('messages', { max_tokens: 1, messages: [] }, PROFILE), { stream: false }); res.json({}); } catch (e) { await sendUpstreamError(r, res, e, adapter, 'anthropic'); }
    });
    const r = await request(app).post('/');
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain('[REDACTED]');
    expect(JSON.stringify(r.body)).not.toContain('bedrock-api-key-1');
  });

  it('a refused access-key signature with a session token is redacted', async () => {
    const adapter = adapterFor(bedrock({}, { secret: SECRET, sessionToken: 'SESSIONTOKEN-abc123' }))!;
    fake.route('/model/', [{ kind: 'status', status: 403, body: { message: 'Canonical String: x-amz-security-token:SESSIONTOKEN-abc123 AKIDEXAMPLE' } }]);
    const app = express();
    app.post('/', async (r: any, res) => {
      try { await callUpstream(await adapter.buildRequest('messages', { max_tokens: 1, messages: [] }, PROFILE), { stream: false }); res.json({}); } catch (e) { await sendUpstreamError(r, res, e, adapter, 'anthropic'); }
    });
    const r = await request(app).post('/');
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain('[REDACTED]');
    expect(JSON.stringify(r.body)).not.toContain('SESSIONTOKEN-abc123');
  });

  it('testConnection maps 403 to forbidden and 200 to ok', async () => {
    const adapter = adapterFor(bedrock())!;
    fake.route('/foundation-models', [{ kind: 'json', body: { modelSummaries: [] } }]);
    expect(await adapter.testConnection()).toEqual({ ok: true });
    fake.route('/foundation-models', [{ kind: 'status', status: 403 }]);
    expect(await adapter.testConnection()).toEqual({ ok: false, error: { reason: 'forbidden', status: 403 } });
  });

  it('secrets() holds the secret and the session token', () => {
    expect(adapterFor(bedrock())!.secrets()).toEqual([SECRET]);
    expect(adapterFor(bedrock({}, { secret: SECRET, sessionToken: 'TOKEN123' }))!.secrets()).toEqual([SECRET, 'TOKEN123']);
    expect(adapterFor(bedrock({}, null))).toBeNull();
  });
});
