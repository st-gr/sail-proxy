// The blob storage panel's reads, hermetic (pool and migration engine mocked): the figures' shape,
// S3 readiness without a request, and that no bucket, endpoint, host or credential reaches an answer.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const BUCKET = 'w7-panel-bucket-name';
const ENDPOINT_HOST = 'panel-object-store.internal';
const ACCESS = 'panel-access-key-value';
const SECRET = 'panel-secret-key-value';

let mockBlobStorage: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({ blobStorage: mockBlobStorage })
}));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

const query = jest.fn<any>();
jest.mock('../../src/fileSearch/blob/blobMigrationDb', () => ({
  __esModule: true,
  requirePool: () => ({ query: (...a: any[]) => query(...a) })
}));
const blobMigrationJob = jest.fn<any>();
const checkMigrationTarget = jest.fn<any>();
jest.mock('../../src/fileSearch/blob/blobMigration', () => ({
  __esModule: true,
  blobMigrationJob: (...a: any[]) => blobMigrationJob(...a),
  checkMigrationTarget: (...a: any[]) => checkMigrationTarget(...a)
}));

import { blobStorageOverview, testS3Connection } from '../../src/fileSearch/blob/blobAdmin';

const s3Config = (overrides: Record<string, string> = {}) => ({
  backend: 's3', localPath: '',
  s3: { bucket: BUCKET, prefix: 'grounding-test/panel/', endpoint: `http://${ENDPOINT_HOST}:9000`, region: 'eu-central-1', ...overrides }
});

/** Answers the overview's statements by what they read. */
function answer(blobs: any[], garbage: any[], latest: any[], outsidePrefix = '0') {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM file_blob_garbage')) return { rows: garbage };
    if (sql.includes('regexp_replace')) return { rows: [{ n: outsidePrefix }] };
    if (sql.includes('FROM file_blobs')) return { rows: blobs };
    if (sql.includes('FROM fs_jobs')) return { rows: latest };
    throw new Error(`unexpected statement: ${sql}`);
  });
}

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [BUCKET, ENDPOINT_HOST, ACCESS, SECRET, 'amazonaws']) expect(text).not.toContain(secret);
}

beforeEach(() => {
  query.mockReset(); blobMigrationJob.mockReset(); checkMigrationTarget.mockReset();
  mockBlobStorage = s3Config();
});
afterEach(() => {
  delete process.env.FILE_SEARCH_S3_ACCESS_KEY_ID;
  delete process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY;
});

describe('blobStorageOverview', () => {
  it('counts live and released rows apart, the garbage queue, and the latest migration, with numbers', async () => {
    process.env.FILE_SEARCH_S3_ACCESS_KEY_ID = ACCESS;
    process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY = SECRET;
    answer(
      [{ storage: 'db', live_blobs: '3', live_bytes: '300', released_blobs: '1', released_bytes: '50' },
        { storage: 's3', live_blobs: '2', live_bytes: '2048', released_blobs: '0', released_bytes: '0' },
        { storage: 'local', live_blobs: '1', live_bytes: '7', released_blobs: '0', released_bytes: '0' }],
      [{ storage: 's3', entries: '4', due: '2', failing: '1' }],
      [{ id: 'job_m' }], '1');
    blobMigrationJob.mockResolvedValue({ id: 'job_m', kind: 'blob_migration', state: 'running', target_storage: 's3', total: 5, done: 2 });
    const overview = await blobStorageOverview();
    expect(overview).toEqual({
      configured_backend: 's3',
      s3: { configured: true, credentials_present: true, prefix: 'grounding-test/panel', outside_prefix_blobs: 1 },
      storages: [
        { storage: 'db', live_blobs: 3, live_bytes: 300, released_blobs: 1, released_bytes: 50, addressable: true },
        { storage: 's3', live_blobs: 2, live_bytes: 2048, released_blobs: 0, released_bytes: 0, addressable: true },
        { storage: 'local', live_blobs: 1, live_bytes: 7, released_blobs: 0, released_bytes: 0, addressable: false }
      ],
      garbage: [{ storage: 's3', entries: 4, due: 2, failing: 1 }],
      migration: { id: 'job_m', kind: 'blob_migration', state: 'running', target_storage: 's3', total: 5, done: 2 }
    });
    expect(blobMigrationJob).toHaveBeenCalledWith('job_m');
    expectNoSecrets(overview);
  });

  it('released rows are those with delete_after set; the running migration sorts before a newer finished one', async () => {
    answer([], [], []);
    await blobStorageOverview();
    const sqls = query.mock.calls.map((call) => String(call[0]));
    const blobsSql = sqls.find((q) => q.includes('FROM file_blobs GROUP BY'))!;
    const latestSql = sqls.find((q) => q.includes('FROM fs_jobs'))!;
    expect(blobsSql).toMatch(/FILTER \(WHERE delete_after IS NULL\)/);
    expect(blobsSql).toMatch(/FILTER \(WHERE delete_after IS NOT NULL\)/);
    expect(blobsSql).not.toMatch(/\b(location|bytes)\b/);
    expect(latestSql).toMatch(/ORDER BY \(finished_at IS NULL\) DESC, created_at DESC/);
  });

  it('s3 blobs are not addressable without credentials or with an invalid configuration; no migration is null', async () => {
    answer([{ storage: 's3', live_blobs: '1', live_bytes: '1', released_blobs: '0', released_bytes: '0' }], [], []);
    const noKeys = await blobStorageOverview();
    expect(noKeys.s3).toEqual({ configured: true, credentials_present: false, prefix: 'grounding-test/panel', outside_prefix_blobs: 0 });
    expect(noKeys.storages[0].addressable).toBe(false);
    expect(noKeys.migration).toBeNull();

    process.env.FILE_SEARCH_S3_ACCESS_KEY_ID = ACCESS;
    process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY = SECRET;
    mockBlobStorage = { ...s3Config({ bucket: '' }), backend: 'db' };
    const noBucket = await blobStorageOverview();
    expect(noBucket.configured_backend).toBe('db');
    expect(noBucket.s3.configured).toBe(false);
    expect(noBucket.storages[0].addressable).toBe(false);
    expect(noBucket.s3.outside_prefix_blobs).toBe(0);
    expect(query.mock.calls.filter((call) => String(call[0]).includes('regexp_replace'))).toHaveLength(1); // only while configured
    expectNoSecrets(noBucket);
  });

  it('counts s3 rows outside the prefix against the key the backend derives; the bucket is a parameter, never returned', async () => {
    answer([], [], [], '2');
    const overview = await blobStorageOverview();
    expect(overview.s3.outside_prefix_blobs).toBe(2);
    const call = query.mock.calls.find((c) => String(c[0]).includes('regexp_replace'))!;
    expect(String(call[0])).toMatch(/storage = 's3' AND location IS NOT NULL/);
    expect(call[1]).toEqual(['grounding-test/panel', BUCKET]);
    expectNoSecrets(overview);
  });
});

describe('testS3Connection', () => {
  it('answers ok when the probe succeeds', async () => {
    checkMigrationTarget.mockResolvedValue(null);
    expect(await testS3Connection()).toEqual({ ok: true });
    expect(checkMigrationTarget).toHaveBeenCalledWith('s3');
  });

  it('keeps only reason, op, status and code: never a message', async () => {
    checkMigrationTarget.mockResolvedValue({ reason: 'request_failed', op: 'PutObject', status: 404, code: 'NoSuchBucket', message: `bucket ${BUCKET} at ${ENDPOINT_HOST}` });
    const result = await testS3Connection();
    expect(result).toEqual({ ok: false, error: { reason: 'request_failed', op: 'PutObject', status: 404, code: 'NoSuchBucket' } });
    expectNoSecrets(result);
    checkMigrationTarget.mockResolvedValue({ reason: 'not_configured', message: 'FILE_SEARCH_S3_ACCESS_KEY_ID / FILE_SEARCH_S3_SECRET_ACCESS_KEY are not configured', storage: 's3' });
    expect(await testS3Connection()).toEqual({ ok: false, error: { reason: 'not_configured' } });
  });
});
