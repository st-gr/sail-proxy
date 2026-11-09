// Page numbers end to end, against a real Postgres and the real pdftotext, with a fake embedder
// (no SAP calls): a multi-page corpus PDF ingested by both strategies stores each chunk's pages
// (static chunk text byte-identical to before); a Markdown file stores none; the REST search, the
// tool's results and dump, and file_citation carry them as an extension; a parent section spans
// the pages of its window; a re-embed copies them; a re-chunk recomputes them.
// Requires FILE_SEARCH_TEST_DSN and FILE_SEARCH_TEST_BINARIES=1 (pdftotext), as CI sets both.
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import { chunkText } from '../../../src/fileSearch/chunker';
import { chunkStructuredWithSections } from '../../../src/fileSearch/structureChunker';
import { closeStructureChunkThread } from '../../../src/fileSearch/structureChunkThread';
import { extractText } from '../../../src/fileSearch/extractors/registry';
import { pageBreakOffsets, spanPages, staticChunkPages, structuredChunkPages } from '../../../src/fileSearch/pages';
import usageEmitter from '../../../src/services/usageEventEmitter';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN && process.env.FILE_SEARCH_TEST_BINARIES === '1' ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'pages-owner@example.test';
const ACTOR = { email: OWNER, credentialId: 'key-1', authType: 'api_key' };
const PDF_NAME = 'developer-chapter-2-architecture.pdf';
const PDF = readFileSync(join(__dirname, '../../../../../ci/file-search-eval/corpus/pdf', PDF_NAME));
const MD_NAME = 'user-chapter-9-roles.md';
const MD = readFileSync(join(__dirname, '../../../../../ci/file-search-eval/corpus/markdown', MD_NAME));

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
  default: { getFileSearchConfig: () => mockConfig },
}));

const MODEL_VECTOR: Record<string, number[]> = { 'model-a': [1, 0, 0], 'model-b': [0, 1, 0] };
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: (texts: string[], _kind: string, target: { model: string }) => Promise.resolve({
    vectors: texts.map(() => MODEL_VECTOR[target.model]),
    usage: { promptTokens: texts.length, totalTokens: texts.length },
  }),
}));
jest.mock('../../../src/fileSearch/reranker', () => ({ __esModule: true, rerank: async () => null }));

// eslint-disable-next-line import/first
import { processOne } from '../../../src/fileSearch/ingestWorker';
// eslint-disable-next-line import/first
import { startReembed } from '../../../src/fileSearch/reembed';
// eslint-disable-next-line import/first
import { startRechunk } from '../../../src/fileSearch/rechunk';
// eslint-disable-next-line import/first
import { claimNextReembedItem, processReembedItem } from '../../../src/fileSearch/reembedWorker';
// eslint-disable-next-line import/first
import { searchVectorStores } from '../../../src/fileSearch/search';
// eslint-disable-next-line import/first
import { searchVectorStore } from '../../../src/controllers/vectorStoresController';
// eslint-disable-next-line import/first
import { fileSearchDescriptor } from '../../../src/pluginSupport/fileSearch/descriptor';
// eslint-disable-next-line import/first
import { buildCitations } from '../../../src/pluginSupport/fileSearch/citations';

function freshConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'model-a',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 10_000_000, maxTokensPerFile: 5_000_000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 2, extractTimeoutMs: 20000, maxRetries: 3 },
    chunking: { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false },
    contextual: { model: 'unused', maxDocumentTokens: 32000, concurrency: 2, requestTimeoutMs: 5000, fileDeadlineMs: 60000 },
    parentSections: { maxTokens: 1500, scope: 'tool' },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

const STRUCTURE = { type: 'structure', max_tokens: 200, overlap_tokens: 50, contextual: false };
const STATIC_200 = { type: 'static', max_tokens: 200, overlap_tokens: 50, contextual: false };

d('page numbers end to end (requires FILE_SEARCH_TEST_DSN and FILE_SEARCH_TEST_BINARIES=1)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let text: string; // pdftotext's output for the corpus PDF

  beforeAll(async () => {
    mockConfig = freshConfig();
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
    text = await extractText(PDF_NAME, PDF, { timeoutMs: 20000 });
    expect(pageBreakOffsets(text)).toHaveLength(9);
  });

  afterAll(async () => {
    await closeStructureChunkThread();
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    mockConfig = freshConfig();
    jest.spyOn(usageEmitter, 'emit').mockImplementation(async () => undefined);
    for (const table of ['fs_reembed_items', 'fs_jobs', 'vector_store_chunks', 'vector_store_files', 'vector_store_batches',
      'vector_stores', 'fs_files', 'file_blobs']) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`DELETE FROM ${table}`);
    }
  });

  async function addFile(storeId: string, filename: string, bytes: Buffer): Promise<string> {
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'application/octet-stream');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, $2, $3, 'assistants', $4, $5, now())`, [fileId, OWNER, filename, sha, bytes.length]);
    await createBatch(storeId, [fileId], null, null, { credentialId: 'key-1', authType: 'api_key' });
    await processOne(storeId, fileId);
    const { rows: [f] } = await pool.query('SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);
    expect(f.status).toBe('completed');
    return fileId;
  }

  async function storeWith(chunking: unknown): Promise<{ storeId: string; pdfId: string; mdId: string }> {
    const store = await repo.createStore({ ownerEmail: OWNER });
    await pool.query('UPDATE vector_stores SET chunking = $2 WHERE id = $1', [store.id, JSON.stringify(chunking)]);
    const pdfId = await addFile(store.id, PDF_NAME, PDF);
    const mdId = await addFile(store.id, MD_NAME, MD);
    return { storeId: store.id, pdfId, mdId };
  }

  const rows = async (storeId: string, fileId: string, generation = 0) => (await pool.query(
    `SELECT ord, text, tokens, page_start, page_end FROM vector_store_chunks
      WHERE store_id = $1 AND file_id = $2 AND generation = $3 ORDER BY ord`, [storeId, fileId, generation])).rows;

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

  it('structure: each chunk stores the pages of its first and last character; Markdown stores none', async () => {
    const { storeId, pdfId, mdId } = await storeWith(STRUCTURE);
    const stored = await rows(storeId, pdfId);
    const { chunks, sections } = chunkStructuredWithSections(text, { maxTokens: 200, overlapTokens: 50, format: 'pdf' });
    const starts = chunks.map((c) => sections[c.section].start + c.sectionOffset);
    const expected = structuredChunkPages(text, chunks, starts);
    expect(stored.map((r) => r.text)).toEqual(chunks.map((c) => c.text));
    expect(stored.map((r) => (r.page_start === null ? null : { first: r.page_start, last: r.page_end }))).toEqual(expected);
    const pages = new Set(stored.flatMap((r) => [r.page_start, r.page_end]));
    expect(Math.min(...pages)).toBe(1);
    expect(Math.max(...pages)).toBe(9);
    // a section is a page here (no page is short enough to merge), so no chunk crosses a page break
    expect(stored.every((r) => r.page_end === r.page_start)).toBe(true);
    expect((await rows(storeId, mdId)).every((r) => r.page_start === null && r.page_end === null)).toBe(true);
  }, 60_000);

  it('static: chunk text byte-identical to chunkText of the extracted text, pages from the word windows', async () => {
    const { storeId, pdfId } = await storeWith(STATIC_200);
    const stored = await rows(storeId, pdfId);
    const strategy = { type: 'static' as const, static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 50 } };
    expect(stored.map((r) => ({ ord: r.ord, text: r.text, tokens: r.tokens }))).toEqual(chunkText(text, strategy));
    expect(stored.map((r) => ({ first: r.page_start, last: r.page_end }))).toEqual(staticChunkPages(text, strategy));
    expect(stored[stored.length - 1].page_end).toBe(9);
  }, 60_000);

  it('search: REST hits carry pages as an extension (Markdown hits none); the tool\'s parents span their window', async () => {
    const { storeId, pdfId } = await storeWith(STRUCTURE);
    const stored = await rows(storeId, pdfId);
    const query = 'gateway plugin architecture request';

    // REST
    const res: any = { status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
    await searchVectorStore({
      headers: {}, params: { id: storeId }, query: {}, body: { query, max_num_results: 20 }, apiKeyInfo: { email: OWNER },
    } as any, res, jest.fn() as any);
    expect(res.code).toBe(200);
    const data: any[] = res.body.data;
    expect(data.some((h) => h.filename === PDF_NAME)).toBe(true);
    for (const h of data) {
      if (h.filename === PDF_NAME) {
        const row = stored.find((r) => r.text === h.content[0].text)!;
        expect(h.pages).toEqual({ first: row.page_start, last: row.page_end });
        expect(Object.keys(h).sort()).toEqual(['attributes', 'content', 'file_id', 'filename', 'pages', 'score']);
      } else {
        expect(Object.keys(h).sort()).toEqual(['attributes', 'content', 'file_id', 'filename', 'score']);
      }
      expect(h.attributes).not.toHaveProperty('pages');
    }

    // Tool: parent sections, each spanning the pages of its window in the document
    const tool = await searchVectorStores({ storeIds: [storeId], query, ownerEmail: OWNER, maxNumResults: 10, surface: 'tool' });
    const breaks = pageBreakOffsets(text);
    const pdfHits = tool.data.filter((h) => h.filename === PDF_NAME);
    expect(pdfHits.length).toBeGreaterThan(0);
    for (const h of pdfHits) {
      const at = text.indexOf(h.content[0].text);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(h.pages).toEqual(spanPages(text, breaks, at, at + h.content[0].text.length));
    }

    // The tool's renderings and the citation
    const r: any = { call: { callId: 'call_1', rawArguments: '{}', args: { query } }, status: 'completed',
      payload: fileSearchDescriptor.rehydratePayload!({ hits: tool.data, queries: [query] }, {} as any) };
    const model = JSON.parse(fileSearchDescriptor.renderOutput(r).output).results;
    expect(model.filter((x: any) => x.filename === PDF_NAME).every((x: any) => x.pages.first >= 1)).toBe(true);
    const client = fileSearchDescriptor.renderCallItem(r, { includeResults: true } as any).results;
    expect(client.map((x: any) => x.pages)).toEqual(tool.data.map((h) => h.pages));
    const dump = fileSearchDescriptor.renderResultMessage(r).content[0].text;
    expect(dump).toMatch(new RegExp(`${PDF_NAME.replace(/\./g, '\\.')}, p\\. \\d+(–\\d+)? \\(score`));
    const sentence = pdfHits[0].content[0].text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0]
      .slice(0, 120).trim();
    const { annotations } = buildCitations(`As the guide says: ${sentence}`, [pdfHits[0]], undefined);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].pages).toEqual(pdfHits[0].pages);
  }, 60_000);

  it('a re-embed copies the pages; a re-chunk to static recomputes them', async () => {
    const { storeId, pdfId, mdId } = await storeWith(STRUCTURE);
    const before = await rows(storeId, pdfId, 0);
    mockConfig.embeddingModel = 'model-b';
    expect((await startReembed(OWNER, storeId, ACTOR)).ok).toBe(true);
    await drain();
    expect(await rows(storeId, pdfId, 1)).toEqual(before);
    expect((await rows(storeId, mdId, 1)).every((r) => r.page_start === null)).toBe(true);

    expect((await startRechunk(OWNER, storeId, STATIC_200 as any, ACTOR)).ok).toBe(true);
    await drain();
    const after = await rows(storeId, pdfId, 2);
    const strategy = { type: 'static' as const, static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 50 } };
    expect(after.map((r) => r.text)).toEqual(chunkText(text, strategy).map((c) => c.text));
    expect(after.map((r) => ({ first: r.page_start, last: r.page_end }))).toEqual(staticChunkPages(text, strategy));
  }, 60_000);
});
