/**
 * A re-embed racing everything else, against a real pgvector (grounding phase
 * 4a, Task 3; plan Review focus 1, 2, 4):
 *  - a file attached while its store re-embeds lands in both generations and is
 *    part of the switch; one detached or deleted leaves nothing behind;
 *  - an ingestion that read the store before a start or a switch writes the
 *    generations the store has when it commits, never the ones it read (Task 1 carry);
 *  - a search that embedded its query before a switch never compares it with the
 *    other model's vectors (Task 2 carry), and searches looping while the worker
 *    re-embeds always see exactly one generation and one model.
 *
 * `embed()`, the extractor and the reranker are stubbed; the fake embedder answers
 * one vector per model (reembedFixture.ts), orthogonal across models, so a
 * cross-model comparison shows as a cosine distance of 1.
 */
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import { EMBED_DIM, vectorOf, seedStore, chunksOf, storeRow, itemsOf } from './reembedFixture';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const OWNER = 'reembed-race@example.test';
const ACTOR = { email: OWNER };

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

jest.mock('../../../src/fileSearch/extractors/registry', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/extractors/registry'),
  extractText: async (_filename: string, bytes: Buffer) => bytes.toString('utf8'),
}));

// eslint-disable-next-line import/first
import * as repo from '../../../src/fileSearch/repository';
// eslint-disable-next-line import/first
import { startReembed } from '../../../src/fileSearch/reembed';
// eslint-disable-next-line import/first
import { claimNextReembedItem, processReembedItem } from '../../../src/fileSearch/reembedWorker';
// eslint-disable-next-line import/first
import { jobSummary } from '../../../src/fileSearch/jobs';
// eslint-disable-next-line import/first
import { processOne, startIngestWorker, stopIngestWorker } from '../../../src/fileSearch/ingestWorker';
// eslint-disable-next-line import/first
import { searchVectorStores } from '../../../src/fileSearch/search';

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

function fakeEmbed(texts: string[], _kind: string, target: { model: string }) {
  return Promise.resolve({
    vectors: texts.map(() => vectorOf(target.model)),
    usage: { promptTokens: texts.length, totalTokens: texts.length },
  });
}

d('re-embed concurrency (requires FILE_SEARCH_TEST_DSN)', () => {
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
    embedMock.mockReset();
    embedMock.mockImplementation(fakeEmbed);
    await pool.query('DELETE FROM fs_jobs');
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  afterEach(async () => {
    await stopIngestWorker();
    jest.restoreAllMocks();
  });

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

  async function start(storeId: string): Promise<string> {
    const started = await startReembed(OWNER, storeId, ACTOR);
    if (!started.ok) throw new Error(`start refused: ${started.error}`);
    return started.job.id;
  }

  /** An uploaded file (real blob) attached to the store, in_progress — not ingested yet. */
  async function attachNewFile(storeId: string, text: string): Promise<string> {
    const content = Buffer.from(text);
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes) VALUES ($1, $2, 'new.txt', 'assistants', $3, $4)`,
      [fileId, OWNER, sha, content.length]);
    await repo.attachFile(storeId, fileId, null);
    return fileId;
  }

  async function fileStatus(storeId: string, fileId: string): Promise<string | undefined> {
    const { rows } = await pool.query('SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);
    return rows[0]?.status;
  }

  // -- attach, detach, delete during a re-embed -----------------------------

  it('a file attached during a re-embed is written into both generations and is part of the switch', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
    const jobId = await start(storeId);
    const fileId = await attachNewFile(storeId, 'harbour tide tables and pilot schedules');

    await processOne(storeId, fileId);

    expect(await fileStatus(storeId, fileId)).toBe('completed');
    const mine = (await chunksOf(pool, storeId)).filter((c) => c.file_id === fileId);
    const gen0 = mine.filter((c) => c.generation === 0);
    const gen1 = mine.filter((c) => c.generation === 1);
    expect(gen0.length).toBeGreaterThan(0);
    expect(gen0.every((c) => c.model === 'model-a')).toBe(true);
    expect(gen1.map((c) => [c.ord, c.text])).toEqual(gen0.map((c) => [c.ord, c.text]));
    expect(gen1.every((c) => c.model === 'model-b')).toBe(true);
    expect((await itemsOf(pool, jobId)).find((i) => i.file_id === fileId)).toMatchObject({ status: 'completed' });
    expect((await jobSummary(jobId, OWNER))!.total).toBe(3);

    await drain();

    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
    const after = await chunksOf(pool, storeId);
    expect(after.every((c) => c.generation === 1 && c.model === 'model-b')).toBe(true);
    expect(after.filter((c) => c.file_id === fileId)).toHaveLength(gen0.length);
  });

  it('a file detached or deleted during a re-embed leaves no item and no chunk in either generation', async () => {
    const { storeId, fileIds } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 4 });
    const jobId = await start(storeId);
    // File 0 re-embedded already (generation 1 written), files 1-3 still open.
    const first = await claimNextReembedItem();
    await processReembedItem(first!);
    const done = first!.fileId;
    const open = fileIds.filter((f) => f !== done);

    expect(await repo.deleteStoreFile(storeId, done, OWNER)).toEqual({ deleted: true });
    expect(await repo.deleteStoreFile(storeId, open[0], OWNER)).toEqual({ deleted: true });
    expect((await repo.deleteFileDetachingEverywhere(open[1], OWNER)).deleted).toBe(true);

    expect((await itemsOf(pool, jobId)).map((i) => i.file_id)).toEqual([open[2]]);
    const gone = new Set([done, open[0], open[1]]);
    expect((await chunksOf(pool, storeId)).filter((c) => gone.has(c.file_id))).toEqual([]);

    await drain();

    expect((await jobSummary(jobId, OWNER))!.state).toBe('completed');
    expect((await chunksOf(pool, storeId)).map((c) => [c.file_id, c.generation, c.model]))
      .toEqual([[open[2], 1, 'model-b'], [open[2], 1, 'model-b']]);
  });

  it('a file detached while its item is being embedded leaves no orphaned chunk', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
    const jobId = await start(storeId);
    const item = await claimNextReembedItem();
    embedMock.mockImplementationOnce(async (texts: string[], kind: string, target: any) => {
      await repo.deleteStoreFile(storeId, item!.fileId, OWNER);
      return fakeEmbed(texts, kind, target);
    });
    await processReembedItem(item!);

    expect((await chunksOf(pool, storeId)).filter((c) => c.file_id === item!.fileId)).toEqual([]);
    expect((await itemsOf(pool, jobId)).map((i) => i.file_id)).not.toContain(item!.fileId);
    await drain();
    expect((await jobSummary(jobId, OWNER))!.state).toBe('completed');
  });

  // -- the generation is decided under the store lock (Task 1 carry) ---------

  it('an ingestion that embedded before a re-embed started still writes the new generation too', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const fileId = await attachNewFile(storeId, 'quartermaster ledger');
    let jobId = '';
    embedMock.mockImplementationOnce(async (texts: string[], kind: string, target: any) => {
      // The re-embed starts while this ingestion embeds with the store's model only.
      jobId = await start(storeId);
      return fakeEmbed(texts, kind, target);
    });

    await processOne(storeId, fileId);

    const mine = (await chunksOf(pool, storeId)).filter((c) => c.file_id === fileId);
    expect(new Set(mine.map((c) => `${c.generation}:${c.model}`))).toEqual(new Set(['0:model-a', '1:model-b']));
    expect((await itemsOf(pool, jobId)).find((i) => i.file_id === fileId)).toMatchObject({ status: 'completed' });
  });

  it('an ingestion that embedded before a switch writes the switched generation with the new model, never the old one', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2 });
    const fileId = await attachNewFile(storeId, 'harbour pilot schedule');
    embedMock.mockImplementationOnce(async (texts: string[], kind: string, target: any) => {
      // While this ingestion embeds with model-a, the store re-embeds and switches to model-b.
      await start(storeId);
      await drain();
      return fakeEmbed(texts, kind, target);
    });

    await processOne(storeId, fileId);

    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b', active_generation: 1 });
    expect(await fileStatus(storeId, fileId)).toBe('completed');
    const all = await chunksOf(pool, storeId);
    expect(all.every((c) => c.generation === 1 && c.model === 'model-b')).toBe(true);
    expect(all.filter((c) => c.file_id === fileId).length).toBeGreaterThan(0);
  });

  // -- one ingestion stays inside its lease (Task 3 review minor 1) ----------

  it('an ingestion past its time budget stops embedding and fails transiently; every embed call carries the deadline', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    await start(storeId); // two models to embed with: the store's and the re-embed's target
    const fileId = await attachNewFile(storeId, 'slow harbour ledger');
    embedMock.mockImplementation(async (texts: string[], kind: string, target: any) => {
      await new Promise((r) => setTimeout(r, 80));
      return fakeEmbed(texts, kind, target);
    });
    const before = Date.now();

    await processOne(storeId, fileId, { budgetMs: 50 });

    expect(embedMock).toHaveBeenCalledTimes(1);
    const options = embedMock.mock.calls[0][3];
    expect(options.deadline).toBeGreaterThanOrEqual(before + 50);
    expect(options.deadline).toBeLessThanOrEqual(Date.now());
    const { rows } = await pool.query(
      'SELECT status, attempts, last_error FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);
    expect(rows[0].status).toBe('in_progress'); // transient: the next claim tries again
    expect(rows[0].last_error.name).toBe('IngestionDeadlineExceededError');
    expect((await chunksOf(pool, storeId)).filter((c) => c.file_id === fileId)).toEqual([]);
  });

  it('the default budget of one ingestion stays below the 15-minute lease', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 1 });
    const fileId = await attachNewFile(storeId, 'quick ledger');
    const before = Date.now();

    await processOne(storeId, fileId);

    expect(await fileStatus(storeId, fileId)).toBe('completed');
    const { deadline } = embedMock.mock.calls[0][3];
    expect(deadline - before).toBeLessThan(15 * 60 * 1000);
    expect(deadline - before).toBeGreaterThanOrEqual(12 * 60 * 1000);
  });

  // -- search across the switch (Task 2 carry, Review focus 1) ---------------

  it('a search that embedded its query before the switch finds no vector hits for that store, never the other model\'s', async () => {
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files: 2, chunksPerFile: 3 });
    await start(storeId);
    const recall = jest.spyOn(repo, 'recallCandidates');
    embedMock.mockImplementation(async (texts: string[], kind: string, target: any) => {
      if (kind === 'query' && target.model === 'model-a') {
        // The query is embedded with the store's old model; the switch commits before recall runs.
        await drain();
      }
      return fakeEmbed(texts, kind, target);
    });

    const stale = await searchVectorStores({ storeIds: [storeId], query: 'chunk', ownerEmail: OWNER });

    expect(await storeRow(pool, storeId)).toMatchObject({ embedding_model: 'model-b' });
    expect(stale.data).toEqual([]);
    expect(await recall.mock.results[0].value).toEqual([]);

    const fresh = await searchVectorStores({ storeIds: [storeId], query: 'chunk', ownerEmail: OWNER });
    expect(fresh.data).toHaveLength(6);
    const candidates = await recall.mock.results[1].value;
    expect(candidates.every((c: any) => c.vectorScore < 1e-6)).toBe(true);
  });

  it('searches looping while the worker re-embeds see exactly one generation and one model per store, every time', async () => {
    const files = 8;
    const chunksPerFile = 3;
    const total = files * chunksPerFile;
    const { storeId } = await seedStore(pool, { owner: OWNER, model: 'model-a', files, chunksPerFile });
    embedMock.mockImplementation(async (texts: string[], kind: string, target: any) => {
      if (kind === 'document') await new Promise((r) => setTimeout(r, 15));
      return fakeEmbed(texts, kind, target);
    });
    const recall = jest.spyOn(repo, 'recallCandidates');
    const jobId = await start(storeId);
    startIngestWorker();

    const k = mockConfig.hybrid.rrfK;
    const expectedScores = Array.from({ length: total }, (_, i) => 1 / (k + i + 1));
    let searches = 0;
    let empty = 0;
    const seenModels = new Set<string>();
    const deadline = Date.now() + 20_000;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const result = await searchVectorStores({ storeIds: [storeId], query: 'chunk', ownerEmail: OWNER, maxNumResults: 50 });
      // eslint-disable-next-line no-await-in-loop
      const candidates = await recall.mock.results[searches].value;
      searches += 1;
      seenModels.add(embedMock.mock.calls.filter((c: any[]) => c[1] === 'query').at(-1)[2].model);
      if (result.data.length === 0) {
        empty += 1;
      } else {
        // One generation: every chunk exactly once (a chunk seen in two generations
        // would sum two RRF contributions), and every vector compared with a query
        // of its own model (cosine distance 0, never 1).
        expect(result.data.map((h) => h.score)).toEqual(expectedScores);
        expect(candidates.every((c: any) => c.vectorScore < 1e-6)).toBe(true);
      }
      // eslint-disable-next-line no-await-in-loop
      const job = await jobSummary(jobId, OWNER);
      if (job!.state === 'completed') break;
      if (Date.now() > deadline) throw new Error(`re-embed did not finish: ${JSON.stringify(job)}`);
    }

    expect(searches).toBeGreaterThan(3);
    // At most the one search that raced the switch came back empty.
    expect(empty).toBeLessThanOrEqual(1);
    expect(seenModels.has('model-a')).toBe(true);
    const last = await searchVectorStores({ storeIds: [storeId], query: 'chunk', ownerEmail: OWNER, maxNumResults: 50 });
    expect(last.data.map((h) => h.score)).toEqual(expectedScores);
    expect(embedMock.mock.calls.at(-1)[2].model).toBe('model-b');
    expect((await chunksOf(pool, storeId)).every((c) => c.generation === 1 && c.model === 'model-b')).toBe(true);
  }, 30_000);
});
