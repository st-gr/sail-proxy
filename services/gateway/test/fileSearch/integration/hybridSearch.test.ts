// Proves recallCandidates against a real pgvector database: the RRF fusion of
// a vector ranking and a lexical ranking, the attribute filter composed onto
// both, and — above all — that the ownership predicate genuinely excludes
// another owner's store rather than merely being present in the SQL text.
// Skips cleanly when no live database is configured.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, __resetForTests } from '../../../src/fileSearch/db';
import { recallCandidates, RecallInputError, setLexicalRankFunction, OR_QUERY_SQL } from '../../../src/fileSearch/repository';
import { STOP_WORDS } from '../../../src/fileSearch/stopWords';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

d('recallCandidates hybrid recall (requires FILE_SEARCH_TEST_DSN pointing at pgvector)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  // Every NOTICE the recall connections receive (e.g. "text-search query doesn't contain lexemes").
  const notices: string[] = [];

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    // The repository modules reach the database through src/fileSearch/db.ts's
    // getPool() singleton, which builds its own Pool from this env var rather
    // than accepting one — point it at the isolated schema the same way the
    // fixture's own pool is scoped.
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    pool = getPool()!;
    pool.on('connect', (client) => client.on('notice', (n) => notices.push(String(n.message))));
  });

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => {
    mockConfig = {
      embeddingDimensions: EMBED_DIM,
      hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50 },
    };
    notices.length = 0;
  });

  async function seedStore(ownerEmail: string, isShared = false): Promise<string> {
    const storeId = `store-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO vector_stores (id, owner_email, is_shared, embedding_model, embedding_dim)
       VALUES ($1, $2, $3, 'test-model', ${EMBED_DIM})`,
      [storeId, ownerEmail, isShared],
    );
    return storeId;
  }

  async function seedChunk(opts: {
    storeId: string;
    fileId: string;
    ord: number;
    text: string;
    embedding: number[];
    attributes?: Record<string, unknown> | null;
  }): Promise<void> {
    const sha256 = crypto.createHash('sha256').update(`${opts.storeId}:${opts.fileId}:${opts.ord}`).digest('hex');
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ($1, 1, 'inline')
       ON CONFLICT (sha256) DO NOTHING`,
      [sha256],
    );
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ($1, 'seed@example.com', $1, 'assistants', $2, 1)
       ON CONFLICT (id) DO NOTHING`,
      [opts.fileId, sha256],
    );
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, attributes, status)
       VALUES ($1, $2, $3, 'completed')
       ON CONFLICT (store_id, file_id) DO UPDATE SET attributes = EXCLUDED.attributes`,
      [opts.storeId, opts.fileId, opts.attributes ?? null],
    );
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)`,
      [opts.storeId, opts.fileId, opts.ord, opts.text, `[${opts.embedding.join(',')}]`],
    );
  }

  // ---------------------------------------------------------------------
  // THE highest-value test: a caller must never be able to retrieve another
  // owner's chunks by listing that owner's store id, even when both stores'
  // chunks are otherwise indistinguishable (identical embedding here, on
  // purpose — if isolation ever regressed to "rank and hope", this would
  // still return both).
  // ---------------------------------------------------------------------
  it('never returns another owner\'s chunks, even when explicitly asked for their store id', async () => {
    const aliceStore = await seedStore('alice@example.com');
    const bobStore = await seedStore('bob@example.com');
    await seedChunk({ storeId: aliceStore, fileId: 'f-alice', ord: 0, text: 'shared wording', embedding: [1, 0, 0] });
    await seedChunk({ storeId: bobStore, fileId: 'f-bob', ord: 0, text: 'shared wording', embedding: [1, 0, 0] });

    const results = await recallCandidates({
      storeIds: [aliceStore, bobStore],
      ownerEmail: 'alice@example.com',
      queryText: 'shared wording',
      queryEmbedding: [1, 0, 0],
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.storeId === aliceStore)).toBe(true);
    expect(results.some((r) => r.fileId === 'f-bob')).toBe(false);
  });

  it('recalls chunks from a store marked is_shared even when the caller is not its owner', async () => {
    const carolStore = await seedStore('carol@example.com', true);
    await seedChunk({ storeId: carolStore, fileId: 'f-carol', ord: 0, text: 'shared store content', embedding: [1, 0, 0] });

    const results = await recallCandidates({
      storeIds: [carolStore],
      ownerEmail: 'alice@example.com',
      queryText: 'shared store content',
      queryEmbedding: [1, 0, 0],
    });

    expect(results.some((r) => r.fileId === 'f-carol')).toBe(true);
  });

  it('recalls the planted chunk and ranks it first by vector similarity', async () => {
    const storeId = await seedStore('dave@example.com');
    // Distinct orthogonal embeddings and text with no word in common with the
    // query, so the (enabled) lexical ranking contributes nothing to any of
    // them — this isolates the vector-ranking path.
    await seedChunk({ storeId, fileId: 'f-planted', ord: 0, text: 'plum kiwi mango', embedding: [1, 0, 0] });
    await seedChunk({ storeId, fileId: 'f-other-a', ord: 0, text: 'grape fig date', embedding: [0, 1, 0] });
    await seedChunk({ storeId, fileId: 'f-other-b', ord: 0, text: 'pear lime cherry', embedding: [0, 0, 1] });

    const results = await recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'dave@example.com',
      queryText: 'zzz_no_lexical_match_zzz',
      queryEmbedding: [1, 0, 0],
    });

    expect(results.length).toBe(3);
    expect(results[0].fileId).toBe('f-planted');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('an ordinal attribute filter excludes a non-matching file\'s chunks', async () => {
    const storeId = await seedStore('erin@example.com');
    await seedChunk({
      storeId, fileId: 'f-old', ord: 0, text: 'annual report', embedding: [1, 0, 0],
      attributes: { year: 2019 },
    });
    await seedChunk({
      storeId, fileId: 'f-new', ord: 0, text: 'annual report', embedding: [1, 0, 0],
      attributes: { year: 2021 },
    });

    const results = await recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'erin@example.com',
      queryText: 'annual report',
      queryEmbedding: [1, 0, 0],
      filter: { type: 'gt', key: 'year', value: 2020 },
    });

    expect(results.map((r) => r.fileId)).toEqual(['f-new']);
  });

  it('runs the vector CTE only when hybrid.lexicalEnabled is false', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    const storeId = await seedStore('frank@example.com');
    // chunkNear is closest in vector space but has no lexical signal;
    // chunkFar repeats the query word heavily and would win if the (disabled)
    // lexical ranking were contributing. With lexical off, only vector
    // distance can decide, so chunkNear must still win.
    await seedChunk({ storeId, fileId: 'f-near', ord: 0, text: 'no relation to the query at all', embedding: [1, 0, 0] });
    await seedChunk({
      storeId, fileId: 'f-far', ord: 0,
      text: 'trumpet trumpet trumpet trumpet trumpet trumpet trumpet trumpet',
      embedding: [0, 1, 0],
    });

    const results = await recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'frank@example.com',
      queryText: 'trumpet',
      queryEmbedding: [1, 0, 0],
    });

    expect(results.length).toBe(2);
    expect(results[0].fileId).toBe('f-near');
  });

  it('caps results at hybrid.candidates', async () => {
    mockConfig.hybrid.candidates = 2;
    const storeId = await seedStore('grace@example.com');
    await seedChunk({ storeId, fileId: 'f-1', ord: 0, text: 'alpha', embedding: [1, 0, 0] });
    await seedChunk({ storeId, fileId: 'f-2', ord: 0, text: 'beta', embedding: [0, 1, 0] });
    await seedChunk({ storeId, fileId: 'f-3', ord: 0, text: 'gamma', embedding: [0, 0, 1] });

    const results = await recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'grace@example.com',
      queryText: 'zzz_no_match',
      queryEmbedding: [1, 0, 0],
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns an empty array for an empty storeIds list without querying the database', async () => {
    const results = await recallCandidates({
      storeIds: [],
      ownerEmail: 'nobody@example.com',
      queryText: 'anything',
      queryEmbedding: [1, 0, 0],
    });
    expect(results).toEqual([]);
  });

  // Task 1 gate: buildCte's SELECT list grew (added `${scoreExpr} AS score`),
  // so every placeholder used after $4 (the compiled filter's params, bound
  // starting from compileFilter's own nextIndex) must still land correctly.
  // Combines BOTH things the WHERE clause must keep doing byte-identically:
  // excluding a store that's foreign to `ownerEmail` (foreignStore, not
  // owned and not shared — included in storeIds but must contribute zero
  // rows), and binding a GENUINELY nested `or(and(gt,eq), and(lt,eq))`
  // filter (two branches, each an `and` of an ordinal leaf — which itself
  // consumes 3 placeholders per filterCompiler.ts's own comment — and an
  // equality leaf) against the OWNED store's chunks.
  it('binds a nested and/or filter mixing an ordinal and equality leaf correctly, and still excludes a foreign store id, after the SELECT list grew', async () => {
    const ownedStore = await seedStore('oliver@example.com');
    const foreignStore = await seedStore('peter@example.com'); // not shared, not owned by oliver
    await seedChunk({
      storeId: ownedStore, fileId: 'f-match', ord: 0, text: 'quarterly report', embedding: [1, 0, 0],
      attributes: { year: 2021, category: 'report' },
    });
    await seedChunk({
      storeId: ownedStore, fileId: 'f-wrong-year', ord: 0, text: 'quarterly report', embedding: [1, 0, 0],
      attributes: { year: 2019, category: 'report' },
    });
    await seedChunk({
      storeId: ownedStore, fileId: 'f-wrong-category', ord: 0, text: 'quarterly report', embedding: [1, 0, 0],
      attributes: { year: 2021, category: 'memo' },
    });
    // Same attributes as f-match, on the foreign store — if the ownership
    // predicate or placeholder numbering ever regressed, this is the row
    // that would leak through.
    await seedChunk({
      storeId: foreignStore, fileId: 'f-foreign-match', ord: 0, text: 'quarterly report', embedding: [1, 0, 0],
      attributes: { year: 2021, category: 'report' },
    });

    const results = await recallCandidates({
      storeIds: [ownedStore, foreignStore],
      ownerEmail: 'oliver@example.com',
      queryText: 'quarterly report',
      queryEmbedding: [1, 0, 0],
      filter: {
        type: 'or',
        filters: [
          {
            type: 'and',
            filters: [
              { type: 'gt', key: 'year', value: 2020 },
              { type: 'eq', key: 'category', value: 'report' },
            ],
          },
          {
            type: 'and',
            filters: [
              { type: 'lt', key: 'year', value: 2000 },
              { type: 'eq', key: 'category', value: 'archive' },
            ],
          },
        ],
      },
    });

    expect(results.map((r) => r.fileId)).toEqual(['f-match']);
    expect(results[0].storeId).toBe(ownedStore);
  });

  it('rejects a malformed attribute filter with a 400-flavoured RecallInputError, not a raw throw', async () => {
    const storeId = await seedStore('henry@example.com');
    const promise = recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'henry@example.com',
      queryText: 'x',
      queryEmbedding: [1, 0, 0],
      filter: { type: 'not_a_real_operator' },
    });
    await expect(promise).rejects.toBeInstanceOf(RecallInputError);
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a query embedding whose dimension does not match the configured embeddingDimensions', async () => {
    const storeId = await seedStore('iris@example.com');
    const promise = recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'iris@example.com',
      queryText: 'x',
      queryEmbedding: [1, 0], // 2 dims, configured EMBED_DIM is 3
    });
    await expect(promise).rejects.toBeInstanceOf(RecallInputError);
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  // Final whole-branch review, Critical #1: a NUL byte in queryText is bound
  // straight into plainto_tsquery(...) with no guard, and Postgres cannot
  // represent it in a text parameter — reproduced live pre-fix as a raw
  // `[22021] invalid byte sequence for encoding "UTF8": 0x00` thrown out of
  // pool.query, an unhandled 500 at the HTTP layer (see
  // integration/endToEnd.test.ts for the endpoint-level assertion). This is
  // the repository-level regression guard for the fix itself.
  it('rejects a NUL byte in queryText with a 400-flavoured RecallInputError, not a raw Postgres exception', async () => {
    const storeId = await seedStore('julia@example.com');
    const promise = recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'julia@example.com',
      queryText: `a${String.fromCharCode(0)}b`,
      queryEmbedding: [1, 0, 0],
    });
    await expect(promise).rejects.toBeInstanceOf(RecallInputError);
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  // Also still true when hybrid.lexicalEnabled is false — queryText is never
  // placed in the SQL on that path, but the guard runs unconditionally
  // before that branch, so it must still reject rather than silently
  // accepting an unusable value.
  it('rejects a NUL byte in queryText even when hybrid.lexicalEnabled is false', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    const storeId = await seedStore('kevin@example.com');
    const promise = recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'kevin@example.com',
      queryText: `a${String.fromCharCode(0)}b`,
      queryEmbedding: [1, 0, 0],
    });
    await expect(promise).rejects.toBeInstanceOf(RecallInputError);
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  // Final whole-branch review, near-free #17: ownerEmail is the highest-
  // stakes parameter in this module (it's the entire ownership boundary —
  // see the file header) and was the one bare string with no validation.
  // The store here is deliberately `is_shared` with a real chunk planted:
  // without the guard, an empty ownerEmail does not error at all — it
  // silently degrades to "every is_shared store", genuinely returning this
  // chunk (proven by temporarily removing the guard during this fix's own
  // mutation check, not asserted here — a caller bug dropping ownerEmail
  // must throw loudly, not succeed quietly).
  it('rejects an empty ownerEmail rather than silently degrading to "all shared stores"', async () => {
    const storeId = await seedStore('laura@example.com', true);
    await seedChunk({ storeId, fileId: 'f-laura', ord: 0, text: 'shared content', embedding: [1, 0, 0] });
    const promise = recallCandidates({
      storeIds: [storeId],
      ownerEmail: '',
      queryText: 'shared content',
      queryEmbedding: [1, 0, 0],
    });
    await expect(promise).rejects.toBeInstanceOf(RecallInputError);
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  it('surfaces per-arm rank and score alongside the fused RRF score, with both arms populated for a chunk recalled by both', async () => {
    const storeId = await seedStore('nadia@example.com');
    // f-both shares the query's exact wording (so the lexical arm recalls
    // it) AND is the closest vector to the query embedding (so the vector
    // arm recalls it too) — this is the row that must end up with BOTH
    // vectorRank/vectorScore and lexicalRank/lexicalScore populated, proving
    // the fusion step no longer collapses a chunk present in both arms down
    // to whichever row happened to arrive last.
    await seedChunk({ storeId, fileId: 'f-both', ord: 0, text: 'alpha beta', embedding: [1, 0, 0] });
    // f-vector-only is near in vector space but shares no words with the
    // query, so only the vector arm recalls it — the vector CTE has no
    // content predicate (unlike the lexical CTE's `AND c.tsv @@ tsQuery`),
    // so this is the reliable way to prove a chunk with no lexical match
    // still gets vector-only fields.
    await seedChunk({ storeId, fileId: 'f-vector-only', ord: 0, text: 'no shared words here', embedding: [0.9, 0.1, 0] });

    const candidates = await recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'nadia@example.com',
      queryText: 'alpha beta',
      queryEmbedding: [1, 0, 0],
    });

    expect(candidates.length).toBe(2);
    for (const c of candidates) {
      // every candidate came from at least one arm
      expect(c.vectorRank !== undefined || c.lexicalRank !== undefined).toBe(true);
      expect(typeof c.score).toBe('number');
    }

    // The core regression this test guards: today `byId.set(id, row)` keeps
    // only the LAST row seen per candidate id, so f-both (present in both
    // the vec and lex CTE result sets) would silently lose one arm's
    // rank/score. Both must survive.
    const both = candidates.find((c) => c.fileId === 'f-both')!;
    expect(both.vectorRank).toBeDefined();
    expect(both.vectorScore).toBeDefined();
    expect(both.lexicalRank).toBeDefined();
    expect(both.lexicalScore).toBeDefined();

    const vectorOnly = candidates.find((c) => c.fileId === 'f-vector-only')!;
    expect(vectorOnly.vectorRank).toBeDefined();
    expect(vectorOnly.lexicalRank).toBeUndefined();
    expect(vectorOnly.lexicalScore).toBeUndefined();

    // the vector arm ranks by ascending cosine distance (lower is better) —
    // f-both (embedding [1,0,0], identical to the query) must rank ahead of
    // f-vector-only ([0.9,0.1,0]).
    expect(both.vectorRank!).toBeLessThan(vectorOnly.vectorRank!);
    expect(both.vectorScore!).toBeLessThanOrEqual(vectorOnly.vectorScore!);

    // `toBeDefined()` alone does not pin lexicalScore's VALUE — a sign-
    // inverted `-ts_rank(...)` or an uninformative `0.5::float4` constant
    // would both still be "defined" and pass every assertion above. Compute
    // the same ts_rank Postgres would have produced for f-both's own text
    // against the same query, straight from the table (bypassing
    // recallCandidates entirely), and assert recall.ts's returned
    // lexicalScore equals it to float4 precision.
    // hybrid.lexical_query "any" (the default): the query is the OR of the question's terms.
    const rawTsRank = await pool.query<{ score: number }>(
      `SELECT ts_rank(c.tsv, to_tsquery('simple', 'alpha | beta')) AS score
       FROM vector_store_chunks c
       WHERE c.store_id = $1 AND c.file_id = $2 AND c.ord = $3`,
      [ storeId, 'f-both', 0 ],
    );
    expect(rawTsRank.rows.length).toBe(1);
    expect(both.lexicalScore!).toBeCloseTo(rawTsRank.rows[0].score, 5);
  });

  // Symmetric to f-vector-only above: the vector CTE's own `LIMIT` (not a
  // content predicate — the vector arm always ranks the WHOLE candidate set,
  // just capped) can truncate a chunk out of the vector arm's result set
  // while the lexical arm's content predicate (`AND c.tsv @@ tsQuery`) still
  // recalls it. Proves vectorRank/vectorScore end up undefined for a chunk
  // that only survives via the lexical arm, not just the reverse direction
  // already covered by f-vector-only.
  it('leaves vectorRank/vectorScore undefined for a chunk recalled by the lexical arm but truncated out of the vector arm\'s LIMIT', async () => {
    mockConfig.hybrid.candidates = 2;
    const storeId = await seedStore('penny@example.com');
    // Two decoys identical (and thus tied-closest) to the query embedding,
    // with text that shares no words with the query — these fill the vector
    // CTE's LIMIT 2 entirely, pushing f-lexical-only (embedding orthogonal,
    // so worse cosine distance) out of the vector arm altogether.
    await seedChunk({ storeId, fileId: 'f-decoy-a', ord: 0, text: 'zzz unrelated decoy one', embedding: [1, 0, 0] });
    await seedChunk({ storeId, fileId: 'f-decoy-b', ord: 0, text: 'zzz unrelated decoy two', embedding: [1, 0, 0] });
    // Strong, repeated lexical match but orthogonal embedding: excluded from
    // the vector arm's top 2 by distance, recalled only by the lexical arm.
    await seedChunk({
      storeId, fileId: 'f-lexical-only', ord: 0, text: 'alpha beta alpha beta alpha beta', embedding: [0, 1, 0],
    });

    const candidates = await recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'penny@example.com',
      queryText: 'alpha beta',
      queryEmbedding: [1, 0, 0],
    });

    const lexicalOnly = candidates.find((c) => c.fileId === 'f-lexical-only');
    expect(lexicalOnly).toBeDefined();
    expect(lexicalOnly!.lexicalRank).toBeDefined();
    expect(lexicalOnly!.lexicalScore).toBeDefined();
    expect(lexicalOnly!.vectorRank).toBeUndefined();
    expect(lexicalOnly!.vectorScore).toBeUndefined();
  });

  it('leaves lexical fields undefined for every candidate when hybrid.lexicalEnabled is false', async () => {
    mockConfig.hybrid.lexicalEnabled = false;
    const storeId = await seedStore('oscar@example.com');
    await seedChunk({ storeId, fileId: 'f-1', ord: 0, text: 'alpha beta', embedding: [1, 0, 0] });
    await seedChunk({ storeId, fileId: 'f-2', ord: 0, text: 'alpha beta', embedding: [0, 1, 0] });

    const candidates = await recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'oscar@example.com',
      queryText: 'alpha beta',
      queryEmbedding: [1, 0, 0],
    });

    expect(candidates.length).toBe(2);
    expect(candidates.every((c) => c.lexicalRank === undefined)).toBe(true);
    expect(candidates.every((c) => c.lexicalScore === undefined)).toBe(true);
    expect(candidates.every((c) => c.vectorRank !== undefined)).toBe(true);
    expect(candidates.every((c) => c.vectorScore !== undefined)).toBe(true);
  });

  // Final whole-branch review, near-free #15: neither CTE's ORDER BY had a
  // deterministic tiebreaker, so ROW_NUMBER() among exactly-tied rows was
  // unspecified and fuseRrf's RRF fusion is only deterministic given
  // deterministic input. Seeds enough exactly-tied chunks (identical
  // embedding -> identical cosine distance; identical text -> identical
  // ts_rank) that an UNSPECIFIED order would show up as flakiness across
  // repeated runs, then asserts the same call returns byte-identical
  // orderings every time.
  it('returns a stable, repeatable ordering for chunks tied on both vector distance and lexical rank', async () => {
    const storeId = await seedStore('mallory@example.com');
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await seedChunk({
        storeId, fileId: `f-tied-${i}`, ord: 0, text: 'identical wording every time', embedding: [1, 0, 0],
      });
    }

    const runOnce = () => recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'mallory@example.com',
      queryText: 'identical wording every time',
      queryEmbedding: [1, 0, 0],
    });

    const first = await runOnce();
    expect(first.length).toBe(8);
    const firstOrder = first.map((r) => r.fileId);
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const again = await runOnce();
      expect(again.map((r) => r.fileId)).toEqual(firstOrder);
    }
  });

  // hybrid_search weights: A is the closest vector with no query term, B matches the
  // query text with a far vector. Unweighted, B wins (it is in both lists).
  it('hybridWeights steer the fusion toward the vector or the full-text ranking', async () => {
    const storeId = await seedStore('nina@example.com');
    await seedChunk({ storeId, fileId: 'f-A', ord: 0, text: 'plum kiwi mango', embedding: [1, 0, 0] });
    await seedChunk({ storeId, fileId: 'f-B', ord: 0, text: 'zebra crossing', embedding: [0, 1, 0] });

    const run = async (hybridWeights?: { embedding: number; text: number }) => (await recallCandidates({
      storeIds: [storeId],
      ownerEmail: 'nina@example.com',
      queryText: 'zebra',
      queryEmbedding: [1, 0, 0],
      hybridWeights,
    })).map((r) => r.fileId);

    expect(await run()).toEqual(['f-B', 'f-A']);
    expect(await run({ embedding: 1, text: 1 })).toEqual(['f-B', 'f-A']);
    expect((await run({ embedding: 1, text: 0 }))[0]).toBe('f-A');
    expect((await run({ embedding: 0, text: 1 }))[0]).toBe('f-B');
  });
  // ---------------------------------------------------------------------
  // hybrid.lexical_query: "any" ORs the question's non-stop-word terms; "all" is the
  // original plainto_tsquery (every word, stop words included, must be in the chunk).
  // ---------------------------------------------------------------------
  describe('the full-text query for natural-language questions', () => {
    const QUESTION = "What port does the optional Ollama service use for SAIL-PROXY's Ollama compatibility feature?";
    const ANSWER = 'Optional Ollama service on port 11434';

    async function lexicalHits(storeId: string, owner: string, queryText: string, extra: Record<string, unknown> = {}) {
      const results = await recallCandidates({ storeIds: [storeId], ownerEmail: owner, queryText, queryEmbedding: [0, 0, 1], ...extra });
      return results.filter((r) => r.lexicalRank !== undefined);
    }

    it('matches the chunk that answers a question, which the all-words query misses', async () => {
      const storeId = await seedStore('quinn@example.com');
      await seedChunk({ storeId, fileId: 'f-answer', ord: 0, text: ANSWER, embedding: [1, 0, 0] });
      await seedChunk({ storeId, fileId: 'f-noise', ord: 0, text: 'what does the for', embedding: [0, 1, 0] });

      const any = await lexicalHits(storeId, 'quinn@example.com', QUESTION);
      // Only stop words in common: f-noise is not recalled by the full-text arm.
      expect(any.map((r) => r.fileId)).toEqual(['f-answer']);
      expect(any[0].lexicalScore).toBeGreaterThan(0);

      mockConfig.hybrid.lexicalQuery = 'all';
      expect(await lexicalHits(storeId, 'quinn@example.com', QUESTION)).toEqual([]);
    });

    it('"all" keeps the original all-words match and score', async () => {
      mockConfig.hybrid.lexicalQuery = 'all';
      const storeId = await seedStore('rita@example.com');
      await seedChunk({ storeId, fileId: 'f-all', ord: 0, text: 'the quarterly report for the board', embedding: [1, 0, 0] });
      await seedChunk({ storeId, fileId: 'f-part', ord: 0, text: 'the quarterly numbers', embedding: [0, 1, 0] });

      const hits = await lexicalHits(storeId, 'rita@example.com', 'the quarterly report');
      expect(hits.map((r) => r.fileId)).toEqual(['f-all']);
      const raw = await pool.query<{ score: number }>(
        `SELECT ts_rank(tsv, plainto_tsquery('simple', $1)) AS score FROM vector_store_chunks WHERE store_id = $2 AND file_id = 'f-all'`,
        ['the quarterly report', storeId],
      );
      expect(hits[0].lexicalScore!).toBeCloseTo(raw.rows[0].score, 5);
    });

    it('never turns quotes, backslashes, operators or Unicode in the question into a tsquery error', async () => {
      const storeId = await seedStore('sam@example.com');
      await seedChunk({ storeId, fileId: 'f-de', ord: 0, text: 'Die Größe der Straße über dem Fluß', embedding: [1, 0, 0] });
      await seedChunk({
        storeId, fileId: 'f-url', ord: 0, text: String.raw`see http://x.org/a'b\c and C:\Users\demo`, embedding: [0, 1, 0],
      });
      const questions = [
        "it's rock'n'roll 'quoted' \"double\" question",
        String.raw`back\slash \\ \' \" trailing\ `,
        '& | ! ( ) : * <-> <2> !( a & b ) | ',
        'foo:* bar:A baz:*AB & !qux',
        "''' \\\\ ''",
        String.raw`http://x.org/a'b\c`,
        'Wie groß ist die Straße über dem Fluß?',
        'Ünïcödé émoji 😀 中文 العربية',
        '   ',
        '',
      ];
      for (const q of questions) {
        // eslint-disable-next-line no-await-in-loop
        await expect(recallCandidates({ storeIds: [storeId], ownerEmail: 'sam@example.com', queryText: q, queryEmbedding: [0, 0, 1] }))
          .resolves.toEqual(expect.any(Array));
      }
      expect((await lexicalHits(storeId, 'sam@example.com', 'Wie groß ist die Straße?')).map((r) => r.fileId)).toEqual(['f-de']);
      expect((await lexicalHits(storeId, 'sam@example.com', String.raw`what is http://x.org/a'b\c`)).map((r) => r.fileId))
        .toEqual(['f-url']);
    });

    // Bounded work for common terms: when at least `limit` chunks contain every term, the OR
    // arm (which ranks every chunk with any term) does not run.
    it('takes the AND matches when there are enough of them, and the OR matches otherwise', async () => {
      mockConfig.hybrid.candidates = 2;
      const storeId = await seedStore('yuri@example.com');
      await seedChunk({ storeId, fileId: 'f-both-1', ord: 0, text: 'retry policy of the gateway', embedding: [1, 0, 0] });
      await seedChunk({ storeId, fileId: 'f-one', ord: 0, text: 'gateway gateway gateway gateway', embedding: [1, 0, 0] });
      const question = 'What is the retry policy of the gateway?';

      // one chunk has every term: fewer than the limit of 2, so the OR arm ranks
      const or = await lexicalHits(storeId, 'yuri@example.com', question);
      expect(or.map((r) => r.fileId).sort()).toEqual(['f-both-1', 'f-one']);

      await seedChunk({ storeId, fileId: 'f-both-2', ord: 0, text: 'the gateway retry policy', embedding: [1, 0, 0] });
      const and = await lexicalHits(storeId, 'yuri@example.com', question);
      expect(and.map((r) => r.fileId).sort()).toEqual(['f-both-1', 'f-both-2']);
      const raw = await pool.query<{ score: number }>(
        `SELECT ts_rank(tsv, to_tsquery('simple', 'retry & policy & gateway')) AS score
         FROM vector_store_chunks WHERE store_id = $1 AND file_id = 'f-both-2'`, [storeId]);
      expect(and.find((r) => r.fileId === 'f-both-2')!.lexicalScore!).toBeCloseTo(raw.rows[0].score, 5);
    });

    it('keeps only the first 32 distinct terms of a long question, in question order', async () => {
      const words = Array.from({ length: 100 }, (_, i) => `term${String(i).padStart(3, '0')}`);
      // stop words, one-letter tokens and repeats in between do not count towards the 32
      const question = words.map((w, i) => (i % 3 ? w : `the ${w} a ${words[0]}`)).join(' ');
      const client = await pool.connect();
      try {
        const q = (await client.query(OR_QUERY_SQL, [question, STOP_WORDS])).rows[0].q as string;
        expect(q).toBe(words.slice(0, 32).map((w) => `'${w}'`).join(' | '));
      } finally {
        client.release();
      }
      // the cap is on the query, not on matching: a chunk with only the 33rd term is not recalled
      const storeId = await seedStore('xena@example.com');
      await seedChunk({ storeId, fileId: 'f-32', ord: 0, text: words[31], embedding: [1, 0, 0] });
      await seedChunk({ storeId, fileId: 'f-33', ord: 0, text: words[32], embedding: [1, 0, 0] });
      expect((await lexicalHits(storeId, 'xena@example.com', question)).map((r) => r.fileId)).toEqual(['f-32']);
    });

    it('builds the same OR query whether standard_conforming_strings is on or off', async () => {
      const question = String.raw`see C:\Users\demo and http://x.org/a'b\c it's`;
      const client = await pool.connect();
      try {
        const build = async (scs: 'on' | 'off') => {
          await client.query(`SET standard_conforming_strings = ${scs}`);
          return (await client.query(OR_QUERY_SQL, [question, STOP_WORDS])).rows[0].q as string;
        };
        const on = await build('on');
        const off = await build('off');
        expect(off).toBe(on);
        // the quote inside a URL lexeme is escaped; the parser splits at a backslash
        // in question order: the parser emits a URL whole and then its host and path, each at the
        // next position ('x.org/a''b':6 'x.org':7 '/a''b':8)
        expect(on).toBe(String.raw`'see' | 'users' | 'demo' | 'x.org/a''b' | 'x.org' | '/a''b'`);
      } finally {
        await client.query('RESET standard_conforming_strings');
        client.release();
      }
    });

    it('skips the full-text arm for a question of only stop words and single letters, without a NOTICE; the vector arm still answers', async () => {
      const storeId = await seedStore('tara@example.com');
      await seedChunk({ storeId, fileId: 'f-1', ord: 0, text: 'what is it and how does a b c work', embedding: [1, 0, 0] });

      for (const q of ['What is it?', 'a b c', 'Was ist das und wie?', 'x', '?!']) {
        // eslint-disable-next-line no-await-in-loop
        const results = await recallCandidates({ storeIds: [storeId], ownerEmail: 'tara@example.com', queryText: q, queryEmbedding: [1, 0, 0] });
        expect(results.map((r) => r.fileId)).toEqual(['f-1']);
        expect(results[0].vectorRank).toBe(1);
        expect(results[0].lexicalRank).toBeUndefined();
      }
      expect(notices).toEqual([]);
      expect(STOP_WORDS).toEqual(expect.arrayContaining(['what', 'is', 'it', 'was', 'ist', 'das']));
    });

    it('still applies the attribute filter to the full-text arm', async () => {
      const storeId = await seedStore('uma@example.com');
      await seedChunk({ storeId, fileId: 'f-in', ord: 0, text: 'invoice totals', embedding: [1, 0, 0], attributes: { dept: 'finance' } });
      await seedChunk({ storeId, fileId: 'f-out', ord: 0, text: 'invoice archive', embedding: [1, 0, 0], attributes: { dept: 'legal' } });
      await seedChunk({ storeId, fileId: 'f-out2', ord: 0, text: 'archive totals', embedding: [1, 0, 0], attributes: { dept: 'legal' } });

      const unfiltered = await lexicalHits(storeId, 'uma@example.com', 'Where are the invoice totals or the archive?');
      expect(unfiltered.map((r) => r.fileId).sort()).toEqual(['f-in', 'f-out', 'f-out2']);

      const results = await recallCandidates({
        storeIds: [storeId], ownerEmail: 'uma@example.com', queryText: 'Where are the invoice totals or the archive?',
        queryEmbedding: [1, 0, 0], filter: { type: 'eq', key: 'dept', value: 'finance' },
      });
      expect(results.map((r) => r.fileId)).toEqual(['f-in']);
      expect(results[0].lexicalRank).toBe(1);
    });

    it('ranks a chunk with more of the terms higher, and ts_rank_cd is selectable for the evaluation', async () => {
      const storeId = await seedStore('vera@example.com');
      await seedChunk({ storeId, fileId: 'f-two', ord: 0, text: 'configure the winston logger here', embedding: [0, 1, 0] });
      await seedChunk({ storeId, fileId: 'f-one', ord: 0, text: 'the logger', embedding: [0, 1, 0] });
      const q = 'Where do I configure the winston logger?';
      expect((await lexicalHits(storeId, 'vera@example.com', q)).sort((a, b) => a.lexicalRank! - b.lexicalRank!).map((r) => r.fileId))
        .toEqual(['f-two', 'f-one']);
      setLexicalRankFunction('ts_rank_cd');
      try {
        const cd = await lexicalHits(storeId, 'vera@example.com', q);
        const raw = await pool.query<{ score: number }>(
          `SELECT ts_rank_cd(tsv, to_tsquery('simple', 'configure | logger | winston')) AS score
           FROM vector_store_chunks WHERE store_id = $1 AND file_id = 'f-two'`, [storeId]);
        expect(cd.find((r) => r.fileId === 'f-two')!.lexicalScore!).toBeCloseTo(raw.rows[0].score, 5);
      } finally {
        setLexicalRankFunction('ts_rank');
      }
    });

    // Review focus 5: on a large store the OR query is answered from the GIN index.
    it('uses the GIN index idx_chunks_tsv for the OR query on a large store', async () => {
      const storeId = await seedStore('wendy@example.com');
      await seedChunk({ storeId, fileId: 'f-big', ord: 0, text: 'seed', embedding: [1, 0, 0] });
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding)
         SELECT $1, 'f-big', g, 'filler text number ' || g || ' about common things', '[0,1,0]'
         FROM generate_series(1, 20000) g`, [storeId]);
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding)
         VALUES ($1, 'f-big', 20001, 'the rare zymurgy chapter', '[0,1,0]')`, [storeId]);
      // VACUUM, not only ANALYZE: the GIN index's own statistics (which the planner's cost
      // estimate for it reads) are written by VACUUM, as autovacuum does on a live store.
      await pool.query('VACUUM ANALYZE vector_store_chunks');

      // Capture the statement recallCandidates sends, then EXPLAIN it with the same parameters.
      let captured: { sql: string; params: unknown[] } | undefined;
      const realConnect = pool.connect.bind(pool);
      const spy = jest.spyOn(pool, 'connect').mockImplementation((async () => {
        const client: any = await realConnect();
        const realQuery = client.query.bind(client);
        client.query = (sql: any, params?: any) => {
          if (typeof sql === 'string' && sql.includes('\nlex AS (')) captured = { sql, params };
          return realQuery(sql, params);
        };
        const realRelease = client.release.bind(client);
        client.release = (...a: any[]) => { client.query = realQuery; client.release = realRelease; return realRelease(...a); };
        return client;
      }) as any);
      let hits;
      try {
        hits = await lexicalHits(storeId, 'wendy@example.com', 'Which chapter covers zymurgy?');
      } finally {
        spy.mockRestore();
      }
      expect(hits.map((r) => r.ord)).toEqual([20001]);
      expect(captured).toBeDefined();

      const client = await pool.connect();
      try {
        const plan = await client.query(`EXPLAIN (FORMAT JSON) ${captured!.sql}`, captured!.params as any[]);
        const text = JSON.stringify(plan.rows[0]['QUERY PLAN']);
        expect(text).toContain('idx_chunks_tsv');
      } finally {
        client.release();
      }
    });
  });
});
