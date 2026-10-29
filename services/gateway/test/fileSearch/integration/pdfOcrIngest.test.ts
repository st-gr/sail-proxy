// W3 Task 2: OCR in ingestion and re-chunking, against a real Postgres with a fake embedder and a
// fake OCR engine (the runners are mocked: no poppler or tesseract needed; the real tools are
// covered by the FILE_SEARCH_TEST_BINARIES suite integration/pdfOcr.test.ts):
// - a scanned PDF's pages are read by OCR and their text is chunked and stored; the batch's job
//   counts the pages (fs_jobs.ocr_pages / ocr_skipped_pages);
// - a file ingested while its store re-chunks is extracted twice (one chunk set per setting) but
//   OCR runs once per page, and the pages are counted once;
// - the re-chunk itself OCRs the file again (a new processing) and counts on its own job;
// - OCR off: the pages stay empty, the file completes, the pages are counted skipped;
// - a PDF with text on every page never asks for OCR.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import { closeStructureChunkThread } from '../../../src/fileSearch/structureChunkThread';
import usageEmitter from '../../../src/services/usageEventEmitter';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'ocr-owner@example.test';
const ACTOR = { email: OWNER, credentialId: 'key-1', authType: 'api_key' };

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
jest.mock('../../../src/fileSearch/reranker', () => ({ __esModule: true, rerank: async () => null }));

// The fake tools. A "PDF" here is `SCAN:<pages>` (no text layer) or `TEXT:<pages>`.
const TEXT_PAGE = 'This page carries a real text layer with plenty of words on it.\n';
const calls = { pdftotext: 0, pdftoppm: 0, tesseract: 0 };
jest.mock('../../../src/fileSearch/extractors/runners', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/extractors/runners'),
  runExtractor: async (bin: string, args: string[], input: Buffer) => {
    if (bin === 'pdftotext') {
      calls.pdftotext += 1;
      const [kind, n] = input.toString().split(':');
      return Array.from({ length: Number(n) }, () => (kind === 'TEXT' ? TEXT_PAGE : '')).map((p) => `${p}\f`).join('');
    }
    if (bin === 'pdfinfo') return `Page ${args[1]} size: 595.2 x 841.92 pts (A4)\n`;
    if (bin === 'tesseract') {
      calls.tesseract += 1;
      return `Scanned page ${input.toString().slice(4)} reads alpha beta gamma delta.\n\f`;
    }
    throw new Error(`unexpected tool ${bin}`);
  },
  runExtractorBuffer: async (bin: string, args: string[]) => {
    if (bin !== 'pdftoppm') throw new Error(`unexpected tool ${bin}`);
    calls.pdftoppm += 1;
    return Buffer.from(`png-${args[1]}`);
  },
}));

let ocrEnabled = true;
const statusCalls = { n: 0 };
jest.mock('../../../src/fileSearch/extractors/ocrAvailability', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/extractors/ocrAvailability'),
  getOcrStatus: async () => {
    statusCalls.n += 1;
    return ocrEnabled
      ? { enabled: true, switchedOff: false, reason: 'tesseract with eng', languages: ['eng'], missing: [] }
      : { enabled: false, switchedOff: true, reason: 'switched off (FILE_SEARCH_OCR=off)', languages: [], missing: [] };
  },
}));

// eslint-disable-next-line import/first
import { processOne } from '../../../src/fileSearch/ingestWorker';
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
    ingestion: { concurrency: 2, extractTimeoutMs: 10000, maxRetries: 3 },
    contextual: { model: 'unused', maxDocumentTokens: 32000, concurrency: 2, requestTimeoutMs: 5000, fileDeadlineMs: 60000,
      maxInputTokensPerFile: 20_000_000 },
    parentSections: { maxTokens: 1500, scope: 'tool' },
    chunking: { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false },
    parsing: { ocr: { languages: ['eng'] } },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

async function fakeEmbed(texts: string[], kind: string, _target: unknown, opts?: { onUsage?: (u: any) => void }) {
  opts?.onUsage?.({ promptTokens: texts.length, totalTokens: texts.length, elapsedMs: 1 });
  return { vectors: texts.map(() => [1, 0, 0]), usage: { promptTokens: texts.length, totalTokens: kind === 'query' ? 1 : texts.length } };
}

const STRUCTURE = { type: 'structure' as const, max_tokens: 200, overlap_tokens: 0, contextual: false };

d('OCR in ingestion and re-chunking (requires FILE_SEARCH_TEST_DSN)', () => {
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
    ocrEnabled = true;
    statusCalls.n = 0;
    Object.assign(calls, { pdftotext: 0, pdftoppm: 0, tesseract: 0 });
    embedMock.mockReset();
    embedMock.mockImplementation(fakeEmbed);
    jest.spyOn(usageEmitter, 'emit').mockImplementation(async () => {});
    for (const table of ['fs_reembed_items', 'fs_jobs', 'vector_store_chunks', 'vector_store_files', 'vector_store_batches',
      'vector_stores', 'fs_files', 'file_blobs']) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`DELETE FROM ${table}`);
    }
  });

  async function newStore(): Promise<string> {
    return (await repo.createStore({ ownerEmail: OWNER })).id;
  }
  async function attach(storeId: string, content: string): Promise<{ fileId: string; batchId: string }> {
    const bytes = Buffer.from(content, 'utf8');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'application/pdf');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, $2, 'scan.pdf', 'assistants', $3, $4, now())`, [fileId, OWNER, sha, bytes.length]);
    const batch = await createBatch(storeId, [fileId], null, null, { credentialId: 'key-1', authType: 'api_key' });
    return { fileId, batchId: batch.id };
  }
  const texts = async (storeId: string, fileId: string, generation = 0) => (await pool.query(
    'SELECT text FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2 AND generation = $3 ORDER BY ord',
    [storeId, fileId, generation])).rows.map((r) => r.text).join(' ');
  const counters = async (where: string, value: string) => (await pool.query(
    `SELECT ocr_pages, ocr_skipped_pages FROM fs_jobs WHERE ${where} = $1`, [value])).rows[0];
  const status = async (storeId: string, fileId: string) => (await pool.query(
    'SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2', [storeId, fileId])).rows[0].status;
  async function drain(): Promise<void> {
    for (let n = 0; n < 50; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const item = await claimNextReembedItem();
      if (!item) return;
      // eslint-disable-next-line no-await-in-loop
      await processReembedItem(item);
    }
    throw new Error('drain did not terminate');
  }

  it('a scanned PDF: every page read by OCR, its text stored, the pages counted on the batch\'s job', async () => {
    const storeId = await newStore();
    const { fileId, batchId } = await attach(storeId, 'SCAN:3');
    await processOne(storeId, fileId);
    expect(await status(storeId, fileId)).toBe('completed');
    const stored = await texts(storeId, fileId);
    for (const page of [1, 2, 3]) expect(stored).toContain(`Scanned page ${page} reads alpha beta gamma delta.`);
    expect(calls).toEqual({ pdftotext: 1, pdftoppm: 3, tesseract: 3 });
    expect(await counters('batch_id', batchId)).toEqual({ ocr_pages: '3', ocr_skipped_pages: '0' });
  });

  it('a file ingested during a re-chunk is extracted for both settings but OCRed once, and counted once', async () => {
    const storeId = await newStore();
    const seed = await attach(storeId, 'TEXT:2');
    await processOne(storeId, seed.fileId);
    const started = await startRechunk(OWNER, storeId, STRUCTURE, ACTOR);
    if (!started.ok) throw new Error(`start refused: ${started.error}`);
    Object.assign(calls, { pdftotext: 0, pdftoppm: 0, tesseract: 0 });

    const { fileId, batchId } = await attach(storeId, 'SCAN:2');
    await processOne(storeId, fileId);
    expect(calls).toEqual({ pdftotext: 2, pdftoppm: 2, tesseract: 2 });
    for (const generation of [0, 1]) {
      // eslint-disable-next-line no-await-in-loop
      const stored = await texts(storeId, fileId, generation);
      expect(stored).toContain('Scanned page 1 reads');
      expect(stored).toContain('Scanned page 2 reads');
    }
    expect(await counters('batch_id', batchId)).toEqual({ ocr_pages: '2', ocr_skipped_pages: '0' });
    expect(await counters('id', started.job.id)).toEqual({ ocr_pages: '0', ocr_skipped_pages: '0' });
  });

  it('a re-chunk reads the scanned pages again and counts them on its own job', async () => {
    const storeId = await newStore();
    const { fileId } = await attach(storeId, 'SCAN:4');
    await processOne(storeId, fileId);
    const started = await startRechunk(OWNER, storeId, STRUCTURE, ACTOR);
    if (!started.ok) throw new Error(`start refused: ${started.error}`);
    Object.assign(calls, { pdftotext: 0, pdftoppm: 0, tesseract: 0 });
    await drain();
    expect(calls).toEqual({ pdftotext: 1, pdftoppm: 4, tesseract: 4 });
    expect(await counters('id', started.job.id)).toEqual({ ocr_pages: '4', ocr_skipped_pages: '0' });
    const { rows: [store] } = await pool.query('SELECT active_generation FROM vector_stores WHERE id = $1', [storeId]);
    expect(await texts(storeId, fileId, store.active_generation)).toContain('Scanned page 4 reads');
  });

  it('OCR off: the pages stay empty, the file completes without chunks, the pages are counted skipped', async () => {
    ocrEnabled = false;
    const storeId = await newStore();
    const { fileId, batchId } = await attach(storeId, 'SCAN:3');
    await processOne(storeId, fileId);
    expect(await status(storeId, fileId)).toBe('completed');
    expect(await texts(storeId, fileId)).toBe('');
    expect(calls).toEqual({ pdftotext: 1, pdftoppm: 0, tesseract: 0 });
    expect(await counters('batch_id', batchId)).toEqual({ ocr_pages: '0', ocr_skipped_pages: '3' });
  });

  it('a PDF with text on every page never asks for OCR and counts nothing', async () => {
    const storeId = await newStore();
    const { fileId, batchId } = await attach(storeId, 'TEXT:3');
    await processOne(storeId, fileId);
    expect(await status(storeId, fileId)).toBe('completed');
    expect(statusCalls.n).toBe(0);
    expect(calls).toEqual({ pdftotext: 1, pdftoppm: 0, tesseract: 0 });
    expect(await counters('batch_id', batchId)).toEqual({ ocr_pages: '0', ocr_skipped_pages: '0' });
  });
});
