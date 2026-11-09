import axios from 'axios';
import {
  createS3Backend, S3BackendConfig, S3ConfigError, S3LocationError,
} from '../../src/fileSearch/blob/s3Backend';
import { SHA_0, SHA_A, SHA_F, SHA_MIX, STUB_CREDENTIALS, rejection, useS3Stub } from './s3Stub';

// Configuration and location validation, and the shared-bucket confinement rule:
// every request is under <prefix>/ (there is no bucket-level request). Request behaviour: s3Backend.requests.test.ts.

const stub = useS3Stub();

describe('s3Backend: configuration and location validation', () => {
  it.each(['', '/abs', 'a/../b', '..', '.', 'a//b', 'a b', 'a%2e', 'a\\b', 'x/./y', '../escape'])(
    'refuses prefix %p', (prefix) => {
      expect(() => createS3Backend(stub.cfg({ prefix }))).toThrow(S3ConfigError);
    },
  );

  it.each([
    ['grounding-test', 'grounding-test'],
    ['grounding-test/', 'grounding-test'],
    ['grounding-test///', 'grounding-test'],
    ['sail-proxy/blobs', 'sail-proxy/blobs'],
  ])('normalises prefix %p', async (prefix, normalised) => {
    expect((await stub.backend({ prefix }).put(SHA_A, Buffer.from('x'), 'a/b')).location)
      .toBe(`${normalised}/aa/${SHA_A}`);
  });

  it.each([
    [{ bucket: '' }], [{ bucket: 'a/b' }], [{ bucket: 'UPPER' }], [{ region: '' }],
    [{ bucket: 'ab' }], [{ bucket: 'a'.repeat(64) }], [{ bucket: 'my..bucket' }], [{ bucket: 'my.-bucket' }],
    [{ bucket: 'my-.bucket' }], [{ bucket: '192.168.5.4' }], [{ bucket: '-bucket' }], [{ bucket: 'bucket-' }],
    [{ bucket: 'xn--bucket' }], [{ bucket: 'sthree-bucket' }], [{ bucket: 'bucket-s3alias' }],
    [{ bucket: 'bucket--ol-s3' }], [{ bucket: 'bucket.mrap' }], [{ bucket: 'bucket--x-s3' }],
    [{ endpoint: 'ftp://host' }], [{ endpoint: 'http://user:pw@host' }], [{ endpoint: 'http://host/path' }],
    [{ endpoint: 'http://host/?q=1' }], [{ endpoint: 'not a url' }],
  ])('refuses config %p', (over) => {
    expect(() => createS3Backend(stub.cfg(over as Partial<S3BackendConfig>))).toThrow(S3ConfigError);
  });

  it.each(['abc', 'a'.repeat(63), 'my.bucket.name', 'my-bucket-1', '1-bucket', 'test-bucket'])(
    'accepts bucket %p', (bucket) => {
      expect(() => createS3Backend(stub.cfg({ bucket }))).not.toThrow();
    },
  );

  it('a config error does not echo credentials-bearing endpoints', () => {
    try {
      createS3Backend(stub.cfg({ endpoint: 'http://user:pw@host' }));
      throw new Error('expected a throw');
    } catch (e: any) {
      expect(e.message).not.toContain('pw');
    }
  });

  it('a stored logical location is used as-is when it matches the configured prefix', async () => {
    stub.handler = (_req, res) => res.end('ok');
    await stub.backend().get(SHA_A, `grounding-test/aa/${SHA_A}`);
    expect(stub.seen[0].url).toBe(`/test-bucket/grounding-test/aa/${SHA_A}`);
  });

  it('a legacy absolute URL location is read safely: the key is derived, the stored host is ignored', async () => {
    stub.handler = (_req, res) => res.end('ok');
    const b = stub.backend();
    expect((await b.get(SHA_A, `https://legacy.example.invalid/test-bucket/grounding-test/aa/${SHA_A}`))?.toString())
      .toBe('ok');
    expect((await b.get(SHA_A, `https://test-bucket.s3.eu-central-1.amazonaws.com/grounding-test/aa/${SHA_A}`))?.toString())
      .toBe('ok');
    expect(stub.seen.map((s) => s.url)).toEqual([
      `/test-bucket/grounding-test/aa/${SHA_A}`, `/test-bucket/grounding-test/aa/${SHA_A}`,
    ]);
  });

  it.each([
    `other-prefix/aa/${SHA_A}`,
    `grounding-test/bb/${SHA_A}`,
    `grounding-test/aa/${SHA_F}`,
    `grounding-test/../aa/${SHA_A}`,
    `/grounding-test/aa/${SHA_A}`,
    `https://host/other-bucket/other/aa/${SHA_A}`,
    'garbage',
  ])('refuses location %p without sending a request', async (location) => {
    const b = stub.backend();
    for (const p of [b.get(SHA_A, location), b.delete(SHA_A, location), b.exists(SHA_A, location)]) {
      expect(await rejection(p)).toBeInstanceOf(S3LocationError);
    }
    expect(stub.seen).toHaveLength(0);
  });
});

describe('s3Backend: prefix confinement (shared bucket rule)', () => {
  const goodShas = [SHA_A, SHA_0, SHA_F, SHA_MIX];
  const badShas = ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `../${'a'.repeat(61)}`,
    `aa/${'a'.repeat(61)}`, '%2e%2e', 'g'.repeat(64), `${'a'.repeat(63)}\n`];
  const prefixes = ['grounding-test', 'grounding-test/', 'grounding-test/nested/deeper/', 'p', 'a.b_c-d/e'];

  async function exercise(b: ReturnType<typeof createS3Backend>): Promise<void> {
    for (const sha of goodShas) {
      await b.put(sha, Buffer.from('x'), 'text/plain').catch(() => undefined);
      await b.get(sha).catch(() => undefined);
      await b.exists(sha).catch(() => undefined);
      await b.delete(sha).catch(() => undefined);
    }
    for (const sha of badShas) {
      await expect(b.put(sha, Buffer.from('x'), 'text/plain')).rejects.toThrow();
      await expect(b.get(sha)).rejects.toThrow();
      await expect(b.exists(sha)).rejects.toThrow();
      await expect(b.delete(sha)).rejects.toThrow();
    }
    // The probe: a PUT and a GET of the fixed probe object, under the prefix like every key.
    await b.probe().catch(() => undefined);
  }

  function normalisedPrefix(p: string): string {
    return p.replace(/\/+$/, '');
  }

  it.each(prefixes)('path-style: every request against the stub is under %p', async (prefix) => {
    // Alternate statuses so success and error branches are both exercised.
    let n = 0;
    stub.handler = (req, res) => {
      req.resume();
      res.statusCode = [200, 404, 403, 500][n++ % 4];
      res.end();
    };
    await exercise(stub.backend({ prefix }));
    const base = `/test-bucket/${normalisedPrefix(prefix)}/`;
    expect(stub.seen.length).toBe(goodShas.length * 4 + 2);
    for (const { method, url } of stub.seen) {
      const underPrefix = url.startsWith(base) && !url.includes('..') && !url.includes('?');
      expect({ method, url, ok: underPrefix }).toEqual({ method, url, ok: true });
    }
  });

  it.each(prefixes)('virtual-host: every request is under %p', async (prefix) => {
    const urls: Array<{ method: string; url: string }> = [];
    const configs: any[] = [];
    jest.spyOn(axios, 'request').mockImplementation(async (config: any) => {
      urls.push({ method: String(config.method).toUpperCase(), url: config.url });
      configs.push(config);
      return { status: 200, data: Buffer.alloc(0), headers: {} } as any;
    });
    await exercise(createS3Backend(stub.cfg({ prefix, endpoint: '', region: 'eu-central-1' }), { credentials: STUB_CREDENTIALS }));
    const host = 'https://test-bucket.s3.eu-central-1.amazonaws.com';
    const base = `${host}/${normalisedPrefix(prefix)}/`;
    expect(urls.length).toBe(goodShas.length * 4 + 2);
    // Asserted here, not inside the mock: exercise() swallows rejections.
    for (const config of configs) {
      expect(config.maxRedirects).toBe(0);
      expect(config.signal).toBeInstanceOf(AbortSignal);
      expect(config.timeout).toBe(config.method === 'GET' ? 30_000 : 0);
    }
    for (const { method, url } of urls) {
      const underPrefix = url.startsWith(base) && !url.includes('..') && !url.includes('?');
      expect({ method, url, ok: underPrefix }).toEqual({ method, url, ok: true });
    }
  });
});

describe('s3Backend: credentials', () => {
  const credentialOf = () => /Credential=([^/]+)\//.exec(String(stub.seen[0].headers.authorization))?.[1];

  it('signs with injected credentials and never needs the product env vars', async () => {
    expect(process.env.FILE_SEARCH_S3_ACCESS_KEY_ID).toBeUndefined();
    await stub.backend().exists(SHA_A);
    expect(credentialOf()).toBe('AKIDTESTONLY');
  });

  it('falls back to FILE_SEARCH_S3_* only when nothing is injected, and fails clearly without either', async () => {
    const b = createS3Backend(stub.cfg());
    await expect(b.exists(SHA_A)).rejects.toThrow(S3ConfigError);
    expect(stub.seen).toHaveLength(0);
    // Fake values; test/setupTests.ts deletes them again after this test.
    process.env.FILE_SEARCH_S3_ACCESS_KEY_ID = 'AKIDFROMENV';
    process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY = 'env-secret-only';
    await b.exists(SHA_A);
    expect(credentialOf()).toBe('AKIDFROMENV');
  });

  it('refuses incomplete injected credentials rather than fall back', async () => {
    process.env.FILE_SEARCH_S3_ACCESS_KEY_ID = 'AKIDFROMENV';
    process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY = 'env-secret-only';
    const b = createS3Backend(stub.cfg(), { credentials: { accessKeyId: 'AKIDTESTONLY', secretAccessKey: '' } });
    await expect(b.exists(SHA_A)).rejects.toThrow('the injected S3 credentials are incomplete');
    expect(stub.seen).toHaveLength(0);
  });
});
