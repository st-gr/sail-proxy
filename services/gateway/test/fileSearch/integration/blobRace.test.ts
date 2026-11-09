// Acceptance: 300 iterations of concurrent release / retain / sweep on one sha, against a real
// Postgres with the db backend, and against MinIO when FILE_SEARCH_TEST_S3_* is set. Zero losses
// (every row with references has its bytes, and its ref_count is the number of references held)
// and zero orphans (after a final sweep no released row remains, and no object is left behind for
// a deleted row; S3 is checked by the exact keys this test wrote, never by a listing).
//
// Each iteration takes a fresh sha, retains it once, then starts four workers, each after a random
// jitter (0-10 ms for release and retain, so they land anywhere in a sweeper's pass; 0-3 ms for the
// sweepers):
//   even iterations: release | retain           | sweeper | sweeper   -> one reference left
//   odd iterations:  release | retain + release | sweeper | sweeper   -> none left
// The two sweepers sweep in a loop until release and retain have finished, so a sweep is running
// whenever the row turns due. Releases use a zero grace, so the sweeper really races retain (with
// the 15-minute grace it would never see the row). Then one more sweep, and the checks.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import * as blobStore from '../../../src/fileSearch/blob/blobStore';
import { retainBlob, releaseBlobIn, openBlob, sha256Of, setBlobS3CredentialsForTests } from '../../../src/fileSearch/blob/blobStore';
import { sweepBlobs } from '../../../src/fileSearch/blob/blobSweeper';
import { createS3Backend } from '../../../src/fileSearch/blob/s3Backend';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { s3TestConfigFromEnv } = require('../../../../../ci/scripts/file-search-test-s3.js');

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const S3 = s3TestConfigFromEnv(process.env);
// 300 for the acceptance run; the CI pipeline sets fewer so the suite does not crowd the timing
// tests that run beside it.
function raceIterations(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 300;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`FILE_SEARCH_RACE_ITERATIONS must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}
const ITERATIONS = raceIterations(process.env.FILE_SEARCH_RACE_ITERATIONS);
const WORKERS = 4;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

const backends = (['db', 's3'] as const).filter((b) => DSN && (b === 'db' || S3));
const d = backends.length > 0 ? describe : describe.skip;

d(`blob race: ${ITERATIONS} iterations, zero losses, zero orphans (requires FILE_SEARCH_TEST_DSN)`, () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const prefix = `fs-race-${crypto.randomBytes(4).toString('hex')}`;
  const s3Config = () => ({ bucket: S3.bucket, prefix, endpoint: S3.endpoint, region: S3.region });
  const direct = () => createS3Backend(s3Config(), {
    credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey },
  });
  const written: string[] = [];

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: 3,
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    };
    fixture = await createIsolatedSchema(DSN!, 3);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    if (S3) {
      setBlobS3CredentialsForTests({ accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey });
      for (const sha of written) await direct().delete(sha); // by exact key, never a listing
    }
    setBlobS3CredentialsForTests(null);
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  afterEach(() => jest.restoreAllMocks());

  const release0 = async (sha: string) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await releaseBlobIn(client, sha, { graceSeconds: 0 });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  const jitter = (maxMs = 3) => new Promise((r) => setTimeout(r, Math.floor(Math.random() * (maxMs + 1))));

  it.each(backends)('%s backend', async (backend) => {
    if (backend === 's3') {
      mockConfig.blobStorage = { backend: 's3', localPath: '', s3: s3Config() };
      setBlobS3CredentialsForTests({ accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey });
      // A local MinIO answers in about a millisecond; give the sweeper's object delete the 5-25 ms
      // a real S3 round trip takes, so a delete that is not covered by the lock can lose a race.
      const real = blobStore.backendForStorage;
      jest.spyOn(blobStore, 'backendForStorage').mockImplementation((storage, cfg) => {
        const backend = real(storage, cfg);
        return { ...backend, delete: async (sha, location) => {
          await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 21)));
          return backend.delete(sha, location);
        } };
      });
    }
    const started = Date.now();
    let losses = 0;
    let orphans = 0;
    let drift = 0;
    let deletedRows = 0;
    let racedDeletes = 0; // rows the racing sweepers deleted (the race really happened)
    let sweepFailures = 0;
    const errors: string[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      const bytes = Buffer.concat([Buffer.from(`race-${backend}-${i}:`), crypto.randomBytes(512)]);
      const sha = sha256Of(bytes);
      if (backend === 's3') written.push(sha);
      await retainBlob(sha, bytes, 'text/plain');
      const keepsOne = i % 2 === 0;
      const refs: Array<() => Promise<unknown>> = [
        () => release0(sha),
        keepsOne
          ? () => retainBlob(sha, bytes, 'text/plain')
          : async () => { await retainBlob(sha, bytes, 'text/plain'); await jitter(); await release0(sha); },
      ];
      let refsDone = false;
      const sweeper = async () => {
        do {
          const r = await sweepBlobs();
          racedDeletes += r.deleted;
          sweepFailures += r.failed + r.garbageFailed;
        } while (!refsDone);
      };
      const refRuns = Promise.allSettled(refs.map(async (op) => { await jitter(10); return op(); }))
        .finally(() => { refsDone = true; });
      const sweepRuns = Promise.allSettled([sweeper, sweeper].map(async (op) => { await jitter(); return op(); }));
      expect(refs.length + 2).toBe(WORKERS);
      for (const s of [...await refRuns, ...await sweepRuns]) if (s.status === 'rejected') errors.push(String(s.reason));
      const last = await sweepBlobs();
      sweepFailures += last.failed + last.garbageFailed;

      const expected = keepsOne ? 1 : 0;
      const { rows: [row] } = await pool.query(
        'SELECT ref_count, (delete_after IS NOT NULL) AS pending FROM file_blobs WHERE sha256 = $1', [sha]);
      if (expected > 0) {
        if (!row) {
          losses += 1;
          continue;
        }
        if (row.ref_count !== expected || row.pending) drift += 1;
        const got = await openBlob(sha).catch(() => null);
        if (!got || !got.equals(bytes)) losses += 1;
        if (backend === 's3') {
          const object = await direct().get(sha).catch(() => null);
          if (!object || !object.equals(bytes)) losses += 1;
        }
      } else {
        if (row) {
          orphans += 1; // a released row past its grace survived the final sweep
          continue;
        }
        deletedRows += 1;
        if (backend === 's3' && (await direct().exists(sha))) orphans += 1; // object left for a deleted row
      }
    }
    const { rows: [garbage] } = await pool.query('SELECT count(*)::int AS n FROM file_blob_garbage');

    const summary = {
      backend, iterations: ITERATIONS, workers: WORKERS, losses, orphans, drift, deletedRows, racedDeletes, sweepFailures,
      garbageLeft: garbage.n, errors: errors.length, durationMs: Date.now() - started,
    };
    // eslint-disable-next-line no-console
    console.log(`blob race result ${JSON.stringify(summary)}`);
    expect(errors).toEqual([]);
    expect({ losses, orphans, drift, sweepFailures, garbageLeft: garbage.n })
      .toEqual({ losses: 0, orphans: 0, drift: 0, sweepFailures: 0, garbageLeft: 0 });
    expect(deletedRows).toBe(Math.floor(ITERATIONS / 2));
    expect(racedDeletes).toBeGreaterThan(0);
  }, 600_000);
});
