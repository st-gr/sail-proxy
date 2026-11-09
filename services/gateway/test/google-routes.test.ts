/**
 * /google route wiring: both API-version mounts reach the same handler with the
 * `<model>:<method>` segment intact, the middleware chain is the one every other
 * inference route uses, and anything that is not one of the three POSTs is a
 * Gemini-shaped 404.
 *
 * The controller and the middlewares are stubbed — what is under test here is the
 * router, not what it calls.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const middlewareOrder: string[] = [];
jest.mock('../src/middlewares/unifiedTokenAuth', () => ({
  __esModule: true,
  default: (_req: any, _res: any, next: any) => next(),
  createUnifiedTokenAuth: () => (_req: any, _res: any, next: any) => { middlewareOrder.push('auth'); next(); },
}));
jest.mock('../src/middlewares/quotaEnforcement', () => ({
  __esModule: true,
  default: (_req: any, _res: any, next: any) => { middlewareOrder.push('quota'); next(); },
}));
jest.mock('../src/services/unifiedAuthProxyService', () => ({
  __esModule: true,
  unifiedAuthProxyService: {
    createServiceAuthMiddleware: (opts: any) => (_req: any, _res: any, next: any) => {
      middlewareOrder.push(`serviceAuth:${opts.serviceName}`);
      next();
    },
  },
  serviceConfigurations: { google: { serviceName: 'google' } },
}));

const handled: Array<{ modelAndMethod: string; body: any; url: string }> = [];
jest.mock('../src/controllers/googleController', () => ({
  __esModule: true,
  handleGemini: (req: any, res: any) => {
    handled.push({ modelAndMethod: req.params.modelAndMethod, body: req.body, url: req.originalUrl });
    res.status(200).json({ ok: true });
    return Promise.resolve();
  },
}));

import googleRoutes from '../src/routes/googleRoutes';

const app = express();
app.use(express.json());
app.use('/google/v1beta', googleRoutes);
app.use('/google/v1', googleRoutes);

beforeEach(() => { handled.length = 0; middlewareOrder.length = 0; });

describe('/google routes', () => {
  it('reaches the handler through the v1beta mount with the model:method segment intact', async () => {
    const r = await request(app)
      .post('/google/v1beta/models/gemini-3.5-flash:generateContent')
      .send({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });

    expect(r.status).toBe(200);
    expect(handled).toHaveLength(1);
    expect(handled[0].modelAndMethod).toBe('gemini-3.5-flash:generateContent');
    expect(handled[0].body.contents).toHaveLength(1);
  });

  it('reaches the same handler through the v1 mount', async () => {
    const r = await request(app).post('/google/v1/models/anthropic--claude-4.5-sonnet:streamGenerateContent').send({});
    expect(r.status).toBe(200);
    expect(handled[0].modelAndMethod).toBe('anthropic--claude-4.5-sonnet:streamGenerateContent');
  });

  it('runs auth, service auth and quota enforcement, in that order', async () => {
    await request(app).post('/google/v1beta/models/gemini-3.5-flash:embedContent').send({});
    expect(middlewareOrder).toEqual(['auth', 'serviceAuth:google', 'quota']);
  });

  it('404s a GET in the Gemini error shape', async () => {
    const r = await request(app).get('/google/v1beta/models/gemini-3.5-flash:generateContent');
    expect(r.status).toBe(404);
    expect(r.body.error.status).toBe('NOT_FOUND');
    expect(handled).toHaveLength(0);
  });

  it('404s an unknown path under the mount in the Gemini error shape', async () => {
    const r = await request(app).post('/google/v1beta/models').send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe(404);
    expect(r.body.error.message).toContain('generateContent');
    expect(handled).toHaveLength(0);
  });
});
