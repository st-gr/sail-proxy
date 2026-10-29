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
jest.mock('../../src/fileSearch/embedder', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/embedder');
  return { ...actual, embed: (...a: any[]) => embedMock(...a) };
});

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
import { storeAccessPredicateSql } from '../../src/fileSearch/recallSql';
import { searchVectorStore } from '../../src/controllers/vectorStoresController';
import { RecallInputError, CandidateChunk, candidateId } from '../../src/fileSearch/repository';
import { EmbeddingModelUnavailableError } from '../../src/fileSearch/embedder';
import { StoreModelUnavailableError } from '../../src/fileSearch/search';
import { RerankerUnavailableError } from '../../src/fileSearch/reranker';
// Deliberately the REAL module, not jest.mock'ed: the "invisible when
// disabled" tests below rely on record()'s own config-gated early return to
// prove the pool genuinely goes untouched, not just that search.ts skipped
// calling it.
import * as teacherLogger from '../../src/fileSearch/teacherLogger';
import usageEmitter from '../../src/services/usageEventEmitter';

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

/** What `embed` is asked for when searching the default store. */
const STORE_TARGET = { model: 'text-embedding-3-large', dimensions: 1536 };

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
    hybrid: { candidates: 50, rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', rerank: { enabled: 'auto', model: 'cohere-reranker' } },
  };
  // Off by default: most tests here are unrelated to teacher logging, and
  // this keeps them from incidentally exercising record()'s write path.
  mockTeacherLogging({ enabled: false });
  poolQuery.mockImplementation(async () => ({
    rows: [{ id: 'vs_owned', embedding_dim: 1536, embedding_model: 'text-embedding-3-large' }],
  }));
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

  it('scopes ownership in the SQL predicate (owner OR is_shared OR a team share), not by post-filtering recall output', async () => {
    await searchVectorStores(base);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain(storeAccessPredicateSql('$3'));
    expect(params).toEqual([['vs_owned'], 'owner@example.com', []]);
  });

  it('binds the caller\'s team ids to the store check and hands them to recall', async () => {
    await searchVectorStores({ ...base, teamIds: ['team-1'] });
    expect(poolQuery.mock.calls[0][1]).toEqual([['vs_owned'], 'owner@example.com', ['team-1']]);
    expect(recallCandidatesMock.mock.calls[0][0]).toMatchObject({ ownerEmail: 'owner@example.com', teamIds: ['team-1'] });
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
    expect(rewriteMock).toHaveBeenCalledWith('capital of france', undefined);
    expect(embedMock).toHaveBeenCalledWith(['rewritten query text'], 'query', STORE_TARGET);
    expect(recallCandidatesMock.mock.calls[0][0].queryText).toBe('rewritten query text');
    expect(result.searchQuery).toBe('rewritten query text');
  });

  it('does not rewrite when disabled per-call, even if the config default is on', async () => {
    mockConfig.rewriteQuery = true;
    const result = await searchVectorStores({ ...base, rewriteQuery: false });
    expect(rewriteMock).not.toHaveBeenCalled();
    expect(embedMock).toHaveBeenCalledWith(['capital of france'], 'query', STORE_TARGET);
    expect(result.searchQuery).toBe('capital of france');
  });

  it('falls back to the config default when no per-call override is given', async () => {
    mockConfig.rewriteQuery = true;
    await searchVectorStores(base);
    expect(rewriteMock).toHaveBeenCalledWith('capital of france', undefined);
  });

  it("hands the search's usage sink to the rewriter, so a rewrite is billed with the search", async () => {
    const usage = jest.fn();
    await searchVectorStores({ ...base, rewriteQuery: true, usage });
    expect(rewriteMock).toHaveBeenCalledWith('capital of france', usage);
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
    expect(embedMock).toHaveBeenCalledWith(['capital of france'], 'query', STORE_TARGET);
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
// One model per store (plan Decisions 2, 7 and 13): the query is embedded with
// each store's own model, stores are grouped by model with one vector arm per
// group, and a store whose model is no longer served fails with a clear 409.
// ---------------------------------------------------------------------------
describe('one model per store', () => {
  const stores = [
    { id: 'vs_a', embedding_dim: 1536, embedding_model: 'model-a', status: 'completed' },
    { id: 'vs_b', embedding_dim: 1536, embedding_model: 'model-b', status: 'completed' },
    { id: 'vs_c', embedding_dim: 1536, embedding_model: 'model-a', status: 'completed' },
  ];
  const vectorFor: Record<string, number[]> = { 'model-a': [1, 0, 0], 'model-b': [0, 1, 0] };

  beforeEach(() => {
    poolQuery.mockImplementation(async () => ({ rows: stores }));
    embedMock.mockImplementation(async (_texts: any, _kind: any, target: any) => (
      { vectors: [vectorFor[target.model]], usage: { promptTokens: 1, totalTokens: 1 } }));
  });

  it('embeds the query with the store\'s own model, not the configured one', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [stores[1]] }));
    await searchVectorStores({ ...base, storeIds: ['vs_b'] });
    expect(mockConfig.embeddingModel).toBe('text-embedding-3-large');
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith(['capital of france'], 'query', { model: 'model-b', dimensions: 1536 });
    expect(recallCandidatesMock.mock.calls[0][0].vectorArms).toEqual([
      { storeIds: ['vs_b'], queryEmbedding: [0, 1, 0], model: 'model-b' },
    ]);
  });

  it('embeds once per model and gives recall one vector arm per model group', async () => {
    await searchVectorStores({ ...base, storeIds: ['vs_a', 'vs_b', 'vs_c'] });

    expect(embedMock).toHaveBeenCalledTimes(2);
    const models = embedMock.mock.calls.map((c) => (c[2] as any).model).sort();
    expect(models).toEqual(['model-a', 'model-b']);
    for (const call of embedMock.mock.calls) {
      expect(call[0]).toEqual(['capital of france']);
      expect((call[2] as any).dimensions).toBe(1536);
    }
    const arg = recallCandidatesMock.mock.calls[0][0];
    expect(arg.storeIds).toEqual(['vs_a', 'vs_b', 'vs_c']);
    expect(arg.queryEmbedding).toBeUndefined();
    expect(arg.vectorArms).toEqual([
      { storeIds: ['vs_a', 'vs_c'], queryEmbedding: [1, 0, 0], model: 'model-a' },
      { storeIds: ['vs_b'], queryEmbedding: [0, 1, 0], model: 'model-b' },
    ]);
  });

  it('records the models actually used on the teacher log', async () => {
    mockTeacherLogging({ enabled: true });
    const spy = jest.spyOn(teacherLogger, 'record');
    poolQuery.mockImplementation(async () => ({ rows: [stores[1]] }));
    await searchVectorStores({ ...base, storeIds: ['vs_b'] });
    expect(spy.mock.calls[0][0].embeddingModel).toBe('model-b');
  });

  it('fails with store_model_unavailable (409, naming the store and asking for a re-embed) when the store\'s model is not served', async () => {
    embedMock.mockImplementation(async (_t: any, _k: any, target: any) => {
      if (target.model === 'model-b') throw new EmbeddingModelUnavailableError('model-b');
      return { vectors: [vectorFor[target.model]], usage: { promptTokens: 1, totalTokens: 1 } };
    });

    const error: any = await searchVectorStores({ ...base, storeIds: ['vs_a', 'vs_b'] }).catch((e) => e);

    expect(error).toBeInstanceOf(StoreModelUnavailableError);
    expect(error).toMatchObject({ status: 409, code: 'store_model_unavailable', storeId: 'vs_b', storeIds: ['vs_b'] });
    expect(error.message).toContain('vs_b');
    expect(error.message).toContain('model-b');
    expect(error.message).toMatch(/re-embed/i);
    expect(error.message).not.toContain('vs_a');
    expect(recallCandidatesMock).not.toHaveBeenCalled();
    expect(touchStoreActivityMock).not.toHaveBeenCalled();
  });

  it('leaves every other embedding failure as it was', async () => {
    const upstream = Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } });
    embedMock.mockRejectedValue(upstream);
    await expect(searchVectorStores({ ...base, storeIds: ['vs_a'] })).rejects.toBe(upstream);
  });

  it('keeps the dimension check: a store on another dimension still 409s as a dimension mismatch before any embed', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [stores[0], { ...stores[1], embedding_dim: 3072 }] }));
    const error: any = await searchVectorStores({ ...base, storeIds: ['vs_a', 'vs_b'] }).catch((e) => e);
    expect(error.code).toBe('embedding_dimension_mismatch');
    expect(embedMock).not.toHaveBeenCalled();
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

  it('passes the request\'s hybrid_search weights to the logger', async () => {
    mockTeacherLogging({ enabled: true });
    const spy = jest.spyOn(teacherLogger, 'record');
    await searchVectorStores({ ...base, rankingOptions: { hybridWeights: { embedding: 1, text: 2 } } });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hybridWeights: { embedding: 1, text: 2 } }));
  });

  it('passes the configured full-text query mode (hybrid.lexical_query) to the logger', async () => {
    mockTeacherLogging({ enabled: true });
    mockConfig.hybrid.lexicalQuery = 'all';
    const spy = jest.spyOn(teacherLogger, 'record');
    await searchVectorStores(base);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ lexicalQuery: 'all' }));
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
// Usage recording (phase 4b): the `usage` sink sees every billed embedding
// request and the rerank's search units, also when the search then fails.
// ---------------------------------------------------------------------------
describe('usage sink', () => {
  /** An embed fake that reports one billed request through `onUsage`, as embedder.ts does. */
  function embedReporting(promptTokens: number, elapsedMs = 4): (...a: any[]) => Promise<any> {
    return async (_t: any, _k: any, target: any, options?: any) => {
      options?.onUsage?.({ promptTokens, totalTokens: promptTokens, elapsedMs });
      return { vectors: [[0.1, 0.2, 0.3]], usage: { promptTokens, totalTokens: promptTokens }, target };
    };
  }

  it('records one query-embedding event per billed request, with the store\'s model', async () => {
    embedMock.mockImplementation(embedReporting(7, 12));
    mockRerankUnavailable();
    const usage = jest.fn();
    await searchVectorStores({ ...base, usage });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith({
      endpoint: 'file_search/search', model: 'text-embedding-3-large', inputTokens: 7, unit: 'tokens', responseTime: 12,
    });
  });

  it('records the rerank search units under file_search/rerank with the configured reranker model', async () => {
    embedMock.mockImplementation(embedReporting(7));
    mockRerankReturns({ hits: [{ index: 0, relevanceScore: 0.9 }], searchUnits: 2 });
    const usage = jest.fn();
    await searchVectorStores({ ...base, usage });
    expect(usage).toHaveBeenCalledTimes(2);
    expect(usage).toHaveBeenLastCalledWith({
      endpoint: 'file_search/rerank', model: 'cohere-reranker', inputTokens: 2, unit: 'units', responseTime: expect.any(Number),
    });
  });

  it.each([
    ['no reranker answered', null],
    ['no search units reported', { hits: [{ index: 0, relevanceScore: 0.9 }] }],
    ['zero search units', { hits: [{ index: 0, relevanceScore: 0.9 }], searchUnits: 0 }],
    ['non-finite search units', { hits: [{ index: 0, relevanceScore: 0.9 }], searchUnits: Number.NaN }],
  ])('records no units event when %s', async (_label, rerankResult) => {
    embedMock.mockImplementation(embedReporting(7));
    rerankMock.mockResolvedValueOnce(rerankResult);
    const usage = jest.fn();
    await searchVectorStores({ ...base, usage });
    expect(usage.mock.calls.map((c: any[]) => c[0].endpoint)).toEqual(['file_search/search']);
  });

  it('records no rerank event when recall found nothing to rerank', async () => {
    embedMock.mockImplementation(embedReporting(7));
    recallCandidatesMock.mockResolvedValue([]);
    const usage = jest.fn();
    await searchVectorStores({ ...base, usage });
    expect(usage.mock.calls.map((c: any[]) => c[0].endpoint)).toEqual(['file_search/search']);
  });

  it('records a succeeded model group even when another group fails the search', async () => {
    poolQuery.mockImplementation(async () => ({
      rows: [
        { id: 'vs_a', embedding_dim: 1536, embedding_model: 'model-a', status: 'completed' },
        { id: 'vs_b', embedding_dim: 1536, embedding_model: 'model-b', status: 'completed' },
      ],
    }));
    const reporting = embedReporting(5);
    embedMock.mockImplementation(async (t: any, k: any, target: any, options?: any) => {
      if (target.model === 'model-b') throw new EmbeddingModelUnavailableError('model-b');
      return reporting(t, k, target, options);
    });
    const usage = jest.fn();
    await expect(searchVectorStores({ ...base, storeIds: ['vs_a', 'vs_b'], usage }))
      .rejects.toBeInstanceOf(StoreModelUnavailableError);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-a', inputTokens: 5 }));
  });

  it('records the embedding when the search fails after it', async () => {
    embedMock.mockImplementation(embedReporting(9));
    recallCandidatesMock.mockRejectedValue(new RecallInputError('bad filter'));
    const usage = jest.fn();
    await expect(searchVectorStores({ ...base, usage })).rejects.toMatchObject({ status: 400 });
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'file_search/search', inputTokens: 9 }));
  });

  it('records the embedding and no units event when a required reranker is unavailable', async () => {
    mockConfig.hybrid.rerank.enabled = true;
    embedMock.mockImplementation(embedReporting(8));
    rerankMock.mockRejectedValueOnce(new RerankerUnavailableError('No RUNNING SAP AI Core reranker deployment was found for file_search'));
    const usage = jest.fn();
    await expect(searchVectorStores({ ...base, usage })).rejects.toBeInstanceOf(RerankerUnavailableError);
    expect(usage.mock.calls.map((c: any[]) => c[0])).toEqual([
      expect.objectContaining({ endpoint: 'file_search/search', inputTokens: 8, unit: 'tokens' }),
    ]);
  });

  it('a sink that throws on the rerank event never fails the search', async () => {
    embedMock.mockImplementation(embedReporting(7));
    mockRerankReturns({ hits: [{ index: 0, relevanceScore: 0.9 }], searchUnits: 1 });
    const usage = jest.fn((u: any) => { if (u.endpoint === 'file_search/rerank') throw new Error('sink boom'); });
    await expect(searchVectorStores({ ...base, usage })).resolves.toMatchObject({ mode: 'reranked' });
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

  it('adds pages as an extension only to a hit with pages; every other field as before', async () => {
    recallCandidatesMock.mockResolvedValue([candidate(0, { pages: { first: 4, last: 5 } }), candidate(1)]);
    mockRerankAvailable(2);
    const res = makeRes();
    await searchVectorStore(baseReq(), res, jest.fn() as any);
    expect(res.statusCode).toBe(200);
    const [paged, plain] = res.body.data;
    expect(paged).toEqual({
      file_id: expect.any(String), filename: expect.any(String), score: expect.any(Number),
      attributes: expect.any(Object), content: expect.any(Array), pages: { first: 4, last: 5 },
    });
    expect(Object.keys(plain).sort()).toEqual(['attributes', 'content', 'file_id', 'filename', 'score']);
    expect(paged.attributes).not.toHaveProperty('pages');
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

  // OpenAI bounds the field to "between 1 and 50 inclusive" (openai-python
  // types/vector_store_search_params.py) and the Responses file_search tool here 400s outside it
  // (plugins/fileSearch/descriptor.ts prepare): the REST search answers the same 400, never a clamp.
  it.each([0, 51, -1, 2.5, 999])('400s an out-of-range max_num_results (%p) as the Responses tool does', async (bad) => {
    const res = makeRes();
    await searchVectorStore(baseReq({ body: { query: 'x', max_num_results: bad } }), res, jest.fn() as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_max_num_results');
    expect(res.body.error.message).toBe('max_num_results must be an integer between 1 and 50');
    expect(recallCandidatesMock).not.toHaveBeenCalled();
  });

  it('treats max_num_results: null as absent, as the Responses tool does', async () => {
    recallCandidatesMock.mockResolvedValue(makeCandidates(60));
    mockRerankUnavailable();
    const withNull = makeRes();
    await searchVectorStore(baseReq({ body: { query: 'x', max_num_results: null } }), withNull, jest.fn() as any);
    const absent = makeRes();
    await searchVectorStore(baseReq({ body: { query: 'x' } }), absent, jest.fn() as any);
    expect(withNull.statusCode).toBe(200);
    expect(withNull.body.data.length).toBe(absent.body.data.length);
  });

  it.each([1, 50])('accepts max_num_results %p, the ends of the range', async (ok) => {
    recallCandidatesMock.mockResolvedValue(makeCandidates(60));
    mockRerankUnavailable();
    const res = makeRes();
    await searchVectorStore(baseReq({ body: { query: 'x', max_num_results: ok } }), res, jest.fn() as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.length).toBe(ok);
  });

  it('400s when ranking_options.score_threshold is not a number', async () => {
    const res = makeRes();
    await searchVectorStore(
      baseReq({ body: { query: 'x', ranking_options: { score_threshold: 'high' } } }), res, jest.fn() as any,
    );
    expect(res.statusCode).toBe(400);
  });

  it('400s invalid_hybrid_search for a negative or all-zero weight', async () => {
    for (const hybrid_search of [{ text_weight: -1 }, { embedding_weight: 0, text_weight: 0 }, 'x']) {
      const res = makeRes();
      await searchVectorStore(
        baseReq({ body: { query: 'x', ranking_options: { hybrid_search } } }), res, jest.fn() as any,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('invalid_hybrid_search');
    }
  });

  it('passes hybrid_search weights through to the recall as hybridWeights', async () => {
    mockRerankAvailable(3);
    const res = makeRes();
    await searchVectorStore(
      baseReq({ body: { query: 'x', ranking_options: { hybrid_search: { text_weight: 2 } } } }), res, jest.fn() as any,
    );
    expect(res.statusCode).toBe(200);
    expect(recallCandidatesMock.mock.calls.at(-1)![0].hybridWeights).toEqual({ embedding: 1, text: 2 });
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

  it('409s with store_model_unavailable, naming the store, when the store\'s model is no longer served', async () => {
    embedMock.mockRejectedValue(new EmbeddingModelUnavailableError('text-embedding-3-large'));
    const res = makeRes();
    const next = jest.fn();
    await searchVectorStore(baseReq(), res, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('store_model_unavailable');
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(res.body.error.message).toContain('vs_owned');
    expect(res.body.error.message).toMatch(/re-embed/i);
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

  describe('usage recording', () => {
    function reportingEmbed(): void {
      embedMock.mockImplementation(async (_t: any, _k: any, _target: any, options?: any) => {
        options?.onUsage?.({ promptTokens: 6, totalTokens: 6, elapsedMs: 2 });
        return { vectors: [[0.1, 0.2, 0.3]], usage: { promptTokens: 6, totalTokens: 6 } };
      });
    }

    it('bills an OpenAI-API search to the caller\'s own key, with ids derived from the request id', async () => {
      const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
      reportingEmbed();
      mockRerankReturns({ hits: [{ index: 0, relevanceScore: 0.9 }], searchUnits: 1 });
      const res = makeRes();
      await searchVectorStore(baseReq({
        debugRequestId: 'req-abc',
        unifiedAuth: { valid: true, authType: 'api_key', data: { id: 'user-key' } },
      }), res, jest.fn() as any);
      expect(res.statusCode).toBe(200);
      const events = emit.mock.calls.map((c) => c[0]);
      expect(events).toEqual([
        expect.objectContaining({
          requestId: 'req-abc-fs-embed-1', credentialId: 'user-key', authType: 'api_key',
          endpoint: 'file_search/search', model: 'text-embedding-3-large', inputTokens: 6, unit: 'tokens',
        }),
        expect.objectContaining({
          requestId: 'req-abc-fs-rerank', credentialId: 'user-key',
          endpoint: 'file_search/rerank', model: 'cohere-reranker', inputTokens: 1, unit: 'units',
        }),
      ]);
      for (const e of events) expect(e).not.toHaveProperty('onBehalfOf');
      emit.mockRestore();
    });

    it('bills a cockpit Test retrieval to the service key on behalf of the acting user', async () => {
      const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
      reportingEmbed();
      mockRerankUnavailable();
      const res = makeRes();
      await searchVectorStore(baseReq({
        debugRequestId: 'req-ckp',
        apiKeyInfo: { active: true, email: 'reader@example.com', authSource: 'grounding' },
        serviceAuth: { authType: 'service-key', serviceKey: { id: 'svc-key-id' } },
        groundingActor: { email: 'reader@example.com', role: 'user' },
      }), res, jest.fn() as any);
      expect(res.statusCode).toBe(200);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0]).toMatchObject({
        requestId: 'req-ckp-fs-embed-1', credentialId: 'svc-key-id', authType: 'api_key', onBehalfOf: 'reader@example.com',
        endpoint: 'file_search/search',
      });
      emit.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// ranking_options.ranker 'none' — no rerank call, no rerank cost
// ---------------------------------------------------------------------------
describe('rerank: false (ranking_options.ranker "none")', () => {
  it('never calls the reranker, keeps the RRF order and scores, and reports rrf_only', async () => {
    const cands = makeCandidates(3);
    recallCandidatesMock.mockResolvedValue(cands);
    embedMock.mockImplementation(async (_t: any, _k: any, _target: any, options?: any) => {
      options?.onUsage?.({ promptTokens: 3, totalTokens: 3, elapsedMs: 1 });
      return { vectors: [[0.1, 0.2, 0.3]], usage: { promptTokens: 3, totalTokens: 3 } };
    });
    const usage = jest.fn();
    const result = await searchVectorStores({ ...base, rankingOptions: { rerank: false }, usage });
    expect(rerankMock).not.toHaveBeenCalled();
    expect(result.mode).toBe('rrf_only');
    expect(result.data.map((h) => h.fileId)).toEqual(['file-0', 'file-1', 'file-2']);
    expect(result.data.map((h) => h.score)).toEqual(cands.map((c) => c.score));
    expect(usage.mock.calls.map((c: any[]) => c[0].endpoint)).toEqual(['file_search/search']);
  });

  it('still applies score_threshold, against the RRF score', async () => {
    recallCandidatesMock.mockResolvedValue([candidate(0, { score: 0.03 }), candidate(1, { score: 0.01 })]);
    const result = await searchVectorStores({ ...base, rankingOptions: { rerank: false, scoreThreshold: 0.02 } });
    expect(rerankMock).not.toHaveBeenCalled();
    expect(result.data.map((h) => h.fileId)).toEqual(['file-0']);
  });
});

// ---------------------------------------------------------------------------
// query as an array: each query embedded and recalled, the lists fused by RRF
// ---------------------------------------------------------------------------
describe('several queries (query as an array)', () => {
  const q1 = 'capital of france';
  const q2 = 'largest city in france';

  beforeEach(() => {
    embedMock.mockImplementation(async (texts: any) => ({
      vectors: (texts as string[]).map((_t, i) => [i + 1, 0, 0]), usage: { promptTokens: 2, totalTokens: 2 },
    }));
    recallCandidatesMock.mockImplementation(async (opts: any) => (
      opts.queryText === q1 ? [candidate(0), candidate(1)] : [candidate(1), candidate(2)]));
  });

  it('embeds every query in ONE request per model, and recalls once per query with its own text and vector', async () => {
    mockRerankUnavailable();
    await searchVectorStores({ ...base, query: [q1, q2] });
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock.mock.calls[0][0]).toEqual([q1, q2]);
    expect(recallCandidatesMock).toHaveBeenCalledTimes(2);
    const [first, second] = recallCandidatesMock.mock.calls.map((c) => c[0]);
    expect(first.queryText).toBe(q1);
    expect(first.vectorArms).toEqual([{ storeIds: ['vs_owned'], queryEmbedding: [1, 0, 0], model: 'text-embedding-3-large' }]);
    expect(second.queryText).toBe(q2);
    expect(second.vectorArms).toEqual([{ storeIds: ['vs_owned'], queryEmbedding: [2, 0, 0], model: 'text-embedding-3-large' }]);
    expect(touchStoreActivityMock).toHaveBeenCalledTimes(1);
  });

  it('fuses the per-query lists by RRF (k = hybrid.rrfK): a chunk both queries found ranks first', async () => {
    mockRerankUnavailable();
    const result = await searchVectorStores({ ...base, query: [q1, q2] });
    expect(result.mode).toBe('rrf_only');
    expect(result.data.map((h) => h.fileId)).toEqual(['file-1', 'file-0', 'file-2']);
    expect(result.data[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(result.data[1].score).toBeCloseTo(1 / 61, 12);
  });

  it('reranks the fused candidates ONCE, against all the queries', async () => {
    mockRerankReturns([{ index: 2, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.5 }, { index: 1, relevanceScore: 0.1 }]);
    const result = await searchVectorStores({ ...base, query: [q1, q2] });
    expect(rerankMock).toHaveBeenCalledTimes(1);
    expect(rerankMock.mock.calls[0][0]).toBe(`${q1}\n${q2}`);
    expect(rerankMock.mock.calls[0][1]).toEqual(['chunk text 1', 'chunk text 0', 'chunk text 2']);
    expect(result.data.map((h) => h.fileId)).toEqual(['file-2', 'file-1', 'file-0']);
  });

  it('caps the fused candidates at hybrid.candidates before the rerank', async () => {
    mockConfig.hybrid.candidates = 2;
    mockRerankUnavailable();
    const result = await searchVectorStores({ ...base, query: [q1, q2] });
    expect(result.data.map((h) => h.fileId)).toEqual(['file-1', 'file-0']);
  });

  it('reports every query searched, rewritten one by one when rewriting is on', async () => {
    rewriteMock.mockImplementation(async (q: string) => `rewritten ${q}`);
    mockRerankUnavailable();
    const result = await searchVectorStores({ ...base, query: [q1, q2], rewriteQuery: true });
    expect(rewriteMock).toHaveBeenCalledTimes(2);
    expect(result.searchQueries).toEqual([`rewritten ${q1}`, `rewritten ${q2}`]);
    expect(embedMock.mock.calls[0][0]).toEqual([`rewritten ${q1}`, `rewritten ${q2}`]);
  });

  it('a single string still searches exactly as before: one recall, searchQueries of one', async () => {
    mockRerankUnavailable();
    recallCandidatesMock.mockResolvedValue(makeCandidates(2));
    const result = await searchVectorStores(base);
    expect(recallCandidatesMock).toHaveBeenCalledTimes(1);
    expect(result.searchQuery).toBe(q1);
    expect(result.searchQueries).toEqual([q1]);
    expect(result.data.map((h) => h.score)).toEqual(makeCandidates(2).map((c) => c.score));
  });

  it('writes no teacher-label row for several queries (one row describes one query), and still one for a single query', async () => {
    mockTeacherLogging({ enabled: true });
    const spy = jest.spyOn(teacherLogger, 'record');
    mockRerankUnavailable();
    await searchVectorStores({ ...base, query: [q1, q2] });
    expect(spy).not.toHaveBeenCalled();
    mockRerankUnavailable();
    await searchVectorStores({ ...base, query: [q1] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].queryText).toBe(q1);
  });

  it('bounds the total length of the queries like a single query, before any database or network call', async () => {
    await expect(searchVectorStores({ ...base, query: ['x'.repeat(5000), 'y'.repeat(5000)] }))
      .rejects.toThrow(/at most 8192 characters/);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
  });
});

describe('POST /vector_stores/{id}/search — query arrays and ranking_options.ranker (controller)', () => {
  function makeRes(): any {
    const res: any = { headersSent: false, statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
  }
  function req(body: Record<string, unknown>): any {
    return { headers: {}, params: { id: 'vs_owned' }, query: {}, body, apiKeyInfo: { email: 'owner@example.com' } };
  }

  it('searches a query array and reports every query in search_query', async () => {
    mockRerankUnavailable();
    const res = makeRes();
    await searchVectorStore(req({ query: ['capital of france', 'paris population'] }), res, jest.fn() as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.search_query).toEqual(['capital of france', 'paris population']);
    expect(recallCandidatesMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an empty array', []],
    ['a non-string element', ['ok', 7]],
    ['an empty-string element', ['ok', '']],
    ['more than 10 queries', Array.from({ length: 11 }, (_, i) => `q${i}`)],
  ])('400s invalid_query for %s, before any search', async (_label, query) => {
    const res = makeRes();
    await searchVectorStore(req({ query }), res, jest.fn() as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_query');
    expect(recallCandidatesMock).not.toHaveBeenCalled();
  });

  it('400s query_too_long when the queries together exceed the bound', async () => {
    const res = makeRes();
    await searchVectorStore(req({ query: ['x'.repeat(4097), 'y'.repeat(4096)] }), res, jest.fn() as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('query_too_long');
  });

  it('ranker "none" skips the rerank: no call and no rerank usage', async () => {
    const res = makeRes();
    await searchVectorStore(req({ query: 'x', ranking_options: { ranker: 'none' } }), res, jest.fn() as any);
    expect(res.statusCode).toBe(200);
    expect(rerankMock).not.toHaveBeenCalled();
    expect(recallCandidatesMock.mock.calls[0][0].hybridWeights).toBeUndefined();
  });

  it.each(['auto', 'default-2024-11-15', 'default_2024_08_21', null])('ranker %p reranks as without it', async (ranker) => {
    mockRerankAvailable(3);
    const res = makeRes();
    await searchVectorStore(req({ query: 'x', ranking_options: { ranker } }), res, jest.fn() as any);
    expect(res.statusCode).toBe(200);
    expect(rerankMock).toHaveBeenCalledTimes(1);
  });

  it.each([['an unknown name', 'fastest'], ['a non-string', 1], ['an empty string', '']])(
    '400s invalid_ranker for %s', async (_label, ranker) => {
      const res = makeRes();
      await searchVectorStore(req({ query: 'x', ranking_options: { ranker } }), res, jest.fn() as any);
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('invalid_ranker');
      expect(rerankMock).not.toHaveBeenCalled();
    },
  );

  it('accepts the guide\'s rrf_* weight spellings, and 400s both spellings of one weight', async () => {
    mockRerankAvailable(3);
    const ok = makeRes();
    await searchVectorStore(
      req({ query: 'x', ranking_options: { hybrid_search: { rrf_embedding_weight: 0.6, rrf_text_weight: 0.4 } } }), ok, jest.fn() as any,
    );
    expect(ok.statusCode).toBe(200);
    expect(recallCandidatesMock.mock.calls.at(-1)![0].hybridWeights).toEqual({ embedding: 0.6, text: 0.4 });

    const both = makeRes();
    await searchVectorStore(
      req({ query: 'x', ranking_options: { hybrid_search: { text_weight: 1, rrf_text_weight: 1 } } }), both, jest.fn() as any,
    );
    expect(both.statusCode).toBe(400);
    expect(both.body.error.code).toBe('invalid_hybrid_search');
  });
});
