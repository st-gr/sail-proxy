// The full-text OR arm's bound on large searches (W4, lexicalBound.ts): a search over more than exact_max_chunks
// chunks leaves the table's common lexemes out of its OR query and ranks a bounded set; every other search sends
// today's statements and gets today's result.
import { Client, Pool, PoolClient } from 'pg';
import { getPool, __resetForTests } from '../../../src/fileSearch/db';
import {
  recallCandidates, RecallOptions, CandidateChunk, __resetRecallSettingsForTests, OR_QUERY_SQL, BOUNDED_OR_QUERY_SQL,
} from '../../../src/fileSearch/repository';
import { COMMON_LEXEMES_SQL, commonLexemes, __resetLexicalBoundForTests } from '../../../src/fileSearch/lexicalBound';
import { STOP_WORDS } from '../../../src/fileSearch/stopWords';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const DIM = 8;
const OWNER = 'owner@example.invalid';
const BIG = 8000; // vs-big's chunks besides its three "both" chunks
const ANN = { enabled: false, exactMaxChunks: 2000, minFraction: 0.05 };

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

const isMain = (sql: string) => sql.includes(' AS source, ');

d('full-text bound on large searches (requires FILE_SEARCH_TEST_DSN pointing at pgvector)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let log: Array<{ sql: string; params?: any[]; rows: any[] }> = [];
  let explain = false;
  let plan: any = null;
  // Statements the wrapper runs on recall's connection right before its main statement (planner pressure).
  let beforeMain: string[] = [];
  // Rewrites recall's main statement before it runs (the canary below).
  let rewriteMain: ((sql: string) => string) | null = null;
  // The scan settings on recall's connection: before BEGIN, right before the main statement, after COMMIT.
  let scanSettings: Record<string, string>[] = [];
  const SHOW_SCAN = `SELECT current_setting('synchronize_seqscans') AS sync,
    current_setting('max_parallel_workers_per_gather') AS workers`;

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
        if (sql === 'BEGIN') scanSettings.push((await rawQuery(client, SHOW_SCAN)).rows[0]);
        if (typeof sql === 'string' && isMain(sql)) {
          for (const s of beforeMain) await rawQuery(client, s); // eslint-disable-line no-await-in-loop
          scanSettings.push((await rawQuery(client, SHOW_SCAN)).rows[0]);
        }
        if (rewriteMain && typeof sql === 'string' && isMain(sql)) sql = rewriteMain(sql); // eslint-disable-line no-param-reassign
        if (explain && typeof sql === 'string' && isMain(sql)) {
          plan = (await rawQuery(client, `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0].Plan;
        }
        const result = await rawQuery(client, sql, params);
        log.push({ sql, params, rows: result.rows ?? [] });
        if (sql === 'COMMIT') scanSettings.push((await rawQuery(client, SHOW_SCAN)).rows[0]);
        return result;
      };
      return client;
    });

    const c = fixture.pool;
    // No autovacuum: the first tests run on a table that was vacuumed (its size is known) but never analysed.
    await c.query('ALTER TABLE vector_store_chunks SET (autovacuum_enabled = false)');
    await c.query(`INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ('seedblob', 1, 'inline')`);
    await c.query(`INSERT INTO vector_stores (id, owner_email, is_shared, embedding_model, embedding_dim)
      VALUES ('vs-big', $1, false, 'm', ${DIM}), ('vs-small', $1, false, 'm', ${DIM})`, [OWNER]);
    const files = async (store: string, n: number) => {
      await c.query(`INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
        SELECT $1 || '-f' || g, 'seed@example.invalid', $1 || '-f' || g || '.txt', 'assistants', 'seedblob', 1
          FROM generate_series(0, $2 - 1) g`, [store, n]);
      await c.query(`INSERT INTO vector_store_files (store_id, file_id, status)
        SELECT $1, $1 || '-f' || g, 'completed' FROM generate_series(0, $2 - 1) g`, [store, n]);
    };
    const chunks = async (store: string, from: number, to: number, text: string) => {
      await c.query(`INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding, generation, context, context_tsv)
        SELECT $1, $1 || '-f' || (g / 100), g % 100, ${text}, ('[' || (g % 7 + 1) || ',1,0,0,0,0,0,1]')::vector, 0,
               CASE WHEN g % 10 = 0 THEN 'handbook' END, CASE WHEN g % 10 = 0 THEN to_tsvector('simple', 'handbook') END
          FROM generate_series($2::int, $3::int) g`, [store, from, to]);
    };
    // vs-big: 'alpha' everywhere, 'evenw'/'oddw' in every other chunk, 'delta' in 2 %, rarer w<n> words; then
    // three chunks with every one of those common words and 'needle', last in the table.
    await files('vs-big', BIG / 100 + 1);
    await chunks('vs-big', 0, BIG - 1, `'alpha ' || CASE WHEN g % 2 = 0 THEN 'evenw' ELSE 'oddw' END || ' w' || (g % 97)
      || ' w' || (g % 89) || CASE WHEN g % 50 = 0 THEN ' delta' ELSE '' END`);
    await files('vs-small', 5);
    await chunks('vs-small', 0, 499, `'alpha evenw w' || (g % 13) || CASE WHEN g % 250 = 0 THEN ' needle' ELSE '' END`);
    await chunks('vs-big', BIG, BIG + 2, "'alpha evenw oddw needle w1'");
    await c.query('VACUUM vector_store_chunks');
  }, 120_000);

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => {
    mockConfig = {
      embeddingDimensions: DIM, ann: { ...ANN },
      hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50 },
    };
    __resetRecallSettingsForTests();
    __resetLexicalBoundForTests();
    log = [];
    explain = false;
    plan = null;
    beforeMain = [];
    rewriteMain = null;
    scanSettings = [];
  });

  const opts = (storeId: string, queryText: string): RecallOptions => ({
    storeIds: [storeId], ownerEmail: OWNER, queryText, queryEmbedding: [1, 1, 0, 0, 0, 0, 0, 1], limit: 50,
  });
  const BOTH = ['vs-big/vs-big-f80/0', 'vs-big/vs-big-f80/1', 'vs-big/vs-big-f80/2'];
  const id = (r: CandidateChunk) => `${r.storeId}/${r.fileId}/${r.ord}`;
  /** The full-text arm's ranking, from the main statement's rows (the fused result keeps only the top `limit`). */
  const lexRanking = (statement: { rows: any[] }) => statement.rows.filter((r) => r.source === 'lex')
    .sort((a, b) => Number(a.rnk) - Number(b.rnk)).map((r) => `${r.store_id}/${r.file_id}/${r.ord}`);
  const orStatement = () => log.filter((l) => l.sql === OR_QUERY_SQL || l.sql === BOUNDED_OR_QUERY_SQL);
  const main = () => log.filter((l) => isMain(l.sql));

  /** recall as it was before the bound: no file_search.ann, so no exact_max_chunks. */
  async function unbounded(o: RecallOptions): Promise<{ result: CandidateChunk[]; main: any; plan: any }> {
    const saved = mockConfig;
    mockConfig = { ...saved, ann: undefined };
    log = [];
    try {
      const result = await recallCandidates(o);
      return { result, main: main()[0], plan };
    } finally {
      mockConfig = saved;
      log = [];
      __resetLexicalBoundForTests();
    }
  }

  it('never analysed: nothing is left out of the OR query, the ranked set is still bounded', async () => {
    const { rows } = await fixture.pool.query(COMMON_LEXEMES_SQL);
    expect(commonLexemes(rows, 0.05)).toEqual([]);
    await recallCandidates(opts('vs-big', 'alpha needle'));
    const mine = main()[0];
    expect(orStatement().map((l) => [l.sql, l.params![2]])).toEqual([[BOUNDED_OR_QUERY_SQL, []]]);
    expect(mine.sql).toContain('LIMIT 5000');
    expect(mine.params).toContain("'alpha' | 'needle'");
    const today = await unbounded(opts('vs-big', 'alpha needle'));
    expect(today.main.sql).not.toContain('LIMIT 5000');
    // The chunks with both terms rank first either way.
    expect(lexRanking(mine).slice(0, 3).sort()).toEqual(BOTH);
    expect(lexRanking(today.main).slice(0, 3).sort()).toEqual(BOTH);
    expect(lexRanking(mine)).toHaveLength(50);
  });

  describe('after ANALYZE', () => {
    beforeAll(async () => { await fixture.pool.query('ANALYZE vector_store_chunks'); });

    it('reads the common lexemes of this table from pg_stats', async () => {
      const { rows } = await fixture.pool.query(COMMON_LEXEMES_SQL);
      const common = commonLexemes(rows, 0.05);
      expect(common).toEqual(expect.arrayContaining(['alpha', 'evenw', 'oddw']));
      expect(common).not.toContain('needle');
      expect(common).not.toContain('delta');
      // context_tsv: 'handbook' is in every context, but only 10 % of the chunks have one.
      expect(commonLexemes(rows.filter((r: any) => r.attname === 'context_tsv'), 0.05)).toEqual(['handbook']);
      expect(commonLexemes(rows.filter((r: any) => r.attname === 'context_tsv'), 0.2)).toEqual([]);
    });

    it('BOUNDED_OR_QUERY_SQL: OR_QUERY_SQL\'s queries without common lexemes; only the OR query loses them', async () => {
      const questions = [
        'What port does the service use?', 'alpha needle', "it's a \\quoted' path/to/x sail-proxy", '', 'the and of',
        Array.from({ length: 40 }, (_, i) => `t${40 - i}`).join(' '), 'Ünïcode wörter straße 東京', 'a b c dd',
      ];
      for (const q of questions) {
        /* eslint-disable no-await-in-loop */
        const today = (await fixture.pool.query(OR_QUERY_SQL, [q, STOP_WORDS])).rows[0];
        const none = (await fixture.pool.query(BOUNDED_OR_QUERY_SQL, [q, STOP_WORDS, []])).rows[0];
        expect(none).toEqual(today);
        /* eslint-enable no-await-in-loop */
      }
      const today = (await fixture.pool.query(OR_QUERY_SQL, ['alpha needle evenw', STOP_WORDS])).rows[0];
      const dropped = (await fixture.pool.query(BOUNDED_OR_QUERY_SQL, ['alpha needle evenw', STOP_WORDS, ['alpha', 'evenw']])).rows[0];
      expect(dropped).toEqual({ q: "'needle'", q_and: today.q_and });
      // Every term common: none is left out.
      const all = (await fixture.pool.query(BOUNDED_OR_QUERY_SQL, ['alpha evenw', STOP_WORDS, ['alpha', 'evenw']])).rows[0];
      expect(all).toEqual((await fixture.pool.query(OR_QUERY_SQL, ['alpha evenw', STOP_WORDS])).rows[0]);
    });

    it('a table of at most exact_max_chunks chunks (a W1-sized install): today\'s statements and result', async () => {
      mockConfig.ann.exactMaxChunks = 20000;
      const result = await recallCandidates(opts('vs-big', 'alpha needle'));
      expect(orStatement().map((l) => l.sql)).toEqual([OR_QUERY_SQL]);
      expect(log.filter((l) => /AS searched|pg_stats/.test(l.sql))).toEqual([]);
      const sent = main()[0];
      const today = await unbounded(opts('vs-big', 'alpha needle'));
      expect(sent.sql).toBe(today.main.sql);
      expect(sent.params).toEqual(today.main.params);
      expect(result).toEqual(today.result);
    });

    it('a small store in a large table: today\'s statements and result', async () => {
      const result = await recallCandidates(opts('vs-small', 'alpha needle'));
      expect(log.filter((l) => l.sql.includes('AS searched')).map((l) => l.rows[0].searched)).toEqual([500]);
      expect(orStatement().map((l) => l.sql)).toEqual([OR_QUERY_SQL]);
      const sent = main()[0];
      const today = await unbounded(opts('vs-small', 'alpha needle'));
      expect(sent.sql).toBe(today.main.sql);
      expect(sent.params).toEqual(today.main.params);
      expect(result).toEqual(today.result);
      expect(lexRanking(sent)).toHaveLength(50);
    });

    it('a large store: the common term leaves the OR query, the AND query keeps it', async () => {
      const result = await recallCandidates(opts('vs-big', 'alpha needle'));
      const mine = main()[0];
      const [or] = orStatement();
      expect(or.sql).toBe(BOUNDED_OR_QUERY_SQL);
      expect(or.params![2]).toEqual(expect.arrayContaining(['alpha', 'evenw', 'oddw']));
      expect(or.rows[0]).toEqual({ q: "'needle'", q_and: "'alpha' & 'needle'" });
      const today = await unbounded(opts('vs-big', 'alpha needle'));
      expect(today.main.params.slice(-2)).toEqual(["'alpha' | 'needle'", "'alpha' & 'needle'"]);
      // AND finds 3 (< 50), so the OR arm runs: today it ranks every chunk with 'alpha'; bounded, the chunks with
      // 'needle', which are the three AND found.
      expect(lexRanking(mine).sort()).toEqual(BOTH);
      expect(lexRanking(today.main)).toHaveLength(50);
      expect(lexRanking(today.main).slice(0, 3).sort()).toEqual(BOTH);
      // The vector arm is untouched.
      const vec = (statement: { rows: any[] }) => statement.rows.filter((r) => r.source === 'vec');
      expect(vec(mine)).toHaveLength(50);
      expect(vec(mine)).toEqual(vec(today.main));
      expect(result.filter((r) => r.lexicalRank !== undefined).map(id).sort()).toEqual(BOTH);
    });

    it('every term common: the OR arm ranks at most the ceiling, plus every chunk with all the terms', async () => {
      explain = true;
      await recallCandidates(opts('vs-big', 'evenw oddw'));
      const mine = main()[0];
      expect(orStatement()[0].rows[0].q).toBe("'evenw' | 'oddw'");
      const ranked = nodes(plan).filter((n) => n['Node Type'] === 'Append');
      expect(ranked.map((n) => n['Actual Rows'])).toContain(5003);
      // The three chunks with both terms are the only AND matches, and the best OR matches: first.
      expect(lexRanking(mine).slice(0, 3).sort()).toEqual(BOTH);
      expect(lexRanking(mine)).toHaveLength(50);

      const today = await unbounded(opts('vs-big', 'evenw oddw'));
      const read = nodes(today.plan).filter((n) => n['Relation Name'] === 'vector_store_chunks')
        .map((n) => n['Actual Rows'] * n['Actual Loops']);
      expect(Math.max(...read)).toBeGreaterThanOrEqual(BIG + 3);
      expect(lexRanking(today.main).slice(0, 3).sort()).toEqual(BOTH);

      // The canary: in the scan's order the three come last, so a ceiling alone would not have ranked them.
      const { rows } = await fixture.pool.query(`SELECT count(*)::int AS n FROM (
        SELECT c.store_id, c.file_id FROM vector_store_chunks c
         WHERE c.store_id = 'vs-big' AND (c.tsv @@ $1::tsquery OR c.context_tsv @@ $1::tsquery) LIMIT 5000) t
         WHERE t.file_id = 'vs-big-f80'`, ["'evenw' | 'oddw'"]);
      expect(rows[0].n).toBe(0);
    });

    it('the bounded statement scans from the table\'s first block, in its transaction only', async () => {
      await recallCandidates(opts('vs-big', 'evenw oddw'));
      const [atBegin, atMain, afterCommit] = scanSettings;
      expect(atBegin.sync).toBe('on');
      expect(atMain).toEqual({ sync: 'off', workers: atBegin.workers }); // workers stay allowed for the statement
      expect(afterCommit).toEqual(atBegin);
      // A search that is not bounded keeps the server's settings.
      scanSettings = [];
      await recallCandidates(opts('vs-small', 'evenw oddw'));
      expect(scanSettings[1]).toEqual(scanSettings[0]);
    });

    it('the same bounded search twice ranks the same set, even on a sequential scan the planner would parallelise', async () => {
      // A sequential scan (no bitmap or index scan) and free parallelism: the plan the ceiling is most exposed to.
      beforeMain = ['SET LOCAL enable_bitmapscan = off', 'SET LOCAL enable_indexscan = off',
        'SET LOCAL parallel_setup_cost = 0', 'SET LOCAL parallel_tuple_cost = 0', 'SET LOCAL min_parallel_table_scan_size = 0'];
      const lexOf = async () => {
        log = [];
        await recallCandidates(opts('vs-big', 'evenw oddw'));
        return lexRanking(main()[0]);
      };
      /** The capped scan: the Limit over the OR matches that lack a term (the plan node with the pid filter). */
      const innermostLimitOver = (filter: string) => nodes(plan).filter((n) => n['Node Type'] === 'Limit'
        && nodes(n).some((m) => String(m.Filter ?? '').includes(filter))).pop();
      const cappedScan = () => innermostLimitOver('pg_backend_pid');
      const gathered = (n: any) => nodes(n).some((m) => /Gather/.test(m['Node Type']));
      // The chunk scans under it (the store lookups and the file hash beside them may use workers: complete sets).
      const chunkScans = (n: any) => nodes(n).filter((m) => m['Relation Name'] === 'vector_store_chunks');
      explain = true;
      const first = await lexOf();
      expect(cappedScan()).toBeDefined();
      expect(chunkScans(cappedScan()).map((m) => [m['Node Type'], m['Parallel Aware']])).toEqual([['Seq Scan', false]]);
      expect(gathered(plan)).toBe(true); // the rest of the statement (the vector arm) still runs in parallel
      explain = false;
      expect(first).toHaveLength(50);
      expect(await lexOf()).toEqual(first);
      expect(await lexOf()).toEqual(first);

      // The canary: without the predicate the capped scan itself is planned in parallel.
      rewriteMain = (sql) => sql.replace('\n        AND c.ord <> -pg_backend_pid()', '\n        AND c.ord <> -1');
      explain = true;
      await lexOf();
      const capped = innermostLimitOver('<> \'-1\'');
      expect(capped).toBeDefined();
      expect(chunkScans(capped).map((m) => [m['Node Type'], m['Parallel Aware']])).toEqual([['Seq Scan', true]]);
    });

    it('the same bounded search twice ranks the same set when a hash join probes a parallel scan of the files', async () => {
      // The plan shape that reorders the chunks: only hash joins and sequential scans, parallelism for free.
      beforeMain = ['SET LOCAL enable_nestloop = off', 'SET LOCAL enable_mergejoin = off',
        'SET LOCAL enable_indexscan = off', 'SET LOCAL enable_indexonlyscan = off', 'SET LOCAL enable_bitmapscan = off',
        'SET LOCAL parallel_setup_cost = 0', 'SET LOCAL parallel_tuple_cost = 0', 'SET LOCAL min_parallel_table_scan_size = 0'];
      const lexOf = async () => {
        log = [];
        await recallCandidates(opts('vs-big', 'evenw oddw'));
        return lexRanking(main()[0]);
      };
      /** The capped branch: the innermost Limit over a filter naming `marker`, and its scans of either table. */
      const capped = (marker: string) => nodes(plan).filter((n) => n['Node Type'] === 'Limit'
        && nodes(n).some((m) => String(m.Filter ?? '').includes(marker) || String(m['Join Filter'] ?? '').includes(marker)))
        .pop();
      const scans = (n: any) => nodes(n).filter((m) => ['vector_store_chunks', 'vector_store_files'].includes(m['Relation Name']))
        .map((m) => `${m['Relation Name']}:${m['Node Type']}:${m['Parallel Aware'] ? 'parallel' : 'serial'}`).sort();
      explain = true;
      const first = await lexOf();
      expect(scans(capped('pg_backend_pid'))).toEqual(['vector_store_chunks:Seq Scan:serial', 'vector_store_files:Seq Scan:serial']);
      explain = false;
      expect(first).toHaveLength(50);
      for (let i = 0; i < 3; i += 1) expect(await lexOf()).toEqual(first); // eslint-disable-line no-await-in-loop

      // The canary: without the files predicate, the files side of the capped branch is a parallel scan.
      rewriteMain = (sql) => sql.replace(' AND octet_length(vsf.file_id) > -pg_backend_pid()', ' AND octet_length(vsf.file_id) > -1');
      explain = true;
      await lexOf();
      expect(scans(capped('pg_backend_pid'))).toContain('vector_store_files:Seq Scan:parallel');
    });
  });
});
