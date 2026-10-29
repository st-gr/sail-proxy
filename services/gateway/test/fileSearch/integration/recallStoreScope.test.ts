// Recall on an install with few stores (W4, Task 0 concern 1): every arm reads its stores' chunks through
// the store index, not by scanning the whole table.
//
// Each arm resolves the readable store ids inside the statement (`c.store_id = ANY(ARRAY(SELECT …))`). That
// array is computed at run time, so the planner guesses its selectivity from the column's distinct count:
// with few stores, "a large share of the table", and a small store's search became a (parallel) scan of every
// chunk - 529 ms for a 2,000-chunk store beside a 1M one in the scale bench, 13 ms with 200 other stores.
// Every arm now also states `c.store_id = ANY($1)` (the requested ids, a bound value the planner reads the
// store statistics for). The predicate is implied by the sub-select, so no row changes: checked here against
// the statement without it, on the same data.
import { Client, Pool, PoolClient } from 'pg';
import { getPool, __resetForTests } from '../../../src/fileSearch/db';
import { recallCandidates, RecallOptions, __resetRecallSettingsForTests, OR_QUERY_SQL } from '../../../src/fileSearch/repository';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const DIM = 8;
const BIG = 25000;
const SMALL = 500;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

const rawQuery = (client: PoolClient, sql: string, params?: any[]): Promise<any> =>
  (Client.prototype.query as any).call(client, sql, params);

/** The statement as it was before W4: the same, without the store-id line each arm now starts with. */
const HINT = /c\.store_id = ANY\(\$\d+\)\n {6}AND c\.store_id = ANY\(ARRAY\(/g;
const withoutHint = (sql: string): string => sql.replace(HINT, 'c.store_id = ANY(ARRAY(');

function nodes(plan: any, out: any[] = []): any[] {
  out.push(plan);
  for (const child of plan.Plans ?? []) nodes(child, out);
  return out;
}

d('recall on an install with few stores reads only the searched stores (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let captured: { sql: string; params: any[] } | null = null;

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
        if (Array.isArray(params) && sql !== OR_QUERY_SQL) captured = { sql, params };
        return rawQuery(client, sql, params);
      };
      return client;
    });

    const f = fixture.pool;
    await f.query('DROP INDEX idx_chunks_hnsw'); // not under test; makes the load fast
    await f.query(`INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ('b', 1, 'inline')`);
    const sizes = [BIG, BIG, BIG, BIG, SMALL];
    for (const [i, n] of sizes.entries()) {
      const files = Math.ceil(n / 50);
      /* eslint-disable no-await-in-loop */
      await f.query(`INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim)
                     VALUES ('s${i}', 'owner@example.com', 'm', ${DIM})`);
      await f.query(`INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
                     SELECT 'f${i}-' || g, 'owner@example.com', 'f' || g || '.txt', 'assistants', 'b', 1
                       FROM generate_series(0, ${files - 1}) g`);
      await f.query(`INSERT INTO vector_store_files (store_id, file_id, status, attributes)
                     SELECT 's${i}', 'f${i}-' || g, 'completed', jsonb_build_object('n', g % 3)
                       FROM generate_series(0, ${files - 1}) g`);
      await f.query(`INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding)
                     SELECT 's${i}', 'f${i}-' || (g / 50), g % 50,
                            'alpha ' || (CASE WHEN g % 7 = 0 THEN 'bravo ' ELSE '' END) || 'w' || (g % 1000),
                            (SELECT array_agg(round((random() * 2 - 1)::numeric, 2)) FROM generate_series(1, ${DIM} + 0 * g))::float4[]::vector
                       FROM generate_series(0, ${n - 1}) g`);
      /* eslint-enable no-await-in-loop */
    }
    await f.query('ANALYZE');
  }, 180_000);

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => {
    mockConfig = { embeddingDimensions: DIM, hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50 } };
    __resetRecallSettingsForTests();
    captured = null;
  });

  const query = (extra: Partial<RecallOptions> = {}): RecallOptions => ({
    storeIds: ['s4'], ownerEmail: 'owner@example.com', queryText: 'alpha bravo', limit: 50,
    queryEmbedding: [0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, -0.8], ...extra,
  });

  async function explain(sql: string, params: any[]): Promise<any> {
    const client = await pool.connect();
    try {
      await rawQuery(client, 'BEGIN');
      await rawQuery(client, 'SET LOCAL jit = off');
      const { rows } = await rawQuery(client, `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
      return rows[0]['QUERY PLAN'][0].Plan;
    } finally {
      await rawQuery(client, 'ROLLBACK');
      client.release();
    }
  }

  async function run(sql: string, params: any[]): Promise<any[]> {
    const client = await pool.connect();
    try {
      return (await rawQuery(client, sql, params)).rows;
    } finally {
      client.release();
    }
  }

  /** The chunk-table scans below each arm's Limit. */
  const chunkScans = (plan: any): any[] => nodes(plan)
    .filter((n) => n['Node Type'] === 'Limit')
    .flatMap((limit) => nodes(limit).filter((n) => n['Relation Name'] === 'vector_store_chunks'));

  it.each([
    ['vector only', false, undefined, undefined],
    ['vector and lexical (OR and AND arms)', true, 'any', undefined],
    ['vector and lexical ("all")', true, 'all', undefined],
    ['with an attribute filter', true, 'any', { type: 'eq', key: 'n', value: 1 }],
  ])('%s: the small store is read through a store index, and the rows are the same as without the store-id line',
    async (_label, lexical, lexicalQuery, filter) => {
      mockConfig.hybrid.lexicalEnabled = lexical;
      if (lexicalQuery) mockConfig.hybrid.lexicalQuery = lexicalQuery;
      const opts = query({ filter });
      await recallCandidates(opts);
      const { sql, params } = captured!;
      expect(sql.match(HINT)).toHaveLength(lexical ? (lexicalQuery === 'all' ? 2 : 3) : 1);

      const scans = chunkScans(await explain(sql, params));
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        // a Bitmap Heap Scan names no index itself; its Bitmap Index Scan child does
        const indexes = nodes(scan).map((n) => n['Index Name']).filter(Boolean);
        expect({ node: scan['Node Type'], indexes })
          .toEqual({ node: expect.stringMatching(/^(Index Scan|Index Only Scan|Bitmap Heap Scan)$/), indexes: expect.arrayContaining([expect.stringMatching(/^idx_chunks_/)]) });
      }

      const before = await run(withoutHint(sql), params);
      const after = await run(sql, params);
      expect(after.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    });

  // The assertion above can fail: the statement without the store-id line scans the whole table.
  it('without the store-id line the same statement scans the whole chunk table', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    await recallCandidates(query());
    const scans = chunkScans(await explain(withoutHint(captured!.sql), captured!.params));
    expect(scans.map((s) => s['Node Type'])).toEqual([expect.stringMatching(/Seq Scan$/)]);
  });

  it('a search that includes a big store returns the same rows', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    const opts = query({ storeIds: ['s0', 's4'] });
    await recallCandidates(opts);
    const { sql, params } = captured!;
    expect(await run(sql, params)).toEqual(await run(withoutHint(sql), params));
  });
});
