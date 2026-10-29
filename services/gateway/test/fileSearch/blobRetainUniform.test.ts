/**
 * An upload's storage work and status do not reveal whether its content exists already: with an
 * external backend configured, every retain PUTs the bytes to the content-addressed key, a
 * duplicate as much as new content, and fails the same way when the storage is down. An object
 * written for a row that lives in another storage (db) is queued as garbage under the lock. Every
 * S3 request made under a connection holds an S3 slot taken BEFORE the connection.
 * Fake database client and fake S3 backend: no Postgres, no network.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const SHA = 'cd'.repeat(32);
const BYTES = Buffer.from('uniform retain bytes');
const KEY = `blobs/${SHA.slice(0, 2)}/${SHA}`;

type Row = { storage: string; location: string | null; delete_after: Date | null };

const state: { backend: string; rows: Row[][]; queries: { sql: string; params: unknown[] }[] } = {
  backend: 's3', rows: [], queries: [],
};

const fakeS3 = {
  put: jest.fn(async (..._args: unknown[]): Promise<{ location: string | null }> => ({ location: KEY })),
  get: jest.fn(async (..._args: unknown[]): Promise<Buffer | null> => BYTES),
  delete: jest.fn(async (..._args: unknown[]) => undefined),
  exists: jest.fn(async (..._args: unknown[]) => true),
};
const createS3Backend = jest.fn((..._args: unknown[]): unknown => fakeS3);

jest.mock('../../src/fileSearch/blob/s3Backend', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/blob/s3Backend');
  return { ...actual, createS3Backend: (...args: unknown[]) => createS3Backend(...args) };
});

jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({
    blobStorage: {
      backend: state.backend,
      localPath: '/tmp/unused',
      s3: { bucket: 'test-bucket', prefix: 'blobs', endpoint: 'http://127.0.0.1:1', region: 'us-east-1' },
    },
    limits: { maxFileBytes: 1000 },
  }),
}));

function respond(sql: string, params: unknown[]): { rowCount: number; rows: unknown[] } {
  state.queries.push({ sql, params });
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
const pool = { connect: jest.fn(async () => client) };
jest.mock('../../src/fileSearch/db', () => ({ getPool: () => pool }));

// eslint-disable-next-line import/first
import {
  retainBlob, BlobUnavailableError, UnsupportedBlobBackendError, BLOB_RELEASE_GRACE_SECONDS,
} from '../../src/fileSearch/blob/blobStore';
// eslint-disable-next-line import/first
import { S3ConfigError, S3RequestError } from '../../src/fileSearch/blob/s3Backend';
// eslint-disable-next-line import/first
import {
  withS3Slot, withS3SlotIfNeeded, NeedsS3SlotError, S3SlotBusyError, S3_SLOTS, s3SlotStateForTests,
} from '../../src/fileSearch/blob/s3Slots';

const sqls = () => state.queries.map((q) => q.sql.replace(/\s+/g, ' ').trim());
const row = (over: Partial<Row>): Row => ({ storage: 's3', location: KEY, delete_after: null, ...over });

beforeEach(() => {
  state.backend = 's3';
  state.rows = [];
  state.queries = [];
  for (const fn of [fakeS3.put, createS3Backend, client.query, client.release, pool.connect]) (fn as jest.Mock).mockClear();
  fakeS3.put.mockImplementation(async () => ({ location: KEY }));
  createS3Backend.mockImplementation(() => fakeS3);
});

describe('with s3 configured, a duplicate does the same storage work as new content', () => {
  it('new content: PUT, then INSERT', async () => {
    state.rows = [[]];
    expect(await retainBlob(SHA, BYTES, 'text/plain')).toEqual({ deduplicated: false });
    expect(fakeS3.put).toHaveBeenCalledTimes(1);
    expect(fakeS3.put).toHaveBeenCalledWith(SHA, BYTES, 'text/plain');
    expect(sqls().some((s) => s.startsWith('INSERT INTO file_blobs'))).toBe(true);
  });

  it('a live s3 row: the same PUT, ref_count + 1, the key cancelled from garbage, the location kept current', async () => {
    state.rows = [[row({})]];
    expect(await retainBlob(SHA, BYTES, 'text/plain')).toEqual({ deduplicated: true });
    expect(fakeS3.put).toHaveBeenCalledTimes(1);
    expect(fakeS3.put).toHaveBeenCalledWith(SHA, BYTES, 'text/plain');
    expect(state.queries.find((q) => /DELETE FROM file_blob_garbage/.test(q.sql))!.params).toEqual(['s3', KEY]);
    const update = state.queries.find((q) => /UPDATE file_blobs SET ref_count = ref_count \+ 1/.test(q.sql))!;
    expect(update.params).toEqual([SHA, KEY]);
    expect(sqls().some((s) => /INSERT INTO file_blob_garbage/.test(s))).toBe(false);
  });

  it('the PUT comes after the lock and the row read, inside the transaction', async () => {
    state.rows = [[row({})]];
    const order: string[] = [];
    client.query.mockImplementation(async (sql: string, params: unknown[] = []) => { order.push(sql.trim().split(/\s+/)[0]); return respond(sql, params); });
    fakeS3.put.mockImplementation(async () => { order.push('PUT'); return { location: KEY }; });
    await retainBlob(SHA, BYTES, 'text/plain');
    expect(order.slice(0, 4)).toEqual(['BEGIN', 'SELECT', 'SELECT', 'PUT']);
    expect(order[order.length - 1]).toBe('COMMIT');
    client.query.mockImplementation(async (sql: string, params: unknown[] = []) => respond(sql, params));
  });

  it('an existing db row: the object written belongs to no row and is queued as garbage under the lock', async () => {
    state.rows = [[row({ storage: 'db', location: null })]];
    expect(await retainBlob(SHA, BYTES, 'text/plain')).toEqual({ deduplicated: true });
    expect(fakeS3.put).toHaveBeenCalledTimes(1);
    const garbage = state.queries.find((q) => /INSERT INTO file_blob_garbage/.test(q.sql))!;
    expect(garbage.params).toEqual(['s3', KEY, SHA, BLOB_RELEASE_GRACE_SECONDS]);
    // queued before COMMIT, i.e. under the advisory lock
    expect(sqls().indexOf(garbage.sql.replace(/\s+/g, ' ').trim())).toBeLessThan(sqls().indexOf('COMMIT'));
    const update = state.queries.find((q) => /UPDATE file_blobs SET ref_count = ref_count \+ 1/.test(q.sql))!;
    expect(update.params).toEqual([SHA, null]); // the row stays on db
  });

  it('a pending db row is revived the same way, its extra object queued', async () => {
    state.rows = [[row({ storage: 'db', location: null, delete_after: new Date() })]];
    await retainBlob(SHA, BYTES, 'text/plain');
    expect(fakeS3.put).toHaveBeenCalledTimes(1);
    expect(sqls().some((s) => /INSERT INTO file_blob_garbage/.test(s))).toBe(true);
    expect(sqls().some((s) => /delete_after = NULL/.test(s))).toBe(true);
  });

  it('an S3 outage answers the same for new and duplicate content (503 blob_storage_unavailable upstream)', async () => {
    fakeS3.put.mockImplementation(async () => { throw new S3RequestError('PutObject', 503, 'SlowDown'); });
    const outcomes: unknown[] = [];
    for (const existing of [[], [row({})], [row({ storage: 'db', location: null })]]) {
      state.rows = [existing];
      const err: any = await retainBlob(SHA, BYTES, 'text/plain').catch((e) => e);
      expect(err).toBeInstanceOf(BlobUnavailableError);
      outcomes.push({ name: err.name, storage: err.storage, reason: err.reason, message: err.message });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
    expect(sqls().filter((s) => s === 'COMMIT')).toHaveLength(0);
  });

  it('a missing S3 configuration answers the same for duplicates, before any database work', async () => {
    createS3Backend.mockImplementation(() => { throw new S3ConfigError('bucket is missing or not a valid bucket name'); });
    state.rows = [[row({ storage: 'db', location: null })]];
    const err: any = await retainBlob(SHA, BYTES, 'text/plain').catch((e) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('not_configured');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('"local" refuses every upload, duplicates included, before any database work', async () => {
    state.backend = 'local';
    state.rows = [[row({ storage: 'db', location: null })]];
    await expect(retainBlob(SHA, BYTES, 'text/plain')).rejects.toBeInstanceOf(UnsupportedBlobBackendError);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('S3 slots', () => {
  it('the slot is taken before the connection: with every slot busy, a retain does not connect', async () => {
    const releases: Array<() => void> = [];
    const holders = Array.from({ length: S3_SLOTS }, () => withS3Slot(() => new Promise<void>((r) => releases.push(r))));
    await new Promise((r) => setImmediate(r));
    expect(s3SlotStateForTests().free).toBe(0);
    state.rows = [[]];
    const retain = retainBlob(SHA, BYTES, 'text/plain');
    await new Promise((r) => setTimeout(r, 20));
    expect(pool.connect).not.toHaveBeenCalled();
    expect(s3SlotStateForTests().waiting).toBe(1);
    releases[0]();
    await retain;
    expect(pool.connect).toHaveBeenCalledTimes(1);
    releases.slice(1).forEach((r) => r());
    await Promise.all(holders);
    expect(s3SlotStateForTests()).toEqual({ free: S3_SLOTS, waiting: 0 });
  });

  it('a retain that waits too long for a slot is unavailable (503), and holds no connection', async () => {
    jest.useFakeTimers();
    try {
      const releases: Array<() => void> = [];
      const holders = Array.from({ length: S3_SLOTS }, () => withS3Slot(() => new Promise<void>((r) => releases.push(r))));
      await Promise.resolve();
      const retain = retainBlob(SHA, BYTES, 'text/plain').catch((e) => e);
      await jest.advanceTimersByTimeAsync(15_000);
      const err: any = await retain;
      expect(err).toBeInstanceOf(BlobUnavailableError);
      expect(err.reason).toBe('request_failed');
      expect(pool.connect).not.toHaveBeenCalled();
      releases.forEach((r) => r());
      await Promise.all(holders);
    } finally {
      jest.useRealTimers();
    }
    expect(s3SlotStateForTests()).toEqual({ free: S3_SLOTS, waiting: 0 });
  });

  it('a slot is released when the work fails', async () => {
    await expect(withS3Slot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    fakeS3.put.mockImplementation(async () => { throw new S3RequestError('PutObject', 500, 'InternalError'); });
    state.rows = [[]];
    await retainBlob(SHA, BYTES, 'text/plain').catch(() => undefined);
    expect(s3SlotStateForTests()).toEqual({ free: S3_SLOTS, waiting: 0 });
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('never more than S3_SLOTS run at once', async () => {
    let running = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 10 }, () => withS3Slot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    })));
    expect(peak).toBe(S3_SLOTS);
  });

  it('withS3SlotIfNeeded runs again holding a slot when the first attempt needs one', async () => {
    const seen: boolean[] = [];
    const value = await withS3SlotIfNeeded(false, async (holding) => {
      seen.push(holding);
      if (!holding) throw new NeedsS3SlotError();
      return 'done';
    });
    expect(value).toBe('done');
    expect(seen).toEqual([false, true]);
  });

  it('a wait with a limit rejects with S3SlotBusyError and leaves no waiter behind', async () => {
    const releases: Array<() => void> = [];
    const holders = Array.from({ length: S3_SLOTS }, () => withS3Slot(() => new Promise<void>((r) => releases.push(r))));
    await Promise.resolve();
    await expect(withS3Slot(async () => 'x', { waitMs: 10 })).rejects.toBeInstanceOf(S3SlotBusyError);
    expect(s3SlotStateForTests().waiting).toBe(0);
    releases.forEach((r) => r());
    await Promise.all(holders);
  });
});
