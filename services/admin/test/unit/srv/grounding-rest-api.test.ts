import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
const callGateway = jest.fn();
jest.mock('../../../src/services/groundingGatewayClient', () => ({
  __esModule: true,
  callGateway: (...a: any[]) => callGateway(...a),
  streamToGateway: jest.fn(),
  streamFromGateway: jest.fn()
}));

const membershipsOf = jest.fn();
const getTeam = jest.fn();
jest.mock('../../../src/services/teamLookups', () => ({
  __esModule: true,
  membershipsOf: (...a: any[]) => membershipsOf(...a),
  getTeam: (...a: any[]) => getTeam(...a)
}));

const computeSapNative = jest.fn();
jest.mock('../../../src/services/sapCapacityService', () => ({
  __esModule: true,
  computeSapNative: (...a: any[]) => computeSapNative(...a),
  isProductive: () => true
}));

const cds = require('@sap/cds');
const router = require('../../../src/srv/grounding-rest-api');

/** user: what the auth middleware leaves on the request. Docker gives is(); local dev does not. */
function appAs(user: any): express.Application {
  const app = express();
  app.use((req: any, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/grounding', router);
  return app;
}
const DEV_USER = { id: 'user@test.com', email: 'user@test.com', roles: ['user'], attr: {} };
const DEV_ADMIN = { id: 'admin@test.com', email: 'admin@test.com', roles: ['admin', 'user', 'gateway'], attr: {} };
const DOCKER_ADMIN = { id: 'boss@example.test', roles: ['admin'], scope: ['admin'], is: (r: string) => r === 'admin' };

beforeEach(() => { membershipsOf.mockReset(); membershipsOf.mockResolvedValue([]); getTeam.mockReset(); getTeam.mockResolvedValue({ ID: 't1' }); callGateway.mockReset(); callGateway.mockResolvedValue({ status: 200, headers: {}, data: { ok: true } }); });

describe('identity comes from the session, never from the browser', () => {
  it('401s without a signed-in user and does not call the gateway', async () => {
    const r = await request(appAs(null)).get('/api/grounding/status');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('authentication_required');
    expect(callGateway).not.toHaveBeenCalled();
  });

  it('acts as the session user with role user', async () => {
    await request(appAs(DEV_USER)).get('/api/grounding/files');
    expect(callGateway.mock.calls[0][0]).toMatchObject({ email: 'user@test.com', role: 'user' });
  });

  it('maps the admin role from a plain roles array (local dev) and from a Docker user object', async () => {
    await request(appAs(DEV_ADMIN)).get('/api/grounding/files');
    await request(appAs(DOCKER_ADMIN)).get('/api/grounding/files');
    expect(callGateway.mock.calls[0][0]).toMatchObject({ email: 'admin@test.com', role: 'admin' });
    expect(callGateway.mock.calls[1][0]).toMatchObject({ email: 'boss@example.test', role: 'admin' });
  });

  it('maps a real cds.User (roles is an object map, is() exists) to admin or user', async () => {
    await request(appAs(new (cds as any).User({ id: 'admin@test.com', roles: ['admin', 'user'] }))).get('/api/grounding/files');
    await request(appAs(new (cds as any).User({ id: 'user@test.com', roles: ['user'] }))).get('/api/grounding/files');
    expect(callGateway.mock.calls[0][0]).toMatchObject({ email: 'admin@test.com', role: 'admin' });
    expect(callGateway.mock.calls[1][0]).toMatchObject({ email: 'user@test.com', role: 'user' });
  });

  it('401s for an anonymous cds.User and for an id without an e-mail, without calling the gateway', async () => {
    const r = await request(appAs((cds as any).User.anonymous)).get('/api/grounding/files');
    const r2 = await request(appAs({ id: 'anonymous', roles: [] })).get('/api/grounding/files');
    expect(r.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it('answers unsupported_identity for a sign-in e-mail that cannot travel in a header, without calling the gateway', async () => {
    const r = await request(appAs({ id: 'jürgen@example.test', roles: ['user'] })).get('/api/grounding/files');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'unsupported_identity', message: 'Your sign-in e-mail contains characters Grounding cannot pass to the gateway.' });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it('ignores acting headers and role claims the browser sends', async () => {
    await request(appAs(DEV_USER)).get('/api/grounding/files')
      .set('X-Grounding-Acting-Email', 'admin@test.com').set('X-Grounding-Acting-Role', 'admin');
    expect(callGateway.mock.calls[0][0]).toMatchObject({ email: 'user@test.com', role: 'user' });
  });
});

describe('forwarding', () => {
  it('forwards method, path, string query values and a JSON body', async () => {
    await request(appAs(DEV_USER)).post('/api/grounding/stores').send({ name: 'Docs' });
    expect(callGateway.mock.calls[0].slice(1, 3)).toEqual(['post', '/stores']);
    expect(callGateway.mock.calls[0][3].body).toEqual({ name: 'Docs' });

    await request(appAs(DEV_USER)).get('/api/grounding/stores/vs_1/files?limit=10&order=asc');
    expect(callGateway.mock.calls[1].slice(1, 3)).toEqual(['get', '/stores/vs_1/files']);
    expect(callGateway.mock.calls[1][3].query.toString()).toBe('limit=10&order=asc');
    expect(callGateway.mock.calls[1][3].body).toBeUndefined();
  });

  it('refuses a path parameter that is not a plain token, so an id cannot leave the grounding route group', async () => {
    const r = await request(appAs(DEV_USER)).get('/api/grounding/files/' + encodeURIComponent('../../deployments'));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid_id', message: 'The id is not valid.' });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it('refuses a dot-segment store id (%2E%2E) without calling the gateway', async () => {
    // supertest normalises %2E%2E on the client, so send the raw request line the way a browser-side attacker can.
    const server = http.createServer(appAs(DEV_USER));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      const reply = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/grounding/stores/%2E%2E/files' }, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode as number, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ error: 'invalid_id', message: 'The id is not valid.' });
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('still forwards a normal id', async () => {
    const r = await request(appAs(DEV_USER)).get('/api/grounding/stores/vs_abc-123/files');
    expect(r.status).toBe(200);
    expect(callGateway.mock.calls[0][2]).toBe('/stores/vs_abc-123/files');
  });

  it('drops bracketed query parameters instead of throwing (express 4.22 null-prototype query)', async () => {
    const r = await request(appAs(DEV_USER)).get('/api/grounding/files?limit[a]=1&order=desc');
    expect(r.status).toBe(200);
    expect(callGateway.mock.calls[0][3].query.toString()).toBe('order=desc');
  });

  it('returns the gateway\'s status and body unchanged, errors included', async () => {
    callGateway.mockResolvedValue({ status: 409, headers: {}, data: { error: { code: 'file_in_use', message: 'The file is attached.' } } });
    const r = await request(appAs(DEV_USER)).delete('/api/grounding/files/file-a');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: { code: 'file_in_use', message: 'The file is attached.' } });
  });

  it('passes a quota 429 through with its body, resets_at included, for the cockpit\'s text', async () => {
    const refusal = { error: { type: 'quota_exceeded', code: 'quota_exceeded', message: 'Your usage quota for this day is used up.', window: 'day', resets_at: '2026-10-14T00:00:00.000Z' } };
    callGateway.mockResolvedValue({ status: 429, headers: { 'retry-after': '60' }, data: refusal });
    const r = await request(appAs(DEV_USER)).post('/api/grounding/stores/vs_a/search').send({ query: 'q' });
    expect(r.status).toBe(429);
    expect(r.body).toEqual(refusal);
  });

  it('passes a 502 for an unreachable gateway through to the app', async () => {
    callGateway.mockResolvedValue({ status: 502, headers: {}, data: { error: 'gateway_unreachable', message: 'The gateway could not be reached.' } });
    const r = await request(appAs(DEV_USER)).get('/api/grounding/status');
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('gateway_unreachable');
  });

  it('answers 502 when the client throws after all', async () => {
    callGateway.mockRejectedValue(new Error('boom'));
    const r = await request(appAs(DEV_USER)).get('/api/grounding/status');
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('gateway_unreachable');
  });
});

describe('jobs, retries, batches and search forward to the gateway', () => {
  it.each([
    ['get', '/api/grounding/jobs', '/jobs'],
    ['get', '/api/grounding/jobs/job_1', '/jobs/job_1'],
    ['post', '/api/grounding/jobs/job_1/cancel', '/jobs/job_1/cancel'],
    ['post', '/api/grounding/jobs/job_1/retry', '/jobs/job_1/retry'],
    ['post', '/api/grounding/stores/vs_1/files/file_1/retry', '/stores/vs_1/files/file_1/retry'],
    ['post', '/api/grounding/stores/vs_1/search', '/stores/vs_1/search'],
    ['post', '/api/grounding/stores/vs_1/file_batches', '/stores/vs_1/file_batches'],
    ['get', '/api/grounding/stores/vs_1/file_batches/batch_1', '/stores/vs_1/file_batches/batch_1'],
    ['get', '/api/grounding/stores/vs_1/file_batches/batch_1/files', '/stores/vs_1/file_batches/batch_1/files'],
  ])('%s %s forwards to %s with query and body', async (method, url, gatewayPath) => {
    const call = (request(appAs(DEV_USER)) as any)[method](url + '?limit=5');
    const r = method === 'post' ? await call.send({ query: 'q' }) : await call;
    expect(r.status).toBe(200);
    expect(callGateway.mock.calls[0].slice(1, 3)).toEqual([method, gatewayPath]);
    expect(callGateway.mock.calls[0][3].query.toString()).toBe('limit=5');
    expect(callGateway.mock.calls[0][3].body).toEqual(method === 'post' ? { query: 'q' } : undefined);
  });

  it.each([
    ['get', '/api/grounding/jobs/' + encodeURIComponent('../x')],
    ['post', '/api/grounding/jobs/' + encodeURIComponent('a b') + '/cancel'],
    ['post', '/api/grounding/jobs/' + encodeURIComponent('../x') + '/retry'],
    ['get', '/api/grounding/stores/vs_1/file_batches/' + encodeURIComponent('../x')],
    ['get', '/api/grounding/stores/vs_1/file_batches/' + encodeURIComponent('../x') + '/files'],
  ])('%s %s is refused as invalid_id without calling the gateway', async (method, path) => {
    const r = await (request(appAs(DEV_USER)) as any)[method](path);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_id');
    expect(callGateway).not.toHaveBeenCalled();
  });
});

describe('only the listed routes exist', () => {
  it.each([
    ['delete', '/api/grounding/jobs/job_1'],
    ['get', '/api/grounding/jobs/job_1/cancel'],
    ['get', '/api/grounding/stores/vs_1/search'],
    ['post', '/api/grounding/stores/vs_1/file_batches/batch_1'],
    ['post', '/api/grounding/stores/vs_1/file_batches/batch_1/cancel'],
    ['get', '/api/grounding/admin/blobs'],
    ['post', '/api/grounding/admin/blobs/migrate'],
    ['post', '/api/grounding/admin/blob-storage'],
    ['delete', '/api/grounding/admin/blob-storage'],
    ['get', '/api/grounding/admin/blob-storage/test'],
    ['get', '/api/grounding/admin/blob-storage/migrate'],
    ['post', '/api/grounding/admin/blob-storage/cancel'],
    ['get', '/api/grounding/admin/reembed-outdated'],
    ['get', '/api/grounding/admin/stores/vs_1/reembed'],
    ['get', '/api/grounding/stores/vs_1/reembed'],
    ['post', '/api/grounding/stores/vs_1/reembed/estimate'],
    ['post', '/api/grounding/admin/stores/vs_1/reembed/estimate'],
    ['post', '/api/grounding/stores/vs_1/chunking/estimate'],
    ['get', '/api/grounding/stores/vs_1/chunking'],
    ['delete', '/api/grounding/stores/vs_1/chunking'],
    ['post', '/api/grounding/admin/stores/vs_1/chunking/estimate'],
    ['get', '/api/grounding/admin/stores/vs_1/chunking'],
    ['put', '/api/grounding/stores/vs_1/chunking'],
    ['post', '/api/grounding/stores/vs_1/reextract/estimate'],
    ['get', '/api/grounding/stores/vs_1/reextract'],
    ['post', '/api/grounding/admin/stores/vs_1/reextract/estimate'],
    ['delete', '/api/grounding/admin/stores/vs_1/reextract'],
    ['get', '/api/grounding/admin/jobs/job_1/cancel'],
    ['delete', '/api/grounding/admin/jobs/job_1'],
    ['post', '/api/grounding/jobs/job_1/failures'],
    ['post', '/api/grounding/admin/jobs/job_1/failures'],
    ['get', '/api/grounding/jobs/job_1/failures/file_1'],
    ['post', '/api/grounding/admin/overview'],
    ['delete', '/api/grounding/admin/stores'],
    ['get', '/api/grounding/admin/stores/vs_1/share'],
    ['delete', '/api/grounding/admin/stores/vs_1/share'],
    ['get', '/api/grounding/admin/stores/vs_1/files/file_1/retry'],
    ['get', '/api/grounding/admin/files/file_1'],
    ['post', '/api/grounding/storage'],
    ['get', '/api/grounding/anything-else'],
  ])('%s %s is not served', async (method, path) => {
    const r = await (request(appAs(DEV_ADMIN)) as any)[method](path);
    expect(r.status).toBe(404);
    expect(callGateway).not.toHaveBeenCalled();
  });
});

describe('re-embedding forwards to the gateway', () => {
  it.each([
    ['get', '/api/grounding/stores/vs_1/reembed/estimate', '/stores/vs_1/reembed/estimate'],
    ['post', '/api/grounding/stores/vs_1/reembed', '/stores/vs_1/reembed'],
    ['get', '/api/grounding/admin/stores/vs_1/reembed/estimate', '/admin/stores/vs_1/reembed/estimate'],
    ['post', '/api/grounding/admin/stores/vs_1/reembed', '/admin/stores/vs_1/reembed'],
    ['get', '/api/grounding/admin/reembed-outdated/estimate', '/admin/reembed-outdated/estimate'],
    ['post', '/api/grounding/admin/reembed-outdated', '/admin/reembed-outdated'],
    ['post', '/api/grounding/admin/jobs/job_1/cancel', '/admin/jobs/job_1/cancel'],
    ['post', '/api/grounding/admin/jobs/job_1/retry', '/admin/jobs/job_1/retry'],
    ['get', '/api/grounding/jobs/job_1/failures', '/jobs/job_1/failures'],
    ['get', '/api/grounding/admin/jobs/job_1/failures', '/admin/jobs/job_1/failures'],
    ['get', '/api/grounding/admin/jobs/job_1', '/admin/jobs/job_1'],
    ['get', '/api/grounding/stores/vs_1/chunking/estimate', '/stores/vs_1/chunking/estimate'],
    ['post', '/api/grounding/stores/vs_1/chunking', '/stores/vs_1/chunking'],
    ['get', '/api/grounding/admin/stores/vs_1/chunking/estimate', '/admin/stores/vs_1/chunking/estimate'],
    ['post', '/api/grounding/admin/stores/vs_1/chunking', '/admin/stores/vs_1/chunking'],
    ['get', '/api/grounding/stores/vs_1/reextract/estimate', '/stores/vs_1/reextract/estimate'],
    ['post', '/api/grounding/stores/vs_1/reextract', '/stores/vs_1/reextract'],
    ['get', '/api/grounding/admin/stores/vs_1/reextract/estimate', '/admin/stores/vs_1/reextract/estimate'],
    ['post', '/api/grounding/admin/stores/vs_1/reextract', '/admin/stores/vs_1/reextract'],
    ['get', '/api/grounding/admin/blob-storage', '/admin/blob-storage'],
    ['post', '/api/grounding/admin/blob-storage/test', '/admin/blob-storage/test'],
    ['post', '/api/grounding/admin/blob-storage/migrate', '/admin/blob-storage/migrate'],
  ])('%s %s forwards to %s with query and body', async (method, url, gatewayPath) => {
    const call = (request(appAs(DEV_ADMIN)) as any)[method](url + '?limit=5');
    const r = method === 'post' ? await call.send({ x: 1 }) : await call;
    expect(r.status).toBe(200);
    expect(callGateway.mock.calls[0].slice(1, 3)).toEqual([method, gatewayPath]);
    expect(callGateway.mock.calls[0][3].query.toString()).toBe('limit=5');
    expect(callGateway.mock.calls[0][3].body).toEqual(method === 'post' ? { x: 1 } : undefined);
  });

  it('passes the gateway\'s refusals through unchanged (a non-owner\'s 404, a 409 with the engine\'s code)', async () => {
    callGateway.mockResolvedValueOnce({ status: 404, headers: {}, data: { error: { code: 'vector_store_not_found' } } });
    const notOwner = await request(appAs(DEV_USER)).post('/api/grounding/stores/vs_1/reembed');
    expect(notOwner.status).toBe(404);
    expect(notOwner.body.error.code).toBe('vector_store_not_found');
    callGateway.mockResolvedValueOnce({ status: 409, headers: {}, data: { error: { code: 'store_current' } } });
    const current = await request(appAs(DEV_USER)).post('/api/grounding/stores/vs_1/reembed');
    expect(current.status).toBe(409);
    expect(current.body.error.code).toBe('store_current');
    expect(callGateway.mock.calls[0][0]).toMatchObject({ email: 'user@test.com', role: 'user' });
  });

  it('drops a bracketed query parameter (?x[a]=1) on the estimate', async () => {
    await request(appAs(DEV_USER)).get('/api/grounding/stores/vs_1/reembed/estimate?x[a]=1&y=2');
    expect(callGateway.mock.calls[0][3].query.toString()).toBe('y=2');
  });

  it.each([
    ['get', '/api/grounding/stores/' + encodeURIComponent('../x') + '/reembed/estimate'],
    ['post', '/api/grounding/stores/' + encodeURIComponent('a b') + '/reembed'],
    ['post', '/api/grounding/admin/stores/' + encodeURIComponent('../x') + '/reembed'],
    ['get', '/api/grounding/admin/stores/' + encodeURIComponent('../x') + '/reembed/estimate'],
    ['get', '/api/grounding/stores/' + encodeURIComponent('../x') + '/chunking/estimate'],
    ['post', '/api/grounding/admin/stores/' + encodeURIComponent('a b') + '/chunking'],
    ['post', '/api/grounding/admin/jobs/' + encodeURIComponent('../x') + '/cancel'],
    ['post', '/api/grounding/admin/jobs/' + encodeURIComponent('a b') + '/retry'],
    ['get', '/api/grounding/jobs/' + encodeURIComponent('../x') + '/failures'],
    ['get', '/api/grounding/admin/jobs/' + encodeURIComponent('a b') + '/failures'],
    ['get', '/api/grounding/admin/jobs/' + encodeURIComponent('../x')],
  ])('%s %s is refused as invalid_id without calling the gateway', async (method, path) => {
    const r = await (request(appAs(DEV_ADMIN)) as any)[method](path);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_id');
    expect(callGateway).not.toHaveBeenCalled();
  });
});

describe('administration and sharing forward to the gateway', () => {
  it.each([
    ['get', '/api/grounding/storage', '/storage'],
    ['get', '/api/grounding/admin/overview', '/admin/overview'],
    ['get', '/api/grounding/admin/stores', '/admin/stores'],
    ['get', '/api/grounding/admin/files', '/admin/files'],
    ['get', '/api/grounding/admin/failed', '/admin/failed'],
    ['get', '/api/grounding/admin/storage', '/admin/storage'],
    ['get', '/api/grounding/admin/jobs', '/admin/jobs'],
    ['delete', '/api/grounding/admin/stores/vs_1', '/admin/stores/vs_1'],
    ['delete', '/api/grounding/admin/files/file_1', '/admin/files/file_1'],
    ['post', '/api/grounding/admin/stores/vs_1/files/file_1/retry', '/admin/stores/vs_1/files/file_1/retry'],
    ['post', '/api/grounding/admin/stores/vs_1/share', '/admin/stores/vs_1/share'],
    ['post', '/api/grounding/admin/stores/vs_1/unshare', '/admin/stores/vs_1/unshare'],
  ])('%s %s forwards to %s with query and body', async (method, url, gatewayPath) => {
    const call = (request(appAs(DEV_ADMIN)) as any)[method](url + '?limit=5');
    const r = method === 'post' ? await call.send({ x: 1 }) : await call;
    expect(r.status).toBe(200);
    expect(callGateway.mock.calls[0].slice(1, 3)).toEqual([method, gatewayPath]);
    expect(callGateway.mock.calls[0][3].query.toString()).toBe('limit=5');
    expect(callGateway.mock.calls[0][3].body).toEqual(method === 'post' ? { x: 1 } : undefined);
  });

  it('forwards the owner, status, shared, embedding_state, after and limit filters untouched, an e-mail owner included', async () => {
    await request(appAs(DEV_ADMIN)).get('/api/grounding/admin/stores?owner=ann.lee%40example.test&status=completed&shared=true&embedding_state=outdated&after=vs_9&limit=50');
    expect(callGateway.mock.calls[0].slice(1, 3)).toEqual(['get', '/admin/stores']);
    const query = callGateway.mock.calls[0][3].query as URLSearchParams;
    expect(query.get('owner')).toBe('ann.lee@example.test');
    expect(query.get('status')).toBe('completed');
    expect(query.get('shared')).toBe('true');
    expect(query.get('embedding_state')).toBe('outdated');
    expect(query.get('after')).toBe('vs_9');
    expect(query.get('limit')).toBe('50');
  });

  it('passes an e-mail cursor of the storage list through (after is a query value, not an id)', async () => {
    await request(appAs(DEV_ADMIN)).get('/api/grounding/admin/storage?after=ann.lee%40example.test');
    expect(callGateway.mock.calls[0][3].query.get('after')).toBe('ann.lee@example.test');
  });

  it('adds no role logic: the actor role goes through for an admin and for a user, and the gateway answers', async () => {
    await request(appAs(DEV_ADMIN)).get('/api/grounding/admin/overview');
    callGateway.mockResolvedValue({ status: 403, headers: {}, data: { error: { code: 'grounding_admin_required' } } });
    const r = await request(appAs(DEV_USER)).get('/api/grounding/admin/overview');
    expect(callGateway.mock.calls[0][0]).toMatchObject({ email: 'admin@test.com', role: 'admin' });
    expect(callGateway.mock.calls[1][0]).toMatchObject({ email: 'user@test.com', role: 'user' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('grounding_admin_required');
  });

  it.each([
    ['delete', '/api/grounding/admin/stores/' + encodeURIComponent('../x')],
    ['delete', '/api/grounding/admin/files/' + encodeURIComponent('a b')],
    ['post', '/api/grounding/admin/stores/' + encodeURIComponent('../x') + '/share'],
    ['post', '/api/grounding/admin/stores/vs_1/files/' + encodeURIComponent('../x') + '/retry'],
  ])('%s %s is refused as invalid_id without calling the gateway', async (method, path) => {
    const r = await (request(appAs(DEV_ADMIN)) as any)[method](path);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_id');
    expect(callGateway).not.toHaveBeenCalled();
  });
});

describe('chunking forwards to the gateway', () => {
  const SETTING = { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true };

  it('the store create carries the chunking setting in its body', async () => {
    await request(appAs(DEV_USER)).post('/api/grounding/stores').send({ name: 'Docs', chunking: SETTING });
    expect(callGateway.mock.calls[0].slice(0, 3)).toMatchObject([{ email: 'user@test.com', role: 'user' }, 'post', '/stores']);
    expect(callGateway.mock.calls[0][3].body).toEqual({ name: 'Docs', chunking: SETTING });
  });

  it('the estimate forwards the setting as string query values; a bracketed one is dropped', async () => {
    await request(appAs(DEV_USER)).get('/api/grounding/stores/vs_1/chunking/estimate?type=structure&max_tokens=800&overlap_tokens=0&contextual=true&x[a]=1');
    expect(callGateway.mock.calls[0][3].query.toString()).toBe('type=structure&max_tokens=800&overlap_tokens=0&contextual=true');
  });

  it('passes the gateway\'s refusals through unchanged (a non-owner\'s 404, a running job\'s 409)', async () => {
    callGateway.mockResolvedValueOnce({ status: 404, headers: {}, data: { error: { code: 'vector_store_not_found' } } });
    const notOwner = await request(appAs(DEV_USER)).post('/api/grounding/stores/vs_1/chunking').send({ chunking: SETTING });
    expect([notOwner.status, notOwner.body.error.code]).toEqual([404, 'vector_store_not_found']);
    callGateway.mockResolvedValueOnce({ status: 409, headers: {}, data: { error: { code: 'reembed_running' } } });
    const running = await request(appAs(DEV_USER)).post('/api/grounding/stores/vs_1/chunking').send({ chunking: SETTING });
    expect([running.status, running.body.error.code]).toEqual([409, 'reembed_running']);
  });
});

describe('GET /model-cost: an estimate priced with the Model Library (answered here, not by the gateway)', () => {
  beforeEach(() => computeSapNative.mockReset());

  it('prices the tokens like a usage event and answers cost, currency and capacity units', async () => {
    computeSapNative.mockResolvedValue({ genAiTokens: 10, capacityUnits: 19.0385, sapCost: 1.42, sapCostCurrency: 'EUR' });
    const r = await request(appAs(DEV_USER)).get('/api/grounding/model-cost?model=gemini-3.5-flash-lite&input_tokens=125000&output_tokens=4096');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ priced: true, capacity_units: 19.0385, cost: 1.42, currency: 'EUR' });
    expect(computeSapNative).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.5-flash-lite', inputTokens: 125000, outputTokens: 4096, cacheReadInputTokens: 0, productive: true
    }));
    expect(callGateway).not.toHaveBeenCalled();
  });

  it('a model without a price is priced: false; no capacity unit price leaves cost null', async () => {
    computeSapNative.mockResolvedValue(null);
    expect((await request(appAs(DEV_USER)).get('/api/grounding/model-cost?model=m&input_tokens=1&output_tokens=1')).body)
      .toEqual({ priced: false, capacity_units: null, cost: null, currency: null });
    computeSapNative.mockResolvedValue({ genAiTokens: 1, capacityUnits: 2, sapCost: null, sapCostCurrency: null });
    expect((await request(appAs(DEV_USER)).get('/api/grounding/model-cost?model=m&input_tokens=1&output_tokens=1')).body)
      .toEqual({ priced: true, capacity_units: 2, cost: null, currency: null });
  });

  it('refuses an anonymous caller, a bad model id or token count, and a bracketed parameter', async () => {
    expect((await request(appAs(null)).get('/api/grounding/model-cost?model=m&input_tokens=1&output_tokens=1')).status).toBe(401);
    for (const q of ['model=a%20b&input_tokens=1', 'model=m&input_tokens=-1', 'model=m&output_tokens=1.5', 'model[a]=1&input_tokens=1', 'input_tokens=1']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await request(appAs(DEV_USER)).get(`/api/grounding/model-cost?${q}`);
      expect(r.status).toBe(400);
    }
    expect(computeSapNative).not.toHaveBeenCalled();
  });

  it('a failed price lookup is a 500 with a plain message', async () => {
    computeSapNative.mockRejectedValue(new Error('db down'));
    const r = await request(appAs(DEV_USER)).get('/api/grounding/model-cost?model=m&input_tokens=1&output_tokens=1');
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('price_lookup_failed');
  });
});

describe('teams (Part B Task 13)', () => {
  it('sends the user\'s server-side teams and admin teams, not anything from the request', async () => {
    membershipsOf.mockResolvedValue([{ team_ID: 't1', role: 'admin' }, { team_ID: 't2', role: 'member' }]);
    await request(appAs(DEV_USER)).get('/api/grounding/stores').query({ teamIds: 'evil' }).set('X-Grounding-Acting-Teams', 'evil');
    expect(callGateway.mock.calls[0][0]).toMatchObject({ email: 'user@test.com', teamIds: ['t1', 't2'], adminTeamIds: ['t1'] });
  });

  it('caps at 200 teams, administered teams first, with the admin teams a subset', async () => {
    membershipsOf.mockResolvedValue([
      ...Array.from({ length: 250 }, (_, i) => ({ team_ID: `m${i}`, role: 'member' })),
      { team_ID: 'a1', role: 'admin' }
    ]);
    await request(appAs(DEV_USER)).get('/api/grounding/files');
    const actor = callGateway.mock.calls[0][0];
    expect(actor.teamIds).toHaveLength(200);
    expect(actor.teamIds[0]).toBe('a1');
    expect(actor.adminTeamIds).toEqual(['a1']);
  });

  it('acts without teams when the membership read fails', async () => {
    membershipsOf.mockRejectedValue(new Error('db down'));
    await request(appAs(DEV_USER)).get('/api/grounding/files');
    expect(callGateway.mock.calls[0][0]).toMatchObject({ teamIds: [], adminTeamIds: [] });
  });

  it('forwards share-team and unshare-team with their body', async () => {
    await request(appAs(DEV_USER)).post('/api/grounding/stores/s1/share-team').send({ teamId: 't1' });
    await request(appAs(DEV_USER)).post('/api/grounding/stores/s1/unshare-team').send({ teamId: 't1' });
    expect(callGateway.mock.calls[0].slice(1, 2)).toEqual(['post']);
    expect(callGateway.mock.calls[0][2]).toBe('/stores/s1/share-team');
    expect(callGateway.mock.calls[0][3].body).toEqual({ teamId: 't1' });
    expect(callGateway.mock.calls[1][2]).toBe('/stores/s1/unshare-team');
  });

  it('refuses to share with a team that does not exist, in the caller\'s language, without calling the gateway', async () => {
    getTeam.mockResolvedValue(null);
    const r = await request(appAs(DEV_USER)).post('/api/grounding/stores/s1/share-team').set('Accept-Language', 'de-DE,de;q=0.9').send({ teamId: 'nope' });
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/Team/);
    expect(r.body.message).not.toBe('TEAM_SHARE_TARGET_NOT_FOUND');
    expect(callGateway).not.toHaveBeenCalled();
  });
});
