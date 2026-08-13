// THE ACCEPTANCE TEST FOR THE FILE-BATCH FEATURE: the contract OpenAI's SDK
// helpers `fileBatches.createAndPoll(...)` and `fileBatches.uploadAndPoll(...)`
// depend on.
//
// Those helpers are not server-side operations. They are CLIENT-SIDE LOOPS over
// `retrieve`, which stop the moment the reported status is anything other than
// `in_progress` and then hand the caller back a vector store they have promised
// is ready to search. So:
//
//   A BATCH MUST NEVER REPORT A TERMINAL STATUS WHILE A MEMBER FILE IS STILL
//   `in_progress`.
//
// If it ever does, `createAndPoll` returns a store that is still being written
// — SILENTLY. Nothing throws, no status is `failed`, no log line fires. The
// caller searches a corpus that is missing the documents they just uploaded and
// concludes the retrieval stack is bad. That failure mode is worth more to
// prevent than any of the four endpoints is worth to have.
//
// TWO INVARIANTS, ASSERTED AT EVERY POLL AND NOT ONLY AT THE END:
//   1. status !== 'in_progress'  =>  file_counts.in_progress === 0
//   2. in_progress + completed + failed + cancelled === total, always
//
// WHY EVERY POLL. A test that drives a batch to completion and then asserts
// once proves only that the FINAL state is coherent. The bug this file exists
// to catch is transient by construction: it appears while the worker is
// part-way through the members and is gone by the time the batch settles. The
// loops below therefore record an observation per poll and assert on all of
// them.
//
// WHY MANY FILES. With one member there is exactly one interesting poll, and
// `deriveBatchStatus` returning the right answer once is indistinguishable from
// luck — an implementation that reported `completed` as soon as ANY member
// finished would pass a one-file fixture. `MEMBER_COUNT` files give the loop
// that many mid-flight observations, each one a chance to catch it.
//
// WHY LIVE POSTGRES AND THE REAL WORKER. The invariant spans two components
// that a mock would replace with the assumption under test: the aggregate query
// in `batchStatusAndCounts` (the derivation) and the per-file status
// transitions in `ingestWorker.processOne` (what it derives from). Only
// `extractText`/`embed` are mocked, being a subprocess and a network call
// covered live elsewhere; the chunker, the claim lease and every statement are
// real.
//
// Each test is named so a mutation can be tied to the one test that catches it.
// The two that matter most:
//   - "never reports a terminal status while a member file is still
//      in_progress" catches reordering `deriveBatchStatus`'s first two rules,
//      and any rewrite that reports terminal on "some member finished".
//   - "keeps both invariants for two batches draining at the same time"
//      catches dropping `f.batch_id = b.id` from the counts join while the
//      store is mid-flight, which the settled-state suites cannot see.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'batch-poll-owner@example.com';

/** Enough members that the batch is seen mid-flight several times over. */
const MEMBER_COUNT = 6;

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
import { createBatch, batchStatusAndCounts, requestBatchCancel, BatchStatus } from '../../../src/fileSearch/batches';
import { FileCounts } from '../../../src/fileSearch/repository';
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

/** One `retrieve` response as an SDK poll loop sees it. */
interface Observation {
  status: BatchStatus;
  file_counts: FileCounts;
}

d('the file-batch poll contract against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
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

  // -- fixtures ----------------------------------------------------------

  async function seedStore(): Promise<string> {
    const store = await repo.createStore({ ownerEmail: OWNER });
    return store.id;
  }

  async function seedFile(filename: string): Promise<string> {
    // Long enough to chunk into something real, and unique per file so two
    // files never share a blob -- a shared sha256 would let one file's chunks
    // masquerade as another's.
    const content = Buffer.from(
      `${filename}:${crypto.randomBytes(6).toString('hex')} lorem ipsum dolor sit amet `.repeat(20),
    );
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

  async function seedFiles(n: number, prefix = 'f'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push(await seedFile(`${prefix}${i}.txt`));
    return ids;
  }

  /**
   * Pins the order in which `claimNext` hands these files out.
   *
   * `claimNext` orders by `created_at`, and `createBatch` attaches its members
   * in separate transactions microseconds apart -- close enough that the
   * incidental ordering would make these tests depend on clock resolution.
   * The interleaving test below needs a SPECIFIC order across two batches, so
   * it is made explicit rather than assumed.
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
  async function processOneFile(): Promise<boolean> {
    const job = await claimNext();
    if (!job) return false;
    await processOne(job.storeId, job.fileId);
    return true;
  }

  /** One `retrieve`, as an SDK poll loop performs it. Fails loudly rather than
   *  returning null: a poll loop that 404s mid-flight is its own defect, and a
   *  silent `null` here would make every downstream assertion vacuous. */
  async function retrieveBatch(storeId: string, batchId: string): Promise<Observation> {
    const result = await batchStatusAndCounts(storeId, batchId);
    expect(result).not.toBeNull();
    return result!;
  }

  // -- the invariants, applied to a single observation --------------------

  /** INVARIANT 1: terminal implies nothing in flight. */
  function expectTerminalImpliesQuiescent(o: Observation, when: string): void {
    if (o.status !== 'in_progress') {
      // The whole point of the file. A terminal status here is what stops an
      // SDK poll loop, so it must mean every member has stopped moving.
      expect({ when, status: o.status, in_progress: o.file_counts.in_progress })
        .toEqual({ when, status: o.status, in_progress: 0 });
    }
  }

  /** INVARIANT 2: the four buckets always account for exactly `total`. */
  function expectCountsSumToTotal(o: Observation, when: string): void {
    const c = o.file_counts;
    expect({ when, sum: c.in_progress + c.completed + c.failed + c.cancelled })
      .toEqual({ when, sum: c.total });
  }

  /**
   * Polls `retrieve` exactly as `createAndPoll` does -- read, stop if terminal,
   * otherwise let the worker advance -- asserting BOTH invariants on every
   * single response before deciding whether to loop again.
   *
   * `advance` is the caller's substitute for wall-clock time between polls.
   * Bounded by `maxPolls` so an implementation that never settles fails here
   * with a message instead of hanging until Jest's timeout.
   */
  async function pollLikeCreateAndPoll(
    storeId: string,
    batchId: string,
    advance: () => Promise<void>,
    maxPolls = MEMBER_COUNT * 3 + 5,
  ): Promise<Observation[]> {
    const observed: Observation[] = [];
    for (let i = 0; i < maxPolls; i += 1) {
      const o = await retrieveBatch(storeId, batchId);
      observed.push(o);
      expectTerminalImpliesQuiescent(o, `poll ${i}`);
      expectCountsSumToTotal(o, `poll ${i}`);
      if (o.status !== 'in_progress') return observed;
      await advance();
    }
    throw new Error(`the batch did not reach a terminal status within ${maxPolls} polls`);
  }

  // -- Step 1: the two required properties --------------------------------

  it('never reports a terminal status while a member file is still in_progress', async () => {
    const storeId = await seedStore();
    const fileIds = await seedFiles(MEMBER_COUNT);
    const batch = await createBatch(storeId, fileIds, null, null);

    // One file drained per poll, so the batch is observed part-way through
    // MEMBER_COUNT times. `pollLikeCreateAndPoll` asserts the invariant on
    // each of those observations, not merely on the last.
    const observed = await pollLikeCreateAndPoll(storeId, batch.id, async () => {
      expect(await processOneFile()).toBe(true);
    });

    // The loop was genuinely mid-flight, repeatedly -- otherwise every
    // assertion above was vacuous and this suite would pass against an
    // implementation that reports `completed` immediately.
    const running = observed.filter((o) => o.status === 'in_progress');
    expect(running).toHaveLength(MEMBER_COUNT);
    expect(running.map((o) => o.file_counts.in_progress)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(running.map((o) => o.file_counts.completed)).toEqual([0, 1, 2, 3, 4, 5]);

    // Terminal reached exactly once, at the end, and it is `completed`.
    const terminal = observed.filter((o) => o.status !== 'in_progress');
    expect(terminal).toHaveLength(1);
    expect(observed[observed.length - 1].status).toBe('completed');
    expect(observed[observed.length - 1].file_counts)
      .toEqual({ in_progress: 0, completed: MEMBER_COUNT, failed: 0, cancelled: 0, total: MEMBER_COUNT });
  }, 60_000);

  it('counts sum to total at every poll, never transiently disagreeing', async () => {
    const storeId = await seedStore();
    const fileIds = await seedFiles(MEMBER_COUNT);
    const batch = await createBatch(storeId, fileIds, null, null);

    // Deliberately keeps polling PAST the point the batch settles -- one more
    // iteration than there are members -- so the arithmetic is checked on the
    // way in, at every intermediate step, and after everything has stopped.
    const sums: number[] = [];
    const totals: number[] = [];
    for (let i = 0; i <= MEMBER_COUNT; i += 1) {
      const o = await retrieveBatch(storeId, batch.id);
      const c = o.file_counts;
      sums.push(c.in_progress + c.completed + c.failed + c.cancelled);
      totals.push(c.total);
      expectCountsSumToTotal(o, `poll ${i}`);
      await processOneFile();
    }

    expect(sums).toHaveLength(MEMBER_COUNT + 1);
    // `total` is the batch's membership, which is fixed at creation: it must
    // not drift as members change status. A `total` derived from, say, only
    // the completed rows would satisfy the sum check at every poll and still
    // be wrong -- so it is pinned to the member count directly.
    expect(totals).toEqual(new Array(MEMBER_COUNT + 1).fill(MEMBER_COUNT));
    expect(sums).toEqual(totals);
  }, 60_000);

  // -- the same contract on the non-`completed` terminal statuses ----------

  it('never reports cancelled while a member file is still in_progress', async () => {
    // `cancelled` is terminal too, so it stops an SDK poll loop just as
    // `completed` does. Cancellation only sets a flag; the worker keeps
    // running until it next checks between files. Reporting `cancelled` on the
    // flag alone would hand the caller a store the worker is still writing --
    // which is the same silent failure, reached by a different route.
    const storeId = await seedStore();
    const fileIds = await seedFiles(MEMBER_COUNT);
    const batch = await createBatch(storeId, fileIds, null, null);

    // Requested up front, so EVERY poll below is taken with the flag latched
    // and members still running.
    expect(await requestBatchCancel(storeId, batch.id)).toBe(true);
    expect((await retrieveBatch(storeId, batch.id)).status).toBe('in_progress');

    const observed = await pollLikeCreateAndPoll(storeId, batch.id, async () => {
      await processOneFile();
    });

    expect(observed[observed.length - 1].status).toBe('cancelled');
    expect(observed[observed.length - 1].file_counts)
      .toEqual({ in_progress: 0, completed: 0, failed: 0, cancelled: MEMBER_COUNT, total: MEMBER_COUNT });
    // At least one poll saw the flag set and the batch still running -- the
    // exact state the ordering in `deriveBatchStatus` exists to describe.
    expect(observed.filter((o) => o.status === 'in_progress').length).toBeGreaterThan(0);
    expect(observed.filter((o) => o.status !== 'in_progress')).toHaveLength(1);
  }, 60_000);

  it('reaches completed rather than failed when a member fails, and only once nothing is in flight', async () => {
    // OpenAI's enum contains `failed`, and nothing in this implementation ever
    // returns it: a batch is a unit of work SUBMITTED. A failed member shows up
    // in `file_counts.failed` on a `completed` batch. A poll loop must still
    // not see that terminal status one file early.
    const storeId = await seedStore();
    const fileIds = await seedFiles(MEMBER_COUNT);
    const doomed = fileIds[2];
    const doomedName = (await pool.query<{ filename: string }>(
      'SELECT filename FROM fs_files WHERE id = $1', [doomed],
    )).rows[0].filename;

    // maxRetries 1 makes the first failure terminal, so the file settles in
    // one cycle rather than looping back to in_progress twice more.
    //
    // NOT 0, which looks like the natural "no retries" value and is a trap:
    // `claimNext` opportunistically runs `reapZombies(maxRetries)`, whose
    // predicate is `attempts >= maxRetries AND claimed_at IS NULL`. At 0 that
    // matches every freshly attached row on the very first claim, so the whole
    // store is swept to `failed` before a single file is ever processed, while
    // `claimNext`'s own `attempts < maxRetries` matches nothing at all. At 1
    // the budget is spent by the claim itself (`attempts` becomes 1 and
    // `claimed_at` is set), so only the file that actually threw fails.
    mockConfig.ingestion.maxRetries = 1;
    extractText.mockImplementation(async (filename: string, bytes: Buffer) => {
      if (filename === doomedName) throw new Error('extractor refused this fixture');
      return bytes.toString('utf8');
    });

    const batch = await createBatch(storeId, fileIds, null, null);
    const observed = await pollLikeCreateAndPoll(storeId, batch.id, async () => {
      await processOneFile();
    });

    const last = observed[observed.length - 1];
    expect(last.status).toBe('completed');
    expect(last.file_counts).toEqual({
      in_progress: 0, completed: MEMBER_COUNT - 1, failed: 1, cancelled: 0, total: MEMBER_COUNT,
    });
    // No observation, at any point, reported `failed` as the BATCH status.
    expect(observed.map((o) => o.status)).not.toContain('failed');
    expect(observed.filter((o) => o.status !== 'in_progress')).toHaveLength(1);
  }, 60_000);

  // -- the contract under a store with more than one batch in flight -------

  it('keeps both invariants for two batches draining at the same time', async () => {
    // The counts join is `f.store_id = b.store_id AND f.batch_id = b.id`.
    // Dropping the second predicate makes every sibling batch in the store a
    // member of this one -- the counts stay plausible and the settled state
    // still looks right once the whole store is quiet, so only a poll taken
    // WHILE both batches are mid-flight can see it. Here batch one is finished
    // first, so there is a window in which it is quiescent and its sibling is
    // not: with the predicate dropped, batch one keeps reporting `in_progress`
    // and its `total` is 5 rather than 3.
    const storeId = await seedStore();
    const groupOne = await seedFiles(3, 'one-');
    const groupTwo = await seedFiles(2, 'two-');

    const one = await createBatch(storeId, groupOne, null, null);
    const two = await createBatch(storeId, groupTwo, null, null);
    // LOAD-BEARING ORDERING: batch one drains completely before batch two is
    // touched, which is what creates the mixed quiescent/running window.
    await claimOrder(storeId, [...groupOne, ...groupTwo]);

    const seenOne: Observation[] = [];
    const seenTwo: Observation[] = [];
    // One extra cycle past the last file, so both batches are also observed
    // after the store as a whole has gone quiet.
    for (let i = 0; i <= groupOne.length + groupTwo.length; i += 1) {
      const a = await retrieveBatch(storeId, one.id);
      const b = await retrieveBatch(storeId, two.id);
      seenOne.push(a);
      seenTwo.push(b);
      for (const [label, o] of [['batch one', a], ['batch two', b]] as const) {
        expectTerminalImpliesQuiescent(o, `${label} @ cycle ${i}`);
        expectCountsSumToTotal(o, `${label} @ cycle ${i}`);
      }
      await processOneFile();
    }

    // Each batch only ever counted its own members, at every cycle.
    expect(seenOne.map((o) => o.file_counts.total)).toEqual(new Array(6).fill(3));
    expect(seenTwo.map((o) => o.file_counts.total)).toEqual(new Array(6).fill(2));
    // The window that matters: batch one terminal while batch two still runs.
    const mixed = seenOne.map((o, i) => o.status !== 'in_progress' && seenTwo[i].status === 'in_progress');
    expect(mixed.filter(Boolean).length).toBeGreaterThan(0);
    expect(seenOne[seenOne.length - 1].status).toBe('completed');
    expect(seenTwo[seenTwo.length - 1].status).toBe('completed');
  }, 60_000);

  it('reports an empty batch as terminal on the very first poll, with nothing in flight', async () => {
    // The degenerate case an SDK caller can reach with `file_ids: []`. It must
    // settle immediately rather than leaving `createAndPoll` spinning forever
    // on a batch that has no member able to move it.
    const storeId = await seedStore();
    const batch = await createBatch(storeId, [], null, null);

    const observed = await pollLikeCreateAndPoll(storeId, batch.id, async () => {
      await processOneFile();
    });

    expect(observed).toHaveLength(1);
    expect(observed[0].status).toBe('completed');
    expect(observed[0].file_counts).toEqual({ in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 });
  }, 60_000);
});
