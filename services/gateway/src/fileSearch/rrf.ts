// Reciprocal Rank Fusion — merges N independently-ranked lists (e.g. a pgvector
// cosine ranking and a Postgres full-text `ts_rank` ranking) into one ranking,
// without needing the underlying scores from either source to be comparable to
// each other. Pure function: no I/O, no database, safe to unit test in isolation
// from repository.ts's SQL.
//
// Formula: for each list a document appears in, it earns 1/(k+rank), rank
// starting at 1 (the top of that list); a document's fused score is the sum of
// its contributions across every list it appears in (zero from lists it's
// absent from). Ties are broken deterministically by first-seen order across
// the input lists (in list order, then position within a list) rather than
// relying on the host engine's sort stability or Map iteration order being
// treated as an implementation detail — two calls with identical input must
// produce identical output.
export interface FusedResult {
  id: string;
  score: number;
}

export function fuseRrf(rankings: string[][], k: number): FusedResult[] {
  const scores = new Map<string, number>();
  const firstSeenRank = new Map<string, number>();
  let seenCounter = 0;

  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      const rank = i + 1; // rank starts at 1, not 0
      const contribution = 1 / (k + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
      if (!firstSeenRank.has(id)) {
        firstSeenRank.set(id, seenCounter);
      }
      seenCounter += 1;
    });
  }

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
