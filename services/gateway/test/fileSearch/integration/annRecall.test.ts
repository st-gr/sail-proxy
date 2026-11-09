// Approximate (HNSW) search for recall's vector arms (W4, annPath.ts): which arms use the index, the
// statement they run, the exact re-run when the index comes back short, and recall on clustered synthetic
// data (the scale bench's generator, at a small size, with lowered thresholds).
import { Client, Pool, PoolClient } from 'pg';
import { getPool, __resetForTests } from '../../../src/fileSearch/db';
import {
  recallCandidates, RecallOptions, CandidateChunk, __resetRecallSettingsForTests,
} from '../../../src/fileSearch/repository';
import { annSessionSettings } from '../../../src/fileSearch/annPath';
import { __resetLexicalBoundForTests } from '../../../src/fileSearch/lexicalBound';
import { halfvecIndexDefinition } from '../../../src/fileSearch/vectorIndex';
import { chunkInsertSql, createVectorPool, insertFiles, vectorSelect } from '../../../scripts/fileSearchScale/load';
import { OWNER } from '../../../scripts/fileSearchScale/vectors';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const probe = require('../../../../../cli-tools/file-search-recall-probe.js') as {
  tieAwareRecall: (exact: Array<{ id: string; score: number }>, ann: Array<{ id: string; score: number }>) => number;
};

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const DIM = 16;
const WORDS = 12;
const ANN_ON = { enabled: true, exactMaxChunks: 1000, minFraction: 0.02 };

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

const rawQuery = (client: PoolClient, sql: string, params?: any[]): Promise<any> =>
  (Client.prototype.query as any).call(client, sql, params);

function nodes(plan: any, out: any[] = []): any[] {
  out.push(plan);
  for (const child of plan.Plans ?? []) nodes(child, out);
  return out;
}

const isAnn = (sql: string) => sql.includes('::halfvec(');
const isCount = (sql: string) => sql.startsWith('SELECT count(*)::int AS n FROM (');
const isMain = (sql: string) => sql.includes(' AS source, ') && !isAnn(sql);

d('approximate vector search (requires FILE_SEARCH_TEST_DSN pointing at pgvector >= 0.8)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  // Every statement recall sent, with the rows it got back.
  let log: Array<{ sql: string; params?: any[]; rows: any[] }> = [];
  // Test hooks: answer the pgvector version probe, or replace a statement before it runs.
  let pgvectorVersion: string | null = null;
  let rewrite: ((sql: string) => string) | null = null;
  // The session settings on recall's connection just before its main statement runs.
  let showBeforeMain = false;
  let settingsBeforeMain: Record<string, string> | null = null;

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    pool = getPool()!;
    const realConnect = pool.connect.bind(pool) as (cb?: any) => any;
    // Assigned, not jest.spyOn: the gateway's jest config restores spies before every test.
    (pool as any).connect = (async (cb?: any) => {
      if (cb) return realConnect(cb);
      const client: PoolClient = await realConnect();
      (client as any).query = async (sql: any, params?: any) => {
        if (pgvectorVersion !== null && /SELECT extversion FROM pg_extension/.test(sql)) {
          return { rows: [{ extversion: pgvectorVersion }] };
        }
        if (typeof sql === 'string' && isMain(sql) && showBeforeMain) {
          const shown = await rawQuery(client, `SELECT current_setting('enable_sort') AS enable_sort,
            current_setting('enable_seqscan') AS enable_seqscan, current_setting('enable_bitmapscan') AS enable_bitmapscan,
            current_setting('hnsw.ef_search') AS ef_search, current_setting('hnsw.iterative_scan') AS iterative_scan`);
          settingsBeforeMain = shown.rows[0];
        }
        const text = rewrite ? rewrite(sql) : sql;
        const result = await rawQuery(client, text, params);
        log.push({ sql, params, rows: result.rows ?? [] });
        return result;
      };
      return client;
    });

    const c = await fixture.pool.connect();
    try {
      await c.query('DROP INDEX idx_chunks_hnsw'); // built after the load, as rebuild-index would
      await createVectorPool(c, DIM);
      await c.query(`INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ('scale', 0, 'db')`);
      const load = async (storeId: string, index: string, from: number, count: number) => {
        await c.query(chunkInsertSql(storeId, index, 'clustered', DIM, WORDS, from, count));
      };
      /* eslint-disable no-await-in-loop */
      for (const [id, index, size] of [['vs-0', '0', 12000], ['vs-1', '1', 3000], ['vs-2', '2', 300], ['vs-m', 'm', 6000]] as const) {
        await insertFiles(c, id, index, size);
        await load(id, index, 0, size);
      }
      await c.query("UPDATE vector_stores SET embedding_model = 'model-b' WHERE id = 'vs-m'");
      // A re-embed in flight: generation 1 active, 0 left behind, 2 being written; 4000 chunks each.
      await insertFiles(c, 'vs-re', 're', 12000);
      await load('vs-re', 're', 0, 4000);
      await c.query("UPDATE vector_store_chunks SET generation = 2 WHERE store_id = 'vs-re'");
      await load('vs-re', 're', 4000, 4000);
      await c.query("UPDATE vector_store_chunks SET generation = 1 WHERE store_id = 'vs-re' AND generation = 0");
      await load('vs-re', 're', 8000, 4000);
      await c.query("UPDATE vector_stores SET active_generation = 1 WHERE id = 'vs-re'");
      /* eslint-enable no-await-in-loop */
      await c.query('SET max_parallel_maintenance_workers = 0');
      await c.query(`CREATE INDEX idx_chunks_hnsw ON vector_store_chunks ${halfvecIndexDefinition(DIM)}`);
      await c.query('ANALYZE');
    } finally {
      c.release();
    }
  }, 300_000);

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => {
    mockConfig = {
      embeddingDimensions: DIM, ann: { ...ANN_ON },
      hybrid: { rrfK: 60, lexicalEnabled: false, lexicalQuery: 'any', candidates: 50 },
    };
    __resetRecallSettingsForTests();
    __resetLexicalBoundForTests(); // the table size and arm counts are cached; each test reads its own
    log = [];
    pgvectorVersion = null;
    rewrite = null;
    showBeforeMain = false;
    settingsBeforeMain = null;
  });

  async function queryVectors(n: number): Promise<number[][]> {
    const s = vectorSelect('clustered', DIM, 0, n);
    const { rows } = await fixture.pool.query(`${s.picks}
SELECT (${s.v})::real[] AS v FROM p ${s.joins} ORDER BY p.s`);
    return rows.map((r: any) => r.v.map(Number));
  }

  let vectors: number[][] = [];
  beforeAll(async () => { vectors = await queryVectors(24); });

  const opts = (extra: Partial<RecallOptions> = {}): RecallOptions => ({
    storeIds: ['vs-0'], ownerEmail: OWNER, queryText: 'lx1 lx2', queryEmbedding: vectors[0], limit: 50, ...extra,
  });

  /** recall as shipped with approximate search off: the exact reference. */
  async function exact(o: RecallOptions): Promise<CandidateChunk[]> {
    const saved = mockConfig.ann;
    mockConfig.ann = { ...saved, enabled: false };
    try {
      return await recallCandidates(o);
    } finally {
      mockConfig.ann = saved;
      log = [];
    }
  }

  const statements = () => ({
    ann: log.filter((l) => isAnn(l.sql)),
    count: log.filter((l) => isCount(l.sql)),
    main: log.filter((l) => isMain(l.sql)),
  });

  it('an arm over a large store reads idx_chunks_hnsw, scores at full precision and re-sorts', async () => {
    const result = await recallCandidates(opts());
    const { ann, count, main } = statements();
    expect(count).toHaveLength(1);
    expect(ann).toHaveLength(1);
    expect(main).toHaveLength(0); // the only arm came from the index and there is no full-text arm
    expect(ann[0].sql).toContain(`ORDER BY c.embedding::halfvec(${DIM}) <=> $3::halfvec(${DIM})\n    LIMIT $4`);
    expect(ann[0].sql).toContain('c.embedding <=> $3::vector AS score');
    expect(log.some((l) => l.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ')).toBe(true);

    expect(result).toHaveLength(50);
    expect(result.map((r) => r.vectorRank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const scores = result.map((r) => r.vectorScore!);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);

    const client = await pool.connect();
    try {
      await rawQuery(client, 'BEGIN');
      await rawQuery(client, `SET LOCAL jit = off; ${annSessionSettings(50)}`);
      const { rows } = await rawQuery(client, `EXPLAIN (ANALYZE, FORMAT JSON) ${ann[0].sql}`, ann[0].params);
      const all = nodes(rows[0]['QUERY PLAN'][0].Plan);
      const limit = all.find((n) => n['Node Type'] === 'Limit');
      expect(nodes(limit).filter((n) => n['Index Name'] === 'idx_chunks_hnsw')).toHaveLength(1);
      expect(all.filter((n) => n['Relation Name'] === 'vector_store_chunks' && /Seq Scan/.test(n['Node Type']))).toEqual([]);
    } finally {
      await rawQuery(client, 'ROLLBACK');
      client.release();
    }
  });

  it('finds what the exact search finds on clustered data (tie-aware recall@50, 20 queries over two stores)', async () => {
    const recalls: number[] = [];
    let served = 0;
    for (const storeId of ['vs-0', 'vs-re']) {
      for (const v of vectors.slice(0, 10)) {
        const o = opts({ storeIds: [storeId], queryEmbedding: v });
        // eslint-disable-next-line no-await-in-loop
        const truth = await exact(o);
        // eslint-disable-next-line no-await-in-loop
        const got = await recallCandidates(o);
        const { ann, main } = statements();
        if (ann.length === 1 && main.length === 0) served += 1;
        const rows = (r: CandidateChunk[]) => r.map((x) => ({ id: `${x.storeId}/${x.fileId}/${x.ord}`, score: x.vectorScore! }));
        expect(got).toHaveLength(truth.length);
        recalls.push(probe.tieAwareRecall(rows(truth), rows(got)));
        log = [];
      }
    }
    const mean = recalls.reduce((s, r) => s + r, 0) / recalls.length;
    expect(served).toBe(20);
    expect(mean).toBeGreaterThanOrEqual(0.9);
  });

  it('never returns fewer chunks than the exact search: a short candidate set runs the arm exactly', async () => {
    mockConfig.ann = { enabled: true, exactMaxChunks: 0, minFraction: 0 };
    const o = opts({ storeIds: ['vs-2'], limit: 400 });
    const truth = await exact(o);
    const got = await recallCandidates(o);
    const { ann, main } = statements();
    expect(ann).toHaveLength(1);
    expect(ann[0].rows.length).toBeLessThan(400);
    expect(main).toHaveLength(1);
    expect(main[0].sql).not.toContain('AND false');
    expect(truth).toHaveLength(300);
    expect(got).toEqual(truth);
  });

  it('a failed approximate statement costs the approximate path, not the search', async () => {
    rewrite = (sql) => (isAnn(sql) ? 'SELECT 1 / 0' : sql);
    const o = opts();
    const truth = await exact(o);
    const got = await recallCandidates(o);
    expect(statements().main).toHaveLength(1);
    expect(got).toEqual(truth);
  });

  it('a failed savepoint restore after a failed approximate statement fails the search with the original error', async () => {
    // the index arm's statement fails (division by zero, using all five of its parameters - $5 the caller's team
    // ids), then its savepoint is gone
    const failing = 'SELECT 1 / 0 WHERE $1::text[] IS NOT NULL AND $2::text IS NOT NULL AND $3::text IS NOT NULL AND $4::int > 0'
      + ' AND $5::text[] IS NOT NULL';
    rewrite = (sql) => (isAnn(sql) ? failing : sql === 'ROLLBACK TO SAVEPOINT ann_arm' ? 'ROLLBACK TO SAVEPOINT no_such' : sql);
    await expect(recallCandidates(opts())).rejects.toMatchObject({ code: '22012' }); // division_by_zero, not 3B001
    expect(statements().main).toEqual([]);
  });

  it('the approximate settings never reach the main statement of the same transaction', async () => {
    mockConfig.hybrid.lexicalEnabled = true; // the full-text arm keeps the main statement after the index arm
    showBeforeMain = true;
    await recallCandidates(opts());
    expect(statements().ann).toHaveLength(1);
    expect(statements().main).toHaveLength(1);
    // recall's own settings (applyRecallSettings: ef_search clamp(2 x 50, 100, 1000), strict_order), not the index arm's
    expect(settingsBeforeMain).toEqual({
      enable_sort: 'on', enable_seqscan: 'on', enable_bitmapscan: 'on', ef_search: '100', iterative_scan: 'strict_order',
    });
  });

  it('keeps the tenant boundary: another owner gets nothing from an unshared store, and the shared store through the index', async () => {
    const other = 'other@bench.invalid';
    try {
      const got = await recallCandidates(opts({ ownerEmail: other }));
      expect(got).toEqual([]);
      expect(statements().count[0].rows[0].n).toBe(0);
      expect(statements().ann).toEqual([]);
      log = [];
      await fixture.pool.query("UPDATE vector_stores SET is_shared = true WHERE id = 'vs-0'");
      const truth = await exact(opts({ ownerEmail: other }));
      // Within the minute the count of 0 is remembered: the arm stays exact, with the exact answer.
      expect(await recallCandidates(opts({ ownerEmail: other }))).toEqual(truth);
      expect(statements().count).toEqual([]);
      expect(statements().ann).toEqual([]);
      log = [];
      __resetLexicalBoundForTests(); // a minute later
      const shared = await recallCandidates(opts({ ownerEmail: other }));
      expect(statements().ann).toHaveLength(1);
      expect(statements().main).toEqual([]);
      expect(shared).toHaveLength(50);
      expect(shared.every((c) => c.storeId === 'vs-0')).toBe(true);
      const ids = (r: CandidateChunk[]) => r.map((x) => ({ id: `${x.fileId}/${x.ord}`, score: x.vectorScore! }));
      expect(probe.tieAwareRecall(ids(truth), ids(shared))).toBeGreaterThanOrEqual(0.9);
      // the owner's own view is the same set
      expect(ids(await recallCandidates(opts()))).toEqual(ids(shared));
    } finally {
      await fixture.pool.query("UPDATE vector_stores SET is_shared = false WHERE id = 'vs-0'");
    }
  });

  it('a store shared with a team reaches its members through the index, and nobody else (spec 2026-10-14 §8)', async () => {
    const other = 'member@bench.invalid';
    const team = 'team-ann-1';
    await fixture.pool.query(
      "INSERT INTO vector_store_team_shares (store_id, team_id, shared_by) VALUES ('vs-0', $1, 'owner@bench.invalid')", [team]);
    try {
      __resetLexicalBoundForTests();
      log = [];
      expect(await recallCandidates(opts({ ownerEmail: other, teamIds: ['team-ann-2'] }))).toEqual([]);
      expect(statements().ann).toEqual([]);
      log = [];
      const truth = await exact(opts({ ownerEmail: other, teamIds: [team] }));
      log = [];
      const member = await recallCandidates(opts({ ownerEmail: other, teamIds: [team] }));
      // A count for another team set is not reused: this team set counts again, and goes approximate.
      expect(statements().count).toHaveLength(1);
      expect(statements().ann).toHaveLength(1);
      expect(member).toHaveLength(50);
      expect(member.every((c) => c.storeId === 'vs-0')).toBe(true);
      const ids = (r: CandidateChunk[]) => r.map((x) => ({ id: `${x.fileId}/${x.ord}`, score: x.vectorScore! }));
      expect(probe.tieAwareRecall(ids(truth), ids(member))).toBeGreaterThanOrEqual(0.9);
    } finally {
      await fixture.pool.query('DELETE FROM vector_store_team_shares WHERE store_id = $1', ['vs-0']);
    }
  });

  it.each([
    ['an attribute filter', { filter: { type: 'eq', key: 'kind', value: 'x' } }],
    ['a store of at most exact_max_chunks chunks', { storeIds: ['vs-2'] }],
  ])('stays exact for %s, with the same result as with approximate search off', async (_label, extra) => {
    const o = opts(extra as Partial<RecallOptions>);
    const truth = await exact(o);
    const got = await recallCandidates(o);
    expect(statements().ann).toEqual([]);
    expect(statements().main).toHaveLength(1);
    expect(got).toEqual(truth);
  });

  it('with an attribute filter it does not even count the chunks', async () => {
    await recallCandidates(opts({ filter: { type: 'eq', key: 'kind', value: 'x' } }));
    expect(statements().count).toEqual([]);
  });

  it('min_fraction: a store below the share of the table stays exact, at it goes approximate', async () => {
    const { rows } = await fixture.pool.query("SELECT reltuples FROM pg_class WHERE oid = 'vector_store_chunks'::regclass");
    const table = Number(rows[0].reltuples);
    expect(table).toBe(12000 + 3000 + 300 + 6000 + 12000);
    mockConfig.ann = { enabled: true, exactMaxChunks: 1000, minFraction: 3001 / table };
    await recallCandidates(opts({ storeIds: ['vs-1'] }));
    expect(statements().count[0].rows[0].n).toBe(3000);
    expect(statements().ann).toEqual([]);
    log = [];
    mockConfig.ann = { enabled: true, exactMaxChunks: 1000, minFraction: 2999 / table };
    await recallCandidates(opts({ storeIds: ['vs-1'] }));
    expect(statements().ann).toHaveLength(1);
  });

  it('exact_max_chunks counts the active generation only: during a re-embed the boundary is its 4000 chunks', async () => {
    mockConfig.ann = { enabled: true, exactMaxChunks: 4000, minFraction: 0 };
    await recallCandidates(opts({ storeIds: ['vs-re'] }));
    expect(statements().count[0].rows[0].n).toBe(4000);
    expect(statements().ann).toEqual([]);
    log = [];
    mockConfig.ann = { enabled: true, exactMaxChunks: 3999, minFraction: 0 };
    const got = await recallCandidates(opts({ storeIds: ['vs-re'], limit: 200 }));
    expect(statements().ann).toHaveLength(1);
    expect(statements().main).toEqual([]);
    expect(got).toHaveLength(200);
    // the active generation's chunks are the files f-re-80 .. f-re-159
    for (const chunk of got) {
      expect(Number(chunk.fileId.split('-')[2])).toBeGreaterThanOrEqual(80);
      expect(Number(chunk.fileId.split('-')[2])).toBeLessThan(160);
    }
  });

  it('decides per arm: one arm per model, the large one approximate, the small one and a stale model exact', async () => {
    mockConfig.hybrid.lexicalEnabled = true;
    const o = opts({
      storeIds: ['vs-2', 'vs-m', 'vs-1'],
      queryEmbedding: undefined,
      vectorArms: [
        { storeIds: ['vs-2'], queryEmbedding: vectors[1], model: 'bench-model' },
        { storeIds: ['vs-m'], queryEmbedding: vectors[2], model: 'model-b' },
        { storeIds: ['vs-1'], queryEmbedding: vectors[3], model: 'model-z' }, // vs-1 is not on model-z: no chunk
      ],
    });
    const truth = await exact(o);
    const got = await recallCandidates(o);
    const { ann, count, main } = statements();
    expect(count.map((c) => c.rows[0].n)).toEqual([300, 1001, 0]); // counted up to exact_max_chunks + 1
    expect(ann).toHaveLength(1);
    expect(ann[0].rows.every((r: any) => r.source === 'vec1' && r.store_id === 'vs-m')).toBe(true);
    expect(main).toHaveLength(1);
    expect(main[0].sql.match(/vec1 AS \([\s\S]*?\n\)/)![0]).toContain('AND false');
    expect(main[0].sql.match(/\bvec AS \([\s\S]*?\n\)/)![0]).not.toContain('AND false');
    expect(main[0].rows.filter((r: any) => r.source === 'vec1')).toEqual([]);
    // The exact arm and the full-text arm are those of the exact search; vs-m's 50 vector hits come from the index.
    const vecHits = (r: CandidateChunk[], storeId: string) => r.filter((x) => x.storeId === storeId && x.vectorRank !== undefined)
      .map((x) => [x.fileId, x.ord, x.vectorRank, x.vectorScore]).sort();
    expect(vecHits(got, 'vs-2')).toEqual(vecHits(truth, 'vs-2'));
    expect(vecHits(got, 'vs-1')).toEqual([]);
    expect(got.filter((x) => x.lexicalRank !== undefined).length).toBeGreaterThan(0);
  });

  it('stays exact on pgvector before 0.8', async () => {
    pgvectorVersion = '0.7.4';
    const o = opts();
    const got = await recallCandidates(o);
    expect(statements()).toEqual({ ann: [], count: [], main: [expect.anything()] });
    pgvectorVersion = null;
    __resetRecallSettingsForTests();
    expect(got).toEqual(await exact(o));
  });

  it('with approximate search off it sends what it sent before: no check, no count, a plain transaction', async () => {
    mockConfig.ann = { ...ANN_ON, enabled: false };
    await recallCandidates(opts());
    expect(log.map((l) => l.sql).filter((s) => !/^SET LOCAL|^SAVEPOINT|^RELEASE|^COMMIT/.test(s)))
      .toEqual(['SELECT extversion FROM pg_extension WHERE extname = \'vector\'', 'BEGIN', expect.stringContaining(' AS source, ')]);
    delete mockConfig.ann; // a configuration without the block is off too
    log = [];
    await recallCandidates(opts());
    expect(statements().count).toEqual([]);
    expect(statements().ann).toEqual([]);
  });

  // Last: these replace the index.
  describe('the index', () => {
    const replaceIndex = async (sql: string | null) => {
      await fixture.pool.query('DROP INDEX IF EXISTS idx_chunks_hnsw');
      if (sql) await fixture.pool.query(sql);
    };
    afterAll(async () => {
      await replaceIndex(`CREATE INDEX idx_chunks_hnsw ON vector_store_chunks ${halfvecIndexDefinition(DIM)}`);
    }, 300_000);

    it.each([
      ['the previous kind (vector, pgvector defaults)', 'CREATE INDEX idx_chunks_hnsw ON vector_store_chunks USING hnsw (embedding vector_cosine_ops)'],
      ['missing', null],
      ['invalid', `CREATE INDEX idx_chunks_hnsw ON vector_store_chunks ${halfvecIndexDefinition(DIM)}`],
    ])('stays exact while it is %s', async (label, sql) => {
      await replaceIndex(sql);
      if (label === 'invalid') {
        // what a failed or interrupted CREATE INDEX CONCURRENTLY leaves (the test role is a superuser)
        await fixture.pool.query(`UPDATE pg_index SET indisvalid = false
          WHERE indexrelid = (SELECT i.indexrelid FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                               WHERE i.indrelid = 'vector_store_chunks'::regclass AND ic.relname = 'idx_chunks_hnsw')`);
      }
      const o = opts();
      const truth = await exact(o);
      const got = await recallCandidates(o);
      expect(statements().ann).toEqual([]);
      expect(statements().count).toEqual([]);
      expect(got).toEqual(truth);
    }, 300_000);

    it('goes approximate again once the halfvec index is back', async () => {
      await replaceIndex(`CREATE INDEX idx_chunks_hnsw ON vector_store_chunks ${halfvecIndexDefinition(DIM)}`);
      await recallCandidates(opts());
      expect(statements().ann).toHaveLength(1);
    }, 300_000);
  });
});
