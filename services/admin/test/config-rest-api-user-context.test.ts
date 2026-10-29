import express from 'express';
import request from 'supertest';

const cds = require('@sap/cds');
const router = require('../src/srv/config-rest-api');

// The REST config routes are plain Express routes (mounted before cds.serve in docker mode), so
// there is no ambient CAP request context: the handler must hand the authenticated req.user to
// AdminService itself. The stub below stands in for AdminService and applies the same check CAP
// applies from admin-service.cds (requires authenticated-user, restrict to admin), recording
// which user each call ran as.
describe('config REST API runs AdminService as the request user', () => {
  const seen: any[] = [];
  let app: express.Express;
  let userApp: express.Express;
  let originalAdminService: any;

  beforeAll(() => {
    originalAdminService = cds.services.AdminService;
    cds.services.AdminService = {
      send: async (event: string) => {
        const user = cds.context?.user;
        seen.push({ event, id: user?.id });
        if (!user?.is('authenticated-user') || !user?.is('admin')) {
          throw Object.assign(new Error('Forbidden'), { code: 403 });
        }
        switch (event) {
          case 'getActiveConfiguration':
            // The shape config-service.ts returns: configData already parsed, deployedAt a string
            // (the db layer hands Timestamps back as ISO strings).
            return { success: true, data: { id: 'cfg-3', name: 'Config 3', configData: { api_config: {} }, version: 3, checksum: 'abcdef0123', deployedAt: '2026-10-20T09:00:00.000Z', deployedBy: 'admin@example.test' } };
          case 'createConfiguration':
            return { success: true, configId: 'cfg-1', warnings: [] };
          case 'activateConfiguration':
            return { success: true, version: 4, checksum: 'abcdef0123' };
          case 'rollbackConfiguration':
            return { success: true, rolledBackFrom: 4, rolledBackTo: 3, reason: 'x', rolledBackAt: new Date() };
          case 'getConfigurationStatus':
            return { success: true, status: { active: true } };
        }
        throw new Error(`unexpected event ${event}`);
      },
    };

    app = express();
    // No express.json() here: Docker mounts the router without a global parser, so the routes
    // must parse their own bodies.
    // Same shape authMiddleware.ts builds, including its own `is`, which knows only the
    // mapped roles (not CAP's built-in authenticated-user).
    app.use((req: any, _res, next) => {
      const roles = ['admin'];
      req.user = {
        id: 'admin@example.test', email: 'admin@example.test', roles, scope: roles,
        attr: { email: 'admin@example.test' }, tenant: 'default', locale: 'en',
        is: (role: string) => roles.includes(role), _roles: roles,
      };
      next();
    });
    app.use('/api/admin', router);

    userApp = express();
    userApp.use((req: any, _res, next) => {
      const roles = ['user'];
      req.user = { id: 'user@example.test', email: 'user@example.test', roles, scope: roles, attr: {}, is: (r: string) => roles.includes(r), _roles: roles };
      next();
    });
    userApp.use('/api/admin', router);
  });

  afterAll(() => {
    if (originalAdminService === undefined) delete cds.services.AdminService;
    else cds.services.AdminService = originalAdminService;
  });

  beforeEach(() => { seen.length = 0; });

  it('GET /api-config succeeds as the authenticated user', async () => {
    const res = await request(app).get('/api/admin/api-config');
    expect(seen).toEqual([{ event: 'getActiveConfiguration', id: 'admin@example.test' }]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ api_config: {} });
    expect(res.headers['x-config-version']).toBe('3');
    expect(res.headers['x-config-deployed-at']).toBe('2026-10-20T09:00:00.000Z');
    expect(res.headers.etag).toBe('"abcdef0123"');
  });

  it('PUT /api-config creates and activates as the authenticated user', async () => {
    const res = await request(app).put('/api/admin/api-config').send({ api_config: {} });
    expect(seen).toEqual([
      { event: 'createConfiguration', id: 'admin@example.test' },
      { event: 'activateConfiguration', id: 'admin@example.test' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(4);
  });

  it('PUT /api-config refuses a body without api_config with 400', async () => {
    const res = await request(app).put('/api/admin/api-config').send({});
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('PUT /api-config answers 413 for a body over 10 MB', async () => {
    const big = { api_config: { padding: 'x'.repeat(11 * 1024 * 1024) } };
    const res = await request(app).put('/api/admin/api-config').send(big);
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('POST /api-config/rollback accepts a JSON reason and also no body at all', async () => {
    const withReason = await request(app).post('/api/admin/api-config/rollback').send({ reason: 'bad change' });
    const noBody = await request(app).post('/api/admin/api-config/rollback');
    expect(withReason.status).toBe(200);
    expect(noBody.status).toBe(200);
  });

  it('POST /api-config/rollback and GET /api-config/status run as the authenticated user', async () => {
    const rollback = await request(app).post('/api/admin/api-config/rollback').send({});
    const status = await request(app).get('/api/admin/api-config/status');
    expect(seen).toEqual([
      { event: 'rollbackConfiguration', id: 'admin@example.test' },
      { event: 'getConfigurationStatus', id: 'admin@example.test' },
    ]);
    expect(rollback.status).toBe(200);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ active: true });
  });

  it('a signed-in user without the admin role gets 403 on every configuration route', async () => {
    const results = [
      await request(userApp).get('/api/admin/api-config'),
      await request(userApp).put('/api/admin/api-config').send({ api_config: {} }),
      await request(userApp).post('/api/admin/api-config/rollback').send({}),
      await request(userApp).get('/api/admin/api-config/status'),
    ];
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(results[1].body).toEqual({ error: 'Forbidden', message: 'The admin role is required.' });
  });
});
