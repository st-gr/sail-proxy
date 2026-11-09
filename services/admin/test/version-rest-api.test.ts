/**
 * GET /api/version: the running version, the installation type and whether the update check is on.
 * Admin only (401 without a signed-in user, 403 for the user role), as the plugins routes.
 */
import express from 'express';
import request from 'supertest';
import { getAdminVersion } from '../src/services/adminVersion';

const versionRouter = require('../src/srv/version-rest-api');

const ADMIN = { id: 'admin@example.com', roles: ['admin', 'user'] };
const USER = { id: 'user@example.com', roles: ['user'] };

const appAs = (user: any): express.Application => {
  const app = express();
  app.use((req: any, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/version', versionRouter);
  return app;
};

describe('GET /api/version', () => {
  const saved = { ...process.env };
  beforeAll(() => { process.env.VALIDATION_TOKEN_SECRET = 'f'.repeat(64); });
  beforeEach(() => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.DEPLOY_TARGET;
    delete process.env.UPDATE_CHECK_ENABLED;
  });
  afterAll(() => { process.env = saved; });

  it('reports kyma on Kubernetes', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    process.env.DEPLOY_TARGET = 'docker';
    const res = await request(appAs(ADMIN)).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: getAdminVersion(), installType: 'kyma', updateCheck: true });
  });

  it('reports docker with only DEPLOY_TARGET=docker', async () => {
    process.env.DEPLOY_TARGET = 'docker';
    const res = await request(appAs(ADMIN)).get('/api/version');
    expect(res.body.installType).toBe('docker');
  });

  it('reports local with neither', async () => {
    const res = await request(appAs(ADMIN)).get('/api/version');
    expect(res.body.installType).toBe('local');
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])('turns the update check off for %s', async (value) => {
    process.env.UPDATE_CHECK_ENABLED = value;
    const res = await request(appAs(ADMIN)).get('/api/version');
    expect(res.body.updateCheck).toBe(false);
  });

  it('keeps the update check on for other values', async () => {
    process.env.UPDATE_CHECK_ENABLED = 'true';
    expect((await request(appAs(ADMIN)).get('/api/version')).body.updateCheck).toBe(true);
  });

  it('refuses the user role with 403', async () => {
    expect((await request(appAs(USER)).get('/api/version')).status).toBe(403);
  });

  it('refuses an anonymous caller with 401', async () => {
    expect((await request(appAs(null)).get('/api/version')).status).toBe(401);
  });
});
