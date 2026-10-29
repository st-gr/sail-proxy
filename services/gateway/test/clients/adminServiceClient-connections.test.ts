/**
 * getConnections() runs on the request path's background refresh every few seconds while it fails.
 * It must stay out of the admin client's shared circuit breaker and retry loop: that breaker also
 * gates API-key validation, so a persistently refused snapshot (an older admin, a weak
 * VALIDATION_TOKEN_SECRET, a 500) would otherwise open it and turn uncached keys into 401s on plain
 * SAP traffic. One attempt per call; an admin that does not know the function (404) means no
 * connections.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import * as http from 'http';
import { AddressInfo } from 'net';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

let status = 403;
let body: unknown = { error: { message: 'Forbidden' } };
let hits = 0;
let server: http.Server;
let url: string;
const ORIGINAL_ENV = { ...process.env };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.includes('getConnections')) hits++;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  jest.resetModules();
  hits = 0;
  process.env = { ...ORIGINAL_ENV, ADMIN_SERVICE_URL: url, VALIDATION_TOKEN_SECRET: 'f'.repeat(64), UNIFIED_AUTH_HEALTH_CHECK_INTERVAL_MS: '0', NODE_ENV: 'test' };
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

async function client(): Promise<any> {
  const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
  return new AdminServiceClient();
}

describe('AdminServiceClient.getConnections', () => {
  it('a persistently refused snapshot never opens the shared circuit breaker', async () => {
    status = 403;
    const c = await client();
    for (let i = 0; i < 8; i++) await expect(c.getConnections()).rejects.toThrow();
    expect(c.circuitBreaker.state).toBe('closed');
    expect(c.circuitBreaker.failures).toBe(0);
  });

  it('makes one attempt per call', async () => {
    status = 500;
    const c = await client();
    await expect(c.getConnections()).rejects.toThrow();
    expect(hits).toBe(1);
  });

  it('an admin without the function (404) means no connections', async () => {
    status = 404;
    const c = await client();
    await expect(c.getConnections()).resolves.toEqual([]);
  });

  it('returns the snapshot connections', async () => {
    status = 200;
    body = { success: true, snapshot: { connections: [{ id: 'c', name: 'oa' }] } };
    const c = await client();
    await expect(c.getConnections()).resolves.toEqual([{ id: 'c', name: 'oa' }]);
  });
});
