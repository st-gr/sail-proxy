// The blob storage panel's figures against a real Postgres: live and released rows per storage,
// the garbage queue (due, failing) and which migration the panel shows.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { blobStorageOverview } from '../../../src/fileSearch/blob/blobAdmin';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

const sha = (c: string) => c.repeat(64);

d('blob storage panel figures against Postgres (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: 3,
      ingestion: { maxRetries: 3, concurrency: 1 },
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: 'panel/blobs', endpoint: '', region: '' } },
    };
    fixture = await createIsolatedSchema(DSN!, 3);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM file_blobs');
    await pool.query('DELETE FROM file_blob_garbage');
  });

  it('an empty database answers zero storages, no garbage and no migration', async () => {
    expect(await blobStorageOverview()).toEqual({
      configured_backend: 'db',
      s3: { configured: false, credentials_present: false, prefix: 'panel/blobs', outside_prefix_blobs: 0 },
      storages: [], garbage: [], migration: null,
    });
  });

  it('counts live and released rows apart per storage, and the garbage that is due or failing', async () => {
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, location, delete_after) VALUES
         ($1, 10, 'text/plain', 1, 'db', 'x', NULL, NULL),
         ($2, 20, 'text/plain', 2, 'db', 'y', NULL, NULL),
         ($3, 5,  'text/plain', 0, 'db', 'z', NULL, now() + interval '15 minutes'),
         ($4, 70, 'text/plain', 1, 's3', NULL, 'panel/blobs/dd/' || $4, NULL)`,
      [sha('a'), sha('b'), sha('c'), sha('d')]);
    await pool.query(
      `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after, attempts) VALUES
         ('s3', 'k1', $1, now() - interval '1 minute', 0),
         ('s3', 'k2', $1, now() + interval '4 minutes', 2),
         ('s3', 'k3', $1, now() + interval '15 minutes', 0)`, [sha('e')]);
    const overview = await blobStorageOverview();
    expect(overview.storages).toEqual([
      { storage: 'db', live_blobs: 2, live_bytes: 30, released_blobs: 1, released_bytes: 5, addressable: true },
      { storage: 's3', live_blobs: 1, live_bytes: 70, released_blobs: 0, released_bytes: 0, addressable: false },
    ]);
    expect(overview.garbage).toEqual([{ storage: 's3', entries: 3, due: 1, failing: 1 }]);
  });

  it('counts s3 rows whose location is not their key under the configured prefix', async () => {
    const saved = mockConfig.blobStorage;
    mockConfig.blobStorage = {
      backend: 's3', localPath: '', s3: { bucket: 'panel-bucket', prefix: 'panel/blobs/', endpoint: 'http://127.0.0.1:1', region: 'us-east-1' },
    };
    try {
      await pool.query(
        `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, location, delete_after) VALUES
           ($1, 1, 'text/plain', 1, 's3', NULL, 'panel/blobs/aa/' || $1, NULL),
           ($2, 1, 'text/plain', 1, 's3', NULL, 'old/blobs/bb/' || $2, NULL),
           ($3, 1, 'text/plain', 0, 's3', NULL, 'http://127.0.0.1:9000/panel-bucket/panel/blobs/cc/' || $3, now()),
           ($4, 1, 'text/plain', 1, 's3', NULL, 'https://panel-bucket.s3.us-east-1.example/panel/blobs/dd/' || $4, NULL),
           ($5, 1, 'text/plain', 1, 's3', NULL, 'http://127.0.0.1:9000/panel-bucket/old/blobs/ee/' || $5, NULL),
           ($6, 1, 'text/plain', 1, 's3', NULL, NULL, NULL),
           ($7, 1, 'text/plain', 1, 'db', 'x', 'old/blobs/11/' || $7, NULL)`,
        [sha('a'), sha('b'), sha('c'), sha('d'), sha('e'), sha('f'), sha('1')]);
      expect((await blobStorageOverview()).s3.outside_prefix_blobs).toBe(2);
    } finally {
      mockConfig.blobStorage = saved;
    }
  });

  it('shows the unfinished migration before a newer finished one, else the most recent', async () => {
    await pool.query(
      `INSERT INTO fs_jobs (id, kind, target_storage, created_at, finished_at) VALUES
         ('job_old', 'blob_migration', 'db', now() - interval '2 hours', now() - interval '1 hour'),
         ('job_new', 'blob_migration', 's3', now() - interval '1 hour', now() - interval '30 minutes')`);
    expect((await blobStorageOverview()).migration).toMatchObject({ id: 'job_new', kind: 'blob_migration', target_storage: 's3' });
    await pool.query(`UPDATE fs_jobs SET finished_at = NULL WHERE id = 'job_old'`);
    expect((await blobStorageOverview()).migration).toMatchObject({ id: 'job_old', target_storage: 'db' });
  });
});
