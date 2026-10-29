// Re-chunking a store (W2 Task 6) against a real Postgres, with a fake embedder and a fake
// context model (no SAP calls):
// - static → structure → structure + contextual: every file chunked again from its blob by the
//   target setting into the next generation; the switch sets the store's chunking with its
//   generation; counters and usage events count the re-chunk's work; contextual on → off makes
//   no context call;
// - cancel mid-run leaves the old setting and generation active, an item in flight commits
//   nothing; a worker that died mid-item is re-claimed after its lease (restart); a failed file
//   fails the job, the store unchanged, and Retry finishes it (review focus 3);
// - ingestion during the run writes the store's setting into the active generation and the
//   target setting into the new one — also when the job starts or switches mid-ingestion — and a
//   file deleted during the run never reappears;
// - the estimate reads no blob and calls no model, counts embedded chunks only, stays within a
//   factor of the real re-chunk and is fast on a large store;
// - with the test MinIO (FILE_SEARCH_TEST_S3_*): a re-chunk reads blobs stored on S3.
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob, setBlobS3CredentialsForTests } from '../../../src/fileSearch/blob/blobStore';
import { createS3Backend } from '../../../src/fileSearch/blob/s3Backend';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import { chunkText, estimateTokens } from '../../../src/fileSearch/chunker';
import { chunkStructured, countTokens } from '../../../src/fileSearch/structureChunker';
import * as chunkThread from '../../../src/fileSearch/structureChunkThread';
import { closeStructureChunkThread } from '../../../src/fileSearch/structureChunkThread';
import { __setVectorBytesPerFileForTests } from '../../../src/fileSearch/chunkPipeline';
import * as memoryBudget from '../../../src/fileSearch/memoryBudget';
import { __memoryBudgetForTests, FileSearchMemoryBusyError, reserveMemory } from '../../../src/fileSearch/memoryBudget';
import { FileSearchBusyError } from '../../../src/fileSearch/dbBusy';
import { LEASE_MINUTES, PROCESS_BUDGET_MS } from '../../../src/fileSearch/workQueue';
import { jobSummary } from '../../../src/fileSearch/jobs';
import usageEmitter from '../../../src/services/usageEventEmitter';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { s3TestConfigFromEnv } = require('../../../../../ci/scripts/file-search-test-s3.js');

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;
const S3 = s3TestConfigFromEnv(process.env);
const dS3 = DSN && S3 ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'rechunk-owner@example.test';
const ACTOR = { email: OWNER, credentialId: 'key-1', authType: 'api_key' };
const CORPUS = join(__dirname, '../../../../../ci/file-search-eval/corpus/markdown');

let mockConfig: any;
let mockForced = false;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
  default: { getFileSearchConfig: () => mockConfig, isPseudonymizationForcedForFileSearch: () => mockForced },
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
import { processOne, startIngestWorker, stopIngestWorker } from '../../../src/fileSearch/ingestWorker';
// eslint-disable-next-line import/first
import { cancelReembed, retryReembed, startReembed } from '../../../src/fileSearch/reembed';
// eslint-disable-next-line import/first
import { estimateRechunk, startRechunk } from '../../../src/fileSearch/rechunk';
// eslint-disable-next-line import/first
import { claimNextReembedItem, processReembedItem, settleIdleReembedJobs } from '../../../src/fileSearch/reembedWorker';
// eslint-disable-next-line import/first
import { CompletionError } from '../../../src/fileSearch/orchestrationCompletion';
// eslint-disable-next-line import/first
import { estimateContextTokens } from '../../../src/fileSearch/contextWriter';
// eslint-disable-next-line import/first
import { EmbeddingModelUnavailableError } from '../../../src/fileSearch/embedder';
// eslint-disable-next-line import/first
import { __commitChunkSetsForTests } from '../../../src/fileSearch/ingestWorker';
// eslint-disable-next-line import/first
import { chunkingKey } from '../../../src/fileSearch/chunkingSetting';

function freshConfig(): any {
  return {
    enabled: true,
    embeddingModel: 'model-a',
    embeddingDimensions: EMBED_DIM,
    rewriteQuery: false,
    hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50, rerank: { enabled: false, model: 'unused' } },
    limits: { maxFileBytes: 10_000_000, maxTokensPerFile: 5_000_000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 2, extractTimeoutMs: 10000, maxRetries: 3 },
    contextual: {
      model: 'fake-context-model', maxDocumentTokens: 32000, concurrency: 2, requestTimeoutMs: 5000, fileDeadlineMs: 60000,
      maxInputTokensPerFile: 20_000_000,
    },
    parentSections: { maxTokens: 1500, scope: 'tool' },
    chunking: { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

let embedded: Array<{ model: string; text: string }> = [];
/** Runs once, inside the next embed call (to start or switch a job mid-ingestion). */
let duringEmbed: (() => Promise<void>) | null = null;
async function fakeEmbed(texts: string[], kind: string, target: { model: string }, opts?: { onUsage?: (u: any) => void }) {
  if (kind === 'query') { // the start's model check
    opts?.onUsage?.({ promptTokens: 2, totalTokens: 2, elapsedMs: 1 });
    return { vectors: texts.map(() => [1, 0, 0]), usage: { promptTokens: 2, totalTokens: 2 } };
  }
  const hook = duringEmbed;
  duringEmbed = null;
  if (hook) await hook();
  for (const text of texts) embedded.push({ model: target.model, text });
  opts?.onUsage?.({ promptTokens: texts.length * 3, totalTokens: texts.length * 3, elapsedMs: 1 });
  return { vectors: texts.map(() => [1, 0, 0]), usage: { promptTokens: texts.length * 3, totalTokens: texts.length * 3 } };
}

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
  '# Gateway Guide', '', para('Overview', 12), '', '## Install', '', para('Install', 10), '', para('Docker', 10), '',
  '## Ports', '', '| Port | Service |', '| --- | --- |',
  ...Array.from({ length: 40 }, (_, i) => `| ${8000 + i} | service-${i} handles requests |`), '',
  '## Troubleshooting', '', `FAILME ${para('Troubleshooting', 12)}`,
].join('\n');
const NOTES = ['# Notes', '', para('Alpha', 20), '', '## Beta', '', para('Beta', 25)].join('\n');
const EXTRA = ['# Extra', '', para('Gamma', 15), '', '## Delta', '', para('Delta', 15)].join('\n');

const STRUCTURE = { type: 'structure' as const, max_tokens: 200, overlap_tokens: 50, contextual: false };
const CONTEXTUAL = { ...STRUCTURE, contextual: true };

d('re-chunking a store (requires FILE_SEARCH_TEST_DSN)', () => {
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
    duringEmbed = null;
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

  /** A store with `chunking` (null = a pre-W2 store, static 800/400). */
  async function newStore(chunking: unknown): Promise<string> {
    const store = await repo.createStore({ ownerEmail: OWNER });
    await pool.query('UPDATE vector_stores SET chunking = $2 WHERE id = $1', [store.id, chunking === null ? null : JSON.stringify(chunking)]);
    return store.id;
  }
  /** One file attached through a batch with a credential, not yet ingested. */
  async function attach(storeId: string, content: string, filename: string): Promise<string> {
    const bytes = Buffer.from(content, 'utf8');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/markdown');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, $2, $3, 'assistants', $4, $5, now())`, [fileId, OWNER, filename, sha, bytes.length]);
    await createBatch(storeId, [fileId], null, null, { credentialId: 'key-1', authType: 'api_key' });
    return fileId;
  }
  async function storeWith(chunking: unknown, files: Array<[string, string]>) {
    const storeId = await newStore(chunking);
    const fileIds: string[] = [];
    for (const [name, content] of files) {
      // eslint-disable-next-line no-await-in-loop
      const fileId = await attach(storeId, content, name);
      // eslint-disable-next-line no-await-in-loop
      await processOne(storeId, fileId);
      fileIds.push(fileId);
    }
    return { storeId, fileIds };
  }
  async function start(storeId: string, target: any) {
    const started = await startRechunk(OWNER, storeId, target, ACTOR);
    if (!started.ok) throw new Error(`start refused: ${started.error}`);
    return started.job;
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
  const storeRow = async (storeId: string) => (await pool.query(
    'SELECT active_generation, embedding_model, chunking FROM vector_stores WHERE id = $1', [storeId])).rows[0];
  const rowsOf = async (storeId: string, fileId: string, generation: number) => (await pool.query(
    `SELECT ord, text, tokens, section, section_offset, heading_path, context, embedding::text AS embedding
       FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2 AND generation = $3 ORDER BY ord`,
    [storeId, fileId, generation])).rows;
  const generations = async (storeId: string) => (await pool.query(
    'SELECT DISTINCT generation FROM vector_store_chunks WHERE store_id = $1 ORDER BY generation', [storeId])).rows.map((r) => r.generation);
  const structured = (content: string, s: { max_tokens: number; overlap_tokens: number }) =>
    chunkStructured(content, { maxTokens: s.max_tokens, overlapTokens: s.overlap_tokens, format: 'markdown' });
  const staticChunks = (content: string, max = 800, overlap = 400) =>
    chunkText(content, { type: 'static', static: { max_chunk_size_tokens: max, chunk_overlap_tokens: overlap } });

  // -- the whole way: static → structure → structure + contextual → off ---------------------

  it('static → structure → structure + contextual: every file chunked again by the target setting; the switch sets the chunking with the generation', async () => {
    const { storeId, fileIds } = await storeWith(null, [['guide.md', GUIDE], ['notes.md', NOTES]]);
    const contents = [GUIDE, NOTES];
    expect((await rowsOf(storeId, fileIds[0], 0)).map((r) => r.text)).toEqual(staticChunks(GUIDE).map((c) => c.text));
    embedded = [];
    emitted = [];

    // static → structure
    const job1 = await start(storeId, STRUCTURE);
    expect(job1).toMatchObject({ kind: 'reembed_store', state: 'queued', total: 2, target_chunking: STRUCTURE });
    // Until the switch the store answers with its old setting and generation.
    expect(await storeRow(storeId)).toEqual({ active_generation: 0, embedding_model: 'model-a', chunking: null });
    await drain();
    expect(await storeRow(storeId)).toEqual({ active_generation: 1, embedding_model: 'model-a', chunking: STRUCTURE });
    expect(await generations(storeId)).toEqual([1]);
    for (const [i, fileId] of fileIds.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await rowsOf(storeId, fileId, 1);
      const want = structured(contents[i], STRUCTURE);
      expect(rows.map((r) => [r.text, r.section, r.section_offset, r.heading_path, r.tokens]))
        .toEqual(want.map((c) => [c.text, c.section, c.sectionOffset, c.headingPath, c.tokens]));
      expect(rows.every((r) => r.embedding === '[1,0,0]' && r.context !== null)).toBe(true);
    }
    // usage_bytes is the new chunks' text
    const { rows: usage } = await pool.query(
      `SELECT f.usage_bytes, (SELECT SUM(octet_length(c.text)) FROM vector_store_chunks c
                               WHERE c.store_id = f.store_id AND c.file_id = f.file_id)::int AS bytes
         FROM vector_store_files f WHERE f.store_id = $1`, [storeId]);
    expect(usage.every((u) => Number(u.usage_bytes) === u.bytes)).toBe(true);
    // embeddings: one file_search/reembed event per request, with the job's credential, on behalf of the owner
    const reembedEvents = emitted.filter((e) => e.endpoint === 'file_search/reembed');
    expect(reembedEvents.length).toBe(3); // the start's model check and one request per file
    expect(reembedEvents.every((e) => e.credentialId === 'key-1' && e.onBehalfOf === OWNER)).toBe(true);
    expect(emitted.filter((e) => e.endpoint === 'file_search/context')).toHaveLength(0);
    expect(completeMock).not.toHaveBeenCalled();
    const done1 = await jobSummary(job1.id, OWNER);
    expect(done1).toMatchObject({ state: 'completed', done: 2, failed: 0, target_chunking: STRUCTURE, context_input_tokens: 0 });
    expect(done1!.embedding_tokens).toBe(embedded.length * 3);

    // structure → structure + contextual
    embedded = [];
    emitted = [];
    const job2 = await start(storeId, CONTEXTUAL);
    await drain();
    expect(await storeRow(storeId)).toEqual({ active_generation: 2, embedding_model: 'model-a', chunking: CONTEXTUAL });
    const guide = await rowsOf(storeId, fileIds[0], 2);
    const failed = guide.filter((r) => r.text.includes('FAILME'));
    expect(failed.length).toBeGreaterThan(0);
    for (const r of guide) {
      if (r.text.includes('FAILME')) expect(r.context).toBe(r.heading_path);
      else expect(r.context.split('\n')[1]).toMatch(/^Context of \w*\.$/);
    }
    const allRows = [...guide, ...await rowsOf(storeId, fileIds[1], 2)];
    const ok = allRows.length - failed.length;
    expect(completeMock).toHaveBeenCalledTimes(allRows.length + 1); // + the start's context model check
    // the job counts the context spend; the context events are billed like the embeddings
    expect(await jobSummary(job2.id, OWNER)).toMatchObject({
      state: 'completed',
      target_chunking: CONTEXTUAL,
      context_input_tokens: ok * CALL_USAGE.input,
      context_cached_tokens: ok * CALL_USAGE.cachedRead,
      context_output_tokens: ok * CALL_USAGE.output,
      context_failed_chunks: failed.length,
    });
    const contextEvents = emitted.filter((e) => e.endpoint === 'file_search/context');
    expect(contextEvents).toHaveLength(ok + 1); // the start's check is billed too, not counted in the job
    expect(contextEvents.every((e) => e.model === 'fake-context-model')).toBe(true);
    // the items run in any order: the same inputs, file by file
    expect(embedded.map((e) => e.text).sort()).toEqual(allRows.map((r) => `${r.context}\n\n${r.text}`).sort());

    // contextual on → off: a re-chunk too, without a single context call
    completeMock.mockClear();
    await start(storeId, STRUCTURE);
    await drain();
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 3, chunking: STRUCTURE });
    expect(completeMock).not.toHaveBeenCalled();
    const off = await rowsOf(storeId, fileIds[1], 3);
    expect(off.every((r) => !r.context.includes('Context of'))).toBe(true);
  }, 120_000);

  it('a file attached with an explicit static strategy keeps it through a re-chunk', async () => {
    const storeId = await newStore(null);
    const bytes = Buffer.from(NOTES, 'utf8');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/markdown');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, $2, 'notes.md', 'assistants', $3, $4, now())`, [fileId, OWNER, sha, bytes.length]);
    await createBatch(storeId, [fileId], null, { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 50 } },
      { credentialId: 'key-1', authType: 'api_key' });
    await processOne(storeId, fileId);
    await start(storeId, STRUCTURE);
    await drain();
    expect((await rowsOf(storeId, fileId, 1)).map((r) => [r.text, r.section]))
      .toEqual(staticChunks(NOTES, 200, 50).map((c) => [c.text, null]));
  }, 60_000);

  // -- cancel, restart, failure and retry (review focus 3) ------------------------------------

  it('cancel mid-run: the old setting and generation stay active; an item in flight commits nothing', async () => {
    const { storeId, fileIds } = await storeWith(null, [['guide.md', GUIDE], ['notes.md', NOTES], ['extra.md', EXTRA]]);
    const before = await Promise.all(fileIds.map((f) => rowsOf(storeId, f, 0)));
    const job = await start(storeId, CONTEXTUAL);
    await processReembedItem((await claimNextReembedItem())!);
    const inFlight = (await claimNextReembedItem())!;
    expect(await generations(storeId)).toEqual([0, 1]);

    // The cancel lands while the item is being embedded: its commit must find the job cancelled.
    let cancelled: any;
    duringEmbed = async () => { cancelled = await cancelReembed(OWNER, job.id); };
    await processReembedItem(inFlight);
    expect(cancelled.ok && cancelled.job.state).toBe('cancelled');
    expect(await claimNextReembedItem()).toBeNull();
    expect(await storeRow(storeId)).toEqual({ active_generation: 0, embedding_model: 'model-a', chunking: null });
    expect(await generations(storeId)).toEqual([0]);
    expect(await Promise.all(fileIds.map((f) => rowsOf(storeId, f, 0)))).toEqual(before);
    // search reads the old chunks
    const hits = await repo.recallCandidates({
      storeIds: [storeId], ownerEmail: OWNER, queryText: 'alpha beta', queryEmbedding: [1, 0, 0], limit: 1000,
    });
    expect(hits.length).toBe(before.flat().length);
    // and a new re-chunk can start
    await start(storeId, STRUCTURE);
  }, 60_000);

  it('restart mid-run: an item whose worker died is claimed again after its lease, and the job switches', async () => {
    const { storeId, fileIds } = await storeWith(null, [['guide.md', GUIDE], ['notes.md', NOTES]]);
    const job = await start(storeId, STRUCTURE);
    await processReembedItem((await claimNextReembedItem())!);
    const orphan = (await claimNextReembedItem())!; // the worker dies here: never processed
    expect(await claimNextReembedItem()).toBeNull(); // leased
    await pool.query(
      `UPDATE fs_reembed_items SET claimed_at = now() - interval '16 minutes' WHERE job_id = $1 AND file_id = $2`,
      [orphan.jobId, orphan.fileId]);
    await drain();
    expect(await jobSummary(job.id, OWNER)).toMatchObject({ state: 'completed', done: 2 });
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
    for (const fileId of fileIds) {
      // eslint-disable-next-line no-await-in-loop
      expect((await rowsOf(storeId, fileId, 1)).length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('a file that fails every attempt fails the job with the store unchanged; Retry finishes it', async () => {
    const { storeId, fileIds } = await storeWith(null, [['guide.md', GUIDE], ['notes.md', NOTES]]);
    embedMock.mockImplementation((texts: string[], kind: string, target: any, opts: any) => (
      texts.some((t) => t.includes('Beta sentence')) ? Promise.reject(new Error('upstream 500')) : fakeEmbed(texts, kind, target, opts)));
    const job = await start(storeId, STRUCTURE);
    await drain();
    const failed = await jobSummary(job.id, OWNER);
    expect(failed).toMatchObject({ state: 'failed', failed: 1, done: 1 });
    expect(failed!.error).toMatchObject({ code: 'rechunk_failed' });
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 0, chunking: null });

    embedMock.mockImplementation(fakeEmbed);
    expect(await retryReembed(OWNER, job.id)).toMatchObject({ ok: true, retried: 1 });
    await drain();
    expect(await jobSummary(job.id, OWNER)).toMatchObject({ state: 'completed', done: 2 });
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
    expect((await rowsOf(storeId, fileIds[1], 1)).map((r) => r.text)).toEqual(structured(NOTES, STRUCTURE).map((c) => c.text));
  }, 60_000);

  it('refuses the store\'s own setting, a second job, an expired store and another owner\'s store', async () => {
    const { storeId } = await storeWith(STRUCTURE, [['notes.md', NOTES]]);
    expect(await startRechunk(OWNER, storeId, STRUCTURE, ACTOR)).toEqual({ ok: false, error: 'chunking_current' });
    expect(await startRechunk('someone@example.test', storeId, CONTEXTUAL, ACTOR)).toEqual({ ok: false, error: 'not_found' });
    await start(storeId, CONTEXTUAL);
    expect(await startRechunk(OWNER, storeId, { ...STRUCTURE, max_tokens: 300 }, ACTOR)).toEqual({ ok: false, error: 'reembed_running' });
    const legacy = await newStore(null);
    expect(await startRechunk(OWNER, legacy, { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false }, ACTOR))
      .toEqual({ ok: false, error: 'chunking_current' });
    await pool.query(`UPDATE vector_stores SET status = 'expired' WHERE id = $1`, [legacy]);
    expect(await startRechunk(OWNER, legacy, STRUCTURE, ACTOR)).toEqual({ ok: false, error: 'store_expired' });
  }, 60_000);

  it('an empty store switches its setting at once', async () => {
    const storeId = await newStore(null);
    const job = await start(storeId, STRUCTURE);
    expect(await jobSummary(job.id, OWNER)).toMatchObject({ state: 'completed', total: 0 });
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
  });

  // -- the store's model is not served; the blob is unavailable (fix round 1) --------------------

  it('a store whose model is not served: the start is refused after one short check, and the estimate says so once known', async () => {
    const { storeId, fileIds } = await storeWith(null, [['notes.md', NOTES]]);
    const unserved = (texts: string[], kind: string, target: any, opts: any) => (
      target.model === 'model-a' ? Promise.reject(new EmbeddingModelUnavailableError('model-a')) : fakeEmbed(texts, kind, target, opts));
    embedMock.mockImplementation(unserved);
    embedMock.mockClear();
    expect(await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR)).toEqual({ ok: false, error: 'store_model_unavailable' });
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock.mock.calls[0].slice(0, 3)).toEqual([['model check'], 'query', { model: 'model-a', dimensions: EMBED_DIM }]);
    expect(completeMock).not.toHaveBeenCalled();
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs WHERE kind = $1', ['reembed_store'])).rows[0].n).toBe(0);
    // a refusal decided by the row needs no check
    embedMock.mockClear();
    expect(await startRechunk(OWNER, storeId, { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false }, ACTOR))
      .toEqual({ ok: false, error: 'chunking_current' });
    expect(embedMock).not.toHaveBeenCalled();

    // the estimate makes no call: it reports a model already found not served
    expect((await estimateRechunk(OWNER, storeId, CONTEXTUAL))!.embedding_model_unavailable).toBe(false);
    await pool.query(
      `UPDATE vector_store_files SET status = 'failed', last_error = $2::jsonb WHERE store_id = $1 AND file_id = $3`,
      [storeId, JSON.stringify({ message: 'not served', name: 'EmbeddingModelUnavailableError' }), fileIds[0]]);
    expect((await estimateRechunk(OWNER, storeId, CONTEXTUAL))!.embedding_model_unavailable).toBe(true);
    expect(embedMock).not.toHaveBeenCalled();

    // a check that fails otherwise (timeout, 5xx) lets the start go on
    embedMock.mockImplementation(() => Promise.reject(new Error('socket hang up')));
    await pool.query(`UPDATE vector_store_files SET status = 'completed', last_error = NULL WHERE store_id = $1`, [storeId]);
    expect((await startRechunk(OWNER, storeId, STRUCTURE, ACTOR)).ok).toBe(true);
  }, 60_000);

  // -- the context model (final round) ------------------------------------------------------------

  it('a contextual target whose context model is refused: no job, after one tiny billed check; a timeout lets the start go on', async () => {
    const { storeId } = await storeWith(STRUCTURE, [['notes.md', NOTES]]);
    completeMock.mockClear();
    emitted = [];
    completeMock.mockImplementation(() => Promise.reject(new CompletionError('request_failed', 'HTTP 400', 400)));
    expect(await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR)).toEqual({ ok: false, error: 'context_model_unavailable' });
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock.mock.calls[0][0]).toMatchObject({ model: 'fake-context-model', params: { temperature: 0 } });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs WHERE kind = $1', ['reembed_store'])).rows[0].n).toBe(0);
    completeMock.mockImplementation(() => Promise.reject(new CompletionError('no_deployment', 'none')));
    expect(await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR)).toEqual({ ok: false, error: 'context_model_unavailable' });
    // a reply, even an empty one, is a served model; its spend is recorded as the owner's context usage
    completeMock.mockClear();
    completeMock.mockImplementationOnce(() => Promise.reject(
      new CompletionError('empty_response', 'empty', undefined, { input: 30, cacheWrite: 0, cachedRead: 0, output: 0 })));
    const started = await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR);
    expect(started.ok).toBe(true);
    const check = emitted.filter((e) => e.endpoint === 'file_search/context');
    expect(check).toHaveLength(1);
    expect(check[0]).toMatchObject({ model: 'fake-context-model', inputTokens: 30, credentialId: 'key-1', onBehalfOf: OWNER });
    await drain();
    // a non-contextual target makes no context call at all
    completeMock.mockClear();
    expect((await startRechunk(OWNER, storeId, STRUCTURE, ACTOR)).ok).toBe(true);
    expect(completeMock).not.toHaveBeenCalled();
    await drain();
    // a timeout or 5xx: started anyway (the writer leaves chunks without contexts, a re-chunk fills them later)
    completeMock.mockImplementation(() => Promise.reject(new CompletionError('timeout', 'slow')));
    expect((await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR)).ok).toBe(true);
  }, 60_000);

  // -- vision (W3) ---------------------------------------------------------------------------------

  /** A PDF attached to `storeId` and completed by hand, with one embedded chunk per entry of
   *  `pageEnds` (null: a chunk without page numbers, ingested before they existed). */
  async function completedPdf(storeId: string, name: string, pageEnds: Array<number | null>): Promise<string> {
    const fileId = await attach(storeId, `%PDF-1.4 ${name}`, name);
    const { active_generation: generation } = await storeRow(storeId);
    await pool.query(`UPDATE vector_store_files SET status = 'completed' WHERE store_id = $1 AND file_id = $2`, [storeId, fileId]);
    for (const [ord, page] of pageEnds.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding, page_start, page_end)
         VALUES ($1, $2, $3, $4, $5, 100, '[1,0,0]', $6, $6)`, [storeId, fileId, generation, ord, `page text ${ord}`, page]);
    }
    return fileId;
  }

  it('vision estimate: every PDF at the per-file page cap × 1,250 input tokens (an honest upper bound); a file-static PDF counts too', async () => {
    mockConfig.parsing = { vision: { model: 'fake-vision-model', maxPagesPerFile: 20 } };
    const { storeId } = await storeWith(STRUCTURE, [['notes.md', NOTES]]);
    const small = await completedPdf(storeId, 'small.pdf', [1, 2, 3]);
    await completedPdf(storeId, 'big.PDF', [1, 40, 80]);
    await completedPdf(storeId, 'legacy.pdf', [null, null]);
    await pool.query(`UPDATE vector_store_files SET chunking_strategy = $3 WHERE store_id = $1 AND file_id = $2`,
      [storeId, small, JSON.stringify({ type: 'static', static: { max_chunk_size_tokens: 400, chunk_overlap_tokens: 0 } })]);
    embedMock.mockClear();
    completeMock.mockClear();

    const VISION = { ...STRUCTURE, vision: 'auto' as const };
    const estimate = (await estimateRechunk(OWNER, storeId, VISION))!;
    expect(embedMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    // A 3-page PDF counts at the cap too: its trailing image-only pages would have produced no chunk.
    expect(estimate).toMatchObject({
      files: 4, unchanged: false, target: VISION, vision_model: 'fake-vision-model', vision_files: 3,
      estimated_vision_pages: 3 * 20,
      estimated_vision_input_tokens: 3 * 20 * 1250,
      estimated_vision_output_tokens: 3 * Math.min(20 * 4096, 120_000 + 2 * 4096),
      vision_switched_off: false, vision_unmasked_warning: false,
    });
    // Without vision nothing is counted; the same sizes with another vision mode are a change.
    expect((await estimateRechunk(OWNER, storeId, STRUCTURE))!).toMatchObject({
      unchanged: true, vision_model: null, vision_files: 0, estimated_vision_pages: 0,
      estimated_vision_input_tokens: 0, estimated_vision_output_tokens: 0, vision_unmasked_warning: false,
    });
    await pool.query('UPDATE vector_stores SET chunking = $2 WHERE id = $1', [storeId, JSON.stringify(VISION)]);
    expect((await estimateRechunk(OWNER, storeId, VISION))!.unchanged).toBe(true);
    expect((await estimateRechunk(OWNER, storeId, { ...VISION, vision: 'all' }))!.unchanged).toBe(false);
    expect((await estimateRechunk(OWNER, storeId, STRUCTURE))!.unchanged).toBe(false);

    mockForced = true;
    try {
      expect((await estimateRechunk(OWNER, storeId, VISION))!.vision_unmasked_warning).toBe(true);
      expect((await estimateRechunk(OWNER, storeId, STRUCTURE))!.vision_unmasked_warning).toBe(false);
    } finally {
      mockForced = false;
    }
  }, 60_000);

  it('vision start: a vision mode change is a re-chunk after one billed check of the vision model; refused when not served or switched off', async () => {
    const { storeId } = await storeWith(STRUCTURE, [['notes.md', NOTES]]);
    const VISION = { ...STRUCTURE, vision: 'no_text' as const };
    const jobs = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM fs_jobs WHERE kind = $1', ['reembed_store'])).rows[0].n;
    completeMock.mockClear();
    completeMock.mockImplementation(() => Promise.reject(new CompletionError('request_failed', 'HTTP 400', 400)));
    expect(await startRechunk(OWNER, storeId, VISION, ACTOR)).toEqual({ ok: false, error: 'vision_model_unavailable' });
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock.mock.calls[0][0]).toMatchObject({ model: 'gemini-3.5-flash-lite', params: { temperature: 0 } });
    expect(completeMock.mock.calls[0][0].messages[0].images).toHaveLength(1);
    expect(await jobs()).toBe(0);

    process.env.FILE_SEARCH_VISION = 'off';
    try {
      completeMock.mockClear();
      expect(await startRechunk(OWNER, storeId, VISION, ACTOR)).toEqual({ ok: false, error: 'vision_model_unavailable' });
      expect(completeMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.FILE_SEARCH_VISION;
    }

    completeMock.mockImplementation(() => Promise.resolve({
      text: '[blank page]', usage: { input: 260, cacheWrite: 0, cachedRead: 0, output: 4 }, elapsedMs: 3,
    }));
    emitted = [];
    expect((await startRechunk(OWNER, storeId, VISION, ACTOR)).ok).toBe(true);
    const check = emitted.filter((e) => e.endpoint === 'file_search/vision');
    expect(check).toHaveLength(1);
    expect(check[0]).toMatchObject({ model: 'gemini-3.5-flash-lite', inputTokens: 260, credentialId: 'key-1', onBehalfOf: OWNER });
    await drain();
    expect((await storeRow(storeId)).chunking).toEqual(VISION);
    expect(await startRechunk(OWNER, storeId, VISION, ACTOR)).toEqual({ ok: false, error: 'chunking_current' });

    // Back to off: a re-chunk without a vision check.
    completeMock.mockClear();
    expect((await startRechunk(OWNER, storeId, STRUCTURE, ACTOR)).ok).toBe(true);
    expect(completeMock).not.toHaveBeenCalled();
    await drain();
    // A timeout or 5xx: started anyway (pages that fail keep their text or go to OCR).
    completeMock.mockImplementation(() => Promise.reject(new CompletionError('timeout', 'slow')));
    expect((await startRechunk(OWNER, storeId, VISION, ACTOR)).ok).toBe(true);
    await drain();
  }, 60_000);

  it('the store\'s own contextual setting re-chunks while chunks lack their context, and fills them', async () => {
    const { storeId } = await storeWith(CONTEXTUAL, [['guide.md', GUIDE], ['notes.md', NOTES]]);
    const missing = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM vector_store_chunks
        WHERE store_id = $1 AND embedding IS NOT NULL AND (context IS NULL OR context NOT LIKE '%Context of%')`, [storeId])).rows[0].n;
    expect(missing).toBeGreaterThan(0); // the FAILME section
    const before = (await estimateRechunk(OWNER, storeId, CONTEXTUAL))!;
    expect(before).toMatchObject({ unchanged: true, chunks_without_context: missing });
    // a chunk under a table header with its sentence counts as present (the header line holds a '|')
    expect((await pool.query(
      `SELECT COUNT(*)::int AS n FROM vector_store_chunks WHERE store_id = $1 AND context LIKE '%Context of%' AND context LIKE '%| Port |%'`,
      [storeId])).rows[0].n).toBeGreaterThan(0);
    // another setting of the same store is not affected by the count
    expect((await estimateRechunk(OWNER, storeId, STRUCTURE))!.chunks_without_context).toBe(missing);

    completeMock.mockImplementation((call: any) => fakeComplete({ messages: [call.messages[0], { text: call.messages[1].text.replace('FAILME', 'Fixed') }] }));
    const job = await start(storeId, CONTEXTUAL);
    expect(job.target_chunking).toEqual(CONTEXTUAL);
    await drain();
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: CONTEXTUAL });
    expect(await jobSummary(job.id, OWNER)).toMatchObject({ state: 'completed', context_failed_chunks: 0 });
    const after = (await estimateRechunk(OWNER, storeId, CONTEXTUAL))!;
    expect(after.chunks_without_context).toBe(0);
    completeMock.mockClear();
    embedMock.mockClear();
    expect(await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR)).toEqual({ ok: false, error: 'chunking_current' });
    expect(completeMock).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
  }, 60_000);

  const contextStops = async (storeId: string) => (await pool.query(
    'SELECT file_id, context_stopped FROM vector_store_files WHERE store_id = $1 ORDER BY file_id', [storeId])).rows;

  /** The writer's time limit reached after its first call: a 1 ms deadline, each call 20 ms. */
  function stopAtDeadline(): void {
    mockConfig.contextual.fileDeadlineMs = 1;
    mockConfig.contextual.concurrency = 1;
    completeMock.mockImplementation(async (call: any) => {
      await new Promise((r) => setTimeout(r, 20));
      return fakeComplete(call);
    });
  }
  function normalContexts(): void {
    mockConfig.contextual.fileDeadlineMs = 60000;
    completeMock.mockImplementation(fakeComplete);
  }

  it('a file whose contexts stop at its time limit records it; the fill retries it once, then leaves it alone', async () => {
    stopAtDeadline();
    const { storeId, fileIds: [notes] } = await storeWith(CONTEXTUAL, [['notes.md', NOTES]]);
    expect(await contextStops(storeId)).toEqual([{ file_id: notes, context_stopped: 'deadline' }]);
    expect((await estimateRechunk(OWNER, storeId, CONTEXTUAL))!.chunks_without_context).toBeGreaterThan(0);

    // The fill: a fresh deadline, the same limit — it stops again, once.
    completeMock.mockClear();
    const fill = await start(storeId, CONTEXTUAL);
    await drain();
    expect(completeMock).toHaveBeenCalledTimes(2); // the start's model check, then one context call
    expect(await jobSummary(fill.id, OWNER)).toMatchObject({ state: 'completed' });
    expect(await contextStops(storeId)).toEqual([{ file_id: notes, context_stopped: 'deadline_retried' }]);
    // Its chunks no longer count as missing: no further fill is offered or started.
    expect((await estimateRechunk(OWNER, storeId, CONTEXTUAL))!).toMatchObject({ unchanged: true, chunks_without_context: 0 });
    completeMock.mockClear();
    expect(await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR)).toEqual({ ok: false, error: 'chunking_current' });
    expect(completeMock).not.toHaveBeenCalled();

    // Another setting is a first try again, and its own fill retries it.
    const SMALLER = { ...CONTEXTUAL, max_tokens: 150 };
    await start(storeId, SMALLER);
    await drain();
    expect(await contextStops(storeId)).toEqual([{ file_id: notes, context_stopped: 'deadline' }]);
    expect((await estimateRechunk(OWNER, storeId, SMALLER))!.chunks_without_context).toBeGreaterThan(0);
    // A new ingestion of the file is a first try too (the stop goes with the chunks it writes).
    await pool.query(`UPDATE vector_store_files SET status = 'in_progress', context_stopped = 'deadline_retried' WHERE store_id = $1`, [storeId]);
    await processOne(storeId, notes);
    expect(await contextStops(storeId)).toEqual([{ file_id: notes, context_stopped: 'deadline' }]);
  }, 60_000);

  it('a file whose contexts stop at its token limit is final at once: no fill is offered for it', async () => {
    mockConfig.contextual.maxInputTokensPerFile = 1; // the first call's tokens reach it
    mockConfig.contextual.concurrency = 1;
    const { storeId, fileIds: [notes] } = await storeWith(CONTEXTUAL, [['notes.md', NOTES]]);
    expect(await contextStops(storeId)).toEqual([{ file_id: notes, context_stopped: 'budget' }]);
    expect((await estimateRechunk(OWNER, storeId, CONTEXTUAL))!).toMatchObject({ unchanged: true, chunks_without_context: 0 });
    completeMock.mockClear();
    expect(await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR)).toEqual({ ok: false, error: 'chunking_current' });
    expect(completeMock).not.toHaveBeenCalled();
    // A fill started for another file's gap re-chunks it too; it stays final.
    mockConfig.contextual.maxInputTokensPerFile = 20_000_000;
    stopAtDeadline();
    const extra = await attach(storeId, EXTRA, 'extra.md');
    await processOne(storeId, extra);
    normalContexts();
    mockConfig.contextual.maxInputTokensPerFile = 1;
    await start(storeId, CONTEXTUAL);
    await drain();
    expect(Object.fromEntries((await contextStops(storeId)).map((r) => [r.file_id, r.context_stopped])))
      .toEqual({ [notes]: 'budget', [extra]: 'budget' });
  }, 60_000);

  it('a fill whose retry writes every context clears the file\'s stop; a file without a stop records none', async () => {
    stopAtDeadline();
    const { storeId, fileIds: [notes] } = await storeWith(CONTEXTUAL, [['notes.md', NOTES]]);
    normalContexts();
    const extra = await attach(storeId, EXTRA, 'extra.md');
    await processOne(storeId, extra);
    expect(await contextStops(storeId)).toEqual(
      [{ file_id: notes, context_stopped: 'deadline' }, { file_id: extra, context_stopped: null }]
        .sort((a, b) => a.file_id.localeCompare(b.file_id)));
    await start(storeId, CONTEXTUAL);
    await drain();
    expect((await contextStops(storeId)).map((r) => r.context_stopped)).toEqual([null, null]);
    expect((await estimateRechunk(OWNER, storeId, CONTEXTUAL))!.chunks_without_context).toBe(0);
  }, 60_000);

  const documentEmbeds = () => embedMock.mock.calls.filter((c: any[]) => c[1] === 'document').length;

  it('a file over the chunk ceiling fails at once after chunking — ingestion and a re-chunk item — with no context or embedding call', async () => {
    // No vector part: the ceiling is one chunk per 400 tokens of the per-file limit, set to the file's own size,
    // which the 200/50 setting exceeds (one chunk per ~150 tokens).
    __setVectorBytesPerFileForTests(0);
    mockConfig.limits.maxTokensPerFile = estimateTokens(GUIDE);
    const guideCeiling = Math.ceil(estimateTokens(GUIDE) / 400);
    try {
      const storeId = await newStore(CONTEXTUAL);
      const guide = await attach(storeId, GUIDE, 'guide.md');
      completeMock.mockClear();
      embedMock.mockClear();
      await processOne(storeId, guide);
      const row = (await pool.query('SELECT status, attempts, last_error FROM vector_store_files WHERE file_id = $1', [guide])).rows[0];
      expect(row.status).toBe('failed');
      expect(row.last_error).toMatchObject({ name: 'FileHasTooManyChunksError' });
      expect(row.last_error.message).toMatch(new RegExp(`^The file has \\d+ chunks, more than the ${guideCeiling} a file may have at 3 embedding dimensions\\. Choose a larger chunk size`));
      expect(completeMock).not.toHaveBeenCalled();
      expect(embedMock).not.toHaveBeenCalled();

      __setVectorBytesPerFileForTests(null);
      const { storeId: other } = await storeWith(STRUCTURE, [['notes.md', NOTES]]);
      __setVectorBytesPerFileForTests(0);
      mockConfig.limits.maxTokensPerFile = estimateTokens(NOTES);
      const job = await start(other, CONTEXTUAL);
      completeMock.mockClear();
      embedMock.mockClear();
      await drain();
      const items = (await pool.query('SELECT status, attempts, last_error FROM fs_reembed_items WHERE job_id = $1', [job.id])).rows;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: { name: 'FileHasTooManyChunksError' } });
      expect(completeMock).not.toHaveBeenCalled();
      expect(documentEmbeds()).toBe(0);
    } finally {
      __setVectorBytesPerFileForTests(null);
    }
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0, holders: 0, waiting: 0 });
  }, 60_000);

  const fileRow = async (fileId: string) => (await pool.query(
    'SELECT status, attempts, claimed_at, last_error FROM vector_store_files WHERE file_id = $1', [fileId])).rows[0];

  it('a wait for memory past its bound hands the file back unspent: attempt returned, no context or embedding call', async () => {
    __memoryBudgetForTests.reset(1);
    const holder = await reserveMemory(1); // another file holds the whole budget
    try {
      const storeId = await newStore(CONTEXTUAL);
      const fileId = await attach(storeId, NOTES, 'notes.md');
      await pool.query('UPDATE vector_store_files SET attempts = 1, claimed_at = now() WHERE file_id = $1', [fileId]); // as claimed
      completeMock.mockClear();
      embedMock.mockClear();
      const started = Date.now();
      await processOne(storeId, fileId, { budgetMs: 400 }); // waits at most 200 ms
      expect(Date.now() - started).toBeLessThan(10_000);
      const row = await fileRow(fileId);
      expect(row).toMatchObject({ status: 'in_progress', attempts: 0, last_error: { name: 'FileSearchMemoryBusyError' } });
      expect(completeMock).not.toHaveBeenCalled();
      expect(embedMock).not.toHaveBeenCalled();
      expect(__memoryBudgetForTests.state()).toMatchObject({ used: 1, holders: 1, waiting: 0 });
    } finally {
      holder.release();
      __memoryBudgetForTests.reset(null);
    }
  }, 60_000);

  it('a re-chunk item and a plain re-embed item wait at most half their deadline, well inside the lease', async () => {
    const deadlines: number[] = [];
    const real = memoryBudget.FileMemory.prototype.reserve;
    const spy = jest.spyOn(memoryBudget.FileMemory.prototype, 'reserve').mockImplementation(function (this: any, parts) {
      deadlines.push(this.deadline);
      return real.call(this, parts);
    });
    try {
      const { storeId } = await storeWith(STRUCTURE, [['notes.md', NOTES]]);
      deadlines.length = 0;
      const before = Date.now();
      await start(storeId, CONTEXTUAL); // a re-chunk
      await drain();
      const { storeId: other } = await storeWith(STRUCTURE, [['extra.md', EXTRA]]);
      await pool.query(`UPDATE vector_stores SET embedding_model = 'model-old' WHERE id = $1`, [other]);
      expect((await startReembed(OWNER, other, ACTOR)).ok).toBe(true); // a plain re-embed to the configured model
      await drain();
      expect(deadlines.length).toBeGreaterThanOrEqual(2);
      // A wait lasts at most half of what is left of the item's deadline (waitUntil), below half the lease.
      for (const deadline of deadlines) expect(deadline - before).toBeLessThanOrEqual(PROCESS_BUDGET_MS + 60_000);
      expect(PROCESS_BUDGET_MS / 2).toBeLessThan(LEASE_MINUTES * 60_000 / 2);
      const now = Date.now();
      expect(memoryBudget.waitUntil(now + PROCESS_BUDGET_MS) - now).toBeLessThanOrEqual(PROCESS_BUDGET_MS / 2);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('stopping the worker ends waits for memory at once: the waiting file is handed back', async () => {
    __memoryBudgetForTests.reset(1);
    const holder = await reserveMemory(1);
    try {
      const storeId = await newStore(STRUCTURE);
      const fileId = await attach(storeId, NOTES, 'notes.md');
      startIngestWorker();
      for (let i = 0; i < 200 && __memoryBudgetForTests.state().waiting === 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(__memoryBudgetForTests.state().waiting).toBe(1);
      const stopping = Date.now();
      await stopIngestWorker();
      expect(Date.now() - stopping).toBeLessThan(5_000); // not behind the holder
      expect(await fileRow(fileId)).toMatchObject({
        status: 'in_progress', attempts: 0, last_error: { name: 'FileSearchMemoryBusyError' },
      });
      expect(__memoryBudgetForTests.state()).toMatchObject({ waiting: 0, holders: 1 });
    } finally {
      await stopIngestWorker();
      holder.release();
      __memoryBudgetForTests.reset(null);
    }
  }, 60_000);

  it('a start while an older worker still drains keeps its own stop signal', async () => {
    startIngestWorker();
    const first = __memoryBudgetForTests.state().stopSignal;
    const stopping = stopIngestWorker();
    startIngestWorker();
    const second = __memoryBudgetForTests.state().stopSignal;
    await stopping;
    expect(first?.aborted).toBe(true);
    expect(second).not.toBe(first);
    expect(__memoryBudgetForTests.state().stopSignal).toBe(second); // not cleared by the older stop
    expect(second?.aborted).toBe(false);
    await stopIngestWorker();
    expect(__memoryBudgetForTests.state().stopSignal).toBeUndefined();
  }, 60_000);

  it('after three memory handbacks in a row a timed-out wait spends the attempt', async () => {
    __memoryBudgetForTests.reset(1);
    const holder = await reserveMemory(1);
    try {
      const storeId = await newStore(STRUCTURE);
      const fileId = await attach(storeId, NOTES, 'notes.md');
      const rounds: Array<{ attempts: number; handbacks: number }> = [];
      for (let round = 1; round <= 4; round += 1) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE vector_store_files SET attempts = attempts + 1, claimed_at = now() WHERE file_id = $1', [fileId]); // a claim
        // eslint-disable-next-line no-await-in-loop
        await processOne(storeId, fileId, { budgetMs: 100 });
        // eslint-disable-next-line no-await-in-loop
        const row = await fileRow(fileId);
        rounds.push({ attempts: row.attempts, handbacks: row.last_error.memory_handbacks });
      }
      expect(rounds).toEqual([
        { attempts: 0, handbacks: 1 }, { attempts: 0, handbacks: 2 }, { attempts: 0, handbacks: 3 }, { attempts: 1, handbacks: 4 },
      ]);
      expect((await fileRow(fileId)).status).toBe('in_progress');
    } finally {
      holder.release();
      __memoryBudgetForTests.reset(null);
    }
  }, 60_000);

  // A pool-busy or stopping handback between memory timeouts must not reset the count, else under sustained memory
  // pressure a file is handed back unspent forever (and its OCR/vision pages paid again on every round).
  const INTERLEAVED: Array<() => Error> = [
    () => new FileSearchMemoryBusyError('timeout'), () => new FileSearchMemoryBusyError('timeout'),
    () => new FileSearchBusyError(), () => new FileSearchMemoryBusyError('stopping'),
    () => new FileSearchMemoryBusyError('timeout'), () => new FileSearchMemoryBusyError('timeout'),
  ];
  const INTERLEAVED_ROUNDS = [
    { attempts: 0, handbacks: 1 }, { attempts: 0, handbacks: 2 }, { attempts: 0, handbacks: 2 }, { attempts: 0, handbacks: 2 },
    { attempts: 0, handbacks: 3 }, { attempts: 1, handbacks: 4 },
  ];

  it('the memory handback cap holds across interleaved pool-busy and stopping handbacks (ingestion)', async () => {
    const storeId = await newStore(STRUCTURE);
    const fileId = await attach(storeId, NOTES, 'notes.md');
    const errors = [...INTERLEAVED];
    const spy = jest.spyOn(memoryBudget.FileMemory.prototype, 'reserve').mockImplementation(() => Promise.reject(errors.shift()!()));
    try {
      const rounds: Array<{ attempts: number; handbacks: number }> = [];
      while (errors.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE vector_store_files SET attempts = attempts + 1, claimed_at = now() WHERE file_id = $1', [fileId]); // a claim
        // eslint-disable-next-line no-await-in-loop
        await processOne(storeId, fileId);
        // eslint-disable-next-line no-await-in-loop
        const row = await fileRow(fileId);
        rounds.push({ attempts: row.attempts, handbacks: row.last_error.memory_handbacks });
      }
      expect(rounds).toEqual(INTERLEAVED_ROUNDS);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('the memory handback cap holds across interleaved pool-busy and stopping handbacks (re-chunk item)', async () => {
    const { storeId } = await storeWith(STRUCTURE, [['notes.md', NOTES]]);
    await start(storeId, CONTEXTUAL);
    const item = (await claimNextReembedItem())!;
    expect(item).not.toBeNull();
    await pool.query('UPDATE fs_reembed_items SET attempts = attempts - 1 WHERE job_id = $1 AND file_id = $2', [item.jobId, item.fileId]);
    const errors = [...INTERLEAVED];
    const spy = jest.spyOn(memoryBudget.FileMemory.prototype, 'reserve').mockImplementation(() => Promise.reject(errors.shift()!()));
    try {
      const rounds: Array<{ attempts: number; handbacks: number }> = [];
      while (errors.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE fs_reembed_items SET attempts = attempts + 1, claimed_at = now() WHERE job_id = $1 AND file_id = $2',
          [item.jobId, item.fileId]); // a claim
        // eslint-disable-next-line no-await-in-loop
        await processReembedItem(item);
        // eslint-disable-next-line no-await-in-loop
        const row = (await pool.query('SELECT attempts, last_error FROM fs_reembed_items WHERE job_id = $1 AND file_id = $2',
          [item.jobId, item.fileId])).rows[0];
        rounds.push({ attempts: row.attempts, handbacks: row.last_error.memory_handbacks });
      }
      expect(rounds).toEqual(INTERLEAVED_ROUNDS);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('files wait for the memory budget instead of embedding together, and every way out releases it', async () => {
    __memoryBudgetForTests.reset(1); // every file is larger than the budget: one at a time
    try {
      const storeId = await newStore(STRUCTURE);
      const files = [await attach(storeId, GUIDE, 'guide.md'), await attach(storeId, NOTES, 'notes.md'), await attach(storeId, EXTRA, 'extra.md')];
      const seen: Array<{ holders: number; waiting: number }> = [];
      embedMock.mockImplementation(async (...a: any[]) => {
        if (a[1] === 'document') seen.push(__memoryBudgetForTests.state());
        return fakeEmbed(a[0], a[1], a[2], a[3]);
      });
      await Promise.all(files.map((f) => processOne(storeId, f)));
      expect((await pool.query(`SELECT status FROM vector_store_files WHERE store_id = $1`, [storeId])).rows.map((r) => r.status))
        .toEqual(['completed', 'completed', 'completed']);
      expect(seen.length).toBe(3);
      expect(seen.every((s) => s.holders === 1)).toBe(true); // never two files' vectors at once
      expect(Math.max(...seen.map((s) => s.waiting))).toBeGreaterThan(0);
      expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0, holders: 0, waiting: 0 });

      // A failed embedding and a failed re-chunk item release too.
      embedMock.mockImplementation((texts: string[], kind: string, target: any, opts: any) => (
        kind === 'document' ? Promise.reject(new Error('upstream 500')) : fakeEmbed(texts, kind, target, opts)));
      const extra = await attach(storeId, para('Omega', 30), 'omega.md');
      await processOne(storeId, extra);
      expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0, holders: 0 });
      await start(storeId, CONTEXTUAL);
      await drain();
      expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0, holders: 0, waiting: 0 });
    } finally {
      __memoryBudgetForTests.reset(null);
    }
  }, 60_000);

  it('a file whose chunking needs more heap than the chunker thread may use fails its item at once (permanent)', async () => {
    const { storeId } = await storeWith(STRUCTURE, [['guide.md', GUIDE], ['notes.md', NOTES]]);
    const spy = jest.spyOn(chunkThread, 'chunkStructuredOffThread')
      .mockRejectedValueOnce(new chunkThread.StructureChunkOutOfMemoryError(256));
    try {
      const job = await start(storeId, CONTEXTUAL);
      await drain();
      const items = (await pool.query(
        'SELECT file_id, status, attempts, last_error FROM fs_reembed_items WHERE job_id = $1 ORDER BY file_id', [job.id])).rows;
      const failed = items.filter((i) => i.status === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ attempts: 1 });
      expect(failed[0].last_error).toMatchObject({
        name: 'StructureChunkOutOfMemoryError', message: 'Chunking the file needs more memory than the chunker may use (256 MB)',
      });
      expect(items.find((i) => i.status !== 'failed')!.file_id).not.toBe(failed[0].file_id);
      expect(await jobSummary(job.id, OWNER)).toMatchObject({ state: 'failed' });
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('chunks of a file attached with an explicit static strategy are not missing contexts: complete contexts stay current', async () => {
    const { storeId } = await storeWith(CONTEXTUAL, [['notes.md', NOTES]]); // every structured chunk has its context
    const bytes = Buffer.from(EXTRA, 'utf8');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/markdown');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1, $2, 'extra.md', 'assistants', $3, $4, now())`, [fileId, OWNER, sha, bytes.length]);
    await createBatch(storeId, [fileId], null, { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 50 } },
      { credentialId: 'key-1', authType: 'api_key' });
    await processOne(storeId, fileId);
    const staticRows = await rowsOf(storeId, fileId, 0);
    expect(staticRows.length).toBeGreaterThan(0);
    expect(staticRows.every((r) => r.section === null && r.context === null && r.embedding !== null)).toBe(true);
    expect((await estimateRechunk(OWNER, storeId, CONTEXTUAL))!).toMatchObject({ unchanged: true, chunks_without_context: 0 });
    completeMock.mockClear();
    expect(await startRechunk(OWNER, storeId, CONTEXTUAL, ACTOR)).toEqual({ ok: false, error: 'chunking_current' });
    expect(completeMock).not.toHaveBeenCalled();
  }, 60_000);

  it('a store whose setting is not contextual counts no missing contexts: its own setting stays current', async () => {
    const { storeId } = await storeWith(STRUCTURE, [['guide.md', GUIDE]]);
    expect((await estimateRechunk(OWNER, storeId, STRUCTURE))!).toMatchObject({ unchanged: true, chunks_without_context: 0 });
    expect(await startRechunk(OWNER, storeId, STRUCTURE, ACTOR)).toEqual({ ok: false, error: 'chunking_current' });
  }, 60_000);

  it('a model found not served during the run fails every open item at once: no further extraction or context spend; Retry resumes', async () => {
    const { storeId } = await storeWith(null, [['guide.md', GUIDE], ['notes.md', NOTES], ['extra.md', EXTRA]]);
    const job = await start(storeId, CONTEXTUAL); // the check passed
    embedMock.mockImplementation((texts: string[], kind: string, target: any, opts: any) => (
      kind === 'document' ? Promise.reject(new EmbeddingModelUnavailableError('model-a')) : fakeEmbed(texts, kind, target, opts)));
    completeMock.mockClear();
    const first = (await claimNextReembedItem())!;
    await processReembedItem(first);
    const firstChunks = completeMock.mock.calls.length;
    expect(firstChunks).toBeGreaterThan(0); // the first file spent its context calls
    expect(await claimNextReembedItem()).toBeNull(); // nothing left to claim
    expect(completeMock).toHaveBeenCalledTimes(firstChunks);
    const failed = await jobSummary(job.id, OWNER);
    expect(failed).toMatchObject({ state: 'failed', failed: 3, done: 0 });
    expect(failed!.error).toMatchObject({ code: 'rechunk_failed' });
    const { rows: items } = await pool.query('SELECT last_error->>\'name\' AS name FROM fs_reembed_items WHERE job_id = $1', [job.id]);
    expect(items.map((i) => i.name)).toEqual(Array(3).fill('EmbeddingModelUnavailableError'));
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 0, chunking: null });

    embedMock.mockImplementation(fakeEmbed); // served again
    expect(await retryReembed(OWNER, job.id)).toMatchObject({ ok: true, retried: 3 });
    await drain();
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: CONTEXTUAL });
  }, 60_000);

  it('an unavailable blob is retried, fails the item after the retry budget, and Retry finishes it once the blob is back', async () => {
    const { storeId, fileIds } = await storeWith(null, [['guide.md', GUIDE], ['notes.md', NOTES]]);
    const { rows: [blob] } = await pool.query(
      `SELECT b.sha256, b.bytes FROM file_blobs b JOIN fs_files f ON f.sha256 = b.sha256 WHERE f.id = $1`, [fileIds[1]]);
    await pool.query('UPDATE file_blobs SET bytes = NULL WHERE sha256 = $1', [blob.sha256]);
    const job = await start(storeId, STRUCTURE);
    await drain();
    const { rows: [item] } = await pool.query(
      `SELECT status, attempts, last_error->>'name' AS name FROM fs_reembed_items WHERE job_id = $1 AND file_id = $2`,
      [job.id, fileIds[1]]);
    // transient: every attempt of the budget was spent before it failed
    expect(item).toEqual({ status: 'failed', attempts: 3, name: 'BlobUnavailableError' });
    expect(await jobSummary(job.id, OWNER)).toMatchObject({ state: 'failed', done: 1, failed: 1 });
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 0, chunking: null });

    await pool.query('UPDATE file_blobs SET bytes = $2 WHERE sha256 = $1', [blob.sha256, blob.bytes]);
    expect(await retryReembed(OWNER, job.id)).toMatchObject({ ok: true, retried: 1 });
    await drain();
    expect(await jobSummary(job.id, OWNER)).toMatchObject({ state: 'completed', done: 2 });
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
    expect((await rowsOf(storeId, fileIds[1], 1)).map((r) => r.text)).toEqual(structured(NOTES, STRUCTURE).map((c) => c.text));
  }, 60_000);

  it('a key-less chunk set serves every generation only when it is the only set: beside keyed sets it fills nothing', async () => {
    const { storeId } = await storeWith(null, [['notes.md', NOTES]]);
    await start(storeId, STRUCTURE);
    const fileId = await attach(storeId, GUIDE, 'guide.md'); // in progress, not ingested
    const staticSet = staticChunks(GUIDE).map((c) => ({ ...c }));
    const structureSet = structured(GUIDE, STRUCTURE).map((c, ord) => ({ ord, text: c.text, tokens: c.tokens }));
    const vectors = (n: number) => ({ 'model-a': { vectors: Array.from({ length: n }, () => [1, 0, 0]), tokens: 0 } });
    // the active generation (static 800/400) has no set of its own: stale, though a key-less set is there
    expect(await __commitChunkSetsForTests(storeId, fileId, [
      { key: null, chunks: staticSet, embedded: vectors(staticSet.length) },
      { key: chunkingKey(STRUCTURE), chunks: structureSet, embedded: vectors(structureSet.length) },
    ])).toBe('stale');
    expect((await rowsOf(storeId, fileId, 0)).length + (await rowsOf(storeId, fileId, 1)).length).toBe(0);
    // with both keyed sets it commits, each generation with its own chunks
    expect(await __commitChunkSetsForTests(storeId, fileId, [
      { key: chunkingKey({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false }), chunks: staticSet,
        embedded: vectors(staticSet.length) },
      { key: chunkingKey(STRUCTURE), chunks: structureSet, embedded: vectors(structureSet.length) },
    ])).toBe('committed');
    expect((await rowsOf(storeId, fileId, 0)).map((r) => r.text)).toEqual(staticSet.map((c) => c.text));
    expect((await rowsOf(storeId, fileId, 1)).map((r) => r.text)).toEqual(structureSet.map((c) => c.text));
  }, 60_000);

  // -- ingestion during the run (review focus 3) ---------------------------------------------

  it('a file attached during the run: the store\'s setting in the active generation, the target setting in the new one', async () => {
    const { storeId } = await storeWith(null, [['notes.md', NOTES]]);
    const job = await start(storeId, STRUCTURE);
    const fileId = await attach(storeId, GUIDE, 'guide.md');
    await processOne(storeId, fileId);
    expect((await rowsOf(storeId, fileId, 0)).map((r) => [r.text, r.section])).toEqual(staticChunks(GUIDE).map((c) => [c.text, null]));
    expect((await rowsOf(storeId, fileId, 1)).map((r) => [r.text, r.section]))
      .toEqual(structured(GUIDE, STRUCTURE).map((c) => [c.text, c.section]));
    // the item is complete without the worker; the job switches once the seeded file is done
    expect((await pool.query(`SELECT status FROM fs_reembed_items WHERE job_id = $1 AND file_id = $2`, [job.id, fileId])).rows)
      .toEqual([{ status: 'completed' }]);
    await drain();
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
    expect((await rowsOf(storeId, fileId, 1)).map((r) => r.text)).toEqual(structured(GUIDE, STRUCTURE).map((c) => c.text));
    // usage bytes: the active set's at the commit, the new chunks' after the switch
    const { rows: [f] } = await pool.query('SELECT usage_bytes FROM vector_store_files WHERE file_id = $1', [fileId]);
    expect(Number(f.usage_bytes)).toBe(structured(GUIDE, STRUCTURE).reduce((n, c) => n + Buffer.byteLength(c.text), 0));
  }, 60_000);

  it('a re-chunk that starts while a file is being embedded: its commit is stale and it chunks again for the new generation', async () => {
    const { storeId } = await storeWith(null, [['notes.md', NOTES]]);
    const fileId = await attach(storeId, GUIDE, 'guide.md');
    let job: any;
    duringEmbed = async () => { job = await start(storeId, STRUCTURE); };
    await processOne(storeId, fileId);
    expect(job).toBeDefined();
    expect((await rowsOf(storeId, fileId, 0)).map((r) => r.text)).toEqual(staticChunks(GUIDE).map((c) => c.text));
    expect((await rowsOf(storeId, fileId, 1)).map((r) => r.text)).toEqual(structured(GUIDE, STRUCTURE).map((c) => c.text));
    await drain();
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
  }, 60_000);

  it('a switch while a file is being embedded: its commit writes the target setting into the new active generation', async () => {
    const { storeId } = await storeWith(null, [['notes.md', NOTES]]);
    await start(storeId, STRUCTURE);
    const fileId = await attach(storeId, GUIDE, 'guide.md');
    duringEmbed = async () => { await drain(); }; // the seeded file's item, then the switch
    await processOne(storeId, fileId);
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
    expect(await generations(storeId)).toEqual([1]);
    expect((await rowsOf(storeId, fileId, 1)).map((r) => r.text)).toEqual(structured(GUIDE, STRUCTURE).map((c) => c.text));
    expect((await pool.query('SELECT status FROM vector_store_files WHERE file_id = $1', [fileId])).rows[0].status).toBe('completed');
  }, 60_000);

  it('files deleted during the run — before their item and while it is in flight — never reappear', async () => {
    const { storeId, fileIds } = await storeWith(null, [['guide.md', GUIDE], ['notes.md', NOTES], ['extra.md', EXTRA]]);
    const job = await start(storeId, STRUCTURE);
    const first = (await claimNextReembedItem())!;
    expect(await repo.deleteStoreFile(storeId, first.fileId, OWNER)).toEqual({ deleted: true });
    await processReembedItem(first); // in flight while the file went
    const other = fileIds.find((f) => f !== first.fileId)!;
    expect(await repo.deleteStoreFile(storeId, other, OWNER)).toEqual({ deleted: true });
    await drain();
    const kept = fileIds.filter((f) => f !== first.fileId && f !== other);
    expect(await jobSummary(job.id, OWNER)).toMatchObject({ state: 'completed' });
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
    const { rows } = await pool.query('SELECT DISTINCT file_id FROM vector_store_chunks WHERE store_id = $1', [storeId]);
    expect(rows.map((r) => r.file_id)).toEqual(kept);
  }, 60_000);

  it('attach and delete race the run: every remaining file ends with its target chunks only (FILE_SEARCH_RACE_ITERATIONS)', async () => {
    const iterations = Math.max(1, Math.min(Number(process.env.FILE_SEARCH_RACE_ITERATIONS) || 6, 60));
    for (let n = 0; n < iterations; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { storeId, fileIds } = await storeWith(null, [['notes.md', `${NOTES}\n\n${para(`Run${n}`, 3)}`], ['extra.md', EXTRA]]);
      // eslint-disable-next-line no-await-in-loop
      await start(storeId, STRUCTURE);
      // eslint-disable-next-line no-await-in-loop
      const added = await attach(storeId, `${GUIDE}\n\n${para(`Added${n}`, 2)}`, 'guide.md');
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([
        drain(),
        processOne(storeId, added),
        repo.deleteStoreFile(storeId, fileIds[n % 2], OWNER),
      ]);
      // eslint-disable-next-line no-await-in-loop
      await drain();
      // What the worker's idle step does when nothing is claimable: a delete that removed the last
      // open item left no item commit to switch the job (see the two tests below).
      // eslint-disable-next-line no-await-in-loop
      await settleIdleReembedJobs();
      // eslint-disable-next-line no-await-in-loop
      const store = await storeRow(storeId);
      expect(store).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
      // eslint-disable-next-line no-await-in-loop
      expect(await generations(storeId)).toEqual([1]);
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `SELECT f.file_id, (SELECT COUNT(*) FROM vector_store_chunks c WHERE c.store_id = f.store_id AND c.file_id = f.file_id
                              AND c.section IS NULL)::int AS static_rows,
                (SELECT COUNT(*) FROM vector_store_chunks c WHERE c.store_id = f.store_id AND c.file_id = f.file_id)::int AS rows
           FROM vector_store_files f WHERE f.store_id = $1 ORDER BY f.file_id`, [storeId]);
      expect(rows.map((r) => r.file_id).sort()).toEqual([fileIds[(n + 1) % 2], added].sort());
      for (const r of rows) expect([r.static_rows, r.rows > 0]).toEqual([0, true]);
      // eslint-disable-next-line no-await-in-loop
      const orphans = await pool.query(
        `SELECT 1 FROM vector_store_chunks c WHERE c.store_id = $1
            AND NOT EXISTS (SELECT 1 FROM vector_store_files f WHERE f.store_id = c.store_id AND f.file_id = c.file_id)`, [storeId]);
      expect(orphans.rowCount).toBe(0);
    }
  }, 300_000);

  // A delete can remove a job's last open item without any item commit left to switch the job;
  // the worker's idle step (settleIdleReembedJobs, also run by the sweeper) switches it.
  it('the last open item deleted while unclaimed: the idle settle switches the store', async () => {
    const { storeId, fileIds } = await storeWith(null, [['notes.md', NOTES], ['extra.md', EXTRA]]);
    await start(storeId, STRUCTURE);
    const first = (await claimNextReembedItem())!;
    await processReembedItem(first);
    await repo.deleteStoreFile(storeId, fileIds.find((f) => f !== first.fileId)!, OWNER);
    await drain();
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 0, chunking: null });
    expect(await settleIdleReembedJobs()).toBe(1);
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
  }, 60_000);

  it('the last open item deleted while in flight: the idle settle switches the store', async () => {
    const { storeId } = await storeWith(null, [['notes.md', NOTES], ['extra.md', EXTRA]]);
    await start(storeId, STRUCTURE);
    const first = (await claimNextReembedItem())!;
    const second = (await claimNextReembedItem())!;
    await processReembedItem(first);
    await repo.deleteStoreFile(storeId, second.fileId, OWNER);
    await processReembedItem(second);
    await drain();
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 0, chunking: null });
    expect(await settleIdleReembedJobs()).toBe(1);
    expect(await storeRow(storeId)).toMatchObject({ active_generation: 1, chunking: STRUCTURE });
  }, 60_000);

  // -- estimate ------------------------------------------------------------------------------

  it('estimate: no blob, embedding or model call; embedded chunks only; exact cuts when only contextual changes', async () => {
    const blank = ' \t'.repeat(3000);
    const doc = `# Notes\n\n${para('Before', 8)}\n\n${blank}\n\n${para('After', 8)}`;
    const { storeId } = await storeWith({ ...STRUCTURE, max_tokens: 100, overlap_tokens: 0 }, [['blank.md', doc], ['guide.md', GUIDE]]);
    embedMock.mockClear();
    completeMock.mockClear();
    await pool.query('UPDATE file_blobs SET bytes = NULL'); // a blob read would fail now
    const { rows: [counts] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded, COUNT(*)::int AS all_rows,
              SUM(tokens) FILTER (WHERE embedding IS NOT NULL)::int AS tokens
         FROM vector_store_chunks WHERE store_id = $1`, [storeId]);
    expect(counts.all_rows).toBeGreaterThan(counts.embedded);

    const target = { type: 'structure' as const, max_tokens: 100, overlap_tokens: 0, contextual: true };
    const estimate = (await estimateRechunk(OWNER, storeId, target))!;
    expect(embedMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(estimate).toMatchObject({
      store_id: storeId, files: 2, unchanged: false, running_job_id: null, embedding_model: 'model-a',
      current: { ...target, contextual: false }, target, context_model: 'fake-context-model',
      current_chunks: counts.embedded, estimated_chunks: counts.embedded,
    });
    expect(estimate.estimated_embedding_tokens).toBe(counts.tokens + counts.embedded * (12 + 60));
    expect(estimate.estimated_context_input_tokens).toBeGreaterThan(0);
    expect(estimate.estimated_context_output_tokens).toBe(counts.embedded * 200);
    expect((await estimateRechunk(OWNER, storeId, { ...target, contextual: false }))!).toMatchObject({
      unchanged: true, context_model: null, estimated_context_input_tokens: 0, estimated_context_output_tokens: 0,
    });
    expect(await estimateRechunk('someone@example.test', storeId, target)).toBeNull();
  }, 60_000);

  it('estimate: within a factor of two of the real re-chunk (chunks, embedding tokens, context input) on the corpus', async () => {
    const files: Array<[string, string]> = ['developer-chapter-16-file-search-tool.md', 'user-chapter-2-features.md', 'user-chapter-9-roles.md']
      .map((name) => [name, readFileSync(join(CORPUS, name), 'utf8')]);
    const { storeId } = await storeWith(null, files);
    const target = { type: 'structure' as const, max_tokens: 800, overlap_tokens: 100, contextual: true };
    const estimate = (await estimateRechunk(OWNER, storeId, target))!;
    embedded = [];
    completeMock.mockClear();
    await start(storeId, target);
    await drain();
    const { rows: [real] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS chunks FROM vector_store_chunks WHERE store_id = $1`, [storeId]);
    const realEmbeddingTokens = embedded.reduce((n, e) => n + countTokens(e.text), 0);
    const realContextInput = files.reduce((n, [, content]) => {
      const chunks = structured(content, target).filter((c) => /\S/.test(c.text)).length;
      return n + estimateContextTokens(countTokens(content), chunks).input;
    }, 0);
    const within = (estimated: number, actual: number) => {
      expect(estimated).toBeGreaterThanOrEqual(actual / 2);
      expect(estimated).toBeLessThanOrEqual(actual * 2);
    };
    within(estimate.estimated_chunks, real.chunks);
    within(estimate.estimated_embedding_tokens, realEmbeddingTokens);
    within(estimate.estimated_context_input_tokens, realContextInput);
    expect(completeMock).toHaveBeenCalledTimes(real.chunks + 1); // + the start's context model check
  }, 120_000);

  it('estimate: bounded on a large store (3,000 files, 30,000 chunks)', async () => {
    const storeId = await newStore(null);
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage, ref_count)
       SELECT md5('b' || i) || md5('c' || i), 1, 'db', 1 FROM generate_series(1, 3000) i`);
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       SELECT 'file-big-' || i, $1, 'f.md', 'assistants', md5('b' || i) || md5('c' || i), 1 FROM generate_series(1, 3000) i`, [OWNER]);
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status)
       SELECT $1, 'file-big-' || i, 'completed' FROM generate_series(1, 3000) i`, [storeId]);
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding)
       SELECT $1, 'file-big-' || i, 0, o, 'chunk text', 800, '[1,0,0]'::vector
         FROM generate_series(1, 3000) i, generate_series(0, 9) o`, [storeId]);
    const t0 = Date.now();
    const estimate = (await estimateRechunk(OWNER, storeId, CONTEXTUAL))!;
    const elapsed = Date.now() - t0;
    expect(estimate).toMatchObject({ files: 3000, current_chunks: 30000 });
    // static 800/400: each file holds 800 + 9 × 400 = 4,400 tokens of text; structure 200/50 at half fill
    const perFile = Math.max(Math.ceil(4400 / (0.5 * 200)), 1 + Math.ceil((4400 - 200) / 150));
    expect(estimate.estimated_chunks).toBe(3000 * perFile);
    expect(elapsed).toBeLessThan(3000);
    expect(embedMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  }, 120_000);
});

// -- a blob on S3 -------------------------------------------------------------------------------

dS3('re-chunking with blobs on the test MinIO (requires FILE_SEARCH_TEST_DSN and FILE_SEARCH_TEST_S3_*)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const prefix = `fs-rechunk-${crypto.randomBytes(4).toString('hex')}`;
  const s3Config = () => ({ bucket: S3.bucket, prefix, endpoint: S3.endpoint, region: S3.region });
  const credentials = () => ({ accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey });
  const written: string[] = [];

  beforeAll(async () => {
    mockConfig = freshConfig();
    mockConfig.blobStorage = { backend: 's3', localPath: '', s3: s3Config() };
    setBlobS3CredentialsForTests(credentials());
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
  });

  afterAll(async () => {
    const direct = createS3Backend(s3Config(), { credentials: credentials() });
    for (const sha of written) await direct.delete(sha); // by exact key, never a listing
    setBlobS3CredentialsForTests(null);
    await closeStructureChunkThread();
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  it('reads each file from S3 and switches the store to the target setting', async () => {
    embedMock.mockReset();
    embedMock.mockImplementation(fakeEmbed);
    const store = await repo.createStore({ ownerEmail: OWNER });
    const fileIds: string[] = [];
    for (const [name, content] of [['guide.md', GUIDE], ['notes.md', NOTES]]) {
      const bytes = Buffer.from(content, 'utf8');
      const sha = sha256Of(bytes);
      written.push(sha);
      // eslint-disable-next-line no-await-in-loop
      await retainBlob(sha, bytes, 'text/markdown');
      const fileId = newFileId();
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
         VALUES ($1, $2, $3, 'assistants', $4, $5, now())`, [fileId, OWNER, name, sha, bytes.length]);
      // eslint-disable-next-line no-await-in-loop
      await createBatch(store.id, [fileId], null, null, { credentialId: 'key-1', authType: 'api_key' });
      // eslint-disable-next-line no-await-in-loop
      await processOne(store.id, fileId);
      fileIds.push(fileId);
    }
    const { rows: blobs } = await pool.query('SELECT storage FROM file_blobs');
    expect(blobs.every((b) => b.storage === 's3')).toBe(true);
    const started = await startRechunk(OWNER, store.id, STRUCTURE, ACTOR);
    expect(started.ok).toBe(true);
    for (let item = await claimNextReembedItem(); item; item = await claimNextReembedItem()) {
      // eslint-disable-next-line no-await-in-loop
      await processReembedItem(item);
    }
    const { rows: [row] } = await pool.query('SELECT active_generation, chunking FROM vector_stores WHERE id = $1', [store.id]);
    expect(row).toEqual({ active_generation: 1, chunking: STRUCTURE });
    const { rows } = await pool.query(
      `SELECT text FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2 AND generation = 1 ORDER BY ord`, [store.id, fileIds[1]]);
    expect(rows.map((r) => r.text)).toEqual(
      chunkStructured(NOTES, { maxTokens: STRUCTURE.max_tokens, overlapTokens: STRUCTURE.overlap_tokens, format: 'markdown' }).map((c) => c.text));
  }, 60_000);
});
