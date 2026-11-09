// The blob sweeper against a real Postgres (and, when FILE_SEARCH_TEST_S3_* is set, a real MinIO):
// deterministic interleavings with retain (revive first; a new retain waiting while the sweeper
// deletes), refcount drift (23503) repaired, a deadlock (40P01) skipped, a failed object delete or
// a failed COMMIT keeping the row, unaddressable storages handed to file_blob_garbage, and the
// garbage queue. Object deletes are faked through backendForStorage except in the MinIO block.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import * as blobStore from '../../../src/fileSearch/blob/blobStore';
import { retainBlob, releaseBlobIn, openBlob, sha256Of, setBlobS3CredentialsForTests } from '../../../src/fileSearch/blob/blobStore';
import { sweepBlobs, __resetWarningsForTests } from '../../../src/fileSearch/blob/blobSweeper';
import { createS3Backend, S3RequestError } from '../../../src/fileSearch/blob/s3Backend';
import { getDefaultLogger } from '@libs/logger';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { s3TestConfigFromEnv } = require('../../../../../ci/scripts/file-search-test-s3.js');

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const S3 = s3TestConfigFromEnv(process.env);
const d = DSN ? describe : describe.skip;
const dS3 = DSN && S3 ? describe : describe.skip;

const NO_S3 = { bucket: '', prefix: '', endpoint: '', region: '' };
// Never contacted: the fake backend answers, or the missing credentials fail first.
const FAKE_S3 = { bucket: 'fs-sweeper-test', prefix: 'sweeper-test', endpoint: 'http://127.0.0.1:9', region: 'us-east-1' };
let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function freshContent(label: string): { bytes: Buffer; sha: string } {
  const bytes = Buffer.concat([Buffer.from(`${label}:`), crypto.randomBytes(256)]);
  return { bytes, sha: sha256Of(bytes) };
}
const keyOf = (prefix: string, sha: string) => `${prefix}/${sha.slice(0, 2)}/${sha}`;

d('blob sweeper against Postgres (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let warn: jest.SpyInstance;

  const blobRow = async (sha: string) => (await pool.query(
    `SELECT ref_count, storage, location, delete_after, extract(epoch FROM delete_after - now()) AS ahead
       FROM file_blobs WHERE sha256 = $1`, [sha])).rows[0];
  const garbageRow = async (storage: string, location: string) => (await pool.query(
    `SELECT sha256, attempts, last_error, extract(epoch FROM delete_after - now()) AS ahead
       FROM file_blob_garbage WHERE storage = $1 AND location = $2`, [storage, location])).rows[0];
  const addFile = (id: string, sha: string) => pool.query(
    `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes) VALUES ($1, 'sw@example.com', 'f.txt', 'assistants', $2, 1)`,
    [id, sha]);
  /** A released row already past its grace. */
  const insertPending = (sha: string, storage = 'db', location: string | null = null) => pool.query(
    `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, location, delete_after)
     VALUES ($1, 1, 'text/plain', 0, $2, $3, $4, now() - interval '1 second')`,
    [sha, storage, storage === 'db' ? Buffer.from('x') : null, location]);
  const release0 = async (sha: string) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await releaseBlobIn(client, sha, { graceSeconds: 0 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
  const fakeBackend = (del: jest.Mock) => jest.spyOn(blobStore, 'backendForStorage').mockReturnValue({
    put: jest.fn(), get: jest.fn(), exists: jest.fn(), delete: del,
  });
  const warnText = () => JSON.stringify(warn.mock.calls);

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: 3,
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 'db', localPath: '', s3: NO_S3 },
    };
    fixture = await createIsolatedSchema(DSN!, 3);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    setBlobS3CredentialsForTests(null);
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    mockConfig.blobStorage = { backend: 'db', localPath: '', s3: NO_S3 };
    setBlobS3CredentialsForTests(null);
    __resetWarningsForTests();
    warn = jest.spyOn(getDefaultLogger(), 'warn');
    // Each test sees only its own rows.
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
    await pool.query('DELETE FROM file_blob_garbage');
  });

  afterEach(() => jest.restoreAllMocks());

  it('deletes a due released row; a row within its grace and a live row stay', async () => {
    const due = freshContent('due');
    const grace = freshContent('grace');
    const live = freshContent('live');
    await retainBlob(due.sha, due.bytes, 'text/plain');
    await release0(due.sha);
    await retainBlob(grace.sha, grace.bytes, 'text/plain');
    await blobStore.releaseBlob(grace.sha); // the real 15-minute grace
    await retainBlob(live.sha, live.bytes, 'text/plain');

    const result = await sweepBlobs();
    expect(result).toMatchObject({ deleted: 1, failed: 0, parked: 0, repaired: 0 });
    expect(await blobRow(due.sha)).toBeUndefined();
    expect((await blobRow(grace.sha)).ref_count).toBe(0);
    expect((await openBlob(grace.sha)).equals(grace.bytes)).toBe(true);
    expect((await openBlob(live.sha)).equals(live.bytes)).toBe(true);
  });

  it('a revive that lands between the scan and the row\'s turn wins: the re-check skips the row', async () => {
    const { bytes, sha } = freshContent('revive-first');
    await retainBlob(sha, bytes, 'text/plain');
    await release0(sha);
    const result = await sweepBlobs({ hooks: { beforeRow: async () => { await retainBlob(sha, bytes, 'text/plain'); } } });
    expect(result).toMatchObject({ deleted: 0, skipped: 1 });
    const row = await blobRow(sha);
    expect(row.ref_count).toBe(1);
    expect(row.delete_after).toBeNull();
    expect((await openBlob(sha)).equals(bytes)).toBe(true);
  });

  it('a retain arriving while the sweeper deletes waits on the lock, then writes the blob anew', async () => {
    const { bytes, sha } = freshContent('sweeper-first');
    await retainBlob(sha, bytes, 'text/plain');
    await release0(sha);
    let retain: Promise<unknown> | null = null;
    let retained = false;
    const result = await sweepBlobs({ hooks: { beforeCommit: async () => {
      retain = retainBlob(sha, bytes, 'text/plain').then(() => { retained = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(retained).toBe(false); // blocked on the per-sha advisory lock
    } } });
    expect(result.deleted).toBe(1);
    await retain;
    expect(retained).toBe(true);
    const row = await blobRow(sha);
    expect(row.ref_count).toBe(1);
    expect(row.delete_after).toBeNull();
    expect((await openBlob(sha)).equals(bytes)).toBe(true);
  });

  it('refcount drift (23503): the row is repaired from the fs_files count, never deleted', async () => {
    const sha = sha256Of(crypto.randomBytes(32));
    await insertPending(sha);
    await addFile('drift-1', sha);
    await addFile('drift-2', sha);
    const result = await sweepBlobs();
    expect(result).toMatchObject({ repaired: 1, deleted: 0 });
    const row = await blobRow(sha);
    expect(row.ref_count).toBe(2);
    expect(row.delete_after).toBeNull();
    expect(warnText()).toMatch(/refcount drift/);
  });

  it('a deadlock (40P01) on the row delete skips the row until the next sweep', async () => {
    const sha = sha256Of(crypto.randomBytes(32));
    await insertPending(sha);
    await pool.query(`CREATE FUNCTION w7_deadlock() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'simulated deadlock' USING ERRCODE = '40P01'; END $$`);
    await pool.query('CREATE TRIGGER w7_deadlock BEFORE DELETE ON file_blobs FOR EACH ROW EXECUTE FUNCTION w7_deadlock()');
    try {
      expect(await sweepBlobs()).toMatchObject({ skipped: 1, deleted: 0, failed: 0 });
    } finally {
      await pool.query('DROP TRIGGER w7_deadlock ON file_blobs');
      await pool.query('DROP FUNCTION w7_deadlock()');
    }
    expect((await blobRow(sha)).ref_count).toBe(0);
    expect(await sweepBlobs()).toMatchObject({ deleted: 1 });
  });

  it('a failed object delete rolls back: the row stays pending and is retried after a pause', async () => {
    const sha = sha256Of(crypto.randomBytes(32));
    const location = keyOf('sweeper-test', sha);
    await insertPending(sha, 's3', location);
    const del = jest.fn().mockRejectedValue(new S3RequestError('DeleteObject', 500, 'InternalError'));
    fakeBackend(del);
    expect(await sweepBlobs()).toMatchObject({ failed: 1, deleted: 0 });
    expect(del).toHaveBeenCalledWith(sha, location);
    const row = await blobRow(sha);
    expect(row).toMatchObject({ ref_count: 0, storage: 's3', location });
    expect(Number(row.ahead)).toBeGreaterThan(14 * 60);
    expect(warnText()).toMatch(/InternalError/);
    expect(warnText()).not.toContain(location);
    expect(await sweepBlobs()).toMatchObject({ deleted: 0, failed: 0 }); // not due again yet
  });

  it('a COMMIT that fails after the object delete keeps the row pending (a revive re-PUTs)', async () => {
    const sha = sha256Of(crypto.randomBytes(32));
    await insertPending(sha, 's3', keyOf('sweeper-test', sha));
    const del = jest.fn().mockResolvedValue(undefined);
    fakeBackend(del);
    await pool.query(`CREATE FUNCTION w7_fail_commit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'simulated commit failure'; END $$`);
    await pool.query(`CREATE CONSTRAINT TRIGGER w7_fail_commit AFTER DELETE ON file_blobs
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w7_fail_commit()`);
    try {
      expect(await sweepBlobs()).toMatchObject({ failed: 1, deleted: 0 });
    } finally {
      await pool.query('DROP TRIGGER w7_fail_commit ON file_blobs');
      await pool.query('DROP FUNCTION w7_fail_commit()');
    }
    expect(del).toHaveBeenCalledTimes(1);
    expect((await blobRow(sha)).ref_count).toBe(0);
  });

  it('a refused object delete (403 AccessDenied) is a failure, not a missing object: the row stays and backs off', async () => {
    const sha = sha256Of(crypto.randomBytes(32));
    await insertPending(sha, 's3', keyOf('sweeper-test', sha));
    fakeBackend(jest.fn().mockRejectedValue(new S3RequestError('DeleteObject', 403, 'AccessDenied')));
    expect(await sweepBlobs()).toMatchObject({ failed: 1, deleted: 0 });
    const row = await blobRow(sha);
    expect(row.ref_count).toBe(0);
    expect(Number(row.ahead)).toBeGreaterThan(14 * 60);
  });

  it('an unsupported storage hands the object to file_blob_garbage with attempts and a backoff; warned once', async () => {
    const a = sha256Of(crypto.randomBytes(32));
    const b = sha256Of(crypto.randomBytes(32));
    await insertPending(a, 'local', `/var/blobs/${a}`);
    await insertPending(b, 'local', null);
    expect(await sweepBlobs()).toMatchObject({ parked: 2, deleted: 0 });
    expect(await blobRow(a)).toBeUndefined();
    const entry = await garbageRow('local', `/var/blobs/${a}`);
    expect(entry).toMatchObject({ sha256: a, attempts: 1, last_error: { reason: 'unsupported_storage', storage: 'local' } });
    expect(Number(entry.ahead)).toBeGreaterThan(60);
    expect((await garbageRow('local', b)).sha256).toBe(b); // no location: keyed by the sha
    expect(warn.mock.calls.filter(([, m]) => /queued for retry/.test(m))).toHaveLength(1);

    expect(await sweepBlobs()).toMatchObject({ garbageDeleted: 0, garbageFailed: 0 }); // backing off
    await pool.query(`UPDATE file_blob_garbage SET delete_after = now() - interval '1 second'`);
    expect(await sweepBlobs()).toMatchObject({ garbageFailed: 2 });
    const again = await garbageRow('local', `/var/blobs/${a}`);
    expect(again.attempts).toBe(2);
    expect(Number(again.ahead)).toBeGreaterThan(3 * 60);
  });

  it('missing S3 credentials park the row as not_configured (no request is sent)', async () => {
    mockConfig.blobStorage = { backend: 'db', localPath: '', s3: FAKE_S3 };
    const sha = sha256Of(crypto.randomBytes(32));
    const location = keyOf(FAKE_S3.prefix, sha);
    await insertPending(sha, 's3', location);
    expect(await sweepBlobs()).toMatchObject({ parked: 1 });
    const entry = await garbageRow('s3', location);
    expect(entry.last_error.reason).toBe('not_configured');
    expect(JSON.stringify(entry.last_error)).not.toMatch(new RegExp(`${FAKE_S3.bucket}|${FAKE_S3.prefix}|127\\.0\\.0\\.1`));
  });

  describe('garbage queue', () => {
    const enqueue = (storage: string, location: string, sha: string) => pool.query(
      `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after) VALUES ($1, $2, $3, now() - interval '1 second')`,
      [storage, location, sha]);

    it('deletes the object by its exact key, then the entry', async () => {
      const sha = sha256Of(crypto.randomBytes(32));
      const location = keyOf('old-prefix', sha);
      await enqueue('s3', location, sha);
      const del = jest.fn().mockResolvedValue(undefined);
      fakeBackend(del);
      expect(await sweepBlobs()).toMatchObject({ garbageDeleted: 1, garbageFailed: 0 });
      expect(del).toHaveBeenCalledWith(sha, location);
      expect(await garbageRow('s3', location)).toBeUndefined();
    });

    it('a failure counts the attempt, backs off and records no key, bucket or host', async () => {
      mockConfig.blobStorage = { backend: 's3', localPath: '', s3: FAKE_S3 };
      const sha = sha256Of(crypto.randomBytes(32));
      const location = keyOf(FAKE_S3.prefix, sha);
      await enqueue('s3', location, sha);
      fakeBackend(jest.fn().mockRejectedValue(new S3RequestError('DeleteObject', 503, 'SlowDown')));
      expect(await sweepBlobs()).toMatchObject({ garbageFailed: 1 });
      const entry = await garbageRow('s3', location);
      expect(entry.attempts).toBe(1);
      expect(entry.last_error).toEqual({ reason: 'request_failed', op: 'DeleteObject', status: 503, code: 'SlowDown' });
      expect(Number(entry.ahead)).toBeGreaterThan(60);
      const text = JSON.stringify(entry.last_error) + warnText();
      expect(text).not.toMatch(new RegExp(`${sha}|${FAKE_S3.bucket}|${FAKE_S3.prefix}|127\\.0\\.0\\.1`));
    });

    it('a refused object delete (403 AccessDenied) counts an attempt and backs off; the entry stays', async () => {
      const sha = sha256Of(crypto.randomBytes(32));
      const location = keyOf('p', sha);
      await enqueue('s3', location, sha);
      fakeBackend(jest.fn().mockRejectedValue(new S3RequestError('DeleteObject', 403, 'AccessDenied')));
      expect(await sweepBlobs()).toMatchObject({ garbageFailed: 1, garbageDeleted: 0 });
      const entry = await garbageRow('s3', location);
      expect(entry).toMatchObject({ attempts: 1, last_error: { reason: 'request_failed', status: 403, code: 'AccessDenied' } });
      expect(Number(entry.ahead)).toBeGreaterThan(60);
    });

    it('an entry whose sha has a row in the same storage is dropped without a delete, whatever its location string', async () => {
      // The backend resolves a legacy URL location and no location (queued as the sha) to the
      // row's own content-addressed key: deleting would remove the live object.
      const { bytes, sha } = freshContent('in-use-any-location');
      const key = keyOf('p', sha);
      await pool.query(
        `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, location) VALUES ($1, $2, 'text/plain', 1, 's3', $3)`,
        [sha, bytes.length, key]);
      await enqueue('s3', `https://fs-sweeper-test.s3.us-east-1.amazonaws.com/${key}`, sha);
      await enqueue('s3', sha, sha);
      const del = jest.fn().mockResolvedValue(undefined);
      fakeBackend(del);
      expect(await sweepBlobs()).toMatchObject({ garbageDeleted: 2, garbageFailed: 0 });
      expect(del).not.toHaveBeenCalled();
      expect((await pool.query('SELECT count(*)::int AS n FROM file_blob_garbage')).rows[0].n).toBe(0);
    });

    it('an entry of a sha whose row is in another storage is still deleted', async () => {
      const { bytes, sha } = freshContent('other-storage');
      await pool.query(
        `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes) VALUES ($1, $2, 'text/plain', 1, 'db', $3)`,
        [sha, bytes.length, bytes]);
      await enqueue('s3', keyOf('p', sha), sha);
      const del = jest.fn().mockResolvedValue(undefined);
      fakeBackend(del);
      expect(await sweepBlobs()).toMatchObject({ garbageDeleted: 1 });
      expect(del).toHaveBeenCalledWith(sha, keyOf('p', sha));
    });

    it('an entry whose key a row points to again is dropped without deleting the object', async () => {
      const { bytes, sha } = freshContent('in-use');
      await pool.query(
        `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, location) VALUES ($1, $2, 'text/plain', 1, 's3', $3)`,
        [sha, bytes.length, keyOf('p', sha)]);
      await enqueue('s3', keyOf('p', sha), sha);
      const del = jest.fn().mockResolvedValue(undefined);
      fakeBackend(del);
      expect(await sweepBlobs()).toMatchObject({ garbageDeleted: 1 });
      expect(del).not.toHaveBeenCalled();
      expect(await garbageRow('s3', keyOf('p', sha))).toBeUndefined();
    });

    it('an entry cancelled after the claim (a write of the key) is left alone', async () => {
      const sha = sha256Of(crypto.randomBytes(32));
      const location = keyOf('p', sha);
      await enqueue('s3', location, sha);
      const del = jest.fn().mockResolvedValue(undefined);
      fakeBackend(del);
      await sweepBlobs({ hooks: { beforeGarbage: async (e) => {
        await pool.query('DELETE FROM file_blob_garbage WHERE storage = $1 AND location = $2', [e.storage, e.location]);
      } } });
      expect(del).not.toHaveBeenCalled();
    });

    it('an entry re-enqueued with a new grace after the claim is not deleted early', async () => {
      const sha = sha256Of(crypto.randomBytes(32));
      const location = keyOf('p', sha);
      await enqueue('s3', location, sha);
      const del = jest.fn().mockResolvedValue(undefined);
      fakeBackend(del);
      await sweepBlobs({ hooks: { beforeGarbage: async (e) => {
        await pool.query(`UPDATE file_blob_garbage SET delete_after = now() + interval '15 minutes'
                           WHERE storage = $1 AND location = $2`, [e.storage, e.location]);
      } } });
      expect(del).not.toHaveBeenCalled();
      expect(await garbageRow('s3', location)).toBeDefined();
    });
  });

  dS3('with S3 (MinIO, requires FILE_SEARCH_TEST_S3_*)', () => {
    const prefix = `fs-sweeper-${crypto.randomBytes(4).toString('hex')}`;
    const s3Config = () => ({ bucket: S3.bucket, prefix, endpoint: S3.endpoint, region: S3.region });
    const credentials = () => ({ accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey });
    const direct = () => createS3Backend(s3Config(), { credentials: credentials() });
    const written: string[] = [];

    beforeEach(() => {
      mockConfig.blobStorage = { backend: 's3', localPath: '', s3: s3Config() };
      setBlobS3CredentialsForTests(credentials());
    });

    afterAll(async () => {
      for (const sha of written) await direct().delete(sha); // by exact key, never a listing
    });

    it('deletes the row and then the object', async () => {
      const { bytes, sha } = freshContent('s3-sweep');
      written.push(sha);
      await retainBlob(sha, bytes, 'text/plain');
      await release0(sha);
      expect((await direct().get(sha))!.equals(bytes)).toBe(true);
      expect(await sweepBlobs()).toMatchObject({ deleted: 1 });
      expect(await blobRow(sha)).toBeUndefined();
      expect(await direct().get(sha)).toBeNull();
    });

    it('a failed object delete keeps row and object; a revive then serves the bytes', async () => {
      const { bytes, sha } = freshContent('s3-delete-fails');
      written.push(sha);
      await retainBlob(sha, bytes, 'text/plain');
      await release0(sha);
      const real = blobStore.backendForStorage('s3', mockConfig.blobStorage);
      jest.spyOn(blobStore, 'backendForStorage').mockReturnValue({
        ...real, delete: () => Promise.reject(new S3RequestError('DeleteObject', 500, 'InternalError')),
      });
      expect(await sweepBlobs()).toMatchObject({ failed: 1 });
      jest.restoreAllMocks();
      expect((await direct().get(sha))!.equals(bytes)).toBe(true);
      await retainBlob(sha, bytes, 'text/plain');
      expect((await blobRow(sha)).ref_count).toBe(1);
      expect((await openBlob(sha)).equals(bytes)).toBe(true);
    });

    it('a COMMIT failing after the object delete: the row stays pending and a revive re-PUTs the bytes', async () => {
      const { bytes, sha } = freshContent('s3-commit-fails');
      written.push(sha);
      await retainBlob(sha, bytes, 'text/plain');
      await release0(sha);
      await pool.query(`CREATE FUNCTION w7_fail_commit() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'simulated commit failure'; END $$`);
      await pool.query(`CREATE CONSTRAINT TRIGGER w7_fail_commit AFTER DELETE ON file_blobs
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w7_fail_commit()`);
      try {
        expect(await sweepBlobs()).toMatchObject({ failed: 1 });
      } finally {
        await pool.query('DROP TRIGGER w7_fail_commit ON file_blobs');
        await pool.query('DROP FUNCTION w7_fail_commit()');
      }
      expect((await blobRow(sha)).ref_count).toBe(0);
      expect(await direct().get(sha)).toBeNull(); // the object delete went through
      await retainBlob(sha, bytes, 'text/plain');
      expect((await blobRow(sha)).ref_count).toBe(1);
      expect((await openBlob(sha)).equals(bytes)).toBe(true);
    });

    it('a garbage entry for a real object is deleted by its exact key', async () => {
      const { bytes, sha } = freshContent('s3-garbage');
      written.push(sha);
      await direct().put(sha, bytes, 'text/plain');
      await pool.query(
        `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after) VALUES ('s3', $1, $2, now() - interval '1 second')`,
        [keyOf(prefix, sha), sha]);
      expect(await sweepBlobs()).toMatchObject({ garbageDeleted: 1 });
      expect(await direct().get(sha)).toBeNull();
    });

    it('a live object survives garbage entries of its sha with a URL location or none', async () => {
      const { bytes, sha } = freshContent('s3-live-vs-garbage');
      written.push(sha);
      await retainBlob(sha, bytes, 'text/plain');
      const key = keyOf(prefix, sha);
      for (const location of [`${S3.endpoint}/${S3.bucket}/${key}`, sha]) {
        await pool.query(
          `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after) VALUES ('s3', $1, $2, now() - interval '1 second')`,
          [location, sha]);
      }
      expect(await sweepBlobs()).toMatchObject({ garbageDeleted: 2, garbageFailed: 0 });
      expect((await direct().get(sha))!.equals(bytes)).toBe(true);
      expect((await openBlob(sha)).equals(bytes)).toBe(true);
    });

    it('a DELETE of a key that does not exist succeeds (S3 answers 204), so a missing object needs no 403 rule', async () => {
      const sha = sha256Of(crypto.randomBytes(32));
      await expect(direct().delete(sha)).resolves.toBeUndefined();
    });

    it('a retain of the same content waits while a garbage entry for its key is deleted, then writes it anew', async () => {
      const { bytes, sha } = freshContent('s3-garbage-vs-retain');
      written.push(sha);
      await direct().put(sha, bytes, 'text/plain');
      await pool.query(
        `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after) VALUES ('s3', $1, $2, now() - interval '1 second')`,
        [keyOf(prefix, sha), sha]);
      let retain: Promise<unknown> | null = null;
      let retained = false;
      await sweepBlobs({ hooks: { beforeGarbageDelete: async () => {
        retain = retainBlob(sha, bytes, 'text/plain').then(() => { retained = true; });
        await new Promise((r) => setTimeout(r, 300));
        expect(retained).toBe(false); // blocked on the per-sha advisory lock, before its PUT
      } } });
      await retain;
      expect((await blobRow(sha)).ref_count).toBe(1);
      expect((await direct().get(sha))!.equals(bytes)).toBe(true);
      expect((await openBlob(sha)).equals(bytes)).toBe(true);
    });
  });
});
