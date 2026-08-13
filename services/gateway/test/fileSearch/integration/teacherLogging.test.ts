// The gap this suite closes: until now NOTHING proved a teacher-label row
// actually lands in Postgres from the search path. teacherLogger.test.ts
// mocks the pool (it proves the SQL is *shaped* right, not that it runs),
// and integration/endToEnd.test.ts pins teacher_logging to `enabled: false`
// on purpose. Here `searchVectorStores` is the REAL function, `pg` is real,
// the schema is real, hybrid recall is real, and every assertion reads the
// rows back out with SQL.
//
// What is stubbed, and why: `embed()` and `rerank()` are the only two calls
// in this path that reach SAP AI Core over the network. `rerank()` is
// stubbed at the same boundary search.test.ts stubs it, which is also what
// makes the teacher's ordering CONTROLLABLE — several tests below need the
// teacher order to be the exact reverse of the retrieval order, which no
// live cross-encoder would reliably produce. Nothing else is mocked away:
// not `pg`, not repository.ts, not teacherLogger.ts.
//
// WAITING FOR A FIRE-AND-FORGET WRITE. `record()` returns void and the
// transaction commits after `searchVectorStores` has already resolved, so
// every test has to wait — but a fixed `setTimeout` sleep is a CI flake
// waiting to happen. Both waits below poll a signal the production code
// itself publishes, with a timeout that only bounds FAILURE:
//   - `__statsForTests().written` is incremented immediately after `COMMIT`
//     returns (teacherLogger.ts), so once it advances the rows are
//     committed and visible to any other connection. Waiting on it cannot
//     observe a half-written state no matter how slow the database is.
//   - `__statsForTests().disabled` is set by handleWriteFailure(), which
//     runs strictly AFTER `await client.query('ROLLBACK')` has resolved in
//     the same catch block, so once it flips, the rollback has already
//     completed. That is the signal the "transaction fails midway" test
//     waits on.
// Neither is a duration. A slow machine makes these tests slower, never
// red.
//
// Schema isolation: createIsolatedSchema() per this directory's convention —
// Jest sets no maxWorkers, so a suite that assumed it owned `public` would
// race every other DSN-gated suite (already observed as 5/6 failures on
// this branch).
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, __resetForTests as resetDbForTests } from '../../../src/fileSearch/db';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

if (!DSN) {
  // Announce the skip loudly. This is the ONLY suite that proves teacher-label
  // rows actually reach Postgres; silently skipping it turns a missing DSN
  // into a green run that has verified nothing about this feature.
  // eslint-disable-next-line no-console
  console.warn(
    '[teacherLogging.test.ts] SKIPPED — FILE_SEARCH_TEST_DSN is not set. '
    + 'Teacher-label logging is NOT covered by this run; no test anywhere else '
    + 'proves a row reaches the database from the search path.',
  );
}

const EMBED_DIM = 3;
const OWNER = 'teacher-logging@example.com';

let mockConfig: any;
let mockTeacherConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => mockTeacherConfig,
  // queryRewriter.ts imports the DEFAULT export (rewriteQuery is false in
  // every test here, so it is never actually called — but the module is
  // still loaded by search.ts's import graph).
  default: { getFileSearchConfig: () => mockConfig },
}));

const embedMock: any = jest.fn();
jest.mock('../../../src/fileSearch/embedder', () => ({
  __esModule: true,
  embed: (...a: any[]) => embedMock(...a),
}));

// Stubbed at the rerank() boundary exactly as search.test.ts does: no live
// SAP HTTP call is made from this suite, and the teacher's ordering becomes
// something the test controls rather than something it hopes for.
const rerankMock: any = jest.fn();
jest.mock('../../../src/fileSearch/reranker', () => ({
  __esModule: true,
  rerank: (...a: any[]) => rerankMock(...a),
}));

// eslint-disable-next-line import/first
import { searchVectorStores, SearchResponse, SearchStoreNotFoundError } from '../../../src/fileSearch/search';
// eslint-disable-next-line import/first
import * as teacherLogger from '../../../src/fileSearch/teacherLogger';

const QUERY = 'how does the widened recall feed the teacher';
const QUERY_EMBEDDING = [1, 0, 0];

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Chunk i's text — distinct per i so chunk_hash/chunk_text assertions can
 *  name an exact expected value, and sharing no word with QUERY so the
 *  lexical arm contributes nothing where it is enabled. */
function chunkText(i: number): string {
  return `zeta corpus body ${i} kiwi mango plum`;
}

/**
 * Retrieval order, per corpus size, as seed indices: `RETRIEVAL_ORDER[6][0]`
 * is the seed index of the chunk RRF ranks FIRST.
 *
 * These are deliberately non-trivial permutations. An earlier version of this
 * fixture made cosine distance monotone in the seed index, which made the RRF
 * order coincide with insertion order AND with lexicographic file_id order at
 * the same time — so `retrieval_rank` was never actually distinguished from
 * "the order I happened to seed in", and fusing by candidate id instead of by
 * fused score would have left every test in this file green. Coinciding
 * orderings are the one recurring defect class on this branch; scrambling the
 * order here is what makes `retrieval_rank` an independently-proven column.
 * No entry is in ascending, descending, or lexicographic-file_id order.
 */
const RETRIEVAL_ORDER: Record<number, number[]> = {
  3: [2, 0, 1],
  4: [2, 0, 3, 1],
  5: [2, 0, 4, 1, 3],
  6: [3, 0, 5, 1, 4, 2],
  12: [7, 0, 11, 3, 5, 1, 9, 2, 10, 4, 8, 6],
};

function retrievalOrder(n: number): number[] {
  const order = RETRIEVAL_ORDER[n];
  if (!order) throw new Error(`no retrieval permutation defined for a corpus of ${n}`);
  return order;
}

/** The file_ids in the order RRF must return them, for a corpus of `n`. */
function expectedRetrievalFileIds(n: number): string[] {
  return retrievalOrder(n).map((seedIndex) => `f-${seedIndex}`);
}

/** Cosine distance from QUERY_EMBEDDING that increases with the chunk's
 *  intended RETRIEVAL POSITION, not with its seed index — so the vector arm's
 *  ranking (and therefore, with the lexical arm off, the whole RRF order) is
 *  RETRIEVAL_ORDER, deterministically and with no ties. Every test that
 *  depends on that order also asserts it from the stored file_id column
 *  rather than assuming it. */
function chunkEmbedding(seedIndex: number, n: number): number[] {
  return [1, retrievalOrder(n).indexOf(seedIndex) * 0.25, 0];
}

/** Teacher scores, descending, all inside [0,1] and all exactly
 *  representable as IEEE doubles so a float8 round-trip through Postgres can
 *  be asserted with toEqual rather than a tolerance. */
const TEACHER_SCORES = [0.875, 0.75, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625,
  0.0078125, 0.00390625, 0.001953125, 0.0009765625];

d('teacher logging against live Postgres (requires FILE_SEARCH_TEST_DSN pointing at pgvector)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    // search.ts, repository.ts AND teacherLogger.ts all reach the database
    // through db.ts's getPool() singleton, which builds its own Pool from
    // this env var rather than accepting one. Pointing it at the isolated
    // schema is what makes the logger write where this suite can read.
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    resetDbForTests();
    pool = getPool()!;
  });

  afterAll(async () => {
    resetDbForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-embedding-model',
      embeddingDimensions: EMBED_DIM,
      rewriteQuery: false,
      hybrid: {
        rrfK: 60,
        lexicalEnabled: false,
        candidates: 50,
        rerank: { enabled: true, model: 'test-reranker-model' },
      },
    };
    mockTeacherConfig = {
      enabled: true,
      storeChunkText: false,
      sampleRate: 1,
      source: 'integration-test',
      maxConcurrentWrites: 4,
    };

    // clearMocks: true wipes implementations between tests — re-arm here.
    embedMock.mockImplementation(async () => ({ vectors: [QUERY_EMBEDDING] }));

    teacherLogger.__resetForTests();
    // Pin the sample-rate RNG: 0 < any sampleRate, so sampling never silently
    // drops a write and turns a real regression into a green run.
    teacherLogger.__setRngForTests(() => 0);

    await truncateLoggingTables();
  });

  afterEach(() => {
    teacherLogger.__resetForTests();
  });

  // -------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------

  async function truncateLoggingTables(): Promise<void> {
    await pool.query('TRUNCATE reranker_candidate_labels, reranker_search_events');
  }

  async function seedStore(ownerEmail: string): Promise<string> {
    const storeId = `store-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO vector_stores (id, owner_email, is_shared, embedding_model, embedding_dim)
       VALUES ($1, $2, false, 'test-embedding-model', ${EMBED_DIM})`,
      [storeId, ownerEmail],
    );
    return storeId;
  }

  async function seedChunk(opts: {
    storeId: string;
    fileId: string;
    ord: number;
    text: string;
    embedding: number[];
    attributes?: Record<string, unknown> | null;
  }): Promise<void> {
    const sha256 = crypto.createHash('sha256')
      .update(`${opts.storeId}:${opts.fileId}:${opts.ord}`).digest('hex');
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ($1, 1, 'inline')
       ON CONFLICT (sha256) DO NOTHING`,
      [sha256],
    );
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ($1, 'seed@example.com', $1, 'assistants', $2, 1)
       ON CONFLICT (id) DO NOTHING`,
      [opts.fileId, sha256],
    );
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, attributes, status)
       VALUES ($1, $2, $3, 'completed')
       ON CONFLICT (store_id, file_id) DO UPDATE SET attributes = EXCLUDED.attributes`,
      [opts.storeId, opts.fileId, opts.attributes ?? null],
    );
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)`,
      [opts.storeId, opts.fileId, opts.ord, opts.text, `[${opts.embedding.join(',')}]`],
    );
  }

  /** Seeds `n` chunks, inserted as f-0 .. f-(n-1) but positioned in vector
   *  space so the retrieval order is the scrambled RETRIEVAL_ORDER[n] — see
   *  that constant for why insertion order must NOT be the retrieval order. */
  async function seedCorpus(n: number, attributes?: Record<string, unknown>): Promise<string> {
    const storeId = await seedStore(OWNER);
    for (let i = 0; i < n; i++) {
      // eslint-disable-next-line no-await-in-loop
      await seedChunk({
        storeId,
        fileId: `f-${i}`,
        ord: 0,
        text: chunkText(i),
        embedding: chunkEmbedding(i, n),
        attributes: attributes ?? null,
      });
    }
    return storeId;
  }

  /**
   * Queues one rerank() response covering `n` candidates.
   *
   * `reverses: true` makes the teacher order the EXACT REVERSE of the
   * retrieval order — the whole point being that `retrieval_rank` and
   * `teacher_rank` then disagree on every single row, so a bug that
   * conflated the two orderings (or that wrote the array position where the
   * candidate index belongs) cannot produce the expected values. A fixture
   * where the two orders coincide would pass whether or not the columns
   * were populated independently, and is worthless.
   */
  function queueRerank(n: number, reverses: boolean): void {
    const order = reverses
      ? Array.from({ length: n }, (_, i) => n - 1 - i)
      : Array.from({ length: n }, (_, i) => i);
    rerankMock.mockResolvedValueOnce({
      hits: order.map((candidateIndex, position) => ({
        index: candidateIndex,
        relevanceScore: TEACHER_SCORES[position],
      })),
      searchUnits: 1,
    });
  }

  function queueRerankUnavailable(): void {
    rerankMock.mockResolvedValueOnce(null);
  }

  /**
   * Waits for the fire-and-forget write to COMMIT, by polling the counter
   * teacherLogger increments immediately after `COMMIT` returns. See this
   * file's header for why this is a real completion signal rather than a
   * sleep. The timeout only bounds failure.
   */
  async function waitForWrittenCount(expected: number, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const stats = teacherLogger.__statsForTests();
      if (stats.written >= expected) return;
      if (stats.disabled) {
        throw new Error('teacher logging self-disabled before the expected write completed');
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${expected} committed teacher-label write(s); `
          + `stats=${JSON.stringify(stats)}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Waits for the self-disable flag, which handleWriteFailure() sets only
   *  after the failing transaction's ROLLBACK has already resolved. */
  async function waitForSelfDisable(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (teacherLogger.__statsForTests().disabled) return;
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the teacher logger to self-disable after a failed write; '
          + `stats=${JSON.stringify(teacherLogger.__statsForTests())}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  interface PoolCalls { query: number; connect: number }

  /**
   * Counts calls into the LIVE pool without mocking it: both wrappers
   * delegate to the real method, so every query still executes against
   * Postgres. `pg`'s own `Pool.query` acquires a client through
   * `this.connect`, so a `query` call also shows up in `connect` — which is
   * exactly what makes `connect - query` the count of transactions taken
   * directly off the search path, i.e. the teacher logger's.
   *
   * Restores by deleting the instance properties, letting the prototype
   * methods take over again — the pool is the module-level getPool()
   * singleton and is reused by every later test in this file.
   */
  function installPoolMeter() {
    const realQuery = Pool.prototype.query;
    const realConnect = Pool.prototype.connect;
    let query = 0;
    let connect = 0;
    (pool as any).query = function meteredQuery(this: Pool, ...args: any[]) {
      query++;
      return (realQuery as any).apply(this, args);
    };
    (pool as any).connect = function meteredConnect(this: Pool, ...args: any[]) {
      connect++;
      return (realConnect as any).apply(this, args);
    };
    return {
      reset() { query = 0; connect = 0; },
      read(): PoolCalls { return { query, connect }; },
      restore() {
        delete (pool as any).query;
        delete (pool as any).connect;
      },
    };
  }

  interface RunOptions {
    candidates: number;
    teacherReverses?: boolean;
    storeChunkText?: boolean;
    rerankerAvailable?: boolean;
    maxNumResults?: number;
    scoreThreshold?: number;
    ownerEmail?: string;
    storeId?: string;
    /** Skip the commit wait — for the cases that deliberately never commit. */
    awaitWrite?: boolean;
  }

  /** Seeds a corpus (unless given a store), runs the REAL searchVectorStores,
   *  and returns once the teacher-label transaction has committed. */
  async function runSearchWithLogging(
    opts: RunOptions,
  ): Promise<{ storeId: string; response: SearchResponse }> {
    mockTeacherConfig.storeChunkText = opts.storeChunkText ?? false;
    const storeId = opts.storeId ?? await seedCorpus(opts.candidates);

    if (opts.rerankerAvailable === false) queueRerankUnavailable();
    else queueRerank(opts.candidates, opts.teacherReverses ?? false);

    const response = await searchVectorStores({
      storeIds: [storeId],
      query: QUERY,
      ownerEmail: opts.ownerEmail ?? OWNER,
      maxNumResults: opts.maxNumResults ?? 50,
      rankingOptions: opts.scoreThreshold !== undefined
        ? { scoreThreshold: opts.scoreThreshold }
        : undefined,
    });

    if (opts.awaitWrite !== false) await waitForWrittenCount(1);
    return { storeId, response };
  }

  // -------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------

  it('writes exactly one event row and one label row per candidate handed to the reranker', async () => {
    const { storeId } = await runSearchWithLogging({ candidates: 12 });

    const ev = await pool.query('SELECT * FROM reranker_search_events');
    expect(ev.rowCount).toBe(1);

    const lb = await pool.query(
      'SELECT * FROM reranker_candidate_labels WHERE event_id = $1', [ev.rows[0].id],
    );
    expect(lb.rowCount).toBe(12);

    // The event's own columns, asserted by VALUE — `candidates_returned`
    // must be the size of the set actually handed to the teacher, and
    // `candidates_requested` the configured recall width, which are
    // deliberately different numbers here (12 vs 50) so a bug writing one
    // into the other's column cannot pass.
    const e = ev.rows[0];
    expect(e.retrieval_mode).toBe('reranked');
    expect(e.reranker_available).toBe(true);
    expect(e.candidates_returned).toBe(12);
    expect(e.candidates_requested).toBe(50);
    expect(e.source).toBe('integration-test');
    expect(e.owner_email).toBe(OWNER);
    expect(e.store_ids).toEqual([storeId]);
    expect(e.query_text).toBe(QUERY);
    expect(e.query_hash).toBe(sha256Hex(QUERY));
    expect(e.rewrite_used).toBe(false);
    expect(e.query_rewritten).toBeNull();
    expect(e.rrf_k).toBe(60);
    expect(e.lexical_enabled).toBe(false);
    expect(e.embedding_model).toBe('test-embedding-model');
    expect(e.embedding_dim).toBe(EMBED_DIM);
    expect(e.reranker_model).toBe('test-reranker-model');
    expect(e.reranker_provider).toBe('cohere');
    expect(e.reranker_search_units).toBe(1);
    expect(e.top_k).toBe(50); // maxNumResults, after search.ts's 1..50 clamp
    expect(e.score_threshold).toBeNull();
    expect(typeof e.total_latency_ms).toBe('number');
    expect(typeof e.rerank_latency_ms).toBe('number');
  });

  // `store_ids` must record what was SEARCHED, not what was asked for. The
  // search path dedupes the caller's store ids before recall runs, so a
  // caller repeating an id (trivially: a client that concatenates two
  // overlapping store lists) searched one store, not two — and an event row
  // that says two would inflate every "stores per search" aggregate computed
  // from this table, with no way to tell the inflation from real fan-out.
  it('records the DEDUPED store ids that recall actually ran against', async () => {
    const storeId = await seedCorpus(3);
    queueRerank(3, false);

    await searchVectorStores({
      storeIds: [storeId, storeId, storeId],
      query: QUERY,
      ownerEmail: OWNER,
      maxNumResults: 50,
    });
    await waitForWrittenCount(1);

    const { rows } = await pool.query('SELECT store_ids FROM reranker_search_events');
    expect(rows).toHaveLength(1);
    expect(rows[0].store_ids).toEqual([storeId]);
  });

  // An EVEN corpus size on purpose. A reversal of an odd-length list has a
  // fixed point in the middle (with n=5, candidate_index 2 keeps rank 3), so
  // the two orderings would still agree on one row out of five. With n=6
  // every single row disagrees, which is the whole premise of this test.
  it('preserves candidate_index, retrieval_rank, teacher_rank and teacher_score independently when the teacher reverses the retrieval order', async () => {
    await runSearchWithLogging({ candidates: 6, teacherReverses: true });

    const { rows } = await pool.query(
      `SELECT candidate_index, file_id, retrieval_rank, teacher_rank, teacher_score
         FROM reranker_candidate_labels ORDER BY candidate_index`,
    );

    // The fixture's own premise, asserted rather than assumed: the RRF order
    // is the scrambled RETRIEVAL_ORDER[6] — neither the insertion order nor
    // the lexicographic file_id order, so `retrieval_rank` is pinned to the
    // FUSED SCORE and to nothing else that happens to correlate with it.
    expect(rows.map((r) => r.file_id)).toEqual(expectedRetrievalFileIds(6));
    expect(rows.map((r) => r.file_id)).not.toEqual(['f-0', 'f-1', 'f-2', 'f-3', 'f-4', 'f-5']);

    expect(rows.map((r) => r.candidate_index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.retrieval_rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // Reversed teacher: candidate 0 is the teacher's LAST choice, and the two
    // orderings now disagree on every row (no fixed point).
    expect(rows.map((r) => r.teacher_rank)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(rows.every((r) => r.teacher_rank !== r.retrieval_rank)).toBe(true);
    // And the scores travel with the teacher's ranks, not the retrieval
    // order — TEACHER_SCORES[0] (the teacher's best) belongs to candidate 5.
    expect(rows.map((r) => r.teacher_score)).toEqual([
      TEACHER_SCORES[5], TEACHER_SCORES[4], TEACHER_SCORES[3],
      TEACHER_SCORES[2], TEACHER_SCORES[1], TEACHER_SCORES[0],
    ]);
    expect(rows.every((r) => r.teacher_score >= 0 && r.teacher_score <= 1)).toBe(true);
  });

  it('marks selected for the rows the teacher ranked into the top-k, not the retrieval top-k', async () => {
    // maxNumResults 2 against a reversed teacher: retrieval's top 2 are
    // candidates 0 and 1, the teacher's top 2 are candidates 5 and 4. Only
    // one of those two answers can be right, so this cannot pass by accident.
    await runSearchWithLogging({ candidates: 6, teacherReverses: true, maxNumResults: 2 });

    const { rows } = await pool.query(
      'SELECT candidate_index, selected FROM reranker_candidate_labels ORDER BY candidate_index',
    );
    expect(rows.map((r) => r.selected)).toEqual([false, false, false, false, true, true]);
  });

  it('stores per-arm ranks and scores from the widened recall, matching what Postgres itself computes', async () => {
    mockConfig.hybrid.lexicalEnabled = true;
    const storeId = await seedStore(OWNER);
    // f-both is recalled by BOTH arms (exact query wording + closest vector);
    // f-vector-only shares no word with the query, so only the vector arm
    // reaches it. Together they pin "both arms populated" and "the absent
    // arm stays NULL" in one fixture.
    await seedChunk({ storeId, fileId: 'f-both', ord: 0, text: QUERY, embedding: [1, 0, 0] });
    await seedChunk({
      storeId, fileId: 'f-vector-only', ord: 0, text: 'zeta corpus kiwi mango plum', embedding: [0.9, 0.1, 0],
    });

    queueRerank(2, false);
    await searchVectorStores({ storeIds: [storeId], query: QUERY, ownerEmail: OWNER, maxNumResults: 50 });
    await waitForWrittenCount(1);

    const { rows } = await pool.query(
      `SELECT file_id, vector_rank, vector_score, lexical_rank, lexical_score, rrf_score
         FROM reranker_candidate_labels ORDER BY candidate_index`,
    );
    expect(rows.length).toBe(2);
    const both = rows.find((r) => r.file_id === 'f-both')!;
    const vectorOnly = rows.find((r) => r.file_id === 'f-vector-only')!;

    // Presence/absence per arm.
    expect(both.vector_rank).not.toBeNull();
    expect(both.lexical_rank).not.toBeNull();
    expect(vectorOnly.vector_rank).not.toBeNull();
    expect(vectorOnly.lexical_rank).toBeNull();
    expect(vectorOnly.lexical_score).toBeNull();

    // VALUES, not mere presence: recompute both arms straight from the table
    // (bypassing recallCandidates entirely) and require the stored columns to
    // equal them. A constant, a sign flip, or the wrong arm's value written
    // into the column would all still be "not null" and would all fail here.
    const arms = await pool.query<{ file_id: string; distance: number; ts: number }>(
      `SELECT c.file_id,
              (c.embedding <=> $1::vector) AS distance,
              ts_rank(c.tsv, plainto_tsquery('simple', $2)) AS ts
         FROM vector_store_chunks c WHERE c.store_id = $3`,
      [`[${QUERY_EMBEDDING.join(',')}]`, QUERY, storeId],
    );
    const armsById = new Map(arms.rows.map((r) => [r.file_id, r]));
    expect(both.vector_score).toBeCloseTo(armsById.get('f-both')!.distance, 6);
    expect(vectorOnly.vector_score).toBeCloseTo(armsById.get('f-vector-only')!.distance, 6);
    expect(both.lexical_score).toBeCloseTo(armsById.get('f-both')!.ts, 6);

    // f-both is nearest in vector space, so it must lead the vector arm.
    expect(both.vector_rank).toBeLessThan(vectorOnly.vector_rank);

    // rrf_score is the FUSED value, not either arm's raw score: the sum of
    // 1/(k + rank) over the arms that recalled the chunk (rrf.ts), k = 60.
    for (const row of rows) {
      const expected = 1 / (60 + row.vector_rank)
        + (row.lexical_rank === null ? 0 : 1 / (60 + row.lexical_rank));
      expect(row.rrf_score).toBeCloseTo(expected, 9);
    }
    // ...and the two rows genuinely differ, so the loop above is not
    // comparing one number against itself twice.
    expect(both.rrf_score).not.toBeCloseTo(vectorOnly.rrf_score, 9);
  });

  it('writes no event row and no label rows when the label insert fails midway, and still serves the full result page', async () => {
    const storeId = await seedCorpus(5);
    // Renaming the labels table away makes the SECOND statement of the
    // logger's transaction fail (42P01) after the event INSERT has already
    // succeeded — a genuine mid-transaction failure, not a rejected BEGIN.
    // If the event were ever committed separately from its labels, the
    // dataset would accumulate events with no candidates: unusable rows that
    // still count towards every aggregate in the docs' verification query.
    await pool.query('ALTER TABLE reranker_candidate_labels RENAME TO reranker_candidate_labels_hidden');
    let response: SearchResponse;
    try {
      queueRerank(5, false);
      response = await searchVectorStores({
        storeIds: [storeId], query: QUERY, ownerEmail: OWNER, maxNumResults: 50,
      });
      // 42P01 is one of the logger's self-disabling codes, and that flag is
      // set only after ROLLBACK has resolved — see the header.
      await waitForSelfDisable();
    } finally {
      await pool.query('ALTER TABLE reranker_candidate_labels_hidden RENAME TO reranker_candidate_labels');
    }

    const ev = await pool.query('SELECT count(*)::int AS n FROM reranker_search_events');
    expect(ev.rows[0].n).toBe(0); // the event rolled back with its labels
    const lb = await pool.query('SELECT count(*)::int AS n FROM reranker_candidate_labels');
    expect(lb.rows[0].n).toBe(0);
    expect(teacherLogger.__statsForTests().written).toBe(0);

    // ...and the search that triggered the failed write was served in full.
    expect(response!.mode).toBe('reranked');
    expect(response!.data.length).toBe(5);
    expect(response!.data[0].content[0].text).toBe(chunkText(retrievalOrder(5)[0]));
  });

  it('stores NULL chunk_text when store_chunk_text is false, and the verbatim text when true', async () => {
    await runSearchWithLogging({ candidates: 3, storeChunkText: false });
    let r = await pool.query(
      'SELECT file_id, chunk_text, chunk_hash FROM reranker_candidate_labels ORDER BY candidate_index',
    );
    expect(r.rows.length).toBe(3);
    expect(r.rows.every((x) => x.chunk_text === null)).toBe(true);
    // chunk_hash must be the sha256 of the REAL chunk text even though the
    // text itself was not stored — that is the whole point of hashing it.
    // Indexed through the retrieval permutation, so the hash is tied to the
    // chunk at that candidate_index rather than to the seeding loop.
    expect(r.rows.map((x) => x.file_id)).toEqual(expectedRetrievalFileIds(3));
    expect(r.rows.map((x) => x.chunk_hash))
      .toEqual(retrievalOrder(3).map((i) => sha256Hex(chunkText(i))));

    await truncateLoggingTables();
    teacherLogger.__resetForTests();
    teacherLogger.__setRngForTests(() => 0);

    await runSearchWithLogging({ candidates: 3, storeChunkText: true });
    r = await pool.query(
      'SELECT file_id, chunk_text, chunk_hash FROM reranker_candidate_labels ORDER BY candidate_index',
    );
    expect(r.rows.length).toBe(3);
    expect(r.rows.map((x) => x.chunk_text)).toEqual(retrievalOrder(3).map((i) => chunkText(i)));
    expect(r.rows.map((x) => x.chunk_hash))
      .toEqual(retrievalOrder(3).map((i) => sha256Hex(chunkText(i))));
  });

  it('records reranker_available = false and NULL teacher columns for an rrf_only search', async () => {
    const { response } = await runSearchWithLogging({ candidates: 4, rerankerAvailable: false });
    expect(response.mode).toBe('rrf_only');

    const ev = await pool.query('SELECT * FROM reranker_search_events');
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].reranker_available).toBe(false);
    expect(ev.rows[0].retrieval_mode).toBe('rrf_only');
    expect(ev.rows[0].reranker_model).toBeNull();
    expect(ev.rows[0].reranker_provider).toBeNull();
    expect(ev.rows[0].rerank_latency_ms).toBeNull();

    const lb = await pool.query(
      'SELECT file_id, teacher_rank, teacher_score, retrieval_rank, rrf_score FROM reranker_candidate_labels ORDER BY candidate_index',
    );
    expect(lb.rows.length).toBe(4);
    expect(lb.rows.every((x) => x.teacher_rank === null && x.teacher_score === null)).toBe(true);
    // The retrieval signal is still fully recorded — an rrf_only event is
    // usable data, not a placeholder — and it is the real fused order, not
    // the seeding order (see RETRIEVAL_ORDER).
    expect(lb.rows.map((x) => x.retrieval_rank)).toEqual([1, 2, 3, 4]);
    expect(lb.rows.map((x) => x.file_id)).toEqual(expectedRetrievalFileIds(4));
    expect(lb.rows.every((x) => typeof x.rrf_score === 'number')).toBe(true);
  });

  it('issues no additional pool call, writes nothing, and returns a byte-identical response, when teacher_logging is disabled', async () => {
    const storeId = await seedCorpus(5);
    const meter = installPoolMeter();

    let disabledResponse: SearchResponse;
    let enabledResponse: SearchResponse;
    let disabled: PoolCalls;
    let enabled: PoolCalls;
    try {
      mockTeacherConfig.enabled = false;
      queueRerank(5, false);
      meter.reset();
      disabledResponse = await searchVectorStores({
        storeIds: [storeId], query: QUERY, ownerEmail: OWNER, maxNumResults: 50,
      });
      disabled = meter.read();
      // Read back between the two measured windows (the reset below discards
      // this probe's own pool traffic).
      expect(await countRows('reranker_search_events')).toBe(0);
      expect(await countRows('reranker_candidate_labels')).toBe(0);
      expect(teacherLogger.__statsForTests().written).toBe(0);

      mockTeacherConfig.enabled = true;
      queueRerank(5, false);
      meter.reset();
      enabledResponse = await searchVectorStores({
        storeIds: [storeId], query: QUERY, ownerEmail: OWNER, maxNumResults: 50,
      });
      // Read AFTER the write has committed, so the logger's pool traffic is
      // inside the measured window rather than racing the read.
      await waitForWrittenCount(1);
      enabled = meter.read();
    } finally {
      meter.restore();
    }

    // The Definition-of-done claim, measured rather than inferred: row counts
    // alone would be satisfied by a read-only probe silently added to the
    // disabled path. Counting the calls is what excludes that.
    // Pinned ABSOLUTELY, not just enabled-vs-disabled. Equality alone cannot
    // see a probe added to BOTH paths (verified: a `getPool().query('SELECT
    // 1')` placed above record()'s `enabled` check leaves an equality-only
    // assertion green). The disabled search must issue exactly these three:
    //   1. search.ts's ownership SELECT on vector_stores
    //   2. recallCandidates' fused recall
    //   3. touchStoreActivity
    // If a legitimate change adds a fourth, update this number deliberately —
    // that is the point of pinning it.
    expect(disabled.query).toBe(3);
    expect(enabled.query).toBe(disabled.query);  // logging adds no query to the search path

    // ...and the meter is demonstrably SENSITIVE to teacher-logging traffic:
    // with logging on it observed exactly one extra pool checkout — the
    // logger's own transaction, taken via pool.connect() off the search path.
    // Without this, "the counts are equal" could be equally true of a meter
    // that was wired up wrong and counted nothing.
    expect(enabled.connect - disabled.connect).toBe(1);

    // Same search, same results — logging changes what is recorded, never
    // what a caller is served.
    expect(JSON.stringify(enabledResponse!)).toBe(JSON.stringify(disabledResponse!));
    expect(await countRows('reranker_search_events')).toBe(1);
    expect(await countRows('reranker_candidate_labels')).toBe(5);
    // (and the disabled half genuinely wrote nothing)
    expect(teacherLogger.__statsForTests().written).toBe(1);
  });

  // NAMED FOR WHAT IT ACTUALLY PROVES. search.ts:169-177 runs an explicit
  // ownership SELECT and throws SearchStoreNotFoundError BEFORE recall, so
  // record() is never reached and nothing is logged. That pre-check is the
  // only thing this test pins: neutralizing recallCandidates' own ownership
  // predicate in repository.ts leaves this suite fully green, because control
  // never gets that far.
  //
  // The label-level tenant boundary — that recall itself cannot return
  // another owner's chunks — is proven live in hybridSearch.test.ts, by
  // "never returns another owner's chunks, even when explicitly asked for
  // their store id" and "binds a nested and/or filter ... and still excludes
  // a foreign store id". Those are the tests that guard it. Do not delete
  // them on the strength of this one.
  it('writes no event and no labels when the ownership pre-check rejects the store', async () => {
    const foreignStore = await seedCorpus(3);
    await pool.query('UPDATE vector_stores SET owner_email = $1 WHERE id = $2',
      ['someone-else@example.com', foreignStore]);

    queueRerank(3, false);
    await expect(searchVectorStores({
      storeIds: [foreignStore], query: QUERY, ownerEmail: OWNER, maxNumResults: 50,
    })).rejects.toBeInstanceOf(SearchStoreNotFoundError);

    expect(await countRows('reranker_search_events')).toBe(0);
    expect(await countRows('reranker_candidate_labels')).toBe(0);
    expect(teacherLogger.__statsForTests().written).toBe(0);
  });

  async function countRows(table: string): Promise<number> {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
  }
});
