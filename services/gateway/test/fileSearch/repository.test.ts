/**
 * Hermetic (no database) unit coverage for `recallCandidates`'s generated
 * SQL shape — specifically the final whole-branch review's near-free #15
 * (deterministic ORDER BY tiebreaker). The live-DB behavioural test in
 * integration/hybridSearch.test.ts ("returns a stable, repeatable ordering
 * for chunks tied on both vector distance and lexical rank") could NOT be
 * made to flake by repeated execution against the current data volume/query
 * plan (matching the exact same finding recorded for this defect during
 * Task 8's own review — see the SDD ledger) — Postgres's sort happens to be
 * stable enough in practice for a handful of tied rows that removing the
 * tiebreaker doesn't reliably reproduce as an observed ordering difference
 * across repeated runs. Asserting on the generated SQL text directly is the
 * one mutation-kill that IS reliable: it fails deterministically, in either
 * environment, the moment `c.store_id, c.file_id, c.ord` stops being
 * appended to both `ORDER BY` clauses in `buildCte`.
 */
import { describe, it, expect, jest } from '@jest/globals';

const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: (...a: any[]) => poolQuery(...a) }),
}));

const mockConfig = {
  embeddingDimensions: 3,
  hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 },
};
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

import { recallCandidates } from '../../src/fileSearch/repository';

describe('recallCandidates SQL generation', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [] });
    mockConfig.hybrid.lexicalEnabled = true;
  });

  async function capturedSql(): Promise<string> {
    await recallCandidates({
      storeIds: ['vs_1'],
      ownerEmail: 'owner@example.com',
      queryText: 'hello world',
      queryEmbedding: [1, 0, 0],
    });
    return poolQuery.mock.calls[0][0] as string;
  }

  it('appends the store_id/file_id/ord tiebreaker after BOTH occurrences of the vector CTE\'s ORDER BY expression', async () => {
    const sql = await capturedSql();
    const vecOrderExpr = 'c.embedding <=> $3::vector';
    const tiebreaker = 'c.store_id, c.file_id, c.ord';
    const occurrences = sql.split(`${vecOrderExpr}, ${tiebreaker}`).length - 1;
    // Exactly two: the ROW_NUMBER() OVER (ORDER BY ...) window clause AND the
    // CTE's own trailing ORDER BY ... LIMIT clause (buildCte's doc comment
    // calls out that orderExpr is used twice) -- for the vec CTE alone.
    expect(occurrences).toBe(2);
  });

  it('appends the same tiebreaker after both occurrences of the lexical CTE\'s ORDER BY expression when hybrid.lexicalEnabled is true', async () => {
    const sql = await capturedSql();
    const lexOrderExpr = "ts_rank(c.tsv, plainto_tsquery('simple', $5)) DESC";
    const tiebreaker = 'c.store_id, c.file_id, c.ord';
    const occurrences = sql.split(`${lexOrderExpr}, ${tiebreaker}`).length - 1;
    expect(occurrences).toBe(2);
  });

  it('still appends the tiebreaker on the vector CTE alone when hybrid.lexicalEnabled is false', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    const sql = await capturedSql();
    const vecOrderExpr = 'c.embedding <=> $3::vector';
    const tiebreaker = 'c.store_id, c.file_id, c.ord';
    const occurrences = sql.split(`${vecOrderExpr}, ${tiebreaker}`).length - 1;
    expect(occurrences).toBe(2);
  });
});
