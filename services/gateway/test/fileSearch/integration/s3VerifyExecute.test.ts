// The steps of the S3 verification script (scripts/fileSearchS3Verify/execute.ts) against a real
// Postgres and the test MinIO (FILE_SEARCH_TEST_S3_*, never the product FILE_SEARCH_S3_* variables),
// so the flow the maintainer approves for the live AWS run has run end to end before it. The
// script's guard admits only the AWS host, so it is not installed here; instead every request is
// counted and compared with the plan (steps 1-11; step 12, the cleanup, belongs to the script).
// Objects are deleted by exact key.
import * as crypto from 'crypto';
import axios from 'axios';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { setBlobS3CredentialsForTests } from '../../../src/fileSearch/blob/blobStore';
import { createS3Backend } from '../../../src/fileSearch/blob/s3Backend';
import { executeSteps } from '../../../scripts/fileSearchS3Verify/execute';
import { buildPlan, OPS, S3Op } from '../../../scripts/fileSearchS3Verify/plan';
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

dS3('S3 verification steps against MinIO (requires FILE_SEARCH_TEST_DSN and FILE_SEARCH_TEST_S3_*)', () => {
  let fixture: IsolatedSchema;
  const runId = 'w7-20261008T120000Z';
  const runFolder = `fs-s3verify-${crypto.randomBytes(4).toString('hex')}/${runId}`;
  const plan = buildPlan(runId, runFolder, 3);
  // Read from S3 in beforeAll, not here: a skipped describe still runs its
  // body, and S3 is null without the test MinIO.
  let s3Config: { bucket: string; prefix: string; endpoint: string; region: string };
  let credentials: { accessKeyId: string; secretAccessKey: string };
  let settings: typeof credentials & { bucket: string; region: string; prefix: string; runFolder: string };

  beforeAll(async () => {
    s3Config = { bucket: S3.bucket, prefix: runFolder, endpoint: S3.endpoint, region: S3.region };
    credentials = { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey };
    settings = { ...credentials, bucket: S3.bucket, region: S3.region, prefix: runFolder.split('/')[0], runFolder };
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: 3,
      ingestion: { maxRetries: 3, concurrency: 1 },
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 's3', localPath: '', s3: s3Config },
    };
    setBlobS3CredentialsForTests(credentials);
    fixture = await createIsolatedSchema(DSN!, 3);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
  });

  afterAll(async () => {
    const direct = createS3Backend(s3Config, { credentials });
    for (const f of plan.files) await direct.delete(f.sha256, f.key); // by exact key, never a listing
    // The product leaves the probe object in place; this throwaway prefix removes it by exact key.
    await direct.delete(plan.probeKey.split('/').pop()!, plan.probeKey);
    setBlobS3CredentialsForTests(null);
    __resetForTests();
    await getPool()?.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  it('runs every step, verifies every key gone, and sends exactly the planned requests', async () => {
    const counts = Object.fromEntries(OPS.map((op) => [op, 0])) as Record<S3Op, number>;
    const paths: string[] = [];
    const id = axios.interceptors.request.use((config) => {
      const pathname = new URL(config.url!).pathname;
      paths.push(pathname);
      const method = String(config.method).toLowerCase();
      const op: S3Op = ({ put: 'PutObject', get: 'GetObject', delete: 'DeleteObject', head: 'HeadObject' } as const)[method as 'get']!;
      counts[op] += 1;
      return config;
    }, undefined, { synchronous: true });
    const log: string[] = [];
    try {
      const result = await executeSteps(plan, settings, {
        switchBackend: (backend) => { mockConfig.blobStorage = { ...mockConfig.blobStorage, backend }; },
        log: (m) => log.push(m),
      });
      expect(result.garbage.confirmed).toHaveLength(3);
      expect(result.final.confirmed).toHaveLength(3);
      expect(result.garbage.notReadable).toEqual([]);
      expect(result.final.notReadable).toEqual([]);
    } finally {
      axios.interceptors.request.eject(id);
    }
    expect(log).toHaveLength(11);
    const cleanup = plan.steps[plan.steps.length - 1].requests;
    const expected = { ...plan.totals, DeleteObject: plan.totals.DeleteObject - (cleanup.DeleteObject ?? 0) };
    expect(counts).toEqual(expected);
    // Only the planned keys and the probe object were addressed; nothing on the bucket itself.
    const allowed = new Set([...plan.files.map((f) => `/${S3.bucket}/${f.key}`), `/${S3.bucket}/${plan.probeKey}`]);
    expect(paths.filter((p) => !allowed.has(p))).toEqual([]);
    const { rows } = await getPool()!.query('SELECT (SELECT count(*) FROM file_blobs)::int AS blobs, (SELECT count(*) FROM file_blob_garbage)::int AS garbage');
    expect(rows[0]).toEqual({ blobs: 0, garbage: 0 });
  });
});
