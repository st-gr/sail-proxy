import * as crypto from 'crypto';
import {
  createS3Backend, S3RequestError, S3_PROBE_CONTENT,
} from '../../src/fileSearch/blob/s3Backend';
import { FAST, SHA_A, STUB_CREDENTIALS, rejection, useS3Stub } from './s3Stub';

// Requests against a local stub S3: success paths, hard timeouts, redirects and
// error statuses. Configuration, locations and confinement: s3Backend.confinement.test.ts.

const stub = useS3Stub();

describe('s3Backend: happy path against the stub', () => {
  it('put sends a signed PUT under the prefix and returns the logical key as location', async () => {
    let body = Buffer.alloc(0);
    stub.handler = (req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => { body = Buffer.concat(parts); res.end(); });
    };
    const out = await stub.backend().put(SHA_A, Buffer.from('hello'), 'text/plain');
    expect(out).toEqual({ location: `grounding-test/aa/${SHA_A}` });
    expect(stub.seen[0].method).toBe('PUT');
    expect(stub.seen[0].url).toBe(`/test-bucket/grounding-test/aa/${SHA_A}`);
    expect(stub.seen[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(body.toString()).toBe('hello');
  });

  it('get returns the bytes, and null on 404', async () => {
    stub.handler = (_req, res) => res.end('content');
    expect((await stub.backend().get(SHA_A))?.toString()).toBe('content');
    stub.handler = (_req, res) => { res.statusCode = 404; res.end('<Error><Code>NoSuchKey</Code></Error>'); };
    expect(await stub.backend().get(SHA_A)).toBeNull();
  });

  it('delete ignores 404; exists maps 200/404 to true/false', async () => {
    stub.handler = (_req, res) => { res.statusCode = 404; res.end(); };
    await expect(stub.backend().delete(SHA_A)).resolves.toBeUndefined();
    expect(await stub.backend().exists(SHA_A)).toBe(false);
    stub.handler = (_req, res) => { res.statusCode = 204; res.end(); };
    await expect(stub.backend().delete(SHA_A)).resolves.toBeUndefined();
    stub.handler = (_req, res) => res.end();
    expect(await stub.backend().exists(SHA_A)).toBe(true);
    expect(stub.seen.map((s) => s.method)).toEqual(['DELETE', 'HEAD', 'DELETE', 'HEAD']);
  });

  describe('probe', () => {
    const probeSha = crypto.createHash('sha256').update(S3_PROBE_CONTENT).digest('hex');
    const probeUrl = `/test-bucket/grounding-test/${probeSha.slice(0, 2)}/${probeSha}`;
    /** A stub that stores PUT bodies and serves them on GET. */
    const storing = (serve: (stored: Buffer | undefined) => Buffer | null) => {
      let stored: Buffer | undefined;
      stub.handler = (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          if (req.method === 'PUT') { stored = Buffer.concat(chunks); res.end(); return; }
          const body = serve(stored);
          if (body === null) { res.statusCode = 404; res.end(); return; }
          res.end(body);
        });
      };
    };

    it('PUTs the fixed probe object at its content-addressed key under the prefix, reads it back, deletes nothing', async () => {
      storing((stored) => stored ?? null);
      await stub.backend().probe();
      expect(stub.seen.map((r) => `${r.method} ${r.url}`)).toEqual([`PUT ${probeUrl}`, `GET ${probeUrl}`]);
      expect(S3_PROBE_CONTENT.toString('utf8')).toBe('sail-proxy file_search connection probe v1\n');
    });

    it('a read-back with other bytes is probe_mismatch, a missing one probe_missing', async () => {
      storing(() => Buffer.from('something else'));
      const mismatch = await rejection(stub.backend().probe());
      expect(mismatch).toMatchObject({ op: 'GetObject', status: 200, code: 'probe_mismatch' });
      storing(() => null);
      const missing = await rejection(stub.backend().probe());
      expect(missing).toMatchObject({ op: 'GetObject', status: 404, code: 'probe_missing' });
    });

    it('a refused PUT fails the probe without a GET', async () => {
      stub.handler = (req, res) => { req.resume(); res.statusCode = 403; res.end('<Error><Code>AccessDenied</Code></Error>'); };
      const err = await rejection(stub.backend().probe());
      expect(err).toMatchObject({ op: 'PutObject', status: 403, code: 'AccessDenied' });
      expect(stub.seen.map((r) => r.method)).toEqual(['PUT']);
    });
  });
});

describe('s3Backend: hard timeouts', () => {
  // FAST = { metadataMs: 400, transferMs: 600, idleMs: 250 }. Which timer fires is deterministic:
  // HEAD/DELETE and PUT run on the deadline alone; GET has the idle timer
  // (headers within idleMs, then no stall longer than idleMs) under its deadline.

  it.each([
    ['exists', (b: any) => b.exists(SHA_A)],
    ['delete', (b: any) => b.delete(SHA_A)],
  ])('a server that never sends headers: %s fails at the metadata deadline', async (_name, call) => {
    stub.handler = () => { /* hang */ };
    const started = Date.now();
    const err = await rejection(call(stub.backend()));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.code).toBe('deadline_exceeded');
    expect(err.status).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(FAST.metadataMs - 50);
    expect(elapsed).toBeLessThan(FAST.metadataMs + 2000);
  });

  it('a server that never sends headers: get trips the idle timer first', async () => {
    stub.handler = () => { /* hang */ };
    const started = Date.now();
    const err = await rejection(stub.backend().get(SHA_A));
    expect(err.code).toBe('idle_timeout');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(FAST.idleMs - 50);
    expect(elapsed).toBeLessThan(FAST.transferMs);
  });

  it('a body that trickles past the transfer deadline is aborted, even though it never idles', async () => {
    stub.handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      const t = setInterval(() => {
        if (res.destroyed) { clearInterval(t); return; }
        res.write('x');
      }, 50); // well inside the 250 ms idle window
      res.on('close', () => clearInterval(t));
    };
    const started = Date.now();
    const err = await rejection(stub.backend().get(SHA_A));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.code).toBe('deadline_exceeded');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(FAST.transferMs - 50);
    expect(elapsed).toBeLessThan(FAST.transferMs + 2000);
  });

  it('a body that stalls mid-transfer trips the idle timeout before the deadline', async () => {
    const timeouts = { metadataMs: 400, transferMs: 5000, idleMs: 250 };
    stub.handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial'); // then silence
    };
    const started = Date.now();
    const err = await rejection(createS3Backend(stub.cfg(), { timeouts, credentials: STUB_CREDENTIALS }).get(SHA_A));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.code).toBe('idle_timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a PUT that never gets a response is cut off by the transfer deadline', async () => {
    stub.handler = (req) => { req.resume(); /* never respond */ };
    const started = Date.now();
    const err = await rejection(stub.backend().put(SHA_A, Buffer.from('x'), 'text/plain'));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.code).toBe('deadline_exceeded');
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.transferMs - 50);
  });

  it('an upload read slowly but steadily for longer than idleMs succeeds within the deadline', async () => {
    const timeouts = { metadataMs: 400, transferMs: 5000, idleMs: 250 };
    const size = 8 * 1024 * 1024;
    let received = 0;
    stub.handler = (req, res) => {
      req.pause();
      const t = setInterval(() => {
        for (let i = 0; i < 4; i++) {
          const chunk = req.read(65536) as Buffer | null;
          if (!chunk) break;
          received += chunk.length;
        }
      }, 20); // ~256 KiB per 20 ms: ~640 ms for 8 MiB
      req.on('end', () => { clearInterval(t); res.end(); });
      req.on('close', () => clearInterval(t));
    };
    const started = Date.now();
    const out = await createS3Backend(stub.cfg(), { timeouts, credentials: STUB_CREDENTIALS }).put(SHA_A, Buffer.alloc(size, 1), 'a/b');
    expect(out.location).toBe(`grounding-test/aa/${SHA_A}`);
    expect(received).toBe(size);
    expect(Date.now() - started).toBeGreaterThan(timeouts.idleMs * 2);
  });
});

describe('s3Backend: stale connection retry', () => {
  it('a connection reset on the first attempt is retried once and succeeds', async () => {
    let n = 0;
    stub.handler = (req, res) => {
      if (n++ === 0) { req.socket.destroy(); return; }
      res.end('content');
    };
    expect((await stub.backend().get(SHA_A))?.toString()).toBe('content');
    expect(stub.seen).toHaveLength(2);
  });

  it.each([
    ['put', (b: any) => b.put(SHA_A, Buffer.from('x'), 'a/b')],
    ['delete', (b: any) => b.delete(SHA_A)],
    ['exists', (b: any) => b.exists(SHA_A)],
  ])('%s is retried once after a reset', async (_name, call) => {
    let n = 0;
    stub.handler = (req, res) => {
      if (n++ === 0) { req.socket.destroy(); return; }
      req.resume();
      req.on('end', () => res.end());
    };
    await call(stub.backend());
    expect(stub.seen).toHaveLength(2);
  });

  it('a second reset is not retried again and surfaces as ECONNRESET', async () => {
    stub.handler = (req) => { req.socket.destroy(); };
    const err = await rejection(stub.backend().get(SHA_A));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.code).toBe('ECONNRESET');
    expect(stub.seen).toHaveLength(2);
  });

  it('a 5xx is not retried', async () => {
    stub.handler = (_req, res) => { res.statusCode = 500; res.end(); };
    await rejection(stub.backend().get(SHA_A));
    expect(stub.seen).toHaveLength(1);
  });
});

describe('s3Backend: redirects and error statuses', () => {
  it.each([301, 302, 307])('a %i is an error and is never followed', async (status) => {
    stub.handler = (req, res) => {
      if (req.url!.startsWith('/elsewhere')) { res.end('followed'); return; }
      res.writeHead(status, { location: `${stub.endpoint}/elsewhere`, 'x-amz-bucket-region': 'eu-west-1' });
      res.end();
    };
    const err = await rejection(stub.backend().get(SHA_A));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.status).toBe(status);
    expect(err.code).toBe('redirect');
    expect(stub.seen.map((s) => s.url)).toEqual([`/test-bucket/grounding-test/aa/${SHA_A}`]);
    // a HEAD reports the region hint S3 sends with a wrong-region redirect
    const head = await rejection(stub.backend().exists(SHA_A));
    expect(head.status).toBe(status);
    expect(head.bucketRegion).toBe('eu-west-1');
    expect(stub.seen.some((s) => s.url.startsWith('/elsewhere'))).toBe(false);
  });

  it.each([400, 403])('a wrong-region %i on a HEAD carries the region hint', async (status) => {
    stub.handler = (_req, res) => {
      res.writeHead(status, { 'x-amz-bucket-region': 'ap-southeast-2' });
      res.end();
    };
    const err = await rejection(stub.backend().exists(SHA_A));
    expect(err.status).toBe(status);
    expect(err.bucketRegion).toBe('ap-southeast-2');
  });

  it('a 5xx carries status and the S3 error code, nothing else', async () => {
    stub.handler = (_req, res) => {
      res.statusCode = 503;
      res.end('<?xml version="1.0"?><Error><Code>SlowDown</Code><Message>Reduce your rate</Message></Error>');
    };
    const err = await rejection(stub.backend().get(SHA_A));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('SlowDown');
    expect(err.op).toBe('GetObject');
  });

  it('a 403 is an error for get, exists, delete and put (never mistaken for absent)', async () => {
    stub.handler = (req, res) => {
      req.resume();
      res.statusCode = 403;
      res.end(req.method === 'HEAD' ? undefined : '<Error><Code>AccessDenied</Code></Error>');
    };
    const b = stub.backend();
    for (const p of [b.get(SHA_A), b.exists(SHA_A), b.delete(SHA_A), b.put(SHA_A, Buffer.from('x'), 'a/b')]) {
      const err = await rejection(p);
      expect(err).toBeInstanceOf(S3RequestError);
      expect(err.status).toBe(403);
    }
  });

  it('errors never carry the URL, credentials or signed headers', async () => {
    stub.handler = (_req, res) => { res.statusCode = 500; res.end('<Error><Code>InternalError</Code></Error>'); };
    const err = await rejection(stub.backend().get(SHA_A));
    const dumped = [err.message, err.stack, JSON.stringify(err), JSON.stringify(Object.entries(err))].join('\n');
    for (const secret of ['127.0.0.1', 'test-bucket', SHA_A, 'AKIDTESTONLY', 'test-secret-only', 'AWS4-HMAC', 'Signature=']) {
      expect(dumped).not.toContain(secret);
    }
    expect(err.cause).toBeUndefined();
  });

  it('a refused connection is a coded error without the address', async () => {
    const err = await rejection(createS3Backend(stub.cfg({ endpoint: 'http://127.0.0.1:1' }), { timeouts: FAST, credentials: STUB_CREDENTIALS }).get(SHA_A));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.status).toBeNull();
    expect(err.code).toBe('ECONNREFUSED');
    expect(err.message).not.toContain('127.0.0.1');
  });
});
