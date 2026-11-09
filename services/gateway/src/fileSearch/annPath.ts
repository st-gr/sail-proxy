/**
 * Approximate (HNSW) search for a vector arm of recall: whether an arm may use it, and the session settings it
 * runs with. Off unless `file_search.ann.enabled`; recallAnn.ts builds the SQL and runs it.
 *
 * An arm searches through the index only when every one of these holds, and exactly otherwise:
 *  - pgvector is 0.8 or later (iterative scans; the caller passes the answer of its version probe);
 *  - `idx_chunks_hnsw` is valid and the halfvec kind `rebuild-index` and new installs build, cast to the
 *    column's width (an upgraded install keeps the previous kind, with its dead spots, until rebuilt);
 *  - the search has no attribute filter (the index post-filters; a selective filter starves it);
 *  - the arm's searched active chunks are more than `exactMaxChunks` and at least `minFraction` of the table
 *    (pg_class.reltuples): below either, the exact scan is as fast (scale bench, 2026-10-10) and always complete.
 * A candidate set shorter than the limit is replaced by the exact arm (recall.ts), so an approximate arm
 * never returns fewer chunks than the exact one would. It can return a full but different set: that is the
 * price of the option, and why it is off by default.
 */
import { readVectorIndex, isHalfvecVectorIndex } from './vectorIndex';

export interface AnnSettings { enabled: boolean; exactMaxChunks: number; minFraction: number }

/** How long the index check is trusted: `rebuild-index` may swap the index under a running gateway. */
export const INDEX_CHECK_TTL_MS = 60_000;

const ANN_EF_SEARCH_MIN = 200;
const ANN_EF_SEARCH_MAX = 1000; // pgvector's upper bound for hnsw.ef_search

/** hnsw.ef_search for an approximate arm: clamp(4 x limit, 200, 1000), as the recall probe measures it. */
export function annEfSearch(limit: number): number {
  return Math.min(Math.max(limit * 4, ANN_EF_SEARCH_MIN), ANN_EF_SEARCH_MAX);
}

/**
 * The SET LOCALs of an approximate arm (the recall probe's B2 shape): the planner is pushed onto the index
 * (no sort, no sequential or bitmap scan), and an iterative scan in relaxed order keeps reading the graph
 * while the store, owner and generation predicates discard what it found. The caller sets them inside a
 * savepoint it rolls back, so no other statement of the transaction runs with them.
 */
export function annSessionSettings(limit: number): string {
  return ['SET LOCAL enable_sort = off', 'SET LOCAL enable_seqscan = off', 'SET LOCAL enable_bitmapscan = off',
    `SET LOCAL hnsw.ef_search = ${annEfSearch(limit)}`, "SET LOCAL hnsw.iterative_scan = 'relaxed_order'"].join('; ');
}

/**
 * How many chunks to count before the answer is known: an arm with at least this many searched chunks
 * passes both thresholds. Null when the table size is unknown (never analyzed), which keeps the arm exact.
 */
export function searchedChunksCap(settings: AnnSettings, tableRows: number): number | null {
  if (!(tableRows > 0)) return null;
  return Math.max(settings.exactMaxChunks + 1, Math.ceil(settings.minFraction * tableRows), 1);
}

/** Whether an arm that searches `searched` active chunks (counted up to `searchedChunksCap`) goes approximate. */
export function searchedChunksAllowAnn(settings: AnnSettings, searched: number, tableRows: number): boolean {
  if (!(tableRows > 0)) return false;
  return searched > settings.exactMaxChunks && searched >= settings.minFraction * tableRows;
}

/**
 * What a vector arm's capped count is remembered under (lexicalBound.ts searchedChunksCount, the cache the
 * full-text bound uses too): the cap, the owner, the owner's teams (sorted), the model and the arm's stores, so no
 * count answers for another tenant, team set, model or setting. Starts with "ann", the full-text bound's keys with
 * the cap (a number).
 */
export function annSearchedChunksKey(
  cap: number, ownerEmail: string, teamIds: readonly string[], storeIds: string[], model: string | undefined,
): string {
  return ['ann', cap, ownerEmail, [...teamIds].sort().join(','), model ?? '', ...[...storeIds].sort()].join('\n');
}

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

let indexCheck: { dimensions: number; at: number; ready: boolean } | null = null;

/**
 * Whether `idx_chunks_hnsw` is the valid halfvec index at `dimensions`, remembered for INDEX_CHECK_TTL_MS.
 * A failed read throws and is not remembered.
 */
export async function annIndexReady(client: Queryable, dimensions: number, now = Date.now()): Promise<boolean> {
  if (indexCheck && indexCheck.dimensions === dimensions && now - indexCheck.at < INDEX_CHECK_TTL_MS) {
    return indexCheck.ready;
  }
  const index = await readVectorIndex(client);
  const ready = index !== null && index.valid && isHalfvecVectorIndex(index.definition, dimensions);
  indexCheck = { dimensions, at: now, ready };
  return ready;
}

/** Forget the index check (after an approximate arm failed, so the next search reads the catalog again). */
export function forgetAnnIndexCheck(): void {
  indexCheck = null;
}
