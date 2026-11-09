// Re-extracting a store (W3 Task 7) against a real Postgres and the real pdftotext, with a fake
// embedder and a fake context model (no SAP calls). A store "from before W3" is made by ingesting
// with this build and then clearing what W3 added (the files' extraction version, the chunks' pages):
// - ingestion stamps every file with the current extraction version;
// - the estimate counts only the affected files (a PDF read before W3), the kept files, the failed
//   PowerPoint file a start queues again, and — with OCR — a PDF without text at the OCR page cap;
// - a start reads the PDF again (page numbers now) and copies the Markdown file with its vectors
//   (no embedding), keeps the store's setting, stamps the PDF, queues the PowerPoint file; the store
//   answers from its old generation until the switch; afterwards nothing is affected any more;
// - cancel keeps the old generation and the stamps; refusals; a contextual store re-runs contexts
//   for the PDF only.
// Requires FILE_SEARCH_TEST_DSN and FILE_SEARCH_TEST_BINARIES=1 (pdftotext), as CI sets both.
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import { closeStructureChunkThread } from '../../../src/fileSearch/structureChunkThread';
import { jobSummary } from '../../../src/fileSearch/jobs';
import { EXTRACTION_VERSION } from '../../../src/fileSearch/extractors/registry';
import { OCR_LIMITS } from '../../../src/fileSearch/extractors/pdfOcr';
import { pptx } from '../fixtures/ooxmlFixtures';
import usageEmitter from '../../../src/services/usageEventEmitter';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN && process.env.FILE_SEARCH_TEST_BINARIES === '1' ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'reextract-owner@example.test';
const ACTOR = { email: OWNER, credentialId: 'key-1', authType: 'api_key' };
const CORPUS = join(__dirname, '../../../../../ci/file-search-eval/corpus');
const PDF = readFileSync(join(CORPUS, 'pdf', 'developer-chapter-2-architecture.pdf'));
const MD = readFileSync(join(CORPUS, 'markdown', 'user-chapter-9-roles.md'));
const DECK = pptx([{ shapes: [{ title: 'Quarterly review' }, { text: ['Revenue grew in every region.'] }] }]);
const DECK_2 = pptx([{ shapes: [{ title: 'Roadmap' }, { text: ['Three launches are planned next year.'] }] }]);
const SCANNED = readFileSync(join(CORPUS, 'scanned', 'user-chapter-1-introduction.pdf'));

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
  default: { getFileSearchConfig: () => mockConfig, isPseudonymizationForcedForFileSearch: () => false },
}));

// OCR as this gateway sees it: false (off), true (on — tesseract runs where it is installed, and its
// pages fail where it is not: neither leaves OCR pending), or 'actual' (the real switch and probe).
let mockOcr: boolean | 'actual' = false;
jest.mock('../../../src/fileSearch/extractors/ocrAvailability', () => {
  const actual = jest.requireActual<any>('../../../src/fileSearch/extractors/ocrAvailability');
  return {
    ...actual,
    __esModule: true,
    isOcrEnabled: async () => (mockOcr === 'actual' ? actual.isOcrEnabled() : mockOcr),
    getOcrStatus: async () => {
      if (mockOcr === 'actual') return actual.getOcrStatus();
      return mockOcr
        ? { enabled: true, switchedOff: false, reason: 'on (test)', languages: ['eng'], missing: [] }
        : { enabled: false, switchedOff: true, reason: 'switched off (test)', languages: [], missing: [] };
    },
  };
});

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
import { cancelReembed } from '../../../src/fileSearch/reembed';
// eslint-disable-next-line import/first
import { estimateReextract, startReextract, OCR_TOKENS_PER_PAGE } from '../../../src/fileSearch/reextract';
// eslint-disable-next-line import/first
import { startRechunk } from '../../../src/fileSearch/rechunk';
// eslint-disable-next-line import/first
import { claimNextReembedItem, processReembedItem } from '../../../src/fileSearch/reembedWorker';

function freshConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'model-a',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 10_000_000, maxTokensPerFile: 5_000_000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 2, extractTimeoutMs: 20000, maxRetries: 3 },
    contextual: {
      model: 'fake-context-model', maxDocumentTokens: 32000, concurrency: 2, requestTimeoutMs: 5000, fileDeadlineMs: 60000,
      maxInputTokensPerFile: 20_000_000,
    },
    parentSections: { maxTokens: 1500, scope: 'tool' },
    parsing: { ocr: { languages: ['eng'] } },
    chunking: { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

let embedded: string[] = [];
let duringEmbed: (() => Promise<void>) | null = null;
async function fakeEmbed(texts: string[], kind: string, _target: unknown, opts?: { onUsage?: (u: any) => void }) {
  if (kind === 'query') { // the start's model check
    opts?.onUsage?.({ promptTokens: 2, totalTokens: 2, elapsedMs: 1 });
    return { vectors: texts.map(() => [1, 0, 0]), usage: { promptTokens: 2, totalTokens: 2 } };
  }
  const hook = duringEmbed;
  duringEmbed = null;
  if (hook) await hook();
  embedded.push(...texts);
  opts?.onUsage?.({ promptTokens: texts.length * 3, totalTokens: texts.length * 3, elapsedMs: 1 });
  // A vector of the text's length: copied rows keep theirs, re-embedded rows get a new one.
  return { vectors: texts.map((t) => [1, t.length % 7, 0]), usage: { promptTokens: texts.length * 3, totalTokens: texts.length * 3 } };
}
function fakeComplete() {
  return Promise.resolve({ text: 'Context sentence.', usage: { input: 10, cacheWrite: 0, cachedRead: 0, output: 3 }, elapsedMs: 1 });
}

const STRUCTURE_CONTEXTUAL = { type: 'structure' as const, max_tokens: 400, overlap_tokens: 0, contextual: true };

d('re-extracting a store (requires FILE_SEARCH_TEST_DSN and FILE_SEARCH_TEST_BINARIES=1)', () => {
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

  beforeEach(async () => {
    mockConfig = freshConfig();
    mockOcr = false;
    embedded = [];
    duringEmbed = null;
    embedMock.mockReset();
    embedMock.mockImplementation(fakeEmbed);
    completeMock.mockReset();
    completeMock.mockImplementation(fakeComplete);
    jest.spyOn(usageEmitter, 'emit').mockImplementation(async () => {});
    for (const table of ['fs_reembed_items', 'fs_jobs', 'vector_store_chunks', 'vector_store_files', 'vector_store_batches',
      'vector_stores', 'fs_files', 'file_blobs']) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`DELETE FROM ${table}`);
    }
  });

  async function attach(storeId: string, bytes: Buffer, filename: string): Promise<string> {
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'application/octet-stream');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, $2, $3, 'assistants', $4, $5, now())`, [fileId, OWNER, filename, sha, bytes.length]);
    await createBatch(storeId, [fileId], null, null, { credentialId: 'key-1', authType: 'api_key' });
    return fileId;
  }

  /** A store as W2 left it: a PDF and a Markdown file read without version or pages, and a PowerPoint
   *  file refused as an unsupported type. */
  async function storeFromBeforeW3(chunking: unknown = null) {
    const store = await repo.createStore({ ownerEmail: OWNER });
    const storeId = store.id;
    await pool.query('UPDATE vector_stores SET chunking = $2 WHERE id = $1', [storeId, chunking === null ? null : JSON.stringify(chunking)]);
    const pdf = await attach(storeId, PDF, 'architecture.pdf');
    await processOne(storeId, pdf);
    const md = await attach(storeId, MD, 'roles.md');
    await processOne(storeId, md);
    const deck = await attach(storeId, DECK, 'review.pptx');
    await pool.query(
      `UPDATE vector_store_files SET status = 'failed', attempts = 1,
              last_error = '{"name":"UnsupportedFileTypeError","message":"Unsupported file type: .pptx."}'::jsonb
        WHERE store_id = $1 AND file_id = $2`, [storeId, deck]);
    await pool.query('UPDATE fs_jobs SET finished_at = now() WHERE store_id = $1', [storeId]);
    await pool.query('UPDATE vector_store_files SET extraction_version = NULL WHERE store_id = $1', [storeId]);
    await pool.query('UPDATE vector_store_chunks SET page_start = NULL, page_end = NULL WHERE store_id = $1', [storeId]);
    return { storeId, pdf, md, deck };
  }

  async function drain(): Promise<void> {
    for (let n = 0; n < 200; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const item = await claimNextReembedItem();
      if (!item) return;
      // eslint-disable-next-line no-await-in-loop
      await processReembedItem(item);
    }
    throw new Error('drain did not terminate');
  }
  const rowsOf = async (storeId: string, fileId: string, generation: number) => (await pool.query(
    `SELECT ord, text, tokens, section, heading_path, context, page_start, page_end, embedding::text AS embedding
       FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2 AND generation = $3 ORDER BY ord`,
    [storeId, fileId, generation])).rows;
  const versions = async (storeId: string) => Object.fromEntries((await pool.query(
    'SELECT file_id, status, extraction_version FROM vector_store_files WHERE store_id = $1', [storeId])).rows
    .map((r) => [r.file_id, [r.status, r.extraction_version]]));
  const pendingOf = async (fileId: string) => (await pool.query(
    'SELECT ocr_pending FROM vector_store_files WHERE file_id = $1', [fileId])).rows[0]?.ocr_pending;
  const storeRow = async (storeId: string) => (await pool.query(
    'SELECT active_generation, chunking FROM vector_stores WHERE id = $1', [storeId])).rows[0];

  it('ingestion stamps every file it reads with the current extraction version', async () => {
    const store = await repo.createStore({ ownerEmail: OWNER });
    const md = await attach(store.id, MD, 'roles.md');
    await processOne(store.id, md);
    expect(await versions(store.id)).toEqual({ [md]: ['completed', EXTRACTION_VERSION] });
    expect(EXTRACTION_VERSION).toBe(1);
  }, 60_000);

  it('the estimate counts the PDF read before W3, the kept file and the PowerPoint file to queue again', async () => {
    const { storeId, pdf } = await storeFromBeforeW3();
    const pdfChunks = (await rowsOf(storeId, pdf, 0)).length;
    embedMock.mockClear();
    const estimate = await estimateReextract(OWNER, storeId);
    expect(embedMock).not.toHaveBeenCalled();
    expect(estimate).toMatchObject({
      store_id: storeId,
      setting: { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false },
      running_job_id: null,
      files: 1,
      kept_files: 1,
      ocr_available: false,
      files_without_text: 0,
      current_chunks: pdfChunks,
      context_model: null,
      estimated_context_input_tokens: 0,
      vision_model: null,
      vision_files: 0,
      retry_files: 1,
    });
    expect(estimate!.estimated_chunks).toBe(pdfChunks); // the same text, the same setting
    expect(estimate!.estimated_embedding_tokens).toBeGreaterThan(0);
    expect(await estimateReextract('someone@example.test', storeId)).toBeNull();
  }, 60_000);

  it('a start reads the PDF again and copies the Markdown file; the store keeps its setting; nothing is affected afterwards', async () => {
    const { storeId, pdf, md, deck } = await storeFromBeforeW3();
    const before = { pdf: await rowsOf(storeId, pdf, 0), md: await rowsOf(storeId, md, 0) };
    expect(before.pdf.every((r) => r.page_start === null)).toBe(true);
    embedded = [];
    // A context stop goes with the chunks: kept by the copied file, recorded anew for the file read again.
    await pool.query(`UPDATE vector_store_files SET context_stopped = 'deadline' WHERE store_id = $1 AND file_id = ANY($2::text[])`,
      [storeId, [pdf, md]]);

    const started = await startReextract(OWNER, storeId, ACTOR);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.retried_files).toBe(1);
    expect(started.job).toMatchObject({ kind: 'reembed_store', reextract: true, total: 2, state: 'queued' });
    // the PowerPoint file is queued again, like a Retry
    expect((await versions(storeId))[deck][0]).toBe('in_progress');
    // until the switch the store answers from the old generation
    expect(await storeRow(storeId)).toEqual({ active_generation: 0, chunking: null });

    await drain();
    expect(await storeRow(storeId)).toEqual({ active_generation: 1, chunking: null });
    const after = { pdf: await rowsOf(storeId, pdf, 1), md: await rowsOf(storeId, md, 1) };
    // the PDF is read again: the same text, now with its pages
    expect(after.pdf.map((r) => r.text)).toEqual(before.pdf.map((r) => r.text));
    expect(after.pdf.every((r) => r.page_start !== null && r.page_end !== null)).toBe(true);
    // the Markdown file is copied as it was, vectors included, and never embedded
    expect(after.md).toEqual(before.md);
    expect(embedded.some((t) => after.md.some((r) => t.includes(r.text)))).toBe(false);
    expect(embedded).toHaveLength(after.pdf.length);
    const v = await versions(storeId);
    expect(v[pdf]).toEqual(['completed', EXTRACTION_VERSION]);
    expect(v[md]).toEqual(['completed', null]); // kept: never read by this build, and nothing to gain
    const stops = Object.fromEntries((await pool.query(
      'SELECT file_id, context_stopped FROM vector_store_files WHERE store_id = $1', [storeId])).rows.map((r) => [r.file_id, r.context_stopped]));
    expect([stops[pdf], stops[md]]).toEqual([null, 'deadline']);
    expect(await jobSummary(started.job!.id, OWNER)).toMatchObject({ state: 'completed', done: 2, reextract: true });
    // usage_bytes is still the chunk text
    const { rows: usage } = await pool.query(
      `SELECT f.usage_bytes, (SELECT SUM(octet_length(c.text)) FROM vector_store_chunks c
                               WHERE c.store_id = f.store_id AND c.file_id = f.file_id)::int AS bytes
         FROM vector_store_files f WHERE f.store_id = $1 AND f.status = 'completed'`, [storeId]);
    expect(usage.every((u) => Number(u.usage_bytes) === u.bytes)).toBe(true);

    // the PowerPoint file ingests now
    await processOne(storeId, deck);
    expect((await versions(storeId))[deck]).toEqual(['completed', EXTRACTION_VERSION]);
    // nothing left to read again
    expect(await estimateReextract(OWNER, storeId)).toMatchObject({ files: 0, kept_files: 3, retry_files: 0 });
    expect(await startReextract(OWNER, storeId, ACTOR)).toEqual({ ok: false, error: 'nothing_to_reextract' });
  }, 120_000);

  it('a re-chunk stamps every file it reads', async () => {
    const { storeId, pdf, md } = await storeFromBeforeW3();
    const started = await startRechunk(OWNER, storeId, { type: 'structure', max_tokens: 400, overlap_tokens: 0, contextual: false }, ACTOR);
    expect(started.ok).toBe(true);
    await drain();
    const v = await versions(storeId);
    expect(v[pdf]).toEqual(['completed', EXTRACTION_VERSION]);
    expect(v[md]).toEqual(['completed', EXTRACTION_VERSION]);
  }, 120_000);

  it('cancel mid-run keeps the old generation, the setting and the stamps', async () => {
    const { storeId, pdf, md } = await storeFromBeforeW3();
    const before = { pdf: await rowsOf(storeId, pdf, 0), md: await rowsOf(storeId, md, 0) };
    const started = await startReextract(OWNER, storeId, ACTOR);
    if (!started.ok) throw new Error(started.error);
    let cancelled: any;
    duringEmbed = async () => { cancelled = await cancelReembed(OWNER, started.job!.id); };
    await drain();
    expect(cancelled.ok && cancelled.job.state).toBe('cancelled');
    expect(await storeRow(storeId)).toEqual({ active_generation: 0, chunking: null });
    expect({ pdf: await rowsOf(storeId, pdf, 0), md: await rowsOf(storeId, md, 0) }).toEqual(before);
    expect((await pool.query('SELECT DISTINCT generation FROM vector_store_chunks WHERE store_id = $1', [storeId])).rows)
      .toEqual([{ generation: 0 }]);
    expect((await versions(storeId))[pdf]).toEqual(['completed', null]);
    // and it can start again
    const again = await startReextract(OWNER, storeId, ACTOR);
    expect(again.ok && again.job?.reextract).toBe(true);
  }, 120_000);

  it('refuses another owner, a running job, an expired store; queues failed files alone without a job', async () => {
    const { storeId, deck } = await storeFromBeforeW3();
    expect(await startReextract('someone@example.test', storeId, ACTOR)).toEqual({ ok: false, error: 'not_found' });
    const running = await startRechunk(OWNER, storeId, { type: 'structure', max_tokens: 400, overlap_tokens: 0, contextual: false }, ACTOR);
    expect(running.ok).toBe(true);
    expect(await startReextract(OWNER, storeId, ACTOR)).toEqual({ ok: false, error: 'reembed_running' });
    expect(await estimateReextract(OWNER, storeId)).toMatchObject({ running_job_id: running.ok ? running.job.id : '' });
    await drain();

    // only the failed PowerPoint file left: queued, no job, no model call
    embedMock.mockClear();
    const queued = await startReextract(OWNER, storeId, ACTOR);
    expect(queued).toEqual({ ok: true, job: null, retried_files: 1, refused_files: [] });
    expect(embedMock).not.toHaveBeenCalled();
    expect((await versions(storeId))[deck][0]).toBe('in_progress');
    expect(await startReextract(OWNER, storeId, ACTOR)).toEqual({ ok: false, error: 'nothing_to_reextract' });

    const other = await storeFromBeforeW3();
    await pool.query(`UPDATE vector_stores SET status = 'expired' WHERE id = $1`, [other.storeId]);
    expect(await startReextract(OWNER, other.storeId, ACTOR)).toEqual({ ok: false, error: 'store_expired' });
  }, 120_000);

  it('a scanned PDF read where OCR was off is pending: not offered while OCR is off, read again once it is on', async () => {
    const store = await repo.createStore({ ownerEmail: OWNER });
    const scan = await attach(store.id, SCANNED, 'scan.pdf');
    const text = await attach(store.id, PDF, 'text.pdf');
    await processOne(store.id, scan);
    await processOne(store.id, text);
    expect(await versions(store.id)).toEqual({ [scan]: ['completed', EXTRACTION_VERSION], [text]: ['completed', EXTRACTION_VERSION] });
    expect([await pendingOf(scan), await pendingOf(text)]).toEqual([true, false]);
    expect(await estimateReextract(OWNER, store.id)).toMatchObject({ files: 0, kept_files: 2, ocr_available: false });
    expect(await startReextract(OWNER, store.id, ACTOR)).toEqual({ ok: false, error: 'nothing_to_reextract' });

    mockOcr = true;
    expect(await estimateReextract(OWNER, store.id)).toMatchObject({ files: 1, kept_files: 1, files_without_text: 1, ocr_available: true });
    const textRows = await rowsOf(store.id, text, 0);
    const started = await startReextract(OWNER, store.id, ACTOR);
    expect(started.ok && started.job).toMatchObject({ reextract: true, total: 2 });
    await drain();
    // the scan was read with OCR running (its pages read, or failed where tesseract is missing): no longer pending
    expect(await pendingOf(scan)).toBe(false);
    expect(await rowsOf(store.id, text, 1)).toEqual(textRows); // the text PDF was copied
    expect(await estimateReextract(OWNER, store.id)).toMatchObject({ files: 0 });
  }, 120_000);

  it('the npm standalone CLI (OCR switched off whatever the host has) never offers a pending scan', async () => {
    mockOcr = 'actual';
    const before = process.env.FILE_SEARCH_OCR;
    process.env.FILE_SEARCH_OCR = 'off';
    try {
      const store = await repo.createStore({ ownerEmail: OWNER });
      const scan = await attach(store.id, SCANNED, 'scan.pdf');
      await processOne(store.id, scan);
      expect(await pendingOf(scan)).toBe(true);
      expect(await estimateReextract(OWNER, store.id)).toMatchObject({ files: 0, kept_files: 1, ocr_available: false });
      expect(await startReextract(OWNER, store.id, ACTOR)).toEqual({ ok: false, error: 'nothing_to_reextract' });
    } finally {
      if (before === undefined) delete process.env.FILE_SEARCH_OCR;
      else process.env.FILE_SEARCH_OCR = before;
    }
  }, 60_000);

  it('a PowerPoint file ingested during a running re-extract lands in the new generation, stamped current', async () => {
    const { storeId } = await storeFromBeforeW3();
    const started = await startReextract(OWNER, storeId, ACTOR);
    if (!started.ok) throw new Error(started.error);
    const target = (await pool.query('SELECT target_generation FROM fs_jobs WHERE id = $1', [started.job!.id])).rows[0].target_generation;
    const deck = await attach(storeId, DECK_2, 'roadmap.pptx');
    await processOne(storeId, deck);
    const inNew = await rowsOf(storeId, deck, target);
    expect(inNew.length).toBeGreaterThan(0);
    expect(inNew.map((r) => r.page_start)).toContain(1);
    expect((await pool.query('SELECT status, extraction_version, ocr_pending FROM fs_reembed_items WHERE job_id = $1 AND file_id = $2',
      [started.job!.id, deck])).rows).toEqual([{ status: 'completed', extraction_version: EXTRACTION_VERSION, ocr_pending: false }]);
    await drain();
    expect(await storeRow(storeId)).toEqual({ active_generation: target, chunking: null });
    expect((await versions(storeId))[deck]).toEqual(['completed', EXTRACTION_VERSION]);
    expect(await rowsOf(storeId, deck, target)).toEqual(inNew);
  }, 120_000);

  it('a start whose queuing the file retry refuses says which files and why, instead of "nothing to read"', async () => {
    const { storeId, deck } = await storeFromBeforeW3();
    expect((await startReextract(OWNER, storeId, ACTOR)).ok).toBe(true); // the PDF, and the deck queued
    await drain();
    // the deck failed again, in a batch that was cancelled meanwhile: the retry refuses it
    await pool.query(
      `UPDATE vector_store_files SET status = 'failed', last_error = '{"name":"UnsupportedFileTypeError","message":"x"}'::jsonb
        WHERE file_id = $1`, [deck]);
    await pool.query(
      `UPDATE vector_store_batches SET cancel_requested = true
        WHERE id = (SELECT batch_id FROM vector_store_files WHERE file_id = $1)`, [deck]);
    expect(await estimateReextract(OWNER, storeId)).toMatchObject({ files: 0, retry_files: 1 });
    expect(await startReextract(OWNER, storeId, ACTOR)).toEqual({
      ok: true, job: null, retried_files: 0, refused_files: [{ file_id: deck, error: 'nothing_to_retry' }],
    });
  }, 120_000);

  it('a contextual store: contexts for the PDF only, estimated and written; a PDF without text counts at the OCR cap', async () => {
    const { storeId, pdf } = await storeFromBeforeW3(STRUCTURE_CONTEXTUAL);
    const estimate = await estimateReextract(OWNER, storeId);
    expect(estimate).toMatchObject({ files: 1, context_model: 'fake-context-model' });
    expect(estimate!.estimated_context_input_tokens).toBeGreaterThan(0);
    expect(estimate!.estimated_context_output_tokens).toBeGreaterThan(0);

    // A scanned PDF read before W3 (no chunk): counted only where OCR runs.
    const scanned = await attach(storeId, PDF, 'scan.pdf');
    await processOne(storeId, scanned);
    await pool.query('DELETE FROM vector_store_chunks WHERE file_id = $1', [scanned]);
    await pool.query('UPDATE vector_store_files SET extraction_version = NULL WHERE file_id = $1', [scanned]);
    const withoutOcr = await estimateReextract(OWNER, storeId);
    expect(withoutOcr).toMatchObject({ files: 2, files_without_text: 0 });
    mockOcr = true;
    const withOcr = await estimateReextract(OWNER, storeId);
    expect(withOcr).toMatchObject({ files: 2, files_without_text: 1, ocr_available: true });
    expect(withOcr!.estimated_embedding_tokens - withoutOcr!.estimated_embedding_tokens)
      .toBeGreaterThanOrEqual(OCR_LIMITS.maxPagesPerFile * OCR_TOKENS_PER_PAGE);
    await pool.query('DELETE FROM vector_store_files WHERE file_id = $1', [scanned]);

    completeMock.mockClear();
    const started = await startReextract(OWNER, storeId, ACTOR);
    expect(started.ok).toBe(true);
    await drain();
    const rows = await rowsOf(storeId, pdf, 1);
    // one call per PDF chunk, plus the start's context model check
    expect(completeMock).toHaveBeenCalledTimes(rows.length + 1);
    expect(rows.every((r) => r.context.includes('Context sentence.'))).toBe(true);
    expect(await storeRow(storeId)).toMatchObject({ chunking: STRUCTURE_CONTEXTUAL });
  }, 120_000);
});
