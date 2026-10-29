// An upload's S3 work and status do not depend on whether its content exists already: against
// Postgres and MinIO, a duplicate is PUT like new content, an object written for a row that lives in
// the database is queued as garbage and deleted by the garbage pass, and with S3 unreachable the
// API answers a duplicate exactly like new content. The MinIO keys are injected, never FILE_SEARCH_S3_*.
import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { retainBlob, openBlob, sha256Of, setBlobS3CredentialsForTests } from '../../../src/fileSearch/blob/blobStore';
import { sweepBlobs } from '../../../src/fileSearch/blob/blobSweeper';
import { createS3Backend } from '../../../src/fileSearch/blob/s3Backend';
import * as filesController from '../../../src/controllers/filesController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { s3TestConfigFromEnv } = require('../../../../../ci/scripts/file-search-test-s3.js');

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const S3 = s3TestConfigFromEnv(process.env);
const dS3 = DSN && S3 ? describe : describe.skip;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function freshContent(label: string): { bytes: Buffer; sha: string } {
  const bytes = Buffer.concat([Buffer.from(`${label}:`), crypto.randomBytes(256)]);
  return { bytes, sha: sha256Of(bytes) };
}

dS3('uploads with S3 do not reveal existing content (requires FILE_SEARCH_TEST_DSN and FILE_SEARCH_TEST_S3_*)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const prefix = `fs-uniform-${crypto.randomBytes(4).toString('hex')}`;
  const s3Config = () => ({ bucket: S3.bucket, prefix, endpoint: S3.endpoint, region: S3.region });
  const credentials = () => ({ accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey });
  const direct = () => createS3Backend(s3Config(), { credentials: credentials() });
  const written: string[] = [];

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: 3,
      limits: { maxFilesPerStore: 10000, maxFileBytes: 1024 * 1024 },
      blobStorage: { backend: 's3', localPath: '', s3: s3Config() },
    };
    setBlobS3CredentialsForTests(credentials());
    fixture = await createIsolatedSchema(DSN!, 3);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    setBlobS3CredentialsForTests(credentials());
    for (const sha of written) await direct().delete(sha); // by exact key, never a listing
    setBlobS3CredentialsForTests(null);
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => {
    mockConfig.blobStorage = { backend: 's3', localPath: '', s3: s3Config() };
    setBlobS3CredentialsForTests(credentials());
  });

  it('a duplicate PUTs again: an object deleted behind the row is back after the next upload', async () => {
    const { bytes, sha } = freshContent('dup-put');
    written.push(sha);
    await retainBlob(sha, bytes, 'text/plain');
    await direct().delete(sha);
    expect(await retainBlob(sha, bytes, 'text/plain')).toEqual({ deduplicated: true });
    expect((await direct().get(sha))!.equals(bytes)).toBe(true);
    expect((await pool.query('SELECT ref_count, storage FROM file_blobs WHERE sha256 = $1', [sha])).rows[0])
      .toEqual({ ref_count: 2, storage: 's3' });
  });

  it('a row in the database: the object written for the duplicate is garbage, deleted by the garbage pass', async () => {
    const { bytes, sha } = freshContent('db-row');
    written.push(sha);
    mockConfig.blobStorage = { backend: 'db', localPath: '', s3: s3Config() };
    await retainBlob(sha, bytes, 'text/plain');
    mockConfig.blobStorage = { backend: 's3', localPath: '', s3: s3Config() };

    expect(await retainBlob(sha, bytes, 'text/plain')).toEqual({ deduplicated: true });
    expect((await direct().get(sha))!.equals(bytes)).toBe(true);
    const garbage = await pool.query('SELECT storage, location FROM file_blob_garbage WHERE sha256 = $1', [sha]);
    expect(garbage.rows).toEqual([{ storage: 's3', location: `${prefix}/${sha.slice(0, 2)}/${sha}` }]);

    await pool.query(`UPDATE file_blob_garbage SET delete_after = now() - interval '1 second' WHERE sha256 = $1`, [sha]);
    const result = await sweepBlobs();
    expect(result.garbageDeleted).toBeGreaterThanOrEqual(1);
    expect(await direct().get(sha)).toBeNull();
    const row = (await pool.query('SELECT ref_count, storage FROM file_blobs WHERE sha256 = $1', [sha])).rows[0];
    expect(row).toEqual({ ref_count: 2, storage: 'db' });
    expect((await openBlob(sha)).equals(bytes)).toBe(true);
  });

  it('with S3 unreachable, the API answers a duplicate exactly like new content', async () => {
    const existing = freshContent('outage-dup');
    written.push(existing.sha);
    await retainBlob(existing.sha, existing.bytes, 'text/plain');

    // Nothing listens on port 1: every PUT fails at once.
    mockConfig.blobStorage = { backend: 's3', localPath: '', s3: { ...s3Config(), endpoint: 'http://127.0.0.1:1' } };
    const app = express();
    app.use((req: any, _res, next) => { req.apiKeyInfo = { email: 'uniform@example.com' }; next(); });
    app.post('/files', filesController.uploadFile);
    const upload = (bytes: Buffer) => request(app).post('/files')
      .field('purpose', 'assistants')
      .attach('file', bytes, { filename: 'a.txt', contentType: 'text/plain' });

    const dup = await upload(existing.bytes);
    const fresh = await upload(freshContent('outage-new').bytes);
    expect(dup.status).toBe(503);
    expect(fresh.status).toBe(503);
    expect(dup.body).toEqual(fresh.body);
    expect(dup.body.error.code).toBe('blob_storage_unavailable');
    expect((await pool.query('SELECT ref_count FROM file_blobs WHERE sha256 = $1', [existing.sha])).rows[0].ref_count).toBe(1);
  });
});
