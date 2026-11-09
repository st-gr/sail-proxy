/**
 * /api/admin/connections on a standalone gateway (spec 2026-10-27 E): the same test and model-list
 * handlers, behind the standalone-only auth, plus POST /reload so the CLI's change is seen at once.
 * Distributed gateways keep the service-key auth and have no reload route.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
const deny = (_req: any, res: any) => res.status(401).json({ error: 'unauthorized' });
jest.mock('../src/middlewares/gatewayServiceAuth', () => ({
  gatewayStandaloneOrServiceKeyAuth: (req: any, res: any, next: any) => (req.headers['x-mode'] === 'service' ? next() : deny(req, res)),
  gatewayStandaloneOnlyAuth: (req: any, res: any, next: any) => (req.headers['x-mode'] === 'standalone' ? next() : deny(req, res)),
}));
let standalone = true;
jest.mock('../src/config/unifiedAuthConfig', () => ({ isStandaloneMode: () => standalone }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {} }));

import { startFakeProviderServer, FakeProviderServer } from './fakeProviderServer';
import { connectionRegistry } from '../src/connections/connectionRegistry';
import { fileConnectionBackend } from '../src/connections/fileBackend';
import { mountConnectionAdminRoutes } from '../src/routes/connectionAdminRoutes';

let fake: FakeProviderServer;
let dir: string;
let file: string;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });

const write = (names: string[]) => fs.writeFileSync(file, JSON.stringify({
  version: 1,
  connections: names.map((name) => ({
    name, type: 'openai', secret: 'sk-file-test', settings: { baseUrl: `${fake.url}/v1` },
    models: [{ upstreamModel: 'gpt-4o' }, { upstreamModel: 'gpt-4o-mini' }],
  })),
}));
const app = () => { const a = express(); a.use(express.json()); mountConnectionAdminRoutes(a); return a; };
const asStandalone = (r: request.Test) => r.set('x-mode', 'standalone');

beforeEach(() => {
  standalone = true;
  fake.requests.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-routes-'));
  file = path.join(dir, 'connections.json');
  write(['oa']);
  connectionRegistry.setBackend(fileConnectionBackend(file, {}));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('standalone /api/admin/connections', () => {
  it('requires the standalone-only auth', async () => {
    expect((await request(app()).post('/api/admin/connections/oa/test')).status).toBe(401);
    expect((await request(app()).post('/api/admin/connections/oa/test').set('x-mode', 'service')).status).toBe(401);
    expect((await request(app()).post('/api/admin/connections/reload')).status).toBe(401);
  });

  it('test of a file connection: ok, unauthorized on 401, 404 for an unknown name', async () => {
    fake.script([{ kind: 'json', body: { data: [] } }]);
    expect((await asStandalone(request(app()).post('/api/admin/connections/oa/test'))).body).toEqual({ ok: true });
    fake.script([{ kind: 'status', status: 401, body: { error: { message: 'bad key' } } }]);
    expect((await asStandalone(request(app()).post('/api/admin/connections/oa/test'))).body).toEqual({ ok: false, error: { reason: 'unauthorized', status: 401 } });
    const unknown = await asStandalone(request(app()).post('/api/admin/connections/nope/test'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('connection_not_found');
  });

  it('models lists the upstream ids', async () => {
    fake.script([{ kind: 'json', body: { data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] } }]);
    const r = await asStandalone(request(app()).get('/api/admin/connections/oa/models'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ models: ['gpt-4o', 'gpt-4.1'] });
  });

  it('reload picks up a file change at once and answers the counts', async () => {
    const first = await asStandalone(request(app()).post('/api/admin/connections/reload'));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ connections: 1, models: 2 });
    write(['oa', 'second']);
    const second = await asStandalone(request(app()).post('/api/admin/connections/reload'));
    expect(second.body).toEqual({ connections: 2, models: 4 });
  });
});

describe('distributed /api/admin/connections', () => {
  it('has no reload route, and keeps the service-key auth', async () => {
    standalone = false;
    connectionRegistry.setBackend({ fetch: async () => [] });
    expect((await request(app()).post('/api/admin/connections/reload').set('x-mode', 'service')).status).toBe(404);
    expect((await request(app()).post('/api/admin/connections/x/test').set('x-mode', 'standalone')).status).toBe(401);
    expect((await request(app()).post('/api/admin/connections/x/test').set('x-mode', 'service')).status).toBe(404);
  });
});
