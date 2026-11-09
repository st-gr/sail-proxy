/**
 * The re-embed engine (grounding phase 4a, Task 3) against a real pgvector:
 * estimates, start and its refusals, the item queue, the switch, failure and
 * retry, cancel, a configuration change mid-job, bulk parents with mixed
 * outcomes, owner/admin scoping of cancel and retry, orphan settling, and the
 * single-row item claim.
 *
 * Only `embed()` (SAP AI Core) and the reranker are stubbed. The fake embedder
 * answers every text with one vector per MODEL (reembedFixture.ts), so a chunk
 * written with the wrong model is visible in the database.
 */
import { Pool } from 'pg';
import { getDefaultLogger } from '@libs/logger';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import {
  EMBED_DIM, vectorOf, seedStore, seedFile, chunksOf, storeRow, jobRow, itemsOf,
} from './reembedFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const OWNER = 'reembed-owner@example.test';
const OTHER = 'reembed-other@example.test';
const ADMIN = 'reembed-admin@example.test';
const ACTOR: { email: string; credentialId: string; authType: string } = { email: OWNER, credentialId: 'key-123', authType: 'api_key' };

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
  default: { getFileSearchConfig: () => mockConfig },
}));

const embedMock: any = jest.fn();
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: (...a: any[]) => embedMock(...a),
}));

jest.mock('../../../src/fileSearch/reranker', () => ({ __esModule: true, rerank: async () => null }));

// eslint-disable-next-line import/first
import type { ReembedActor } from '../../../src/fileSearch/reembed';
// eslint-disable-next-line import/first
import {
  estimateStore, estimateOutdated, startReembed, startBulkReembed, cancelReembed, retryReembed,
} from '../../../src/fileSearch/reembed';
// eslint-disable-next-line import/first
import { claimNextReembedItem, processReembedItem, settleIdleReembedJobs } from '../../../src/fileSearch/reembedWorker';
// eslint-disable-next-line import/first
import { jobSummary, listJobs } from '../../../src/fileSearch/jobs';
// eslint-disable-next-line import/first
import { listAllJobs } from '../../../src/fileSearch/admin';
// eslint-disable-next-line import/first
import { settleOrphanedJobs, sweepFinishedJobs, dropOrphanedGenerations } from '../../../src/fileSearch/jobSweeper';
// eslint-disable-next-line import/first
import { sweepExpiredStores } from '../../../src/fileSearch/expirySweeper';
// eslint-disable-next-line import/first
import { deleteStoreFile } from '../../../src/fileSearch/repository';
// eslint-disable-next-line import/first
import { searchVectorStores } from '../../../src/fileSearch/search';
// eslint-disable-next-line import/first
import { EmbeddingModelUnavailableError } from '../../../src/fileSearch/embedder';

function freshConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'model-b',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: false, candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 2, extractTimeoutMs: 5000, maxRetries: 3 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

/** The default fake: one vector per model, 2 provider tokens per text. A text
 *  containing "poison" fails for the target model while `poison` is set. */
let poison: Error | null = null;
function fakeEmbed(texts: string[], _kind: string, target: { model: string }) {
  if (poison && texts.some((t) => t.includes('poison'))) return Promise.reject(poison);
  return Promise.resolve({
    vectors: texts.map(() => vectorOf(target.model)),
    usage: { promptTokens: texts.length, totalTokens: texts.length * 2 },
  });
}

d('re-embed engine (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = freshConfig();
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
  });

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    mockConfig = freshConfig();
    poison = null;
    embedMock.mockReset();
    embedMock.mockImplementation(fakeEmbed);
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  /** Claims and processes items until none is claimable. */
  async function drain(): Promise<number> {
    for (let n = 0; ; n += 1) {
      if (n > 500) throw new Error('drain did not terminate');
      // eslint-disable-next-line no-await-in-loop
      const item = await claimNextReembedItem();
      if (!item) return n;
      // eslint-disable-next-line no-await-in-loop
      await processReembedItem(item);
    }
  }

  async function start(storeId: string, owner = OWNER, actor: ReembedActor = ACTOR): Promise<string> {
    const started = await startReembed(owner, storeId, actor);
    if (!started.ok) throw new Error(`start refused: ${started.error}`);
    return started.job.id;
  }

  const search = (storeId: string) => searchVectorStores({ storeIds: [storeId], query: 'chunk', ownerEmail: OWNER });

  // -- estimates ----------------------------------------------------------

  describe('estimates', () => {
    it('estimateStore counts the active generation of the owner\'s store, and hides other owners\' stores', async () => {
      const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 3, tokensPerChunk: 4 });
      // A stray generation is not counted.
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding)
         SELECT store_id, file_id, 7, ord, text, tokens, embedding FROM vector_store_chunks WHERE store_id = $1`, [storeId]);

      expect(await estimateStore(OWNER, storeId)).toEqual({ files: 2, chunks: 6, estimated_tokens: 24, state: 'outdated' });
      expect(await estimateStore(OTHER, storeId)).toBeNull();
      await pool.query('UPDATE vector_stores SET is_shared = true WHERE id = $1', [storeId]);
      expect(await estimateStore(OTHER, storeId)).toBeNull();
    });

    it('estimateOutdated totals the included stores of every owner and reports the skipped ones with their reason', async () => {
      const a = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 2, tokensPerChunk: 5 });
      const b = await seedStore(pool, { owner: OTHER, model: 'model-a', files: 1, chunksPerFile: 3, tokensPerChunk: 1 });
      await seedStore(pool, { owner: OWNER, model: 'model-b', files: 1 }); // current: not listed at all
      const dim = await seedStore(pool, { owner: OWNER, model: 'model-a', dim: 4 });
      const expired = await seedStore(pool, { owner: OTHER, model: 'model-a', status: 'expired' });
      const running = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
      await start(running.storeId);

      const estimate = await estimateOutdated();

      expect(estimate).toMatchObject({ stores: 2, files: 3, chunks: 7, estimated_tokens: 23 });
      expect(estimate.skipped).toEqual([
        { store_id: dim.storeId, owner_email: OWNER, reason: 'dimension_mismatch' },
        { store_id: expired.storeId, owner_email: OTHER, reason: 'expired' },
        { store_id: running.storeId, owner_email: OWNER, reason: 'reembed_running' },
      ].sort((x, y) => (x.store_id < y.store_id ? -1 : 1)));
      expect(estimate.skipped.map((x) => x.store_id)).not.toContain(a.storeId);
      expect(estimate.skipped.map((x) => x.store_id)).not.toContain(b.storeId);
    });
  });

  // -- start and refusals -------------------------------------------------

  describe('start', () => {
    it('refuses not_found, store_current, store_dimension_mismatch, store_expired and reembed_running', async () => {
      const outdated = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
      const current = await seedStore(pool, { owner: OWNER, model: 'model-b', files: 1 });
      const dim = await seedStore(pool, { owner: OWNER, model: 'model-a', dim: 4 });
      const expired = await seedStore(pool, { owner: OWNER, model: 'model-a', status: 'expired' });

      expect(await startReembed(OTHER, outdated.storeId, ACTOR)).toEqual({ ok: false, error: 'not_found' });
      expect(await startReembed(OWNER, 'vs_missing', ACTOR)).toEqual({ ok: false, error: 'not_found' });
      expect(await startReembed(OWNER, current.storeId, ACTOR)).toEqual({ ok: false, error: 'store_current' });
      expect(await startReembed(OWNER, dim.storeId, ACTOR)).toEqual({ ok: false, error: 'store_dimension_mismatch' });
      expect(await startReembed(OWNER, expired.storeId, ACTOR)).toEqual({ ok: false, error: 'store_expired' });
      expect((await startReembed(OWNER, outdated.storeId, ACTOR)).ok).toBe(true);
      expect(await startReembed(OWNER, outdated.storeId, ACTOR)).toEqual({ ok: false, error: 'reembed_running' });

      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM fs_jobs WHERE kind = 'reembed_store'`);
      expect(rows[0].n).toBe(1);
    });

    it('two concurrent starts of one store create exactly one job', async () => {
      const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
      const results = await Promise.all([1, 2, 3].map(() => startReembed(OWNER, storeId, ACTOR)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r: any) => r.error)).toEqual(['reembed_running', 'reembed_running']);
    });
  });

  // -- the happy path -----------------------------------------------------

  it('re-embeds every file into the next generation with the target model, then switches the store in one step', async () => {
    const { storeId, fileIds } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 3, chunksPerFile: 3 });
    const before = await chunksOf(pool, storeId);

    const started = await startReembed(OWNER, storeId, { email: ADMIN, credentialId: 'key-9', authType: 'api_key' });
    expect(started.ok).toBe(true);
    const job = (started as any).job;
    expect(job).toMatchObject({
      kind: 'reembed_store', store_id: storeId, state: 'queued', total: 3, done: 0, in_progress: 3, started_by: ADMIN,
    });
    // The job is the store owner's (it shows in their Jobs), stamped with the actor's credential.
    expect(await jobRow(pool, job.id)).toMatchObject({
      owner_email: OWNER, started_by: ADMIN, credential_id: 'key-9', auth_type: 'api_key',
      target_model: 'model-b', target_dim: EMBED_DIM, target_generation: 1,
    });
    expect((await listJobs(OWNER, { limit: 10 })).map((j) => j.id)).toEqual([job.id]);

    expect(await drain()).toBe(3);

    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
    const after = await chunksOf(pool, storeId);
    expect(after.every((c) => c.generation === 1 && c.model === 'model-b')).toBe(true);
    // The same chunks, text and order — only the vectors are new.
    expect(after.map((c) => [c.file_id, c.ord, c.text])).toEqual(before.map((c) => [c.file_id, c.ord, c.text]));
    expect(new Set(after.map((c) => c.file_id))).toEqual(new Set(fileIds));

    const done = await jobSummary(job.id, OWNER);
    expect(done).toMatchObject({ state: 'completed', total: 3, done: 3, failed: 0, in_progress: 0, embedding_tokens: 18 });
    expect(done!.started_at).toBeInstanceOf(Date);
    expect(done!.finished_at).toBeInstanceOf(Date);
    expect(await estimateStore(OWNER, storeId)).toMatchObject({ state: 'current' });

    // Search embeds with the store's new model and finds the new generation.
    const hits = await search(storeId);
    expect(hits.data).toHaveLength(9);
    expect(embedMock.mock.calls.at(-1)[2]).toEqual({ model: 'model-b', dimensions: EMBED_DIM });
  });

  it('the switch waits for a completed file that has no item (or a short target generation) instead of losing it', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 2 });
    const jobId = await start(storeId);
    // A completed file the job does not know about (written behind the engine's back).
    const stray = await seedFile(pool, OWNER);
    await pool.query(`INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, 'completed')`, [storeId, stray]);
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding)
       VALUES ($1, $2, 0, 0, 'stray chunk', 1, $3::vector)`, [storeId, stray, `[${vectorOf('model-a').join(',')}]`]);

    await drain();

    expect((await jobSummary(jobId, OWNER))).toMatchObject({ state: 'completed', total: 3, done: 3 });
    const after = await chunksOf(pool, storeId);
    expect(after.filter((c) => c.file_id === stray)).toEqual([
      { file_id: stray, generation: 1, ord: 0, text: 'stray chunk', model: 'model-b' }]);
    expect(after).toHaveLength(5);
  });

  it('switches an empty store at once', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a' });
    const started = await startReembed(OWNER, storeId, ACTOR);
    expect(started.ok && started.job.state).toBe('completed');
    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
  });

  // -- failure and retry --------------------------------------------------

  it('a failing file fails the job after the retry budget; the store keeps answering with the old model; retry finishes it', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 3, chunksPerFile: 2, poisonFile: 1 });
    poison = new Error('upstream 503');
    const jobId = await start(storeId);

    await drain();

    const failed = await jobSummary(jobId, OWNER);
    expect(failed).toMatchObject({ state: 'failed', done: 2, failed: 1, in_progress: 0 });
    expect((failed!.error as any).code).toBe('reembed_failed');
    const items = await itemsOf(pool, jobId);
    expect(items.find((i) => i.status === 'failed')!.attempts).toBe(3); // ingestion.maxRetries
    const { rows: err } = await pool.query(
      `SELECT last_error FROM fs_reembed_items WHERE job_id = $1 AND status = 'failed'`, [jobId]);
    expect(err[0].last_error).toEqual({ name: 'Error', message: 'upstream 503' });
    // Not switched: still model-a, generation 0 answering; the done files wait in generation 1.
    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-a', active_generation: 0 });
    expect((await search(storeId)).data).toHaveLength(6);
    expect((await chunksOf(pool, storeId)).filter((c) => c.generation === 1)).toHaveLength(4);
    // A finished job stays out of the running index: the store reports no running re-embed.
    expect((await estimateOutdated()).stores).toBe(1);

    expect(await retryReembed(OTHER, jobId)).toEqual({ ok: false, error: 'not_found' });
    poison = null;
    expect(await retryReembed(OWNER, jobId)).toEqual({ ok: true, job_id: jobId, retried: 1 });
    expect((await jobSummary(jobId, OWNER))!.state).toBe('running');
    expect(await retryReembed(OWNER, jobId)).toEqual({ ok: false, error: 'job_running' });

    await drain();

    expect(await jobSummary(jobId, OWNER)).toMatchObject({ state: 'completed', done: 3, failed: 0, error: null });
    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
    expect((await chunksOf(pool, storeId)).every((c) => c.generation === 1 && c.model === 'model-b')).toBe(true);
    expect(await retryReembed(OWNER, jobId)).toEqual({ ok: false, error: 'nothing_to_retry' });
  });

  it('an unserved target model fails the item at once (permanent), logged at warn', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    embedMock.mockImplementation(async () => { throw new EmbeddingModelUnavailableError('model-b'); });
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const error = jest.spyOn(getDefaultLogger(), 'error');
    try {
      const jobId = await start(storeId);
      await drain();
      expect((await itemsOf(pool, jobId))[0]).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await jobSummary(jobId, OWNER))!.state).toBe('failed');
      expect(warn.mock.calls.some((c) => c[0] === 'Reembed' && String(c[1]).includes("'model-b' is not served"))).toBe(true);
      expect(error.mock.calls.filter((c) => c[0] === 'Reembed')).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('a retry of a job superseded by a later re-embed is refused', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, poisonFile: 0 });
    poison = new Error('boom');
    const first = await start(storeId);
    await drain();
    expect((await jobSummary(first, OWNER))!.state).toBe('failed');
    poison = null;
    const second = await start(storeId);
    // The second start discarded the first's leftover generation before writing its own.
    await drain();
    expect((await jobSummary(second, OWNER))!.state).toBe('completed');
    expect(await retryReembed(OWNER, first)).toEqual({ ok: false, error: 'nothing_to_retry' });
  });

  // -- cancel -------------------------------------------------------------

  it('cancel removes the new generation and the open items; the store answers from the old one throughout', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 3, chunksPerFile: 2 });
    const jobId = await start(storeId);
    const first = await claimNextReembedItem();
    await processReembedItem(first!);
    expect((await chunksOf(pool, storeId)).filter((c) => c.generation === 1)).toHaveLength(2);

    expect(await cancelReembed(OTHER, jobId)).toEqual({ ok: false, error: 'not_found' });
    const cancelled = await cancelReembed(OWNER, jobId);

    expect(cancelled.ok && cancelled.job).toMatchObject({ state: 'cancelled', done: 1, cancelled: 2, in_progress: 0 });
    expect((await chunksOf(pool, storeId)).every((c) => c.generation === 0 && c.model === 'model-a')).toBe(true);
    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-a', active_generation: 0 });
    expect(await claimNextReembedItem()).toBeNull();
    expect((await search(storeId)).data).toHaveLength(6);
    // Cancel again: unchanged. Retry: nothing to retry. A new start is allowed.
    expect((await cancelReembed(OWNER, jobId) as any).job.state).toBe('cancelled');
    expect(await retryReembed(OWNER, jobId)).toEqual({ ok: false, error: 'nothing_to_retry' });
    expect((await startReembed(OWNER, storeId, ACTOR)).ok).toBe(true);
  });

  it('an item in flight when the job is cancelled writes nothing', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const jobId = await start(storeId);
    const item = await claimNextReembedItem();
    embedMock.mockImplementationOnce(async (texts: string[], kind: string, target: any) => {
      await cancelReembed(OWNER, jobId);
      return fakeEmbed(texts, kind, target);
    });
    await processReembedItem(item!);
    expect((await chunksOf(pool, storeId)).filter((c) => c.generation === 1)).toEqual([]);
    expect((await jobSummary(jobId, OWNER))!.state).toBe('cancelled');
  });

  it('cancel of a failed job discards the generation it left behind', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, poisonFile: 1 });
    poison = new Error('boom');
    const jobId = await start(storeId);
    await drain();
    expect((await chunksOf(pool, storeId)).some((c) => c.generation === 1)).toBe(true);
    const cancelled = await cancelReembed(OWNER, jobId);
    expect(cancelled.ok && cancelled.job.state).toBe('cancelled');
    expect((await chunksOf(pool, storeId)).every((c) => c.generation === 0)).toBe(true);
  });

  it('cancel of a failed job superseded by a running one only latches: the successor\'s generation (same number) stays', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 3, chunksPerFile: 2, poisonFile: 1 });
    poison = new Error('boom');
    const first = await start(storeId);
    await drain();
    expect((await jobSummary(first, OWNER))!.state).toBe('failed');
    poison = null;
    const second = await start(storeId);
    expect((await jobRow(pool, second)).target_generation).toBe((await jobRow(pool, first)).target_generation);
    await processReembedItem((await claimNextReembedItem())!);
    await processReembedItem((await claimNextReembedItem())!);
    const successorChunks = (await chunksOf(pool, storeId)).filter((c) => c.generation === 1);
    expect(successorChunks).toHaveLength(4);
    const callsBefore = embedMock.mock.calls.length;

    const cancelled = await cancelReembed(OWNER, first);

    expect(cancelled.ok && cancelled.job.state).toBe('cancelled');
    expect((await chunksOf(pool, storeId)).filter((c) => c.generation === 1)).toEqual(successorChunks);
    expect((await jobSummary(second, OWNER))!.state).toBe('running');
    expect(await drain()).toBe(1);
    expect(embedMock.mock.calls.length - callsBefore).toBe(1);
    expect(await jobSummary(second, OWNER)).toMatchObject({ state: 'completed', done: 3 });
    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
    expect((await chunksOf(pool, storeId)).filter((c) => c.generation === 1 && c.model === 'model-b')).toHaveLength(6);
  });

  it('cancel of a failed job superseded by a completed one leaves the store\'s active generation alone', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, poisonFile: 0 });
    poison = new Error('boom');
    const first = await start(storeId);
    await drain();
    poison = null;
    const second = await start(storeId);
    await drain();
    expect((await jobSummary(second, OWNER))!.state).toBe('completed');

    expect((await cancelReembed(OWNER, first) as any).job.state).toBe('cancelled');

    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
    expect((await chunksOf(pool, storeId)).filter((c) => c.generation === 1)).toHaveLength(4);
  });

  // -- configuration change mid-job ----------------------------------------

  it('a configuration change mid-job: the store switches to the pinned target and is outdated again, never mixed', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 3, chunksPerFile: 2 });
    const jobId = await start(storeId);
    await processReembedItem((await claimNextReembedItem())!);
    mockConfig.embeddingModel = 'model-c';

    await drain();

    expect((await jobSummary(jobId, OWNER))!.state).toBe('completed');
    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
    const models = new Set((await chunksOf(pool, storeId)).map((c) => c.model));
    expect(models).toEqual(new Set(['model-b']));
    expect(await estimateStore(OWNER, storeId)).toMatchObject({ state: 'outdated' });
  });

  // -- bulk ----------------------------------------------------------------

  describe('bulk', () => {
    it('one child per included store, skipped stores reported, the parent derived from mixed child outcomes', async () => {
      const ok = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
      const bad = await seedStore(pool, { owner: OTHER, model: 'model-a', files: 2, poisonFile: 0 });
      const cancelMe = await seedStore(pool, { owner: OTHER, model: 'model-a', files: 2 });
      const dim = await seedStore(pool, { owner: OWNER, model: 'model-a', dim: 4 });
      const expired = await seedStore(pool, { owner: OWNER, model: 'model-a', status: 'expired' });
      const running = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
      await seedStore(pool, { owner: OWNER, model: 'model-b', files: 1 });
      const runningJob = await start(running.storeId);
      poison = new Error('boom');

      const bulk = await startBulkReembed({ email: ADMIN, credentialId: 'admin-key', authType: 'api_key' });
      if (!bulk.ok) throw new Error(bulk.error);
      expect(bulk.skipped.map((s) => [s.store_id, s.reason]).sort()).toEqual([
        [dim.storeId, 'dimension_mismatch'], [expired.storeId, 'expired'], [running.storeId, 'reembed_running'],
      ].sort());
      const parentId = bulk.job.id;
      expect(bulk.job).toMatchObject({ kind: 'reembed_bulk', store_id: null, state: 'queued', total: 3, in_progress: 3 });
      expect(await jobRow(pool, parentId)).toMatchObject({ owner_email: ADMIN, started_by: ADMIN, credential_id: 'admin-key' });
      const { rows: children } = await pool.query(
        'SELECT id, store_id, owner_email, started_by FROM fs_jobs WHERE parent_id = $1 ORDER BY store_id', [parentId]);
      expect(children.map((c) => c.store_id).sort()).toEqual([ok.storeId, bad.storeId, cancelMe.storeId].sort());
      for (const c of children) {
        expect(c.started_by).toBe(ADMIN);
        expect(c.owner_email).toBe(c.store_id === ok.storeId ? OWNER : OTHER);
      }
      // Ruling R2: the parent is the admin's, never in an owner's list; each child is in its owner's.
      expect(await jobSummary(parentId, OWNER)).toBeNull();
      expect((await listJobs(OTHER, { limit: 10 })).map((j) => j.kind)).toEqual(['reembed_store', 'reembed_store']);

      const cancelChild = children.find((c) => c.store_id === cancelMe.storeId)!.id;
      expect((await cancelReembed(null, cancelChild) as any).job.state).toBe('cancelled');
      expect((await jobSummary(parentId, ADMIN))!.state).toBe('queued');
      await drain();
      await finishRunningJob(runningJob);

      const parent = await jobSummary(parentId, ADMIN);
      expect(parent).toMatchObject({ state: 'completed_with_errors', total: 3, done: 1, failed: 1, cancelled: 1, in_progress: 0 });
      expect(parent!.finished_at).toBeInstanceOf(Date);
      const { rows: sum } = await pool.query(
        'SELECT SUM(embedding_tokens)::int AS n FROM fs_jobs WHERE parent_id = $1', [parentId]);
      expect(sum[0].n).toBeGreaterThan(0);
      expect(parent!.embedding_tokens).toBe(sum[0].n);
      const all = await listAllJobs({ limit: 20 });
      expect(all.find((j) => j.id === parentId)).toMatchObject({ owner_email: ADMIN, state: 'completed_with_errors' });

      // Retry of the parent retries its failed child only.
      poison = null;
      expect(await retryReembed(OWNER, parentId)).toEqual({ ok: false, error: 'not_found' }); // not the owner's job
      expect(await retryReembed(null, parentId)).toEqual({ ok: true, job_id: parentId, retried: 1 });
      expect((await jobSummary(parentId, ADMIN))!.state).toBe('running');
      expect((await jobRow(pool, parentId)).finished_at).toBeNull();
      await drain();
      expect(await jobSummary(parentId, ADMIN)).toMatchObject({ state: 'completed', done: 2, cancelled: 1 });
      expect((await jobRow(pool, parentId)).finished_at).toBeInstanceOf(Date);
      expect(await storeRow(pool, bad.storeId)).toMatchObject({ embedding_model: 'model-b' });
      expect(await storeRow(pool, cancelMe.storeId)).toMatchObject({ embedding_model: 'model-a' });
    });

    it('cancelling the parent cancels every running child and drops their generations', async () => {
      const s1 = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
      const s2 = await seedStore(pool, { owner: OTHER, model: 'model-a', files: 2 });
      const bulk = await startBulkReembed({ email: ADMIN });
      if (!bulk.ok) throw new Error(bulk.error);
      await processReembedItem((await claimNextReembedItem())!);

      expect(await cancelReembed(OWNER, bulk.job.id)).toEqual({ ok: false, error: 'not_found' });
      const cancelled = await cancelReembed(null, bulk.job.id);

      expect(cancelled.ok && cancelled.job).toMatchObject({ state: 'cancelled', cancelled: 2, in_progress: 0 });
      expect((await jobRow(pool, bulk.job.id)).finished_at).toBeInstanceOf(Date);
      for (const s of [s1, s2]) {
        // eslint-disable-next-line no-await-in-loop
        expect((await chunksOf(pool, s.storeId)).every((c) => c.generation === 0 && c.model === 'model-a')).toBe(true);
      }
      expect(await claimNextReembedItem()).toBeNull();
      expect(await retryReembed(null, bulk.job.id)).toEqual({ ok: false, error: 'nothing_to_retry' });
    });

    it('nothing outdated: no job', async () => {
      await seedStore(pool, { owner: OWNER, model: 'model-b', files: 1 });
      expect(await startBulkReembed({ email: ADMIN })).toEqual({ ok: false, error: 'nothing_to_reembed' });
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs');
      expect(rows[0].n).toBe(0);
    });
  });

  /** Cancels a helper job so its store does not linger in other assertions. */
  async function finishRunningJob(jobId: string): Promise<void> {
    await cancelReembed(null, jobId);
  }

  // -- scoping of cancel and retry (Decision 10) ---------------------------

  it('cancel and retry act on re-embed kinds only: a file batch is not found, an admin reaches any owner\'s re-embed', async () => {
    const { storeId } = await seedStore(pool, { owner: OTHER, model: 'model-a', files: 1 });
    await pool.query(`INSERT INTO vector_store_batches (id, store_id, created_at) VALUES ('vsfb_x', $1, now())`, [storeId]);
    await pool.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, store_id, batch_id) VALUES ('job_batchxxxxxxxxxxxxxxxxxxx', 'file_batch', $1, $2, 'vsfb_x')`,
      [OTHER, storeId]);
    expect(await cancelReembed(null, 'job_batchxxxxxxxxxxxxxxxxxxx')).toEqual({ ok: false, error: 'not_found' });
    expect(await retryReembed(OTHER, 'job_batchxxxxxxxxxxxxxxxxxxx')).toEqual({ ok: false, error: 'not_found' });

    const jobId = await start(storeId, OTHER, { email: ADMIN });
    const cancelled = await cancelReembed(null, jobId);
    expect(cancelled.ok && cancelled.job.state).toBe('cancelled');
  });

  // -- orphan settling and the history sweep -------------------------------

  describe('orphan settling', () => {
    it('a job whose last open item was detached switches on the next settle', async () => {
      const { storeId, fileIds } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
      const jobId = await start(storeId);
      await processReembedItem((await claimNextReembedItem())!);
      const open = (await itemsOf(pool, jobId)).find((i) => i.status === 'in_progress')!;
      expect(await deleteStoreFile(storeId, open.file_id, OWNER)).toEqual({ deleted: true });
      expect((await itemsOf(pool, jobId)).map((i) => i.file_id)).toEqual([fileIds.find((f) => f !== open.file_id)]);

      expect(await settleOrphanedJobs()).toBe(1);

      expect((await jobSummary(jobId, OWNER))!.state).toBe('completed');
      expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
      expect((await chunksOf(pool, storeId)).map((c) => c.generation)).toEqual([1, 1]);
    });

    it('a store that expires mid-job: open items stop, the job fails with store_expired', async () => {
      const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
      const jobId = await start(storeId);
      await processReembedItem((await claimNextReembedItem())!);
      await pool.query(`UPDATE vector_stores SET expires_at = now() - interval '1 minute' WHERE id = $1`, [storeId]);
      expect(await sweepExpiredStores()).toBe(1);
      expect(await claimNextReembedItem()).toBeNull();

      expect(await settleIdleReembedJobs()).toBe(1);

      const job = await jobSummary(jobId, OWNER);
      expect(job).toMatchObject({ state: 'failed', cancelled: 1 });
      expect((job!.error as any).code).toBe('store_expired');
      expect(await chunksOf(pool, storeId)).toEqual([]);
    });

    it('a bulk parent whose children all finished is finished by the settler', async () => {
      await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
      const bulk = await startBulkReembed({ email: ADMIN });
      if (!bulk.ok) throw new Error(bulk.error);
      await drain();
      await pool.query('UPDATE fs_jobs SET finished_at = NULL WHERE id = $1', [bulk.job.id]); // a crash before the settle
      expect(await settleOrphanedJobs()).toBe(1);
      expect((await jobRow(pool, bulk.job.id)).finished_at).toBeInstanceOf(Date);
    });

    it('an item whose worker died with its budget spent is reaped failed, and its job fails', async () => {
      const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
      const jobId = await start(storeId);
      await pool.query(
        `UPDATE fs_reembed_items SET attempts = 3, claimed_at = now() - interval '16 minutes' WHERE job_id = $1`, [jobId]);
      expect(await claimNextReembedItem()).toBeNull();
      expect((await itemsOf(pool, jobId))[0].status).toBe('failed');
      expect((await jobSummary(jobId, OWNER))!.state).toBe('failed');
    });

    it('the 30-day history sweep deletes finished re-embed jobs with their items', async () => {
      const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
      const jobId = await start(storeId);
      await drain();
      await pool.query(`UPDATE fs_jobs SET finished_at = now() - interval '31 days' WHERE id = $1`, [jobId]);
      expect(await sweepFinishedJobs()).toBe(1);
      expect(await jobRow(pool, jobId)).toBeUndefined();
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM fs_reembed_items');
      expect(rows[0].n).toBe(0);
    });

    it('the history sweep drops the generation a swept failed job left behind, in batches; kept generations stay', async () => {
      // A failed job past the retention window: its generation 1 becomes an orphan once the job row goes.
      const swept = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 3, chunksPerFile: 2, poisonFile: 0 });
      // A failed job inside the window (retry continues from its generation), and a running job.
      const recent = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 2, poisonFile: 0 });
      const running = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 2 });
      poison = new Error('boom');
      const sweptJob = await start(swept.storeId);
      const recentJob = await start(recent.storeId);
      await drain();
      poison = null;
      const runningJob = await start(running.storeId);
      await processReembedItem((await claimNextReembedItem())!);
      expect((await jobSummary(sweptJob, OWNER))!.state).toBe('failed');
      expect((await jobSummary(recentJob, OWNER))!.state).toBe('failed');
      await pool.query(`UPDATE fs_jobs SET finished_at = now() - interval '31 days' WHERE id = $1`, [sweptJob]);
      const gen = async (storeId: string, g: number) => (await chunksOf(pool, storeId)).filter((c) => c.generation === g);
      expect(await gen(swept.storeId, 1)).toHaveLength(4);
      const keptRecent = await gen(recent.storeId, 1);
      const keptRunning = await gen(running.storeId, 1);
      expect(keptRecent).toHaveLength(2);
      expect(keptRunning).toHaveLength(2);

      expect(await sweepFinishedJobs()).toBe(1);

      expect(await jobRow(pool, sweptJob)).toBeUndefined();
      expect(await gen(swept.storeId, 1)).toEqual([]);
      expect(await gen(swept.storeId, 0)).toHaveLength(6);
      expect(await gen(recent.storeId, 1)).toEqual(keptRecent);
      expect(await gen(running.storeId, 1)).toEqual(keptRunning);
      expect(await gen(running.storeId, 0)).toHaveLength(4);
    });

    it('dropOrphanedGenerations deletes in batches of the given size and only non-active, untargeted generations', async () => {
      const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 3 });
      // Stray generations 4 and 5 that no job targets (e.g. a job swept before this sweep existed).
      for (const g of [4, 5]) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding)
           SELECT store_id, file_id, $2, ord, text, tokens, embedding FROM vector_store_chunks
            WHERE store_id = $1 AND generation = 0`, [storeId, g]);
      }
      // A cancelled job targeting generation 5 does not protect it.
      await pool.query(
        `INSERT INTO fs_jobs (id, kind, owner_email, store_id, target_model, target_dim, target_generation,
                              cancel_requested, finished_at)
         VALUES ('job_cancelledxxxxxxxxxxxxxxx', 'reembed_store', $1, $2, 'model-b', $3, 5, true, now())`,
        [OWNER, storeId, EMBED_DIM]);
      // 6 chunks per generation in batches of 4: only a loop over batches deletes them all.
      expect(await dropOrphanedGenerations(4)).toBe(12);
      expect((await chunksOf(pool, storeId)).map((c) => c.generation)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(await dropOrphanedGenerations(4)).toBe(0);
    });

    it('dropOrphanedGenerations re-checks with a fresh snapshot after the store lock: a job targeting the generation that commits meanwhile protects it', async () => {
      const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 3 });
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding)
         SELECT store_id, file_id, 1, ord, text, tokens, embedding FROM vector_store_chunks
          WHERE store_id = $1 AND generation = 0`, [storeId]);
      // A start in flight: it holds the store row and targets generation 1, not yet committed.
      const starter = await pool.connect();
      try {
        await starter.query('BEGIN');
        await starter.query('SELECT 1 FROM vector_stores WHERE id = $1 FOR UPDATE', [storeId]);
        await starter.query(
          `INSERT INTO fs_jobs (id, kind, owner_email, store_id, target_model, target_dim, target_generation)
           VALUES ('job_inflightxxxxxxxxxxxxxxxx', 'reembed_store', $1, $2, 'model-b', $3, 1)`,
          [OWNER, storeId, EMBED_DIM]);
        const sweep = dropOrphanedGenerations(4);
        // The sweep found generation 1 untargeted and now waits on the store lock.
        for (let i = 0; i < 200; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`);
          if ((waiting.rowCount ?? 0) > 0) break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await starter.query('COMMIT');
        expect(await sweep).toBe(0);
      } finally {
        starter.release();
      }
      expect((await chunksOf(pool, storeId)).filter((c) => c.generation === 1)).toHaveLength(6);
    });
  });

  // -- the switch re-queues files that failed for the old model (m1) --------

  it('files that failed because the old model was not served ingest again with the new model after the switch', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const fileId = await seedFile(pool, OWNER);
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status, attempts, last_error)
       VALUES ($1, $2, 'failed', 1, $3::jsonb)`,
      [storeId, fileId, JSON.stringify({ name: 'EmbeddingModelUnavailableError', message: 'not served' })]);
    const other = await seedFile(pool, OWNER);
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status, attempts, last_error)
       VALUES ($1, $2, 'failed', 3, $3::jsonb)`,
      [storeId, other, JSON.stringify({ name: 'Error', message: 'something else' })]);
    await start(storeId);
    await drain();

    const { rows } = await pool.query(
      'SELECT file_id, status, attempts, last_error FROM vector_store_files WHERE store_id = $1 ORDER BY file_id', [storeId]);
    expect(rows.find((r) => r.file_id === fileId)).toMatchObject({ status: 'in_progress', attempts: 0, last_error: null });
    expect(rows.find((r) => r.file_id === other)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  // -- the item claim (CTE, db0d2b27) --------------------------------------

  it('one item claim takes exactly one item, even with statistics that say the table holds one row', async () => {
    const s1 = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const first = await start(s1.storeId);
    await pool.query('ANALYZE fs_reembed_items');
    await pool.query('ANALYZE fs_jobs');
    const s2 = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const second = await start(s2.storeId);

    const item = await claimNextReembedItem();

    expect(item!.jobId).toBe(first);
    expect(await itemsOf(pool, second)).toEqual([{ file_id: s2.fileIds[0], status: 'in_progress', attempts: 0 }]);
    const { rows } = await pool.query('SELECT claimed_at FROM fs_reembed_items WHERE job_id = $1', [second]);
    expect(rows[0].claimed_at).toBeNull();
  });

  it('concurrent claims never share an item', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 6 });
    await start(storeId);
    const claims = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => claimNextReembedItem()));
    const got = claims.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => c.fileId);
    expect(got).toHaveLength(6);
    expect(new Set(got).size).toBe(6);
  });
});
