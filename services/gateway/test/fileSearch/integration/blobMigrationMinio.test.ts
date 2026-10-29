// The blob migration against a real Postgres and a real MinIO (FILE_SEARCH_TEST_S3_*, never the
// product FILE_SEARCH_S3_* variables): db -> s3 and back with every blob readable afterwards, the
// s3 sources queued as garbage and removed by a sweep; a worker killed between its PUT and its
// COMMIT, then the restart finishing the job; a cancel mid-run. Objects are deleted by exact key.
import * as crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { retainBlob, openBlob, sha256Of, setBlobS3CredentialsForTests } from '../../../src/fileSearch/blob/blobStore';
import { sweepBlobs } from '../../../src/fileSearch/blob/blobSweeper';
import { createS3Backend } from '../../../src/fileSearch/blob/s3Backend';
import { startBlobMigration, cancelBlobMigration, blobMigrationJob } from '../../../src/fileSearch/blob/blobMigration';
import { processBlobMigrationItem, ProcessOptions } from '../../../src/fileSearch/blob/blobMigrationWorker';
import { claimNextBlobMigrationItem } from '../../../src/fileSearch/blob/blobMigrationQueue';
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

const ADMIN = { email: 'mig-admin@example.com' };
const N = 6;

function freshContent(label: string): { bytes: Buffer; sha: string } {
  const bytes = Buffer.concat([Buffer.from(`${label}:`), crypto.randomBytes(512)]);
  return { bytes, sha: sha256Of(bytes) };
}

dS3('blob migration with MinIO (requires FILE_SEARCH_TEST_DSN and FILE_SEARCH_TEST_S3_*)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const prefix = `fs-migration-${crypto.randomBytes(4).toString('hex')}`;
  const s3Config = () => ({ bucket: S3.bucket, prefix, endpoint: S3.endpoint, region: S3.region });
  const credentials = () => ({ accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey });
  const direct = () => createS3Backend(s3Config(), { credentials: credentials() });
  const written: string[] = [];
  const useBackend = (backend: 'db' | 's3') => { mockConfig.blobStorage = { backend, localPath: '', s3: s3Config() }; };

  const row = async (sha: string) => (await pool.query(
    'SELECT storage, location, bytes IS NULL AS no_bytes FROM file_blobs WHERE sha256 = $1', [sha])).rows[0];
  const garbageCount = async () => Number((await pool.query('SELECT count(*) FROM file_blob_garbage')).rows[0].count);
  const seed = async (label: string, n = N) => {
    const blobs = Array.from({ length: n }, (_, i) => freshContent(`${label}-${i}`));
    for (const b of blobs) {
      written.push(b.sha);
      await retainBlob(b.sha, b.bytes, 'application/octet-stream');
    }
    return blobs;
  };
  const start = async (target: string) => {
    const started = await startBlobMigration(target, ADMIN);
    if (!started.ok) throw new Error(`start refused: ${started.error}`);
    return started.job;
  };
  const drain = async (opts: ProcessOptions = {}) => {
    for (let claimed = await claimNextBlobMigrationItem(); claimed; claimed = await claimNextBlobMigrationItem()) {
      await processBlobMigrationItem(claimed, opts);
    }
  };
  const expectReadable = async (blobs: Array<{ bytes: Buffer; sha: string }>) => {
    for (const b of blobs) expect((await openBlob(b.sha)).equals(b.bytes)).toBe(true);
  };

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: 3,
      ingestion: { maxRetries: 3, concurrency: 1 },
      limits: { maxFilesPerStore: 10000 },
    };
    useBackend('db');
    setBlobS3CredentialsForTests(credentials());
    fixture = await createIsolatedSchema(DSN!, 3);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    for (const sha of written) await direct().delete(sha); // by exact key, never a listing
    setBlobS3CredentialsForTests(null);
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    useBackend('db');
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM file_blobs');
    await pool.query('DELETE FROM file_blob_garbage');
  });

  it('db -> s3 -> db: every blob readable throughout; the s3 sources are queued and swept', async () => {
    const blobs = await seed('roundtrip');
    const toS3 = await start('s3');
    await drain();
    expect(await blobMigrationJob(toS3.id)).toMatchObject({ state: 'completed', done: N, failed: 0 });
    for (const b of blobs) {
      expect(await row(b.sha)).toMatchObject({ storage: 's3', no_bytes: true });
      expect((await direct().get(b.sha))!.equals(b.bytes)).toBe(true);
    }
    await expectReadable(blobs);
    expect(await garbageCount()).toBe(0);

    useBackend('s3'); // the admin switched the configured backend; now back to the database
    const toDb = await start('db');
    await drain({ garbageGraceSeconds: 0 });
    expect(await blobMigrationJob(toDb.id)).toMatchObject({ state: 'completed', done: N });
    for (const b of blobs) expect(await row(b.sha)).toMatchObject({ storage: 'db', location: null, no_bytes: false });
    await expectReadable(blobs);
    expect(await garbageCount()).toBe(N);
    // The source objects stay until the garbage pass deletes them, by exact key.
    for (const b of blobs) expect(await direct().get(b.sha)).not.toBeNull();
    expect(await sweepBlobs()).toMatchObject({ garbageDeleted: N, garbageFailed: 0 });
    expect(await garbageCount()).toBe(0);
    for (const b of blobs) expect(await direct().get(b.sha)).toBeNull();
    await expectReadable(blobs);
  });

  it('a worker killed between its PUT and its COMMIT: the restart reclaims the item and finishes the job', async () => {
    const blobs = await seed('restart');
    const job = await start('s3');
    // Two items move normally.
    for (let i = 0; i < 2; i++) await processBlobMigrationItem((await claimNextBlobMigrationItem())!);
    // The third worker dies inside its switch transaction, after the PUT.
    const victim = (await claimNextBlobMigrationItem())!;
    let release!: () => void;
    let killed!: () => void;
    const wasKilled = new Promise<void>((resolve) => { killed = resolve; });
    const hung = processBlobMigrationItem(victim, {
      hooks: {
        beforeCommit: async (_item, client: PoolClient) => {
          client.on('error', () => {}); // the terminated connection reports here
          const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          await pool.query('SELECT pg_terminate_backend($1)', [pid]);
          killed();
          await new Promise<void>((resolve) => { release = resolve; });
        },
      },
    });
    await wasKilled;
    // The switch rolled back with the connection: the row is still on db; the object was PUT.
    expect(await row(victim.sha256)).toMatchObject({ storage: 'db' });
    expect((await direct().get(victim.sha256))).not.toBeNull();
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'running', done: 2 });

    // "Restart": the victim's lease expires, a new worker claims everything left and finishes.
    await pool.query(`UPDATE fs_blob_migration_items SET claimed_at = now() - interval '16 minutes'
                       WHERE job_id = $1 AND sha256 = $2`, [job.id, victim.sha256]);
    await drain();
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', done: N, failed: 0 });
    for (const b of blobs) expect(await row(b.sha)).toMatchObject({ storage: 's3', no_bytes: true });
    await expectReadable(blobs);

    // The dead worker's late wake-up changes nothing.
    release();
    expect(await hung).toBe('retry');
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', done: N, failed: 0 });
    expect(await garbageCount()).toBe(0);
    await expectReadable(blobs);
  });

  it('cancel mid-run: the blob moved before stays on s3, the in-flight one and the rest on db, all readable', async () => {
    const blobs = await seed('cancel');
    const job = await start('s3');
    await processBlobMigrationItem((await claimNextBlobMigrationItem())!);
    const inFlight = (await claimNextBlobMigrationItem())!;
    await processBlobMigrationItem(inFlight, { hooks: { afterTargetWrite: async () => { await cancelBlobMigration(job.id); } } });
    expect(await claimNextBlobMigrationItem()).toBeNull();
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'cancelled', done: 1, cancelled: N - 1, in_progress: 0 });
    const storages = await Promise.all(blobs.map(async (b) => (await row(b.sha)).storage));
    expect(storages.filter((s) => s === 's3')).toHaveLength(1);
    expect(storages.filter((s) => s === 'db')).toHaveLength(N - 1);
    expect(await row(inFlight.sha256)).toMatchObject({ storage: 'db' });
    await expectReadable(blobs);
  });
});
