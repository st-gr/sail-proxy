/**
 * The bound on the full-text OR arm of a large search (W4). The OR arm ranks every chunk that holds any of the
 * question's terms (recallSql.ts), so a term in a large share of a large store makes it read and rank a large
 * share of the store: seconds at 200k chunks and more (scale bench, 2026-10-10). Above `exactMaxChunks` searched
 * chunks (file_search.ann.exact_max_chunks, the same size the vector arm calls large) the arm:
 *  - leaves out of its OR query the lexemes that more than COMMON_LEXEME_SHARE of the table's chunks contain
 *    (pg_stats of `tsv` and `context_tsv`): they say little about which chunk is relevant, and are what makes the
 *    matched set large. The AND query keeps every term, so a chunk that has them all still comes first; when
 *    every term is common, none is left out;
 *  - ranks at most OR_ARM_RANKED_SET_CEILING matching chunks beside the ones that hold every term, for what the
 *    statistics miss (never analysed, stale after a bulk ingest, many mid-frequency terms): the first ones in a
 *    fixed order (table order, or index order when the planner uses the (store_id, file_id) index), the same on
 *    every run (recallSql.ts orArmRankedSetSql), which favours older chunks.
 * At most `exactMaxChunks` searched chunks, the arm is exactly what it was before. Statistics are per table, not
 * per store, which is why they apply only to large searches: a small store is cheap whatever its terms.
 *
 * Cost when it does not apply: the table's size from pg_class, once per TABLE_ROWS_TTL_MS per process; nothing
 * else while the table holds at most `exactMaxChunks` chunks. In a larger table, a count of the searched chunks
 * capped at `exactMaxChunks + 1`, remembered per store set, owner and the owner's teams for SEARCHED_CHUNKS_TTL_MS. The approximate-
 * search check (annPath.ts) keeps its table size and counts in the same two caches.
 */

/** A lexeme in more than this share of the table's chunks is left out of a large search's OR query. */
export const COMMON_LEXEME_SHARE = 0.05;

/** A large search's OR arm ranks at most this many chunks that do not hold every term. */
export const OR_ARM_RANKED_SET_CEILING = 5000;

export const TABLE_ROWS_TTL_MS = 60_000;
export const SEARCHED_CHUNKS_TTL_MS = 60_000;
/** pg_stats changes only when (auto)analyze runs. */
export const COMMON_LEXEMES_TTL_MS = 600_000;
/** The searched-chunks cache keeps at most this many counts (then starts empty again). */
export const SEARCHED_CHUNKS_CACHE_MAX = 1000;

/** The table's estimated rows: -1 (PG 14+) or 0 before its first vacuum or analyze. */
export const TABLE_ROWS_SQL = "SELECT reltuples::float8 AS n FROM pg_class WHERE oid = to_regclass('vector_store_chunks')";

/** The most common lexemes of the chunk table's two tsvector columns, from the table the search path resolves. */
export const COMMON_LEXEMES_SQL = `SELECT s.attname, s.null_frac, s.most_common_elems::text::text[] AS elems,
       s.most_common_elem_freqs AS freqs
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = t.relname
 WHERE t.oid = to_regclass('vector_store_chunks') AND s.attname IN ('tsv', 'context_tsv')`;

export interface LexemeStatsRow {
  attname: string;
  null_frac: number | string | null;
  elems: string[] | null;
  freqs: Array<number | string> | null;
}

/**
 * The lexemes in more than `share` of the table's rows, sorted. most_common_elem_freqs holds one frequency per
 * lexeme of most_common_elems (then minimum, maximum and the null share), as a share of the column's NON-NULL
 * rows; scaled by (1 - null_frac) it is a share of all rows, so a context_tsv lexeme counts by the chunks that
 * hold it, not by the chunks that have a context.
 */
export function commonLexemes(rows: LexemeStatsRow[], share: number): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const { elems, freqs } = row;
    if (!elems || !freqs) continue; // eslint-disable-line no-continue
    if (freqs.length < elems.length) throw new Error('most_common_elem_freqs is shorter than most_common_elems');
    const nonNull = 1 - Number(row.null_frac ?? 0);
    elems.forEach((lexeme, i) => {
      if (Number(freqs[i]) * nonNull > share) out.add(lexeme);
    });
  }
  return [...out].sort();
}

export interface LexicalBound {
  /** Left out of the OR query (never out of the AND query). */
  commonLexemes: string[];
  /** The OR arm ranks at most this many chunks besides the ones with every term. */
  ceiling: number;
}

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

let tableRows: { at: number; n: number } | null = null;
const searchedChunks = new Map<string, { at: number; n: number }>();
let lexemes: { at: number; common: string[] } | null = null;

/**
 * The chunk table's estimated rows (TABLE_ROWS_SQL: -1 or 0 when unknown), remembered for TABLE_ROWS_TTL_MS. Shared
 * by this bound and the approximate-search check (recallAnn.ts annCandidateArms). A failed read throws and is not
 * remembered.
 */
export async function tableRowsEstimate(client: Queryable, now = Date.now()): Promise<number> {
  if (!tableRows || now - tableRows.at >= TABLE_ROWS_TTL_MS) {
    const { rows } = await client.query(TABLE_ROWS_SQL);
    tableRows = { at: now, n: Number(rows[0]?.n ?? -1) };
  }
  return tableRows.n;
}

/**
 * A capped count of searched chunks, remembered under `key` for SEARCHED_CHUNKS_TTL_MS in one map of at most
 * SEARCHED_CHUNKS_CACHE_MAX keys. Shared by this bound and the approximate-search check, so a key names everything
 * the count depends on: the cap, the owner, the owner's teams and the stores (and, for an approximate-search arm, its model; annPath.ts
 * annSearchedChunksKey). A failed count throws and is not remembered.
 */
export async function searchedChunksCount(key: string, count: () => Promise<number>, now = Date.now()): Promise<number> {
  let searched = searchedChunks.get(key);
  if (!searched || now - searched.at >= SEARCHED_CHUNKS_TTL_MS) {
    searched = { at: now, n: await count() };
    if (searchedChunks.size >= SEARCHED_CHUNKS_CACHE_MAX) searchedChunks.clear();
    searchedChunks.set(key, searched);
  }
  return searched.n;
}

/**
 * The bound for a search, or null when it searches at most `exactMaxChunks` chunks (or the table's size is
 * unknown): the OR arm then runs as it always has. `storeSetKey` identifies what `countSearched(cap)` counts
 * (the searched active chunks, up to `cap`). A failed read throws and is not remembered.
 */
export async function lexicalBound(
  client: Queryable, exactMaxChunks: number, storeSetKey: string, countSearched: (cap: number) => Promise<number>,
  now = Date.now(),
): Promise<LexicalBound | null> {
  if (!(await tableRowsEstimate(client, now) > exactMaxChunks)) return null;

  const cap = exactMaxChunks + 1;
  if (await searchedChunksCount(`${cap}\n${storeSetKey}`, () => countSearched(cap), now) <= exactMaxChunks) return null;

  if (!lexemes || now - lexemes.at >= COMMON_LEXEMES_TTL_MS) {
    const { rows } = await client.query(COMMON_LEXEMES_SQL);
    lexemes = { at: now, common: commonLexemes(rows, COMMON_LEXEME_SHARE) };
  }
  return { commonLexemes: lexemes.common, ceiling: OR_ARM_RANKED_SET_CEILING };
}

export function __resetLexicalBoundForTests(): void {
  tableRows = null;
  searchedChunks.clear();
  lexemes = null;
}
