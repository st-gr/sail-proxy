// Recall's approximate path: which vector arms search through the HNSW index, and running one such arm
// (split out of repository.ts).
import type { PoolClient } from 'pg';
import { getDefaultLogger } from '@libs/logger';
import {
  AnnSettings, annIndexReady, annSearchedChunksKey, annSessionSettings, forgetAnnIndexCheck, searchedChunksAllowAnn,
  searchedChunksCap,
} from './annPath';
import { searchedChunksCount, tableRowsEstimate } from './lexicalBound';
import { driverErrorCode } from './recallErrors';
import { ARM_COLUMNS, CandidateRow, RecallOptions, VectorArm } from './recallTypes';
import { HAS_VECTOR_SQL, armName, buildArm, chunkScopeSql, pushArmScope } from './recallSql';

const logger = getDefaultLogger();

/**
 * The searched active chunks of one vector arm, counted up to `$3` (annPath.ts searchedChunksCap), the caller's
 * team ids at `$4`. An estimate of
 * the arm's size, not its result: chunks of a detached file (left for the orphan sweep) and chunks without a
 * vector count too, so the count needs only the store and generation columns (idx_chunks_store_gen).
 */
function searchedChunksStatement(opts: RecallOptions, arm: VectorArm, armCount: number, cap: number): { sql: string; params: any[] } {
  const params: any[] = [opts.storeIds, opts.ownerEmail, cap, opts.teamIds ?? []];
  const { scope, storeIdsPlaceholder } = pushArmScope(params, arm, armCount);
  return {
    sql: `SELECT count(*)::int AS n FROM (
  SELECT 1 FROM vector_store_chunks c
  WHERE ${chunkScopeSql(scope, storeIdsPlaceholder, '$4')}
  LIMIT $3) t`,
    params,
  };
}

/**
 * The vector arms that search through the HNSW index (annPath.ts): the index is the valid halfvec kind and
 * the arm's searched chunks pass both thresholds. In a savepoint: a failed check costs the approximate path
 * (every arm exact), never the search.
 */
export async function annCandidateArms(
  client: PoolClient, opts: RecallOptions, arms: VectorArm[], ann: AnnSettings, dimensions: number,
): Promise<number[]> {
  await client.query('SAVEPOINT ann_check');
  try {
    const chosen: number[] = [];
    if (await annIndexReady(client, dimensions)) {
      // Both remembered for a minute (lexicalBound.ts, the full-text bound's caches): only exact vs approximate
      // depends on them, and an approximate arm short of the limit runs exactly anyway.
      const tableRows = await tableRowsEstimate(client);
      const cap = searchedChunksCap(ann, tableRows);
      for (const [i, arm] of arms.entries()) {
        if (cap === null) break;
        const { sql, params } = searchedChunksStatement(opts, arm, arms.length, cap);
        // eslint-disable-next-line no-await-in-loop
        const searched = await searchedChunksCount(annSearchedChunksKey(cap, opts.ownerEmail, opts.teamIds ?? [], arm.storeIds, arm.model),
          async () => Number((await client.query<{ n: number }>(sql, params)).rows[0].n));
        if (searchedChunksAllowAnn(ann, searched, tableRows)) chosen.push(i);
      }
    }
    await client.query('RELEASE SAVEPOINT ann_check');
    return chosen;
  } catch (error: any) {
    await restoreSavepointOrRethrow(client, 'ann_check', error);
    forgetAnnIndexCheck();
    logger.warn('FileSearchRepository', `Approximate search check failed (${driverErrorCode(error)}); every arm runs exactly`);
    return [];
  }
}

/**
 * One vector arm through the HNSW index (the recall probe's B2 shape): the inner query orders by the halfvec
 * distance alone and keeps `limit` candidates, scored with the full-precision distance; the arm's ROW_NUMBER
 * re-sorts them by that score and the tiebreaker. Its settings live in a savepoint that is rolled back after
 * it, so no other statement runs with them. Null when it failed (the arm then runs exactly).
 */
export async function runAnnArm(
  client: PoolClient, opts: RecallOptions, arms: VectorArm[], i: number, vectorLiteral: string, limit: number,
  dimensions: number,
): Promise<CandidateRow[] | null> {
  // $5 the caller's team ids, before the arm's own scope.
  const params: any[] = [opts.storeIds, opts.ownerEmail, vectorLiteral, limit, opts.teamIds ?? []];
  const { scope, storeIdsPlaceholder } = pushArmScope(params, arms[i], arms.length);
  const name = armName(i);
  const cte = buildArm(name, 'c.embedding <=> $3::vector', '', scope, HAS_VECTOR_SQL, '', '$4', storeIdsPlaceholder, '$5',
    `c.embedding::halfvec(${dimensions}) <=> $3::halfvec(${dimensions})`);
  await client.query('SAVEPOINT ann_arm');
  let rows: CandidateRow[];
  try {
    await client.query(annSessionSettings(limit));
    ({ rows } = await client.query<CandidateRow>(`
WITH${cte}
SELECT '${name}' AS source, ${ARM_COLUMNS} FROM ${name}`, params));
  } catch (error: any) {
    await restoreSavepointOrRethrow(client, 'ann_arm', error);
    forgetAnnIndexCheck();
    logger.warn('FileSearchRepository', `Approximate search failed (${driverErrorCode(error)}); the arm runs exactly`);
    return null;
  }
  // Drops the arm's settings. A failure here leaves nothing to recover: the error fails the search.
  await client.query('ROLLBACK TO SAVEPOINT ann_arm');
  return rows;
}

/**
 * Rolls back to `savepoint` after an approximate-search failure (`cause`), so the search can go on exactly.
 * When the rollback itself fails, the transaction is unusable — no statement, the exact one included, can run on
 * it — so the search fails: with `cause` (the error that matters), after a warning naming both SQLSTATEs.
 */
async function restoreSavepointOrRethrow(client: PoolClient, savepoint: string, cause: unknown): Promise<void> {
  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  } catch (rollbackError: any) {
    logger.warn('FileSearchRepository', `Approximate search failed (${driverErrorCode(cause)}) and ROLLBACK TO SAVEPOINT `
      + `${savepoint} failed too (${driverErrorCode(rollbackError)}); the search fails`);
    throw cause;
  }
}
