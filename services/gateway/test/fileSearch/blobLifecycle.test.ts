/**
 * Blob lifecycle against a fake database client and a fake S3 backend (no Postgres, no network):
 * reads dispatch on the row's stored `storage`/`location`, never on the configured backend;
 * release only marks the row inside the caller's transaction; a pending row is revived with a
 * re-PUT; every retain takes the per-sha advisory lock before it looks at the row; the
 * configuration is read once per operation.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const SHA = 'ab'.repeat(32);
const BYTES = Buffer.from('blob lifecycle bytes');
const KEY = `blobs/${SHA.slice(0, 2)}/${SHA}`;

type Row = {
  storage: string; location: string | null; bytes: Buffer | null; ref_count: number; delete_after: Date | null;
  size_bytes: number;
};

const state: {
  backend: 'db' | 'local' | 's3';
  configReads: number;
  rows: Row[][];
  queries: { sql: string; params: unknown[] }[];
  failOn?: RegExp;
} = { backend: 'db', configReads: 0, rows: [], queries: [] };

const fakeS3 = {
  put: jest.fn(async (..._args: unknown[]): Promise<{ location: string | null }> => ({ location: KEY })),
  get: jest.fn(async (..._args: unknown[]): Promise<Buffer | null> => BYTES),
  delete: jest.fn(async (..._args: unknown[]) => undefined),
  exists: jest.fn(async (..._args: unknown[]) => true),
  probe: jest.fn(async () => undefined),
  keyFor: jest.fn((sha: string) => `blobs/${sha.slice(0, 2)}/${sha}`),
};
const createS3Backend = jest.fn((..._args: unknown[]) => fakeS3);

jest.mock('../../src/fileSearch/blob/s3Backend', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/blob/s3Backend');
  return { ...actual, createS3Backend: (...args: unknown[]) => createS3Backend(...args) };
});

jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => {
    state.configReads += 1;
    return {
      blobStorage: {
        backend: state.backend,
        localPath: '/tmp/unused',
        s3: { bucket: 'test-bucket', prefix: 'blobs', endpoint: 'http://127.0.0.1:1', region: 'us-east-1' },
      },
      limits: { maxFileBytes: 1000 },
    };
  },
}));

function respond(sql: string, params: unknown[]): { rowCount: number; rows: unknown[] } {
  state.queries.push({ sql, params });
  if (state.failOn && state.failOn.test(sql)) throw new Error('injected failure');
  if (/FROM file_blobs/.test(sql) && /^\s*SELECT/.test(sql)) {
    const rows = state.rows.shift() ?? [];
    return { rowCount: rows.length, rows };
  }
  return { rowCount: 1, rows: [] };
}

const client = {
  query: jest.fn(async (sql: string, params: unknown[] = []) => respond(sql, params)),
  release: jest.fn(),
};
const pool = {
  connect: jest.fn(async () => client),
  query: jest.fn(async (sql: string, params: unknown[] = []) => respond(sql, params)),
};
jest.mock('../../src/fileSearch/db', () => ({ getPool: () => pool }));

// eslint-disable-next-line import/first
import {
  openBlob, retainBlob, releaseBlob, releaseBlobIn, getBackend, lockBlobSha, blobLockKey,
  BLOB_LOCK_CLASS, BLOB_RELEASE_GRACE_SECONDS, BlobUnavailableError, UnsupportedBlobBackendError, GET_SIZE_MARGIN_BYTES,
  setBlobS3CredentialsForTests,
} from '../../src/fileSearch/blob/blobStore';
// eslint-disable-next-line import/first
import { S3ConfigError, S3LocationError, S3RequestError } from '../../src/fileSearch/blob/s3Backend';

const sqls = () => state.queries.map((q) => q.sql.replace(/\s+/g, ' ').trim());
const row = (over: Partial<Row>): Row => ({
  storage: 'db', location: null, bytes: null, ref_count: 1, delete_after: null, size_bytes: BYTES.length, ...over,
});

beforeEach(() => {
  state.backend = 'db';
  state.configReads = 0;
  state.rows = [];
  state.queries = [];
  state.failOn = undefined;
  for (const fn of [fakeS3.put, fakeS3.get, fakeS3.delete, fakeS3.exists, createS3Backend, client.query, client.release, pool.connect, pool.query]) {
    (fn as jest.Mock).mockClear();
  }
  fakeS3.put.mockImplementation(async () => ({ location: KEY }));
  fakeS3.get.mockImplementation(async () => BYTES);
  createS3Backend.mockImplementation(() => fakeS3);
  setBlobS3CredentialsForTests(null);
});

describe('openBlob dispatches on the stored storage, not on the configured backend', () => {
  it('a db row returns the bytes of the same statement, even while s3 is configured', async () => {
    state.backend = 's3';
    state.rows = [[row({ storage: 'db', bytes: BYTES })]];
    expect((await openBlob(SHA)).equals(BYTES)).toBe(true);
    expect(createS3Backend).not.toHaveBeenCalled();
    expect(sqls()[0]).toMatch(/SELECT storage, location, bytes, size_bytes FROM file_blobs WHERE sha256 = \$1/);
  });

  it('an s3 row is read from S3 at its stored location while db is configured', async () => {
    state.backend = 'db';
    state.rows = [[row({ storage: 's3', location: KEY })]];
    expect((await openBlob(SHA)).equals(BYTES)).toBe(true);
    expect(fakeS3.get).toHaveBeenCalledWith(SHA, KEY, BYTES.length + GET_SIZE_MARGIN_BYTES);
    expect(state.configReads).toBe(1);
  });

  it('passes the injected test credentials to the S3 backend', async () => {
    setBlobS3CredentialsForTests({ accessKeyId: 'AKIDTESTONLY', secretAccessKey: 'test-secret-only' });
    state.rows = [[row({ storage: 's3', location: KEY })]];
    await openBlob(SHA);
    expect(createS3Backend).toHaveBeenCalledWith(
      { bucket: 'test-bucket', prefix: 'blobs', endpoint: 'http://127.0.0.1:1', region: 'us-east-1' },
      { credentials: { accessKeyId: 'AKIDTESTONLY', secretAccessKey: 'test-secret-only' } },
    );
  });

  it('a location outside the configured prefix is unavailable (location_unreachable)', async () => {
    fakeS3.get.mockImplementation(async () => { throw new S3LocationError(); });
    state.rows = [[row({ storage: 's3', location: 'old-prefix/ab/x' })]];
    const err = await openBlob(SHA).catch((e: any) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('location_unreachable');
    expect(err.storage).toBe('s3');
  });

  it('missing S3 configuration or credentials is unavailable', async () => {
    createS3Backend.mockImplementation(() => { throw new S3ConfigError('bucket is missing or not a valid bucket name'); });
    state.rows = [[row({ storage: 's3', location: KEY })]];
    const err = await openBlob(SHA).catch((e: any) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('not_configured');
  });

  it('a failed GET (a 403 is never read as "absent") is unavailable', async () => {
    fakeS3.get.mockImplementation(async () => { throw new S3RequestError('GetObject', 403, 'AccessDenied'); });
    state.rows = [[row({ storage: 's3', location: KEY })]];
    const err = await openBlob(SHA).catch((e: any) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('request_failed');
    expect(err.message).not.toMatch(/127\.0\.0\.1|test-bucket|blobs\//);
  });

  it('an object gone from S3 re-reads the row once and follows a moved blob', async () => {
    fakeS3.get.mockImplementation(async () => null);
    state.rows = [[row({ storage: 's3', location: KEY })], [row({ storage: 'db', bytes: BYTES })]];
    expect((await openBlob(SHA)).equals(BYTES)).toBe(true);
    expect(fakeS3.get).toHaveBeenCalledTimes(1);
  });

  it('an object gone from S3 whose row did not move is unavailable (missing)', async () => {
    fakeS3.get.mockImplementation(async () => null);
    state.rows = [[row({ storage: 's3', location: KEY })], [row({ storage: 's3', location: KEY })]];
    const err = await openBlob(SHA).catch((e: any) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('missing');
    expect(fakeS3.get).toHaveBeenCalledTimes(1);
  });

  it.each(['local', 'inline', 'gcs'])('a row stored as "%s" is unavailable, not read from the configured backend', async (storage) => {
    state.rows = [[row({ storage, location: '/x' })]];
    const err = await openBlob(SHA).catch((e: any) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('unsupported_storage');
    expect(createS3Backend).not.toHaveBeenCalled();
  });

  it('no row, or a db row without bytes, is unavailable (missing)', async () => {
    state.rows = [[]];
    expect((await openBlob(SHA).catch((e: any) => e)).reason).toBe('missing');
    state.rows = [[row({ storage: 'db', bytes: null })]];
    expect((await openBlob(SHA).catch((e: any) => e)).reason).toBe('missing');
  });
});

describe('release marks the row inside the caller\'s transaction and does no I/O', () => {
  it('the last reference sets ref_count 0 and delete_after = now() + grace on the given client only', async () => {
    state.rows = [[{ ref_count: 1 } as any]];
    const result = await releaseBlobIn(client as any, SHA);
    expect(result).toEqual({ pendingDelete: true });
    const s = sqls();
    expect(s).toEqual([
      'SELECT ref_count FROM file_blobs WHERE sha256 = $1 FOR UPDATE',
      expect.stringMatching(/^UPDATE file_blobs SET ref_count = 0, delete_after = now\(\) \+ make_interval\(secs => \$2\) WHERE sha256 = \$1$/),
    ]);
    expect(state.queries[1].params).toEqual([SHA, BLOB_RELEASE_GRACE_SECONDS]);
    expect(s).not.toContain('BEGIN');
    expect(s).not.toContain('COMMIT');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(createS3Backend).not.toHaveBeenCalled();
    expect(fakeS3.delete).not.toHaveBeenCalled();
    expect(s.join('\n')).not.toMatch(/DELETE FROM file_blobs/);
  });

  it('another reference remaining only decrements', async () => {
    state.rows = [[{ ref_count: 3 } as any]];
    expect(await releaseBlobIn(client as any, SHA)).toEqual({ pendingDelete: false });
    expect(sqls()[1]).toBe('UPDATE file_blobs SET ref_count = $2 WHERE sha256 = $1');
    expect(state.queries[1].params).toEqual([SHA, 2]);
  });

  it('an unknown sha is a no-op', async () => {
    state.rows = [[]];
    expect(await releaseBlobIn(client as any, SHA)).toEqual({ pendingDelete: false });
    expect(sqls()).toHaveLength(1);
  });

  it('accepts a shorter grace (for the sweeper\'s tests)', async () => {
    state.rows = [[{ ref_count: 1 } as any]];
    await releaseBlobIn(client as any, SHA, { graceSeconds: 0 });
    expect(state.queries[1].params).toEqual([SHA, 0]);
  });

  it('releaseBlob wraps the same statements in its own transaction, still without I/O', async () => {
    state.rows = [[{ ref_count: 1 } as any]];
    expect(await releaseBlob(SHA)).toEqual({ pendingDelete: true });
    expect(sqls()[0]).toBe('BEGIN');
    expect(sqls()[sqls().length - 1]).toBe('COMMIT');
    expect(createS3Backend).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });
});

describe('retain', () => {
  it('takes the per-sha advisory lock before it reads the row', async () => {
    state.rows = [[]];
    await retainBlob(SHA, BYTES, 'text/plain');
    const s = sqls();
    expect(s[0]).toBe('BEGIN');
    expect(s[1]).toBe('SELECT pg_advisory_xact_lock($1::int4, $2::int4)');
    expect(state.queries[1].params).toEqual([BLOB_LOCK_CLASS, blobLockKey(SHA)]);
    expect(s[2]).toMatch(/FROM file_blobs WHERE sha256 = \$1 FOR UPDATE/);
  });

  it('a new sha on db writes the bytes into the row; no S3 backend is built', async () => {
    state.rows = [[]];
    expect(await retainBlob(SHA, BYTES, 'text/plain')).toEqual({ deduplicated: false });
    const insert = state.queries.find((q) => /INSERT INTO file_blobs/.test(q.sql))!;
    expect(insert.params).toEqual([SHA, BYTES.length, 'text/plain', 'db', BYTES, null]);
    expect(createS3Backend).not.toHaveBeenCalled();
    expect(sqls()[sqls().length - 1]).toBe('COMMIT');
  });

  it('a new sha on s3 PUTs, records the logical key, and cancels a pending garbage delete of that key', async () => {
    state.backend = 's3';
    state.rows = [[]];
    await retainBlob(SHA, BYTES, 'text/plain');
    expect(fakeS3.put).toHaveBeenCalledWith(SHA, BYTES, 'text/plain');
    const insert = state.queries.find((q) => /INSERT INTO file_blobs/.test(q.sql))!;
    expect(insert.params).toEqual([SHA, BYTES.length, 'text/plain', 's3', null, KEY]);
    const garbage = state.queries.find((q) => /DELETE FROM file_blob_garbage/.test(q.sql))!;
    expect(garbage.params).toEqual(['s3', KEY]);
  });

  it('reads the configuration once: a reload mid-operation cannot split backend and recorded storage', async () => {
    state.backend = 's3';
    state.rows = [[]];
    fakeS3.put.mockImplementation(async () => { state.backend = 'db'; return { location: KEY }; });
    await retainBlob(SHA, BYTES, 'text/plain');
    expect(state.configReads).toBe(1);
    const insert = state.queries.find((q) => /INSERT INTO file_blobs/.test(q.sql))!;
    expect(insert.params[3]).toBe('s3');
  });

  it('a live db row only increments while db is configured', async () => {
    state.rows = [[row({ storage: 'db', ref_count: 2 })]];
    expect(await retainBlob(SHA, BYTES, 'text/plain')).toEqual({ deduplicated: true });
    expect(createS3Backend).not.toHaveBeenCalled();
    const update = state.queries.find((q) => /UPDATE file_blobs SET ref_count = ref_count \+ 1/.test(q.sql))!;
    expect(update.params).toEqual([SHA, null]);
  });

  it('revives a pending s3 row with a re-PUT to its own storage, even while db is configured', async () => {
    state.backend = 'db';
    // Read twice: the first attempt finds it needs S3 under the lock, rolls back and retries holding a slot.
    const pending = row({ storage: 's3', location: KEY, ref_count: 0, delete_after: new Date() });
    state.rows = [[pending], [pending]];
    expect(await retainBlob(SHA, BYTES, 'text/plain')).toEqual({ deduplicated: true });
    expect(sqls().filter((q) => q === 'ROLLBACK')).toHaveLength(1);
    expect(fakeS3.put).toHaveBeenCalledWith(SHA, BYTES, 'text/plain');
    expect(fakeS3.exists).not.toHaveBeenCalled();
    const revive = state.queries.find((q) => /delete_after = NULL/.test(q.sql))!;
    expect(revive.sql.replace(/\s+/g, ' ')).toMatch(/SET ref_count = ref_count \+ 1, delete_after = NULL, location = \$2/);
    expect(revive.params).toEqual([SHA, KEY]);
    expect(state.queries.find((q) => /DELETE FROM file_blob_garbage/.test(q.sql))!.params).toEqual(['s3', KEY]);
  });

  it('revives a pending db row without any backend call while db is configured', async () => {
    state.rows = [[row({ storage: 'db', ref_count: 0, delete_after: new Date() })]];
    await retainBlob(SHA, BYTES, 'text/plain');
    expect(createS3Backend).not.toHaveBeenCalled();
    expect(state.queries.find((q) => /delete_after = NULL/.test(q.sql))!.params).toEqual([SHA, null]);
  });

  it('a failed revive PUT rolls back and reports the blob storage unavailable', async () => {
    fakeS3.put.mockImplementation(async () => { throw new S3RequestError('PutObject', 503, 'SlowDown'); });
    const pending = row({ storage: 's3', location: KEY, ref_count: 0, delete_after: new Date() });
    state.rows = [[pending], [pending]];
    const err = await retainBlob(SHA, BYTES, 'text/plain').catch((e: any) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('request_failed');
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls().some((s) => /delete_after = NULL/.test(s))).toBe(false);
  });

  it('a pending row of an unsupported storage is not revived', async () => {
    const pending = row({ storage: 'local', location: '/x', ref_count: 0, delete_after: new Date() });
    state.rows = [[pending], [pending]];
    const err = await retainBlob(SHA, BYTES, 'text/plain').catch((e: any) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('unsupported_storage');
    expect(sqls()).toContain('ROLLBACK');
  });
});

describe('backend selection and the lock key', () => {
  it('getBackend refuses only "local"', () => {
    state.backend = 'local';
    expect(() => getBackend()).toThrow(UnsupportedBlobBackendError);
    expect(() => getBackend()).toThrow(/"local" is not supported/);
    state.backend = 's3';
    expect(getBackend()).toBe(fakeS3);
    state.backend = 'db';
    expect(typeof getBackend().get).toBe('function');
  });

  it('the unsupported-backend message no longer claims s3 is refused or lacks timeouts', () => {
    const message = new UnsupportedBlobBackendError('local').message;
    expect(message).not.toMatch(/timeout|experimental|Plan 3/i);
    expect(message).toMatch(/"db" or "s3"/);
  });

  it('the lock key is the sha\'s first 32 bits as a signed int4, under the "blob" class', async () => {
    expect(BLOB_LOCK_CLASS).toBe(0x626c6f62);
    expect(blobLockKey('00000001' + '0'.repeat(56))).toBe(1);
    expect(blobLockKey('ffffffff' + '0'.repeat(56))).toBe(-1);
    expect(blobLockKey('7fffffff' + 'f'.repeat(56))).toBe(2147483647);
    expect(() => blobLockKey('xyz')).toThrow(/Invalid sha256/);
    await lockBlobSha(client as any, SHA);
    expect(state.queries[0]).toEqual({ sql: 'SELECT pg_advisory_xact_lock($1::int4, $2::int4)', params: [BLOB_LOCK_CLASS, blobLockKey(SHA)] });
  });
});
