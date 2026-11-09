// Recall's SQL shape (plan 2026-10-07, B1). The recall statement was reshaped so
// that its LIMIT bounds the work: each arm's inner query reads only
// vector_store_chunks, sorts by score plus the full tiebreaker and keeps the top
// `limit` rows; ROW_NUMBER and the file joins run on those rows only.
//
// The oracle below is a verbatim copy of the recall SQL builder as it was at
// ccc2fd5d (buildCte with the joins and ROW_NUMBER at the LIMIT's level). Every
// case runs recallCandidates twice on the same data — once as shipped, once
// with its statement swapped for the oracle's — and both the raw per-arm rows
// and the fused result must be identical. The one change to the copy: its
// full-text query follows hybrid.lexical_query like recall's ("all" is the
// original plainto_tsquery; "any" takes the AND query's top rows when there are
// `limit` of them and the OR query's otherwise, both computed by recall first).
// W2: the copy also returns the structure columns recall now carries (generation,
// section, section_offset, context); this data has no contexts and no chunk
// without a vector, so recall's context_tsv and NULL-vector predicates must not
// change a single row. W3: and the page columns (page_start, page_end).
// W4: every arm also starts with `c.store_id = ANY($1)` (implied by its store sub-select; it lets the
// planner read the store statistics - recallStoreScope.test.ts). The oracle and every EXPLAIN assertion
// below hold unchanged with it; approximate search (file_search.ann) is off here, as by default.
import { Client, Pool, PoolClient } from 'pg';
import { getPool, __resetForTests } from '../../../src/fileSearch/db';
import { recallCandidates, RecallOptions, __resetRecallSettingsForTests, OR_QUERY_SQL } from '../../../src/fileSearch/repository';
import { STOP_WORDS } from '../../../src/fileSearch/stopWords';
import { compileFilter } from '../../../src/fileSearch/filterCompiler';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 8;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

// ---------------------------------------------------------------------------
// The oracle: repository.ts's recall SQL at ccc2fd5d, unchanged.
// ---------------------------------------------------------------------------
const ORACLE_STORE_ACCESS = '(vs.owner_email = $2 OR vs.is_shared = true)';
const ORACLE_ACTIVE_GENERATION = 'c.generation = vs.active_generation';
const ORACLE_COLUMNS = 'store_id, file_id, ord, text, attributes, filename, rnk, score, generation, section, section_offset, context, '
  + 'page_start, page_end';

function oracleBuildCte(
  name: string, orderExpr: string, scoreExpr: string, extraPredicate: string, filterSql: string, limitPlaceholder: string,
): string {
  const orderByWithTiebreaker = `${orderExpr}, c.store_id, c.file_id, c.ord`;
  return `
${name} AS (
  SELECT c.store_id, c.file_id, c.ord, c.text, vsf.attributes, f.filename,
         ROW_NUMBER() OVER (ORDER BY ${orderByWithTiebreaker}) AS rnk,
         ${scoreExpr} AS score, c.generation, c.section, c.section_offset, c.context, c.page_start, c.page_end
  FROM vector_store_chunks c
  JOIN vector_store_files vsf ON vsf.store_id = c.store_id AND vsf.file_id = c.file_id
  JOIN vector_stores vs ON vs.id = c.store_id
  JOIN fs_files f ON f.id = c.file_id
  WHERE vs.id = ANY($1)
    AND ${ORACLE_STORE_ACCESS}
    AND ${ORACLE_ACTIVE_GENERATION}
    ${filterSql}
    ${extraPredicate}
  ORDER BY ${orderByWithTiebreaker}
  LIMIT ${limitPlaceholder}
)`;
}

function oracleQuery(opts: RecallOptions, terms: { q: string | null; q_and: string | null }): { sql: string; params: any[] } {
  const limit = opts.limit ?? mockConfig.hybrid.candidates;
  const arms = opts.vectorArms ?? [{ storeIds: opts.storeIds, queryEmbedding: opts.queryEmbedding! }];
  const vectorLiterals = arms.map((arm) => `[${arm.queryEmbedding.join(',')}]`);
  const params: any[] = [opts.storeIds, opts.ownerEmail, vectorLiterals[0], limit];
  let nextIndex = 5;
  const armSql = arms.map((arm, i) => {
    let vectorPlaceholder = '$3';
    if (i > 0) {
      params.push(vectorLiterals[i]);
      vectorPlaceholder = `$${nextIndex}`;
      nextIndex += 1;
    }
    let scope = '';
    if (arms.length > 1) {
      params.push(arm.storeIds);
      scope = `AND vs.id = ANY($${nextIndex})`;
      nextIndex += 1;
    }
    if (arm.model !== undefined) {
      params.push(arm.model);
      scope += `${scope ? ' ' : ''}AND vs.embedding_model = $${nextIndex}`;
      nextIndex += 1;
    }
    return { name: i === 0 ? 'vec' : `vec${i}`, vectorPlaceholder, scope };
  });
  let filterSql = '';
  if (opts.filter !== undefined && opts.filter !== null) {
    const compiled = compileFilter(opts.filter, nextIndex);
    filterSql = `AND ${compiled.sql}`;
    params.push(...compiled.params);
    nextIndex = compiled.nextIndex;
  }
  const vecCte = armSql.map(({ name, vectorPlaceholder, scope }) => oracleBuildCte(
    name, `c.embedding <=> ${vectorPlaceholder}::vector`, `c.embedding <=> ${vectorPlaceholder}::vector`,
    scope, filterSql, '$4',
  )).join(',');
  const vecSelects = armSql.map(({ name }) =>
    `SELECT '${name}' AS source, ${ORACLE_COLUMNS} FROM ${name}`);
  if (!mockConfig.hybrid.lexicalEnabled) {
    return { sql: `\nWITH${vecCte}\n${vecSelects.join('\nUNION ALL\n')}`, params };
  }
  const queryTextIndex = nextIndex;
  const oracleArm = (name: string, tsQuery: string) => oracleBuildCte(
    name, `ts_rank(c.tsv, ${tsQuery}) DESC`, `ts_rank(c.tsv, ${tsQuery})`, `AND c.tsv @@ ${tsQuery}`, filterSql, '$4',
  );
  let lexCte: string;
  if (mockConfig.hybrid.lexicalQuery === 'all') {
    params.push(opts.queryText);
    lexCte = oracleArm('lex', `plainto_tsquery('simple', $${queryTextIndex})`);
  } else {
    params.push(terms.q, terms.q_and);
    lexCte = `${oracleArm('lexand', `$${queryTextIndex + 1}::tsquery`)},${oracleArm('lexor', `$${queryTextIndex}::tsquery`)},
lex AS (
  SELECT * FROM lexand WHERE (SELECT count(*) FROM lexand) >= $4
  UNION ALL
  SELECT * FROM lexor WHERE (SELECT count(*) FROM lexand) < $4
)`;
  }
  return {
    sql: `
WITH${vecCte},${lexCte}
${vecSelects.join('\nUNION ALL\n')}
UNION ALL
SELECT 'lex' AS source, ${ORACLE_COLUMNS} FROM lex`,
    params,
  };
}

// ---------------------------------------------------------------------------
// Deterministic data
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango',
  'the', 'and', 'of',
];

// The client's own query, past the swap installed on pool.connect below.
const rawQuery = (client: PoolClient, sql: string, params?: any[]): Promise<any> =>
  (Client.prototype.query as any).call(client, sql, params);

interface Row { source: string; store_id: string; file_id: string; ord: number; rnk: string; score: number }

d('recall SQL shape: identical to the pre-B1 statement (requires FILE_SEARCH_TEST_DSN pointing at pgvector)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const rand = mulberry32(20261007);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

  // A small pool of base directions, so exact distance ties are everywhere.
  const BASES: number[][] = Array.from({ length: 24 }, () =>
    Array.from({ length: EMBED_DIM }, () => Math.floor(rand() * 3)));
  BASES[0] = Array.from({ length: EMBED_DIM }, () => 0); // cosine distance NaN against it
  const vector = (): number[] => (rand() < 0.8
    ? pick(BASES)
    : Array.from({ length: EMBED_DIM }, () => Math.round((rand() * 2 - 1) * 1000) / 1000));
  const text = (): string => (rand() < 0.3
    ? 'alpha bravo charlie' // identical texts tie on ts_rank across files and ords
    : Array.from({ length: 3 + Math.floor(rand() * 10) }, () => pick(VOCAB)).join(' '));
  const attributes = (): Record<string, unknown> | null => (rand() < 0.15 ? null : {
    color: pick(['red', 'green', 'blue']),
    year: 2019 + Math.floor(rand() * 6),
    ...(rand() < 0.5 ? { flag: rand() < 0.5 } : {}),
  });

  // Store layout: id -> { owner, shared, model, sizes }
  const stores: Record<string, { owner: string; shared: boolean; model: string; activeGen: number }> = {};
  let fileCounter = 0;

  async function seedStore(id: string, owner: string, shared: boolean, model: string, activeGen = 0): Promise<void> {
    stores[id] = { owner, shared, model, activeGen };
    await pool.query(
      `INSERT INTO vector_stores (id, owner_email, is_shared, embedding_model, embedding_dim, active_generation)
       VALUES ($1, $2, $3, $4, ${EMBED_DIM}, $5)`,
      [id, owner, shared, model, activeGen],
    );
  }

  /** `files` files of `chunksPerFile` chunks each, in every listed generation. Files
   *  in `detached` keep their chunks but lose their vector_store_files row (what a
   *  detach leaves for the orphan sweep). `reuse` attaches already-seeded fs_files. */
  async function seedChunks(storeId: string, files: number, chunksPerFile: number, generations: number[],
    opts: { detached?: number; reuse?: string[] } = {}): Promise<string[]> {
    const fileIds = opts.reuse ?? Array.from({ length: files }, () => {
      fileCounter += 1;
      return `file-${String(fileCounter).padStart(5, '0')}`;
    });
    if (!opts.reuse) {
      await pool.query(
        `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
         SELECT id, 'seed@example.com', id || '.txt', 'assistants', 'seedblob', 1 FROM unnest($1::text[]) AS id`,
        [fileIds],
      );
    }
    const attached = fileIds.slice(opts.detached ?? 0);
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, attributes, status)
       SELECT $1, f, a, 'completed' FROM unnest($2::text[], $3::jsonb[]) AS u(f, a)`,
      [storeId, attached, attached.map(() => attributes())],
    );
    const cols: { f: string[]; o: number[]; t: string[]; e: string[]; g: number[] } = { f: [], o: [], t: [], e: [], g: [] };
    for (const g of generations) {
      for (const fileId of fileIds) {
        for (let ord = 0; ord < chunksPerFile; ord += 1) {
          cols.f.push(fileId); cols.o.push(ord); cols.t.push(text()); cols.e.push(`[${vector().join(',')}]`); cols.g.push(g);
        }
      }
    }
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding, generation)
       SELECT $1, f, o, t, e::vector, g FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::int[]) AS u(f, o, t, e, g)`,
      [storeId, cols.f, cols.o, cols.t, cols.e, cols.g],
    );
    return fileIds;
  }

  // ---- the client swap: runs recall's own statement, or the oracle's in its place
  let mode: 'shipped' | 'oracle' | 'explain' = 'shipped';
  let oracle: { sql: string; params: any[] } | null = null;
  let captured: { sql: string; params: any[]; rows: any[]; plan?: any } | null = null;
  // Extra SET LOCALs for an explain run (planner switches that push it towards the index).
  let explainSettings: string[] = [];

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    pool = getPool()!;

    const realConnect = pool.connect.bind(pool) as (cb?: any) => any;
    // Assigned, not jest.spyOn: the gateway's jest config restores spies before every test.
    (pool as any).connect = (async (cb?: any) => {
      // pool.query checks out its client with a callback; only recall's own checkout is wrapped
      if (cb) return realConnect(cb);
      const client: PoolClient = await realConnect();
      (client as any).query = async (sql: any, params?: any) => {
        const run = (s: string, p?: any[]) => rawQuery(client, s, p);
        if (!Array.isArray(params) || sql === OR_QUERY_SQL) return run(sql, params);
        // The recall statement: the only other one recallCandidates sends with parameters.
        let plan: any;
        if (mode === 'explain') {
          await run('SET LOCAL jit_above_cost = 0'); // JIT would kick in on any plan, were it on
          for (const setting of explainSettings) await run(setting); // eslint-disable-line no-await-in-loop
          const explained = await run(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
          plan = explained.rows[0]['QUERY PLAN'][0];
        }
        const statement = mode === 'oracle' ? oracle! : { sql, params };
        const result = await run(statement.sql, statement.params);
        captured = { ...statement, rows: result.rows, plan };
        return result;
      };
      return client;
    });

    await pool.query(`INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ('seedblob', 1, 'inline')`);
    // alice: one large store, small ones, a store on the second model, a re-embedded one
    await seedStore('vs-a-big', 'alice@example.com', false, 'model-a');
    const bigFiles = await seedChunks('vs-a-big', 100, 30, [0], { detached: 3 });
    await seedStore('vs-a-small1', 'alice@example.com', false, 'model-a');
    await seedChunks('vs-a-small1', 3, 4, [0]);
    await seedStore('vs-a-small2', 'alice@example.com', false, 'model-a');
    await seedChunks('vs-a-small2', 12, 15, [0], { detached: 1 });
    await seedStore('vs-a-one', 'alice@example.com', false, 'model-a');
    await seedChunks('vs-a-one', 1, 1, [0]);
    await seedStore('vs-a-empty', 'alice@example.com', false, 'model-a');
    await seedStore('vs-a-modelb', 'alice@example.com', false, 'model-b');
    await seedChunks('vs-a-modelb', 40, 30, [0]);
    // re-embedded: generation 1 active, 0 left behind, 2 being written
    await seedStore('vs-a-reembed', 'alice@example.com', false, 'model-b', 1);
    await seedChunks('vs-a-reembed', 20, 30, [0, 1, 2]);
    // the same fs_files attached to a second store
    await seedStore('vs-a-reuse', 'alice@example.com', false, 'model-a');
    await seedChunks('vs-a-reuse', 0, 6, [0], { reuse: bigFiles.slice(10, 30) });
    // bob: a shared store, a private store; carol: shared on model-b
    await seedStore('vs-b-shared', 'bob@example.com', true, 'model-a');
    await seedChunks('vs-b-shared', 40, 20, [0]);
    await seedStore('vs-b-private', 'bob@example.com', false, 'model-a');
    await seedChunks('vs-b-private', 30, 20, [0]);
    await seedStore('vs-c-shared', 'carol@example.com', true, 'model-b');
    await seedChunks('vs-c-shared', 10, 25, [0]);
    // noise from other tenants
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seedStore(`vs-x-${i}`, `x${i}@example.com`, false, i % 2 ? 'model-a' : 'model-b');
      // eslint-disable-next-line no-await-in-loop
      await seedChunks(`vs-x-${i}`, 20, 20, [0]);
    }
    await pool.query('ANALYZE');
  }, 120_000);

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => {
    mockConfig = { embeddingDimensions: EMBED_DIM, hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50 } };
    __resetRecallSettingsForTests();
    mode = 'shipped';
    explainSettings = [];
  });

  const ALL_STORES = () => Object.keys(stores).concat(['vs-missing']);
  const FILTERS: unknown[] = [
    undefined,
    { type: 'eq', key: 'color', value: 'red' },
    { type: 'in', key: 'color', value: ['green', 'blue'] },
    { type: 'and', filters: [{ type: 'gte', key: 'year', value: 2021 }, { type: 'ne', key: 'color', value: 'blue' }] },
    { type: 'or', filters: [{ type: 'eq', key: 'flag', value: true }, { type: 'lt', key: 'year', value: 2020 }] },
    { type: 'nin', key: 'color', value: ['red'] },
  ];

  function makeCase(): { opts: RecallOptions; lexical: boolean } {
    const all = ALL_STORES();
    const storeIds = rand() < 0.2 ? all : all.filter(() => rand() < 0.35);
    if (storeIds.length === 0) storeIds.push(pick(all));
    const ownerEmail = rand() < 0.75 ? 'alice@example.com' : pick(['bob@example.com', 'carol@example.com', 'x1@example.com']);
    const queryText = rand() < 0.1 ? 'zzz' : Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(VOCAB)).join(' ');
    const limit = pick([1, 3, 7, 50, 50, 50, 120, 400]);
    const filter = pick(FILTERS);
    const opts: RecallOptions = { storeIds, ownerEmail, queryText, filter, limit };
    const shape = rand();
    if (shape < 0.4) {
      opts.queryEmbedding = vector();
    } else {
      // one arm per model, each naming its model; sometimes one arm names the wrong one
      const byModel = new Map<string, string[]>();
      for (const id of storeIds) {
        const model = stores[id]?.model ?? 'model-a';
        byModel.set(model, [...(byModel.get(model) ?? []), id]);
      }
      const wrong = rand() < 0.2;
      opts.vectorArms = [...byModel.entries()].map(([model, ids], i) => ({
        storeIds: ids,
        queryEmbedding: vector(),
        ...(shape < 0.55 ? {} : { model: wrong && i === 0 ? 'model-z' : model }),
      }));
    }
    return { opts, lexical: rand() < 0.75 };
  }

  async function runBoth(opts: RecallOptions): Promise<{ shipped: any; oracle: any; shippedRows: Row[]; oracleRows: Row[] }> {
    const byArm = (rows: any[]): Row[] => [...rows].sort((a, b) => (a.source === b.source
      ? Number(a.rnk) - Number(b.rnk) : a.source.localeCompare(b.source)));
    mode = 'shipped';
    const shipped = await recallCandidates(opts);
    const shippedRows = byArm(captured!.rows);
    mode = 'oracle';
    // On a checked-out client: pool.query would reuse a client whose query is swapped above
    // and pass it a callback the swap does not take.
    const client = await pool.connect();
    let terms: { q: string | null; q_and: string | null };
    try {
      terms = (await rawQuery(client, OR_QUERY_SQL, [opts.queryText, STOP_WORDS])).rows[0];
    } finally {
      client.release();
    }
    oracle = oracleQuery(opts, terms);
    const oracleResult = await recallCandidates(opts);
    const oracleRows = byArm(captured!.rows);
    return { shipped, oracle: oracleResult, shippedRows, oracleRows };
  }

  it('returns identical candidates, ranks, scores and fused order over many stores, filters, owners and ties', async () => {
    let rowsCompared = 0;
    let tiesAtTheLimit = 0;
    let fusedCompared = 0;
    for (let i = 0; i < 160; i += 1) {
      const { opts, lexical } = makeCase();
      mockConfig.hybrid.lexicalEnabled = lexical;
      mockConfig.hybrid.lexicalQuery = i % 2 ? 'all' : 'any';
      // eslint-disable-next-line no-await-in-loop
      const { shipped, oracle: oracleResult, shippedRows, oracleRows } = await runBoth(opts);
      expect({ case: i, rows: shippedRows }).toEqual({ case: i, rows: oracleRows });
      expect({ case: i, fused: shipped }).toEqual({ case: i, fused: oracleResult });
      rowsCompared += shippedRows.length;
      fusedCompared += shipped.length;
      // a tie straddling the cut: the last kept row shares its score with the one before it
      const bySource = new Map<string, Row[]>();
      for (const r of shippedRows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
      for (const arm of bySource.values()) {
        if (arm.length === opts.limit && arm.length > 1 && Object.is(arm[arm.length - 1].score, arm[arm.length - 2].score)) {
          tiesAtTheLimit += 1;
        }
      }
    }
    // the comparison is not vacuous
    expect(rowsCompared).toBeGreaterThan(5000);
    expect(fusedCompared).toBeGreaterThan(2000);
    expect(tiesAtTheLimit).toBeGreaterThan(20);
  }, 120_000);

  it('matches the oracle on the hand-picked edge cases', async () => {
    const zero = Array.from({ length: EMBED_DIM }, () => 0);
    const cases: RecallOptions[] = [
      // another owner's private store requested by alice: nothing from it
      { storeIds: ['vs-b-private', 'vs-a-one'], ownerEmail: 'alice@example.com', queryText: 'alpha', queryEmbedding: BASES[3] },
      // a shared store seen by a non-owner
      { storeIds: ['vs-b-shared'], ownerEmail: 'carol@example.com', queryText: 'alpha bravo charlie', queryEmbedding: BASES[5] },
      // the re-embedded store: only generation 1
      { storeIds: ['vs-a-reembed'], ownerEmail: 'alice@example.com', queryText: 'echo', queryEmbedding: BASES[7], limit: 1000 },
      // the zero query vector: every distance NaN, order by the tiebreaker alone
      { storeIds: ['vs-a-small2', 'vs-a-big'], ownerEmail: 'alice@example.com', queryText: 'the', queryEmbedding: zero, limit: 80 },
      // detached files' chunks and an empty store
      { storeIds: ['vs-a-big', 'vs-a-empty'], ownerEmail: 'alice@example.com', queryText: 'of and', queryEmbedding: BASES[1], limit: 3000 },
      // the same file in two stores
      { storeIds: ['vs-a-big', 'vs-a-reuse'], ownerEmail: 'alice@example.com', queryText: 'kilo', queryEmbedding: BASES[2], limit: 200 },
      // an arm whose model no store is on any more
      {
        storeIds: ['vs-a-big', 'vs-a-modelb'], ownerEmail: 'alice@example.com', queryText: 'lima', limit: 60,
        vectorArms: [
          { storeIds: ['vs-a-big'], queryEmbedding: BASES[4], model: 'model-a' },
          { storeIds: ['vs-a-modelb'], queryEmbedding: BASES[6], model: 'model-a' },
        ],
      },
    ];
    for (const [lexical, lexicalQuery] of [[true, 'any'], [true, 'all'], [false, 'any']] as const) {
      for (const [i, opts] of cases.entries()) {
        mockConfig.hybrid.lexicalEnabled = lexical;
        mockConfig.hybrid.lexicalQuery = lexicalQuery;
        // eslint-disable-next-line no-await-in-loop
        const { shipped, oracle: oracleResult, shippedRows, oracleRows } = await runBoth(opts);
        expect({ case: i, lexical, lexicalQuery, rows: shippedRows }).toEqual({ case: i, lexical, lexicalQuery, rows: oracleRows });
        expect({ case: i, lexical, lexicalQuery, fused: shipped }).toEqual({ case: i, lexical, lexicalQuery, fused: oracleResult });
      }
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // The plan: each arm sorts only the rows it keeps.
  // -------------------------------------------------------------------------
  function nodes(plan: any, out: any[] = []): any[] {
    out.push(plan);
    for (const child of plan.Plans ?? []) nodes(child, out);
    return out;
  }

  async function explain(opts: RecallOptions): Promise<any> {
    mode = 'explain';
    await recallCandidates(opts);
    return captured!.plan;
  }

  const bigQuery = (extra: Partial<RecallOptions> = {}): RecallOptions => ({
    storeIds: ['vs-a-big', 'vs-b-shared', 'vs-a-small2'], ownerEmail: 'alice@example.com',
    queryText: 'alpha bravo', queryEmbedding: BASES[9], limit: 50, ...extra,
  });

  it.each([
    ['vector and lexical', true, undefined],
    ['vector only', false, undefined],
    ['with an attribute filter', true, { type: 'eq', key: 'color', value: 'red' }],
  ])('%s: a top-N heapsort under every Limit, no window function below one, no external sort, no JIT', async (_label, lexical, filter) => {
    mockConfig.hybrid.lexicalEnabled = lexical;
    const plan = await explain(bigQuery({ filter }));
    const all = nodes(plan.Plan);
    const limits = all.filter((n) => n['Node Type'] === 'Limit');
    // the vector arm, and the full-text arm's AND and OR arms
    expect(limits).toHaveLength(lexical ? 3 : 1);
    for (const limit of limits) {
      const below = nodes(limit).slice(1);
      expect(below.filter((n) => n['Node Type'] === 'WindowAgg')).toEqual([]);
      const sorts = below.filter((n) => n['Node Type'] === 'Sort');
      // the OR arm never runs when the AND arm filled the limit: no sort method to report
      if (limit['Actual Loops'] === 0) continue;
      expect(sorts).toHaveLength(1);
      // Postgres switches to the bounded heap only past twice the bound; an arm with fewer
      // input rows (here the AND arm) sorts them in memory, which is just as bounded
      const [sort] = sorts;
      const input = sort.Plans[0]['Actual Rows'] * sort.Plans[0]['Actual Loops'];
      expect({ method: sort['Sort Method'], small: input <= 2 * 50 })
        .toEqual(sort['Sort Method'] === 'quicksort' ? { method: 'quicksort', small: true } : { method: 'top-N heapsort', small: expect.any(Boolean) });
      // exact: the arm never reads the HNSW index
      expect(below.filter((n) => n['Index Name'] === 'idx_chunks_hnsw')).toEqual([]);
    }
    expect(all.filter((n) => /external/.test(n['Sort Method'] ?? ''))).toEqual([]);
    expect(plan.JIT).toBeUndefined();
  });

  // The case the OR arm exists for: 'zulu' is in no chunk, so the AND query finds nothing,
  // the OR arm runs and ranks every chunk with 'alpha' - far more than twice the limit, so
  // its sort must be the bounded top-N heapsort.
  it.each([
    ['without a filter', undefined],
    ['with an attribute filter', { type: 'eq', key: 'color', value: 'red' }],
  ])('the OR arm, when it runs (%s), sorts with a top-N heapsort', async (_label, filter) => {
    expect(VOCAB).not.toContain('zulu');
    mockConfig.hybrid.lexicalEnabled = true;
    const plan = await explain(bigQuery({ filter, queryText: 'alpha zulu' }));
    const limits = nodes(plan.Plan).filter((n) => n['Node Type'] === 'Limit');
    const sortKey = (limit: any) => nodes(limit).find((n) => n['Node Type'] === 'Sort')?.['Sort Key']?.[0] ?? '';
    const orLimit = limits.find((l) => sortKey(l).includes("''alpha'' | ''zulu''"));
    const andLimit = limits.find((l) => sortKey(l).includes("''alpha'' & ''zulu''"));
    expect(andLimit!['Actual Rows']).toBe(0);
    expect(orLimit!['Actual Loops']).toBeGreaterThan(0);
    expect(orLimit!['Actual Rows']).toBe(50);
    const sort = nodes(orLimit).find((n) => n['Node Type'] === 'Sort');
    expect(sort['Sort Method']).toBe('top-N heapsort');
    expect(sort.Plans[0]['Actual Rows'] * sort.Plans[0]['Actual Loops']).toBeGreaterThan(2 * 50);
    expect(nodes(orLimit).slice(1).filter((n) => n['Node Type'] === 'WindowAgg')).toEqual([]);
    expect(nodes(orLimit).filter((n) => n['Index Name'] === 'idx_chunks_hnsw')).toEqual([]);
  });

  // The exact top-N must not depend on the planner preferring it: with sorts,
  // sequential and bitmap scans all discouraged, the cheapest-looking way to an
  // ordered result is idx_chunks_hnsw — which no arm may read below its Limit.
  it.each([
    ['vector and lexical', true, undefined],
    ['vector only', false, undefined],
    ['with an attribute filter', true, { type: 'eq', key: 'color', value: 'red' }],
  ])('%s, sorts and scans discouraged: still no idx_chunks_hnsw below any Limit', async (_label, lexical, filter) => {
    mockConfig.hybrid.lexicalEnabled = lexical;
    explainSettings = ['SET LOCAL enable_seqscan = off', 'SET LOCAL enable_bitmapscan = off', 'SET LOCAL enable_sort = off'];
    const plan = await explain(bigQuery({ filter }));
    const limits = nodes(plan.Plan).filter((n) => n['Node Type'] === 'Limit');
    expect(limits).toHaveLength(lexical ? 3 : 1);
    for (const limit of limits) {
      expect(nodes(limit).slice(1).filter((n) => n['Index Name'] === 'idx_chunks_hnsw')).toEqual([]);
    }
  });

  // The schema's index is the halfvec expression index (vectorIndex.ts), so the canary orders by that expression.
  it('the HNSW assertion can fail: with the same settings, a nearest-neighbour query without the tiebreaker reads the index', async () => {
    const client = await pool.connect();
    try {
      await rawQuery(client, 'BEGIN');
      await rawQuery(client, 'SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL enable_sort = off');
      const { rows } = await rawQuery(client,
        `EXPLAIN (FORMAT JSON) SELECT store_id, file_id, ord FROM vector_store_chunks
          ORDER BY embedding::halfvec(${EMBED_DIM}) <=> $1::halfvec(${EMBED_DIM}) LIMIT 50`, [`[${BASES[9].join(',')}]`]);
      const limit = nodes(rows[0]['QUERY PLAN'][0].Plan).find((n) => n['Node Type'] === 'Limit');
      expect(nodes(limit).filter((n) => n['Index Name'] === 'idx_chunks_hnsw')).toHaveLength(1);
    } finally {
      await rawQuery(client, 'ROLLBACK');
      client.release();
    }
  });

  it('the JIT assertion can fail: the same statement with jit on is compiled', async () => {
    mockConfig.hybrid.lexicalEnabled = true;
    await explain(bigQuery());
    const { sql, params } = captured!;
    const client = await pool.connect();
    try {
      await rawQuery(client, 'BEGIN');
      await rawQuery(client, 'SET LOCAL jit = on; SET LOCAL jit_above_cost = 0');
      const { rows } = await rawQuery(client, `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
      expect(rows[0]['QUERY PLAN'][0].JIT).toBeDefined();
    } finally {
      await rawQuery(client, 'ROLLBACK');
      client.release();
    }
  });
});
