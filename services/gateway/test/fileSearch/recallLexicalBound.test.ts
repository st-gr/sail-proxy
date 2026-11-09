/**
 * Hermetic coverage of the full-text bound's wiring in `recallCandidates` (lexicalBound.ts): which statements a
 * search sends, and that a search over at most exact_max_chunks chunks sends exactly today's SQL. What the
 * bounded statement returns is proven against a database in integration/lexicalBound.test.ts.
 */
import { describe, it, expect, jest } from '@jest/globals';

const sent: Array<{ sql: string; params?: any[] }> = [];
let tableRows = 15000;
let searched = 0;
let failCount = false;
const STATS = [{ attname: 'tsv', null_frac: 0, elems: ['port', 'rare'], freqs: [0.4, 0.001, 0.001, 0.4, 0] }];
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        sent.push({ sql, params });
        if (sql.includes('reltuples')) return { rows: [{ n: tableRows }] };
        if (sql.includes('AS searched')) {
          if (failCount) throw Object.assign(new Error('boom'), { code: '57014' });
          return { rows: [{ searched: Math.min(searched, params![2]) }] };
        }
        if (sql.includes('pg_stats')) return { rows: STATS };
        if (sql.includes('cardinality')) return { rows: [{ q: "'service'", q_and: "'port' & 'service'" }] };
        return { rows: [] };
      },
      release: () => {},
    }),
  }),
}));

const warn = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    warn: (...args: any[]) => warn(...args), error: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

let mockConfig: any;
jest.mock('../../src/services/configService', () => ({ __esModule: true, getFileSearchConfig: () => mockConfig }));

import {
  recallCandidates, __resetRecallSettingsForTests, OR_QUERY_SQL, BOUNDED_OR_QUERY_SQL, ORDERED_SCAN_SETTINGS_SQL,
} from '../../src/fileSearch/repository';
import { __resetLexicalBoundForTests, TABLE_ROWS_SQL, COMMON_LEXEMES_SQL } from '../../src/fileSearch/lexicalBound';
import { STOP_WORDS } from '../../src/fileSearch/stopWords';

const ANN = { enabled: false, exactMaxChunks: 20000, minFraction: 0.05 };
const base = { storeIds: ['vs_2', 'vs_1'], ownerEmail: 'owner@example.invalid', queryText: 'port service', queryEmbedding: [1, 0, 0] };

/** The statements of one search, `ann` (and so exact_max_chunks) set or not. */
async function search(ann: any, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}):
  Promise<Array<{ sql: string; params?: any[] }>> {
  mockConfig = { embeddingDimensions: 3, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50, lexicalQuery: 'any' } };
  if (ann) mockConfig.ann = ann;
  Object.assign(mockConfig.hybrid, extra);
  __resetRecallSettingsForTests();
  __resetLexicalBoundForTests();
  sent.length = 0;
  await recallCandidates({ ...base, ...options });
  return [...sent];
}
const main = (s: Array<{ sql: string; params?: any[] }>) => s.filter((x) => x.sql.includes(' AS source, '));
const named = (s: Array<{ sql: string; params?: any[] }>, re: RegExp) => s.filter((x) => re.test(x.sql));
/** One CTE of the main statement, by name. */
function cte(sql: string, name: string): string {
  const start = sql.indexOf(`\n${name} AS (`);
  const end = sql.indexOf('\n)', start);
  return sql.slice(start, end);
}

describe('recallCandidates: the full-text bound', () => {
  beforeEach(() => {
    tableRows = 15000;
    searched = 0;
    failCount = false;
    warn.mockClear();
  });

  it('a table of at most exact_max_chunks rows: today\'s statements, byte for byte, after one catalog read', async () => {
    const today = await search(undefined);
    const small = await search(ANN);
    // Before BEGIN, on the recall connection.
    const at = small.findIndex((x) => x.sql === TABLE_ROWS_SQL);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(small.findIndex((x) => x.sql.startsWith('BEGIN')));
    expect(small.filter((x) => x.sql !== TABLE_ROWS_SQL)).toEqual(today);
    expect(named(small, /AS searched|pg_stats/)).toEqual([]);
    expect(named(today, /reltuples/)).toEqual([]);
  });

  it('a search over at most exact_max_chunks chunks of a larger table: today\'s statements, byte for byte', async () => {
    tableRows = 1_000_000;
    searched = 20000;
    const today = await search(undefined);
    const s = await search(ANN);
    const count = named(s, /AS searched/);
    expect(count).toHaveLength(1);
    expect(count[0].params).toEqual([base.storeIds, base.ownerEmail, 20001, []]);
    expect(s.filter((x) => !/reltuples|AS searched/.test(x.sql))).toEqual(today);
  });

  it('a larger search drops the common lexemes from the OR query and ranks a bounded set', async () => {
    tableRows = 1_000_000;
    searched = 500_000;
    const today = await search(undefined);
    const s = await search(ANN);
    expect(named(s, /pg_stats/).map((x) => x.sql)).toEqual([COMMON_LEXEMES_SQL]);
    const orQueries = s.filter((x) => x.sql === OR_QUERY_SQL || x.sql === BOUNDED_OR_QUERY_SQL);
    expect(orQueries).toEqual([{ sql: BOUNDED_OR_QUERY_SQL, params: [base.queryText, STOP_WORDS, ['port']] }]);

    const [bounded] = main(s);
    const [unbounded] = main(today);
    expect(bounded.params).toEqual(unbounded.params);
    // Right before the statement, inside the transaction: a sequential scan starts at the table's first block.
    expect(ORDERED_SCAN_SETTINGS_SQL).toBe('SET LOCAL synchronize_seqscans = off');
    const at = s.findIndex((x) => x.sql === ORDERED_SCAN_SETTINGS_SQL);
    expect(s[at + 1]).toBe(bounded);
    expect(at).toBeGreaterThan(s.findIndex((x) => x.sql.startsWith('BEGIN')));
    expect(named(today, /synchronize_seqscans/)).toEqual([]);
    // The vector arm and the AND arm are untouched; only the OR arm reads a bounded set.
    expect(cte(bounded.sql, 'vec')).toBe(cte(unbounded.sql, 'vec'));
    expect(cte(bounded.sql, 'lexand')).toBe(cte(unbounded.sql, 'lexand'));
    const lexor = cte(bounded.sql, 'lexor');
    expect(lexor).not.toBe(cte(unbounded.sql, 'lexor'));
    expect(lexor).toContain('LIMIT 5000');
    // Every chunk with all the terms (fewer than the limit, or this arm would not run) is in the ranked set.
    expect(lexor).toContain('AND (c.tsv @@ $7::tsquery OR c.context_tsv @@ $7::tsquery)\n      LIMIT $4');
    expect(lexor).toContain('(c.tsv @@ $7::tsquery OR c.context_tsv @@ $7::tsquery) IS NOT TRUE\n        AND c.ord <> -pg_backend_pid()\n      LIMIT 5000');
    expect(lexor).toContain('WHERE vsf.store_id = c.store_id AND vsf.file_id = c.file_id AND octet_length(vsf.file_id) > -pg_backend_pid()');
    expect(lexor.split('pg_backend_pid')).toHaveLength(3); // the capped scan and its files check only
    expect(lexor).toContain("ORDER BY ts_rank(c.tsv || coalesce(c.context_tsv, ''::tsvector), $6::tsquery) DESC, c.store_id, c.file_id, c.ord\n    LIMIT $4");
    // Both branches keep the one-time gate (the OR arm runs only when AND found fewer than the limit).
    expect(lexor.split('AND NOT (SELECT count(*) FROM lexand) >= $4')).toHaveLength(3);
  });

  it('an attribute filter applies to both parts of the bounded set', async () => {
    tableRows = 1_000_000;
    searched = 500_000;
    const filter = { filter: { type: 'eq', key: 'category', value: 'report' } };
    const today = await search(undefined, {}, filter);
    const [bounded] = main(await search(ANN, {}, filter));
    const [unbounded] = main(today);
    expect(bounded.params).toEqual(unbounded.params);
    const filterSql = '(vsf.attributes->>$6) = $7';
    expect(cte(unbounded.sql, 'lexor').split(filterSql)).toHaveLength(2);
    expect(cte(bounded.sql, 'lexor').split(filterSql)).toHaveLength(3);
  });

  it('remembers the searched count per owner and store set: another owner counts again', async () => {
    tableRows = 1_000_000;
    searched = 500_000;
    __resetLexicalBoundForTests();
    const counted = async (ownerEmail: string, storeIds: string[]) => {
      sent.length = 0;
      __resetRecallSettingsForTests();
      await recallCandidates({ ...base, ownerEmail, storeIds });
      return named(sent, /AS searched/).length;
    };
    mockConfig = { embeddingDimensions: 3, ann: ANN, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50, lexicalQuery: 'any' } };
    expect(await counted('a@example.invalid', ['vs_1', 'vs_2'])).toBe(1);
    expect(await counted('a@example.invalid', ['vs_2', 'vs_1'])).toBe(0); // same set, any order
    expect(await counted('b@example.invalid', ['vs_1', 'vs_2'])).toBe(1);
    expect(await counted('a@example.invalid', ['vs_1'])).toBe(1);
  });

  it('remembers the searched count per team set too: another team set counts again (spec 2026-10-14 §8)', async () => {
    tableRows = 1_000_000;
    searched = 500_000;
    __resetLexicalBoundForTests();
    const counted = async (teamIds: string[] | undefined) => {
      sent.length = 0;
      __resetRecallSettingsForTests();
      await recallCandidates({ ...base, teamIds });
      return named(sent, /AS searched/);
    };
    mockConfig = { embeddingDimensions: 3, ann: ANN, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50, lexicalQuery: 'any' } };
    const first = await counted(['t1', 't2']);
    expect(first).toHaveLength(1);
    expect(first[0].params![3]).toEqual(['t1', 't2']);
    expect(await counted(['t2', 't1'])).toHaveLength(0); // same set, any order
    expect(await counted(['t1'])).toHaveLength(1);
    expect(await counted(undefined)).toHaveLength(1);
    expect(await counted([])).toHaveLength(0); // absent and empty are the same: no teams
  });

  it('a failed check costs the bound, never the search', async () => {
    tableRows = 1_000_000;
    failCount = true;
    const today = await search(undefined);
    const s = await search(ANN);
    expect(warn).toHaveBeenCalledWith('FileSearchRepository', expect.stringContaining('(57014)'));
    expect(s.filter((x) => !/reltuples|AS searched/.test(x.sql))).toEqual(today);
  });

  it('"all" and a search without the full-text arm never check', async () => {
    tableRows = 1_000_000;
    searched = 500_000;
    expect(named(await search(ANN, { lexicalQuery: 'all' }), /reltuples|AS searched|pg_stats/)).toEqual([]);
    expect(named(await search(ANN, { lexicalEnabled: false }), /reltuples|AS searched|pg_stats/)).toEqual([]);
  });
});
