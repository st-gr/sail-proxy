/**
 * /api/admin/connections/:id/test and /:id/models (spec 2026-10-23 §5.2, §7): the admin asks the
 * gateway, which holds the decrypted credential, to test a connection or list its upstream models.
 * The answer is a reason code, never the provider's text or the credential. Service-key only, like
 * the deployment routes (a standalone gateway: connection-admin-routes-standalone.test.ts).
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../src/middlewares/gatewayServiceAuth', () => ({ gatewayStandaloneOrServiceKeyAuth: (_req: any, _res: any, next: any) => next() }));
let standalone = false;
jest.mock('../src/config/unifiedAuthConfig', () => ({ isStandaloneMode: () => standalone }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {} }));

import { startFakeProviderServer, FakeProviderServer } from './fakeProviderServer';
import { connectionRegistry } from '../src/connections/connectionRegistry';
import type { Connection } from '../src/connections/types';
import { mountConnectionAdminRoutes } from '../src/routes/connectionAdminRoutes';
import { currentSapTarget } from '../src/sap/sapTarget';
import { SERVICE_KEYS, ENDPOINT_AUTH_RULES, validateServiceKeyPermissions } from '@libs/service-auth';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: 'c-oa', name: 'oa', providerType: 'openai', isActive: false,
  settings: { baseUrl: `${fake.url}/v1` }, credentials: { secret: 'sk-admin-test' }, models: [], ...over,
});
let snapshot: Connection[] = [];
const fetch = jest.fn(async () => snapshot);
const app = () => { const a = express(); a.use(express.json()); mountConnectionAdminRoutes(a); return a; };

beforeEach(() => {
  fake.requests.length = 0;
  standalone = false;
  snapshot = [conn()];
  fetch.mockClear();
  connectionRegistry.setBackend({ fetch });
});

describe('/api/admin/connections', () => {
  it('test answers ok against the fake, unauthorized on 401, 404 for an unknown id', async () => {
    fake.script([{ kind: 'json', body: { data: [] } }]);
    expect((await request(app()).post('/api/admin/connections/c-oa/test')).body).toEqual({ ok: true });
    fake.script([{ kind: 'status', status: 401, body: { error: { message: 'Incorrect API key provided: sk-admin-test' } } }]);
    const refused = await request(app()).post('/api/admin/connections/c-oa/test');
    expect(refused.status).toBe(200);
    expect(refused.body).toEqual({ ok: false, error: { reason: 'unauthorized', status: 401 } });
    const unknown = await request(app()).post('/api/admin/connections/nope/test');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('connection_not_found');
  });

  it('refetches the snapshot first, since the admin may just have changed the connection', async () => {
    fake.script([{ kind: 'json', body: { data: [] } }]);
    await request(app()).post('/api/admin/connections/c-oa/test');
    await request(app()).post('/api/admin/connections/c-oa/test');
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('no credential: test says so, models is 409', async () => {
    snapshot = [conn({ credentials: null })];
    expect((await request(app()).post('/api/admin/connections/c-oa/test')).body).toEqual({ ok: false, error: { reason: 'no_credential' } });
    const models = await request(app()).get('/api/admin/connections/c-oa/models');
    expect(models.status).toBe(409);
    expect(models.body.error).toBe('no_credential');
  });

  it('a provider type not served yet answers not_supported', async () => {
    snapshot = [conn({ providerType: 'future-provider' as Connection['providerType'] })];
    expect((await request(app()).post('/api/admin/connections/c-oa/test')).body).toEqual({ ok: false, error: { reason: 'not_supported' } });
    expect((await request(app()).get('/api/admin/connections/c-oa/models')).status).toBe(501);
  });

  it('models lists the fake openai ids', async () => {
    fake.script([{ kind: 'json', body: { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] } }]);
    const r = await request(app()).get('/api/admin/connections/c-oa/models');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ models: ['gpt-4o-mini', 'gpt-4o'] });
  });

  it('a refused model list is 502 with a reason, and no response carries the credential', async () => {
    fake.script([{ kind: 'status', status: 401, body: { error: { message: 'Incorrect API key provided: sk-admin-test' } } }]);
    const r = await request(app()).get('/api/admin/connections/c-oa/models');
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: 'unauthorized', status: 401 });
    expect(JSON.stringify(r.body)).not.toContain('sk-admin-test');
  });

  it('test of a sap-ai-core connection: a token from its auth URL, then the foundation-model list with it', async () => {
    const sap = conn({
      id: 'c-sap', name: 'sap', providerType: 'sap-ai-core', isActive: false,
      settings: { resourceGroup: 'rg-test', endpoint: 'https://patched.example.invalid' },
      credentials: { secret: JSON.stringify({ aiCoreUrl: fake.url, authUrl: `${fake.url}/oauth/token`, clientId: 'sb-test-client', clientSecret: 'sap-admin-test-secret', region: 'prod.eu10' }) },
    });
    snapshot = [sap];
    fake.route('/oauth/token', [{ kind: 'json', body: { access_token: 'sap-test-token', expires_in: 3600 } }]);
    fake.route('/v2/lm/scenarios/foundation-models/models', [{ kind: 'json', body: { resources: [] } }]);
    expect((await request(app()).post('/api/admin/connections/c-sap/test')).body).toEqual({ ok: true });
    const list = fake.requests.find((r) => r.url === '/v2/lm/scenarios/foundation-models/models');
    expect(list?.headers.authorization).toBe('Bearer sap-test-token');
    expect(list?.headers['ai-resource-group']).toBe('rg-test');
    expect(fake.requests.find((r) => r.url === '/oauth/token')?.body).toContain('client_id=sb-test-client');

    fake.route('/oauth/token', [{ kind: 'status', status: 401, body: { error: 'unauthorized', error_description: 'Bad credentials sap-admin-test-secret' } }]);
    const refused = await request(app()).post('/api/admin/connections/c-sap/test');
    expect(refused.body).toEqual({ ok: false, error: { reason: 'unauthorized', status: 401 } });
    expect(JSON.stringify(refused.body)).not.toContain('sap-admin-test-secret');

    const models = await request(app()).get('/api/admin/connections/c-sap/models');
    expect(models.status).toBe(501);
    expect(models.body.error).toBe('not_supported');
  });

  it('testing a sap-ai-core connection never installs it as the SAP target', async () => {
    const before = currentSapTarget();
    snapshot = [conn({ id: 'c-sap', providerType: 'sap-ai-core', credentials: { secret: JSON.stringify({ aiCoreUrl: fake.url, authUrl: `${fake.url}/oauth/token`, clientId: 'c', clientSecret: 's', region: 'r' }) } })];
    fake.route('/oauth/token', [{ kind: 'json', body: { access_token: 't', expires_in: 3600 } }]);
    fake.route('/v2/lm/scenarios/foundation-models/models', [{ kind: 'json', body: { resources: [] } }]);
    await request(app()).post('/api/admin/connections/c-sap/test');
    expect(currentSapTarget()).toBe(before);
  });

  it('ADMIN_TO_GATEWAY may call them with connections:read', () => {
    expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS).toEqual(expect.arrayContaining(['connections:read']));
    expect(ENDPOINT_AUTH_RULES['/api/admin/connections/*'].mode).toBe('STANDALONE_OR_SERVICE_KEY');
    expect(validateServiceKeyPermissions('ADMIN_TO_GATEWAY', '/api/admin/connections/c-oa/test')).toBe(true);
  });
});
