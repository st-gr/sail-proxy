/**
 * file_search retrieval evaluation: ingests ci/file-search-eval/corpus through the gateway's own
 * ingestion path into a pgvector database, runs every question of ci/file-search-eval/questions.json
 * through the real `searchVectorStores` with a named configuration, and writes recall@5/10/20, MRR,
 * nDCG@10, per-kind lines, latency and cost to ci/file-search-eval/results/. See
 * ci/file-search-eval/README.md ("Evaluation runner") for how to run it and read the numbers.
 *
 * Live SAP AI Core calls (embeddings, rerank, contexts, vision, optional judge chat) only; every one
 * is metered against --max-usd. Credentials come from --env and are never printed. --plan prints a
 * configuration's calls and estimated cost and runs nothing; a vision configuration runs only with
 * --allow-vision.
 */
import { options } from './fileSearchEval/bootstrap';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { getPool, runMigration } from '../src/fileSearch/db';
import { searchVectorStores, setRerankInput } from '../src/fileSearch/search';
import { setLexicalRankFunction } from '../src/fileSearch/repository';
import { estimateTokens } from '../src/fileSearch/chunker';
import { countTokens } from '../src/fileSearch/structureChunker';
import { EMBED_TOKEN_ESTIMATE_FACTOR } from '../src/fileSearch/embedder';
import { getFileSearchConfig } from '../src/services/configService';
import usageEmitter from '../src/services/usageEventEmitter';
import { getOcrStatus } from '../src/fileSearch/extractors/ocrAvailability';
import { defaultVisionDeps } from '../src/fileSearch/visionTranscriber';
import { evaluateOutcomes } from '../src/fileSearch/eval/metrics';
import { BudgetExceededError, CostMeter, PRICES, pricesForJudge } from './fileSearchEval/costMeter';
import { prepareDatabase, withDatabase } from './fileSearchEval/database';
import { EvalQuestion, evaluateQuestions, EvaluationRun, RESULTS_PER_QUERY, safeError } from './fileSearchEval/evaluate';
import { EVAL_OWNER, ensureStore, ManifestEntry, PipelineSettings, pipelineSettings, StoreSummary } from './fileSearchEval/ingest';
import { chatEstimateUsd, JudgeRun, MAX_CONTEXT_CHARS, pickJudgeSample, runJudge } from './fileSearchEval/judge';
import { CONFIGS } from './fileSearchEval/options';
import { VisionUsageTap } from './fileSearchEval/parsing';
import { formatPlan, planRun } from './fileSearchEval/plan';
import { compareResults, ResultsFile, returnedTokenSummary, writeResults } from './fileSearchEval/report';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalise } = require('../../../ci/file-search-eval/normalise') as { normalise: (t: string) => string };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSapClient } = require('../../../ci/file-search-eval/sap-client') as {
  createSapClient: (env: Record<string, string>, model: string, o: { http: unknown; maxRequests: number }) =>
    { complete: (p: { system: string; user: string }) => Promise<{ text: string; usage?: any }> };
};

const EVAL_DIR = path.resolve(__dirname, '../../../ci/file-search-eval');
/** Cohere bills a search unit per 100 documents; 50 candidates of up to 800 tokens can count as two. */
const RERANK_UNITS_PER_QUERY = 2;
/** Characters per token the judge allows a parent section: generous, so a section is not cut. */
const PARENT_CHARS_PER_TOKEN = 6;

const log = (m: string) => console.log(`[file-search-eval] ${m}`);
const sha256File = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function run(): Promise<number> {
  const config = CONFIGS[options.config];
  setLexicalRankFunction(config.lexicalRank ?? 'ts_rank');
  // The runner pins the reranker input (text unless the configuration names another), so every
  // configuration reproduces what it measured whatever hybrid.rerank.input ships as.
  setRerankInput(config.rerankInput ?? 'text');
  const startedAt = new Date();
  // Every model the run may pay for has a price row, or the run stops here, before any call.
  const meter = new CostMeter(options.maxUsd, options.judge > 0 ? pricesForJudge(options.judgeModel) : PRICES);
  if (config.contextual) meter.contextPrices(config.contextual.model);
  if (config.vision) meter.visionPrices(config.vision.model);
  // A configuration that reads scans or page images refuses to start where it could not: it would
  // measure the text layer alone under its name.
  if (config.ocr) {
    const ocr = await getOcrStatus();
    if (!ocr.enabled) throw new Error(`--config ${options.config} needs OCR, which is off here (${ocr.reason}); install tesseract with eng`);
  }
  if (config.vision) {
    const unavailable = defaultVisionDeps.unavailable();
    if (unavailable) throw new Error(`--config ${options.config} needs vision transcription, which is unavailable here (${unavailable})`);
  }
  const tap = config.vision ? new VisionUsageTap() : null;
  tap?.install(usageEmitter);
  const manifestFile = path.join(EVAL_DIR, 'corpus', 'manifest.json');
  const questionsFile = path.join(EVAL_DIR, 'questions.json');
  const manifestSha = sha256File(manifestFile);
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const questionSet = JSON.parse(fs.readFileSync(questionsFile, 'utf8'));
  if (questionSet.corpusManifestSha256 !== manifestSha) log('WARNING: questions.json was written against another corpus');
  const questions: EvalQuestion[] = questionSet.questions.slice(0, options.limit ?? undefined);

  const stopReasons: string[] = [];
  const { settings, store, evaluation, judge } = await withDatabase({ dsn: options.dsn, keepDb: options.keepDb, log }, async (baseDsn) => {
    let settings: PipelineSettings | null = null;
    let store: StoreSummary | null = null;
    let evaluation: EvaluationRun | null = null;
    let judge: JudgeRun | null = null;
    try {
      process.env.FILE_SEARCH_DATABASE_URL = await prepareDatabase(baseDsn);
      if (!(await runMigration())) throw new Error('the file_search schema migration did not complete');
      settings = pipelineSettings(manifestSha, config);
      log(`config ${options.config} (${config.description}); store key ${settings.key.slice(0, 16)}`);

      try {
        store = await ensureStore({
          corpusDir: path.join(EVAL_DIR, 'corpus'), manifest, settings: settings!, chunking: config.chunking, meter, log,
          embeddingUsd: (t) => meter.embeddingUsd(t),
          contextEstimateUsd: (model, estimate) => meter.contextEstimateUsd(model, estimate),
          visionEstimateUsd: (e) => meter.visionUsd(e.model, e.input, 0, e.outputUpperBound),
          takeVision: tap ? () => tap.take() : undefined,
        });
        log(`store: ${store.completed}/${store.files} files completed, ${store.chunks} chunks, `
          + `${store.reused ? 'reused' : `${store.ingestedThisRun} ingested this run`}`);
        if (store.context) {
          log(`context: ${store.context.inputTokens} input, ${store.context.cachedTokens} cached `
            + `(${(store.context.cacheReadShare * 100).toFixed(1)}% of the prompt), ${store.context.outputTokens} output, `
            + `${store.context.failedChunks} chunk(s) without context`);
        }
        if (store.parsing && (config.ocr || config.vision)) {
          log(`parsing: OCR ${store.parsing.ocrPages} page(s) read, ${store.parsing.ocrSkippedPages} skipped; `
            + `vision ${store.parsing.visionPages} page(s) transcribed, ${store.parsing.visionSkippedPages} skipped`);
        }
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        stopReasons.push(`ingestion: ${error.message}`);
      }

      if (store?.stopReason) stopReasons.push(`ingestion: ${store.stopReason}`);
      if (store?.failed.length) {
        stopReasons.push(`ingestion: ${store.failed.length} files failed (${store.failed.map((f) => `${f.file}: ${f.error}`).join(', ')})`);
      }
      if (store?.pending) {
        stopReasons.push(`ingestion: ${store.pending} files are still in progress (their embedding failed); run again to resume`);
      } else if (store && !store.stopReason) {
        const storeId = store.storeId;
        const reranks = getFileSearchConfig().hybrid.rerank.enabled !== false;
        const sample = options.judge > 0 ? pickJudgeSample(questions, options.judge) : [];
        evaluation = await evaluateQuestions(questions, {
          meter, normalise, log, countTokens, keepHitsFor: new Set(sample.map((q) => q.id)),
          estimateUsd: (q) => meter.embeddingUsd(estimateTokens(q.question) * EMBED_TOKEN_ESTIMATE_FACTOR + 16)
            + (reranks ? meter.rerankUsd(RERANK_UNITS_PER_QUERY) : 0),
          search: async (query) => {
            const res = await searchVectorStores({
              storeIds: [storeId], query, ownerEmail: EVAL_OWNER, maxNumResults: RESULTS_PER_QUERY,
              rankingOptions: config.rankingOptions,
              // Parent sections are what the Responses tool returns; every other configuration searches as
              // the REST route does, which returns chunks.
              surface: config.parentSections ? 'tool' : 'api',
              usage: (u) => (u.endpoint === 'file_search/rerank' ? meter.addRerank(u.inputTokens) : meter.addEmbedding(u.inputTokens)),
            });
            return { mode: res.mode, hits: res.data.map((h) => ({ filename: h.filename, text: h.content.map((c) => c.text).join('\n') })) };
          },
        });
        if (evaluation.stopReason) stopReasons.push(`search: ${evaluation.stopReason}`);

        if (sample.length && !evaluation.complete) stopReasons.push('judge: skipped, retrieval stopped early');
        if (sample.length && evaluation.complete) {
          const client = createSapClient(dotenv.parse(fs.readFileSync(options.env!)) as Record<string, string>,
            options.judgeModel, { http: axios, maxRequests: 4 * sample.length + 4 });
          judge = await runJudge(sample, {
            chat: (p) => client.complete(p), meter, model: options.judgeModel, hits: evaluation.hits, log,
            estimateUsd: (p) => chatEstimateUsd(meter, p),
            maxContextChars: config.parentSections
              ? Math.max(MAX_CONTEXT_CHARS, config.parentSections.maxTokens * PARENT_CHARS_PER_TOKEN) : MAX_CONTEXT_CHARS,
          });
          if (judge.stopReason) stopReasons.push(`judge: ${judge.stopReason}`);
        }
      }
    } finally {
      await getPool()?.end().catch(() => {});
    }
    return { settings, store, evaluation, judge };
  });

  const evaluated = evaluation?.outcomes.length ?? 0;
  const failed = evaluation?.records.filter((r) => r.error).length ?? 0;
  const results: ResultsFile = {
    version: 1,
    complete: evaluation !== null && stopReasons.length === 0 && failed === 0,
    stopReasons,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config: { name: options.config, ...config },
    pipeline: settings ? { ...settings } : {},
    corpusManifestSha256: manifestSha,
    questions: {
      sha256: sha256File(questionsFile), corpusManifestSha256: questionSet.corpusManifestSha256,
      total: questions.length, evaluated, failed,
    },
    store: store ? { ...store } : {},
    modes: evaluation?.modes ?? {},
    cost: meter.snapshot(),
    metrics: evaluation && evaluated ? evaluateOutcomes(evaluation.outcomes) : null,
    relevance: config.parentSections ? 'parent' : 'chunk',
    returnedTokens: evaluation ? returnedTokenSummary(evaluation.records) : null,
    judge,
    perQuestion: evaluation?.records ?? [],
  };
  const file = writeResults(path.join(EVAL_DIR, 'results'), results);
  const m = results.metrics?.overall;
  if (m) {
    log(`recall@5 ${m.recall['5'].toFixed(3)}  recall@10 ${m.recall['10'].toFixed(3)}  recall@20 ${m.recall['20'].toFixed(3)}`
      + `  MRR ${m.mrr.toFixed(3)}  nDCG@10 ${m.ndcg10.toFixed(3)}`);
  }
  log(`${results.complete ? 'complete' : 'INCOMPLETE'}; $${results.cost.spentUsd.toFixed(4)} spent; wrote ${path.relative(process.cwd(), file)}`);
  return results.complete ? 0 : 1;
}

async function plan(): Promise<number> {
  const config = CONFIGS[options.config];
  const manifestFile = path.join(EVAL_DIR, 'corpus', 'manifest.json');
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const questions = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'questions.json'), 'utf8')).questions
    .slice(0, options.limit ?? undefined);
  const meter = new CostMeter(options.maxUsd);
  const p = await planRun({
    name: options.config, config, settings: pipelineSettings(sha256File(manifestFile), config), meter,
    corpusDir: path.join(EVAL_DIR, 'corpus'), manifest, questions,
  });
  console.log(formatPlan(p));
  if (options.judge > 0) console.log(`--judge ${options.judge} adds 2 chat calls per judged question (not in the table; README "Cost").`);
  if (config.vision) console.log('run it with --allow-vision');
  if (p.totalUpperUsd > options.maxUsd) console.log(`the upper bound passes --max-usd ${options.maxUsd}: the run would stop early`);
  return 0;
}

function compare(): number {
  const [a, b] = options.compare!.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as ResultsFile);
  console.log(compareResults(a, b));
  return 0;
}

(options.compare ? Promise.resolve(compare()) : options.plan ? plan() : run())
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[file-search-eval] failed: ${safeError(error)}`);
    process.exit(1);
  });
