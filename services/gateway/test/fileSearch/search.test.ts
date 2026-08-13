/**
 * Unit tests for `searchVectorStores` (the two-stage search entry point) and
 * `vectorStoresController.searchVectorStore` (its HTTP wrapper), with every
 * network/database call mocked: `embed`, `rerank`, `rewriteSearchQuery`,
 * `recallCandidates`/`touchStoreActivity` and the raw `pg` pool.
 * `assertStoreDimension`/`validateAttributes`/`RecallInputError` are kept
 * real (`jest.requireActual`) since they are pure/config-only.
 *
 * `RecallInputError`, deadlocks, and the ownership predicate's genuine
 * database behaviour are covered live in
 * test/fileSearch/integration/hybridSearch.test.ts and
 * test/fileSearch/integration/endToEnd.test.ts; this file covers what
 * search.ts itself is responsible for: clamping, mode reporting,
 * score_threshold semantics, ownership gating BEFORE recall runs, activity
 * touching, and query rewriting.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

let mockConfig: any;
let mockTeacherLoggingConfig: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => mockTeacherLoggingConfig,
}));

const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
const poolConnect = jest.fn<(...args: any[]) => Promise<any>>();
const isFileSearchAvailableMock = jest.fn<(...args: any[]) => boolean>(() => true);
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({
    query: (...a: any[]) => poolQuery(...a),
    connect: (...a: any[]) => poolConnect(...a),
  }),
  isFileSearchAvailable: () => isFileSearchAvailableMock(),
}));

const embedMock = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/embedder', () => ({
  __esModule: true,
  embed: (...a: any[]) => embedMock(...a),
}));

const rerankMock = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/reranker', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/reranker');
  return { ...actual, rerank: (...a: any[]) => rerankMock(...a) };
});

const rewriteMock = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/queryRewriter', () => ({
  __esModule: true,
  rewriteSearchQuery: (...a: any[]) => rewriteMock(...a),
}));

const recallCandidatesMock = jest.fn<(...args: any[]) => Promise<any>>();
const touchStoreActivityMock = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/repository', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/repository');
  return {
    ...actual,
    recallCandidates: (...a: any[]) => recallCandidatesMock(...a),
    touchStoreActivity: (...a: any[]) => touchStoreActivityMock(...a),
  };
});

import { searchVectorStores, SearchOptions } from '../../src/fileSearch/search';
import { searchVectorStore } from '../../src/controllers/vectorStoresController';
import { RecallInputError, CandidateChunk, candidateId } from '../../src/fileSearch/repository';
// Deliberately the REAL module, not jest.mock'ed: the "invisible when
// disabled" tests below rely on record()'s own config-gated early return to
// prove the pool genuinely goes untouched, not just that search.ts skipped
// calling it.
import * as teacherLogger from '../../src/fileSearch/teacherLogger';

function candidate(i: number, overrides: Partial<CandidateChunk> = {}): CandidateChunk {
  return {
    storeId: 'vs_owned',
    fileId: `file-${i}`,
    filename: `f${i}.txt`,
    ord: 0,
    text: `chunk text ${i}`,
    attributes: {},
    score: 1 / (60 + i + 1), // a plausible RRF score
    ...overrides,
  };
}

function makeCandidates(n: number): CandidateChunk[] {
  return Array.from({ length: n }, (_, i) => candidate(i));
}

/** Queues a resolved rerank response with `n` descending-score hits for
 *  candidate indices 0..n-1 — a realistic "reranker answered" shape. */
function mockRerankAvailable(n: number): void {
  rerankMock.mockResolvedValueOnce({
    hits: Array.from({ length: n }, (_, i) => ({ index: i, relevanceScore: 1 - i * (1 / (n + 1)) })),
  });
}

function mockRerankUnavailable(): void {
  rerankMock.mockResolvedValueOnce(null);
}

/** Accepts either a bare hits array (searchUnits left unset) or a full
 *  `{ hits, searchUnits }` result — both are real shapes `rerank()` returns. */
function mockRerankReturns(
  result: Array<{ index: number; relevanceScore: number }>
    | { hits: Array<{ index: number; relevanceScore: number }>; searchUnits?: number },
): void {
  rerankMock.mockResolvedValueOnce(Array.isArray(result) ? { hits: result } : result);
}

function mockRecallReturns(candidates: CandidateChunk[]): void {
  recallCandidatesMock.mockResolvedValue(candidates);
}

/** Controls configService's getTeacherLoggingConfig() for the real
 *  (non-mocked) teacherLogger module. Defaults mirror a conservative
 *  production config; only `enabled` needs overriding by most tests. */
function mockTeacherLogging(overrides: Partial<{
  enabled: boolean; storeChunkText: boolean; sampleRate: number; source: string; maxConcurrentWrites: number;
}> = {}): void {
  mockTeacherLoggingConfig = {
    enabled: false,
    storeChunkText: false,
    sampleRate: 1,
    source: 'file_search',
    maxConcurrentWrites: 5,
    ...overrides,
  };
}

const base: SearchOptions = {
  storeIds: ['vs_owned'],
  query: 'capital of france',
  ownerEmail: 'owner@example.com',
};

beforeEach(() => {
  jest.clearAllMocks();
  teacherLogger.__resetForTests();
  isFileSearchAvailableMock.mockReturnValue(true);
  mockConfig = {
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: 1536,
    rewriteQuery: false,
    hybrid: { candidates: 50, rrfK: 60, lexicalEnabled: true, rerank: { enabled: 'auto', model: 'cohere-reranker' } },
  };
  // Off by default: most tests here are unrelated to teacher logging, and
  // this keeps them from incidentally exercising record()'s write path.
  mockTeacherLogging({ enabled: false });
  poolQuery.mockImplementation(async () => ({ rows: [{ id: 'vs_owned', embedding_dim: 1536 }] }));
  // Backs record()'s `pool.connect()` with a client whose queries route
  // through the same poolQuery spy, so "no extra query" assertions catch a
  // logging INSERT exactly like they'd catch any other stray query.
  poolConnect.mockImplementation(async () => ({
    query: (...a: any[]) => poolQuery(...a),
    release: jest.fn(),
  }));
  embedMock.mockResolvedValue({ vectors: [[0.1, 0.2, 0.3]], usage: { promptTokens: 1, totalTokens: 1 } });
  recallCandidatesMock.mockResolvedValue(makeCandidates(3));
  touchStoreActivityMock.mockResolvedValue(undefined);
  rewriteMock.mockImplementation(async (q: string) => q);
});

// ---------------------------------------------------------------------------
// Ownership: 404, never 403, checked BEFORE recall runs
// ---------------------------------------------------------------------------
describe('ownership', () => {
  it('returns 404 rather than 403 for a store the caller does not own', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [] }));
    await expect(searchVectorStores({ ...base, storeIds: ['vs_someone_else'] }))
      .rejects.toMatchObject({ status: 404 });
    expect(recallCandidatesMock).not.toHaveBeenCalled();
  });

  it('404s if only some of several requested stores resolve — never silently searches the rest', async () => {
    // Only vs_owned resolves; vs_other does not.
    poolQuery.mockImplementation(async () => ({ rows: [{ id: 'vs_owned', embedding_dim: 1536 }] }));
    await expect(searchVectorStores({ ...base, storeIds: ['vs_owned', 'vs_other'] }))
      .rejects.toMatchObject({ status: 404 });
    expect(recallCandidatesMock).not.toHaveBeenCalled();
  });

  it('scopes ownership in the SQL predicate (owner OR is_shared), not by post-filtering recall output', async () => {
    await searchVectorStores(base);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$2/);
    expect(sql).toMatch(/is_shared = true/);
    expect(params).toEqual([['vs_owned'], 'owner@example.com']);
  });

  it('dedupes storeIds before checking ownership and touching activity', async () => {
    await searchVectorStores({ ...base, storeIds: ['vs_owned', 'vs_owned'] });
    expect(poolQuery.mock.calls[0][1][0]).toEqual(['vs_owned']);
    expect(touchStoreActivityMock).toHaveBeenCalledWith(['vs_owned']);
  });

  it('409s when a resolved store\'s pinned embedding_dim no longer matches the live config', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [{ id: 'vs_owned', embedding_dim: 999 }] }));
    await expect(searchVectorStores(base)).rejects.toMatchObject({ status: 409 });
    expect(recallCandidatesMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // I4: an expired store is terminal for use — search 409s rather than
  // running (and, critically, rather than touching last_active_at/
  // expires_at, which would slide the deadline forward forever on a store
  // the sweeper already reclaimed).
  // -------------------------------------------------------------------
  it('409s (never runs recall or touches activity) when the resolved store has status expired', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [{ id: 'vs_owned', embedding_dim: 1536, status: 'expired' }] }));
    await expect(searchVectorStores(base)).rejects.toMatchObject({ status: 409 });
    expect(recallCandidatesMock).not.toHaveBeenCalled();
    expect(touchStoreActivityMock).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('the expired check runs before the dimension check, so an expired+dimension-stale store still reports as expired, not dimension-mismatched', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [{ id: 'vs_owned', embedding_dim: 999, status: 'expired' }] }));
    const error: any = await searchVectorStores(base).catch((e) => e);
    expect(error.name).toBe('StoreExpiredError');
  });

  it('a store with any other status (e.g. completed, in_progress) is never treated as expired', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [{ id: 'vs_owned', embedding_dim: 1536, status: 'completed' }] }));
    await expect(searchVectorStores(base)).resolves.toBeTruthy();
    expect(recallCandidatesMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// query length bound — protects rewriteSearchQuery/embed from an unbounded
// payload. Checked before any query/database work happens.
// ---------------------------------------------------------------------------
describe('query length', () => {
  it('400s a query beyond the configured maximum, before any database or network call', async () => {
    const hugeQuery = 'x'.repeat(8193);
    await expect(searchVectorStores({ ...base, query: hugeQuery })).rejects.toMatchObject({ status: 400 });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  it('accepts a query exactly at the maximum', async () => {
    const maxQuery = 'x'.repeat(8192);
    await expect(searchVectorStores({ ...base, query: maxQuery })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// max_num_results clamping
// ---------------------------------------------------------------------------
describe('max_num_results', () => {
  it('clamps to 50 when the caller asks for far more', async () => {
    recallCandidatesMock.mockResolvedValue(makeCandidates(60));
    mockRerankUnavailable();
    const result = await searchVectorStores({ ...base, maxNumResults: 999 });
    expect(result.data.length).toBeLessThanOrEqual(50);
    expect(result.data.length).toBe(50);
  });

  it('clamps below 1 up to the minimum of 1', async () => {
    mockRerankUnavailable();
    const result = await searchVectorStores({ ...base, maxNumResults: 0 });
    expect(result.data.length).toBe(1);
  });

  it('defaults to 10 when unset', async () => {
    recallCandidatesMock.mockResolvedValue(makeCandidates(20));
    mockRerankUnavailable();
    const result = await searchVectorStores(base);
    expect(result.data.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// mode — proves stage 2 (reranking) genuinely ran vs. degraded
// ---------------------------------------------------------------------------
describe('mode', () => {
  it('reports mode reranked when the reranker answered', async () => {
    mockRerankAvailable(3);
    const result = await searchVectorStores(base);
    expect(result.mode).toBe('reranked');
  });

  it('reports mode rrf_only and still returns results when no reranker exists', async () => {
    mockRerankUnavailable();
    const result = await searchVectorStores(base);
    expect(result.mode).toBe('rrf_only');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('reports mode rrf_only (never reranked) when recall finds nothing, without calling rerank at all', async () => {
    recallCandidatesMock.mockResolvedValue([]);
    const result = await searchVectorStores(base);
    expect(result.mode).toBe('rrf_only');
    expect(result.data).toEqual([]);
    expect(rerankMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// score_threshold — applied to the reranker's score, approximate for RRF
// ---------------------------------------------------------------------------
describe('ranking_options.score_threshold', () => {
  it('applies score_threshold to the reranker score, not the RRF score', async () => {
    recallCandidatesMock.mockResolvedValue([candidate(0), candidate(1)]);
    mockRerankReturns([{ index: 0, relevanceScore: 0.9 }, { index: 1, relevanceScore: 0.2 }]);
    const result = await searchVectorStores({ ...base, rankingOptions: { scoreThreshold: 0.5 } });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].score).toBeCloseTo(0.9);
  });

  it('still applies score_threshold against the RRF score in rrf_only mode (documented as approximate, never silently skipped)', async () => {
    recallCandidatesMock.mockResolvedValue([
      candidate(0, { fileId: 'a', score: 0.9 }),
      candidate(1, { fileId: 'b', score: 0.1 }),
    ]);
    mockRerankUnavailable();
    const result = await searchVectorStores({ ...base, rankingOptions: { scoreThreshold: 0.5 } });
    expect(result.data.map((d) => d.fileId)).toEqual(['a']);
  });

  it('filters out everything when score_threshold excludes every candidate, without throwing', async () => {
    mockRerankReturns([{ index: 0, relevanceScore: 0.1 }, { index: 1, relevanceScore: 0.05 }, { index: 2, relevanceScore: 0.01 }]);
    const result = await searchVectorStores({ ...base, rankingOptions: { scoreThreshold: 0.9 } });
    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The reranker document budget
// ---------------------------------------------------------------------------
describe('reranker document budget', () => {
  it('sends the full recalled candidate set (never more than hybrid.candidates) to the reranker, capped at what recall itself returned', async () => {
    mockConfig.hybrid.candidates = 50;
    recallCandidatesMock.mockResolvedValue(makeCandidates(50));
    mockRerankAvailable(50);
    await searchVectorStores(base);
    const [, documents, topN] = rerankMock.mock.calls[0];
    expect(documents.length).toBe(50);
    expect(topN).toBe(50);
    // And search.ts asked recallCandidates itself to respect the same budget.
    expect(recallCandidatesMock.mock.calls[0][0].limit).toBe(50);
  });

  it('never pads or truncates the document array beyond what recall returned', async () => {
    recallCandidatesMock.mockResolvedValue(makeCandidates(7));
    mockRerankAvailable(7);
    await searchVectorStores(base);
    expect(rerankMock.mock.calls[0][1]).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// query rewriting — implemented, never accepted-and-ignored
// ---------------------------------------------------------------------------
describe('rewrite_query', () => {
  it('rewrites the query before embedding and recall when enabled per-call', async () => {
    rewriteMock.mockResolvedValueOnce('rewritten query text');
    const result = await searchVectorStores({ ...base, rewriteQuery: true });
    expect(rewriteMock).toHaveBeenCalledWith('capital of france');
    expect(embedMock).toHaveBeenCalledWith(['rewritten query text'], 'query');
    expect(recallCandidatesMock.mock.calls[0][0].queryText).toBe('rewritten query text');
    expect(result.searchQuery).toBe('rewritten query text');
  });

  it('does not rewrite when disabled per-call, even if the config default is on', async () => {
    mockConfig.rewriteQuery = true;
    const result = await searchVectorStores({ ...base, rewriteQuery: false });
    expect(rewriteMock).not.toHaveBeenCalled();
    expect(embedMock).toHaveBeenCalledWith(['capital of france'], 'query');
    expect(result.searchQuery).toBe('capital of france');
  });

  it('falls back to the config default when no per-call override is given', async () => {
    mockConfig.rewriteQuery = true;
    await searchVectorStores(base);
    expect(rewriteMock).toHaveBeenCalledWith('capital of france');
  });

  it('config default off + no override: never calls the rewriter', async () => {
    mockConfig.rewriteQuery = false;
    await searchVectorStores(base);
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Defence-in-depth: queryRewriter.ts's OWN contract is "never throws",
  // but rewrite_query defaults to on, so search.ts must not treat that
  // contract as its only line of defence. This test breaks the contract at
  // the mock level (something the real module promises never to do) and
  // asserts search.ts's own try/catch still degrades to the original query
  // rather than failing the whole search.
  // -------------------------------------------------------------------
  it('degrades to the original query, rather than rejecting, if rewriteSearchQuery ever throws despite its own never-throws contract', async () => {
    rewriteMock.mockRejectedValueOnce(new Error('contract violation: this should never happen'));
    const result = await searchVectorStores({ ...base, rewriteQuery: true });
    expect(result.searchQuery).toBe('capital of france');
    expect(embedMock).toHaveBeenCalledWith(['capital of france'], 'query');
  });
});

// ---------------------------------------------------------------------------
// Errors propagate with their own status, never collapsed into a 500
// ---------------------------------------------------------------------------
describe('error propagation', () => {
  it('propagates RecallInputError (malformed/oversized filter) as-is — a 400, never wrapped', async () => {
    recallCandidatesMock.mockRejectedValue(new RecallInputError('bad filter'));
    await expect(searchVectorStores(base)).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// Activity touching (the anchor-sliding fix)
// ---------------------------------------------------------------------------
describe('activity touching', () => {
  it('touches last_active_at for every searched store, even on a zero-result search', async () => {
    recallCandidatesMock.mockResolvedValue([]);
    await searchVectorStores({ ...base, storeIds: ['vs_owned'] });
    expect(touchStoreActivityMock).toHaveBeenCalledWith(['vs_owned']);
  });

  it('touches activity exactly once per search, after recall, not once per candidate', async () => {
    recallCandidatesMock.mockResolvedValue(makeCandidates(5));
    mockRerankUnavailable();
    await searchVectorStores(base);
    expect(touchStoreActivityMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Hit shaping
// ---------------------------------------------------------------------------
describe('SearchHit shape', () => {
  it('maps candidate chunks into fileId/filename/attributes/content', async () => {
    recallCandidatesMock.mockResolvedValue([
      candidate(0, { fileId: 'file-x', filename: 'doc.md', text: 'planted chunk text', attributes: { lang: 'en' }, score: 0.5 }),
    ]);
    mockRerankUnavailable();
    const result = await searchVectorStores(base);
    expect(result.data[0]).toEqual({
      fileId: 'file-x',
      filename: 'doc.md',
      score: 0.5,
      attributes: { lang: 'en' },
      content: [{ type: 'text', text: 'planted chunk text' }],
    });
  });

  it('forwards filters and ownerEmail through to recallCandidates', async () => {
    const filter = { type: 'eq', key: 'lang', value: 'en' };
    await searchVectorStores({ ...base, filters: filter });
    const arg = recallCandidatesMock.mock.calls[0][0];
    expect(arg.filter).toBe(filter);
    expect(arg.ownerEmail).toBe('owner@example.com');
    expect(arg.storeIds).toEqual(['vs_owned']);
  });
});

// ---------------------------------------------------------------------------
// Teacher-label logging (reranker teacher-logging Task 4): the search path
// must be byte-identical to callers whether logging is on or off, the
// logger must see the FULL candidate set (not the filtered/truncated
// response), and an rrf_only search must still log (with teacher: null) so
// "how often is the reranker unavailable" is answerable from the table.
// ---------------------------------------------------------------------------
describe('teacher-label logging', () => {
  it('does not touch the pool when teacher logging is disabled', async () => {
    mockTeacherLogging({ enabled: false });
    mockRerankUnavailable();
    const before = poolQuery.mock.calls.length;
    await searchVectorStores(base);
    // The only query is the search's own ownership SELECT — no BEGIN/INSERT
    // from a logging write, and record() never even reached pool.connect().
    const expectedSearchQueryCount = 1;
    expect(poolQuery.mock.calls.length).toBe(before + expectedSearchQueryCount);
    expect(poolConnect).not.toHaveBeenCalled();
  });

  it('logs an rrf_only event with teacher null when the reranker returns null', async () => {
    mockTeacherLogging({ enabled: true });
    mockRerankUnavailable();
    const spy = jest.spyOn(teacherLogger, 'record');
    await searchVectorStores(base);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ teacher: null }));
  });

  it('passes the FULL candidate set to the logger, not the filtered results', async () => {
    mockTeacherLogging({ enabled: true });
    mockRecallReturns(makeCandidates(50));
    mockRerankReturns([{ index: 0, relevanceScore: 0.9 }]); // only one survives top-k
    const spy = jest.spyOn(teacherLogger, 'record');
    const res = await searchVectorStores({ ...base, maxNumResults: 1 });
    expect(res.data).toHaveLength(1);
    expect(spy.mock.calls[0][0].candidates).toHaveLength(50);
  });

  it('returns identical results whether logging is on or off (rrf_only)', async () => {
    mockRecallReturns(makeCandidates(10));
    mockRerankUnavailable();
    mockTeacherLogging({ enabled: false });
    const off = await searchVectorStores(base);

    mockRecallReturns(makeCandidates(10));
    mockRerankUnavailable();
    mockTeacherLogging({ enabled: true });
    const on = await searchVectorStores(base);

    expect(on.data).toEqual(off.data);
    expect(on.mode).toBe(off.mode);
    expect(on.mode).toBe('rrf_only');
  });

  it('returns identical results whether logging is on or off (reranked)', async () => {
    mockRecallReturns(makeCandidates(10));
    mockRerankAvailable(10);
    mockTeacherLogging({ enabled: false });
    const off = await searchVectorStores(base);

    mockRecallReturns(makeCandidates(10));
    mockRerankAvailable(10);
    mockTeacherLogging({ enabled: true });
    const on = await searchVectorStores(base);

    expect(on.data).toEqual(off.data);
    expect(on.mode).toBe(off.mode);
    expect(on.mode).toBe('reranked');
  });

  it('builds selectedIds from the TEACHER\'s top pick, not recall order — a fixture where they disagree', async () => {
    mockTeacherLogging({ enabled: true });
    // Recall (RRF) order is a, b, c (candidates[0] is 'a'). The reranker
    // disagrees: its best hit is index 2 ('c'), not index 0 — so a mutation
    // that built selectedIds from candidates.slice(0, maxNumResults)
    // (recall order, ignoring the teacher) selects 'a' and this test would
    // catch it, unlike an identity-ordered fixture where both agree.
    mockRecallReturns([
      candidate(0, { fileId: 'a', ord: 0 }),
      candidate(1, { fileId: 'b', ord: 0 }),
      candidate(2, { fileId: 'c', ord: 0 }),
    ]);
    mockRerankReturns([
      { index: 2, relevanceScore: 0.9 }, // 'c' is the teacher's top pick
      { index: 0, relevanceScore: 0.5 },
      { index: 1, relevanceScore: 0.1 },
    ]);
    const spy = jest.spyOn(teacherLogger, 'record');
    await searchVectorStores({ ...base, maxNumResults: 1 });
    const selectedIds: Set<string> = spy.mock.calls[0][0].selectedIds;
    expect(selectedIds.has(candidateId('vs_owned', 'c', 0))).toBe(true);
    expect(selectedIds.has(candidateId('vs_owned', 'a', 0))).toBe(false);
    expect(selectedIds.has(candidateId('vs_owned', 'b', 0))).toBe(false);
  });

  it('records billed search units and the three latencies', async () => {
    mockTeacherLogging({ enabled: true });
    mockRerankReturns({ hits: [{ index: 0, relevanceScore: 0.9 }], searchUnits: 2 });
    // A real delay, not an immediate resolve: ms()'s integer-millisecond
    // truncation makes any stage under ~1ms indistinguishable from a
    // completely broken clock (e.g. ms() hardcoded to 0, or Date.now()
    // masquerading as the monotonic clock) in a fully-mocked run. Pin a
    // number large enough that truncation can't hide either mutation.
    embedMock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { vectors: [[0.1, 0.2, 0.3]], usage: { promptTokens: 1, totalTokens: 1 } };
    });
    const spy = jest.spyOn(teacherLogger, 'record');
    await searchVectorStores(base);
    const input = spy.mock.calls[0][0];
    expect(input.rerankerSearchUnits).toBe(2);
    expect(input.embedLatencyMs).toBeGreaterThanOrEqual(10);
    expect(input.rerankLatencyMs).toBeGreaterThanOrEqual(0);
    expect(input.totalLatencyMs).toBeGreaterThanOrEqual(input.embedLatencyMs!);
  });

  it('omits rerankLatencyMs when the reranker returned null (rrf_only), even though it was called', async () => {
    mockTeacherLogging({ enabled: true });
    mockRerankUnavailable();
    const spy = jest.spyOn(teacherLogger, 'record');
    await searchVectorStores(base);
    const input = spy.mock.calls[0][0];
    expect(input.rerankLatencyMs).toBeUndefined();
    expect(input.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  // Pinned, not necessarily final: a zero-candidate search hits the early
  // return in search.ts (before `selected`/`hits`/timings even exist), so
  // there is nothing meaningful to rank or select — no candidates, no
  // reranker call, no teacher verdict. Unlike an rrf_only search (reranker
  // ran and came back unavailable — itself a signal worth counting), this
  // is "recall found nothing," which the existing zero-result response
  // already communicates. If that judgment changes, move the record() call
  // ahead of the empty-candidates return rather than just changing this
  // assertion.
  it('does not log a zero-candidate search: nothing to log if recall found nothing', async () => {
    mockTeacherLogging({ enabled: true });
    mockRecallReturns([]);
    const spy = jest.spyOn(teacherLogger, 'record');
    await searchVectorStores(base);
    expect(spy).not.toHaveBeenCalled();
  });

  // Acceptance criterion, not just today's implementation detail: the call
  // site must not depend on record()'s own internal try/catch. Force a
  // synchronous throw at the call boundary and confirm it never reaches the
  // caller of searchVectorStores.
  it('never lets a synchronous throw from record() propagate to the caller', async () => {
    mockTeacherLogging({ enabled: true });
    jest.spyOn(teacherLogger, 'record').mockImplementation(() => {
      throw new Error('teacherLogger.record boom');
    });
    await expect(searchVectorStores(base)).resolves.toMatchObject({
      object: 'vector_store.search_results.page',
    });
  });
});

// ---------------------------------------------------------------------------
// The HTTP endpoint: OpenAI page shape, `mode` NEVER on the wire
// ---------------------------------------------------------------------------
describe('POST /vector_stores/{id}/search (controller)', () => {
  function makeRes(): any {
    const res: any = { headersSent: false, statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
  }
  function baseReq(overrides: Record<string, any> = {}): any {
    return {
      headers: {}, params: { id: 'vs_owned' }, query: {}, body: { query: 'capital of france' },
      apiKeyInfo: { email: 'owner@example.com' }, ...overrides,
    };
  }

  it('returns the OpenAI page shape without the internal mode field', async () => {
    mockRerankAvailable(3);
    const res = makeRes();
    await searchVectorStore(baseReq(), res, jest.fn() as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.object).toBe('vector_store.search_results.page');
    // ARRAY, matching captured OpenAI responses (2026-08-06). A bare string
    // makes `search_query[0]` yield 'c' instead of the query.
    expect(res.body.search_query).toEqual(['capital of france']);
    expect(res.body.has_more).toBe(false);
    expect(res.body.next_page).toBeNull();
    expect(res.body).not.toHaveProperty('mode');
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const hit of res.body.data) {
      expect(hit).not.toHaveProperty('mode');
      expect(hit).toEqual({
        file_id: expect.any(String),
        filename: expect.any(String),
        score: expect.any(Number),
        attributes: expect.any(Object),
        content: expect.any(Array),
      });
    }
  });

  it('400s when query is missing', async () => {
    const res = makeRes();
    await searchVectorStore(baseReq({ body: {} }), res, jest.fn() as any);
    expect(res.statusCode).toBe(400);
  });

  it('400s when max_num_results is not a number', async () => {
    const res = makeRes();
    await searchVectorStore(baseReq({ body: { query: 'x', max_num_results: 'lots' } }), res, jest.fn() as any);
    expect(res.statusCode).toBe(400);
  });

  it('400s when ranking_options.score_threshold is not a number', async () => {
    const res = makeRes();
    await searchVectorStore(
      baseReq({ body: { query: 'x', ranking_options: { score_threshold: 'high' } } }), res, jest.fn() as any,
    );
    expect(res.statusCode).toBe(400);
  });

  it('404s for a store the caller does not own — same error shape as every other store 404', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [] }));
    const res = makeRes();
    await searchVectorStore(baseReq({ params: { id: 'vs_other' } }), res, jest.fn() as any);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('vector_store_not_found');
  });

  it('400s a query beyond the length bound, mapped through handleKnownError', async () => {
    const res = makeRes();
    await searchVectorStore(baseReq({ body: { query: 'x'.repeat(8193) } }), res, jest.fn() as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('query_too_long');
  });

  it('409s for an expired store, mapped through handleKnownError', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [{ id: 'vs_owned', embedding_dim: 1536, status: 'expired' }] }));
    const res = makeRes();
    await searchVectorStore(baseReq(), res, jest.fn() as any);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('vector_store_expired');
  });

  it('503s when file_search is unavailable', async () => {
    isFileSearchAvailableMock.mockReturnValueOnce(false);
    const res = makeRes();
    await searchVectorStore(baseReq(), res, jest.fn() as any);
    expect(res.statusCode).toBe(503);
  });

  it('401s when unauthenticated', async () => {
    const res = makeRes();
    await searchVectorStore(baseReq({ apiKeyInfo: undefined }), res, jest.fn() as any);
    expect(res.statusCode).toBe(401);
  });
});
