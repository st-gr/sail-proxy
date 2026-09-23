/**
 * The chain on the SAP-RPT router: authentication first, quota second, controller last - and
 * NOT tool governance, which has nothing to govern in a tabular request. Mirrors
 * google-routes.test.ts.
 *
 * Auth here emits the REAL OpenAI-shaped refusal (`{error:{message,type}}`) and quota emits the
 * REAL quotaEnforcement body (`{error:{type,scope,dimension,window,limit,used,resets_at}}`, no
 * `message`), exactly as `createUnifiedTokenAuth`/`quotaEnforcement` do in production, so these
 * tests also prove `shapeMiddlewareErrors` (mounted first on the router) reshapes them into the
 * SAP envelope the spec requires for this route, while leaving everything else - a controller's
 * 200, and a relayed upstream response from SAP itself marked via `res.locals.sapRelay` (even a
 * SAP 401/429) - untouched.
 */
import express from 'express';
import request from 'supertest';

const order: string[] = [];
jest.mock('../src/middlewares/unifiedTokenAuth', () => ({
  __esModule: true,
  default: (_req: any, _res: any, next: any) => { order.push('auth'); next(); },
  createUnifiedTokenAuth: () => (req: any, res: any, next: any) => {
    order.push('auth');
    if (req.headers['x-test-unauth']) { res.status(401).json({ error: { message: 'API key is required', type: 'authentication_error' } }); return; }
    next();
  }
}));
jest.mock('../src/middlewares/quotaEnforcement', () => ({
  __esModule: true,
  default: (req: any, res: any, next: any) => {
    order.push('quota');
    // The real body quotaEnforcement.ts sends (its `reject`, ~line 140): no `message`, just the
    // structured fields.
    if (req.headers['x-test-quota-exceeded']) {
      res.status(429).json({ error: { type: 'quota_exceeded', scope: 'user', dimension: 'tokens', window: 'day', limit: 900, used: 1000, resets_at: '2026-09-23T00:00:00.000Z' } });
      return;
    }
    next();
  }
}));
jest.mock('../src/toolGovernance', () => ({ toolGovernance: () => () => { order.push('toolGovernance'); throw new Error('must not be mounted'); } }));
jest.mock('../src/controllers/sapRptController', () => ({
  predict: (req: any, res: any) => {
    order.push('controller');
    // Mirrors the real controller's relay of SAP's OWN response: marks res.locals.sapRelay so
    // shapeMiddlewareErrors leaves it untouched, even when SAP's own status is 401.
    if (req.headers['x-test-relay-401']) { res.locals.sapRelay = true; res.status(401).json({ error: { code: 401, message: 'token expired' } }); return; }
    res.status(200).json({ ok: true });
  },
  predictParquet: (_req: any, res: any) => { order.push('controller-parquet'); res.status(200).json({ ok: true }); }
}));

import sapRptRoutes from '../src/routes/sapRptRoutes';

const app = express();
app.use(express.json());
app.use('/sap/v1/rpt', sapRptRoutes);

beforeEach(() => { order.length = 0; });

describe('sap-rpt routes', () => {
  it('runs auth, then quota, then the controller, and never tool governance, leaving a 200 body untouched', async () => {
    const r = await request(app).post('/sap/v1/rpt/sap-rpt-1.6/predict').send({ rows: [] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(order).toEqual(['auth', 'quota', 'controller']);
  });
  it('reshapes an OpenAI-shaped 401 from auth into the SAP shape', async () => {
    const r = await request(app).post('/sap/v1/rpt/sap-rpt-1.6/predict').set('x-test-unauth', '1').send({});
    expect(r.status).toBe(401);
    expect(r.body.detail[0]).toMatchObject({ type: 'gateway_auth', msg: 'API key is required' });
    expect(r.body.status.code).toBe(1);
    expect(order).toEqual(['auth']);
  });
  it('reshapes the real quotaEnforcement 429 (no message) into the SAP shape, composing msg from its fields and preserving them', async () => {
    const r = await request(app).post('/sap/v1/rpt/sap-rpt-1.6/predict').set('x-test-quota-exceeded', '1').send({});
    expect(r.status).toBe(429);
    expect(r.body.detail[0].type).toBe('quota_exceeded');
    expect(r.body.detail[0].msg).toBe('Quota exceeded: tokens per day (1000/900), resets at 2026-09-23T00:00:00.000Z');
    expect(r.body.detail[0].quota).toEqual({ type: 'quota_exceeded', scope: 'user', dimension: 'tokens', window: 'day', limit: 900, used: 1000, resets_at: '2026-09-23T00:00:00.000Z' });
    expect(r.body.status.code).toBe(4);
    expect(order).toEqual(['auth', 'quota']);
  });
  it('leaves a relayed upstream 401 from SAP itself untouched, unlike an auth-middleware 401', async () => {
    const r = await request(app).post('/sap/v1/rpt/sap-rpt-1.6/predict').set('x-test-relay-401', '1').send({});
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: 401, message: 'token expired' } });
    expect(order).toEqual(['auth', 'quota', 'controller']);
  });
  it('routes predict-parquet to its own handler', async () => {
    const r = await request(app).post('/sap/v1/rpt/sap-rpt-1.6/predict-parquet').send({});
    expect(r.status).toBe(200);
    expect(order).toEqual(['auth', 'quota', 'controller-parquet']);
  });
});
