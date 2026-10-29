// Live-Postgres coverage of the job-history sweeper: it deletes the job rows
// of jobs that finished more than 30 days ago, and nothing else — not an
// unfinished job however old, not a recently finished one, and never the
// batch or its member files the job described.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import { sweepFinishedJobs, settleOrphanedJobs } from '../../../src/fileSearch/jobSweeper';
import { sweepExpiredStores } from '../../../src/fileSearch/expirySweeper';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'sweep-owner@example.test';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

d('jobSweeper against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    };
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
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
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  async function seedFileRow(): Promise<string> {
    const content = Buffer.from(`sweep ${crypto.randomBytes(6).toString('hex')}`);
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,'doc.txt','assistants',$3,$4, now())`,
      [fileId, OWNER, sha, content.length],
    );
    return fileId;
  }

  /** A store with a one-file batch whose job finished `finishedAgo` ago (or
   *  is unfinished when null) and was created `createdAgo` ago. */
  async function seedJob(createdAgo: string, finishedAgo: string | null): Promise<{ jobId: string; batchId: string; storeId: string }> {
    const store = await repo.createStore({ ownerEmail: OWNER });
    const fileId = await seedFileRow();
    const batch = await createBatch(store.id, [fileId], null, null);
    const { rows } = await pool.query(
      `UPDATE fs_jobs SET created_at = now() - $2::interval,
                          finished_at = CASE WHEN $3::interval IS NULL THEN NULL ELSE now() - $3::interval END
        WHERE batch_id = $1 RETURNING id`,
      [batch.id, createdAgo, finishedAgo],
    );
    return { jobId: rows[0].id, batchId: batch.id, storeId: store.id };
  }

  async function jobExists(jobId: string): Promise<boolean> {
    return ((await pool.query('SELECT 1 FROM fs_jobs WHERE id = $1', [jobId])).rowCount ?? 0) > 0;
  }

  it('deletes only jobs finished more than 30 days ago, keeping their batch and files', async () => {
    const old = await seedJob('40 days', '31 days');
    const recent = await seedJob('40 days', '29 days');
    const unfinished = await seedJob('90 days', null);

    expect(await sweepFinishedJobs()).toBe(1);

    expect(await jobExists(old.jobId)).toBe(false);
    expect(await jobExists(recent.jobId)).toBe(true);
    expect(await jobExists(unfinished.jobId)).toBe(true);
    const batch = await pool.query('SELECT 1 FROM vector_store_batches WHERE id = $1', [old.batchId]);
    expect(batch.rowCount).toBe(1);
    const files = await pool.query(
      'SELECT 1 FROM vector_store_files WHERE store_id = $1 AND batch_id = $2', [old.storeId, old.batchId]);
    expect(files.rowCount).toBe(1);

    // A second pass finds nothing more.
    expect(await sweepFinishedJobs()).toBe(0);
  });

  async function finishedAt(jobId: string): Promise<Date | null> {
    return (await pool.query('SELECT finished_at FROM fs_jobs WHERE id = $1', [jobId])).rows[0].finished_at;
  }

  /** Ages a finished job so that it falls outside the 30-day history. */
  async function ageFinished(jobId: string): Promise<void> {
    await pool.query(`UPDATE fs_jobs SET finished_at = now() - interval '31 days' WHERE id = $1`, [jobId]);
  }

  it('finishes the job of an expired store whose files were deleted mid-ingestion, and deletes it 30 days later', async () => {
    const job = await seedJob('1 day', null); // its one member is still in_progress
    await pool.query(`UPDATE vector_stores SET expires_at = now() - interval '1 minute' WHERE id = $1`, [job.storeId]);
    expect(await sweepExpiredStores()).toBe(1);
    expect(await finishedAt(job.jobId)).toBeNull();

    expect(await sweepFinishedJobs()).toBe(0);
    expect(await finishedAt(job.jobId)).toBeInstanceOf(Date);

    await ageFinished(job.jobId);
    expect(await sweepFinishedJobs()).toBe(1);
    expect(await jobExists(job.jobId)).toBe(false);
  });

  it('finishes the job whose last in-progress file was detached, and deletes it 30 days later', async () => {
    const job = await seedJob('1 day', null);
    const extra = await seedFileRow();
    await repo.attachFile(job.storeId, extra, null, null, job.batchId);
    const { rows } = await pool.query(
      'SELECT file_id FROM vector_store_files WHERE store_id = $1 ORDER BY created_at', [job.storeId]);
    await pool.query(`UPDATE vector_store_files SET status = 'completed' WHERE store_id = $1 AND file_id = $2`,
      [job.storeId, rows[0].file_id]);
    expect(await repo.deleteStoreFile(job.storeId, rows[1].file_id, OWNER)).toEqual({ deleted: true });
    expect(await finishedAt(job.jobId)).toBeNull();

    expect(await settleOrphanedJobs()).toBe(1);
    expect(await finishedAt(job.jobId)).toBeInstanceOf(Date);
    expect(await settleOrphanedJobs()).toBe(0); // set exactly once

    await ageFinished(job.jobId);
    expect(await sweepFinishedJobs()).toBe(1);
    expect(await jobExists(job.jobId)).toBe(false);
  });

  it('finishes a job whose batch has no members left at all', async () => {
    const job = await seedJob('1 day', null);
    await pool.query('DELETE FROM vector_store_files WHERE store_id = $1', [job.storeId]);
    expect(await settleOrphanedJobs()).toBe(1);
    expect(await finishedAt(job.jobId)).toBeInstanceOf(Date);
  });

  it('leaves a job with a member in_progress, and a re-embed with an open item, unfinished', async () => {
    const running = await seedJob('1 day', null);
    await pool.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, store_id, created_at)
       VALUES ('job_0000000000000000000000ff', 'reembed_store', $1, $2, now() - interval '1 day')`,
      [OWNER, running.storeId]);
    await pool.query(
      `INSERT INTO fs_reembed_items (job_id, store_id, file_id) VALUES ('job_0000000000000000000000ff', $1, 'file-open')`,
      [running.storeId]);
    expect(await settleOrphanedJobs()).toBe(0);
    expect(await finishedAt(running.jobId)).toBeNull();
    expect(await finishedAt('job_0000000000000000000000ff')).toBeNull();
  });

  it('leaves a job created in the last 5 minutes alone: createBatch may still be attaching its members', async () => {
    // createBatch commits the job row before the first attach commits, so a
    // fresh job with no member yet is being created, not orphaned.
    const fresh = await seedJob('1 minute', null);
    const old = await seedJob('6 minutes', null);
    await pool.query('DELETE FROM vector_store_files WHERE store_id = ANY($1)', [[fresh.storeId, old.storeId]]);
    expect(await settleOrphanedJobs()).toBe(1);
    expect(await finishedAt(fresh.jobId)).toBeNull();
    expect(await finishedAt(old.jobId)).toBeInstanceOf(Date);
  });

  it('does not finish a job that a concurrent retry reopens while the sweeper waits on its row', async () => {
    const job = await seedJob('1 day', null);
    await pool.query(`UPDATE vector_store_files SET status = 'failed' WHERE store_id = $1`, [job.storeId]);

    // A retry-like transaction: members first, then the job row (jobs.ts's order).
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE vector_store_files SET status = 'in_progress', attempts = 0 WHERE store_id = $1`, [job.storeId]);
      await holder.query('UPDATE fs_jobs SET finished_at = NULL WHERE id = $1', [job.jobId]);
      const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      // The sweeper's snapshot still sees the member failed, so the job is a
      // candidate; it blocks on the job row the retry holds.
      const settling = settleOrphanedJobs();
      for (let i = 0; ; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const blocked = await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid]);
        if (blocked.rowCount) break;
        if (i > 300) throw new Error('the sweeper never blocked on the retry');
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 10));
      }
      await holder.query('COMMIT');
      expect(await settling).toBe(0);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    expect(await finishedAt(job.jobId)).toBeNull();
  });

  it('takes the retention in days', async () => {
    const job = await seedJob('10 days', '8 days');
    expect(await sweepFinishedJobs(30)).toBe(0);
    expect(await sweepFinishedJobs(7)).toBe(1);
    expect(await jobExists(job.jobId)).toBe(false);
  });
});
