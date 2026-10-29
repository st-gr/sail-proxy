/**
 * Hermetic coverage of the approximate-search check's cache in `recallCandidates` (recallAnn.ts annCandidateArms):
 * with `ann.enabled`, the table size and each arm's capped count are remembered (lexicalBound.ts, one cache with the
 * full-text bound's), keyed by owner, stores, model and cap. What an approximate arm returns is proven against a
 * database in integration/annRecall.test.ts.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const sent: Array<{ sql: string; params?: any[] }> = [];
const HALFVEC = 'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw '
  + "(((embedding)::halfvec(3)) halfvec_cosine_ops) WITH (m='16', ef_construction='200')";
let tableRows = 1_000_000;
let searched = 500_000;
let failCount = false;
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        sent.push({ sql, params });
        if (sql.includes('pg_extension')) return { rows: [{ extversion: '0.8.0' }] };
        if (sql.includes('pg_get_indexdef')) return { rows: [{ definition: HALFVEC, valid: true, size: '8192' }] };
        if (sql.includes('reltuples')) return { rows: [{ n: tableRows }] };
        if (sql.includes('count(*)::int AS n')) {
          if (failCount) throw Object.assign(new Error('boom'), { code: '57014' });
          return { rows: [{ n: Math.min(searched, params![2]) }] };
        }
        if (sql.includes('AS searched')) return { rows: [{ searched: Math.min(searched, params![2]) }] };
        if (sql.includes('cardinality')) return { rows: [{ q: "'port'", q_and: "'port'" }] };
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

// eslint-disable-next-line import/first
import { recallCandidates, __resetRecallSettingsForTests } from '../../src/fileSearch/repository';
// eslint-disable-next-line import/first
import { TABLE_ROWS_SQL, __resetLexicalBoundForTests } from '../../src/fileSearch/lexicalBound';

const ANN = { enabled: true, exactMaxChunks: 20000, minFraction: 0.05 };
const base = { storeIds: ['vs_2', 'vs_1'], ownerEmail: 'owner@example.invalid', queryText: 'port', queryEmbedding: [1, 0, 0] };

/** The statements of one search; the caches persist between calls unless `reset`. */
async function search(options: Record<string, unknown> = {}, ann: any = ANN, lexicalEnabled = false):
  Promise<Array<{ sql: string; params?: any[] }>> {
  mockConfig = { embeddingDimensions: 3, ann, hybrid: { rrfK: 60, lexicalEnabled, candidates: 50, lexicalQuery: 'any' } };
  sent.length = 0;
  await recallCandidates({ ...base, ...options });
  return [...sent];
}
type Sent = Array<{ sql: string; params?: any[] }>;
const reltuples = (s: Sent) => s.filter((x) => x.sql.includes('reltuples'));
const armCounts = (s: Sent) => s.filter((x) => x.sql.includes('count(*)::int AS n'));
const annArms = (s: Sent) => s.filter((x) => x.sql.includes('::halfvec(3) <=>'));

describe('recallCandidates: the approximate-search check is cached', () => {
  beforeEach(() => {
    __resetRecallSettingsForTests();
    __resetLexicalBoundForTests();
    tableRows = 1_000_000;
    searched = 500_000;
    failCount = false;
    warn.mockClear();
  });

  it('a second search within the TTL reads neither the table size nor the arm count, and still goes approximate', async () => {
    const first = await search();
    expect(reltuples(first).map((x) => x.sql)).toEqual([TABLE_ROWS_SQL]);
    expect(armCounts(first)).toHaveLength(1);
    expect(armCounts(first)[0].params).toEqual([base.storeIds, base.ownerEmail, 50000, []]);
    expect(annArms(first)).toHaveLength(1);
    const second = await search();
    expect(reltuples(second)).toEqual([]);
    expect(armCounts(second)).toEqual([]);
    expect(annArms(second)).toHaveLength(1);
    // the savepoint stays: the index check (cached itself) and the arm run inside it
    expect(second.map((x) => x.sql)).toContain('SAVEPOINT ann_check');
  });

  it('shares the table size with the full-text bound: one read for both checks', async () => {
    const s = await search({}, ANN, true);
    expect(reltuples(s)).toHaveLength(1);
    expect(armCounts(s)).toHaveLength(1);
  });

  it('another owner, another store set or another model counts again', async () => {
    await search();
    expect(armCounts(await search({ ownerEmail: 'other@example.invalid' }))).toHaveLength(1);
    expect(armCounts(await search({ storeIds: ['vs_1'] }))).toHaveLength(1);
    expect(armCounts(await search({ storeIds: ['vs_1', 'vs_2'] }))).toEqual([]); // the same set, another order
    expect(armCounts(await search({ queryEmbedding: undefined, vectorArms: [{ storeIds: ['vs_2', 'vs_1'], model: 'm2', queryEmbedding: [1, 0, 0] }] })))
      .toHaveLength(1);
  });

  it('a failed count is not remembered: every arm runs exactly, and the next search counts again', async () => {
    failCount = true;
    const failed = await search();
    expect(annArms(failed)).toEqual([]);
    expect(warn).toHaveBeenCalledWith('FileSearchRepository', expect.stringMatching(/Approximate search check failed \(57014\)/));
    failCount = false;
    const next = await search();
    expect(armCounts(next)).toHaveLength(1);
    expect(annArms(next)).toHaveLength(1);
  });

  it('with ann off, no check runs at all', async () => {
    const s = await search({}, { ...ANN, enabled: false });
    expect(s.map((x) => x.sql)).not.toContain('SAVEPOINT ann_check');
    expect(reltuples(s)).toEqual([]);
    expect(armCounts(s)).toEqual([]);
  });
});
