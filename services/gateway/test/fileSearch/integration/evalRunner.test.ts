// The evaluation runner's pipeline against a real Postgres/pgvector: three small corpus files go
// through the gateway's own ingestion (createBatch + processOne), their questions through the real
// searchVectorStores, and the metrics come out of the shared normaliser and metrics module. Only
// embed() is faked (a hashed bag of words, no network) and the reranker is disabled, as in
// endToEnd.test.ts. The three files make so few chunks that every chunk comes back in the top 20,
// so recall@20 must be 1: a quote lost between extraction, chunking and the database would fail it.
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { searchVectorStores } from '../../../src/fileSearch/search';
import { evaluateOutcomes } from '../../../src/fileSearch/eval/metrics';
import { CostMeter, PRICES } from '../../../scripts/fileSearchEval/costMeter';
import { EvalQuestion, evaluateQuestions } from '../../../scripts/fileSearchEval/evaluate';
import { EVAL_OWNER, ensureStore, estimateFileContext, ManifestEntry, pipelineSettings } from '../../../scripts/fileSearchEval/ingest';
import { VisionUsageTap } from '../../../scripts/fileSearchEval/parsing';
import usageEmitter from '../../../src/services/usageEventEmitter';
import { VISION_DEFAULTS } from '../../../src/fileSearch/visionTranscriber';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalise } = require('../../../../../ci/file-search-eval/normalise');

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 16;
const EVAL_DIR = path.resolve(__dirname, '../../../../../ci/file-search-eval');
const FILES = ['markdown/user-chapter-6-opencode.md', 'markdown/user-chapter-5-codex.md', 'markdown/user-chapter-9-roles.md'];

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false, storeChunkText: false, sampleRate: 1, source: 'test', maxConcurrentWrites: 5 }),
  default: { getFileSearchConfig: () => mockConfig },
}));

jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { embed } = require('../../../src/fileSearch/embedder');

// The context model of the contextual store: a fixed sentence and fixed usage per call, no network.
const CALL_USAGE = { input: 120, cacheWrite: 20, cachedRead: 400, output: 9 };
const completeMock: any = jest.fn();
jest.mock('../../../src/fileSearch/orchestrationCompletion', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/orchestrationCompletion'),
  __esModule: true,
  orchestrationComplete: (...a: any[]) => completeMock(...a),
}));
// eslint-disable-next-line import/first
import { closeStructureChunkThread } from '../../../src/fileSearch/structureChunkThread';

function fakeEmbedding(text: string): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) % EMBED_DIM;
    v[h] += 1;
  }
  return v.some((x) => x > 0) ? v : [1, ...v.slice(1)];
}

d('file_search evaluation runner (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'corpus', 'manifest.json'), 'utf8'))
    .filter((e: ManifestEntry) => FILES.includes(e.file));
  const questions: EvalQuestion[] = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'questions.json'), 'utf8'))
    .questions.filter((q: EvalQuestion) => FILES.includes(q.file));

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM, rewriteQuery: false,
      hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50, rerank: { enabled: false, model: 'unused' } },
      chunking: { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false },
      contextual: { model: 'fake-context-model', maxDocumentTokens: 32000, concurrency: 2, requestTimeoutMs: 5000,
        fileDeadlineMs: 60000, maxInputTokensPerFile: 20000000 },
      parentSections: { maxTokens: 1500, scope: 'tool' },
      limits: { maxFileBytes: 33554432, maxTokensPerFile: 5000000, maxFilesPerStore: 10000 },
      ingestion: { concurrency: 1, extractTimeoutMs: 60000, maxRetries: 3 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
      parsing: { ocr: { languages: ['eng'] }, vision: { ...VISION_DEFAULTS, model: 'fake-vision-model', defaultMode: 'off' } },
    };
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    await closeStructureChunkThread();
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => {
    completeMock.mockReset();
    completeMock.mockImplementation(async () => ({ text: 'A context sentence.', usage: { ...CALL_USAGE }, elapsedMs: 1 }));
    embed.mockReset();
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map(fakeEmbedding),
      usage: { promptTokens: texts.length * 100, totalTokens: texts.length * 100 },
    }));
  });

  it('ingests once per key, then answers every question of those files within the top 20', async () => {
    expect(manifest).toHaveLength(3);
    expect(questions.length).toBeGreaterThanOrEqual(5);
    const settings = pipelineSettings('manifest-sha');
    const meter = new CostMeter(5);
    const opts = { corpusDir: path.join(EVAL_DIR, 'corpus'), manifest, settings, meter,
      embeddingUsd: (t: number) => meter.embeddingUsd(t), log: () => {} };

    const first = await ensureStore(opts);
    expect(first).toMatchObject({ reused: false, files: 3, completed: 3, failed: [], pending: 0, ingestedThisRun: 3 });
    expect(first.chunks).toBeGreaterThanOrEqual(3);
    // The job's provider-reported tokens reached the meter: 100 per chunk in this fake.
    expect(meter.snapshot().embeddingTokens).toBe(first.chunks * 100);

    const again = await ensureStore(opts);
    expect(again).toMatchObject({ storeId: first.storeId, reused: true, ingestedThisRun: 0, completed: 3 });

    const run = await evaluateQuestions(questions, {
      meter, normalise, estimateUsd: () => 0,
      search: async (query) => {
        const res = await searchVectorStores({ storeIds: [first.storeId], query, ownerEmail: EVAL_OWNER, maxNumResults: 20 });
        return { mode: res.mode, hits: res.data.map((h) => ({ filename: h.filename, text: h.content[0].text })) };
      },
    });
    expect(run.complete).toBe(true);
    expect(run.modes).toEqual({ rrf_only: questions.length });
    const metrics = evaluateOutcomes(run.outcomes);
    expect(metrics.overall.questions).toBe(questions.length);
    expect(metrics.overall.recall['20']).toBe(1);
    expect(metrics.byKind.multihop?.recall['20']).toBe(1);
  });

  it('warns when a completed file with chunks reported no embedding tokens (cost would be under-counted)', async () => {
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map(fakeEmbedding), usage: { promptTokens: 0, totalTokens: 0 },
    }));
    const chunking = { type: 'static', static: { max_chunk_size_tokens: 400, chunk_overlap_tokens: 100 } };
    const settings = pipelineSettings('manifest-sha', { chunking });
    const meter = new CostMeter(5);
    const logs: string[] = [];
    const summary = await ensureStore({ corpusDir: path.join(EVAL_DIR, 'corpus'), manifest, settings, chunking, meter,
      embeddingUsd: (t: number) => meter.embeddingUsd(t), log: (m) => logs.push(m) });
    expect(summary).toMatchObject({ completed: 3, ingestedThisRun: 3 });
    const warnings = logs.filter((l) => /^WARNING: .* completed with \d+ chunks but its job reported 0 embedding tokens/.test(l));
    expect(warnings).toHaveLength(3);
    // The first test's store differs only in chunking; the runner says so instead of silently re-ingesting.
    expect(logs).toContainEqual(expect.stringMatching(/^not reusing store fseval-[0-9a-f]{16}: chunking changed$/));
  });

  const contextualConfig = {
    description: 'contextual', fileSearch: {}, storeChunking: { type: 'structure' as const, max_tokens: 800, overlap_tokens: 0 },
    contextual: { model: 'fake-context-model' },
  };
  const contextPrices = { 'fake-context-model': {
    inputPer1kTokens: 0.001, cacheWritePer1kTokens: 0.001, cachedReadPer1kTokens: 0.0001, outputPer1kTokens: 0.005,
  } };

  it('builds a contextual store with the configuration\'s setting, and meters and reports its context tokens', async () => {
    const settings = pipelineSettings('manifest-sha', contextualConfig);
    const meter = new CostMeter(5, PRICES, contextPrices);
    const logs: string[] = [];
    const summary = await ensureStore({ corpusDir: path.join(EVAL_DIR, 'corpus'), manifest, settings, meter,
      embeddingUsd: (t: number) => meter.embeddingUsd(t), contextEstimateUsd: (m, e) => meter.contextEstimateUsd(m, e),
      log: (m) => logs.push(m) });
    expect(summary).toMatchObject({ completed: 3, failed: [], pending: 0, ingestedThisRun: 3, stopReason: null });
    expect(logs).toContainEqual(expect.stringMatching(/^not reusing store fseval-[0-9a-f]{16}: chunking, contextual changed$/));

    const { rows: [store] } = await pool.query('SELECT chunking FROM vector_stores WHERE id = $1', [summary.storeId]);
    expect(store.chunking).toEqual({ type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true });
    const { rows: [counts] } = await pool.query(
      `SELECT count(*)::int AS chunks, count(section)::int AS sectioned, count(*) FILTER (WHERE context LIKE '%A context sentence.%')::int AS contextual
         FROM vector_store_chunks WHERE store_id = $1`, [summary.storeId]);
    expect(counts.sectioned).toBe(counts.chunks);
    expect(counts.contextual).toBe(completeMock.mock.calls.length);
    expect(summary.chunksByKind).toEqual({ markdown: counts.chunks });

    const calls = completeMock.mock.calls.length;
    expect(calls).toBeGreaterThan(3);
    expect(summary.context).toEqual({
      inputTokens: calls * CALL_USAGE.input, cachedTokens: calls * CALL_USAGE.cachedRead, outputTokens: calls * CALL_USAGE.output,
      failedChunks: 0, cacheReadShare: CALL_USAGE.cachedRead / (CALL_USAGE.input + CALL_USAGE.cachedRead),
    });
    expect(meter.snapshot().context).toEqual({ 'fake-context-model': {
      inputTokens: calls * CALL_USAGE.input, cachedTokens: calls * CALL_USAGE.cachedRead, outputTokens: calls * CALL_USAGE.output,
    } });

    const again = await ensureStore({ corpusDir: path.join(EVAL_DIR, 'corpus'), manifest, settings, meter,
      embeddingUsd: (t: number) => meter.embeddingUsd(t), contextEstimateUsd: (m, e) => meter.contextEstimateUsd(m, e), log: () => {} });
    expect(again).toMatchObject({ storeId: summary.storeId, reused: true, context: summary.context });
    expect(completeMock).toHaveBeenCalledTimes(calls);
  });

  it('stops ingesting before a file whose context estimate could pass the ceiling and says how far it got', async () => {
    const settings = pipelineSettings('manifest-sha', { ...contextualConfig, storeChunking: { type: 'structure', max_tokens: 400, overlap_tokens: 0 } });
    // Smallest estimate first, priced so that it costs exactly the ceiling: the first file fits, its
    // real spend plus the (no smaller) second estimate does not.
    const estimates = await Promise.all(manifest.map(async (e) => ({ entry: e, tokens: (await estimateFileContext(e.file,
      fs.readFileSync(path.join(EVAL_DIR, 'corpus', e.file)), settings.chunking, mockConfig.contextual)).input })));
    estimates.sort((a, b) => a.tokens - b.tokens);
    const ordered = estimates.map((e) => e.entry);
    const perToken = { 'fake-context-model': { inputPer1kTokens: 1000 / estimates[0].tokens, cacheWritePer1kTokens: 0,
      cachedReadPer1kTokens: 0, outputPer1kTokens: 0 } };
    const meter = new CostMeter(1, { ...PRICES, embeddingPer1kTokens: 0 }, perToken);
    const summary = await ensureStore({ corpusDir: path.join(EVAL_DIR, 'corpus'), manifest: ordered, settings, meter,
      embeddingUsd: () => 0, contextEstimateUsd: (m, e) => meter.contextEstimateUsd(m, e), log: () => {} });
    const esc = (f: string) => f.replace(/[.]/g, '\\.');
    expect(summary.ingestedThisRun).toBe(1);
    expect(summary.files).toBe(1);
    expect(summary.stopReason).toMatch(new RegExp(`before ${esc(ordered[1].file)}, file 2 of 3 to ingest; `
      + `1 file\\(s\\) ingested this run, the last ${esc(ordered[0].file)}\\)$`));
    expect(meter.spentUsd).toBeGreaterThan(0);
    expect(meter.spentUsd).toBeLessThanOrEqual(1);
  });

  // Vision needs poppler and sharp to render pages: the FILE_SEARCH_TEST_BINARIES suites' tools.
  (process.env.FILE_SEARCH_TEST_BINARIES === '1' ? it : it.skip)(
    'transcribes a scanned PDF\'s pages with the vision model, books every call as reported, and keeps slide pages', async () => {
      const files = ['scanned/user-chapter-1-introduction.pdf', 'pptx/quillmere-operations-review.pptx', 'xlsx/quillmere-maintenance-ledger.xlsx'];
      const office: ManifestEntry[] = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'corpus', 'manifest.json'), 'utf8'))
        .filter((e: ManifestEntry) => files.includes(e.file));
      const VISION_USAGE = { input: 1235, cacheWrite: 0, cachedRead: 0, output: 350 };
      completeMock.mockImplementation(async (call: any) => ({
        text: call.messages?.some((m: any) => m.images?.length) ? 'What is SAIL-PROXY? A transcribed page.' : 'A context sentence.',
        usage: { ...VISION_USAGE }, elapsedMs: 1,
      }));
      const saved = { ocr: process.env.FILE_SEARCH_OCR, vision: process.env.FILE_SEARCH_VISION };
      process.env.FILE_SEARCH_OCR = 'off';
      process.env.FILE_SEARCH_VISION = 'auto';
      const originalEmit = usageEmitter.emit;
      const tap = new VisionUsageTap();
      tap.install(usageEmitter);
      try {
        const config = { description: 'vision', fileSearch: {}, vision: { mode: 'no_text' as const, model: 'fake-vision-model' } };
        const settings = pipelineSettings('manifest-sha', config);
        expect(settings.chunking).toMatchObject({ type: 'static', vision: 'no_text' });
        const row = { inputPer1kTokens: 0.0005, cacheWritePer1kTokens: 0.0005, cachedReadPer1kTokens: 0.0005, outputPer1kTokens: 0.003 };
        const meter = new CostMeter(5, PRICES, {}, { 'fake-vision-model': row });
        const logs: string[] = [];
        const summary = await ensureStore({ corpusDir: path.join(EVAL_DIR, 'corpus'), manifest: office, settings, meter,
          embeddingUsd: (t: number) => meter.embeddingUsd(t),
          visionEstimateUsd: (e) => meter.visionUsd(e.model, e.input, 0, e.outputUpperBound),
          takeVision: () => tap.take(), log: (m) => logs.push(m) });
        expect(summary).toMatchObject({ completed: 3, failed: [], pending: 0, ingestedThisRun: 3, stopReason: null });
        const pages = summary.parsing!.visionPages;
        expect(pages).toBeGreaterThanOrEqual(2);
        expect(summary.parsing).toEqual({ ocrPages: 0, ocrSkippedPages: 0, visionPages: pages, visionSkippedPages: 0 });
        const imageCalls = completeMock.mock.calls.filter(([call]: any[]) => call.messages?.some((m: any) => m.images?.length)).length;
        expect(imageCalls).toBe(pages);
        expect(meter.snapshot().vision).toEqual({ 'fake-vision-model': {
          inputTokens: pages * VISION_USAGE.input, cachedTokens: 0, outputTokens: pages * VISION_USAGE.output } });
        expect(logs).toContainEqual(expect.stringMatching(/^processed scanned\/user-chapter-1-introduction\.pdf \(\d\), OCR 0 page\(s\), vision \d+ page\(s\) in \d+ call\(s\)/));

        const { rows } = await pool.query(
          `SELECT f.filename, min(c.page_start) AS first, max(c.page_end) AS last, count(*)::int AS chunks
             FROM vector_store_chunks c JOIN fs_files f ON f.id = c.file_id WHERE c.store_id = $1 GROUP BY f.filename`, [summary.storeId]);
        const by = Object.fromEntries(rows.map((r: any) => [r.filename, r]));
        expect(by['scanned/user-chapter-1-introduction.pdf']).toMatchObject({ first: 1, last: pages });
        expect(by['pptx/quillmere-operations-review.pptx'].first).toBe(1);
        expect(by['pptx/quillmere-operations-review.pptx'].last).toBeGreaterThanOrEqual(11);
        expect(by['xlsx/quillmere-maintenance-ledger.xlsx']).toMatchObject({ first: null, last: null });
      } finally {
        usageEmitter.emit = originalEmit;
        if (saved.ocr === undefined) delete process.env.FILE_SEARCH_OCR; else process.env.FILE_SEARCH_OCR = saved.ocr;
        if (saved.vision === undefined) delete process.env.FILE_SEARCH_VISION; else process.env.FILE_SEARCH_VISION = saved.vision;
      }
    });
});
