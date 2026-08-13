/**
 * The two-stage `file_search` retrieval entry point: Task 10's hybrid recall
 * (`recallCandidates` — pgvector cosine + full-text RRF fusion) narrowed by
 * the reranker into an OpenAI-shaped `vector_store.search_results.page`.
 * `searchVectorStores` is the single entry point Plan 2's Responses
 * `file_search` tool plugin will call; `vectorStoresController.ts`'s
 * `POST /vector_stores/{id}/search` handler is its only other caller here.
 *
 * STAGE 1 (recall): embed the (optionally rewritten) query, then
 * `recallCandidates` returns up to `hybrid.candidates` chunks fused by RRF.
 * STAGE 2 (precision): `rerank` scores those candidates against the query
 * with a cross-encoder and returns a calibrated `[0,1]` relevance score —
 * or `null` when no reranker deployment is discoverable / `hybrid.rerank.
 * enabled` is `false`, in which case the database's own RRF ordering is
 * used unchanged. `SearchResponse.mode` records which of the two actually
 * ran, so a live gate exercising this path can prove stage 2 fired rather
 * than silently, greenly, never reaching it — see this module's own
 * `SearchResponse` doc comment. `mode` is internal bookkeeping only: the
 * HTTP endpoint in vectorStoresController.ts must not put it on the wire.
 *
 * OWNERSHIP: enforced by an explicit `SELECT ... WHERE vs.id = ANY($1) AND
 * <STORE_ACCESS_PREDICATE_SQL>` before anything else runs — NOT
 * inferred from `recallCandidates` returning zero rows for that store,
 * which cannot by itself distinguish "unauthorized" from "authorized but
 * genuinely no matching chunks". Any requested store id absent from that
 * result throws `SearchStoreNotFoundError` (404, never 403), keeping store
 * ids non-enumerable exactly like every other file_search endpoint.
 */
import { getDefaultLogger } from '@libs/logger';
import { getFileSearchConfig } from '../services/configService';
import { getPool } from './db';
import { embed } from './embedder';
import { rerank } from './reranker';
import { rewriteSearchQuery } from './queryRewriter';
import * as teacherLogger from './teacherLogger';
import {
  recallCandidates,
  touchStoreActivity,
  assertStoreDimension,
  assertStoreNotExpired,
  CandidateChunk,
  candidateId,
  STORE_ACCESS_PREDICATE_SQL,
} from './repository';

const logger = getDefaultLogger();

export interface SearchOptions {
  storeIds: string[];
  query: string;
  ownerEmail: string;
  maxNumResults?: number;
  filters?: unknown;
  rankingOptions?: { scoreThreshold?: number };
  rewriteQuery?: boolean;
}

export interface SearchHit {
  fileId: string;
  filename: string;
  score: number;
  attributes: Record<string, unknown>;
  content: Array<{ type: 'text'; text: string }>;
}

export interface SearchResponse {
  object: 'vector_store.search_results.page';
  searchQuery: string;
  data: SearchHit[];
  hasMore: boolean;
  nextPage: string | null;
  /** Which retrieval mode actually ran: 'reranked' when the cross-encoder
   *  answered, 'rrf_only' when it was unavailable/disabled and the
   *  database's RRF ordering was used unchanged. Internal only — a live
   *  gate uses this to prove stage 2 genuinely ran rather than silently
   *  degrading; never serialize this onto the HTTP response body, which
   *  follows OpenAI's page shape exactly. */
  mode: 'reranked' | 'rrf_only';
}

/** Thrown when a requested store id does not resolve to a store the caller
 *  owns (or a shared store). Callers must map this to HTTP 404 — never
 *  403 — so store ids stay non-enumerable, matching every other
 *  file_search endpoint's ownership contract. */
export class SearchStoreNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly storeId: string) {
    super(`No such vector store: ${storeId}`);
    this.name = 'SearchStoreNotFoundError';
  }
}

const MAX_QUERY_LENGTH = 8192;

/** Thrown for a `query` exceeding `MAX_QUERY_LENGTH`. OpenAI does not
 *  document an exact bound for this field; this exists to protect the
 *  downstream `rewriteSearchQuery`/`embed` calls from an unbounded payload,
 *  not to enforce a spec-mandated value — chosen generously, far beyond any
 *  reasonable search query. Callers should map this to HTTP 400. */
export class SearchQueryTooLongError extends Error {
  readonly status = 400;
  constructor(length: number) {
    super(`query must be at most ${MAX_QUERY_LENGTH} characters, got ${length}`);
    this.name = 'SearchQueryTooLongError';
  }
}

const MIN_MAX_NUM_RESULTS = 1;
const MAX_MAX_NUM_RESULTS = 50;
const DEFAULT_MAX_NUM_RESULTS = 10;

/** Clamps to 1..50, defaulting to 10 for anything not a finite number —
 *  matches OpenAI's own tolerant-input behaviour on this endpoint rather
 *  than 400ing on an out-of-range value. */
function clampMaxNumResults(input: number | undefined): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_MAX_NUM_RESULTS;
  return Math.min(MAX_MAX_NUM_RESULTS, Math.max(MIN_MAX_NUM_RESULTS, Math.floor(input)));
}

interface RankedCandidate {
  candidate: CandidateChunk;
  score: number;
}

// Monotonic clock for the three latency columns on reranker_search_events:
// Date.now() is wall-clock and can jump backwards/forwards on an NTP
// adjustment, which would corrupt the "is an open reranker faster than
// Cohere?" comparison the teacher-log dataset exists to answer.
function ms(a: bigint, b: bigint): number {
  return Number((b - a) / 1_000_000n);
}

/**
 * Runs the two-stage search described in this module's header and returns
 * an OpenAI-shaped result page. Throws `SearchStoreNotFoundError` (404) for
 * any unauthorized/nonexistent store id, `SearchQueryTooLongError` (400)
 * for an oversized `query`, `RecallInputError` (400, thrown by
 * `recallCandidates`) for a malformed/oversized attribute filter,
 * `StoreDimensionMismatchError` (409) for a store whose pinned
 * `embedding_dim` has drifted from the live embedding configuration, and
 * `StoreExpiredError` (409) for a store whose `status` is `'expired'`.
 */
export async function searchVectorStores(opts: SearchOptions): Promise<SearchResponse> {
  // process.hrtime.bigint() (monotonic, unaffected by clock adjustment) —
  // see the `ms` helper above. t0 anchors totalLatencyMs.
  const t0 = process.hrtime.bigint();
  const config = getFileSearchConfig();
  const pool = getPool();
  if (!pool) throw new Error('searchVectorStores: file_search database is not configured');

  if (opts.query.length > MAX_QUERY_LENGTH) {
    throw new SearchQueryTooLongError(opts.query.length);
  }

  const storeIds = Array.from(new Set(opts.storeIds));
  if (storeIds.length === 0) {
    throw new SearchStoreNotFoundError(opts.storeIds[0] ?? '');
  }

  // Ownership check, INDEPENDENT of recallCandidates's own ownership
  // predicate — see this module's header comment for why that predicate
  // alone can't be used to distinguish "unauthorized" from "authorized but
  // empty". Also fetches each store's pinned embedding_dim and status so a
  // config-drifted store 409s here instead of reaching pgvector as a raw,
  // dimension-mismatched query (repository.ts's own header comment calls
  // this out by name as a site assertStoreDimension must guard), and an
  // EXPIRED store 409s rather than being searched (and having its
  // last_active_at/expires_at slid forward forever — see
  // assertStoreNotExpired's own doc comment for why that must not happen).
  //
  // The predicate itself is `STORE_ACCESS_PREDICATE_SQL`, the ONE ownership
  // rule in this codebase — not a second literal that happens to agree with
  // recallCandidates' today. "Independent of recallCandidates' predicate"
  // above means independent of its RESULT (zero rows is not a permission
  // answer), not a second rule: those are different claims, and only the
  // first one is wanted. The table is aliased `vs` purely so the shared
  // fragment, which is written against buildCte's `vs` alias, drops in
  // unchanged; `$1`/`$2` are bound in the same positions it expects.
  const { rows: ownedStores } = await pool.query<{ id: string; embedding_dim: number; status: string }>(
    `SELECT vs.id, vs.embedding_dim, vs.status FROM vector_stores vs
      WHERE vs.id = ANY($1) AND ${STORE_ACCESS_PREDICATE_SQL}`,
    [storeIds, opts.ownerEmail],
  );
  const ownedById = new Map(ownedStores.map((r) => [r.id, r]));
  const missing = storeIds.find((id) => !ownedById.has(id));
  if (missing) {
    throw new SearchStoreNotFoundError(missing);
  }
  for (const store of ownedStores) {
    assertStoreNotExpired(store);
    // eslint-disable-next-line no-await-in-loop
    await assertStoreDimension(store);
  }

  const maxNumResults = clampMaxNumResults(opts.maxNumResults);
  const rewriteEnabled = opts.rewriteQuery ?? config.rewriteQuery;
  let searchQuery = opts.query;
  if (rewriteEnabled) {
    // queryRewriter.ts's own contract is "never throws" — this try/catch is
    // deliberate defence-in-depth, not redundant: `rewrite_query` now defaults
    // to OFF for new installs, but every install that predates that flip keeps
    // `true` (neither deployment shape merges new config keys into an existing
    // configuration), so a regression in that contract would still be a single
    // point of failure for every search those installs make.
    try {
      searchQuery = await rewriteSearchQuery(opts.query);
    } catch (error: any) {
      logger.debug('FileSearch', `Query rewrite threw unexpectedly; falling back to the original query: ${error?.message}`);
      searchQuery = opts.query;
    }
  }

  // 'query' is call-site intent only — see embedder.ts's own doc comment on
  // why input_type is never actually placed on the wire.
  const tEmbedStart = process.hrtime.bigint();
  const { vectors } = await embed([searchQuery], 'query');
  const tEmbedEnd = process.hrtime.bigint();
  const embedLatencyMs = ms(tEmbedStart, tEmbedEnd);
  const queryEmbedding = vectors[0];

  const candidates = await recallCandidates({
    storeIds,
    ownerEmail: opts.ownerEmail,
    queryText: searchQuery,
    queryEmbedding,
    filter: opts.filters,
    limit: config.hybrid.candidates,
  });

  // Touch last_active_at (and, transitively, slide expires_at) regardless of
  // hit count — a zero-result search is still activity per the spec's
  // "touched on every search" wording.
  await touchStoreActivity(storeIds);

  if (candidates.length === 0) {
    return {
      object: 'vector_store.search_results.page',
      searchQuery,
      data: [],
      hasMore: false,
      nextPage: null,
      mode: 'rrf_only',
    };
  }

  // Request the FULL candidate set back from the reranker (already capped at
  // hybrid.candidates by recallCandidates — never more documents than that
  // are ever sent), not just maxNumResults: score_threshold must be applied
  // against the complete reranked set before truncating to maxNumResults,
  // or a low-scoring result inside the first maxNumResults could crowd out
  // a higher-scoring one ranked just beyond it.
  const tRerankStart = process.hrtime.bigint();
  const reranked = await rerank(searchQuery, candidates.map((c) => c.text), candidates.length);
  const tRerankEnd = process.hrtime.bigint();
  const hits = reranked?.hits;

  let ranked: RankedCandidate[];
  let mode: 'reranked' | 'rrf_only';
  if (hits) {
    mode = 'reranked';
    ranked = hits
      .map((hit) => ({ candidate: candidates[hit.index], score: hit.relevanceScore }))
      .filter((r): r is RankedCandidate => r.candidate !== undefined);
  } else {
    mode = 'rrf_only';
    // The database's own RRF ordering, unchanged — see rrf.ts: these scores
    // are sums of 1/(k+rank), not normalized to [0,1], so score_threshold
    // below is only approximate in this mode (documented on SearchOptions/
    // the design spec, never silently treated as calibrated).
    ranked = candidates.map((c) => ({ candidate: c, score: c.score }));
  }

  const scoreThreshold = opts.rankingOptions?.scoreThreshold;
  const filtered = typeof scoreThreshold === 'number'
    ? ranked.filter((r) => r.score >= scoreThreshold)
    : ranked;

  const truncated = filtered.slice(0, maxNumResults);

  const data: SearchHit[] = truncated.map(({ candidate, score }) => ({
    fileId: candidate.fileId,
    filename: candidate.filename,
    score,
    attributes: candidate.attributes,
    content: [{ type: 'text', text: candidate.text }],
  }));

  logger.debug('FileSearch', 'Search completed', {
    storeCount: storeIds.length,
    candidateCount: candidates.length,
    resultCount: data.length,
    mode,
  });

  // candidateId()s of the hits that survived threshold + top-k truncation —
  // built here, where that filtering already happened, rather than
  // recomputed inside the logger.
  const selectedIds = new Set(
    truncated.map(({ candidate }) => candidateId(candidate.storeId, candidate.fileId, candidate.ord)),
  );

  // Fire-and-forget: never awaited, never allowed to affect the response.
  // `record` itself is synchronous and swallows everything downstream — see
  // teacherLogger.ts's own doc comment for the isolation guarantee. This
  // try/catch is defence-in-depth, not redundant: the call site must not
  // *depend* on record()'s own guarantee never regressing — a synchronous
  // throw here must never reach the caller of searchVectorStores.
  try {
    teacherLogger.record({
      queryText: opts.query,
      queryRewritten: searchQuery !== opts.query ? searchQuery : undefined,
      rewriteUsed: searchQuery !== opts.query,
      // The DEDUPED set built above and passed to recallCandidates — not
      // `opts.storeIds`, which may repeat an id. `store_ids` must record what
      // was actually searched, or an analyst counting stores per event reads
      // the caller's typo rather than the query's real fan-out.
      storeIds,
      ownerEmail: opts.ownerEmail,
      candidates,
      teacher: hits ? hits.map((h) => ({ index: h.index, relevanceScore: h.relevanceScore })) : null,
      selectedIds,
      // Fixed, not config-derived, because there is no provider choice to
      // derive it from: reranker.ts speaks exactly one wire protocol — SAP AI
      // Core's `/rerank` endpoint with Cohere's request/response shape
      // (`relevance_score`, `meta.billed_units.search_units`). `rerank.model`
      // is configurable only because the deployment's model-name string
      // varies within that one provider. Reading a provider name out of
      // config here would invent a degree of freedom the client does not
      // have, and would let the column claim a provider that never produced
      // these labels. Change this string when a second reranker client
      // exists, not before.
      rerankerProvider: hits ? 'cohere' : undefined,
      rerankerModel: hits ? config.hybrid.rerank.model : undefined,
      rerankerSearchUnits: reranked?.searchUnits,
      embeddingModel: config.embeddingModel,
      embeddingDim: config.embeddingDimensions,
      candidatesRequested: config.hybrid.candidates,
      rrfK: config.hybrid.rrfK,
      lexicalEnabled: config.hybrid.lexicalEnabled,
      topK: maxNumResults,
      scoreThreshold: opts.rankingOptions?.scoreThreshold,
      embedLatencyMs,
      rerankLatencyMs: reranked ? ms(tRerankStart, tRerankEnd) : undefined,
      totalLatencyMs: ms(t0, process.hrtime.bigint()),
    });
  } catch (error: any) {
    logger.debug('FileSearch', `Teacher-label logging threw unexpectedly and was ignored: ${error?.message}`);
  }

  return {
    object: 'vector_store.search_results.page',
    searchQuery,
    data,
    hasMore: false,
    nextPage: null,
    mode,
  };
}
