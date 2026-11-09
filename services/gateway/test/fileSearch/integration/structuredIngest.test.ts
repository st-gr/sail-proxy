// Ingestion by the store's chunking setting, against a real Postgres with a
// fake embedder and a fake context model (no SAP calls):
// - static: exactly today's chunks (the static pins), no section, no context,
//   embedded with the chunk text alone;
// - structure: section, offset and heading path per chunk, the heading path as
//   context, context_tsv from the one shared statement, embedded with context
//   and text; the chunker runs in its thread;
// - contextual: the LLM's sentence after the heading path; a partial or total
//   failure of the context model never fails the file (review focus 2), and the
//   job and the usage events count only what was spent;
// - chunks of only whitespace are stored but never embedded, and never recalled;
// - a re-embed copies the new columns into the next generation and embeds
//   context + text without calling the context model; an ingestion during a
//   re-embed writes the same rows into both generations.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import { chunkText } from '../../../src/fileSearch/chunker';
import { chunkStructured } from '../../../src/fileSearch/structureChunker';
import { closeStructureChunkThread } from '../../../src/fileSearch/structureChunkThread';
import usageEmitter from '../../../src/services/usageEventEmitter';
import { STATIC_CHUNK_PINS } from '../fixtures/staticChunkPins';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'structured-owner@example.test';
const CORPUS = join(__dirname, '../../../../../ci/file-search-eval/corpus/markdown');

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
  default: { getFileSearchConfig: () => mockConfig },
}));

const embedMock: any = jest.fn();
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: (...a: any[]) => embedMock(...a),
}));

const completeMock: any = jest.fn();
jest.mock('../../../src/fileSearch/orchestrationCompletion', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/orchestrationCompletion'),
  __esModule: true,
  orchestrationComplete: (...a: any[]) => completeMock(...a),
}));

jest.mock('../../../src/fileSearch/reranker', () => ({ __esModule: true, rerank: async () => null }));

// eslint-disable-next-line import/first
import { processOne } from '../../../src/fileSearch/ingestWorker';
// eslint-disable-next-line import/first
import { estimateStore, startReembed } from '../../../src/fileSearch/reembed';
// eslint-disable-next-line import/first
import { claimNextReembedItem, processReembedItem } from '../../../src/fileSearch/reembedWorker';
// eslint-disable-next-line import/first
import { CompletionError } from '../../../src/fileSearch/orchestrationCompletion';

function freshConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'model-a',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 10_000_000, maxTokensPerFile: 5_000_000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 2, extractTimeoutMs: 10000, maxRetries: 3 },
    // The shipped installation default: it must not reach a pre-W2 (NULL) store or a recorded setting.
    chunking: { strategy: 'structure', maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true },
    contextual: { model: 'fake-context-model', maxDocumentTokens: 32000, concurrency: 2, requestTimeoutMs: 5000, fileDeadlineMs: 60000 },
    parentSections: { maxTokens: 1500, scope: 'tool' },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

/** One fixed vector per model, as the re-embed suites do; and every text the embedder saw. */
const MODEL_VECTOR: Record<string, number[]> = { 'model-a': [1, 0, 0], 'model-b': [0, 1, 0] };
let embedded: Array<{ model: string; text: string }> = [];
function fakeEmbed(texts: string[], _kind: string, target: { model: string }) {
  for (const text of texts) embedded.push({ model: target.model, text });
  return Promise.resolve({
    vectors: texts.map(() => MODEL_VECTOR[target.model]),
    usage: { promptTokens: texts.length * 3, totalTokens: texts.length * 3 },
  });
}

/** A fake context model: "Context of <the chunk's first word>." with fixed usage; a chunk that
 *  contains FAILME fails (the call billed nothing). */
const CALL_USAGE = { input: 120, cacheWrite: 20, cachedRead: 400, output: 9 };
function fakeComplete(call: { messages: Array<{ text: string }> }) {
  const chunk = /<chunk>\n([\s\S]*)\n<\/chunk>/.exec(call.messages[1].text)![1];
  if (chunk.includes('FAILME')) return Promise.reject(new CompletionError('request_failed', 'HTTP 500', 500));
  const first = chunk.trim().split(/\s+/)[0].replace(/[^\w]/g, '');
  return Promise.resolve({ text: `Context of ${first}.`, usage: { ...CALL_USAGE }, elapsedMs: 5 });
}

const para = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${topic} sentence ${i} explains one more detail about the ${topic.toLowerCase()} step.`).join(' ');

const GUIDE = [
  '# Gateway Guide',
  '',
  para('Overview', 12),
  '',
  '## Install',
  '',
  para('Install', 10),
  '',
  para('Docker', 10),
  '',
  '## Ports',
  '',
  '| Port | Service |',
  '| --- | --- |',
  ...Array.from({ length: 60 }, (_, i) => `| ${8000 + i} | service-${i} handles requests |`),
  '',
  '## Troubleshooting',
  '',
  `FAILME ${para('Troubleshooting', 12)}`,
].join('\n');

const STRUCTURE = { type: 'structure', max_tokens: 200, overlap_tokens: 50, contextual: false };

d('structured and contextual ingestion (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = freshConfig();
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
  });

  afterAll(async () => {
    await closeStructureChunkThread();
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  let emitted: any[];
  beforeEach(async () => {
    mockConfig = freshConfig();
    embedded = [];
    embedMock.mockReset();
    embedMock.mockImplementation(fakeEmbed);
    completeMock.mockReset();
    completeMock.mockImplementation(fakeComplete);
    emitted = [];
    jest.spyOn(usageEmitter, 'emit').mockImplementation(async (event: any) => { emitted.push(event); });
    for (const table of ['fs_reembed_items', 'fs_jobs', 'vector_store_chunks', 'vector_store_files', 'vector_store_batches',
      'vector_stores', 'fs_files', 'file_blobs']) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`DELETE FROM ${table}`);
    }
  });

  /** A store with `chunking` (null = a pre-W2 store) and one file attached through a batch with a credential. */
  async function seed(chunking: unknown, content: string, filename = 'guide.md', fileStrategy: Record<string, unknown> | null = null) {
    const store = await repo.createStore({ ownerEmail: OWNER });
    await pool.query('UPDATE vector_stores SET chunking = $2 WHERE id = $1', [store.id, chunking === null ? null : JSON.stringify(chunking)]);
    const bytes = Buffer.from(content, 'utf8');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/markdown');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, $2, $3, 'assistants', $4, $5, now())`, [fileId, OWNER, filename, sha, bytes.length]);
    const batch = await createBatch(store.id, [fileId], null, fileStrategy, { credentialId: 'key-1', authType: 'api_key' });
    return { storeId: store.id, fileId, batchId: batch.id };
  }

  async function rows(storeId: string, generation = 0) {
    const { rows: r } = await pool.query(
      `SELECT ord, text, tokens, section, section_offset, heading_path, context,
              embedding::text AS embedding,
              (context_tsv IS NOT DISTINCT FROM to_tsvector('simple', context)) AS tsv_matches,
              context_tsv IS NULL AS tsv_null
         FROM vector_store_chunks WHERE store_id = $1 AND generation = $2 ORDER BY ord`, [storeId, generation]);
    return r;
  }
  const status = async (storeId: string, fileId: string) =>
    (await pool.query('SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [storeId, fileId])).rows[0].status;
  const job = async (batchId: string) => (await pool.query(
    `SELECT embedding_tokens, context_input_tokens, context_cached_tokens, context_output_tokens, context_failed_chunks
       FROM fs_jobs WHERE batch_id = $1`, [batchId])).rows[0];

  // -- static -------------------------------------------------------------------------------

  it('static: every pinned corpus file ingests exactly its pinned chunks — through a pre-W2 store (NULL, 800/400) and a file static strategy (200/50) — without structure or context', async () => {
    expect(new Set(STATIC_CHUNK_PINS.map((p) => p[0])).size).toBe(6); // every corpus Markdown file, at 800/400 and 200/50
    for (const [file, size, overlap, count, sha] of STATIC_CHUNK_PINS) {
      const content = readFileSync(join(CORPUS, file), 'utf8');
      const fileStrategy = size === 800 ? null : { type: 'static', static: { max_chunk_size_tokens: size, chunk_overlap_tokens: overlap } };
      // eslint-disable-next-line no-await-in-loop
      const { storeId, fileId } = await seed(null, content, file, fileStrategy);
      embedded = [];
      // eslint-disable-next-line no-await-in-loop
      await processOne(storeId, fileId);
      // eslint-disable-next-line no-await-in-loop
      expect(await status(storeId, fileId)).toBe('completed');
      // eslint-disable-next-line no-await-in-loop
      const stored = await rows(storeId);
      const chunks = stored.map((r) => ({ ord: r.ord, text: r.text, tokens: r.tokens }));
      expect(chunks).toHaveLength(count);
      expect(createHash('sha256').update(JSON.stringify(chunks)).digest('hex')).toBe(sha);
      for (const r of stored) {
        expect([r.section, r.section_offset, r.heading_path, r.context]).toEqual([null, null, null, null]);
        expect(r.tsv_null).toBe(true);
      }
      // Embedded with the chunk text alone, as before.
      expect(embedded.map((e) => e.text)).toEqual(chunks.map((c) => c.text));
    }
    expect(completeMock).not.toHaveBeenCalled();
  }, 60_000);

  // -- structure ----------------------------------------------------------------------------

  it('structure: exact substrings with section, offset and heading path; the heading path is the context, indexed and embedded', async () => {
    const { storeId, fileId } = await seed(STRUCTURE, GUIDE);
    await processOne(storeId, fileId);
    expect(await status(storeId, fileId)).toBe('completed');
    const stored = await rows(storeId);
    const expected = chunkStructured(GUIDE, { maxTokens: 200, overlapTokens: 50, format: 'markdown' });
    expect(stored.map((r) => [r.text, r.section, r.section_offset, r.heading_path, r.tokens]))
      .toEqual(expected.map((c) => [c.text, c.section, c.sectionOffset, c.headingPath, c.tokens]));
    expect(new Set(stored.map((r) => r.section)).size).toBeGreaterThan(2);
    for (const [i, r] of stored.entries()) {
      const tableHeader = expected[i].tableHeader;
      const want = [r.heading_path, tableHeader].filter(Boolean).join('\n') || null;
      expect(r.context).toBe(want);
      expect(r.tsv_matches).toBe(true);
    }
    // a continuation piece of the table carries its header in the context
    expect(stored.some((r) => r.context?.includes('| Port | Service |') && !r.text.includes('| Port | Service |'))).toBe(true);
    // embedded with context + text
    expect(embedded.map((e) => e.text)).toEqual(stored.map((r) => (r.context ? `${r.context}\n\n${r.text}` : r.text)));
    // found by its heading through the full-text arm, though the chunk text does not contain it
    const docker = stored.find((r) => r.heading_path === 'Gateway Guide > Install' && !r.text.includes('## Install'))!;
    expect(docker).toBeDefined();
    const { rows: hit } = await pool.query(
      `SELECT ord FROM vector_store_chunks WHERE store_id = $1 AND (tsv @@ to_tsquery('simple', 'guide') OR context_tsv @@ to_tsquery('simple', 'guide'))`,
      [storeId]);
    expect(hit.map((h) => h.ord)).toContain(docker.ord);
    expect(completeMock).not.toHaveBeenCalled();
  }, 60_000);

  // -- contextual (review focus 2) ----------------------------------------------------------

  it('contextual: the LLM sentence after the heading path; failed chunks keep the heading path; counters and usage count what was spent', async () => {
    const { storeId, fileId, batchId } = await seed({ ...STRUCTURE, contextual: true }, GUIDE);
    await processOne(storeId, fileId);
    expect(await status(storeId, fileId)).toBe('completed');
    const stored = await rows(storeId);
    const failed = stored.filter((r) => r.text.includes('FAILME'));
    const ok = stored.filter((r) => !r.text.includes('FAILME'));
    expect(failed.length).toBeGreaterThan(0);
    for (const r of ok) {
      const first = r.text.trim().split(/\s+/)[0].replace(/[^\w]/g, '');
      expect(r.context!.split('\n').slice(0, 2)).toEqual([r.heading_path, `Context of ${first}.`].filter(Boolean));
      expect(r.tsv_matches).toBe(true);
    }
    for (const r of failed) expect(r.context).toBe(r.heading_path);
    // one call per chunk; the model got each chunk's heading path and its document offset
    expect(completeMock).toHaveBeenCalledTimes(stored.length);
    const calls = completeMock.mock.calls.map((c: any[]) => c[0]);
    expect(calls.every((c: any) => c.model === 'fake-context-model')).toBe(true);
    expect(calls.some((c: any) => c.messages[1].text.startsWith('Section: Gateway Guide > Ports'))).toBe(true);
    // job counters: only successful calls spent tokens
    expect(await job(batchId)).toEqual({
      embedding_tokens: String(stored.length * 3),
      context_input_tokens: String(ok.length * CALL_USAGE.input),
      context_cached_tokens: String(ok.length * CALL_USAGE.cachedRead),
      context_output_tokens: String(ok.length * CALL_USAGE.output),
      context_failed_chunks: String(failed.length),
    });
    // one file_search/context event per successful call, billed to the file's caller
    const context = emitted.filter((e) => e.endpoint === 'file_search/context');
    expect(context).toHaveLength(ok.length);
    expect(context.every((e) => e.requestId.startsWith('fs-context-') && e.model === 'fake-context-model')).toBe(true);
    expect(new Set(context.map((e) => e.requestId)).size).toBe(ok.length);
    // embedded with context + text
    expect(embedded.map((e) => e.text)).toEqual(stored.map((r) => `${r.context}\n\n${r.text}`));
  }, 60_000);

  it('contextual: a context model that is not served leaves every chunk with its heading path; the file still completes', async () => {
    completeMock.mockImplementation(() => Promise.reject(new CompletionError('no_deployment', 'no deployment')));
    const { storeId, fileId, batchId } = await seed({ ...STRUCTURE, contextual: true }, GUIDE);
    await processOne(storeId, fileId);
    expect(await status(storeId, fileId)).toBe('completed');
    const stored = await rows(storeId);
    // heading path (and, on a table continuation, its header) only: no LLM sentence anywhere
    for (const r of stored) {
      expect(r.context === r.heading_path || r.context.startsWith(`${r.heading_path}\n| Port | Service |`)).toBe(true);
      expect(r.context).not.toContain('Context of');
    }
    expect(completeMock).toHaveBeenCalledTimes(1); // stops at the first no_deployment
    expect(await job(batchId)).toMatchObject({
      context_input_tokens: '0', context_cached_tokens: '0', context_output_tokens: '0', context_failed_chunks: String(stored.length),
    });
    expect(emitted.filter((e) => e.endpoint === 'file_search/context')).toHaveLength(0);
  }, 60_000);

  it('contextual: timeouts and refusals on every chunk do not fail the file', async () => {
    completeMock.mockImplementation(() => Promise.reject(new CompletionError('timeout', 'timed out')));
    const { storeId, fileId } = await seed({ ...STRUCTURE, contextual: true }, GUIDE);
    await processOne(storeId, fileId);
    expect(await status(storeId, fileId)).toBe('completed');
    expect((await rows(storeId)).length).toBeGreaterThan(5);
    // gives up after three failures before any success
    expect(completeMock).toHaveBeenCalledTimes(3);
  }, 60_000);

  // -- whitespace-only chunks ---------------------------------------------------------------

  it('chunks of only whitespace are stored with no vector and no context, never embedded, never recalled', async () => {
    const blank = ' \t'.repeat(3000);
    const doc = `# Notes\n\n${para('Before', 8)}\n\n${blank}\n\n${para('After', 8)}`;
    const { storeId, fileId } = await seed({ ...STRUCTURE, max_tokens: 100, overlap_tokens: 0, contextual: true }, doc);
    await processOne(storeId, fileId);
    expect(await status(storeId, fileId)).toBe('completed');
    const stored = await rows(storeId);
    const blanks = stored.filter((r) => !/\S/.test(r.text));
    expect(blanks.length).toBeGreaterThan(0);
    for (const r of blanks) {
      expect(r.embedding).toBeNull();
      expect(r.context).toBeNull();
      expect(r.tsv_null).toBe(true);
    }
    expect(stored.filter((r) => /\S/.test(r.text)).every((r) => r.embedding !== null)).toBe(true);
    expect(embedded.map((e) => e.text)).toEqual(stored.filter((r) => /\S/.test(r.text))
      .map((r) => (r.context ? `${r.context}\n\n${r.text}` : r.text)));
    // the context model never saw them either
    expect(completeMock).toHaveBeenCalledTimes(stored.length - blanks.length);
    // the section rebuilds exactly from all rows, blanks included
    const rebuilt = stored.reduce((acc, r) => acc + r.text.slice(acc.length - r.section_offset), '');
    expect(doc).toContain(rebuilt);
    expect(rebuilt).toContain(blank);
    // recall: every candidate, both arms, never a blank row
    const candidates = await repo.recallCandidates({
      storeIds: [storeId], ownerEmail: OWNER, queryText: 'before after notes', queryEmbedding: [1, 0, 0], limit: 1000,
    });
    expect(candidates.length).toBe(stored.length - blanks.length);
    expect(candidates.some((c) => !/\S/.test(c.text))).toBe(false);
  }, 60_000);

  // -- re-embed -----------------------------------------------------------------------------

  async function drain(): Promise<void> {
    for (let n = 0; n < 100; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const item = await claimNextReembedItem();
      if (!item) return;
      // eslint-disable-next-line no-await-in-loop
      await processReembedItem(item);
    }
    throw new Error('drain did not terminate');
  }
  const COLUMNS = (r: any) => [r.ord, r.text, r.tokens, r.section, r.section_offset, r.heading_path, r.context, r.tsv_matches];

  it('a re-embed copies text, structure and context into the next generation and embeds context + text, without a context call', async () => {
    const doc = `${GUIDE}\n\n# Notes\n\n${para('Before', 8)}\n\n${' \t'.repeat(3000)}\n\n${para('After', 8)}`;
    const { storeId, fileId } = await seed({ ...STRUCTURE, contextual: true }, doc);
    await processOne(storeId, fileId);
    const before = await rows(storeId, 0);
    expect(before.some((r) => r.embedding === null)).toBe(true);
    completeMock.mockClear();
    embedded = [];

    // The estimate counts what the re-embed sends: text + context of every chunk with a vector.
    const estimate = await estimateStore(OWNER, storeId);
    const expected = before.filter((r) => r.embedding !== null)
      .reduce((n, r) => n + r.tokens + (r.context ? Math.ceil(r.context.length / 4) + 1 : 0), 0);
    expect(estimate!.estimated_tokens).toBe(expected);
    expect(estimate!.estimated_tokens).toBeLessThan(
      before.reduce((n, r) => n + r.tokens, 0) + before.reduce((n, r) => n + (r.context ? Math.ceil(r.context.length / 4) + 1 : 0), 0));

    mockConfig.embeddingModel = 'model-b';
    const started = await startReembed(OWNER, storeId, { email: OWNER, credentialId: 'key-1', authType: 'api_key' });
    expect(started.ok).toBe(true);
    await drain();
    const { rows: [store] } = await pool.query('SELECT active_generation, embedding_model FROM vector_stores WHERE id = $1', [storeId]);
    expect(store).toEqual({ active_generation: 1, embedding_model: 'model-b' });
    const after = await rows(storeId, 1);
    expect(after.map(COLUMNS)).toEqual(before.map(COLUMNS));
    expect(after.filter((r) => r.embedding === null).map((r) => r.ord)).toEqual(before.filter((r) => r.embedding === null).map((r) => r.ord));
    expect(after.filter((r) => r.embedding !== null).every((r) => r.embedding === '[0,1,0]')).toBe(true);
    expect(completeMock).not.toHaveBeenCalled();
    const nonBlank = before.filter((r) => /\S/.test(r.text));
    expect(embedded.map((e) => e.text)).toEqual(nonBlank.map((r) => (r.context ? `${r.context}\n\n${r.text}` : r.text)));
    expect(embedded.every((e) => e.model === 'model-b')).toBe(true);
  }, 60_000);

  it('a file ingested while its store re-embeds gets the same rows in both generations, each with its model\'s vectors', async () => {
    // A store with one file, re-embedding: its job is open while a second file arrives.
    const first = await seed(STRUCTURE, para('Seed', 30));
    await processOne(first.storeId, first.fileId);
    mockConfig.embeddingModel = 'model-b';
    expect((await startReembed(OWNER, first.storeId, { email: OWNER, credentialId: 'key-1', authType: 'api_key' })).ok).toBe(true);

    const bytes = Buffer.from(GUIDE, 'utf8');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/markdown');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, $2, 'second.md', 'assistants', $3, $4, now())`, [fileId, OWNER, sha, bytes.length]);
    await repo.attachFile(first.storeId, fileId, null, null);
    await processOne(first.storeId, fileId);

    const read = async (generation: number) => (await pool.query(
      `SELECT ord, text, section, section_offset, heading_path, context, embedding::text AS embedding,
              (context_tsv IS NOT DISTINCT FROM to_tsvector('simple', context)) AS tsv_matches
         FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2 AND generation = $3 ORDER BY ord`,
      [first.storeId, fileId, generation])).rows;
    const g0 = await read(0);
    const g1 = await read(1);
    expect(g0.length).toBeGreaterThan(3);
    const strip = (r: any) => ({ ...r, embedding: undefined });
    expect(g1.map(strip)).toEqual(g0.map(strip));
    expect(g0.every((r) => r.embedding === '[1,0,0]')).toBe(true);
    expect(g1.every((r) => r.embedding === '[0,1,0]')).toBe(true);
    expect(g0.some((r) => r.section !== null && r.context !== null)).toBe(true);
  }, 60_000);

  it('an invalid store setting fails the file permanently, without a retry', async () => {
    const { storeId, fileId } = await seed({ type: 'structure', max_tokens: 5, overlap_tokens: 0 }, GUIDE);
    await processOne(storeId, fileId);
    const { rows: [row] } = await pool.query(
      'SELECT status, last_error FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);
    expect(row.status).toBe('failed');
    expect(row.last_error.name).toBe('ChunkingStrategyError');
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('the static chunker output pinned here is the chunker\'s own (sanity)', () => {
    const content = readFileSync(join(CORPUS, 'developer-chapter-16-file-search-tool.md'), 'utf8');
    expect(chunkText(content, { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } })).toHaveLength(38);
  });
});
