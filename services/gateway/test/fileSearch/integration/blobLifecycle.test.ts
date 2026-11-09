// Blob lifecycle against a real Postgres (and, when FILE_SEARCH_TEST_S3_* is set, a real MinIO):
// release marks the row pending delete inside the caller's transaction, so a rollback between the
// file delete and the release leaves no refcount drift; a pending row is revived with its bytes; the
// per-sha advisory lock serialises retains; reads follow the row's stored storage across a switch of
// the configured backend. The MinIO keys are injected (setBlobS3CredentialsForTests), never
// FILE_SEARCH_S3_*.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import {
  retainBlob, releaseBlob, releaseBlobIn, openBlob, sha256Of, BlobUnavailableError, BLOB_LOCK_CLASS, blobLockKey,
  setBlobS3CredentialsForTests,
} from '../../../src/fileSearch/blob/blobStore';
import { createS3Backend } from '../../../src/fileSearch/blob/s3Backend';
import { deleteFileDetachingEverywhere } from '../../../src/fileSearch/repository';
import * as filesController from '../../../src/controllers/filesController';
import { createUpload, addUploadPart, completeUpload } from '../../../src/fileSearch/uploads';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { s3TestConfigFromEnv } = require('../../../../../ci/scripts/file-search-test-s3.js');

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const S3 = s3TestConfigFromEnv(process.env);
const d = DSN ? describe : describe.skip;
const dS3 = DSN && S3 ? describe : describe.skip;

const NO_S3 = { bucket: '', prefix: '', endpoint: '', region: '' };
let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function freshContent(label: string): { bytes: Buffer; sha: string } {
  const bytes = Buffer.concat([Buffer.from(`${label}:`), crypto.randomBytes(256)]);
  return { bytes, sha: sha256Of(bytes) };
}

d('blob lifecycle against Postgres (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  const blobRow = async (sha: string) => (await pool.query(
    'SELECT ref_count, storage, location, bytes, delete_after FROM file_blobs WHERE sha256 = $1', [sha])).rows[0];
  const addFile = (id: string, owner: string, sha: string) => pool.query(
    `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes) VALUES ($1, $2, 'f.txt', 'assistants', $3, 1)`,
    [id, owner, sha]);

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: 3,
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

  beforeEach(() => {
    mockConfig.blobStorage = { backend: 'db', localPath: '', s3: NO_S3 };
    setBlobS3CredentialsForTests(null);
  });

  it('release in the caller\'s transaction rolls back with it: no refcount drift (crash between delete and release)', async () => {
    const { bytes, sha } = freshContent('rollback');
    await retainBlob(sha, bytes, 'text/plain');
    await addFile('file-rb', 'rb@example.com', sha);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM fs_files WHERE id = $1', ['file-rb']);
      expect(await releaseBlobIn(client, sha)).toEqual({ pendingDelete: true });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT 1 FROM fs_files WHERE id = $1', ['file-rb'])).rowCount).toBe(1);
    const row = await blobRow(sha);
    expect(row.ref_count).toBe(1);
    expect(row.delete_after).toBeNull();
  });

  it('a failure after the file delete (repository and /files paths) undoes both', async () => {
    const { bytes, sha } = freshContent('detach-fail');
    await retainBlob(sha, bytes, 'text/plain');
    await retainBlob(sha, bytes, 'text/plain');
    await addFile('file-df', 'df@example.com', sha);
    await addFile('file-df2', 'df@example.com', sha);
    // The release's UPDATE fails: the stand-in for a crash after the fs_files delete.
    await pool.query(`CREATE FUNCTION w7_fail_release() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'simulated crash'; END $$`);
    await pool.query(`CREATE TRIGGER w7_fail_release BEFORE UPDATE ON file_blobs FOR EACH ROW
      EXECUTE FUNCTION w7_fail_release()`);
    try {
      await expect(deleteFileDetachingEverywhere('file-df', 'df@example.com')).rejects.toThrow(/simulated crash/);
      const next = jest.fn();
      await filesController.deleteFile(
        { headers: {}, params: { id: 'file-df2' }, query: {}, apiKeyInfo: { email: 'df@example.com' } } as any,
        { status: () => ({ json: () => undefined }) } as any, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/simulated crash/) }));
    } finally {
      await pool.query('DROP TRIGGER w7_fail_release ON file_blobs');
      await pool.query('DROP FUNCTION w7_fail_release()');
    }
    expect((await pool.query('SELECT 1 FROM fs_files WHERE id = ANY($1)', [['file-df', 'file-df2']])).rowCount).toBe(2);
    const row = await blobRow(sha);
    expect(row.ref_count).toBe(2);
    expect(row.delete_after).toBeNull();
    // And without the failure: each delete and its release commit together.
    expect(await deleteFileDetachingEverywhere('file-df2', 'df@example.com')).toEqual({ deleted: true, sha256: sha });
    expect((await blobRow(sha)).ref_count).toBe(1);
    expect(await deleteFileDetachingEverywhere('file-df', 'df@example.com')).toEqual({ deleted: true, sha256: sha });
    const after = await blobRow(sha);
    expect(after.ref_count).toBe(0);
    expect(after.delete_after).not.toBeNull();
  });

  it('release sets delete_after about the grace ahead; revive clears it and keeps the bytes', async () => {
    const { bytes, sha } = freshContent('revive-db');
    await retainBlob(sha, bytes, 'text/plain');
    await releaseBlob(sha);
    const { rows: [pending] } = await pool.query(
      `SELECT ref_count, extract(epoch FROM delete_after - now()) AS ahead FROM file_blobs WHERE sha256 = $1`, [sha]);
    expect(pending.ref_count).toBe(0);
    expect(Number(pending.ahead)).toBeGreaterThan(14 * 60);
    expect(Number(pending.ahead)).toBeLessThanOrEqual(15 * 60);
    expect((await openBlob(sha)).equals(bytes)).toBe(true); // readable during the grace

    expect(await retainBlob(sha, bytes, 'text/plain')).toEqual({ deduplicated: true });
    const row = await blobRow(sha);
    expect(row.ref_count).toBe(1);
    expect(row.delete_after).toBeNull();
    expect((await openBlob(sha)).equals(bytes)).toBe(true);
  });

  it('retain waits for the per-sha advisory lock that the sweeper and the migration take', async () => {
    const { bytes, sha } = freshContent('lock');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [BLOB_LOCK_CLASS, blobLockKey(sha)]);
      let done = false;
      const retain = retainBlob(sha, bytes, 'text/plain').then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      expect((await pool.query('SELECT 1 FROM file_blobs WHERE sha256 = $1', [sha])).rowCount).toBe(0);
      await holder.query('COMMIT');
      await retain;
      expect(done).toBe(true);
    } finally {
      holder.release();
    }
    expect((await blobRow(sha)).ref_count).toBe(1);
  });

  it('reads follow the stored storage: a db row is read while s3 is configured (without S3 config)', async () => {
    const { bytes, sha } = freshContent('db-under-s3');
    await retainBlob(sha, bytes, 'text/plain');
    mockConfig.blobStorage = { backend: 's3', localPath: '', s3: NO_S3 };
    expect((await openBlob(sha)).equals(bytes)).toBe(true);
  });

  it('a row of an unknown storage is unavailable, never read from the configured backend', async () => {
    const sha = 'e'.repeat(64);
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes) VALUES ($1, 1, 'text/plain', 1, 'inline', 'x')`,
      [sha]);
    const err = await openBlob(sha).catch((e: any) => e);
    expect(err).toBeInstanceOf(BlobUnavailableError);
    expect(err.reason).toBe('unsupported_storage');
  });

  dS3('with S3 (MinIO, requires FILE_SEARCH_TEST_S3_*)', () => {
    const prefix = `fs-lifecycle-${crypto.randomBytes(4).toString('hex')}`;
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

    it('a blob written to S3 stays readable after the configured backend switches to db', async () => {
      const { bytes, sha } = freshContent('s3-then-db');
      written.push(sha);
      expect(await retainBlob(sha, bytes, 'text/plain')).toEqual({ deduplicated: false });
      const row = await blobRow(sha);
      expect(row).toMatchObject({ storage: 's3', location: `${prefix}/${sha.slice(0, 2)}/${sha}`, bytes: null });
      expect((await direct().get(sha, row.location))!.equals(bytes)).toBe(true);

      mockConfig.blobStorage = { backend: 'db', localPath: '', s3: s3Config() };
      expect((await openBlob(sha)).equals(bytes)).toBe(true);
      // New content now goes to db; the old blob stays where it is.
      const other = freshContent('db-after-s3');
      await retainBlob(other.sha, other.bytes, 'text/plain');
      expect((await blobRow(other.sha)).storage).toBe('db');
      expect((await blobRow(sha)).storage).toBe('s3');
    });

    it('release + revive keeps the bytes, even when the object was deleted in between (re-PUT)', async () => {
      const { bytes, sha } = freshContent('s3-revive');
      written.push(sha);
      await retainBlob(sha, bytes, 'text/plain');
      await releaseBlob(sha);
      expect((await openBlob(sha)).equals(bytes)).toBe(true); // nothing deleted by the release
      // A sweeper object delete that completed although its transaction did not.
      await direct().delete(sha);
      expect(await direct().get(sha)).toBeNull();

      mockConfig.blobStorage = { backend: 'db', localPath: '', s3: s3Config() }; // revive goes to the row's storage
      await retainBlob(sha, bytes, 'text/plain');
      const row = await blobRow(sha);
      expect(row).toMatchObject({ ref_count: 1, storage: 's3', delete_after: null });
      expect((await direct().get(sha))!.equals(bytes)).toBe(true);
      expect((await openBlob(sha)).equals(bytes)).toBe(true);
    });

    it('an Uploads API completion stores the file in S3, in part order, and it downloads', async () => {
      const pieces = [Buffer.from('upload-s3-first:'), crypto.randomBytes(300), Buffer.from(':last')];
      const whole = Buffer.concat(pieces);
      const sha = sha256Of(whole);
      written.push(sha);
      const owner = 'upload-s3@example.com';
      const upload = await createUpload({
        ownerEmail: owner, filename: 's3.txt', purpose: 'assistants', mimeType: 'text/plain', bytes: whole.length,
        expiresAfterSeconds: null,
      });
      const partIds: string[] = [];
      for (const index of [2, 0, 1]) partIds[index] = (await addUploadPart(owner, upload.id, pieces[index])).id;

      const { upload: done, file } = await completeUpload(owner, upload.id, partIds, null, 1024 * 1024);
      expect(done.status).toBe('completed');
      expect((await pool.query('SELECT count(*)::int AS n FROM fs_upload_parts WHERE upload_id = $1', [upload.id])).rows[0].n).toBe(0);
      const row = await blobRow(sha);
      expect(row).toMatchObject({ ref_count: 1, storage: 's3', location: `${prefix}/${sha.slice(0, 2)}/${sha}`, bytes: null });
      expect((await direct().get(sha, row.location))!.equals(whole)).toBe(true);

      const res: any = { statusCode: 0 };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.set = () => res;
      res.json = (body: unknown) => { res.body = body; return res; };
      res.send = (body: unknown) => { res.body = body; return res; };
      const next = jest.fn();
      await filesController.downloadFileContent(
        { headers: {}, params: { id: file.id }, query: {}, apiKeyInfo: { email: owner } } as any, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(Buffer.isBuffer(res.body) && res.body.equals(whole)).toBe(true);
    });

    it('an s3 blob under another prefix, or without credentials, is unavailable with a typed error', async () => {
      const { bytes, sha } = freshContent('s3-unreachable');
      written.push(sha);
      await retainBlob(sha, bytes, 'text/plain');

      mockConfig.blobStorage = { backend: 's3', localPath: '', s3: { ...s3Config(), prefix: `${prefix}-moved` } };
      expect((await openBlob(sha).catch((e: any) => e)).reason).toBe('location_unreachable');

      mockConfig.blobStorage = { backend: 'db', localPath: '', s3: s3Config() };
      setBlobS3CredentialsForTests(null); // and FILE_SEARCH_S3_* is never set in tests
      const err = await openBlob(sha).catch((e: any) => e);
      expect(err).toBeInstanceOf(BlobUnavailableError);
      expect(err.reason).toBe('not_configured');
    });
  });
});
