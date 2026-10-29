// File-batch JOBS against a real Postgres database.
//
// A job's state and counters are derived from the batch's member files and the
// batch's cancel latch (plan decision 1), so, like batches.test.ts, every
// property here IS the SQL and cannot be shown against a mock: the derivation
// is one aggregate query, the tenant boundary is an owner predicate inside each
// statement, the backfill is an INSERT ... SELECT in the schema script, and
// retry is a transaction whose guarantees depend on real row locks.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId, newBatchId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch, requestBatchCancel } from '../../../src/fileSearch/batches';
import {
  jobSummary,
  jobSummaryAnyOwner,
  addJobOcrTotals,
  listJobs,
  markStartedIfNeeded,
  settleFinishedIfTerminal,
  addTokens,
  retryJob,
  retryFile,
} from '../../../src/fileSearch/jobs';
import { listAllJobs } from '../../../src/fileSearch/admin';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'jobs-owner@example.test';
const OTHER = 'jobs-other@example.test';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function baseConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'test-model',
    embeddingDimensions: EMBED_DIM,
    limits: { maxFilesPerStore: 10000 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

d('file batch jobs against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = baseConfig();
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
    mockConfig = baseConfig();
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  async function seedFile(owner: string, filename: string): Promise<string> {
    const content = Buffer.from(`${filename}:${crypto.randomBytes(6).toString('hex')}`);
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, owner, filename, sha, content.length],
    );
    return id;
  }

  async function seedStore(owner = OWNER, name: string | null = 'Handbook'): Promise<string> {
    const store = await repo.createStore({ ownerEmail: owner, name });
    return store.id;
  }

  /** A store with a batch of `n` files; returns the ids and the job's id. */
  async function seedBatch(n: number, owner = OWNER, opts: Parameters<typeof createBatch>[4] = {}): Promise<{
    storeId: string; batchId: string; jobId: string; fileIds: string[];
  }> {
    const storeId = await seedStore(owner);
    const fileIds: string[] = [];
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      fileIds.push(await seedFile(owner, `f${i}.txt`));
    }
    const batch = await createBatch(storeId, fileIds, null, null, opts);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM fs_jobs WHERE batch_id = $1', [batch.id]);
    expect(rows).toHaveLength(1);
    return { storeId, batchId: batch.id, jobId: rows[0].id, fileIds };
  }

  /** Sets one member's status/attempts the way the worker would. */
  async function setFile(storeId: string, fileId: string, status: string, attempts = 1): Promise<void> {
    const r = await pool.query(
      `UPDATE vector_store_files SET status = $3, attempts = $4,
              last_error = CASE WHEN $3 = 'failed' THEN '{"message":"boom"}'::jsonb ELSE NULL END
        WHERE store_id = $1 AND file_id = $2`,
      [storeId, fileId, status, attempts],
    );
    expect(r.rowCount).toBe(1);
  }

  async function fileRow(storeId: string, fileId: string): Promise<any> {
    const { rows } = await pool.query(
      'SELECT status, attempts, last_error, claimed_at FROM vector_store_files WHERE store_id = $1 AND file_id = $2',
      [storeId, fileId],
    );
    return rows[0];
  }

  async function jobRow(jobId: string): Promise<any> {
    const { rows } = await pool.query('SELECT * FROM fs_jobs WHERE id = $1', [jobId]);
    return rows[0];
  }

  // -----------------------------------------------------------------------
  // creation with the batch
  // -----------------------------------------------------------------------

  it('creates one job row with the batch, carrying the store owner and the request identity', async () => {
    const { storeId, batchId, jobId } = await seedBatch(2, OWNER, {
      startedBy: 'cockpit-user@example.test', credentialId: 'svc-key-1', authType: 'api_key',
    });
    expect(jobId).toMatch(/^job_[0-9a-f]{24}$/);
    const row = await jobRow(jobId);
    expect(row).toMatchObject({
      kind: 'file_batch',
      owner_email: OWNER,
      started_by: 'cockpit-user@example.test',
      credential_id: 'svc-key-1',
      auth_type: 'api_key',
      store_id: storeId,
      batch_id: batchId,
      parent_id: null,
      error: null,
      started_at: null,
      finished_at: null,
    });
    expect(Number(row.embedding_tokens)).toBe(0);
  });

  it('defaults started_by to the store owner and leaves the credential null when none is given', async () => {
    const { jobId } = await seedBatch(1);
    const row = await jobRow(jobId);
    expect(row.started_by).toBe(OWNER);
    expect(row.credential_id).toBeNull();
    expect(row.auth_type).toBeNull();
  });

  it('deletes the job together with a batch that fails partway through', async () => {
    const storeId = await seedStore();
    const a = await seedFile(OWNER, 'a.txt');
    const b = await seedFile(OWNER, 'b.txt');
    await repo.attachFile(storeId, b, null); // b is already attached: the batch fails on it

    await expect(createBatch(storeId, [a, b], null, null)).rejects.toMatchObject({ code: '23505' });

    const jobs = await pool.query('SELECT id FROM fs_jobs');
    expect(jobs.rows).toEqual([]);
    const batches = await pool.query('SELECT id FROM vector_store_batches');
    expect(batches.rows).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // backfill
  // -----------------------------------------------------------------------

  it('backfills exactly one job per pre-existing batch, idempotently, with the backfill id shape', async () => {
    const storeId = await seedStore();
    const other = await seedStore(OTHER);
    const b1 = newBatchId();
    const b2 = newBatchId();
    const b3 = newBatchId();
    // Batches as an install that predates fs_jobs holds them: no job rows.
    await pool.query(
      `INSERT INTO vector_store_batches (id, store_id, cancel_requested, created_at)
       VALUES ($1,$4,false, now() - interval '2 days'), ($2,$4,true, now() - interval '1 day'), ($3,$5,false, now())`,
      [b1, b2, b3, storeId, other],
    );
    // b3 already has a job (created by createBatch after the upgrade): left alone.
    await pool.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, started_by, store_id, batch_id)
       VALUES ('job_000000000000000000000001', 'file_batch', $1, $1, $2, $3)`,
      [OTHER, other, b3],
    );

    __resetForTests();
    await pool.end();
    expect(await runMigration()).toBe(true);
    await runMigration(); // a second boot must not duplicate anything
    pool = getPool()!;

    const { rows } = await pool.query(
      'SELECT id, batch_id, owner_email, started_by, store_id, created_at FROM fs_jobs ORDER BY batch_id',
    );
    expect(rows).toHaveLength(3);
    const byBatch = new Map(rows.map((r: any) => [r.batch_id, r]));
    for (const b of [b1, b2]) {
      const job: any = byBatch.get(b);
      expect(job.id).toBe(`job_${crypto.createHash('md5').update(b).digest('hex').slice(0, 24)}`);
      expect(job.id).toMatch(/^job_[0-9a-f]{24}$/);
      expect(job.owner_email).toBe(OWNER);
      expect(job.started_by).toBe(OWNER);
      expect(job.store_id).toBe(storeId);
    }
    expect((byBatch.get(b3) as any).id).toBe('job_000000000000000000000001');
    const batchCreated = await pool.query('SELECT created_at FROM vector_store_batches WHERE id = $1', [b1]);
    expect((byBatch.get(b1) as any).created_at.getTime()).toBe(batchCreated.rows[0].created_at.getTime());
  });

  /** Re-runs the schema script, as a gateway boot does. */
  async function rerunMigration(): Promise<void> {
    __resetForTests();
    await pool.end();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
  }

  /** A batch row with no job, as an install that predates fs_jobs holds it. */
  async function seedLegacyBatch(storeId: string, age: string, memberStatuses: string[]): Promise<string> {
    const batchId = newBatchId();
    await pool.query(
      `INSERT INTO vector_store_batches (id, store_id, cancel_requested, created_at)
       VALUES ($1, $2, false, now() - $3::interval)`,
      [batchId, storeId, age],
    );
    for (const status of memberStatuses) {
      // eslint-disable-next-line no-await-in-loop
      const fileId = await seedFile(OWNER, `${status}.txt`);
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO vector_store_files (store_id, file_id, status, batch_id) VALUES ($1, $2, $3, $4)`,
        [storeId, fileId, status, batchId],
      );
    }
    return batchId;
  }

  it('backfills no job for a batch older than 29 days (one day short of the 30-day sweep)', async () => {
    const storeId = await seedStore();
    // Inside the one-day margin: a batch this old could belong to a job the
    // 30-day sweep already deleted (gateway vs database clock), so no job.
    const old = await seedLegacyBatch(storeId, '29 days 1 hour', ['completed']);
    const recent = await seedLegacyBatch(storeId, '28 days', ['completed']);
    await rerunMigration();
    const { rows } = await pool.query('SELECT batch_id FROM fs_jobs');
    expect(rows.map((r: any) => r.batch_id)).toEqual([recent]);
    expect(rows.map((r: any) => r.batch_id)).not.toContain(old);
  });

  it('marks a backfilled finished batch finished, and leaves an in-progress one open', async () => {
    const storeId = await seedStore();
    const finished = await seedLegacyBatch(storeId, '1 day', ['completed', 'failed', 'cancelled']);
    const running = await seedLegacyBatch(storeId, '1 day', ['completed', 'in_progress']);
    const empty = await seedLegacyBatch(storeId, '1 day', []);
    await rerunMigration();
    const { rows } = await pool.query('SELECT batch_id, finished_at FROM fs_jobs');
    const byBatch = new Map(rows.map((r: any) => [r.batch_id, r.finished_at]));
    expect(byBatch.get(finished)).toBeInstanceOf(Date);
    expect(byBatch.get(empty)).toBeInstanceOf(Date);
    expect(byBatch.get(running)).toBeNull();
  });

  it('does not recreate a finished job of an old batch once it was deleted (the history sweep)', async () => {
    const storeId = await seedStore();
    const batchId = await seedLegacyBatch(storeId, '40 days', ['completed']);
    await pool.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, started_by, store_id, batch_id, created_at, finished_at)
       VALUES ('job_00000000000000000000000a', 'file_batch', $1, $1, $2, $3, now() - interval '40 days',
               now() - interval '39 days')`,
      [OWNER, storeId, batchId],
    );
    await pool.query('DELETE FROM fs_jobs WHERE batch_id = $1', [batchId]);
    await rerunMigration();
    const { rows } = await pool.query('SELECT id FROM fs_jobs WHERE batch_id = $1', [batchId]);
    expect(rows).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // derived state and counters
  // -----------------------------------------------------------------------

  async function stateFor(
    statuses: Array<[string, number]>, cancel = false,
  ): Promise<{ state: string; summary: any }> {
    const { storeId, batchId, jobId, fileIds } = await seedBatch(statuses.length);
    for (let i = 0; i < statuses.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await setFile(storeId, fileIds[i], statuses[i][0], statuses[i][1]);
    }
    if (cancel) expect(await requestBatchCancel(storeId, batchId)).toBe(true);
    const summary = await jobSummary(jobId, OWNER);
    expect(summary).not.toBeNull();
    // Counters always sum to total (the batchPollContract invariant).
    expect(summary!.done + summary!.failed + summary!.cancelled + summary!.in_progress).toBe(summary!.total);
    expect(summary!.total).toBe(statuses.length);
    return { state: summary!.state, summary };
  }

  it.each([
    ['queued: every member in_progress, none ever claimed', [['in_progress', 0], ['in_progress', 0]], false, 'queued'],
    ['running: a member in_progress and one was claimed', [['in_progress', 1], ['in_progress', 0]], false, 'running'],
    ['running: a member in_progress after others finished', [['completed', 1], ['in_progress', 0]], false, 'running'],
    ['cancelling: cancel requested while a member is in_progress', [['in_progress', 1], ['cancelled', 0]], true, 'cancelling'],
    ['cancelling: cancel requested before anything was claimed', [['in_progress', 0]], true, 'cancelling'],
    ['cancelled: cancel requested and nothing in_progress', [['completed', 1], ['cancelled', 0]], true, 'cancelled'],
    ['cancelled wins over failed members', [['failed', 3], ['cancelled', 0]], true, 'cancelled'],
    ['completed_with_errors: a failed member, no cancel', [['completed', 1], ['failed', 3]], false, 'completed_with_errors'],
    ['completed: every member completed', [['completed', 1], ['completed', 2]], false, 'completed'],
  ] as Array<[string, Array<[string, number]>, boolean, string]>)('derives %s', async (_name, statuses, cancel, expected) => {
    const { state } = await stateFor(statuses, cancel);
    expect(state).toBe(expected);
  });

  it('reports every counter and the job fields in its summary', async () => {
    const { storeId, batchId, jobId, fileIds } = await seedBatch(4, OWNER, { startedBy: 'starter@example.test' });
    await setFile(storeId, fileIds[0], 'completed');
    await setFile(storeId, fileIds[1], 'failed', 3);
    await setFile(storeId, fileIds[2], 'in_progress', 1);
    await setFile(storeId, fileIds[3], 'cancelled', 0);
    const s = await jobSummary(jobId, OWNER);
    expect(s).toMatchObject({
      id: jobId,
      kind: 'file_batch',
      store_id: storeId,
      store_name: 'Handbook',
      batch_id: batchId,
      state: 'running',
      total: 4,
      done: 1,
      failed: 1,
      cancelled: 1,
      in_progress: 1,
      embedding_tokens: 0,
      error: null,
      started_at: null,
      finished_at: null,
      started_by: 'starter@example.test',
    });
    expect(s!.created_at).toBeInstanceOf(Date);
  });

  it('reports the OCR and vision page counters as numbers, in the owner and admin summaries', async () => {
    const { jobId } = await seedBatch(1);
    expect(await jobSummary(jobId, OWNER)).toMatchObject({
      ocr_pages: 0, ocr_skipped_pages: 0, vision_pages: 0, vision_skipped_pages: 0,
    });
    await addJobOcrTotals(pool, jobId, { ocrPages: 3, skippedPages: 1, visionPages: 2, visionSkippedPages: 4 });
    const counters = { ocr_pages: 3, ocr_skipped_pages: 1, vision_pages: 2, vision_skipped_pages: 4 };
    expect(await jobSummary(jobId, OWNER)).toMatchObject(counters);
    expect(await jobSummaryAnyOwner(jobId)).toMatchObject({ ...counters, owner_email: OWNER });
    expect(await listAllJobs({ owner: OWNER, limit: 10 })).toEqual([expect.objectContaining({ id: jobId, ...counters })]);
  });

  it('counts only its own batch members, not a sibling batch or unbatched files in the store', async () => {
    const { storeId, jobId } = await seedBatch(2);
    const loose = await seedFile(OWNER, 'loose.txt');
    await repo.attachFile(storeId, loose, null);
    const sibling = await seedFile(OWNER, 'sibling.txt');
    await createBatch(storeId, [sibling], null, null);
    const s = await jobSummary(jobId, OWNER);
    expect(s!.total).toBe(2);
  });

  it('returns null for another owner\'s job and for an unknown id', async () => {
    const { jobId } = await seedBatch(1);
    expect(await jobSummary(jobId, OTHER)).toBeNull();
    expect(await jobSummary('job_ffffffffffffffffffffffff', OWNER)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // listing
  // -----------------------------------------------------------------------

  it('lists only the owner\'s jobs, newest first, keyset-paged, and filters by derived state', async () => {
    const j1 = await seedBatch(1);
    const j2 = await seedBatch(1);
    const j3 = await seedBatch(1);
    await seedBatch(1, OTHER);
    // Distinct, ordered created_at values regardless of clock resolution.
    await pool.query(`UPDATE fs_jobs SET created_at = now() - interval '3 minutes' WHERE id = $1`, [j1.jobId]);
    await pool.query(`UPDATE fs_jobs SET created_at = now() - interval '2 minutes' WHERE id = $1`, [j2.jobId]);
    await pool.query(`UPDATE fs_jobs SET created_at = now() - interval '1 minute' WHERE id = $1`, [j3.jobId]);
    await setFile(j2.storeId, j2.fileIds[0], 'completed');

    const all = await listJobs(OWNER, { limit: 10 });
    expect(all.map((j) => j.id)).toEqual([j3.jobId, j2.jobId, j1.jobId]);

    // limit + 1 rows come back so the caller can compute has_more.
    const page1 = await listJobs(OWNER, { limit: 1 });
    expect(page1.map((j) => j.id)).toEqual([j3.jobId, j2.jobId]);
    const page2 = await listJobs(OWNER, { limit: 1, after: j3.jobId });
    expect(page2.map((j) => j.id)).toEqual([j2.jobId, j1.jobId]);
    const page3 = await listJobs(OWNER, { limit: 1, after: j1.jobId });
    expect(page3).toEqual([]);

    const completed = await listJobs(OWNER, { limit: 10, state: 'completed' });
    expect(completed.map((j) => j.id)).toEqual([j2.jobId]);
    const queued = await listJobs(OWNER, { limit: 10, state: 'queued' });
    expect(queued.map((j) => j.id)).toEqual([j3.jobId, j1.jobId]);

    // A cursor naming another owner's job is no cursor at all: an empty page.
    const foreign = await pool.query('SELECT id FROM fs_jobs WHERE owner_email = $1', [OTHER]);
    expect(await listJobs(OWNER, { limit: 10, after: foreign.rows[0].id })).toEqual([]);
  });

  it('keeps sub-millisecond created_at order across a page boundary', async () => {
    const a = await seedBatch(1);
    const b = await seedBatch(1);
    // Two jobs one microsecond apart: a cursor rebound as a JS Date would lose it.
    await pool.query(`UPDATE fs_jobs SET created_at = '2026-10-01 10:00:00.000001+00' WHERE id = $1`, [a.jobId]);
    await pool.query(`UPDATE fs_jobs SET created_at = '2026-10-01 10:00:00.000002+00' WHERE id = $1`, [b.jobId]);
    const page1 = await listJobs(OWNER, { limit: 1 });
    expect(page1[0].id).toBe(b.jobId);
    const page2 = await listJobs(OWNER, { limit: 1, after: b.jobId });
    expect(page2.map((j) => j.id)).toEqual([a.jobId]);
  });

  // -----------------------------------------------------------------------
  // worker hooks
  // -----------------------------------------------------------------------

  it('markStartedIfNeeded sets started_at once; addTokens accumulates', async () => {
    const { batchId, jobId } = await seedBatch(1);
    await markStartedIfNeeded(pool, batchId);
    const first = (await jobRow(jobId)).started_at;
    expect(first).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 5));
    await markStartedIfNeeded(pool, batchId);
    expect((await jobRow(jobId)).started_at.getTime()).toBe(first.getTime());

    await addTokens(pool, batchId, 120);
    await addTokens(pool, batchId, 30);
    await addTokens(pool, batchId, 0);
    expect(Number((await jobRow(jobId)).embedding_tokens)).toBe(150);
    expect((await jobSummary(jobId, OWNER))!.embedding_tokens).toBe(150);
  });

  it('settleFinishedIfTerminal sets finished_at only when no member is in_progress, and only once', async () => {
    const { storeId, batchId, jobId, fileIds } = await seedBatch(2);
    await setFile(storeId, fileIds[0], 'completed');
    expect(await settleFinishedIfTerminal(pool, batchId)).toBe(false);
    expect((await jobRow(jobId)).finished_at).toBeNull();

    await setFile(storeId, fileIds[1], 'failed', 3);
    expect(await settleFinishedIfTerminal(pool, batchId)).toBe(true);
    const finished = (await jobRow(jobId)).finished_at;
    expect(finished).toBeInstanceOf(Date);
    expect(await settleFinishedIfTerminal(pool, batchId)).toBe(false);
    expect((await jobRow(jobId)).finished_at.getTime()).toBe(finished.getTime());
  });

  it('attaching a member reopens a job its earlier members already finished (createBatch attaches one by one)', async () => {
    const { storeId, batchId, jobId, fileIds } = await seedBatch(1);
    await setFile(storeId, fileIds[0], 'completed');
    expect(await settleFinishedIfTerminal(pool, batchId)).toBe(true);

    const second = await seedFile(OWNER, 'late.txt');
    await repo.attachFile(storeId, second, null, null, batchId);
    expect((await jobRow(jobId)).finished_at).toBeNull();
    expect((await jobSummary(jobId, OWNER))!.state).not.toBe('completed');

    await setFile(storeId, second, 'completed');
    expect(await settleFinishedIfTerminal(pool, batchId)).toBe(true);
    expect((await jobRow(jobId)).finished_at).toBeInstanceOf(Date);
  });

  it('settles the job when the last two members finish in concurrent transactions', async () => {
    // Under READ COMMITTED each transaction would see the OTHER member still
    // in_progress and neither would settle; the job-row lock serialises them.
    const { storeId, batchId, jobId, fileIds } = await seedBatch(2);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(`UPDATE vector_store_files SET status = 'completed' WHERE store_id = $1 AND file_id = $2`, [storeId, fileIds[0]]);
      await b.query(`UPDATE vector_store_files SET status = 'completed' WHERE store_id = $1 AND file_id = $2`, [storeId, fileIds[1]]);
      expect(await settleFinishedIfTerminal(a, batchId)).toBe(false);
      const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let bDone = false;
      const bSettled = settleFinishedIfTerminal(b, batchId).finally(() => { bDone = true; });
      // A is committed only once B has either finished (without the lock: it
      // saw A's member in_progress and did not settle) or is waiting on A's
      // job-row lock — so the outcome does not depend on round-trip timing.
      for (let i = 0; i < 200 && !bDone; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const waiting = await pool.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [bPid]);
        if (waiting.rowCount) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 10));
      }
      await a.query('COMMIT');
      expect(await bSettled).toBe(true);
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }
    expect((await jobRow(jobId)).finished_at).toBeInstanceOf(Date);
  });

  // -----------------------------------------------------------------------
  // retry
  // -----------------------------------------------------------------------

  it('retryJob reopens only the failed members, resets attempts, and clears finished_at', async () => {
    const { storeId, batchId, jobId, fileIds } = await seedBatch(3);
    await setFile(storeId, fileIds[0], 'completed', 1);
    await setFile(storeId, fileIds[1], 'failed', 3);
    await setFile(storeId, fileIds[2], 'failed', 2);
    await pool.query('UPDATE vector_store_files SET claimed_at = now() WHERE store_id = $1', [storeId]);
    await settleFinishedIfTerminal(pool, batchId);
    expect((await jobRow(jobId)).finished_at).not.toBeNull();

    const result = await retryJob(jobId, OWNER);
    expect(result).toEqual({ ok: true, job_id: jobId, retried: 2 });

    expect(await fileRow(storeId, fileIds[0])).toMatchObject({ status: 'completed', attempts: 1 });
    for (const f of [fileIds[1], fileIds[2]]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await fileRow(storeId, f)).toEqual({ status: 'in_progress', attempts: 0, last_error: null, claimed_at: null });
    }
    expect((await jobRow(jobId)).finished_at).toBeNull();
    expect((await jobSummary(jobId, OWNER))!.state).toBe('running');
  });

  /** Waits until some backend is blocked by `holderPid`'s locks. */
  async function waitUntilBlockedBy(holderPid: number): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const blocked = await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid]);
      if (blocked.rowCount) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('nothing became blocked by the holder');
  }

  /** Whether another transaction can lock the row right now (NOWAIT). */
  async function rowIsFree(storeId: string, fileId: string): Promise<boolean> {
    const probe = await pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query(
        'SELECT 1 FROM vector_store_files WHERE store_id = $1 AND file_id = $2 FOR UPDATE NOWAIT', [storeId, fileId]);
      return true;
    } catch (e: any) {
      if (e.code === '55P03') return false;
      throw e;
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
  }

  it.each([
    ['retryJob', false],
    ['retryFile', true],
  ])('%s locks the batch members in file_id order (no deadlock with the worker\'s ordered updates)', async (_name, single) => {
    // Members inserted in DESCENDING file_id order, so a scan in insertion
    // order and a scan in file_id order lock them in opposite orders.
    const storeId = await seedStore();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(await seedFile(OWNER, `o${i}.txt`));
    }
    const desc = [...ids].sort().reverse();
    const batch = await createBatch(storeId, desc, null, null);
    const jobId = (await pool.query('SELECT id FROM fs_jobs WHERE batch_id = $1', [batch.id])).rows[0].id;
    for (const id of desc) {
      // eslint-disable-next-line no-await-in-loop
      await setFile(storeId, id, 'failed', 3);
    }
    const lowest = desc[desc.length - 1];
    const highest = desc[0];

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM vector_store_files WHERE store_id = $1 AND file_id = $2 FOR UPDATE', [storeId, lowest]);
      const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const retry = single ? retryFile(storeId, highest, OWNER) : retryJob(jobId, OWNER);
      await waitUntilBlockedBy(holderPid);
      // In file_id order the retry waits on the lowest id before it locks any
      // other member, so the highest is still free.
      expect(await rowIsFree(storeId, highest)).toBe(true);
      await holder.query('COMMIT');
      expect(await retry).toEqual({ ok: true, job_id: jobId, retried: single ? 1 : 4 });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  it('retryJob refuses a running job', async () => {
    const { storeId, jobId, fileIds } = await seedBatch(2);
    await setFile(storeId, fileIds[0], 'failed', 3);
    await setFile(storeId, fileIds[1], 'in_progress', 1);
    expect(await retryJob(jobId, OWNER)).toEqual({ ok: false, error: 'job_running' });
    expect((await fileRow(storeId, fileIds[0])).status).toBe('failed');
  });

  it('retryJob refuses an expired store', async () => {
    const { storeId, jobId, fileIds } = await seedBatch(1);
    await setFile(storeId, fileIds[0], 'failed', 3);
    await pool.query(`UPDATE vector_stores SET status = 'expired' WHERE id = $1`, [storeId]);
    expect(await retryJob(jobId, OWNER)).toEqual({ ok: false, error: 'store_expired' });
    expect((await fileRow(storeId, fileIds[0])).status).toBe('failed');
  });

  it('retryJob has nothing to retry when no member failed', async () => {
    const { storeId, jobId, fileIds } = await seedBatch(1);
    await setFile(storeId, fileIds[0], 'completed', 1);
    expect(await retryJob(jobId, OWNER)).toEqual({ ok: false, error: 'nothing_to_retry' });
  });

  it('retryJob never reopens cancelled files, and refuses a cancelled job outright', async () => {
    const { storeId, batchId, jobId, fileIds } = await seedBatch(2);
    await setFile(storeId, fileIds[0], 'failed', 3);
    await setFile(storeId, fileIds[1], 'cancelled', 0);
    await requestBatchCancel(storeId, batchId);
    // The worker would cancel a reopened member of a cancelled batch at once:
    // a cancel is the user's decision, and retry does not override it.
    expect(await retryJob(jobId, OWNER)).toEqual({ ok: false, error: 'nothing_to_retry' });
    expect((await fileRow(storeId, fileIds[0])).status).toBe('failed');
    expect((await fileRow(storeId, fileIds[1])).status).toBe('cancelled');
  });

  it('retryJob leaves cancelled members of an uncancelled job alone', async () => {
    const { storeId, jobId, fileIds } = await seedBatch(2);
    await setFile(storeId, fileIds[0], 'failed', 3);
    await setFile(storeId, fileIds[1], 'cancelled', 0);
    expect(await retryJob(jobId, OWNER)).toEqual({ ok: true, job_id: jobId, retried: 1 });
    expect((await fileRow(storeId, fileIds[1])).status).toBe('cancelled');
  });

  it('retryJob gives another owner not_found and touches none of the rows', async () => {
    const { storeId, jobId, fileIds } = await seedBatch(1);
    await setFile(storeId, fileIds[0], 'failed', 3);
    expect(await retryJob(jobId, OTHER)).toEqual({ ok: false, error: 'not_found' });
    expect(await retryJob('job_ffffffffffffffffffffffff', OWNER)).toEqual({ ok: false, error: 'not_found' });
    expect((await fileRow(storeId, fileIds[0])).status).toBe('failed');
  });

  it('retryJob does not touch a failed file of the same store outside the batch', async () => {
    const { storeId, jobId, fileIds } = await seedBatch(1);
    const loose = await seedFile(OWNER, 'loose.txt');
    await repo.attachFile(storeId, loose, null);
    await setFile(storeId, fileIds[0], 'failed', 3);
    await setFile(storeId, loose, 'failed', 3);
    expect(await retryJob(jobId, OWNER)).toEqual({ ok: true, job_id: jobId, retried: 1 });
    expect((await fileRow(storeId, loose)).status).toBe('failed');
  });

  it('retryFile reopens one failed file and clears its job\'s finished_at', async () => {
    const { storeId, batchId, jobId, fileIds } = await seedBatch(2);
    await setFile(storeId, fileIds[0], 'failed', 3);
    await setFile(storeId, fileIds[1], 'failed', 3);
    await settleFinishedIfTerminal(pool, batchId);
    expect(await retryFile(storeId, fileIds[0], OWNER)).toEqual({ ok: true, job_id: jobId, retried: 1 });
    expect(await fileRow(storeId, fileIds[0])).toEqual({ status: 'in_progress', attempts: 0, last_error: null, claimed_at: null });
    expect((await fileRow(storeId, fileIds[1])).status).toBe('failed');
    expect((await jobRow(jobId)).finished_at).toBeNull();
  });

  it('retryFile works for a file attached outside any batch', async () => {
    const storeId = await seedStore();
    const f = await seedFile(OWNER, 'single.txt');
    await repo.attachFile(storeId, f, null);
    await setFile(storeId, f, 'failed', 3);
    expect(await retryFile(storeId, f, OWNER)).toEqual({ ok: true, job_id: null, retried: 1 });
    expect((await fileRow(storeId, f)).status).toBe('in_progress');
  });

  it('retryFile applies the same refusals', async () => {
    const { storeId, batchId, fileIds } = await seedBatch(3);
    await setFile(storeId, fileIds[0], 'failed', 3);
    await setFile(storeId, fileIds[1], 'in_progress', 1);
    await setFile(storeId, fileIds[2], 'completed', 1);
    expect(await retryFile(storeId, fileIds[0], OWNER)).toEqual({ ok: false, error: 'job_running' });

    await setFile(storeId, fileIds[1], 'cancelled', 0);
    expect(await retryFile(storeId, fileIds[1], OWNER)).toEqual({ ok: false, error: 'nothing_to_retry' });
    expect(await retryFile(storeId, fileIds[2], OWNER)).toEqual({ ok: false, error: 'nothing_to_retry' });
    expect(await retryFile(storeId, fileIds[0], OTHER)).toEqual({ ok: false, error: 'not_found' });
    expect(await retryFile(storeId, newFileId(), OWNER)).toEqual({ ok: false, error: 'not_found' });

    await requestBatchCancel(storeId, batchId);
    expect(await retryFile(storeId, fileIds[0], OWNER)).toEqual({ ok: false, error: 'nothing_to_retry' });

    const s2 = await seedBatch(1);
    await setFile(s2.storeId, s2.fileIds[0], 'failed', 3);
    await pool.query(`UPDATE vector_stores SET status = 'expired' WHERE id = $1`, [s2.storeId]);
    expect(await retryFile(s2.storeId, s2.fileIds[0], OWNER)).toEqual({ ok: false, error: 'store_expired' });

    expect((await fileRow(storeId, fileIds[0])).status).toBe('failed');
    expect((await fileRow(s2.storeId, s2.fileIds[0])).status).toBe('failed');
  });
});
