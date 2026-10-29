// The shapes recall takes and returns, the columns every arm selects and the chunk key fusion uses
// (split out of repository.ts, which re-exports the public ones).
import type { HybridWeights } from './rrf';
import type { PageSpan } from './pages';

export interface RecallOptions {
  /** Vector store ids the search is scoped to. Every id not owned by
   *  `ownerEmail`, not `is_shared` and not shared with one of `teamIds` yields no rows for that store. */
  storeIds: string[];
  ownerEmail: string;
  /** The caller's team ids, from this request's validation (recallSql.ts storeAccessPredicateSql).
   *  Absent = none. */
  teamIds?: readonly string[];
  /** Raw query text, used for the lexical (`ts_rank`) ranking. Never logged. */
  queryText: string;
  /** Already-embedded query vector, same dimensionality as the store's
   *  `embedding` column, compared with the chunks of every store in `storeIds`.
   *  Never logged. Pass exactly one of this and `vectorArms`. */
  queryEmbedding?: number[];
  /** One query vector per embedding model (plan Decision 7): each arm's vector is
   *  compared only with the chunks of its own stores, and every arm is fused with the
   *  lexical one by the same RRF. The arms must cover each id in `storeIds` exactly
   *  once. Pass exactly one of this and `queryEmbedding`. */
  vectorArms?: VectorArm[];
  /** An OpenAI-style attribute filter AST, or undefined for no filter. */
  filter?: unknown;
  /** Max candidates to return after fusion. Defaults to `hybrid.candidates`. */
  limit?: number;
  /** OpenAI `hybrid_search` weights for the RRF: `embedding` scales every vector arm,
   *  `text` the lexical one. Undefined = unweighted fusion. */
  hybridWeights?: HybridWeights;
}

/** The query embedded with one model, and the stores pinned to that model. */
export interface VectorArm {
  storeIds: string[];
  queryEmbedding: number[];
  /** The model `queryEmbedding` was embedded with. When given, the arm also requires
   *  `vs.embedding_model` to be that model, read in recall's own snapshot: a re-embed that
   *  switched a store to another model after the query was embedded then yields no vector
   *  hits for that store in this call, never a comparison across two models. */
  model?: string;
}

export interface CandidateChunk {
  storeId: string;
  fileId: string;
  filename: string;
  ord: number;
  text: string;
  attributes: Record<string, unknown>;
  /** The fused RRF score — not a cosine similarity or a ts_rank value. */
  score: number;
  /** Rank (1-based) and raw score from the vector arm, when this chunk was
   *  recalled by it. `vectorScore` is a cosine DISTANCE — lower is better —
   *  never inverted here; the consumer decides how to use it. Undefined when
   *  this chunk was recalled only by the lexical arm. */
  vectorRank?: number;
  vectorScore?: number;
  /** Rank (1-based) and raw `ts_rank` score from the lexical arm, when this
   *  chunk was recalled by it — higher is better. Undefined when this chunk
   *  was recalled only by the vector arm, or when hybrid.lexicalEnabled is
   *  false. */
  lexicalRank?: number;
  lexicalScore?: number;
  /** A structured chunk's generation, section and offset in it (parent-section assembly);
   *  absent for a static or legacy chunk. */
  generation?: number;
  section?: number;
  sectionOffset?: number;
  /** The chunk's stored context, when it has one (never returned to a caller). */
  context?: string;
  /** The pages of the chunk's first and last character; absent for a format without pages. */
  pages?: PageSpan;
}

export interface CandidateRow {
  /** The CTE the row came from: 'vec' (the first vector arm), 'vec1', 'vec2', … or 'lex'. */
  source: string;
  store_id: string;
  file_id: string;
  ord: number;
  text: string;
  attributes: Record<string, unknown> | null;
  filename: string;
  rnk: string; // bigint from ROW_NUMBER() arrives as a string via node-pg
  score: number;
  generation: number;
  section: number | null;
  section_offset: number | null;
  context: string | null;
  page_start: number | null;
  page_end: number | null;
}

/** The columns every arm returns, in the order of each arm's SELECT and of the UNION. */
export const ARM_COLUMNS = 'store_id, file_id, ord, text, attributes, filename, rnk, score, generation, section, section_offset, context, '
  + 'page_start, page_end';

// Composite key uniquely identifying a chunk across both rankings. JSON-encoded
// (rather than a delimiter-joined string) so nothing about store_id/file_id's
// own contents — however they're generated — can forge a collision. Exported
// for teacherLogger.ts, which uses this exact key to test selectedIds
// membership — deliberately not a second, independently-defined key format.
export function candidateId(storeId: string, fileId: string, ord: number): string {
  return JSON.stringify([storeId, fileId, ord]);
}
