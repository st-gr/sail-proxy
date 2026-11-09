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
 * environment, the moment `store_id, file_id, ord` stops being appended to
 * both orderings in `buildArm` (the inner ORDER BY ... LIMIT and the outer
 * ROW_NUMBER). Whether the reshaped statement returns exactly what the
 * pre-reshape one did is proven against a database in
 * integration/recallShape.test.ts.
 */
import { describe, it, expect, jest } from '@jest/globals';

const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
const controlQuery = jest.fn<(sql: string) => Promise<any>>();
const clientRelease = jest.fn();
// The OR query of hybrid.lexical_query "any" is its own statement before the recall one.
const orQuery = jest.fn<(sql: string, params: any[]) => Promise<any>>(async () => ({
  rows: [{ q: "'port' | 'service'", q_and: "'port' & 'service'" }],
}));
// Recall runs on a checked-out client inside a transaction; the transaction
// control, the pgvector probe and the SET LOCAL settings are answered here so
// `poolQuery` sees only the recall statement itself.
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({
    connect: async () => ({
      query: (sql: string, ...rest: any[]) => {
        if (sql.startsWith('SELECT CASE WHEN cardinality')) return orQuery(sql, rest[0]);
        return /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|SET LOCAL|SELECT extversion)/.test(sql)
          ? controlQuery(sql)
          : poolQuery(sql, ...rest);
      },
      release: (...a: any[]) => clientRelease(...a),
    }),
  }),
}));

const mockConfig = {
  embeddingDimensions: 3,
  hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50, lexicalQuery: 'any' as 'any' | 'all' },
};
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

import {
  recallCandidates, recallEfSearch, __resetRecallSettingsForTests, setLexicalRankFunction, OR_QUERY_SQL, MAX_QUERY_TERMS,
} from '../../src/fileSearch/repository';
import { STOP_WORDS } from '../../src/fileSearch/stopWords';
import { storeAccessPredicateSql } from '../../src/fileSearch/recallSql';

describe('recallCandidates SQL generation', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [] });
    controlQuery.mockReset();
    controlQuery.mockResolvedValue({ rows: [] });
    mockConfig.hybrid.lexicalEnabled = true;
    mockConfig.hybrid.lexicalQuery = 'any';
    __resetRecallSettingsForTests();
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

  const count = (sql: string, fragment: string): number => sql.split(fragment).length - 1;
  // The inner ORDER BY ... LIMIT and the outer ROW_NUMBER, each with the tiebreaker.
  const VEC_INNER = 'ORDER BY c.embedding <=> $3::vector, c.store_id, c.file_id, c.ord\n    LIMIT $4';
  const VEC_WINDOW = 'ROW_NUMBER() OVER (ORDER BY k.score, k.store_id, k.file_id, k.ord)';
  const LEX_INNER = "ORDER BY ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), $6::tsquery) DESC, c.store_id, c.file_id, c.ord\n    LIMIT $4";
  const LEX_AND_INNER = "ORDER BY ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), $7::tsquery) DESC, c.store_id, c.file_id, c.ord\n    LIMIT $4";
  const LEX_INNER_ALL = "ORDER BY ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), plainto_tsquery('simple', $6)) DESC, c.store_id, c.file_id, c.ord\n    LIMIT $4";
  const LEX_WINDOW = 'ROW_NUMBER() OVER (ORDER BY k.score DESC, k.store_id, k.file_id, k.ord)';
  const GENERATION_KEY = "AND (c.store_id || ':' || c.generation) = ANY(ARRAY(\n          SELECT vs.id || ':' || vs.active_generation FROM vector_stores vs";

  it('appends the store_id/file_id/ord tiebreaker to BOTH orderings of the vector arm', async () => {
    const sql = await capturedSql();
    expect(count(sql, VEC_INNER)).toBe(1);
    expect(count(sql, VEC_WINDOW)).toBe(1);
  });

  it('appends the same tiebreaker to both orderings of the lexical arm when hybrid.lexicalEnabled is true', async () => {
    const sql = await capturedSql();
    // "any": the AND arm and the OR arm
    expect(count(sql, LEX_INNER)).toBe(1);
    expect(count(sql, LEX_AND_INNER)).toBe(1);
    expect(count(sql, LEX_WINDOW)).toBe(2);
    mockConfig.hybrid.lexicalQuery = 'all';
    poolQuery.mockClear();
    const allSql = await capturedSql();
    expect(count(allSql, LEX_INNER_ALL)).toBe(1);
    expect(count(allSql, LEX_WINDOW)).toBe(1);
  });

  it('still appends the tiebreaker on the vector arm alone when hybrid.lexicalEnabled is false', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    const sql = await capturedSql();
    expect(count(sql, VEC_INNER)).toBe(1);
    expect(count(sql, VEC_WINDOW)).toBe(1);
    expect(sql).not.toContain('ts_rank');
  });

  it('numbers the rows above the LIMIT, never below it', async () => {
    const sql = await capturedSql();
    const arms = sql.split(/\n(?:vec|lexand|lexor) AS \(/).slice(1);
    expect(arms).toHaveLength(3);
    for (const arm of arms) {
      const inner = arm.slice(arm.indexOf('FROM ('), arm.indexOf(') k'));
      expect(inner).toContain('LIMIT $4');
      expect(inner).not.toContain('ROW_NUMBER');
      expect(inner).not.toMatch(/JOIN/);
    }
  });

  it('reads only the active generation in BOTH arms (the full-text one as its AND and OR arm)', async () => {
    const sql = await capturedSql();
    expect(count(sql, GENERATION_KEY)).toBe(3);
  });

  it('reads only the active generation in the vector arm when hybrid.lexicalEnabled is false', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    const sql = await capturedSql();
    expect(count(sql, GENERATION_KEY)).toBe(1);
  });
});

// hybrid.lexical_query: "any" (the default) ORs the question's terms that are not stop
// words; "all" is the original plainto_tsquery statement, byte for byte.
describe('recallCandidates full-text query', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [] });
    controlQuery.mockReset();
    controlQuery.mockResolvedValue({ rows: [] });
    mockConfig.hybrid.lexicalEnabled = true;
    mockConfig.hybrid.lexicalQuery = 'any';
    orQuery.mockClear();
    setLexicalRankFunction('ts_rank');
    __resetRecallSettingsForTests();
  });
  afterAll(() => setLexicalRankFunction('ts_rank'));

  const base = {
    storeIds: ['vs_1'],
    ownerEmail: 'owner@example.com',
    queryText: 'What port does the service use?',
    queryEmbedding: [1, 0, 0],
  };
  async function captured(extra: Record<string, unknown> = {}): Promise<[string, any[]]> {
    await recallCandidates({ ...base, ...extra });
    return poolQuery.mock.calls[0] as [string, any[]];
  }

  it('builds the OR query in Postgres from the bound question and stop words, then binds it as a constant', async () => {
    const [sql, params] = await captured();
    expect(orQuery).toHaveBeenCalledTimes(1);
    expect(orQuery.mock.calls[0]).toEqual([OR_QUERY_SQL, [base.queryText, STOP_WORDS]]);
    expect(OR_QUERY_SQL).toContain("FROM unnest(to_tsvector('simple', $1)) AS u(l, positions, weights)");
    expect(OR_QUERY_SQL).toContain('WHERE l <> ALL($2::text[]) AND length(l) > 1');
    // At most MAX_QUERY_TERMS terms, the first ones of the question.
    expect(MAX_QUERY_TERMS).toBe(32);
    expect(OR_QUERY_SQL).toContain('ORDER BY u.positions[1], l\n        LIMIT 32)');
    expect(OR_QUERY_SQL).toContain("array_to_string(t.terms, ' | ')::tsquery::text END AS q,");
    expect(OR_QUERY_SQL).toContain("array_to_string(t.terms, ' & ')::tsquery::text END AS q_and");
    expect(OR_QUERY_SQL).toContain('CASE WHEN cardinality(t.terms) > 0');
    // The recall statement gets the finished query, never the question.
    expect(params).toEqual([['vs_1'], 'owner@example.com', '[1,0,0]', 50, [], "'port' | 'service'", "'port' & 'service'"]);
    expect(params).toHaveLength(7);
    expect(sql).toContain("ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), $6::tsquery) AS score");
    expect(sql).toContain('AND (c.tsv @@ $6::tsquery OR c.context_tsv @@ $6::tsquery)');
    expect(sql).toContain("ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), $7::tsquery) AS score");
    expect(sql).toContain('AND (c.tsv @@ $7::tsquery OR c.context_tsv @@ $7::tsquery)');
    expect(sql).not.toContain('plainto_tsquery');
    // Inside the recall transaction, after the settings and before the recall statement.
    const at = (stmt: string) => controlQuery.mock.invocationCallOrder[controlQuery.mock.calls.findIndex((c) => c[0] === stmt)];
    expect(orQuery.mock.invocationCallOrder[0]).toBeGreaterThan(at('BEGIN'));
    expect(orQuery.mock.invocationCallOrder[0]).toBeLessThan(poolQuery.mock.invocationCallOrder[0]);
    expect(poolQuery.mock.invocationCallOrder[0]).toBeLessThan(at('COMMIT'));
  });

  it('binds the caller\'s team ids at $5, a parameter every arm\'s store access reads (spec 2026-10-14 §8)', async () => {
    const [sql, params] = await captured({ teamIds: ['team-1', 'team-2'] });
    expect(params[4]).toEqual(['team-1', 'team-2']);
    // vec, lexand and lexor, two store sub-selects each
    expect(sql.split(storeAccessPredicateSql('$5')).length - 1).toBe(6);
    expect(sql).not.toContain('team-1');
  });

  it('binds NULL when no term is left, so the full-text arm matches nothing', async () => {
    orQuery.mockResolvedValueOnce({ rows: [{ q: null, q_and: null }] });
    const [, params] = await captured();
    expect(params).toHaveLength(7);
    expect(params[5]).toBeNull(); // the OR query
    expect(params[6]).toBeNull(); // the AND query
  });

  it('tries the AND query first and runs the OR arm only when AND found fewer than the limit', async () => {
    const [sql] = await captured();
    const lexor = sql.match(/\blexor AS \([\s\S]*?\n\)/)![0];
    // a one-time filter: no row reference, so the OR arm reads nothing when AND was enough
    expect(lexor).toContain('AND NOT (SELECT count(*) FROM lexand) >= $4\n      AND (c.tsv @@ $6::tsquery OR c.context_tsv @@ $6::tsquery)');
    expect(sql).toContain([
      'lex AS (',
      '  SELECT * FROM lexand WHERE (SELECT count(*) FROM lexand) >= $4',
      '  UNION ALL',
      '  SELECT * FROM lexor',
      ')',
    ].join('\n'));
    expect(sql).toContain("SELECT 'lex' AS source, store_id, file_id, ord, text, attributes, filename, rnk, score, generation, section, section_offset, context, page_start, page_end FROM lex");
  });

  // A pin of the SQL text only; that it escapes correctly is proved against Postgres in
  // integration/hybridSearch.test.ts (hostile characters, both standard_conforming_strings).
  it('pins the lexeme escaping SQL: backslash (as chr(92)), then quote, then the quotes around it', () => {
    expect(OR_QUERY_SQL).toContain("'''' || replace(replace(l, chr(92), chr(92) || chr(92)), '''', '''''') || ''''");
    expect(OR_QUERY_SQL).not.toContain('\\');
  });

  it('"all" restores the original statement and parameters exactly, without the OR query', async () => {
    mockConfig.hybrid.lexicalQuery = 'all';
    const [sql, params] = await captured();
    expect(orQuery).not.toHaveBeenCalled();
    expect(params).toEqual([['vs_1'], 'owner@example.com', '[1,0,0]', 50, [], base.queryText]);
    expect(sql).not.toContain('::tsquery');
    expect(sql).toContain("ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), plainto_tsquery('simple', $6)) AS score");
    expect(sql).toContain("AND (c.tsv @@ plainto_tsquery('simple', $6) OR c.context_tsv @@ plainto_tsquery('simple', $6))");
    // score, ORDER BY, and the match on text and on context
    expect(sql.split('plainto_tsquery').length - 1).toBe(4);
  });

  // The original statement, byte for byte (one shape: one store, one arm, no filter): a change to
  // the "all" path - the rollback lever - must show up here, not only in the evaluation.
  // W2 changed it deliberately: chunks match and rank on their context too, chunks without a
  // vector never come from the vector arm, and every arm returns the structure columns.
  // W4 changed it deliberately: each arm first states `c.store_id = ANY($1)` (implied by the
  // sub-select after it), so the planner reads the store statistics for the requested stores.
  it('"all" sends exactly the original statement', async () => {
    mockConfig.hybrid.lexicalQuery = 'all';
    const [sql] = await captured();
    expect(sql).toBe([
      "",
      "WITH",
      "vec AS (",
      "  SELECT k.store_id, k.file_id, k.ord, k.text, vsf.attributes, f.filename,",
      "         ROW_NUMBER() OVER (ORDER BY k.score, k.store_id, k.file_id, k.ord) AS rnk,",
      "         k.score, k.generation, k.section, k.section_offset, k.context, k.page_start, k.page_end",
      "  FROM (",
      "    SELECT c.store_id, c.file_id, c.ord, c.text, c.embedding <=> $3::vector AS score,",
      "           c.generation, c.section, c.section_offset, c.context, c.page_start, c.page_end",
      "    FROM vector_store_chunks c",
      "    WHERE c.store_id = ANY($1)",
      "      AND c.store_id = ANY(ARRAY(",
      "          SELECT vs.id FROM vector_stores vs",
      "          WHERE vs.id = ANY($1)",
      "            AND (vs.owner_email = $2 OR vs.is_shared = true OR EXISTS (SELECT 1 FROM vector_store_team_shares s WHERE s.store_id = vs.id AND s.team_id = ANY($5)))))",
      "      AND (c.store_id || ':' || c.generation) = ANY(ARRAY(",
      "          SELECT vs.id || ':' || vs.active_generation FROM vector_stores vs",
      "          WHERE vs.id = ANY($1)",
      "            AND (vs.owner_email = $2 OR vs.is_shared = true OR EXISTS (SELECT 1 FROM vector_store_team_shares s WHERE s.store_id = vs.id AND s.team_id = ANY($5)))))",
      "      AND EXISTS (",
      "          SELECT 1 FROM vector_store_files vsf",
      "          WHERE vsf.store_id = c.store_id AND vsf.file_id = c.file_id",
      "            )",
      "      AND c.embedding IS NOT NULL",
      "    ORDER BY c.embedding <=> $3::vector, c.store_id, c.file_id, c.ord",
      "    LIMIT $4",
      "  ) k",
      "  JOIN vector_store_files vsf ON vsf.store_id = k.store_id AND vsf.file_id = k.file_id",
      "  JOIN fs_files f ON f.id = k.file_id AND (f.expires_at IS NULL OR f.expires_at > now())",
      "),",
      "lex AS (",
      "  SELECT k.store_id, k.file_id, k.ord, k.text, vsf.attributes, f.filename,",
      "         ROW_NUMBER() OVER (ORDER BY k.score DESC, k.store_id, k.file_id, k.ord) AS rnk,",
      "         k.score, k.generation, k.section, k.section_offset, k.context, k.page_start, k.page_end",
      "  FROM (",
      "    SELECT c.store_id, c.file_id, c.ord, c.text, ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), plainto_tsquery('simple', $6)) AS score,",
      "           c.generation, c.section, c.section_offset, c.context, c.page_start, c.page_end",
      "    FROM vector_store_chunks c",
      "    WHERE c.store_id = ANY($1)",
      "      AND c.store_id = ANY(ARRAY(",
      "          SELECT vs.id FROM vector_stores vs",
      "          WHERE vs.id = ANY($1)",
      "            AND (vs.owner_email = $2 OR vs.is_shared = true OR EXISTS (SELECT 1 FROM vector_store_team_shares s WHERE s.store_id = vs.id AND s.team_id = ANY($5)))))",
      "      AND (c.store_id || ':' || c.generation) = ANY(ARRAY(",
      "          SELECT vs.id || ':' || vs.active_generation FROM vector_stores vs",
      "          WHERE vs.id = ANY($1)",
      "            AND (vs.owner_email = $2 OR vs.is_shared = true OR EXISTS (SELECT 1 FROM vector_store_team_shares s WHERE s.store_id = vs.id AND s.team_id = ANY($5)))))",
      "      AND EXISTS (",
      "          SELECT 1 FROM vector_store_files vsf",
      "          WHERE vsf.store_id = c.store_id AND vsf.file_id = c.file_id",
      "            )",
      "      AND (c.tsv @@ plainto_tsquery('simple', $6) OR c.context_tsv @@ plainto_tsquery('simple', $6))",
      "    ORDER BY ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), plainto_tsquery('simple', $6)) DESC, c.store_id, c.file_id, c.ord",
      "    LIMIT $4",
      "  ) k",
      "  JOIN vector_store_files vsf ON vsf.store_id = k.store_id AND vsf.file_id = k.file_id",
      "  JOIN fs_files f ON f.id = k.file_id AND (f.expires_at IS NULL OR f.expires_at > now())",
      ")",
      "SELECT 'vec' AS source, store_id, file_id, ord, text, attributes, filename, rnk, score, generation, section, section_offset, context, page_start, page_end FROM vec",
      "UNION ALL",
      "SELECT 'lex' AS source, store_id, file_id, ord, text, attributes, filename, rnk, score, generation, section, section_offset, context, page_start, page_end FROM lex",
    ].join('\n'));
  });

  it('numbers the OR query after the attribute filter\'s parameters, and the filter still constrains the lexical arm', async () => {
    const [sql, params] = await captured({ filter: { type: 'eq', key: 'category', value: 'report' } });
    expect(params).toEqual([['vs_1'], 'owner@example.com', '[1,0,0]', 50, [], 'category', 'report',
      "'port' | 'service'", "'port' & 'service'"]);
    expect(params).toHaveLength(9);
    const lexand = sql.match(/\blexand AS \([\s\S]*?\n\)/)![0];
    const lexor = sql.match(/\blexor AS \([\s\S]*?\n\)/)![0];
    expect(lexand).toContain('(vsf.attributes->>$6) = $7');
    expect(lexand).toContain('AND (c.tsv @@ $9::tsquery OR c.context_tsv @@ $9::tsquery)');
    expect(lexor).toContain('(vsf.attributes->>$6) = $7');
    expect(lexor).toContain('AND (c.tsv @@ $8::tsquery OR c.context_tsv @@ $8::tsquery)');
  });

  it('adds no full-text query at all when the lexical arm is disabled', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    const [sql, params] = await captured();
    expect(orQuery).not.toHaveBeenCalled();
    expect(sql).not.toContain('tsquery');
    expect(params).toHaveLength(5);
  });

  it('ranks with ts_rank_cd only when the evaluation runner selects it', async () => {
    setLexicalRankFunction('ts_rank_cd');
    const [sql] = await captured();
    expect(sql).toContain("ts_rank_cd(c.tsv || coalesce(c.context_tsv, ''::tsvector), $6::tsquery) AS score");
    expect(sql).not.toMatch(/ts_rank\(/);
    expect(() => setLexicalRankFunction('ts_rank; DROP' as any)).toThrow();
  });
});

describe('STOP_WORDS', () => {
  it('is lowercase, deduplicated, and carries English and German function words', () => {
    expect(STOP_WORDS.every((w) => w === w.toLowerCase() && w.length > 1)).toBe(true);
    expect(new Set(STOP_WORDS).size).toBe(STOP_WORDS.length);
    for (const w of ['what', 'the', 'does', 'and', 'der', 'die', 'und', 'für', 'wie']) expect(STOP_WORDS).toContain(w);
    for (const w of ['not', 'port', 'service', 'nicht']) expect(STOP_WORDS).not.toContain(w);
  });
});

describe('recallCandidates pgvector settings', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [] });
    controlQuery.mockReset();
    mockConfig.hybrid.lexicalEnabled = true;
    __resetRecallSettingsForTests();
  });

  const recall = () => recallCandidates({
    storeIds: ['vs_1'], ownerEmail: 'owner@example.com', queryText: 'hello', queryEmbedding: [1, 0, 0],
  });
  const withVersion = (extversion: string | null) => controlQuery.mockImplementation(async (sql: string) => (
    sql.startsWith('SELECT extversion') ? { rows: extversion === null ? [] : [{ extversion }] } : { rows: [] }));
  const settingsCalls = () => controlQuery.mock.calls.map((c) => c[0]).filter((q) => q.startsWith('SAVEPOINT'));
  const jitCalls = () => controlQuery.mock.calls.map((c) => c[0]).filter((q) => q === 'SET LOCAL jit = off');

  it('raises ef_search to twice the candidates, at least 100 and at most 1000', () => {
    expect(recallEfSearch(10)).toBe(100);
    expect(recallEfSearch(50)).toBe(100);
    expect(recallEfSearch(80)).toBe(160);
    expect(recallEfSearch(5000)).toBe(1000);
  });

  it('turns JIT off and sets ef_search and iterative_scan with SET LOCAL inside the recall transaction on pgvector 0.8+', async () => {
    withVersion('0.8.6');
    await recall();
    const order = controlQuery.mock.calls.map((c) => c[0].split(' ')[0]);
    expect(order).toEqual(['SELECT', 'BEGIN', 'SET', 'SAVEPOINT', 'COMMIT']);
    expect(jitCalls()).toEqual(['SET LOCAL jit = off']);
    expect(settingsCalls()).toEqual([
      "SAVEPOINT recall_settings; SET LOCAL hnsw.ef_search = 100; SET LOCAL hnsw.iterative_scan = 'strict_order'; "
      + 'RELEASE SAVEPOINT recall_settings',
    ]);
  });

  it('leaves iterative_scan alone on an older pgvector, and probes the version only once', async () => {
    withVersion('0.7.4');
    await recall();
    await recall();
    expect(settingsCalls()).toEqual([
      'SAVEPOINT recall_settings; SET LOCAL hnsw.ef_search = 100; RELEASE SAVEPOINT recall_settings',
      'SAVEPOINT recall_settings; SET LOCAL hnsw.ef_search = 100; RELEASE SAVEPOINT recall_settings',
    ]);
    expect(controlQuery.mock.calls.filter((c) => c[0].startsWith('SELECT extversion'))).toHaveLength(1);
  });

  it('still searches when the version probe fails, without iterative_scan, and probes again next time', async () => {
    controlQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT extversion')) throw Object.assign(new Error('boom'), { code: '42501' });
      return { rows: [] };
    });
    await expect(recall()).resolves.toEqual([]);
    await recall();
    expect(settingsCalls()[0]).not.toContain('iterative_scan');
    expect(jitCalls()).toHaveLength(2);
    expect(controlQuery.mock.calls.filter((c) => c[0].startsWith('SELECT extversion'))).toHaveLength(2);
  });

  it('releases its client exactly once on success, on a query error and on a BEGIN error', async () => {
    withVersion('0.8.6');
    clientRelease.mockClear();
    await recall();
    expect(clientRelease).toHaveBeenCalledTimes(1);

    clientRelease.mockClear();
    poolQuery.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }));
    await expect(recall()).rejects.toMatchObject({ code: '57014' });
    expect(clientRelease).toHaveBeenCalledTimes(1);
    expect(controlQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK');

    clientRelease.mockClear();
    controlQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') throw Object.assign(new Error('gone'), { code: '57P01' });
      return { rows: [] };
    });
    await expect(recall()).rejects.toMatchObject({ code: '57P01' });
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('skips the settings for one call, without latching, when they fail for another reason (a cancel)', async () => {
    let failOnce = true;
    controlQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SAVEPOINT') && failOnce) {
        failOnce = false;
        throw Object.assign(new Error('canceling statement'), { code: '57014' });
      }
      return { rows: [{ extversion: '0.8.0' }] };
    });
    await expect(recall()).resolves.toEqual([]);
    const calls = controlQuery.mock.calls.map((c) => c[0]);
    expect(calls).toContain('ROLLBACK TO SAVEPOINT recall_settings');
    // JIT went off before the savepoint, so rolling back to it keeps JIT off.
    expect(calls).toContain('SET LOCAL jit = off');
    expect(calls.indexOf('SET LOCAL jit = off')).toBeLessThan(calls.findIndex((q) => q.startsWith('SAVEPOINT')));
    controlQuery.mockClear();
    await recall();
    expect(settingsCalls()).toHaveLength(1); // tried again: not latched
  });

  it('latches on "invalid parameter value" (22023) as well', async () => {
    controlQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SAVEPOINT')) throw Object.assign(new Error('invalid value'), { code: '22023' });
      return { rows: [{ extversion: '0.8.0' }] };
    });
    await recall();
    controlQuery.mockClear();
    await recall();
    expect(settingsCalls()).toEqual([]);
  });

  it('still searches when the server rejects the settings, and stops sending them', async () => {
    controlQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SAVEPOINT')) throw Object.assign(new Error('unrecognized'), { code: '42704' });
      return { rows: [{ extversion: '0.8.0' }] };
    });
    await expect(recall()).resolves.toEqual([]);
    expect(controlQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK TO SAVEPOINT recall_settings');
    expect(poolQuery).toHaveBeenCalledTimes(1);
    controlQuery.mockClear();
    await recall();
    expect(settingsCalls()).toEqual([]);
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('turns JIT off on every recall, also once the server rejected the HNSW settings', async () => {
    controlQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SAVEPOINT')) throw Object.assign(new Error('unrecognized'), { code: '42704' });
      return { rows: [{ extversion: '0.8.0' }] };
    });
    await recall();
    controlQuery.mockClear();
    await recall();
    await recall();
    expect(settingsCalls()).toEqual([]);
    expect(jitCalls()).toEqual(['SET LOCAL jit = off', 'SET LOCAL jit = off']);
    const order = controlQuery.mock.calls.map((c) => c[0]).filter((q) => q !== 'SELECT extversion FROM pg_extension WHERE extname = \'vector\'');
    expect(order.slice(0, 3)).toEqual(['BEGIN', 'SET LOCAL jit = off', 'COMMIT']);
  });
});

// One model per store (plan Decisions 2 and 7): stores on different embedding models are
// searched with one vector arm per model — each arm compares only its own stores' chunks
// with the query embedded by THEIR model — and every arm plus the lexical one is fused by
// the same RRF.
describe('recallCandidates with one vector arm per model', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [] });
    controlQuery.mockReset();
    controlQuery.mockResolvedValue({ rows: [] });
    mockConfig.hybrid.lexicalEnabled = true;
    __resetRecallSettingsForTests();
  });

  const twoArms = {
    storeIds: ['vs_a', 'vs_b'],
    ownerEmail: 'owner@example.com',
    queryText: 'hello',
    vectorArms: [
      { storeIds: ['vs_a'], queryEmbedding: [1, 0, 0] },
      { storeIds: ['vs_b'], queryEmbedding: [0, 1, 0] },
    ],
  };

  function row(source: string, storeId: string, fileId: string, rnk: number, score: number) {
    return {
      source, store_id: storeId, file_id: fileId, ord: 0, text: `${fileId} text`,
      attributes: null, filename: `${fileId}.txt`, rnk: String(rnk), score,
    };
  }

  it('builds one vector CTE per arm, each scoped to its own stores and its own query vector', async () => {
    await recallCandidates(twoArms);
    const [sql, params] = poolQuery.mock.calls[0] as [string, any[]];

    expect(sql).toMatch(/\bvec AS \(/);
    expect(sql).toMatch(/\bvec1 AS \(/);
    expect(sql).toMatch(/\blex AS \(/);
    // The tenant boundary ($1 store ids, $2 owner, $5 the caller's team ids) stays in every arm — in both of its
    // store sub-selects (the ids and the active generations); each vector arm is
    // additionally narrowed to its own stores.
    expect(sql.split(`WHERE vs.id = ANY($1)\n            AND ${storeAccessPredicateSql('$5')}`).length - 1).toBe(8);
    expect(params[4]).toEqual([]);
    // vec, vec1, and the full-text arm's AND and OR arms
    expect(sql.split("SELECT vs.id || ':' || vs.active_generation FROM vector_stores").length - 1).toBe(4);
    expect(params[0]).toEqual(['vs_a', 'vs_b']);
    expect(params[2]).toBe('[1,0,0]');
    const vec1Vector = sql.match(/vec1 AS \([\s\S]*?c\.embedding <=> \$(\d+)::vector/)![1];
    expect(params[Number(vec1Vector) - 1]).toBe('[0,1,0]');
    const vecScope = sql.match(/\bvec AS \([\s\S]*?AND vs\.id = ANY\(\$(\d+)\)/)![1];
    const vec1Scope = sql.match(/vec1 AS \([\s\S]*?AND vs\.id = ANY\(\$(\d+)\)/)![1];
    expect(params[Number(vecScope) - 1]).toEqual(['vs_a']);
    expect(params[Number(vec1Scope) - 1]).toEqual(['vs_b']);
    // The planner's view of the stores each arm reads: a vector arm its own ids, the full-text arms $1.
    expect(sql.match(/\bvec AS \([\s\S]*?WHERE c\.store_id = ANY\(\$(\d+)\)\n/)![1]).toBe(vecScope);
    expect(sql.match(/vec1 AS \([\s\S]*?WHERE c\.store_id = ANY\(\$(\d+)\)\n/)![1]).toBe(vec1Scope);
    expect(sql.match(/lexand AS \([\s\S]*?WHERE c\.store_id = ANY\(\$(\d+)\)\n/)![1]).toBe('1');
    expect(sql.match(/lexor AS \([\s\S]*?WHERE c\.store_id = ANY\(\$(\d+)\)\n/)![1]).toBe('1');
  });

  it('fuses every vector arm and the lexical arm with the same RRF', async () => {
    poolQuery.mockResolvedValue({
      rows: [
        row('vec', 'vs_a', 'a1', 1, 0.1),
        row('vec', 'vs_a', 'a2', 2, 0.2),
        row('vec1', 'vs_b', 'b1', 1, 0.3),
        row('lex', 'vs_b', 'b1', 1, 0.9),
      ],
    });

    const result = await recallCandidates(twoArms);

    // b1: first in its arm AND in lex; a1: first in its arm only; a2: second in its arm.
    expect(result.map((c) => c.fileId)).toEqual(['b1', 'a1', 'a2']);
    expect(result[0].score).toBeCloseTo(2 / 61);
    expect(result[1].score).toBeCloseTo(1 / 61);
    expect(result[0]).toMatchObject({ vectorRank: 1, vectorScore: 0.3, lexicalRank: 1 });
    expect(result[1]).toMatchObject({ vectorRank: 1, vectorScore: 0.1 });
  });

  // Weights are positional: [every vector arm..., lexical]. The fused scores tell which
  // weight reached which list: a1/b1 each top one vector arm, x tops the lexical one.
  describe('hybridWeights reach the right ranking arms', () => {
    const rows = () => [
      row('vec', 'vs_a', 'a1', 1, 0.1),
      row('vec1', 'vs_b', 'b1', 1, 0.3),
      row('lex', 'vs_a', 'x', 1, 0.9),
    ];
    const scores = (result: any[]) => Object.fromEntries(result.map((c) => [c.fileId, c.score]));

    it('applies embedding to every vector arm and text to the lexical arm', async () => {
      poolQuery.mockResolvedValue({ rows: rows() });
      const result = await recallCandidates({ ...twoArms, hybridWeights: { embedding: 2, text: 5 } });
      const s = scores(result);
      expect(s.a1).toBeCloseTo(2 / 61);
      expect(s.b1).toBeCloseTo(2 / 61);
      expect(s.x).toBeCloseTo(5 / 61);
      expect(result[0].fileId).toBe('x');
    });

    it('{ embedding: 1, text: 0 } returns only vector-arm ids', async () => {
      poolQuery.mockResolvedValue({ rows: rows() });
      const result = await recallCandidates({ ...twoArms, hybridWeights: { embedding: 1, text: 0 } });
      expect(result.map((c) => c.fileId).sort()).toEqual(['a1', 'b1']);
    });

    it('fuses unweighted when hybridWeights is absent', async () => {
      poolQuery.mockResolvedValue({ rows: rows() });
      const s = scores(await recallCandidates(twoArms));
      expect(s.a1).toBeCloseTo(1 / 61);
      expect(s.b1).toBeCloseTo(1 / 61);
      expect(s.x).toBeCloseTo(1 / 61);
    });

    it('applies embedding to the vector arms when the lexical arm is disabled', async () => {
      mockConfig.hybrid.lexicalEnabled = false;
      poolQuery.mockResolvedValue({ rows: rows().slice(0, 2) });
      const s = scores(await recallCandidates({ ...twoArms, hybridWeights: { embedding: 3, text: 1 } }));
      expect(s.a1).toBeCloseTo(3 / 61);
      expect(s.b1).toBeCloseTo(3 / 61);
    });
  });

  it('keeps today\'s single-arm SQL when every store shares one model', async () => {
    await recallCandidates({ ...twoArms, vectorArms: [{ storeIds: ['vs_a', 'vs_b'], queryEmbedding: [1, 0, 0] }] });
    const [sql, params] = poolQuery.mock.calls[0] as [string, any[]];
    expect(sql).not.toMatch(/vec1/);
    expect(sql).not.toMatch(/AND vs\.id = ANY\(\$\d+\)/);
    // Byte for byte the SQL and parameters of the queryEmbedding form.
    const { vectorArms: _arms, ...rest } = twoArms;
    poolQuery.mockClear();
    await recallCandidates({ ...rest, queryEmbedding: [1, 0, 0] });
    const [legacySql, legacyParams] = poolQuery.mock.calls[0] as [string, any[]];
    expect(sql).toBe(legacySql);
    expect(params).toEqual(legacyParams);
  });

  it('requires each arm\'s stores to still be on the arm\'s model, in the vector arms only', async () => {
    await recallCandidates({
      ...twoArms,
      vectorArms: [
        { storeIds: ['vs_a'], queryEmbedding: [1, 0, 0], model: 'model-a' },
        { storeIds: ['vs_b'], queryEmbedding: [0, 1, 0], model: 'model-b' },
      ],
    });
    const [sql, params] = poolQuery.mock.calls[0] as [string, any[]];
    const vecModel = sql.match(/\bvec AS \([\s\S]*?AND vs\.embedding_model = \$(\d+)/)![1];
    const vec1Model = sql.match(/vec1 AS \([\s\S]*?AND vs\.embedding_model = \$(\d+)/)![1];
    expect(params[Number(vecModel) - 1]).toBe('model-a');
    expect(params[Number(vec1Model) - 1]).toBe('model-b');
    // twice per vector arm: the store ids and their active generations
    expect(sql.split('vs.embedding_model =').length - 1).toBe(4);
    expect(sql.match(/lexand AS \([\s\S]*$/)![0]).not.toMatch(/embedding_model/);
  });

  it('adds the model predicate to a single arm that names its model', async () => {
    await recallCandidates({ ...twoArms, vectorArms: [{ storeIds: ['vs_a', 'vs_b'], queryEmbedding: [1, 0, 0], model: 'm' }] });
    const [sql, params] = poolQuery.mock.calls[0] as [string, any[]];
    expect(sql).not.toMatch(/AND vs\.id = ANY\(\$\d+\)/);
    const placeholder = sql.match(/AND vs\.embedding_model = \$(\d+)/)![1];
    expect(params[Number(placeholder) - 1]).toBe('m');
  });

  it('refuses arms that do not cover each requested store exactly once', async () => {
    await expect(recallCandidates({ ...twoArms, vectorArms: [twoArms.vectorArms[0]] })).rejects.toThrow(/arm/);
    await expect(recallCandidates({
      ...twoArms,
      vectorArms: [twoArms.vectorArms[0], { storeIds: ['vs_a', 'vs_b'], queryEmbedding: [0, 1, 0] }],
    })).rejects.toThrow(/arm/);
    await expect(recallCandidates({
      ...twoArms,
      vectorArms: [...twoArms.vectorArms, { storeIds: ['vs_c'], queryEmbedding: [0, 0, 1] }],
    })).rejects.toThrow(/arm/);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('refuses a call that passes both queryEmbedding and vectorArms, or neither', async () => {
    await expect(recallCandidates({ ...twoArms, queryEmbedding: [1, 0, 0] })).rejects.toThrow(/queryEmbedding|vectorArms/);
    const { vectorArms: _omit, ...neither } = twoArms;
    await expect(recallCandidates(neither)).rejects.toThrow(/queryEmbedding|vectorArms/);
  });

  it('validates every arm\'s vector, not only the first', async () => {
    await expect(recallCandidates({
      ...twoArms,
      vectorArms: [twoArms.vectorArms[0], { storeIds: ['vs_b'], queryEmbedding: [0, 1] }],
    })).rejects.toMatchObject({ status: 400 });
  });
});
