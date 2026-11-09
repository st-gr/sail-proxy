// The blob migration job against a real Postgres, with an in-memory S3 backend (the MinIO run is
// blobMigrationMinio.test.ts): start and its refusals, the claim, a source that fails its SHA-256
// check, a row that vanished, a row already on the target, stale garbage of the target key,
// cancel (with an item in flight), retry, the derived job state and the worker loop.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import * as blobStore from '../../../src/fileSearch/blob/blobStore';
import { sha256Of } from '../../../src/fileSearch/blob/blobStore';
import { createDbBackend } from '../../../src/fileSearch/blob/dbBackend';
import { S3RequestError } from '../../../src/fileSearch/blob/s3Backend';
import {
  startBlobMigration, cancelBlobMigration, retryBlobMigration, blobMigrationJob, listBlobMigrationFailures,
} from '../../../src/fileSearch/blob/blobMigration';
import { processBlobMigrationItem, ProcessOptions } from '../../../src/fileSearch/blob/blobMigrationWorker';
import {
  claimNextBlobMigrationItem, startBlobMigrationWorker, stopBlobMigrationWorker,
} from '../../../src/fileSearch/blob/blobMigrationQueue';
import { sweepBlobs } from '../../../src/fileSearch/blob/blobSweeper';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

const ADMIN = { email: 'mig-admin@example.com' };
const keyOf = (sha: string) => `fake/${sha.slice(0, 2)}/${sha}`;

function freshContent(label: string): { bytes: Buffer; sha: string } {
  const bytes = Buffer.concat([Buffer.from(`${label}:`), crypto.randomBytes(128)]);
  return { bytes, sha: sha256Of(bytes) };
}

/** An in-memory S3: objects by key, every call recorded. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const backend = {
    keyFor: keyOf,
    put: jest.fn(async (sha: string, bytes: Buffer) => { calls.push(`put:${sha}`); objects.set(keyOf(sha), Buffer.from(bytes)); return { location: keyOf(sha) }; }),
    get: jest.fn(async (sha: string) => { calls.push(`get:${sha}`); return objects.get(keyOf(sha)) ?? null; }),
    delete: jest.fn(async (sha: string) => { calls.push(`delete:${sha}`); objects.delete(keyOf(sha)); }),
    exists: jest.fn(async (sha: string) => objects.has(keyOf(sha))),
    probe: jest.fn(async () => {}),
  };
  return { objects, calls, backend };
}

d('blob migration against Postgres (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let s3: ReturnType<typeof fakeS3>;

  const row = async (sha: string) => (await pool.query(
    'SELECT storage, location, bytes, delete_after FROM file_blobs WHERE sha256 = $1', [sha])).rows[0];
  const item = async (jobId: string, sha: string) => (await pool.query(
    'SELECT status, attempts, last_error, claimed_at FROM fs_blob_migration_items WHERE job_id = $1 AND sha256 = $2',
    [jobId, sha])).rows[0];
  const garbage = async () => (await pool.query(
    'SELECT storage, location, sha256, extract(epoch FROM delete_after - now()) AS ahead FROM file_blob_garbage ORDER BY location')).rows;
  const insertDb = (sha: string, bytes: Buffer, deleteAfter: string | null = null) => pool.query(
    `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, location, delete_after)
     VALUES ($1, $2, 'text/plain', 1, 'db', $3, NULL, $4)`, [sha, bytes.length, bytes, deleteAfter]);
  const insertS3 = async (sha: string, bytes: Buffer) => {
    s3.objects.set(keyOf(sha), bytes);
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, location)
       VALUES ($1, $2, 'text/plain', 1, 's3', NULL, $3)`, [sha, bytes.length, keyOf(sha)]);
  };
  const start = async (target: string) => {
    const started = await startBlobMigration(target, ADMIN);
    if (!started.ok) throw new Error(`start refused: ${started.error}`);
    return started.job;
  };
  /** Claims and processes until nothing is left; returns the outcomes. */
  const drain = async (opts: ProcessOptions = {}) => {
    const outcomes: string[] = [];
    for (let claimed = await claimNextBlobMigrationItem(); claimed; claimed = await claimNextBlobMigrationItem()) {
      outcomes.push(await processBlobMigrationItem(claimed, opts));
    }
    return outcomes;
  };

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: 3,
      ingestion: { maxRetries: 3, concurrency: 1 },
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
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    s3 = fakeS3();
    jest.spyOn(blobStore, 'backendForStorage').mockImplementation((storage: string) => {
      if (storage === 'db') return createDbBackend();
      if (storage === 's3') return s3.backend;
      throw new blobStore.BlobUnavailableError(storage, 'unsupported_storage');
    });
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM file_blobs');
    await pool.query('DELETE FROM file_blob_garbage');
  });

  afterEach(() => jest.restoreAllMocks());

  it('refuses an unknown target, an unreachable target, an empty move and a second migration', async () => {
    expect(await startBlobMigration('local', ADMIN)).toEqual({ ok: false, error: 'invalid_target' });
    expect(await startBlobMigration('s3', ADMIN)).toEqual({ ok: false, error: 'nothing_to_migrate' });
    expect((await pool.query('SELECT 1 FROM fs_jobs')).rowCount).toBe(0);

    const a = freshContent('refusals');
    await insertDb(a.sha, a.bytes);
    s3.backend.probe.mockClear();
    s3.backend.probe.mockRejectedValueOnce(new S3RequestError('PutObject', 403, 'AccessDenied'));
    const unreachable = await startBlobMigration('s3', ADMIN);
    expect(s3.backend.probe).toHaveBeenCalledTimes(1); // the in-prefix probe, not a bucket-level request
    expect(unreachable).toMatchObject({ ok: false, error: 'target_unavailable', detail: { reason: 'request_failed', op: 'PutObject', status: 403 } });
    expect((await pool.query('SELECT 1 FROM fs_jobs')).rowCount).toBe(0);

    const job = await start('s3');
    expect(job).toMatchObject({ kind: 'blob_migration', state: 'queued', total: 1, in_progress: 1, target_storage: 's3', started_by: ADMIN.email });
    expect(await startBlobMigration('db', ADMIN)).toEqual({ ok: false, error: 'migration_running', job_id: job.id });
    // The unique index refuses a racing insert that passed the pre-check.
    await expect(pool.query(`INSERT INTO fs_jobs (id, kind, target_storage) VALUES ('job_race', 'blob_migration', 'db')`))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('db -> s3: copies, verifies, switches the row (bytes dropped) and completes the job', async () => {
    const blobs = [freshContent('m1'), freshContent('m2'), freshContent('m3')];
    for (const b of blobs) await insertDb(b.sha, b.bytes);
    const job = await start('s3');
    expect(await drain()).toEqual(['completed', 'completed', 'completed']);
    for (const b of blobs) {
      const r = await row(b.sha);
      expect(r).toMatchObject({ storage: 's3', location: keyOf(b.sha), bytes: null });
      expect(s3.objects.get(keyOf(b.sha))!.equals(b.bytes)).toBe(true);
      // PUT, then the one read-back (in the switch, under the lock).
      expect(s3.calls.filter((c) => c.endsWith(b.sha))).toEqual([`put:${b.sha}`, `get:${b.sha}`]);
    }
    expect(await garbage()).toEqual([]); // a db source has no object
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', done: 3, failed: 0, total: 3, error: null });
    expect((await blobMigrationJob(job.id))!.finished_at).not.toBeNull();
  });

  it('s3 -> db: the bytes move into the row and the source object is queued as garbage after the grace', async () => {
    const a = freshContent('to-db');
    await insertS3(a.sha, a.bytes);
    const job = await start('db');
    expect(await drain()).toEqual(['completed']);
    const r = await row(a.sha);
    expect(r.storage).toBe('db');
    expect(r.location).toBeNull();
    expect(r.bytes.equals(a.bytes)).toBe(true);
    const queued = await garbage();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ storage: 's3', location: keyOf(a.sha), sha256: a.sha });
    expect(Number(queued[0].ahead)).toBeGreaterThan(14 * 60); // BLOB_RELEASE_GRACE_SECONDS
    expect(s3.calls).toEqual([`get:${a.sha}`]); // nothing deleted here
    expect((await blobMigrationJob(job.id))!.state).toBe('completed');
  });

  it('a source that fails its SHA-256 check fails the item for good and leaves the row alone', async () => {
    const good = freshContent('good');
    const bad = freshContent('bad');
    await insertDb(good.sha, good.bytes);
    await insertDb(bad.sha, Buffer.from('not the bytes of this sha'));
    const job = await start('s3');
    const outcomes = await drain();
    expect(outcomes.sort()).toEqual(['completed', 'failed']);
    expect(await item(job.id, bad.sha)).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await item(job.id, bad.sha)).last_error).toMatchObject({ name: 'BlobMigrationVerifyError' });
    const r = await row(bad.sha);
    expect(r).toMatchObject({ storage: 'db', location: null });
    expect(r.bytes.toString()).toBe('not the bytes of this sha');
    expect(s3.calls.some((c) => c.includes(bad.sha))).toBe(false); // never written
    const summary = await blobMigrationJob(job.id);
    expect(summary).toMatchObject({ state: 'completed_with_errors', done: 1, failed: 1 });
    expect(summary!.error).toMatchObject({ code: 'blob_migration_failed' });
    const failures = await listBlobMigrationFailures(job.id, { limit: 10 });
    expect(failures).toEqual([{
      id: bad.sha, sha256: bad.sha, source_storage: 'db', size_bytes: 25, attempts: 1,
      last_error: { message: 'the source copy of the blob does not match its SHA-256' },
    }]);
  });

  it('a row swept before the switch deletes its item, and the copy just written is queued as garbage', async () => {
    const a = freshContent('vanishing');
    await insertDb(a.sha, a.bytes);
    const job = await start('s3');
    const claimed = (await claimNextBlobMigrationItem())!;
    const outcome = await processBlobMigrationItem(claimed, {
      hooks: { afterTargetWrite: async () => { await pool.query('DELETE FROM file_blobs WHERE sha256 = $1', [a.sha]); } },
    });
    expect(outcome).toBe('vanished');
    expect(await item(job.id, a.sha)).toBeUndefined();
    expect(await garbage()).toMatchObject([{ storage: 's3', location: keyOf(a.sha), sha256: a.sha }]);
    // No item left: the job finished, with nothing done.
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', total: 0 });
  });

  it('a row gone before the item is processed deletes the item without touching any storage', async () => {
    const a = freshContent('gone-early');
    await insertDb(a.sha, a.bytes);
    const job = await start('s3');
    await pool.query('DELETE FROM file_blobs WHERE sha256 = $1', [a.sha]);
    expect(await drain()).toEqual(['vanished']);
    expect(await item(job.id, a.sha)).toBeUndefined();
    expect(s3.calls).toEqual([]);
    expect(await garbage()).toEqual([]);
  });

  it('a row already on the target counts completed with no copy', async () => {
    const a = freshContent('already');
    await insertDb(a.sha, a.bytes);
    const job = await start('s3');
    // Another path moved it meanwhile.
    s3.objects.set(keyOf(a.sha), a.bytes);
    await pool.query(`UPDATE file_blobs SET storage = 's3', location = $2, bytes = NULL WHERE sha256 = $1`, [a.sha, keyOf(a.sha)]);
    expect(await drain()).toEqual(['completed']);
    expect(await item(job.id, a.sha)).toMatchObject({ status: 'completed' });
    expect(s3.calls).toEqual([]);
  });

  it('a stale garbage entry of the target key is cancelled before the PUT (it would delete the new copy)', async () => {
    const a = freshContent('stale-garbage');
    await insertDb(a.sha, a.bytes);
    // Left by an earlier s3 -> db move, already due.
    await pool.query(
      `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after) VALUES ('s3', $1, $2, now() - interval '1 second')`,
      [keyOf(a.sha), a.sha]);
    let garbageAtPut: unknown[] | null = null;
    s3.backend.put.mockImplementationOnce(async (sha: string, bytes: Buffer) => {
      garbageAtPut = await garbage();
      s3.objects.set(keyOf(sha), bytes);
      return { location: keyOf(sha) };
    });
    await start('s3');
    expect(await drain()).toEqual(['completed']);
    expect(garbageAtPut).toEqual([]);
    expect(await garbage()).toEqual([]);
  });

  it('claims: one item per claim, a live lease is not taken again, an expired one is', async () => {
    const a = freshContent('claim-a');
    const b = freshContent('claim-b');
    await insertDb(a.sha, a.bytes);
    await insertDb(b.sha, b.bytes);
    const job = await start('s3');
    const [one, two] = await Promise.all([claimNextBlobMigrationItem(), claimNextBlobMigrationItem()]);
    expect(new Set([one!.sha256, two!.sha256])).toEqual(new Set([a.sha, b.sha]));
    expect(await claimNextBlobMigrationItem()).toBeNull();
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'running' });
    // A worker died holding `one`: once its lease expires it is claimed again.
    await pool.query(`UPDATE fs_blob_migration_items SET claimed_at = now() - interval '16 minutes' WHERE sha256 = $1`, [one!.sha256]);
    const again = (await claimNextBlobMigrationItem())!;
    expect(again.sha256).toBe(one!.sha256);
    expect((await item(job.id, one!.sha256)).attempts).toBe(2);
    // The dead worker's late failure report no longer matches the claim: the item stays the new worker's.
    expect(await processBlobMigrationItem(one!, { hooks: { afterTargetWrite: async () => { throw new Error('late'); } } }))
      .toBe('retry');
    expect((await item(job.id, one!.sha256)).claimed_at).not.toBeNull();
    expect(await processBlobMigrationItem(again)).toBe('completed');
    expect(await processBlobMigrationItem(two!)).toBe('completed');
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', done: 2 });
  });

  it('cancel: every open item cancelled, the in-flight one moves nothing, nothing is claimed afterwards', async () => {
    const blobs = [freshContent('c1'), freshContent('c2'), freshContent('c3')];
    for (const b of blobs) await insertDb(b.sha, b.bytes);
    const job = await start('s3');
    const claimed = (await claimNextBlobMigrationItem())!;
    let cancelled: Awaited<ReturnType<typeof cancelBlobMigration>> | null = null;
    const outcome = await processBlobMigrationItem(claimed, {
      hooks: { afterTargetWrite: async () => { cancelled = await cancelBlobMigration(job.id); } },
    });
    expect(outcome).toBe('skipped');
    expect(cancelled).toMatchObject({ ok: true, job: { state: 'cancelled' } });
    expect(await row(claimed.sha256)).toMatchObject({ storage: 'db' });
    expect(await item(job.id, claimed.sha256)).toMatchObject({ status: 'cancelled' });
    // The copy it had PUT is nobody's: queued as garbage.
    expect(await garbage()).toMatchObject([{ storage: 's3', location: keyOf(claimed.sha256) }]);
    expect(await claimNextBlobMigrationItem()).toBeNull();
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'cancelled', done: 0, cancelled: 3, in_progress: 0 });
    for (const b of blobs) expect(await row(b.sha)).toMatchObject({ storage: 'db' });
    // Cancel is one-way; a finished job is answered unchanged; a new migration may start.
    expect(await cancelBlobMigration(job.id)).toMatchObject({ ok: true, job: { state: 'cancelled' } });
    expect(await retryBlobMigration(job.id)).toEqual({ ok: false, error: 'nothing_to_retry' });
    expect(await cancelBlobMigration('job_unknown')).toEqual({ ok: false, error: 'not_found' });
    expect((await startBlobMigration('s3', ADMIN)).ok).toBe(true);
  });

  it('a cancel and an opposite migration started while an item is in flight: every row agrees with the new job', async () => {
    const x = freshContent('in-flight');
    const y = freshContent('on-s3');
    await insertDb(x.sha, x.bytes);
    await insertS3(y.sha, y.bytes);
    const first = await start('s3'); // takes x only
    let second: Awaited<ReturnType<typeof start>> | null = null;
    const claimed = (await claimNextBlobMigrationItem())!;
    expect(claimed.sha256).toBe(x.sha);
    await processBlobMigrationItem(claimed, {
      hooks: {
        afterTargetWrite: async () => {
          await cancelBlobMigration(first.id);
          second = await start('db'); // its snapshot: y only, x is on db
        },
      },
    });
    await drain();
    expect(await blobMigrationJob(second!.id)).toMatchObject({ state: 'completed', done: 1, total: 1 });
    expect(await row(x.sha)).toMatchObject({ storage: 'db' });
    expect(await row(y.sha)).toMatchObject({ storage: 'db' });
    expect((await row(x.sha)).bytes.equals(x.bytes)).toBe(true);
    expect((await row(y.sha)).bytes.equals(y.bytes)).toBe(true);
  });

  it('a garbage entry of the target key queued between the PUT and the switch: deleted, and the copy read again under the lock', async () => {
    const a = freshContent('late-entry');
    const b = freshContent('late-entry-gone');
    await insertDb(a.sha, a.bytes);
    await insertDb(b.sha, b.bytes);
    const enqueue = (sha: string) => pool.query(
      `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after) VALUES ('s3', $1, $2, now() + interval '2 minutes')`,
      [keyOf(sha), sha]);
    const job = await start('s3');
    const interfered = new Set<string>();
    const hooks = {
      afterTargetWrite: async (it: { sha256: string }) => {
        if (interfered.has(it.sha256)) return; // first attempt only
        interfered.add(it.sha256);
        await enqueue(it.sha256);
        // For b, the garbage pass got there first: the copy is gone.
        if (it.sha256 === b.sha) s3.objects.delete(keyOf(b.sha));
      },
    };
    // The first outcome of each item (b, failing, is claimable again at once; the claim order is by sha).
    const outcomes: Record<string, string> = {};
    let bAfterFirst: { row: any; item: any } | null = null;
    while (Object.keys(outcomes).length < 2) {
      const claimed = (await claimNextBlobMigrationItem())!;
      const outcome = await processBlobMigrationItem(claimed, { hooks });
      if (claimed.sha256 === b.sha && !outcomes[b.sha]) bAfterFirst = { row: await row(b.sha), item: await item(job.id, b.sha) };
      outcomes[claimed.sha256] ??= outcome;
    }
    expect(outcomes[a.sha]).toBe('completed');
    expect(s3.calls.filter((c) => c === `get:${a.sha}`)).toHaveLength(1); // the read-back under the lock
    expect(await row(a.sha)).toMatchObject({ storage: 's3' });
    expect(outcomes[b.sha]).toBe('retry');
    expect(bAfterFirst!.row).toMatchObject({ storage: 'db', location: null });
    expect(bAfterFirst!.item).toMatchObject({ status: 'in_progress', last_error: { name: 'BlobMigrationVerifyError' } });
    // The next attempt cancels the entry and writes the copy again.
    await drain();
    expect(await row(b.sha)).toMatchObject({ storage: 's3' });
    expect(s3.objects.get(keyOf(b.sha))!.equals(b.bytes)).toBe(true);
    expect(await garbage()).toEqual([]);
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', done: 2 });
  });

  it('an entry for the target key queued AND swept between the PUT and the switch: the switch finds the copy gone', async () => {
    const a = freshContent('swept-in-window');
    await insertDb(a.sha, a.bytes);
    const job = await start('s3');
    const claimed = (await claimNextBlobMigrationItem())!;
    const outcome = await processBlobMigrationItem(claimed, {
      hooks: {
        afterTargetWrite: async () => {
          await pool.query(
            `INSERT INTO file_blob_garbage (storage, location, sha256, delete_after) VALUES ('s3', $1, $2, now() - interval '1 second')`,
            [keyOf(a.sha), a.sha]);
          expect(await sweepBlobs()).toMatchObject({ garbageDeleted: 1 }); // no s3 row of the sha yet: deleted
          expect(s3.objects.has(keyOf(a.sha))).toBe(false);
        },
      },
    });
    expect(outcome).toBe('retry');
    expect(await row(a.sha)).toMatchObject({ storage: 'db', location: null });
    expect((await item(job.id, a.sha)).last_error).toMatchObject({ name: 'BlobMigrationVerifyError' });
    // The retry re-PUTs and completes.
    expect(await drain()).toEqual(['completed']);
    expect(await row(a.sha)).toMatchObject({ storage: 's3' });
    expect(s3.objects.get(keyOf(a.sha))!.equals(a.bytes)).toBe(true);
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', done: 1 });
  });

  it('an item the reaper failed while its worker still ran: the late switch moves nothing and the failure stands', async () => {
    const a = freshContent('reaped');
    await insertDb(a.sha, a.bytes);
    const job = await start('s3');
    const claimed = (await claimNextBlobMigrationItem())!;
    const outcome = await processBlobMigrationItem(claimed, {
      hooks: {
        afterTargetWrite: async () => {
          await pool.query(`UPDATE fs_blob_migration_items SET attempts = 3, claimed_at = now() - interval '16 minutes'`);
          expect(await claimNextBlobMigrationItem()).toBeNull(); // the reaper runs first
        },
      },
    });
    expect(outcome).toBe('skipped');
    expect(await item(job.id, a.sha)).toMatchObject({ status: 'failed' });
    expect(await row(a.sha)).toMatchObject({ storage: 'db' });
    expect(await garbage()).toMatchObject([{ storage: 's3', location: keyOf(a.sha) }]);
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'failed', done: 0, failed: 1 });
    expect(await retryBlobMigration(job.id)).toMatchObject({ ok: true, retried: 1 });
    expect(await drain()).toEqual(['completed']);
    expect(await row(a.sha)).toMatchObject({ storage: 's3' });
  });

  it('retry: failed items re-open and the job runs again from where it stopped', async () => {
    const a = freshContent('retry-ok');
    const b = freshContent('retry-flaky');
    await insertDb(a.sha, a.bytes);
    await insertDb(b.sha, b.bytes);
    const job = await start('s3');
    const realPut = s3.backend.put.getMockImplementation()!;
    s3.backend.put.mockImplementation(async (sha: string, bytes: Buffer) => {
      if (sha === b.sha) throw new S3RequestError('PutObject', 503, 'SlowDown');
      return realPut(sha, bytes);
    });
    await drain();
    expect(await item(job.id, b.sha)).toMatchObject({ status: 'failed', attempts: 3 }); // ingestion.maxRetries
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed_with_errors', done: 1, failed: 1 });
    expect(await retryBlobMigration('job_unknown')).toEqual({ ok: false, error: 'not_found' });

    s3.backend.put.mockImplementation(realPut);
    expect(await retryBlobMigration(job.id)).toEqual({ ok: true, job_id: job.id, retried: 1 });
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'running', finished_at: null, error: null });
    expect(await retryBlobMigration(job.id)).toEqual({ ok: false, error: 'job_running' });
    expect(await drain()).toEqual(['completed']);
    expect(await row(b.sha)).toMatchObject({ storage: 's3' });
    expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', done: 2, failed: 0 });
    expect(await retryBlobMigration(job.id)).toEqual({ ok: false, error: 'nothing_to_retry' });
  });

  it('retry is refused once a newer migration was started, and while another one is unfinished', async () => {
    const a = freshContent('retry-blocked');
    await insertDb(a.sha, a.bytes);
    const job = await start('s3');
    s3.backend.put.mockRejectedValue(new S3RequestError('PutObject', 500, 'InternalError'));
    await drain();
    expect((await blobMigrationJob(job.id))!.state).toBe('failed');
    const newer = await start('s3'); // a is still on db: the new job takes it
    expect(await retryBlobMigration(job.id)).toEqual({ ok: false, error: 'superseded' });
    await drain();
    expect((await blobMigrationJob(newer.id))!.state).toBe('failed');
    expect(await retryBlobMigration(job.id)).toEqual({ ok: false, error: 'superseded' });
    // An older job unfinished (it cannot be retried past the newer one): the unique index refuses.
    await pool.query(`UPDATE fs_jobs SET finished_at = NULL WHERE id = $1`, [job.id]);
    expect(await retryBlobMigration(newer.id)).toEqual({ ok: false, error: 'job_running' });
  });

  it('released rows are migrated too', async () => {
    const a = freshContent('released');
    await insertDb(a.sha, a.bytes, new Date(Date.now() + 600_000).toISOString());
    await start('s3');
    expect(await drain()).toEqual(['completed']);
    const r = await row(a.sha);
    expect(r.storage).toBe('s3');
    expect(r.delete_after).not.toBeNull(); // still released: the sweeper deletes it later
  });

  it('the worker loop picks a started job up and finishes it', async () => {
    const blobs = [freshContent('loop1'), freshContent('loop2')];
    for (const b of blobs) await insertDb(b.sha, b.bytes);
    startBlobMigrationWorker();
    try {
      const job = await start('s3');
      const deadline = Date.now() + 10_000;
      while ((await blobMigrationJob(job.id))!.state !== 'completed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await blobMigrationJob(job.id)).toMatchObject({ state: 'completed', done: 2 });
    } finally {
      await stopBlobMigrationWorker();
    }
  });
});
