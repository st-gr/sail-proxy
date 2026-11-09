/**
 * Who may call /api/plugins, through the real Docker authentication middleware (DEPLOY_TARGET=docker),
 * not an injected req.user. The actions are mocked: these tests are about identity only.
 */
process.env.DEPLOY_TARGET = 'docker';
process.env.NODE_ENV = 'production';
process.env.VALIDATION_TOKEN_SECRET = 'a'.repeat(64);
process.env.IDENTITY_PROVIDER = 'local';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const reached = jest.fn();
jest.mock('../src/services/pluginOperations', () => ({
  uploadPackage: async (_b: any, a: any) => { reached('upload', a.id); return { status: 201, body: {} }; },
  enablePlugin: async (_i: any, _v: any, a: any) => { reached('enable', a.id); return { status: 200, body: {} }; },
  disablePlugin: async (_i: any, a: any) => { reached('disable', a.id); return { status: 200, body: {} }; },
  removeVersion: async (_i: any, _v: any, a: any) => { reached('remove', a.id); return { status: 200, body: {} }; },
}));
jest.mock('../src/services/pluginSuggestedHooks', () => ({
  addSuggestedHooks: async (_i: any, a: any) => { reached('suggest', a.id); return { status: 200, body: {} }; },
  addSuggestedHooksFor: async (_i: any, a: any) => { reached('suggest', a.id); return { status: 200, body: {} }; },
}));
jest.mock('../src/services/pluginSettingsSchemas', () => ({
  listSettingsSchemas: async () => { reached('schemas', ''); return { status: 200, body: [] }; },
}));
jest.mock('../src/services/pluginListing', () => ({ listPlugins: async () => { reached('list', ''); return {}; } }));

// Required, not imported: the middleware reads the environment above when it is loaded.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createAuthMiddleware } = require('../src/middleware/authMiddleware');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/srv/plugins-rest-api');

const app = express();
app.use(createAuthMiddleware());
app.use('/api/plugins', router);

const SECRET = process.env.VALIDATION_TOKEN_SECRET as string;
const serviceToken = (secret = SECRET) => jwt.sign({
  iss: 'gateway-service', sub: 'admin@test.com', aud: 'admin-service', email: 'admin@test.com',
  scope: ['admin', 'user', 'gateway'], roles: ['admin', 'user', 'gateway'], service: 'gateway', requestId: 'r',
}, secret, { algorithm: 'HS256', expiresIn: 300 });
const asUser = (r: request.Test) => r.set('X-Auth-Request-Email', 'user@example.com').set('X-Auth-Request-Groups', 'user');
const asAdmin = (r: request.Test) => r.set('X-Auth-Request-Email', 'admin@example.com').set('X-Auth-Request-Groups', 'admin');

const calls: Array<[string, (a: any) => request.Test]> = [
  ['GET /', (a: any) => a.get('/api/plugins')],
  ['POST /', (a: any) => a.post('/api/plugins').set('Content-Type', 'application/zip').send(Buffer.from('x'))],
  ['POST /:id/enable', (a: any) => a.post('/api/plugins/acme/enable').send({ version: '1.0.0' })],
  ['POST /:id/disable', (a: any) => a.post('/api/plugins/acme/disable').send({})],
  ['POST /:id/suggested-hooks', (a: any) => a.post('/api/plugins/acme/suggested-hooks').send({})],
  ['POST /suggested-hooks', (a: any) => a.post('/api/plugins/suggested-hooks').send({ ids: ['acme'] })],
  ['GET /settings-schemas', (a: any) => a.get('/api/plugins/settings-schemas')],
  ['DELETE /:id/versions/:version', (a: any) => a.delete('/api/plugins/acme/versions/1.0.0')],
];

beforeEach(() => reached.mockReset());

describe.each(calls)('%s', (_name, call) => {
  it('401 with no identity', async () => { expect((await call(request(app))).status).toBe(401); });
  it('403 for a plain user', async () => { expect((await asUser(call(request(app)))).status).toBe(403); });
  it('401 for a bearer signed with another secret', async () => {
    expect((await call(request(app)).set('Authorization', `Bearer ${serviceToken('wrong-secret')}`)).status).toBe(401);
  });
  it('403 for the gateway service JWT, although the middleware maps it to admin', async () => {
    const res = await call(request(app)).set('Authorization', `Bearer ${serviceToken()}`);
    expect(res.status).toBe(403);
  });
  it('reaches the action for an admin', async () => {
    const res = await asAdmin(call(request(app)));
    expect(res.status).toBeLessThan(300);
  });
});

it('no action ran for any refused caller', async () => {
  for (const [, call] of calls) {
    await call(request(app));
    await asUser(call(request(app)));
    await call(request(app)).set('Authorization', `Bearer ${serviceToken()}`);
  }
  expect(reached).not.toHaveBeenCalled();
});

describe('disable needs a JSON content type', () => {
  it('refuses a form-encoded or text/plain POST (a cross-site form)', async () => {
    for (const type of ['application/x-www-form-urlencoded', 'text/plain']) {
      const res = await asAdmin(request(app).post('/api/plugins/acme/disable').set('Content-Type', type).send('a=b'));
      expect({ type, status: res.status }).toEqual({ type, status: 415 });
    }
    expect(reached).not.toHaveBeenCalled();
  });
  it('refuses a POST with no body type', async () => {
    expect((await asAdmin(request(app).post('/api/plugins/acme/disable'))).status).toBe(415);
  });
});

describe('suggested-hooks needs a JSON content type', () => {
  it('refuses a form-encoded, text/plain or untyped POST (a cross-site form)', async () => {
    for (const type of ['application/x-www-form-urlencoded', 'text/plain']) {
      const res = await asAdmin(request(app).post('/api/plugins/acme/suggested-hooks').set('Content-Type', type).send('a=b'));
      expect({ type, status: res.status }).toEqual({ type, status: 415 });
    }
    expect((await asAdmin(request(app).post('/api/plugins/acme/suggested-hooks'))).status).toBe(415);
    expect(reached).not.toHaveBeenCalled();
  });
});

describe('settings-schemas is not an :id', () => {
  it('GET /settings-schemas reaches the schemas action, not a plugin route', async () => {
    expect((await asAdmin(request(app).get('/api/plugins/settings-schemas'))).status).toBe(200);
    expect(reached).toHaveBeenCalledWith('schemas', '');
  });
});
