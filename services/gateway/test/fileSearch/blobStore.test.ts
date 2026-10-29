import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { sha256Of } from '../../src/fileSearch/blob/blobStore';
import { createLocalBackend } from '../../src/fileSearch/blob/localBackend';

// 'local' stays refused for new writes; 's3' is built from blob_storage.s3
// (blobLifecycle.test.ts covers reads, release and revive). mockBackend is
// mutated per test below; the `mock` name prefix is required for Jest's
// module-factory hoisting to allow referencing it from inside jest.mock().
let mockBackend: string = 'db';
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({
    blobStorage: {
      backend: mockBackend,
      localPath: '/tmp/unused',
      s3: { bucket: '', prefix: '', endpoint: '', region: '' },
    },
  }),
}));

// eslint-disable-next-line import/first
import { getBackend, UnsupportedBlobBackendError } from '../../src/fileSearch/blob/blobStore';
// eslint-disable-next-line import/first
import { S3ConfigError } from '../../src/fileSearch/blob/s3Backend';

describe('getBackend backend gating', () => {
  beforeEach(() => { mockBackend = 'db'; });

  it('"db" resolves to a working backend with the full BlobBackend shape', () => {
    const backend = getBackend();
    expect(typeof backend.put).toBe('function');
    expect(typeof backend.get).toBe('function');
    expect(typeof backend.delete).toBe('function');
    expect(typeof backend.exists).toBe('function');
  });

  it('"local" is refused with a clear, typed error rather than being constructed', () => {
    mockBackend = 'local';
    expect(() => getBackend()).toThrow(UnsupportedBlobBackendError);
    expect(() => getBackend()).toThrow(/"local" is not supported/i);
  });

  it('"s3" is not refused: it is built from blob_storage.s3, whose gaps are a config error', () => {
    mockBackend = 's3';
    expect(() => getBackend()).toThrow(S3ConfigError);
    expect(() => getBackend()).not.toThrow(UnsupportedBlobBackendError);
  });
});

describe('sha256Of', () => {
  it('is stable and content-addressed', () => {
    expect(sha256Of(Buffer.from('hello'))).toBe(sha256Of(Buffer.from('hello')));
    expect(sha256Of(Buffer.from('hello'))).not.toBe(sha256Of(Buffer.from('hellp')));
    expect(sha256Of(Buffer.from('hello'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('localBackend', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blob-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('round-trips bytes and shards by hash prefix', async () => {
    const b = createLocalBackend(dir);
    const bytes = Buffer.from('some document text');
    const sha = sha256Of(bytes);
    await b.put(sha, bytes, 'text/plain');
    expect(await b.exists(sha)).toBe(true);
    expect((await b.get(sha))!.equals(bytes)).toBe(true);
    await expect(fs.stat(path.join(dir, sha.slice(0, 2), sha))).resolves.toBeDefined();
  });

  it('returns null rather than throwing for an absent blob', async () => {
    expect(await createLocalBackend(dir).get('0'.repeat(64))).toBeNull();
  });

  it('refuses a path-traversal key', async () => {
    await expect(createLocalBackend(dir).get('../../etc/passwd')).rejects.toThrow(/Invalid sha256/);
  });

  it('delete is idempotent', async () => {
    const b = createLocalBackend(dir);
    await b.delete('a'.repeat(64));        // must not throw
    await b.delete('a'.repeat(64));
  });
});
