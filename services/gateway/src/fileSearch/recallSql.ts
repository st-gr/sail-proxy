// The SQL recall is built from: the store-access and active-generation predicates, the chunk scope, one
// ranked arm, the full-text queries and the vector arms' store scopes (split out of repository.ts, which
// re-exports the public ones).
import type { VectorArm } from './recallTypes';

/**
 * THE tenant boundary for reading a vector store, as one SQL fragment shared
 * by every reader rather than copied per call site.
 *
 * Who may read a store (spec 2026-10-14 §8): its owner ($2 - every statement binds the caller's
 * e-mail there), everyone when it is shared with all users, and members of a team it is shared
 * with. `teamIdsParam` is the placeholder of the caller's team ids (`text[]`, empty when none -
 * an empty array grants nothing); `alias` is the statement's vector_stores alias.
 *
 * `recallCandidates` (via `chunkScopeSql`), `assertStoresAccessible`, the search's store check and
 * the store reads (stores.ts) all AND this into a WHERE clause over `vector_stores`. It is
 * deliberately NOT duplicated as literal text anywhere: a second copy of the rule is a second
 * place for the boundary to drift, and the drift would be silent (each query keeps returning rows,
 * just the wrong set). Anything else that learns to read `vector_stores` on a caller's behalf must
 * use this function too. Read and search only: owner-only operations check `owner_email` alone.
 */
export function storeAccessPredicateSql(teamIdsParam: string, alias = 'vs'): string {
  return `(${alias}.owner_email = $2 OR ${alias}.is_shared = true OR EXISTS (SELECT 1 FROM vector_store_team_shares s WHERE s.store_id = ${alias}.id AND s.team_id = ANY(${teamIdsParam})))`;
}

/**
 * Every reader of chunk content sees only the store's active generation. While
 * a re-embed writes the next generation, its chunks carry vectors from another
 * model — comparing them with this query's vector would be meaningless, and
 * returning both generations would return every chunk twice. Aliases `c`
 * (chunks) and `vs` (vector_stores), for a reader that joins the two. Recall
 * does not join them (its chunk scan reads `vector_store_chunks` alone); it
 * states the same rule as `ACTIVE_GENERATION_KEY_SQL` below.
 */
export const ACTIVE_GENERATION_PREDICATE_SQL = 'c.generation = vs.active_generation';

/**
 * Recall's form of `ACTIVE_GENERATION_PREDICATE_SQL`: a chunk's `store:generation`
 * key, matched against the keys `buildArm` selects from `vector_stores` as
 * `vs.id || ':' || vs.active_generation`. The generation is an integer, so the
 * key is unambiguous whatever the store id contains.
 */
const ACTIVE_GENERATION_KEY_SQL = "(c.store_id || ':' || c.generation)";

/**
 * Which chunks an arm reads (alias `c`): those of the requested stores the caller may read, in their
 * active generation, resolved from `vector_stores` (alias `vs`) inside the statement under
 * `storeAccessPredicateSql` (the caller's team ids bound at `teamIdsPlaceholder`), narrowed by `storeScope`.
 *
 * The first line, `c.store_id = ANY(<the requested ids>)`, is implied by the sub-select below it (which
 * keeps only ids in `$1`, and in the arm's own ids when it has them) and so changes no row. It is there for
 * the planner: the sub-select's array is computed at run time, so its selectivity is a guess from the
 * column's distinct count — with few stores in the table (a single-tenant install), "a large share", and
 * the plan scans the whole table even for a small store. The bound array is a value the planner reads
 * the store statistics for, so a small store's chunks come from idx_chunks_store or idx_chunks_store_gen.
 */
export function chunkScopeSql(storeScope: string, storeIdsPlaceholder: string, teamIdsPlaceholder: string): string {
  const stores = `FROM vector_stores vs
          WHERE vs.id = ANY($1)
            AND ${storeAccessPredicateSql(teamIdsPlaceholder)}${storeScope ? `\n            ${storeScope}` : ''}`;
  return `c.store_id = ANY(${storeIdsPlaceholder})
      AND c.store_id = ANY(ARRAY(
          SELECT vs.id ${stores}))
      AND ${ACTIVE_GENERATION_KEY_SQL} = ANY(ARRAY(
          SELECT vs.id || ':' || vs.active_generation ${stores}))`;
}

/**
 * Builds one ranked arm as a CTE named `name`, in two levels so that the LIMIT
 * bounds the work:
 *
 *  - the inner query reads `vector_store_chunks` alone, orders by the arm's
 *    score plus the tiebreaker and keeps the top `limit` rows — a bounded top-N
 *    sort that carries no window function and no joined columns;
 *  - the outer query numbers those rows (`ROW_NUMBER`, same order) and joins
 *    their file row and filename.
 *
 * Which chunks may be read is resolved inside the same statement, so recall
 * still sees one snapshot: `storeScope` narrows the `vector_stores` sub-selects
 * (alias `vs`) that yield the readable store ids and their active
 * `store:generation` keys, always under `storeAccessPredicateSql`. A chunk
 * counts only while its `vector_store_files` row exists (as the join it
 * replaces required); `filterSql` (`compileFilter`'s fragment, alias `vsf`) is
 * applied in that same EXISTS. `chunkPredicate` references `c` only.
 *
 * `scoreExpr` is the bare per-arm score; `direction` is '' (ascending, a
 * distance) or ' DESC' (a rank).
 *
 * `storeIdsPlaceholder` is the bound array of the arm's requested store ids
 * (`$1`, or a vector arm's own ids when there are several): see
 * `chunkScopeSql`. `teamIdsPlaceholder` is the bound array of the caller's team ids
 * (`storeAccessPredicateSql`). `annOrder` replaces the inner ORDER BY for an approximate
 * vector arm (annPath.ts): the halfvec distance alone, the shape the HNSW index
 * serves, while `score` stays the full-precision distance — the outer
 * ROW_NUMBER then re-sorts the candidates by it, tiebreaker included.
 *
 * `rankedSet` replaces the inner query's source and WHERE (it then ignores
 * `storeScope`, `chunkPredicate` and `filterSql`): a sub-select aliased `c`
 * that already applied them — the bounded OR arm's (`orArmRankedSetSql`).
 *
 * A chunk of an expired file (`fs_files.expires_at` passed, not yet deleted by
 * the expiry sweeper) is dropped at the outer join to `fs_files`: after the
 * inner LIMIT, so the check costs one predicate per candidate and the arm's
 * plan is unchanged; in that window an arm can return fewer candidates.
 */
export function buildArm(
  name: string,
  scoreExpr: string,
  direction: '' | ' DESC',
  storeScope: string,
  chunkPredicate: string,
  filterSql: string,
  limitPlaceholder: string,
  storeIdsPlaceholder: string,
  teamIdsPlaceholder: string,
  annOrder?: string,
  rankedSet?: string,
): string {
  // The tiebreaker after the score, in BOTH orderings below: without one, rows
  // tied on the score (a cosine distance or a ts_rank — both plausible to tie
  // exactly, e.g. two chunks at cosine distance 0 from an identical embedding)
  // would be cut at the LIMIT and numbered in an UNSPECIFIED order, and
  // fuseRrf's RRF fusion is only deterministic given deterministic input
  // rankings. `store_id, file_id, ord` is unique per chunk of one generation
  // (see candidateId in recallTypes.ts), so the order is total: the inner LIMIT keeps
  // exactly the rows the outer ROW_NUMBER then numbers 1..n.
  const tiebreaker = 'c.store_id, c.file_id, c.ord';
  const source = rankedSet ?? `vector_store_chunks c
    WHERE ${chunkScopeSql(storeScope, storeIdsPlaceholder, teamIdsPlaceholder)}
      AND EXISTS (
          SELECT 1 FROM vector_store_files vsf
          WHERE vsf.store_id = c.store_id AND vsf.file_id = c.file_id
            ${filterSql})
      ${chunkPredicate}`;
  return `
${name} AS (
  SELECT k.store_id, k.file_id, k.ord, k.text, vsf.attributes, f.filename,
         ROW_NUMBER() OVER (ORDER BY k.score${direction}, k.store_id, k.file_id, k.ord) AS rnk,
         k.score, k.generation, k.section, k.section_offset, k.context, k.page_start, k.page_end
  FROM (
    SELECT c.store_id, c.file_id, c.ord, c.text, ${scoreExpr} AS score,
           c.generation, c.section, c.section_offset, c.context, c.page_start, c.page_end
    FROM ${source}
    ORDER BY ${annOrder ?? `${scoreExpr}${direction}, ${tiebreaker}`}
    LIMIT ${limitPlaceholder}
  ) k
  JOIN vector_store_files vsf ON vsf.store_id = k.store_id AND vsf.file_id = k.file_id
  JOIN fs_files f ON f.id = k.file_id AND (f.expires_at IS NULL OR f.expires_at > now())
)`;
}

// Lexeme -> one quoted tsquery operand: backslash first, then the quote, then the quotes
// around it (the tsquery input syntax). The 'simple' parser keeps quotes inside URL- and
// path-like lexemes, so this is needed (it treats a backslash as a separator today, so that
// half is defence in depth); `quote_literal` is not usable here
// because it writes E'...' for a value with a backslash, which is no tsquery syntax. The
// backslash is chr(92), not a '\' literal, so the SQL means the same with
// standard_conforming_strings off.
const QUOTED_LEXEME_SQL = "'''' || replace(replace(l, chr(92), chr(92) || chr(92)), '''', '''''') || ''''";

/** The OR query keeps at most this many terms - the first distinct ones of the question - so
 *  the work of one full-text search stays bounded for a long question (up to 8192 characters). */
export const MAX_QUERY_TERMS = 32;

/**
 * hybrid.lexical_query "any": the tsquery that ORs the lexemes of the question - parsed by the
 * same 'simple' configuration as the stored `tsv` - that are not stop words and are longer
 * than one character, at most MAX_QUERY_TERMS of them in question order (by first position),
 * as tsquery text (`q`), with the AND of the same terms beside it (`q_and`, tried first -
 * see recallCandidates), or NULL when no such lexeme is left.
 *
 * Postgres builds it from its own lexemes; the question and the stop words are only ever
 * bound parameters. The operands are cast with `::tsquery`, which takes them verbatim
 * (`to_tsquery` would re-parse a compound lexeme such as `sail-proxy` into a phrase). NULL
 * rather than an empty tsquery, so there is no "doesn't contain lexemes" NOTICE.
 *
 * Its own statement, not a CTE of the recall statement: the recall statement then binds the
 * finished query as a constant, so the planner estimates its selectivity from the column
 * statistics - as it did for plainto_tsquery(constant) - and chooses between the GIN index
 * (idx_chunks_tsv) and a scan of the store's chunks on real numbers. A query computed inside
 * the statement is unknown at planning time and only gets a default selectivity.
 */
export const OR_QUERY_SQL = `SELECT CASE WHEN cardinality(t.terms) > 0
         THEN array_to_string(t.terms, ' | ')::tsquery::text END AS q,
       CASE WHEN cardinality(t.terms) > 0
         THEN array_to_string(t.terms, ' & ')::tsquery::text END AS q_and
FROM (SELECT ARRAY(
        SELECT ${QUOTED_LEXEME_SQL}
        FROM unnest(to_tsvector('simple', $1)) AS u(l, positions, weights)
        WHERE l <> ALL($2::text[]) AND length(l) > 1
        ORDER BY u.positions[1], l
        LIMIT ${MAX_QUERY_TERMS}) AS terms) t`;

/**
 * OR_QUERY_SQL for a large search (lexicalBound.ts): the same terms and the same AND query (`q_and`), but the OR
 * query (`q`) leaves out the terms in `$3` (the table's common lexemes) - unless that would leave none, then it
 * keeps them all. With an empty `$3` both queries are OR_QUERY_SQL's.
 */
export const BOUNDED_OR_QUERY_SQL = `WITH w AS (
  SELECT l, u.positions[1] AS p
  FROM unnest(to_tsvector('simple', $1)) AS u(l, positions, weights)
  WHERE l <> ALL($2::text[]) AND length(l) > 1
  ORDER BY u.positions[1], l
  LIMIT ${MAX_QUERY_TERMS}),
t AS (
  SELECT ARRAY(SELECT ${QUOTED_LEXEME_SQL} FROM w ORDER BY p, l) AS terms,
         ARRAY(SELECT ${QUOTED_LEXEME_SQL} FROM w WHERE l <> ALL($3::text[]) ORDER BY p, l) AS kept)
SELECT CASE WHEN cardinality(t.terms) > 0
         THEN array_to_string(CASE WHEN cardinality(t.kept) > 0 THEN t.kept ELSE t.terms END, ' | ')::tsquery::text END AS q,
       CASE WHEN cardinality(t.terms) > 0
         THEN array_to_string(t.terms, ' & ')::tsquery::text END AS q_and
FROM t`;

/**
 * The full-text arm matches a chunk's text OR its stored context (structured chunks: heading
 * path, contextual sentence, table header), and ranks it over both. A chunk without a context
 * has a NULL context_tsv: it matches and ranks on its text alone, exactly as before contexts.
 */
export const lexicalScoreSql = (tsQuery: string): string =>
  `${lexicalRankFunction}(c.tsv || coalesce(c.context_tsv, ''::tsvector), ${tsQuery})`;
export const lexicalMatchSql = (tsQuery: string): string => `(c.tsv @@ ${tsQuery} OR c.context_tsv @@ ${tsQuery})`;

/**
 * The chunks a large search's OR arm ranks (lexicalBound.ts), as `buildArm`'s `rankedSet`: every chunk with all
 * the terms (`andQuery`; fewer than the limit, or the OR arm would not run) and at most `ceiling` of the others
 * that match `orQuery`: the first ones in a fixed order - table order, or index order when the planner uses the
 * (store_id, file_id) index - the same on every run (ORDERED_SCAN_SETTINGS_SQL, SERIAL_SCAN_SQL and
 * SERIAL_FILES_SCAN_SQL), which favours older chunks - but the
 * chunks with every term, the best a ts_rank can find, are always in, and the vector arm is not bounded.
 * `gate` is the OR arm's one-time filter; each branch carries it, so neither reads a chunk when AND was enough.
 * `teamIdsPlaceholder` is the bound array of the caller's team ids (`storeAccessPredicateSql`).
 */
export function orArmRankedSetSql(
  gate: string, orQuery: string, andQuery: string, filterSql: string, ceiling: number, teamIdsPlaceholder: string,
): string {
  const branch = (match: string, limit: string, filesPredicate = ''): string => `SELECT c.store_id, c.file_id, c.ord, c.text, c.generation, c.section,
             c.section_offset, c.context, c.page_start, c.page_end, c.tsv, c.context_tsv
      FROM vector_store_chunks c
      WHERE ${chunkScopeSql('', '$1', teamIdsPlaceholder)}
        AND EXISTS (
            SELECT 1 FROM vector_store_files vsf
            WHERE vsf.store_id = c.store_id AND vsf.file_id = c.file_id${filesPredicate}
              ${filterSql})
        ${gate}AND ${match}
      LIMIT ${limit}`;
  // IS NOT TRUE, not NOT: a chunk without a context has a NULL context_tsv, and NOT (false OR NULL) is NULL.
  return `(
      (${branch(lexicalMatchSql(andQuery), '$4')})
      UNION ALL
      (${branch(`${lexicalMatchSql(orQuery)}\n        AND ${lexicalMatchSql(andQuery)} IS NOT TRUE\n        AND ${SERIAL_SCAN_SQL}`,
    String(ceiling), ` AND ${SERIAL_FILES_SCAN_SQL}`)})
    ) c`;
}

/**
 * The setting a bounded OR arm's statement runs with (see recallCandidates): a synchronized sequential scan
 * starts where the table's previous scan stopped, so its first matches would change from run to run.
 */
export const ORDERED_SCAN_SETTINGS_SQL = 'SET LOCAL synchronize_seqscans = off';

/**
 * A predicate that is always true (`ord` is never negative, a backend pid always positive) and parallel
 * restricted (pg_backend_pid): the planner gives the scan it filters no parallel workers, whose LIMIT would
 * keep whichever matches the workers happen to deliver first. It applies to that one scan, so the rest of the
 * statement (the exact vector arm on a large store) keeps its parallel plan.
 */
export const SERIAL_SCAN_SQL = 'c.ord <> -pg_backend_pid()';

/**
 * The same for the capped branch's vector_store_files scan (a file id's length is never negative): a hash join can
 * take the chunks in a fixed order and still emit them in the order a parallel scan of the files table probes it.
 */
export const SERIAL_FILES_SCAN_SQL = 'octet_length(vsf.file_id) > -pg_backend_pid()';

/** A chunk of only whitespace is stored without a vector (embeddingInputOf); it is never a hit. */
export const HAS_VECTOR_SQL = 'AND c.embedding IS NOT NULL';

export type LexicalRankFunction = 'ts_rank' | 'ts_rank_cd';
let lexicalRankFunction: LexicalRankFunction = 'ts_rank';

/** For the file_search evaluation runner only (a measurement, not a configuration): the
 *  ranking function of the full-text arm. The gateway always ranks with ts_rank. */
export function setLexicalRankFunction(fn: LexicalRankFunction): void {
  if (fn !== 'ts_rank' && fn !== 'ts_rank_cd') throw new Error(`unknown ranking function ${String(fn)}`);
  lexicalRankFunction = fn;
}

/** A vector arm's CTE and `source` name: 'vec' for the first, 'vec1', 'vec2', … after it. */
export const armName = (i: number): string => (i === 0 ? 'vec' : `vec${i}`);

/**
 * Appends a vector arm's store scope to `params` (placeholders numbered from its length): with several arms,
 * the arm's own store ids (also its `storeIdsPlaceholder`, else `$1`); with a model, `vs.embedding_model`.
 */
export function pushArmScope(params: any[], arm: VectorArm, armCount: number): { scope: string; storeIdsPlaceholder: string } {
  let scope = '';
  let storeIdsPlaceholder = '$1';
  if (armCount > 1) {
    params.push(arm.storeIds);
    storeIdsPlaceholder = `$${params.length}`;
    scope = `AND vs.id = ANY(${storeIdsPlaceholder})`;
  }
  if (arm.model !== undefined) {
    params.push(arm.model);
    scope += `${scope ? ' ' : ''}AND vs.embedding_model = $${params.length}`;
  }
  return { scope, storeIdsPlaceholder };
}
