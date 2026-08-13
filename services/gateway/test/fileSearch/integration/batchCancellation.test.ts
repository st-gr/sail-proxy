// Cooperative batch cancellation in the ingest worker, against a real Postgres
// database.
//
// Task 1 shipped `requestBatchCancel`, which sets
// `vector_store_batches.cancel_requested` and nothing else. Until the worker
// reads that flag, `cancel` is a lie: the endpoint would report `cancelled`
// while every remaining member file kept ingesting to completion. These tests
// are what make the flag load-bearing.
//
// WHY LIVE POSTGRES: every property here IS the SQL. The claim path
// (`claimNext`'s `FOR UPDATE SKIP LOCKED` over `status='in_progress'`), the
// cancelling UPDATE's `store_id AND batch_id` scoping, and the derived batch
// status all live in statements a mock would simply not execute. A mock that
// ignored the `batch_id` predicate would pass every assertion below.
//
// extractText and embed are mocked (subprocess/network calls, covered live
// elsewhere); the chunker and every database interaction are real, against a
// per-suite isolated schema — Jest runs suites in parallel worker processes
// against one database, so a suite that assumed it owned `public` would race
// the others.
//
// Each test is named so a mutation can be tied to the one test that catches
// it. The two that matter most:
//   - "stops claiming a cancelled batch ..."      catches removing the
//     cancellation check from processOne entirely.
//   - "does not cancel files from a DIFFERENT batch in the same store"
//                                                  catches scoping the
//     cancelling UPDATE by `store_id` alone, dropping `batch_id`.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'batch-cancel-owner@example.com';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

jest.mock('../../../src/fileSearch/extractors/registry', () => {
  const actual = jest.requireActual('../../../src/fileSearch/extractors/registry');
  return { ...actual, extractText: jest.fn() };
});

jest.mock('../../../src/fileSearch/embedder', () => ({
  __esModule: true,
  embed: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractText } = require('../../../src/fileSearch/extractors/registry');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { embed } = require('../../../src/fileSearch/embedder');

// Imported AFTER the jest.mock calls above, so the worker closes over the
// mocked extractor/embedder rather than the real ones.
import { claimNext, processOne } from '../../../src/fileSearch/ingestWorker';
import { createBatch, batchStatusAndCounts, requestBatchCancel } from '../../../src/fileSearch/batches';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

function baseConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'test-model',
    embeddingDimensions: EMBED_DIM,
    limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 4, extractTimeoutMs: 5000, maxRetries: 3 },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

function fakeVector(): number[] {
  return Array.from({ length: EMBED_DIM }, () => Math.random());
}

d('ingest worker batch cancellation against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    // Set BEFORE runMigration -- buildSchemaSql reads embeddingDimensions.
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
    extractText.mockReset();
    embed.mockReset();
    extractText.mockImplementation(async (_filename: string, bytes: Buffer) => bytes.toString('utf8'));
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map(() => fakeVector()),
      usage: { promptTokens: texts.length * 10, totalTokens: texts.length * 10 },
    }));
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_batches');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  // -- helpers ---------------------------------------------------------

  async function seedStore(): Promise<string> {
    const store = await repo.createStore({ ownerEmail: OWNER });
    return store.id;
  }

  async function seedFile(filename: string): Promise<string> {
    // Content long enough to chunk into something real, and unique per file so
    // two files never share a blob (a shared sha256 would let one file's chunks
    // masquerade as another's).
    const content = Buffer.from(`${filename}:${crypto.randomBytes(6).toString('hex')} lorem ipsum dolor sit amet `.repeat(20));
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, OWNER, filename, sha, content.length],
    );
    return id;
  }

  /**
   * Pins the order in which `claimNext` will hand these files out.
   *
   * `claimNext` orders by `created_at`, and `createBatch` attaches its members
   * in separate transactions microseconds apart — close enough that relying on
   * the incidental ordering would make these tests depend on clock resolution.
   * Several tests below need a SPECIFIC file claimed first (see
   * "does not cancel files from a DIFFERENT batch..."), so the ordering is made
   * explicit rather than assumed.
   */
  async function claimOrder(storeId: string, orderedFileIds: string[]): Promise<void> {
    for (let i = 0; i < orderedFileIds.length; i += 1) {
      const result = await pool.query(
        `UPDATE vector_store_files SET created_at = now() - ($3::int * interval '1 second')
          WHERE store_id = $1 AND file_id = $2`,
        [storeId, orderedFileIds[i], orderedFileIds.length - i],
      );
      // Guards the helper itself: a typo'd id would silently order nothing.
      expect(result.rowCount).toBe(1);
    }
  }

  /** One worker cycle, exactly as `runLoop` performs it: claim, then process.
   *  Deterministic and timer-free, unlike driving `startIngestWorker`. */
  async function claimAndProcessOne(): Promise<boolean> {
    const job = await claimNext();
    if (!job) return false;
    await processOne(job.storeId, job.fileId);
    return true;
  }

  /** Runs worker cycles until nothing is claimable. Bounded, so an
   *  implementation that never reaches a terminal state fails loudly here
   *  instead of hanging until Jest's timeout. */
  async function drainWorker(maxCycles = 20): Promise<number> {
    for (let cycles = 0; cycles <= maxCycles; cycles += 1) {
      if (!(await claimAndProcessOne())) return cycles;
    }
    throw new Error(`drainWorker did not settle within ${maxCycles} cycles`);
  }

  async function statusOf(storeId: string, fileId: string): Promise<string> {
    const { rows } = await pool.query(
      'SELECT status FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [storeId, fileId]);
    return rows[0]?.status;
  }

  async function chunkCount(storeId: string, fileId: string): Promise<number> {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM vector_store_chunks WHERE store_id=$1 AND file_id=$2', [storeId, fileId]);
    return rows[0].n;
  }

  async function storeChunkCount(storeId: string): Promise<number> {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM vector_store_chunks WHERE store_id=$1', [storeId]);
    return rows[0].n;
  }

  // -- the three required properties ------------------------------------

  it('stops claiming a cancelled batch and marks the remaining files cancelled', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const fileC = await seedFile('c.txt');
    const batch = await createBatch(storeId, [fileA, fileB, fileC], null, null);
    await claimOrder(storeId, [fileA, fileB, fileC]);

    expect(await claimAndProcessOne()).toBe(true);
    expect(await statusOf(storeId, fileA)).toBe('completed');

    expect(await requestBatchCancel(storeId, batch.id)).toBe(true);

    // The next worker cycle must NOT ingest fileB...
    await claimAndProcessOne();
    expect(await chunkCount(storeId, fileB)).toBe(0);
    // ...and afterwards there is nothing left for any worker to claim: the
    // whole remainder of the batch is terminal, not merely skipped. A skip
    // without the cancelling UPDATE would leave these rows in_progress
    // forever, and the batch would never reach a terminal status.
    expect(await claimNext()).toBeNull();

    const result = await batchStatusAndCounts(storeId, batch.id);
    expect(result!.status).toBe('cancelled');
    expect(result!.file_counts).toEqual({ in_progress: 0, completed: 1, failed: 0, cancelled: 2, total: 3 });
  });

  it('leaves a file that was already completed as completed, not cancelled', async () => {
    // Cancellation stops future work; it does not retroactively undo finished
    // work. The completed file keeps both its status and its chunks.
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const batch = await createBatch(storeId, [fileA, fileB], null, null);
    await claimOrder(storeId, [fileA, fileB]);

    await claimAndProcessOne();
    expect(await statusOf(storeId, fileA)).toBe('completed');
    const chunksBefore = await chunkCount(storeId, fileA);
    expect(chunksBefore).toBeGreaterThan(0);

    await requestBatchCancel(storeId, batch.id);
    await drainWorker();

    expect(await statusOf(storeId, fileA)).toBe('completed');
    expect(await chunkCount(storeId, fileA)).toBe(chunksBefore);
    expect(await statusOf(storeId, fileB)).toBe('cancelled');
  });

  it('does not cancel files from a DIFFERENT batch in the same store', async () => {
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');

    const doomed = await createBatch(storeId, [fileA], null, null);
    const spared = await createBatch(storeId, [fileB], null, null);

    // LOAD-BEARING ORDERING: the doomed batch's file must be claimed FIRST, so
    // that the cancelling UPDATE runs while the sibling batch's file is still
    // `in_progress`. Claimed the other way round, fileB would already be
    // `completed` and the UPDATE's own `status='in_progress'` predicate would
    // shield it — an UPDATE scoped by `store_id` alone would then pass this
    // test for the wrong reason.
    await claimOrder(storeId, [fileA, fileB]);

    expect(await requestBatchCancel(storeId, doomed.id)).toBe(true);
    await drainWorker();

    expect(await statusOf(storeId, fileA)).toBe('cancelled');
    expect((await batchStatusAndCounts(storeId, doomed.id))!.status).toBe('cancelled');

    // The sibling batch was never cancelled, so it ingested normally.
    expect(await statusOf(storeId, fileB)).toBe('completed');
    const siblingCounts = (await batchStatusAndCounts(storeId, spared.id))!;
    expect(siblingCounts.file_counts.cancelled).toBe(0);
    expect(siblingCounts.file_counts).toEqual({ in_progress: 0, completed: 1, failed: 0, cancelled: 0, total: 1 });
    expect(await chunkCount(storeId, fileB)).toBeGreaterThan(0);
  });

  // -- additional properties --------------------------------------------

  it('never extracts, embeds or writes chunks for a file the cancellation stopped', async () => {
    // The status assertions above would also pass for a worker that ingested
    // the file in full and only THEN overwrote its status. This is the direct
    // evidence that the work never happened: nothing was extracted, nothing was
    // embedded, and the store holds no chunks at all.
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const batch = await createBatch(storeId, [fileA, fileB], null, null);

    await requestBatchCancel(storeId, batch.id);
    extractText.mockClear();
    embed.mockClear();

    await drainWorker();

    expect(extractText).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(await storeChunkCount(storeId)).toBe(0);
    expect((await batchStatusAndCounts(storeId, batch.id))!.file_counts)
      .toEqual({ in_progress: 0, completed: 0, failed: 0, cancelled: 2, total: 2 });
  });

  it('leaves a file attached outside any batch untouched when a batch in the same store is cancelled', async () => {
    // `vector_store_files.batch_id` is NULL for the single-file attach path.
    // Such a row belongs to no batch and can never be cancelled by one.
    const storeId = await seedStore();
    const batched = await seedFile('a.txt');
    const loose = await seedFile('b.txt');

    const batch = await createBatch(storeId, [batched], null, null);
    await repo.attachFile(storeId, loose, {});
    // Same load-bearing ordering as the sibling-batch test: the cancelling
    // UPDATE has to run while the loose file is still `in_progress`.
    await claimOrder(storeId, [batched, loose]);

    await requestBatchCancel(storeId, batch.id);
    await drainWorker();

    expect(await statusOf(storeId, batched)).toBe('cancelled');
    expect(await statusOf(storeId, loose)).toBe('completed');
    expect(await chunkCount(storeId, loose)).toBeGreaterThan(0);
  });

  it('ingests a batch normally when cancellation was never requested', async () => {
    // The control case: the cancellation check must not change the ordinary
    // ingest path. A check with an inverted condition fails here and nowhere
    // else in this file.
    const storeId = await seedStore();
    const fileA = await seedFile('a.txt');
    const fileB = await seedFile('b.txt');
    const batch = await createBatch(storeId, [fileA, fileB], null, null);

    await drainWorker();

    expect(await statusOf(storeId, fileA)).toBe('completed');
    expect(await statusOf(storeId, fileB)).toBe('completed');
    const result = await batchStatusAndCounts(storeId, batch.id);
    expect(result!.status).toBe('completed');
    expect(result!.file_counts).toEqual({ in_progress: 0, completed: 2, failed: 0, cancelled: 0, total: 2 });
  });
});
