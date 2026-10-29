// The S3 verification's steps with the script's own request guard installed, against a real
// Postgres and an in-memory S3 behind a fake axios adapter on the AWS-shaped host the live run uses
// (nothing reaches a network). Every request must pass the guard and the counts must equal the plan
// (steps 1-11; step 12, the cleanup, belongs to the script).
import axios, { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { setBlobS3CredentialsForTests } from '../../../src/fileSearch/blob/blobStore';
import { executeSteps } from '../../../scripts/fileSearchS3Verify/execute';
import { countByOp, installGuard } from '../../../scripts/fileSearchS3Verify/guard';
import { buildPlan } from '../../../scripts/fileSearchS3Verify/plan';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

d('S3 verification steps under the guard (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  const BUCKET = 'example-verify-bucket';
  const REGION = 'eu-central-1';
  const HOST = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
  const runId = 'w7-20261008T120000Z';
  const runFolder = `grounding-test/${runId}`;
  const plan = buildPlan(runId, runFolder, 3);
  const settings = {
    bucket: BUCKET, region: REGION, prefix: 'grounding-test', runFolder,
    accessKeyId: 'AKIDVERIFYTESTONLY', secretAccessKey: 'verify-test-secret-only',
  };
  const objects = new Map<string, Buffer>();
  const transported: string[] = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const method = String(config.method).toUpperCase();
    const url = String(config.url);
    transported.push(`${method} ${url}`);
    const respond = (status: number, data: Buffer = Buffer.alloc(0)) => ({ status, statusText: '', headers: {}, data, config });
    if (method === 'PUT') { objects.set(url, Buffer.from(config.data)); return respond(200); }
    if (method === 'DELETE') { objects.delete(url); return respond(204); }
    const stored = objects.get(url);
    if (!stored) return respond(404);
    return respond(200, method === 'GET' ? stored : Buffer.alloc(0));
  };
  let original: any;

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: 3,
      ingestion: { maxRetries: 3, concurrency: 1 },
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 's3', localPath: '', s3: { bucket: BUCKET, prefix: runFolder, endpoint: '', region: REGION } },
    };
    setBlobS3CredentialsForTests({ accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey });
    fixture = await createIsolatedSchema(DSN!, 3);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    original = axios.defaults.adapter;
    axios.defaults.adapter = adapter;
  });

  afterAll(async () => {
    axios.defaults.adapter = original;
    setBlobS3CredentialsForTests(null);
    __resetForTests();
    await getPool()?.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  it('every request passes the guard, and the requests equal the plan', async () => {
    const guard = installGuard(axios, {
      bucket: BUCKET, region: REGION, runFolder, keys: [...plan.files.map((f) => f.key), plan.probeKey],
    });
    try {
      const result = await executeSteps(plan, settings, {
        switchBackend: (backend) => { mockConfig.blobStorage = { ...mockConfig.blobStorage, backend }; },
        log: () => {},
      });
      expect(result.final.confirmed).toHaveLength(3);
    } finally {
      guard.eject();
    }
    expect(guard.violations).toEqual([]);
    const cleanup = plan.steps[plan.steps.length - 1].requests;
    expect(countByOp(guard.allowed)).toEqual({ ...plan.totals, DeleteObject: plan.totals.DeleteObject - (cleanup.DeleteObject ?? 0) });
    expect(transported).toHaveLength(guard.allowed.length);
    expect(transported.every((t) => t.split(' ')[1].startsWith(`${HOST}/${runFolder}/`))).toBe(true);
    // Only the probe object is left: the script's cleanup would find nothing else to delete.
    expect([...objects.keys()]).toEqual([`${HOST}/${plan.probeKey}`]);
  });
});
