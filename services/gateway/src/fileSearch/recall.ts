// The hybrid recall stage: runs a pgvector cosine-distance ranking and (when
// enabled) a Postgres full-text `ts_rank` ranking over `vector_store_chunks`,
// each capped at `hybrid.candidates` rows, and fuses them with `fuseRrf` into
// one ordered list of ~50 candidate chunks. Task 12's reranker narrows that
// list further; this module's only job is cheap, correct recall.
//
// SECURITY: ownership is enforced INSIDE the SQL, not as a post-hoc filter —
// `storeAccessPredicateSql` (owner, shared with all, or shared with one of the
// caller's teams) is ANDed into both CTEs' WHERE clauses. A caller passing a store id it does not own must get zero
// rows for that store, not rows that are then discarded by the caller. This
// is deliberate: Task 12 turns "no rows for a store id" into a 404 rather than
// a 403, so store ids can't be enumerated by observing 403 vs 404.
//
// The attribute filter (attacker-controlled, from the client's file_search
// tool call) is compiled by filterCompiler.ts, which is pure and already
// hardened against injection, prototype-chain tricks and NUL bytes. This
// module's own responsibility is just correct placeholder bookkeeping: always
// resume numbering from compileFilter's returned `nextIndex`, never from a
// hardcoded per-leaf offset (ordinal leaves consume 3 placeholders, not 2 —
// see filterCompiler.ts and the Task 7 "Post-review correction" note), and to
// map compileFilter's thrown validation errors (oversized/malformed filter) to
// a client-input error rather than letting them look like a database failure.
import type { PoolClient } from 'pg';
import { getPool } from './db';
import { compileFilter } from './filterCompiler';
import { getFileSearchConfig } from '../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { fuseRrf } from './rrf';
import { STOP_WORDS } from './stopWords';
import type { AnnSettings } from './annPath';
import { LexicalBound, lexicalBound } from './lexicalBound';
import { RecallInputError, driverErrorCode, redactDriverError } from './recallErrors';
import { ARM_COLUMNS, CandidateChunk, CandidateRow, RecallOptions, VectorArm, candidateId } from './recallTypes';
import { assertArmsCoverStores, assertQueryTextIsSafe, toVectorLiteral } from './recallInput';
import {
  BOUNDED_OR_QUERY_SQL, HAS_VECTOR_SQL, OR_QUERY_SQL, ORDERED_SCAN_SETTINGS_SQL, armName, buildArm, chunkScopeSql,
  lexicalMatchSql, lexicalScoreSql, orArmRankedSetSql, pushArmScope,
} from './recallSql';
import { applyRecallSettings, recallSettingsRejected, supportsIterativeScan } from './recallSettings';
import { annCandidateArms, runAnnArm } from './recallAnn';

const logger = getDefaultLogger();

/**
 * The full-text OR arm's bound for this search (lexicalBound.ts), or null: at most `exactMaxChunks` searched
 * chunks, or a failed check (logged; the arm then runs unbounded, as it always has).
 */
async function orArmBound(client: PoolClient, opts: RecallOptions, exactMaxChunks: number): Promise<LexicalBound | null> {
  // The caller's teams are part of what the count counts: one team set's count must not answer for another.
  const storeSetKey = `${opts.ownerEmail}\n${[...(opts.teamIds ?? [])].sort().join(',')}\n${[...opts.storeIds].sort().join('\n')}`;
  const countSearched = async (cap: number): Promise<number> => {
    const { rows } = await client.query<{ searched: number }>(`SELECT count(*)::int AS searched FROM (
  SELECT 1 FROM vector_store_chunks c
  WHERE ${chunkScopeSql('', '$1', '$4')}
  LIMIT $3) t`, [opts.storeIds, opts.ownerEmail, cap, opts.teamIds ?? []]);
    return Number(rows[0].searched);
  };
  try {
    return await lexicalBound(client, exactMaxChunks, storeSetKey, countSearched);
  } catch (error: any) {
    logger.warn('FileSearchRepository', `Full-text bound check failed (${driverErrorCode(error)}); the full-text arm runs unbounded`);
    return null;
  }
}

/**
 * Recall ~`limit` candidate chunks across `storeIds`, scoped to what
 * `ownerEmail` may see, by fusing a vector-similarity ranking with (when
 * `hybrid.lexicalEnabled`) a full-text ranking via RRF.
 *
 * Throws `RecallInputError` (map to HTTP 400) for a malformed attribute
 * filter or a query embedding of the wrong dimension. Any other thrown error
 * is an unexpected database/connectivity failure.
 */
export async function recallCandidates(opts: RecallOptions): Promise<CandidateChunk[]> {
  const pool = getPool();
  if (!pool) {
    throw new Error('recallCandidates: file_search database is not configured');
  }

  const config = getFileSearchConfig();
  const limit = opts.limit ?? config.hybrid.candidates;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RecallInputError('limit must be a positive integer');
  }

  // `limit` and `queryEmbedding` (via toVectorLiteral, recallInput.ts) are validated;
  // `ownerEmail` is the highest-stakes parameter in this module — it is
  // ANDed into both CTEs' WHERE clauses as the entire ownership boundary
  // (see this file's header comment) — and was the one bare string passed
  // straight through with no check at all. A caller bug that drops it
  // (`undefined`, `null`, `''`) degrades SILENTLY today: the SQL predicate
  // (storeAccessPredicateSql) just never matches on
  // the owner_email side, so the query still runs and returns only
  // stores shared with all or with the caller's teams — fail-safe, but a caller error should throw here,
  // loudly, rather than quietly narrowing to "everything shared" and
  // looking like a correct empty/partial result.
  if (typeof opts.ownerEmail !== 'string' || opts.ownerEmail.length === 0) {
    throw new RecallInputError('ownerEmail must be a non-empty string');
  }

  assertQueryTextIsSafe(opts.queryText);

  if ((opts.queryEmbedding === undefined) === (opts.vectorArms === undefined)) {
    throw new Error('recallCandidates: pass exactly one of queryEmbedding and vectorArms');
  }
  const arms: VectorArm[] = opts.vectorArms ?? [{ storeIds: opts.storeIds, queryEmbedding: opts.queryEmbedding! }];
  const vectorLiterals = arms.map((arm) => toVectorLiteral(arm.queryEmbedding, config.embeddingDimensions));

  if (!Array.isArray(opts.storeIds) || opts.storeIds.length === 0) {
    return [];
  }
  if (opts.vectorArms) assertArmsCoverStores(opts.storeIds, opts.vectorArms);

  // $1 storeIds, $2 ownerEmail, $3 the first arm's query vector, $4 limit,
  // $5 the caller's team ids (text[], empty when none) —
  // fixed base params every CTE shares; further arms' vectors and store scopes,
  // the attribute filter and (if lexical is enabled) the query text are
  // appended after them, continuing from the running nextIndex (compileFilter's
  // own returned one for the filter) rather than a hardcoded offset.
  const params: any[] = [opts.storeIds, opts.ownerEmail, vectorLiterals[0], limit, opts.teamIds ?? []];
  let nextIndex = 6;

  // With one arm it covers every store and the SQL is the single-model shape.
  // With several, each arm is ALSO narrowed to its own stores — on top of, never
  // instead of, the `vs.id = ANY($1)` + owner boundary every CTE keeps.
  const armSql = arms.map((arm, i) => {
    let vectorPlaceholder = '$3';
    if (i > 0) {
      params.push(vectorLiterals[i]);
      vectorPlaceholder = `$${nextIndex}`;
      nextIndex += 1;
    }
    const { scope, storeIdsPlaceholder } = pushArmScope(params, arm, arms.length);
    nextIndex = params.length + 1;
    return { name: armName(i), vectorPlaceholder, scope, storeIdsPlaceholder };
  });

  let filterSql = '';
  if (opts.filter !== undefined && opts.filter !== null) {
    let compiled;
    try {
      compiled = compileFilter(opts.filter, nextIndex);
    } catch (error: any) {
      // compileFilter throws on malformed filter shapes AND on the
      // MAX_TOTAL_LEAVES/MAX_FILTER_DEPTH DoS guards — all of those are
      // client-input problems, never a 500.
      throw new RecallInputError(`Invalid attribute filter: ${error.message}`);
    }
    filterSql = `AND ${compiled.sql}`;
    params.push(...compiled.params);
    nextIndex = compiled.nextIndex;
  }

  const lexicalEnabled = config.hybrid.lexicalEnabled;
  const ann: AnnSettings = config.ann ?? { enabled: false, exactMaxChunks: 0, minFraction: 0 };

  // An arm in `annServed` got its rows from its approximate statement (runAnnArm): its CTE here keeps its
  // parameters but reads nothing (a constant-false predicate, planned away).
  const vecCteFor = (annServed: ReadonlySet<number>): string => armSql.map(({ name, vectorPlaceholder, scope, storeIdsPlaceholder }, i) => buildArm(
    name,
    `c.embedding <=> ${vectorPlaceholder}::vector`,
    '',
    scope,
    annServed.has(i) ? `${HAS_VECTOR_SQL}\n      AND false` : HAS_VECTOR_SQL,
    filterSql,
    '$4',
    storeIdsPlaceholder,
    '$5',
  )).join(',');
  const vecSelects = armSql.map(({ name }) =>
    `SELECT '${name}' AS source, ${ARM_COLUMNS} FROM ${name}`);

  let sqlFor: (annServed: ReadonlySet<number>, bound: LexicalBound | null) => string;
  let orQueryIndex: number | undefined;
  if (lexicalEnabled) {
    const queryTextIndex = nextIndex;
    nextIndex += 1;

    let lexCteFor: (bound: LexicalBound | null) => string;
    if (config.hybrid.lexicalQuery === 'all') {
      params.push(opts.queryText);
      const tsQuery = `plainto_tsquery('simple', $${queryTextIndex})`;
      const lexCte = buildArm(
        'lex',
        lexicalScoreSql(tsQuery),
        ' DESC',
        '',
        `AND ${lexicalMatchSql(tsQuery)}`,
        filterSql,
        '$4',
        '$1',
        '$5',
      );
      lexCteFor = () => lexCte;
    } else {
      // The OR and the AND query over the same terms, filled in by OR_QUERY_SQL inside the
      // transaction. AND first: when at least `limit` chunks contain every term, those are the
      // arm's candidates and the OR arm never runs (its one-time filter is false). Only when
      // AND finds fewer does the OR arm rank every chunk with any of the terms - the costly
      // case for a term that occurs in a large share of a store, which a large search bounds
      // (lexicalBound.ts: BOUNDED_OR_QUERY_SQL and orArmRankedSetSql).
      params.push(null, null);
      orQueryIndex = queryTextIndex;
      nextIndex += 1;
      const orQuery = `$${queryTextIndex}::tsquery`;
      const andQuery = `$${queryTextIndex + 1}::tsquery`;
      const andIsEnough = '(SELECT count(*) FROM lexand) >= $4';
      const arm = (name: string, tsQuery: string, gate: string, rankedSet?: string) => buildArm(
        name,
        lexicalScoreSql(tsQuery),
        ' DESC',
        '',
        `${gate}AND ${lexicalMatchSql(tsQuery)}`,
        filterSql,
        '$4',
        '$1',
        '$5',
        undefined,
        rankedSet,
      );
      const orGate = `AND NOT ${andIsEnough}\n      `;
      lexCteFor = (bound) => `${arm('lexand', andQuery, '')},${arm('lexor', orQuery, orGate,
        bound ? orArmRankedSetSql(orGate, orQuery, andQuery, filterSql, bound.ceiling, '$5') : undefined)},
lex AS (
  SELECT * FROM lexand WHERE ${andIsEnough}
  UNION ALL
  SELECT * FROM lexor
)`;
    }
    sqlFor = (annServed, bound) => `
WITH${vecCteFor(annServed)},${lexCteFor(bound)}
${vecSelects.join('\nUNION ALL\n')}
UNION ALL
SELECT 'lex' AS source, ${ARM_COLUMNS} FROM lex`;
  } else {
    // hybrid.lexicalEnabled=false: run the vector CTE only, still through
    // fuseRrf (a single ranking degrades to plain 1/(k+rank) ordering, which
    // is order-preserving — see rrf.test.ts) so there's exactly one scoring
    // code path regardless of how many rankings contributed.
    sqlFor = (annServed) => `
WITH${vecCteFor(annServed)}
${vecSelects.join('\nUNION ALL\n')}`;
  }

  // One transaction per recall, so the SET LOCAL pgvector settings apply to
  // exactly this query and are gone when the connection returns to the pool.
  // With approximate search on, an arm may run as its own statement: REPEATABLE
  // READ keeps every statement of the recall on one snapshot, as one statement is.
  let rows: CandidateRow[];
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    // Probed outside the transaction: a failing probe must not abort it.
    const iterativeScan = await supportsIterativeScan(client);
    // Outside the transaction too: a failed check costs the bound, never the search.
    const bound = orQueryIndex !== undefined && config.ann
      ? await orArmBound(client, opts, config.ann.exactMaxChunks) : null;
    await client.query(ann.enabled ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    try {
      await applyRecallSettings(client, limit, iterativeScan);
      if (orQueryIndex !== undefined) {
        // NULL (no term left) makes both `@@ NULL` a constant false: the arm reads nothing.
        const orQuery = bound
          ? await client.query(BOUNDED_OR_QUERY_SQL, [opts.queryText, STOP_WORDS, bound.commonLexemes])
          : await client.query(OR_QUERY_SQL, [opts.queryText, STOP_WORDS]);
        params[orQueryIndex - 1] = orQuery.rows[0].q;
        params[orQueryIndex] = orQuery.rows[0].q_and;
      }
      const annServed = new Set<number>();
      const annRows: CandidateRow[] = [];
      // pgvector before 0.8 has no iterative scan, and a filtered search post-filters the index: both exact.
      if (ann.enabled && iterativeScan && !recallSettingsRejected && filterSql === '') {
        const candidates = await annCandidateArms(client, opts, arms, ann, config.embeddingDimensions);
        for (const i of candidates) {
          // eslint-disable-next-line no-await-in-loop
          const armRows = await runAnnArm(client, opts, arms, i, vectorLiterals[i], limit, config.embeddingDimensions);
          // Fewer than the limit (or a failure): the arm runs exactly in the statement below, so an
          // approximate arm never returns fewer chunks than the exact one.
          if (armRows !== null && armRows.length >= limit) {
            annServed.add(i);
            annRows.push(...armRows);
          }
        }
      }
      let statementRows: CandidateRow[] = [];
      if (lexicalEnabled || annServed.size < arms.length) {
        // The bounded OR arm keeps the first matches its scan meets: the same ones on every run only if a
        // sequential scan starts at the table's first block. For this transaction only, like the recall
        // settings above. (Its scan also never runs in parallel workers: SERIAL_SCAN_SQL.)
        if (bound) await client.query(ORDERED_SCAN_SETTINGS_SQL);
        statementRows = (await client.query(sqlFor(annServed, bound), params)).rows;
      }
      await client.query('COMMIT');
      rows = annRows.length > 0 ? [...statementRows, ...annRows] : statementRows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } catch (error: any) {
    // NOT `error.message`, and not the raw error object either. Everything that can be
    // thrown here comes out of the `pg` driver, and a DatabaseError's message QUOTES THE
    // INPUT that offended Postgres -- reproduced live, an ordinal filter carrying a
    // non-numeric `value` yields
    //   [22P02] invalid input syntax for type numeric: "Jane Doe, MRN 4471"
    // where the quoted string is the caller's own filter value, which `body.filters` never
    // has pseudonymization applied to. `filterCompiler` now rejects that filter at 400, but
    // this line must not depend on every future 22P02-shaped input being caught upstream.
    //
    // `redactDriverError` keeps what is diagnostic (the class, the SQLSTATE, the frames)
    // and drops what is not ours to log (the message, and the stack's first line, which is
    // `${name}: ${message}` and therefore carries a second copy of it).
    logger.error('FileSearchRepository',
      `Hybrid recall query failed: ${driverErrorCode(error)}`, redactDriverError(error), {
        storeCount: opts.storeIds.length,
        lexicalEnabled,
      });
    throw error;
  } finally {
    client?.release();
  }

  // Each CTE contributes at most one row per chunk, but a chunk recalled by
  // BOTH arms produces two rows here — one per source. Collapsing them with a
  // single `byId.set(id, row)` (as this used to) keeps only whichever row
  // arrived last and silently drops the other arm's rank/score, which is
  // exactly the per-arm data this function exists to preserve. Instead, each
  // id accumulates into one entry with an optional `vec` and/or `lex` hit, so
  // a chunk present in both arms surfaces both.
  interface ArmHit { rank: number; score: number }
  const byId = new Map<string, { row: CandidateRow; vec?: ArmHit; lex?: ArmHit }>();
  const vecRankings: string[][] = arms.map(() => []);
  const lexRanking: string[] = [];

  for (const row of rows) {
    const id = candidateId(row.store_id, row.file_id, row.ord);
    const entry = byId.get(id) ?? { row };
    const rank = Number(row.rnk);
    const hit: ArmHit = { rank, score: Number(row.score) };
    if (row.source !== 'lex') {
      // A store belongs to exactly one arm, so a chunk has at most one vector hit.
      entry.vec = hit;
      vecRankings[row.source === 'vec' ? 0 : Number(row.source.slice(3))][rank - 1] = id;
    } else {
      entry.lex = hit;
      lexRanking[rank - 1] = id;
    }
    byId.set(id, entry);
  }

  const rankings = lexicalEnabled ? [...vecRankings, lexRanking] : vecRankings;
  // Order matches `rankings`: every vector arm first, the lexical ranking last.
  const w = opts.hybridWeights;
  const weights = w
    ? (lexicalEnabled ? [...vecRankings.map(() => w.embedding), w.text] : vecRankings.map(() => w.embedding))
    : undefined;
  const fused = fuseRrf(rankings, config.hybrid.rrfK, weights).slice(0, limit);

  return fused.map(({ id, score }) => {
    const { row, vec, lex } = byId.get(id)!;
    return {
      storeId: row.store_id,
      fileId: row.file_id,
      filename: row.filename,
      ord: row.ord,
      text: row.text,
      attributes: row.attributes ?? {},
      score,
      vectorRank: vec?.rank,
      vectorScore: vec?.score,
      lexicalRank: lex?.rank,
      lexicalScore: lex?.score,
      ...(row.section !== null && row.section !== undefined
        ? { generation: row.generation, section: row.section, sectionOffset: row.section_offset ?? 0 } : {}),
      ...(row.context ? { context: row.context } : {}),
      ...(row.page_start != null && row.page_end != null ? { pages: { first: row.page_start, last: row.page_end } } : {}),
    };
  });
}
