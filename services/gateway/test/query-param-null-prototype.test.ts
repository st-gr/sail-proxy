/**
 * Regression: express 4.22 parses bracketed query parameters to null-prototype
 * objects.
 *
 * The CVE-2024-51999 fix swapped `qs.parse(str, { allowPrototypes: true })` for
 * `{ plainObjects: true }`, so `?x[a]=1` now yields an `Object.create(null)`
 * value with no `toString`/`valueOf`/`Symbol.toPrimitive`. `String(v)`,
 * `parseInt(v as string)` and template literals all throw `TypeError: Cannot
 * convert object to primitive value` on such a value. In an async handler
 * express 4 does not route the rejection to `app.use(errorHandler)`, so the
 * request hangs and Node reports an unhandledRejection — which is what happened
 * to `/health`, the unauthenticated container probe.
 *
 * These tests drive the real handlers over supertest, so they fail against the
 * pre-fix `parseInt(req.query.response_wait as string)` / `String(req.query.model)`.
 */
import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../src/middlewares/gatewayServiceAuth', () => ({ gatewayStandaloneOrServiceKeyAuth: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: { getSAPAICoreConfig: () => ({ url: 'https://ai.example', resourceGroup: 'default' }) }, getTrustForwardedFor: () => false, getSAPAICoreConfig: () => ({ url: 'https://ai.example', resourceGroup: 'default' }) }));
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitDeploymentCreated: jest.fn<any>().mockResolvedValue(undefined) } }));
const svc = { listDeploymentsForModel: jest.fn<any>(), createDeployment: jest.fn<any>(), getDeploymentStatus: jest.fn<any>() };
jest.mock('../src/services/deploymentManagementService', () => {
  class DeploymentError extends Error { status: number; code: string; details?: any; constructor(s: number, c: string, m: string, d?: any) { super(m); this.status = s; this.code = c; this.details = d; } }
  return { __esModule: true, ...svc, DeploymentError, default: { ...svc, DeploymentError } };
});

import { queryString, firstValue } from '../src/utils/queryParam';
import { createHealthHandler } from '../src/routes/healthRoutes';
import { parsePageParams } from '../src/fileSearch/pagination';
import deploymentRoutes from '../src/routes/deploymentRoutes';

describe('queryString', () => {
  it('returns a string value unchanged', () => {
    expect(queryString('5')).toBe('5');
  });

  it('takes the first element of an array-valued parameter', () => {
    expect(queryString(['a', 'b'])).toBe('a');
    expect(queryString([])).toBeNull();
    expect(queryString([{ a: '1' }])).toBeNull();
  });

  it('returns null for an object — including the null-prototype one express 4.22 produces', () => {
    expect(queryString({ a: '1' })).toBeNull();
    const nullProto = Object.assign(Object.create(null), { a: '1' });
    expect(queryString(nullProto)).toBeNull();
    // Guard the premise: coercing that value is exactly what used to throw.
    expect(() => String(nullProto)).toThrow(TypeError);
  });

  it('returns null for undefined, null and the empty string', () => {
    expect(queryString(undefined)).toBeNull();
    expect(queryString(null)).toBeNull();
    expect(queryString('')).toBeNull();
  });

  it('firstValue unwraps arrays only', () => {
    expect(firstValue(['x'])).toBe('x');
    expect(firstValue('x')).toBe('x');
    expect(firstValue(undefined)).toBeUndefined();
  });
});

describe('GET /health with a bracketed response_wait', () => {
  const app = express();
  app.get('/health', createHealthHandler('local'));

  it('express parses ?response_wait[a]=1 to a prototype-less object', async () => {
    const probe = express();
    let seen: unknown;
    probe.get('/probe', (req, res) => { seen = req.query.response_wait; res.end(); });
    await request(probe).get('/probe?response_wait[a]=1');
    expect(typeof seen).toBe('object');
    expect(Object.getPrototypeOf(seen as object)).toBeNull();
  });

  it('answers the health JSON instead of hanging', async () => {
    const r = await request(app).get('/health?response_wait[a]=1');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('healthy');
    expect(r.body.simulatedDelay).toBeUndefined();
  });

  it('an array-valued response_wait takes the first element', async () => {
    const r = await request(app).get('/health?response_wait=5&response_wait=9');
    expect(r.status).toBe(200);
    expect(r.body.simulatedDelay).toBe(5);
  });

  it('a valid response_wait still reports the simulated delay (DEBUG off, so no sleep)', async () => {
    const r = await request(app).get('/health?response_wait=5');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ status: 'healthy', service: 'gateway', deployTarget: 'local', simulatedDelay: 5 }));
  });

  it('an absent or out-of-range response_wait reports no delay', async () => {
    expect((await request(app).get('/health')).body.simulatedDelay).toBeUndefined();
    expect((await request(app).get('/health?response_wait=abc')).body.simulatedDelay).toBeUndefined();
    expect((await request(app).get('/health?response_wait=661')).body.simulatedDelay).toBeUndefined();
    expect((await request(app).get('/health?response_wait=0')).body.simulatedDelay).toBeUndefined();
  });
});

describe('GET /api/admin/deployments with a bracketed model', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/deployments', deploymentRoutes);

  it('answers 400 missing_model instead of throwing outside the try', async () => {
    const r = await request(app).get('/api/admin/deployments?model[x]=1');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'missing_model', message: 'query parameter model is required' });
    expect(svc.listDeploymentsForModel).not.toHaveBeenCalled();
  });

  it('a plain model is still trimmed and passed through', async () => {
    svc.listDeploymentsForModel.mockResolvedValue([{ id: 'd1' }]);
    const r = await request(app).get('/api/admin/deployments?model=%20gpt-5.4%20');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ model: 'gpt-5.4', deployments: [{ id: 'd1' }] });
  });
});

describe('file_search pagination reads through the shared helper', () => {
  it('a bracketed after/before degrades to null rather than throwing', () => {
    const nullProto = Object.assign(Object.create(null), { a: '1' });
    expect(parsePageParams({ after: nullProto, before: nullProto, limit: nullProto, order: nullProto }))
      .toEqual({ limit: 20, order: 'desc', after: null, before: null });
  });

  it('string and array forms are unchanged', () => {
    expect(parsePageParams({ limit: '5', order: 'asc', after: ['f1'], before: 'f2' }))
      .toEqual({ limit: 5, order: 'asc', after: 'f1', before: 'f2' });
  });
});
