/**
 * The cross-site guard: a browser request that changes something and that the browser itself marks as
 * coming from another site (`Sec-Fetch-Site: cross-site` or `same-site`) is refused before it reaches
 * authentication. Everything else passes unchanged: reads, the cockpit's own same-origin requests, and
 * every client that is not a browser (the gateway, CLI tools, scripts), which sends no such header.
 */
import express from 'express';
import request from 'supertest';
import { createCrossSiteGuard, isCrossSiteWrite } from '../../../src/middleware/crossSiteGuard';

function app() {
  const a = express();
  a.use(createCrossSiteGuard());
  a.all('*', (_req, res) => { res.status(200).json({ reached: true }); });
  return a;
}

describe('isCrossSiteWrite', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s marked cross-site or same-site', (method) => {
    expect(isCrossSiteWrite(method, { 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(isCrossSiteWrite(method, { 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(isCrossSiteWrite(method.toLowerCase(), { 'sec-fetch-site': 'Cross-Site' })).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('lets %s through whatever its origin', (method) => {
    expect(isCrossSiteWrite(method, { 'sec-fetch-site': 'cross-site' })).toBe(false);
  });

  it('lets the cockpit\'s own requests through', () => {
    expect(isCrossSiteWrite('POST', { 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(isCrossSiteWrite('POST', { 'sec-fetch-site': 'none' })).toBe(false);
  });

  it('lets a client that is not a browser through: no Sec-Fetch-Site, with or without an Origin', () => {
    expect(isCrossSiteWrite('POST', {})).toBe(false);
    expect(isCrossSiteWrite('DELETE', { origin: 'https://elsewhere.example' })).toBe(false);
    expect(isCrossSiteWrite('POST', { 'sec-fetch-mode': 'cors' })).toBe(false);
  });
});

describe('createCrossSiteGuard', () => {
  it('answers 403 with a code and never reaches the routes', async () => {
    const res = await request(app()).post('/api/plugins/acme/disable').set('Sec-Fetch-Site', 'cross-site').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CROSS_SITE_REQUEST');
    expect(res.body.reached).toBeUndefined();
  });

  it('passes a same-origin $batch, a gateway call and a cross-site read', async () => {
    expect((await request(app()).post('/odata/v4/admin/$batch').set('Sec-Fetch-Site', 'same-origin').send('x')).status).toBe(200);
    expect((await request(app()).post('/api/usage').set('Authorization', 'Bearer t').send({})).status).toBe(200);
    expect((await request(app()).get('/api/health').set('Sec-Fetch-Site', 'cross-site')).status).toBe(200);
  });
});
