/**
 * The two-stage `file_search` retrieval entry point: Task 10's hybrid recall
 * (`recallCandidates` — pgvector cosine + full-text RRF fusion) narrowed by
 * the reranker into an OpenAI-shaped `vector_store.search_results.page`.
 * `searchVectorStores` is the single entry point Plan 2's Responses
 * `file_search` tool plugin will call; `vectorStoresController.ts`'s
 * `POST /vector_stores/{id}/search` handler is its only other caller here.
 *
 * STAGE 1 (recall): embed the (optionally rewritten) query once per embedding
 * model among the searched stores (each store's own model), then
 * `recallCandidates` returns up to `hybrid.candidates` chunks fused by RRF
 * across one vector arm per model and the lexical arm. Several queries (`query` as an array) are
 * embedded in the same request, recalled one by one, and their candidate lists fused by RRF.
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
 * PARENT SECTIONS (`file_search.parent_sections`): on the surfaces its `scope` names (the
 * Responses tool by default; every search with 'all'; none with 'off'), a structured hit's
 * content is its section — at most `max_tokens` tokens around the matched chunk, see
 * parentSections.ts — and several hits in one section collapse into the best-scored one, the
 * freed places refilled from the ranked list. Static and legacy chunks are returned as chunks.
 * The REST search keeps returning chunks by default (OpenAI's search returns chunks).
 *
 * OWNERSHIP: enforced by an explicit `SELECT ... WHERE vs.id = ANY($1) AND
 * <storeAccessPredicateSql>` before anything else runs — NOT
 * inferred from `recallCandidates` returning zero rows for that store,
 * which cannot by itself distinguish "unauthorized" from "authorized but
 * genuinely no matching chunks". Any requested store id absent from that
 * result throws `SearchStoreNotFoundError` (404, never 403), keeping store
 * ids non-enumerable exactly like every other file_search endpoint.
 */
import { getDefaultLogger } from '@libs/logger';
import { getFileSearchConfig } from '../services/configService';
import { getPool } from './db';
import { embed, EmbeddingModelUnavailableError } from './embedder';
import { rerank } from './reranker';
import { rewriteSearchQuery } from './queryRewriter';
import * as teacherLogger from './teacherLogger';
import type { SearchUsage } from './usage';
import {
  recallCandidates,
  touchStoreActivity,
  assertStoreDimension,
  assertStoreNotExpired,
  CandidateChunk,
  candidateId,
  VectorArm,
} from './repository';
import { storeAccessPredicateSql } from './recallSql';
import { fuseRrf, HybridWeights } from './rrf';
import { loadParentSections, parentSectionSettings, ParentHit, ParentSection } from './parentSections';
import type { PageSpan } from './pages';

const logger = getDefaultLogger();

export interface SearchOptions {
  storeIds: string[];
  /** One query, or several (OpenAI's `query: string | string[]`): each is embedded and recalled on
   *  its own, the per-query candidate lists are fused by RRF, and the fused set is reranked once
   *  against all the queries (joined by newlines). */
  query: string | string[];
  ownerEmail: string;
  /** The caller's team ids, from this request's validation: stores shared with one of them are
   *  searchable too (recallSql.ts storeAccessPredicateSql). Absent = none. */
  teamIds?: readonly string[];
  maxNumResults?: number;
  filters?: unknown;
  /** `rerank: false` is OpenAI's `ranking_options.ranker: "none"`: no rerank call (and no rerank
   *  cost); the RRF order and scores are returned as when no reranker is available. */
  rankingOptions?: { scoreThreshold?: number; hybridWeights?: HybridWeights; rerank?: false };
  rewriteQuery?: boolean;
  /** Receives every billed call this search makes: one `file_search/search` record per
   *  query-embedding request, as it succeeds (so a search that fails later still reports
   *  it), one `file_search/rerank` record when the reranker billed search units, and one
   *  `file_search/rewrite` record when a query rewrite completed. */
  usage?: (u: SearchUsage) => void;
  /** Who is searching: the Responses file_search tool, or the REST search (default). Decides
   *  with `parent_sections.scope` whether hits come back as parent sections. */
  surface?: SearchSurface;
}

export type SearchSurface = 'tool' | 'api';

/** What the reranker reads per candidate: its stored context, a blank line and its text where it has
 *  a context ('context_and_text', the default of `hybrid.rerank.input`), or its text only. */
export type RerankInput = 'text' | 'context_and_text';
/** The evaluation runner's override of `hybrid.rerank.input`; null = the configuration decides. */
let rerankInputOverride: RerankInput | null = null;
export function setRerankInput(input: RerankInput | null): void {
  if (input !== null && input !== 'text' && input !== 'context_and_text') throw new Error(`unknown rerank input ${String(input)}`);
  rerankInputOverride = input;
}
function rerankTextOf(c: CandidateChunk, input: RerankInput): string {
  return input === 'context_and_text' && c.context ? `${c.context}\n\n${c.text}` : c.text;
}

export interface SearchHit {
  fileId: string;
  filename: string;
  score: number;
  attributes: Record<string, unknown>;
  content: Array<{ type: 'text'; text: string }>;
  /** The pages the content spans (first and last), for a file with pages; absent otherwise. An
   *  extension of OpenAI's shapes: never in `attributes`, which are the file's own. */
  pages?: PageSpan;
}

export interface SearchResponse {
  object: 'vector_store.search_results.page';
  /** The query searched (after an optional rewrite); several queries joined by newlines. */
  searchQuery: string;
  /** Every query searched, in request order (after an optional rewrite): OpenAI's `search_query`. */
  searchQueries: string[];
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

/** Thrown when the embedding model a store is pinned to is no longer served (plan
 *  Decision 13): the store cannot be searched until it is re-embedded, and nothing falls
 *  back to another model. Callers map it to HTTP 409 with `code`. The message carries
 *  the store ids and the model name — both identifiers, never caller content. */
export class StoreModelUnavailableError extends Error {
  readonly status = 409;
  /** The wire `code` every surface emits — the HTTP routes via vectorStoresController's
   *  handleKnownError and the Responses file_search tool via its errorCodeFor. */
  readonly code = 'store_model_unavailable';
  /** The first affected store; `storeIds` lists all of them. */
  readonly storeId: string;
  constructor(readonly storeIds: string[], readonly model: string) {
    super(
      `${storeIds.length === 1 ? 'Vector store' : 'Vector stores'} ${storeIds.join(', ')} `
      + `${storeIds.length === 1 ? 'uses' : 'use'} the embedding model '${model}', which is no longer available. `
      + 'Re-embed the store to restore search.',
    );
    this.name = 'StoreModelUnavailableError';
    this.storeId = storeIds[0];
  }
}

/**
 * OpenAI's `ranking_options.ranker` values, shared by the REST search and the Responses tool: `none`
 * skips the rerank; `auto`, `default-2024-11-15` and the Assistants v2 spelling `default_2024_08_21`
 * rerank as an absent ranker does (this deployment has one reranker, see reranker.ts). `null` counts
 * as absent; any other value is refused.
 */
export const SEARCH_RANKERS: readonly string[] = ['none', 'auto', 'default-2024-11-15', 'default_2024_08_21'];

const MAX_QUERY_LENGTH = 8192;

/** Thrown for a `query` exceeding `MAX_QUERY_LENGTH`. OpenAI does not
 *  document an exact bound for this field; this exists to protect the
 *  downstream `rewriteSearchQuery`/`embed` calls from an unbounded payload,
 *  not to enforce a spec-mandated value — chosen generously, far beyond any
 *  reasonable search query. Callers should map this to HTTP 400. */
export class SearchQueryTooLongError extends Error {
  readonly status = 400;
  constructor(length: number, total = false) {
    super(`query must be at most ${MAX_QUERY_LENGTH} characters${total ? ' in total' : ''}, got ${length}`);
    this.name = 'SearchQueryTooLongError';
  }
}

/** OpenAI's bound for a search's `max_num_results`: "between 1 and 50 inclusive"
 *  (openai-python types/vector_store_search_params.py). */
export const MIN_MAX_NUM_RESULTS = 1;
export const MAX_MAX_NUM_RESULTS = 50;
const DEFAULT_MAX_NUM_RESULTS = 10;

/** Clamps to 1..50, defaulting to 10 for anything not a finite number. Both callers pass a value
 *  already checked against that range — POST /vector_stores/{id}/search and the Responses
 *  file_search tool answer 400 outside it, as OpenAI does — so this is a backstop, not a policy. */
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

/** A structured chunk's section key; null for a static or legacy chunk (no section). */
function sectionKey(c: CandidateChunk): string | null {
  if (c.section === undefined || c.generation === undefined) return null;
  return JSON.stringify([c.storeId, c.fileId, c.generation, c.section]);
}

/** The first `max` of `ranked` (best first), keeping one hit per section — the best one — so a
 *  section is returned once; the places this frees go to the next ranked hits. */
function collapseSections(ranked: RankedCandidate[], max: number): RankedCandidate[] {
  const out: RankedCandidate[] = [];
  const seen = new Set<string>();
  for (const r of ranked) {
    if (out.length >= max) break;
    const key = sectionKey(r.candidate);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

/** Each selected hit's parent section, or undefined to return its chunk. */
async function parentTextsOf(selected: RankedCandidate[], maxTokens: number): Promise<Array<ParentSection | undefined>> {
  const hits: ParentHit[] = [];
  const at: number[] = [];
  selected.forEach(({ candidate: c }, i) => {
    if (c.section === undefined || c.generation === undefined) return;
    hits.push({
      storeId: c.storeId, fileId: c.fileId, generation: c.generation, section: c.section, ord: c.ord,
      sectionOffset: c.sectionOffset ?? 0, text: c.text, ...(c.pages ? { pages: c.pages } : {}),
    });
    at.push(i);
  });
  const out: Array<ParentSection | undefined> = selected.map(() => undefined);
  if (hits.length === 0) return out;
  const parents = await loadParentSections(hits, maxTokens);
  parents.forEach((parent, k) => { if (parent !== null) out[at[k]] = parent; });
  return out;
}

/**
 * Several queries' candidate lists fused into one by RRF (rrf.ts, `k` = `hybrid.rrf_k`): a chunk
 * found by several queries rises, each keeps its first-seen row, and its score becomes the fused one
 * (what rrf_only mode returns). Capped at `limit` (`hybrid.candidates`), the reranker's budget.
 */
function fuseQueryLists(lists: CandidateChunk[][], k: number, limit: number): CandidateChunk[] {
  const byId = new Map<string, CandidateChunk>();
  const rankings = lists.map((list) => list.map((c) => {
    const id = candidateId(c.storeId, c.fileId, c.ord);
    if (!byId.has(id)) byId.set(id, c);
    return id;
  }));
  return fuseRrf(rankings, k).slice(0, limit).map(({ id, score }) => ({ ...byId.get(id)!, score }));
}

/** The rewritten query, or the query itself should the rewrite throw. */
async function rewriteOrOriginal(query: string, usage: SearchOptions['usage']): Promise<string> {
  // queryRewriter.ts's own contract is "never throws" — this try/catch is
  // deliberate defence-in-depth, not redundant: `rewrite_query` now defaults
  // to OFF for new installs, but every install that predates that flip keeps
  // `true` (neither deployment shape merges new config keys into an existing
  // configuration), so a regression in that contract would still be a single
  // point of failure for every search those installs make.
  try {
    return await rewriteSearchQuery(query, usage);
  } catch (error: any) {
    logger.debug('FileSearch', `Query rewrite threw unexpectedly; falling back to the original query: ${error?.message}`);
    return query;
  }
}

/**
 * Runs the two-stage search described in this module's header and returns
 * an OpenAI-shaped result page. Throws `SearchStoreNotFoundError` (404) for
 * any unauthorized/nonexistent store id, `SearchQueryTooLongError` (400)
 * for an oversized `query`, `RecallInputError` (400, thrown by
 * `recallCandidates`) for a malformed/oversized attribute filter,
 * `StoreDimensionMismatchError` (409) for a store whose pinned
 * `embedding_dim` has drifted from the live embedding configuration, and
 * `StoreExpiredError` (409) for a store whose `status` is `'expired'`, and
 * `StoreModelUnavailableError` (409) for a store whose embedding model is no
 * longer served.
 */
export async function searchVectorStores(opts: SearchOptions): Promise<SearchResponse> {
  // process.hrtime.bigint() (monotonic, unaffected by clock adjustment) —
  // see the `ms` helper above. t0 anchors totalLatencyMs.
  const t0 = process.hrtime.bigint();
  const config = getFileSearchConfig();
  const pool = getPool();
  if (!pool) throw new Error('searchVectorStores: file_search database is not configured');

  const queries = typeof opts.query === 'string' ? [opts.query] : opts.query;
  // Several queries share the one bound: their total length.
  const queryLength = queries.reduce((sum, q) => sum + q.length, 0);
  if (queryLength > MAX_QUERY_LENGTH) {
    throw new SearchQueryTooLongError(queryLength, queries.length > 1);
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
  // dimension-mismatched query (storeValidation.ts's section comment calls
  // this out by name as a site assertStoreDimension must guard), and an
  // EXPIRED store 409s rather than being searched (and having its
  // last_active_at/expires_at slid forward forever — see
  // assertStoreNotExpired's own doc comment for why that must not happen).
  //
  // The predicate itself is `storeAccessPredicateSql`, the ONE ownership
  // rule in this codebase — not a second literal that happens to agree with
  // recallCandidates' today. "Independent of recallCandidates' predicate"
  // above means independent of its RESULT (zero rows is not a permission
  // answer), not a second rule: those are different claims, and only the
  // first one is wanted. The table is aliased `vs` purely so the shared
  // fragment, which is written against buildArm's `vs` alias, drops in
  // unchanged; `$1`/`$2` are bound in the same positions it expects, the
  // caller's team ids at `$3`.
  const { rows: ownedStores } = await pool.query<{
    id: string; embedding_dim: number; embedding_model: string; status: string;
  }>(
    `SELECT vs.id, vs.embedding_dim, vs.embedding_model, vs.status FROM vector_stores vs
      WHERE vs.id = ANY($1) AND ${storeAccessPredicateSql('$3')}`,
    [storeIds, opts.ownerEmail, opts.teamIds ?? []],
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
  // Each query is rewritten on its own (one rewrite call each), as a single query is.
  const searchQueries = rewriteEnabled
    ? await Promise.all(queries.map((q) => rewriteOrOriginal(q, opts.usage)))
    : queries;
  const searchQuery = searchQueries.join('\n');
  const originalQuery = queries.join('\n');
  // One model per store (plan Decisions 2 and 7): a store's chunks were embedded
  // with ITS model, so the query is embedded once per distinct model among the
  // searched stores and each vector is compared only with its own stores' chunks.
  // Groups follow the order of `storeIds`. The dimension is the store's, which
  // assertStoreDimension above already pinned to the configured one.
  const groups: Array<{ model: string; dimensions: number; storeIds: string[] }> = [];
  for (const id of storeIds) {
    const store = ownedById.get(id)!;
    const group = groups.find((g) => g.model === store.embedding_model);
    if (group) group.storeIds.push(id);
    else groups.push({ model: store.embedding_model, dimensions: store.embedding_dim, storeIds: [id] });
  }

  // 'query' is call-site intent only — see embedder.ts's own doc comment on
  // why input_type is never actually placed on the wire.
  const tEmbedStart = process.hrtime.bigint();
  // One embedding request per model group carries every query; `vectors[i]` is query i's.
  const groupVectors: Array<{ storeIds: string[]; model: string; vectors: number[][] }> = await Promise.all(groups.map(async (group) => {
    try {
      const target = { model: group.model, dimensions: group.dimensions };
      const sink = opts.usage;
      // Recorded inside this mapper, per request as embed() reports it: a group that
      // succeeded is billed even when another group (or recall, later) fails the search.
      const { vectors } = sink
        ? await embed(searchQueries, 'query', target, {
          onUsage: (u) => sink({
            endpoint: 'file_search/search', model: group.model, inputTokens: u.promptTokens,
            unit: 'tokens', responseTime: u.elapsedMs,
          }),
        })
        : await embed(searchQueries, 'query', target);
      return { storeIds: group.storeIds, model: group.model, vectors };
    } catch (error) {
      // No fallback to another model (Decision 13): its vectors would be compared
      // with this store's chunks and rank nonsense. Only the embedder's own
      // "model not served" classification is translated; anything else is as it was.
      if (error instanceof EmbeddingModelUnavailableError) {
        throw new StoreModelUnavailableError(group.storeIds, group.model);
      }
      throw error;
    }
  }));
  const tEmbedEnd = process.hrtime.bigint();
  const embedLatencyMs = ms(tEmbedStart, tEmbedEnd);

  // One recall per query, one after the other (each is a pooled connection). The model goes
  // along with each vector so recall compares it only with stores still on it in recall's own
  // snapshot (a re-embed may switch a store in between).
  const recalled: CandidateChunk[][] = [];
  for (const [i, queryText] of searchQueries.entries()) {
    const vectorArms: VectorArm[] = groupVectors.map((g) => ({ storeIds: g.storeIds, queryEmbedding: g.vectors[i], model: g.model }));
    // eslint-disable-next-line no-await-in-loop
    recalled.push(await recallCandidates({
      storeIds,
      ownerEmail: opts.ownerEmail,
      teamIds: opts.teamIds ?? [],
      queryText,
      vectorArms,
      filter: opts.filters,
      limit: config.hybrid.candidates,
      hybridWeights: opts.rankingOptions?.hybridWeights,
    }));
  }
  const candidates = recalled.length === 1 ? recalled[0] : fuseQueryLists(recalled, config.hybrid.rrfK, config.hybrid.candidates);

  // Touch last_active_at (and, transitively, slide expires_at) regardless of
  // hit count — a zero-result search is still activity per the spec's
  // "touched on every search" wording.
  await touchStoreActivity(storeIds);

  if (candidates.length === 0) {
    return {
      object: 'vector_store.search_results.page',
      searchQuery,
      searchQueries,
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
  const configured = config.hybrid.rerank.input === 'text' ? 'text' : 'context_and_text';
  const rerankInput = rerankInputOverride ?? configured;
  // `ranker: "none"`: the caller declined the rerank (its latency and its cost); RRF decides.
  const reranked = opts.rankingOptions?.rerank === false
    ? null
    : await rerank(searchQuery, candidates.map((c) => rerankTextOf(c, rerankInput)), candidates.length);
  const tRerankEnd = process.hrtime.bigint();
  const hits = reranked?.hits;

  // Search units are optional on the reranker's answer; only a positive count is billed.
  const searchUnits = reranked?.searchUnits;
  if (opts.usage && typeof searchUnits === 'number' && Number.isFinite(searchUnits) && searchUnits > 0) {
    try {
      opts.usage({
        endpoint: 'file_search/rerank', model: config.hybrid.rerank.model, inputTokens: searchUnits,
        unit: 'units', responseTime: ms(tRerankStart, tRerankEnd),
      });
    } catch (error: any) {
      logger.warn('FileSearch', `Rerank usage sink failed and was ignored: ${error?.message}`);
    }
  }

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

  const parents = parentSectionSettings();
  const withParents = parents.scope === 'all' || (parents.scope === 'tool' && opts.surface === 'tool');
  const truncated = withParents ? collapseSections(filtered, maxNumResults) : filtered.slice(0, maxNumResults);
  const parentTexts = withParents ? await parentTextsOf(truncated, parents.maxTokens) : [];

  const data: SearchHit[] = truncated.map(({ candidate, score }, i) => {
    const parent = parentTexts[i];
    // A parent's own pages; a chunk's stored ones. A parent of a hit with pages always has them.
    const pages = parent ? parent.pages : candidate.pages;
    return {
      fileId: candidate.fileId,
      filename: candidate.filename,
      score,
      attributes: candidate.attributes,
      content: [{ type: 'text', text: parent?.text ?? candidate.text }],
      ...(pages ? { pages } : {}),
    };
  });

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

  // A teacher-label row describes ONE query against its candidates (query_text, the recall rrf_score
  // and arm ranks). Several queries fused into one candidate set would mix meanings and corrupt the
  // reranker dataset, so a multi-query search is not logged.
  if (queries.length === 1) {
    // Fire-and-forget: never awaited, never allowed to affect the response.
    // `record` itself is synchronous and swallows everything downstream — see
    // teacherLogger.ts's own doc comment for the isolation guarantee. This
    // try/catch is defence-in-depth, not redundant: the call site must not
    // *depend* on record()'s own guarantee never regressing — a synchronous
    // throw here must never reach the caller of searchVectorStores.
    try {
      teacherLogger.record({
        queryText: originalQuery,
        queryRewritten: searchQuery !== originalQuery ? searchQuery : undefined,
        rewriteUsed: searchQuery !== originalQuery,
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
        // The models the query was actually embedded with — the stores' own, not
        // the configured one; comma-joined in group order when the stores differ.
        embeddingModel: groups.map((g) => g.model).join(','),
        embeddingDim: groups[0].dimensions,
        candidatesRequested: config.hybrid.candidates,
        rrfK: config.hybrid.rrfK,
        lexicalEnabled: config.hybrid.lexicalEnabled,
        lexicalQuery: config.hybrid.lexicalQuery,
        hybridWeights: opts.rankingOptions?.hybridWeights,
        topK: maxNumResults,
        scoreThreshold: opts.rankingOptions?.scoreThreshold,
        embedLatencyMs,
        rerankLatencyMs: reranked ? ms(tRerankStart, tRerankEnd) : undefined,
        totalLatencyMs: ms(t0, process.hrtime.bigint()),
      });
    } catch (error: any) {
      logger.debug('FileSearch', `Teacher-label logging threw unexpectedly and was ignored: ${error?.message}`);
    }
  }

  return {
    object: 'vector_store.search_results.page',
    searchQuery,
    searchQueries,
    data,
    hasMore: false,
    nextPage: null,
    mode,
  };
}
