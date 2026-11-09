// pinEphemeralServersToLoopback: test servers that ask for an ephemeral port bind 127.0.0.1, and
// `localhost` resolves to 127.0.0.1 first, so the client and the server meet on one address.
//
// Why: `app.listen(0)` (supertest, cds.test, ws) binds the dual-stack wildcard `::`, and macOS
// hands such a socket a port another process already holds on a SPECIFIC address — Colima's
// forwarders on 127.0.0.1/0.0.0.0, another project's `cds watch` livereload on [::1]. The client
// (supertest dials 127.0.0.1, cds.test dials localhost = ::1) then lands on that process:
// "Parse Error: Expected HTTP/", "socket hang up" or a foreign 404. Bound to 127.0.0.1, the
// kernel never hands out a port another IPv4 listener holds.
import dns = require('dns');
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import { pinEphemeralServersToLoopback, withLoopbackHost, loopbackLookup, TEST_LOOPBACK_HOST } from '../src/loopback-listen';

const listening = (server: net.Server, listen: () => void) =>
  new Promise<AddressInfo>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address() as AddressInfo));
    listen();
  });
const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('withLoopbackHost', () => {
  const cb = () => undefined;

  it.each([
    ['listen()', [], [0, TEST_LOOPBACK_HOST]],
    ['listen(cb)', [cb], [0, TEST_LOOPBACK_HOST, cb]],
    ['listen(0)', [0], [0, TEST_LOOPBACK_HOST]],
    ['listen(0, cb)', [0, cb], [0, TEST_LOOPBACK_HOST, cb]],
    ['listen(0, backlog, cb)', [0, 511, cb], [0, TEST_LOOPBACK_HOST, 511, cb]],
    ['listen(0, undefined, backlog, cb) as ws does', [0, undefined, 511, cb], [0, TEST_LOOPBACK_HOST, 511, cb]],
    ['listen(undefined, cb)', [undefined, cb], [undefined, TEST_LOOPBACK_HOST, cb]],
    ["listen('0') as cds.server does", ['0'], ['0', TEST_LOOPBACK_HOST]],
    ["listen('0', cb)", ['0', cb], ['0', TEST_LOOPBACK_HOST, cb]],
  ])('pins %s to the loopback host', (_name, args, expected) => {
    expect(withLoopbackHost(args)).toEqual(expected);
  });

  it('pins an options object with an ephemeral port and no host', () => {
    expect(withLoopbackHost([{ port: 0 }, cb])).toEqual([{ port: 0, host: TEST_LOOPBACK_HOST }, cb]);
    expect(withLoopbackHost([{}])).toEqual([{ host: TEST_LOOPBACK_HOST }]);
    expect(withLoopbackHost([{ port: '0' }])).toEqual([{ port: '0', host: TEST_LOOPBACK_HOST }]);
  });

  it.each([
    ['an explicit host', [0, '0.0.0.0', cb]],
    ['a fixed port', [4004, cb]],
    ['a fixed port in an options object', [{ port: 4004 }]],
    ['an options object with a host', [{ port: 0, host: '::1' }]],
    ['a pipe path', ['/tmp/some.sock', cb]],
    ['an options object with a path', [{ path: '/tmp/some.sock' }]],
    ['a handle', [{ fd: 3 }]],
    ['a fixed port as a string', ['4004', cb]],
  ])('leaves %s alone', (_name, args) => {
    expect(withLoopbackHost(args)).toEqual(args);
  });

  it('leaves a pipe-name string and a non-plain object (a raw handle) untouched', () => {
    const pipe = ['\\\\.\\pipe\\test'];
    expect(withLoopbackHost(pipe)).toBe(pipe);
    class FakeHandle { port?: number }
    const handleArgs = [new FakeHandle()];
    expect(withLoopbackHost(handleArgs)).toBe(handleArgs);
  });
});

describe('loopbackLookup', () => {
  // listen() resolves its host through dns.lookup: Node 20 asks for one address, Node 22+ for all
  // of them ({ all: true }) and binds each.
  it('answers the loopback literal in the single-address form', () => {
    const cb = jest.fn();
    loopbackLookup(jest.fn(), TEST_LOOPBACK_HOST, cb);
    expect(cb).toHaveBeenCalledWith(null, TEST_LOOPBACK_HOST, 4);
    const cb2 = jest.fn();
    loopbackLookup(jest.fn(), TEST_LOOPBACK_HOST, { family: 0 }, cb2);
    expect(cb2).toHaveBeenCalledWith(null, TEST_LOOPBACK_HOST, 4);
  });

  it('answers the loopback literal as an address list when all addresses are asked for, as Node 24 listen() does', () => {
    const cb = jest.fn();
    loopbackLookup(jest.fn(), TEST_LOOPBACK_HOST, { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: TEST_LOOPBACK_HOST, family: 4 }]);
  });

  it('passes any other host to the real lookup', () => {
    const real = jest.fn();
    const cb = jest.fn();
    loopbackLookup(real, 'example.test', { all: true }, cb);
    expect(real).toHaveBeenCalledWith('example.test', { all: true }, cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('pinEphemeralServersToLoopback', () => {
  beforeAll(() => pinEphemeralServersToLoopback());

  it('binds an ephemeral http server to 127.0.0.1, as app.listen(0) and supertest call it', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const addr = await listening(server, () => server.listen(0));
    expect(addr.address).toBe('127.0.0.1');
    await close(server);
  });

  it('binds synchronously, as supertest expects: address() is set right after listen(0) returns', async () => {
    const lookup = dns.lookup;
    const server = http.createServer();
    server.listen(0);
    expect(server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(dns.lookup).toBe(lookup);
    await close(server);
  });

  it("binds a string '0' port to 127.0.0.1, as cds.test's server does", async () => {
    const server = http.createServer();
    const addr = await listening(server, () => server.listen('0' as any));
    expect(addr.address).toBe('127.0.0.1');
    await close(server);
  });

  it('binds a raw net server and a no-argument listen() to 127.0.0.1', async () => {
    const server = net.createServer();
    const addr = await listening(server, () => server.listen());
    expect(addr.address).toBe('127.0.0.1');
    await close(server);
  });

  it('keeps an explicit host', async () => {
    const server = net.createServer();
    const addr = await listening(server, () => server.listen(0, '0.0.0.0'));
    expect(addr.address).toBe('0.0.0.0');
    await close(server);
  });

  it('is idempotent: a second call does not wrap listen twice', () => {
    const before = net.Server.prototype.listen;
    pinEphemeralServersToLoopback();
    expect(net.Server.prototype.listen).toBe(before);
  });

  it('resolves localhost to 127.0.0.1 first, so a localhost client reaches the pinned server', async () => {
    const first = await new Promise<string>((resolve, reject) =>
      dns.lookup('localhost', (err, address) => (err ? reject(err) : resolve(address))));
    expect(first).toBe('127.0.0.1');

    const server = http.createServer((req, res) => res.end(req.socket.remoteAddress));
    const { port } = await listening(server, () => server.listen(0));
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: 'localhost', port, agent: false }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    expect(body).toMatch(/127\.0\.0\.1$/);
    await close(server);
  });

  it('a localhost client still connects when the process is busy right after it dials (cds.test serves in-process)', async () => {
    const server = http.createServer((req, res) => res.end('ok'));
    const { port } = await listening(server, () => server.listen(0));
    const body = await new Promise<string>((resolve) => {
      const req = http.get({ host: 'localhost', port, agent: false }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', (err) => resolve(`error: ${err.message}`));
      // A first request to a cds.test server compiles the service synchronously in this same
      // process. Block longer than Node's 250 ms per-address attempt timeout right after the dial.
      req.on('socket', (socket) => socket.once('connectionAttempt', () => process.nextTick(() => {
        const until = Date.now() + 400;
        while (Date.now() < until) { /* busy */ }
      })));
    });
    expect(body).toBe('ok');
    await close(server);
  });
});
