// Search over structured chunks against a real Postgres (fake embedder, no
// reranker, no SAP calls), review focus 4:
// - parent sections are rebuilt from the hit's own file, generation and section,
//   contain the hit chunk at its offset and never exceed the limit;
// - the Responses tool returns parents, collapsed per section, and the model-bound
//   results, the client's file_search_call results and the citations agree and
//   point at the hit's file; the REST search keeps returning chunks;
// - the full-text arm finds a chunk by its context, and on a realistic table its
//   plan (store and generation filter) reads indexes, not the whole chunk table.
import { Client, Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { chunkStructuredWithSections, countTokens } from '../../../src/fileSearch/structureChunker';
import { closeStructureChunkThread } from '../../../src/fileSearch/structureChunkThread';
import { loadParentSections } from '../../../src/fileSearch/parentSections';
import { buildCitations } from '../../../src/plugins/fileSearch/citations';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'parents-owner@example.test';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => {
  const api = {
    getFileSearchConfig: () => mockConfig,
    getTeacherLoggingConfig: () => ({ enabled: false }),
    getFileSearchToolConfig: () => ({ maxNumResultsDefault: 10 }),
  };
  return { __esModule: true, ...api, default: api, MIN_RESULTS_DEFAULT: 1, MAX_RESULTS_DEFAULT: 50 };
});

jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: async (texts: string[]) => ({
    vectors: texts.map((t) => (t.includes('bravo') ? [0, 1, 0] : [1, 0, 0.1])),
    usage: { promptTokens: texts.length, totalTokens: texts.length },
  }),
}));
jest.mock('../../../src/fileSearch/reranker', () => ({ __esModule: true, rerank: async () => null }));

// eslint-disable-next-line import/first
import { processOne } from '../../../src/fileSearch/ingestWorker';
// eslint-disable-next-line import/first
import { searchVectorStores } from '../../../src/fileSearch/search';
// eslint-disable-next-line import/first
import { fileSearchDescriptor } from '../../../src/plugins/fileSearch/descriptor';

const LIMIT = 300;

function freshConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'model-a',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 10_000_000, maxTokensPerFile: 5_000_000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 2, extractTimeoutMs: 10000, maxRetries: 3 },
    parentSections: { maxTokens: LIMIT, scope: 'tool' },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

/** Two documents with the same headings (so the same section numbers), told apart by their words. */
function doc(tag: string): string {
  const lines = (topic: string, n: number) => Array.from({ length: n }, (_, i) =>
    `The ${tag} ${topic} setting ${i} controls part ${i} of the ${topic} flow. Its ${tag} default is ${i * 3}.`).join('\n\n');
  return [
    `# ${tag} handbook`, '', lines('intro', 6), '',
    '## Limits', '', lines('limits', 40), '',
    '## Retries', '', lines('retries', 40), '',
    '## Logging', '', lines('logging', 12),
  ].join('\n');
}
const DOCS: Record<string, string> = { alpha: doc('alpha'), bravo: doc('bravo') };

d('parent sections in search (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let storeId: string;
  const fileOf: Record<string, string> = {};

  beforeAll(async () => {
    mockConfig = freshConfig();
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
    const store = await repo.createStore({
      ownerEmail: OWNER, chunking: { type: 'structure', max_tokens: 120, overlap_tokens: 30, contextual: false },
    });
    storeId = store.id;
    for (const [tag, content] of Object.entries(DOCS)) {
      const bytes = Buffer.from(content, 'utf8');
      const sha = sha256Of(bytes);
      // eslint-disable-next-line no-await-in-loop
      await retainBlob(sha, bytes, 'text/markdown');
      const fileId = newFileId();
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
         VALUES ($1, $2, $3, 'assistants', $4, $5, now())`, [fileId, OWNER, `${tag}.md`, sha, bytes.length]);
      // eslint-disable-next-line no-await-in-loop
      await repo.attachFile(storeId, fileId, null, null);
      // eslint-disable-next-line no-await-in-loop
      await processOne(storeId, fileId);
      fileOf[tag] = fileId;
    }
    const { rows } = await pool.query(`SELECT status FROM vector_store_files WHERE store_id = $1`, [storeId]);
    expect(rows.every((r) => r.status === 'completed')).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await closeStructureChunkThread();
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => { mockConfig = freshConfig(); });

  const tagOfFile = (fileId: string) => Object.keys(fileOf).find((t) => fileOf[t] === fileId)!;

  it('every chunk\'s parent: from its own file and section, holding the chunk at its offset, never over the limit', async () => {
    const { rows } = await pool.query(
      `SELECT file_id, generation, section, ord, section_offset, text FROM vector_store_chunks
        WHERE store_id = $1 ORDER BY file_id, ord`, [storeId]);
    expect(rows.length).toBeGreaterThan(30);
    const sectionStarts: Record<string, number[]> = Object.fromEntries(Object.entries(DOCS).map(([tag, text]) => [tag,
      chunkStructuredWithSections(text, { maxTokens: 120, overlapTokens: 30, format: 'markdown' }).sections.map((x) => x.start)]));
    const hits = rows.map((r) => ({
      storeId, fileId: r.file_id, generation: r.generation, section: r.section, ord: r.ord, sectionOffset: r.section_offset, text: r.text,
    }));
    for (const limit of [LIMIT, 8000]) {
      // eslint-disable-next-line no-await-in-loop
      const parents = (await loadParentSections(hits, limit)).map((p) => p?.text ?? null);
      parents.forEach((parent, i) => {
        const hit = hits[i];
        const own = DOCS[tagOfFile(hit.fileId)];
        expect(parent).not.toBeNull();
        expect(countTokens(parent!)).toBeLessThanOrEqual(Math.max(limit, countTokens(hit.text)));
        expect(parent).toContain(hit.text);
        expect(own).toContain(parent); // never crosses into the other file (same section numbers)
        // the window covers the hit's own place in the document (section start + offset)
        const at = sectionStarts[tagOfFile(hit.fileId)][hit.section] + hit.sectionOffset;
        const windowStart = own.indexOf(parent!);
        expect(own.lastIndexOf(parent!)).toBe(windowStart);
        expect(windowStart).toBeLessThanOrEqual(at);
        expect(at + hit.text.length).toBeLessThanOrEqual(windowStart + parent!.length);
      });
    }
    // With a large limit a parent is the whole section: the Limits section of alpha, exactly.
    const limitsHit = hits.find((h) => h.fileId === fileOf.alpha && h.text.includes('limits setting 20'))!;
    const whole = (await loadParentSections([limitsHit], 8000))[0]?.text;
    const own = DOCS.alpha;
    expect(whole).toBe(own.slice(own.indexOf('## Limits'), own.indexOf('## Retries')).trim());
  }, 60_000);

  it('the tool gets one parent per section, within the limit, from the hit\'s own file; the REST search gets chunks', async () => {
    const query = 'alpha retries setting 17 controls part';
    const tool = await searchVectorStores({ storeIds: [storeId], query, ownerEmail: OWNER, maxNumResults: 5, surface: 'tool' });
    const api = await searchVectorStores({ storeIds: [storeId], query, ownerEmail: OWNER, maxNumResults: 5 });
    const { rows } = await pool.query('SELECT text FROM vector_store_chunks WHERE store_id = $1', [storeId]);
    const chunkTexts = new Set(rows.map((r) => r.text));
    expect(api.data.every((h) => chunkTexts.has(h.content[0].text))).toBe(true);
    expect(tool.data.length).toBeGreaterThan(1);
    const seen = new Set<string>();
    for (const hit of tool.data) {
      const text = hit.content[0].text;
      expect(countTokens(text)).toBeLessThanOrEqual(LIMIT);
      expect(DOCS[tagOfFile(hit.fileId)]).toContain(text);
      // one result per section: no two results overlap
      for (const other of seen) expect(other.includes(text) || text.includes(other)).toBe(false);
      seen.add(text);
    }
    // the best hit's parent is longer than its chunk and holds it
    expect(tool.data[0].content[0].text.length).toBeGreaterThan(api.data[0].content[0].text.length);
    expect(tool.data[0].content[0].text).toContain(api.data[0].content[0].text);
    expect(tool.data[0].fileId).toBe(api.data[0].fileId);
  }, 60_000);

  it('the Responses tool: the model-bound results, the client\'s results and the citations agree and point at the hit\'s file', async () => {
    const prepared = await fileSearchDescriptor.prepare!({ vector_store_ids: [storeId], max_num_results: 4 }, {
      ownerEmail: OWNER, logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    } as any);
    const call = fileSearchDescriptor.parseCall('call_1', JSON.stringify({ query: 'bravo logging setting 5 default' }));
    const result = await fileSearchDescriptor.execute(call, {
      prepared, ownerEmail: OWNER, isStreaming: false, replacementMap: undefined, maskingConfig: undefined,
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    } as any);
    expect(result.status).toBe('completed');
    const payload = result.payload as any;
    const hitTexts = payload.hits.map((h: any) => h.content[0].text);
    expect(hitTexts.length).toBeGreaterThan(0);
    // model-bound (no masking on this request) == client-bound == hits
    expect(payload.maskedResults.map((r: any) => r.text)).toEqual(hitTexts);
    const output = JSON.parse(fileSearchDescriptor.renderOutput(result).output);
    expect(output.results.map((r: any) => r.text)).toEqual(hitTexts);
    const item = fileSearchDescriptor.renderCallItem!(result, { includeResults: true } as any);
    expect(item.results.map((r: any) => r.text)).toEqual(hitTexts);
    expect(item.results.map((r: any) => r.file_id)).toEqual(payload.hits.map((h: any) => h.fileId));
    // parents, not chunks: longer than any stored chunk of this store
    const { rows: [{ longest }] } = await pool.query('SELECT max(length(text))::int AS longest FROM vector_store_chunks WHERE store_id = $1', [storeId]);
    expect(Math.max(...hitTexts.map((t: string) => t.length))).toBeGreaterThan(longest);

    // The model quotes a sentence of the first parent; the citation names that hit's file.
    const top = payload.hits[0];
    const sentence = top.content[0].text.split(/(?<=\.)\s+/).find((s: string) => s.length > 40)!;
    const message = `According to the handbook, "${sentence}" That is all.`;
    const { annotations } = buildCitations(message, payload.hits, undefined);
    expect(annotations.length).toBeGreaterThan(0);
    const first = annotations.find((a) => message.slice(a.start_index, a.end_index).length >= 30)!;
    expect(first.file_id).toBe(top.fileId);
    expect(tagOfFile(first.file_id)).toBe('bravo');
    expect(sentence).toContain(message.slice(first.start_index, first.end_index));
  }, 60_000);

  it('the full-text arm finds a structured chunk by its heading path (its context)', async () => {
    const candidates = await repo.recallCandidates({
      storeIds: [storeId], ownerEmail: OWNER, queryText: 'handbook', queryEmbedding: [0, 0, 1], limit: 200,
    });
    const lexical = candidates.filter((c) => c.lexicalRank !== undefined);
    // "handbook" is in the heading line only, yet every chunk under it carries it in its context
    expect(lexical.length).toBeGreaterThan(10);
    expect(lexical.filter((c) => !/handbook/.test(c.text)).length).toBeGreaterThan(5);
    expect(lexical.every((c) => c.section !== undefined && /handbook/.test(c.context ?? ''))).toBe(true);
  });
});

d('the lexical arm on a realistic table reads indexes (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = freshConfig();
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
    // 40 stores: one large (20,000 chunks, structured, a third with a context), the rest
    // 1,500 chunks each (static, no context) — 78,500 chunks in all.
    await pool.query(`INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ('blob', 1, 'inline')`);
    await pool.query(
      `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim, chunking)
       SELECT 'vs_' || g, $1, 'model-a', ${EMBED_DIM}, NULL FROM generate_series(0, 39) AS g`, [OWNER]);
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       SELECT 'file_' || s || '_' || f, $1, 'f.md', 'assistants', 'blob', 1
         FROM generate_series(0, 39) AS s, generate_series(0, 19) AS f`, [OWNER]);
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status)
       SELECT 'vs_' || s, 'file_' || s || '_' || f, 'completed' FROM generate_series(0, 39) AS s, generate_series(0, 19) AS f`);
    const words = `ARRAY['gateway','port','retry','limit','token','store','chunk','search','model','cache','queue','worker']`;
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding, context, context_tsv, section, section_offset, heading_path)
       SELECT 'vs_' || s, 'file_' || s || '_' || (o % 20), o,
              (${words})[1 + o % 12] || ' ' || (${words})[1 + (o * 7) % 12] || ' text ' || o, 5,
              ('[' || (o % 7) || ',1,' || (s % 5) || ']')::vector,
              ctx, to_tsvector('simple', ctx),
              CASE WHEN s = 0 THEN o / 10 END, CASE WHEN s = 0 THEN (o % 10) * 40 END,
              CASE WHEN s = 0 THEN 'Guide > Part ' || (o / 10) END
         FROM generate_series(0, 39) AS s
         CROSS JOIN LATERAL generate_series(0, CASE WHEN s = 0 THEN 19999 ELSE 1499 END) AS o
         CROSS JOIN LATERAL (SELECT CASE WHEN s = 0 AND o % 3 = 0
                                         THEN 'Guide > Part ' || (o / 10) || E'\\n' || 'zebra context ' || (o % 50) END AS ctx) c`);
    await pool.query('ANALYZE');
  }, 120_000);

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  /** recallCandidates' own statement, EXPLAINed with its own parameters. */
  async function recallPlan(storeIds: string[], queryText: string): Promise<string> {
    let statement: { text: string; params: any[] } | null = null;
    const original = Client.prototype.query;
    jest.spyOn(Client.prototype, 'query').mockImplementation(function query(this: Client, ...args: any[]) {
      const text = typeof args[0] === 'string' ? args[0] : undefined;
      if (text && text.trimStart().startsWith('WITH') && Array.isArray(args[1])) statement = { text, params: [...args[1]] };
      return (original as any).apply(this, args);
    });
    try {
      await repo.recallCandidates({ storeIds, ownerEmail: OWNER, queryText, queryEmbedding: [1, 1, 0], limit: 50 });
    } finally {
      jest.restoreAllMocks();
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL jit = off');
      const { rows } = await client.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${statement!.text}`, statement!.params);
      await client.query('ROLLBACK');
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      client.release();
    }
  }

  it('the large store and a small one: no sequential scan of the chunk table, in either arm', async () => {
    const plans: string[] = [];
    for (const [stores, query] of [[['vs_0'], 'zebra gateway'], [['vs_7'], 'zebra gateway'], [['vs_0', 'vs_7'], 'retry worker port']] as const) {
      // eslint-disable-next-line no-await-in-loop
      const plan = await recallPlan([...stores], query);
      plans.push(`-- stores ${stores.join(', ')}, query "${query}"\n${plan}`);
      expect(plan).not.toMatch(/Seq Scan on vector_store_chunks/);
      expect(plan).toMatch(/Index|Bitmap/);
    }
    if (process.env.FILE_SEARCH_PRINT_PLANS === '1') {
      // eslint-disable-next-line no-console
      console.log(plans.join('\n\n'));
    }
  }, 60_000);

  it('the context matches through the full-text arm', async () => {
    const candidates = await repo.recallCandidates({
      storeIds: ['vs_0'], ownerEmail: OWNER, queryText: 'zebra', queryEmbedding: [1, 1, 0], limit: 50,
    });
    const lexical = candidates.filter((c) => c.lexicalRank !== undefined);
    expect(lexical.length).toBeGreaterThan(10);
    expect(lexical.every((c) => /zebra/.test(c.context ?? '') && !/zebra/.test(c.text))).toBe(true);
  });
});
