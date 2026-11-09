// Reciprocal Rank Fusion — merges N independently-ranked lists (e.g. a pgvector
// cosine ranking and a Postgres full-text `ts_rank` ranking) into one ranking,
// without needing the underlying scores from either source to be comparable to
// each other. Pure function: no I/O, no database, safe to unit test in isolation
// from recall's SQL.
//
// Formula: for each list a document appears in, it earns weight/(k+rank), rank
// starting at 1 (the top of that list) and weight that list's weight (1 when no
// weights are given, which is plain 1/(k+rank)); a document's fused score is the
// sum of its contributions across every list it appears in (zero from lists it's
// absent from). A list weighted 0 is left out entirely: its ids neither score
// nor appear in the output unless another list holds them. Ties are broken
// deterministically by first-seen order across the weighted input lists (in
// list order, then position within a list) rather than relying on the host
// engine's sort stability or Map iteration order being treated as an
// implementation detail — two calls with identical input must
// produce identical output.
export interface FusedResult {
  id: string;
  score: number;
}

export interface HybridWeights {
  embedding: number;
  text: number;
}

export type HybridWeightsParse =
  | { ok: true; weights?: HybridWeights }
  | { ok: false; message: string };

/**
 * Validates OpenAI's `ranking_options.hybrid_search` (`embedding_weight`, `text_weight`).
 * Absent -> no weights (fusion stays unweighted, exactly as before). A missing field
 * defaults to 1; each given value must be a finite number >= 0, and not both 0.
 * OpenAI's retrieval guide spells the fields `rrf_embedding_weight` / `rrf_text_weight`; both
 * spellings are accepted, and both spellings of ONE weight together are refused as ambiguous.
 * Shared by the REST route (400) and the Responses tool translation.
 */
export function parseHybridSearch(raw: unknown): HybridWeightsParse {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'ranking_options.hybrid_search must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const read = (field: 'embedding_weight' | 'text_weight'): number | string => {
    const alias = `rrf_${field}`;
    if (obj[field] !== undefined && obj[alias] !== undefined) {
      return `ranking_options.hybrid_search: give one of ${field} and ${alias}, not both`;
    }
    const name = obj[field] !== undefined ? field : alias;
    const v = obj[name];
    if (v === undefined) return 1;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return `ranking_options.hybrid_search.${name} must be a number greater than or equal to 0`;
    }
    return v;
  };
  const embedding = read('embedding_weight');
  if (typeof embedding === 'string') return { ok: false, message: embedding };
  const text = read('text_weight');
  if (typeof text === 'string') return { ok: false, message: text };
  if (embedding === 0 && text === 0) {
    return { ok: false, message: 'ranking_options.hybrid_search.embedding_weight and text_weight must not both be 0' };
  }
  return { ok: true, weights: { embedding, text } };
}

/** `weights[i]` scales `rankings[i]`'s contributions; a missing entry means 1, a 0 drops the list. */
export function fuseRrf(rankings: string[][], k: number, weights?: number[]): FusedResult[] {
  const scores = new Map<string, number>();
  const firstSeenRank = new Map<string, number>();
  let seenCounter = 0;

  rankings.forEach((ranking, listIndex) => {
    const weight = weights?.[listIndex] ?? 1;
    if (weight === 0) return;
    ranking.forEach((id, i) => {
      const rank = i + 1; // rank starts at 1, not 0
      const contribution = weight === 1 ? 1 / (k + rank) : weight / (k + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
      if (!firstSeenRank.has(id)) {
        firstSeenRank.set(id, seenCounter);
      }
      seenCounter += 1;
    });
  });

  const results: FusedResult[] = Array.from(scores.entries()).map(([id, score]) => ({ id, score }));

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break: whichever id was encountered first while
    // walking the input lists wins, regardless of Map iteration order or
    // Array.sort's stability guarantees on any particular JS engine.
    return firstSeenRank.get(a.id)! - firstSeenRank.get(b.id)!;
  });

  return results;
}
