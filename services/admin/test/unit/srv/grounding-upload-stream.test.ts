import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../../src/services/modelCostService', () => ({
  __esModule: true,
  modelCostService: { getGatewayServiceKey: jest.fn().mockResolvedValue('sk-service') },
  default: { getGatewayServiceKey: jest.fn().mockResolvedValue('sk-service') }
}));

const router = require('../../../src/srv/grounding-rest-api');
import { __resetGroundingLimitCacheForTests } from '../../../src/services/groundingGatewayClient';

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; bytes: number; ended: boolean }
let gateway: http.Server; let admin: http.Server; let seen: Seen;
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  __resetGroundingLimitCacheForTests();
  seen = { headers: {}, bytes: 0, ended: false };
  respond = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'file-new', object: 'file' })); };
  gateway = http.createServer((req, res) => {
    seen.method = req.method; seen.url = req.url; seen.headers = req.headers;
    req.on('data', (chunk) => { seen.bytes += chunk.length; });
    req.on('end', () => { seen.ended = true; respond(req, res); });
  });
  process.env.GATEWAY_URL = `http://127.0.0.1:${await listen(gateway)}`;
  const app = express();
  app.use((req: any, _res, next) => { req.user = { id: 'user@test.com', roles: ['user'] }; next(); });
  app.use('/api/grounding', router);
  admin = http.createServer(app);
  await listen(admin);
});
afterEach(async () => {
  // A dropped upload can leave a half-open socket that would make close() wait forever.
  admin.closeAllConnections();
  gateway.closeAllConnections();
  await new Promise((resolve) => admin.close(resolve));
  await new Promise((resolve) => gateway.close(resolve));
});

function adminPort(): number { return (admin.address() as AddressInfo).port; }

describe('POST /api/grounding/files', () => {
  it('streams the body to the gateway while the browser is still sending it', async () => {
    const boundary = 'xBOUNDARYx';
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    let bytesAtHalf = -1;
    const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: adminPort(), path: '/api/grounding/files', method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked' }
      }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part) => parts.push(part));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
      });
      req.on('error', reject);
      (async () => {
        for (let i = 0; i < 4; i++) req.write(chunk);
        // Give the proxy time to pass on what it has. A buffering proxy passes on nothing yet.
        for (let i = 0; i < 40 && seen.bytes === 0; i++) await sleep(50);
        bytesAtHalf = seen.bytes;
        for (let i = 0; i < 4; i++) req.write(chunk);
        req.end();
      })().catch(reject);
    });

    expect(bytesAtHalf).toBeGreaterThan(0);
    expect(seen.ended).toBe(true);
    expect(seen.bytes).toBe(8 * chunk.length);
    expect(result).toEqual({ status: 200, body: { id: 'file-new', object: 'file' } });
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/admin/grounding/files');
    expect(seen.headers['content-type']).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(seen.headers['x-api-key']).toBe('sk-service');
    expect(seen.headers['x-grounding-acting-email']).toBe('user@test.com');
    expect(seen.headers['x-grounding-acting-role']).toBe('user');
  }, 20000);

  it('returns the gateway\'s refusal with its body, for example a file that is too large', async () => {
    respond = (_req, res) => { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'file_too_large', message: 'The file exceeds the maximum allowed size of 33554432 bytes.' } })); };
    const r = await fetch(`http://127.0.0.1:${adminPort()}/api/grounding/files`, {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=b' }, body: '--b--\r\n'
    });
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error.code).toBe('file_too_large');
  });

  it('400s a body that is not multipart without calling the gateway', async () => {
    const r = await fetch(`http://127.0.0.1:${adminPort()}/api/grounding/files`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe('invalid_content_type');
    expect(seen.method).toBeUndefined();
  });

  it('answers 502 upload_interrupted when the gateway drops the connection mid-upload', async () => {
    gateway.removeAllListeners('request');
    gateway.on('request', (req) => { req.socket.destroy(); });
    const r = await fetch(`http://127.0.0.1:${adminPort()}/api/grounding/files`, {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=b' }, body: Buffer.alloc(1024 * 1024, 0x61)
    });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error).toBe('upload_interrupted');
  });
});

describe('POST /api/grounding/files size limit', () => {
  const MiB = 1024 * 1024;
  let uploadRequests: number;
  beforeEach(() => {
    uploadRequests = 0;
    gateway.removeAllListeners('request');
    gateway.on('request', (req, res) => {
      if (req.method === 'GET' && req.url === '/api/admin/grounding/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ available: true, limits: { maxFileBytes: MiB, maxFilesPerStore: 10 } }));
        return;
      }
      uploadRequests++;
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'file-new' })); });
    });
  });

  it('refuses a declared size above the gateway limit without calling the gateway upload', async () => {
    const r = await fetch(`http://127.0.0.1:${adminPort()}/api/grounding/files`, {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=b' }, body: Buffer.alloc(3 * MiB, 0x61)
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'file_too_large', message: 'The file is larger than the allowed 1.0 MB.' });
    expect(uploadRequests).toBe(0);
  });

  it('still streams an upload within the limit', async () => {
    const r = await fetch(`http://127.0.0.1:${adminPort()}/api/grounding/files`, {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=b' }, body: Buffer.alloc(MiB / 2, 0x61)
    });
    expect(r.status).toBe(200);
    expect(uploadRequests).toBe(1);
  });
});

describe('GET /api/grounding/files/:id/content', () => {
  it('streams the file back with its content headers', async () => {
    gateway.removeAllListeners('request');
    gateway.on('request', (req, res) => {
      seen.url = req.url;
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="note.txt"', 'content-length': '5' });
      res.end('hello');
    });
    const r = await fetch(`http://127.0.0.1:${adminPort()}/api/grounding/files/file-a/content`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="note.txt"');
    expect(await r.text()).toBe('hello');
    expect(seen.url).toBe('/api/admin/grounding/files/file-a/content');
  });

  it('closes the gateway stream when the browser aborts the download', async () => {
    let gatewayClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => { gatewayClosed = resolve; });
    gateway.removeAllListeners('request');
    gateway.on('request', (_req, res) => {
      res.on('close', gatewayClosed);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(64 * 1024, 0x61)); // part of a body; the response is never finished
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: adminPort(), path: '/api/grounding/files/file-a/content' }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('no first chunk')), 5000);
    });
    const outcome = await Promise.race([closed.then(() => 'closed'), sleep(2000).then(() => 'still open')]);
    expect(outcome).toBe('closed');
  });

  it('closes the gateway response when the browser aborts before the gateway has answered', async () => {
    let gatewayClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => { gatewayClosed = resolve; });
    let gatewayAnswered = false;
    gateway.removeAllListeners('request');
    gateway.on('request', (_req, res) => {
      res.on('close', gatewayClosed);
      // The response head is delayed; the browser is gone by then.
      setTimeout(() => {
        gatewayAnswered = true;
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(Buffer.alloc(64 * 1024, 0x61)); // the response is never finished
      }, 300);
    });
    const req = http.get({ host: '127.0.0.1', port: adminPort(), path: '/api/grounding/files/file-a/content' });
    req.on('error', () => undefined);
    await sleep(100);
    req.destroy();
    const outcome = await Promise.race([closed.then(() => 'closed'), sleep(2000).then(() => 'still open')]);
    expect(outcome).toBe('closed');
    expect(gatewayAnswered).toBe(true); // the head did arrive after the abort, so the early-abort branch was the one taken
  });

  it('passes a 404 from the gateway through', async () => {
    gateway.removeAllListeners('request');
    gateway.on('request', (_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":"not_found"}}'); });
    const r = await fetch(`http://127.0.0.1:${adminPort()}/api/grounding/files/file-x/content`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.code).toBe('not_found');
  });

  it('answers 502 when the gateway is down', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:9';
    const r = await fetch(`http://127.0.0.1:${adminPort()}/api/grounding/files/file-a/content`);
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error).toBe('gateway_unreachable');
  });
});
