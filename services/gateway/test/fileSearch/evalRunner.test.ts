import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  BudgetExceededError, CONTEXT_PRICES, CostMeter, CostSnapshot, JUDGE_PRICES, Meter, PRICES, pricesForJudge, UnpricedModelError,
  VISION_PRICES,
} from '../../scripts/fileSearchEval/costMeter';
import { fileVisionEstimate, visionPagesOf, VisionUsageTap } from '../../scripts/fileSearchEval/parsing';
import { VISION_DEFAULTS } from '../../src/fileSearch/visionTranscriber';
import { EvalQuestion, evaluateQuestions, MAX_CONSECUTIVE_ERRORS, SearchAnswer } from '../../scripts/fileSearchEval/evaluate';
import { answerPrompt, MAX_CONTEXT_CHARS, parseJudgeScores, pickJudgeSample, runJudge } from '../../scripts/fileSearchEval/judge';
import { CONFIGS, CONTEXT_MODELS, EvalConfig, parseArgs, VISION_MODEL } from '../../scripts/fileSearchEval/options';
import { apiConfigFor, prepareEnvironment } from '../../scripts/fileSearchEval/environment';
import { withDatabase } from '../../scripts/fileSearchEval/database';
import { compareResults, resultsFileName, ResultsFile, returnedTokenSummary } from '../../scripts/fileSearchEval/report';
import {
  changedKeyParts, CONTEXT_TOKENIZER_MARGIN, estimateFileContext, FileResult, INGESTION_SOURCES, INGESTION_VERSION, ingestFiles,
  ingestionFingerprint, ManifestEntry, pipelineSettings, storeKey, StoreKeyParts,
} from '../../scripts/fileSearchEval/ingest';
import { evaluateOutcomes } from '../../src/fileSearch/eval/metrics';
import { estimateContextTokens } from '../../src/fileSearch/contextWriter';
import { chunkStructured, countTokens } from '../../src/fileSearch/structureChunker';
import type { FileSearchConfig } from '../../src/services/configService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalise } = require('../../../../ci/file-search-eval/normalise');

/** A meter whose ensure() refuses from the `refuseAt`-th call on, like a ceiling being reached. */
class FakeMeter implements Meter {
  ensureCalls = 0;
  embedding = 0;
  chat: Array<[number, number]> = [];
  constructor(private readonly refuseAt = Infinity) {}
  ensure(estimateUsd: number): void {
    this.ensureCalls += 1;
    if (this.ensureCalls >= this.refuseAt) throw new BudgetExceededError(4.99, estimateUsd, 5);
  }
  addEmbedding(tokens: number): void { this.embedding += tokens; }
  addRerank(): void {}
  addChat(i: number, o: number): void { this.chat.push([i, o]); }
  addContext(): void {}
  snapshot(): CostSnapshot {
    return { maxUsd: 5, spentUsd: 0, embeddingTokens: this.embedding, rerankSearchUnits: 0, chatInputTokens: 0,
      chatOutputTokens: 0, prices: PRICES };
  }
}

function question(id: string, extra: Partial<EvalQuestion> = {}): EvalQuestion {
  return { id, question: `question ${id}`, file: 'markdown/a.md', kind: 'markdown', quotes: [`answer of ${id}`], ...extra };
}

/** Puts the question's quote at `rank` (1-based) of 20 results from markdown/a.md. */
function searchAt(rank: number, filename = 'markdown/a.md') {
  return jest.fn(async (query: string): Promise<SearchAnswer> => {
    const id = query.replace('question ', '');
    return {
      mode: 'reranked',
      hits: Array.from({ length: 20 }, (_, i) => ({ filename, text: i + 1 === rank ? `... answer of ${id} ...` : 'filler' })),
    };
  });
}

describe('file_search eval: cost meter', () => {
  it('prices usage and refuses a step that could pass the ceiling', () => {
    const meter = new CostMeter(0.01, { embeddingPer1kTokens: 0.001, rerankPerSearchUnit: 0.002,
      chatInputPer1kTokens: 0.003, chatOutputPer1kTokens: 0.004 });
    meter.addEmbedding(2000);
    meter.addRerank(1);
    meter.addChat(1000, 250);
    meter.addEmbedding(-5);
    expect(meter.spentUsd).toBeCloseTo(0.002 + 0.002 + 0.003 + 0.001, 10);
    expect(() => meter.ensure(0.002)).not.toThrow();
    expect(() => meter.ensure(0.0021)).toThrow(BudgetExceededError);
    expect(meter.snapshot()).toMatchObject({ embeddingTokens: 2000, rerankSearchUnits: 1, chatInputTokens: 1000, chatOutputTokens: 250 });
  });
});

describe('file_search eval: question loop', () => {
  const opts = (meter: Meter, search: (q: string) => Promise<SearchAnswer>, keep?: Set<string>) =>
    ({ meter, search, normalise, estimateUsd: () => 0.01, keepHitsFor: keep });

  it('stops before the question the meter refuses and returns the partial run marked incomplete', async () => {
    const meter = new FakeMeter(3);
    const search = searchAt(1);
    const run = await evaluateQuestions(['q001', 'q002', 'q003', 'q004'].map((id) => question(id)), opts(meter, search));
    expect(search).toHaveBeenCalledTimes(2);
    expect(run.complete).toBe(false);
    expect(run.stopReason).toMatch(/spending ceiling reached.*before question 3 of 4/);
    expect(run.outcomes.map((o) => o.id)).toEqual(['q001', 'q002']);
    expect(evaluateOutcomes(run.outcomes).overall.recall['5']).toBe(1);
  });

  it('records the rank of the answer and keeps hits only for the judge sample', async () => {
    const run = await evaluateQuestions([question('q001'), question('q002')], opts(new FakeMeter(), searchAt(7), new Set(['q002'])));
    expect(run.complete).toBe(true);
    expect(run.records[0]).toMatchObject({ id: 'q001', mode: 'reranked', returned: 20, matches: [{ rank: 7, exact: [0], fragment: [] }] });
    expect(run.modes).toEqual({ reranked: 2 });
    expect([...run.hits.keys()]).toEqual(['q002']);
  });

  it('ignores a chunk from another file, and accepts either file of a two-file multihop question', async () => {
    const other = await evaluateQuestions([question('q001')], opts(new FakeMeter(), searchAt(1, 'pdf/b.pdf')));
    expect(other.outcomes[0].matches).toEqual([]);
    const twoFiles = await evaluateQuestions([question('q001', { kind: 'multihop', files: ['markdown/a.md', 'pdf/b.pdf'] })],
      opts(new FakeMeter(), searchAt(1, 'pdf/b.pdf')));
    expect(twoFiles.outcomes[0].matches).toHaveLength(1);
  });

  it('skips a failing question, and stops after repeated failures', async () => {
    let calls = 0;
    const flaky = jest.fn(async (q: string) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Request failed with status code 500\nmore'), { name: 'AxiosError' });
      return searchAt(1)(q);
    });
    const once = await evaluateQuestions([question('q001'), question('q002')], opts(new FakeMeter(), flaky));
    expect(once.complete).toBe(true);
    expect(once.records[0]).toEqual({ id: 'q001', kind: 'markdown', error: 'AxiosError: Request failed with status code 500' });
    expect(once.outcomes.map((o) => o.id)).toEqual(['q002']);

    const down = jest.fn(async () => { throw new Error('down'); });
    const ids = Array.from({ length: 6 }, (_, i) => question(`q00${i}`));
    const stopped = await evaluateQuestions(ids, opts(new FakeMeter(), down));
    expect(down).toHaveBeenCalledTimes(MAX_CONSECUTIVE_ERRORS);
    expect(stopped.complete).toBe(false);
    expect(stopped.stopReason).toMatch(/consecutive searches failed/);
  });
});

describe('file_search eval: judge', () => {
  it('parses both scores from a reply and rejects anything else', () => {
    expect(parseJudgeScores('Sure: {"faithfulness": 4, "correctness": 5}')).toEqual({ faithfulness: 4, correctness: 5 });
    expect(parseJudgeScores('{"faithfulness": 6, "correctness": 5}')).toBeNull();
    expect(parseJudgeScores('{"faithfulness": 4}')).toBeNull();
    expect(parseJudgeScores('no json')).toBeNull();
  });

  it('samples the same questions every time, independent of input order', () => {
    const qs = Array.from({ length: 30 }, (_, i) => ({ id: `q${String(i).padStart(3, '0')}` }));
    const a = pickJudgeSample(qs, 5).map((q) => q.id);
    expect(pickJudgeSample([...qs].reverse(), 5).map((q) => q.id)).toEqual(a);
    expect(new Set(a).size).toBe(5);
  });

  it('meters both calls and stops at the ceiling with the scores so far', async () => {
    const meter = new FakeMeter(4); // calls 1-3 allowed: q1 answer + judge, q2 answer; q2 judge refused
    const chat = jest.fn(async ({ system }: { system: string }) => (system.startsWith('You grade')
      ? { text: '{"faithfulness": 5, "correctness": 3}', usage: { prompt_tokens: 100, completion_tokens: 10 } }
      : { text: 'an answer' }));
    const hits = new Map([['q1', [{ filename: 'markdown/a.md', text: 'ctx' }]], ['q2', [{ filename: 'markdown/a.md', text: 'ctx' }]]]);
    const run = await runJudge([question('q1'), question('q2')], { chat, meter, model: 'm', hits, estimateUsd: () => 0.01 });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(run.complete).toBe(false);
    expect(run.stopReason).toMatch(/BudgetExceededError/);
    expect(run.items).toEqual([{ id: 'q1', kind: 'markdown', scores: { faithfulness: 5, correctness: 3 } }]);
    expect(run.mean).toEqual({ faithfulness: 5, correctness: 3 });
    expect(meter.chat[1]).toEqual([100, 10]);
  });
});

describe('file_search eval: options and environment', () => {
  it('parses a run and a compare, and rejects bad input', () => {
    expect(parseArgs(['--env', 'x.env'])).toMatchObject({ config: 'baseline', maxUsd: 5, judge: 0, keepDb: false, dsn: null });
    expect(parseArgs(['--env', 'e', '--config', 'no-rerank', '--max-usd', '1.5', '--judge', '10', '--keep-db', '--limit', '3']))
      .toMatchObject({ config: 'no-rerank', maxUsd: 1.5, judge: 10, keepDb: true, limit: 3 });
    expect(parseArgs(['--compare', 'a.json', 'b.json']).compare).toEqual(['a.json', 'b.json']);
    for (const bad of [[], ['--env', 'e', '--config', 'nope'], ['--env', 'e', '--max-usd', '0'], ['--env', 'e', '--judge', '-1'],
      ['--env'], ['--compare', 'a.json'], ['--bogus']]) {
      expect(() => parseArgs(bad)).toThrow();
    }
  });

  it('ships the four named configurations with their search options', () => {
    expect(CONFIGS['text-heavy'].rankingOptions).toEqual({ hybridWeights: { embedding: 0.5, text: 1 } });
    expect(CONFIGS['embedding-heavy'].rankingOptions).toEqual({ hybridWeights: { embedding: 1, text: 0.5 } });
    expect(CONFIGS['no-rerank'].fileSearch).toEqual({ hybrid: { rerank: { enabled: false } } });
    expect(CONFIGS.baseline).toEqual({ description: 'static chunking 800/400, otherwise the shipped search defaults', fileSearch: {} });
  });

  it('ships the full-text comparison points: all words, and ts_rank_cd', () => {
    expect(CONFIGS['lexical-all'].fileSearch).toEqual({ hybrid: { lexical_query: 'all' } });
    expect(CONFIGS['lexical-all'].lexicalRank).toBeUndefined();
    expect(CONFIGS['ts-rank-cd'].fileSearch).toEqual({});
    expect(CONFIGS['ts-rank-cd'].lexicalRank).toBe('ts_rank_cd');
    expect(parseArgs(['--env', 'e', '--config', 'ts-rank-cd']).config).toBe('ts-rank-cd');
  });

  it('ships the large-search points (W4) with thresholds the ~100-chunk corpus store exceeds', () => {
    // The W1 store is far below the shipped 20,000: lowered thresholds put its searches on the bounded
    // full-text arm, and with `ann` also on the index (store key unchanged: both are search only).
    expect(CONFIGS['bounded-lexical'].fileSearch).toEqual({ ann: { enabled: false, exact_max_chunks: 10, min_fraction: 0.01 } });
    expect(CONFIGS.ann.fileSearch).toEqual({ ann: { enabled: true, exact_max_chunks: 10, min_fraction: 0.01 } });
    for (const name of ['bounded-lexical', 'ann']) {
      expect(CONFIGS[name].storeChunking).toBeUndefined();
      expect(CONFIGS[name].contextual).toBeUndefined();
    }
  });

  it('takes only SAP credentials from the env file and points the gateway at a generated config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fseval-test-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'CLIENT_ID=id\nCLIENT_SECRET=secret\nAUTH_URL=https://auth.example\n'
      + 'SAP_AI_RESOURCE_GROUP=rg\nVALKEY_URL=redis://live:6379\nFILE_SEARCH_DATABASE_URL=postgresql://live/db\n');
    const env: NodeJS.ProcessEnv = { ADMIN_SERVICE_URL: 'http://live:4004', POSTGRES_URL: 'postgresql://live' };
    const { configFile } = prepareEnvironment({ env: envFile, verbose: false }, CONFIGS['no-rerank'], env, dir);
    expect(env).toMatchObject({ CLIENT_ID: 'id', CLIENT_SECRET: 'secret', AUTH_URL: 'https://auth.example',
      SAP_AI_RESOURCE_GROUP: 'rg', GATEWAY_STANDALONE: 'true', LOG_LEVEL: 'warn', CONFIG_FILE_PATH: configFile });
    for (const key of ['VALKEY_URL', 'FILE_SEARCH_DATABASE_URL', 'ADMIN_SERVICE_URL', 'POSTGRES_URL']) expect(env[key]).toBe('');
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')))
      .toEqual({ api_config: { capabilities: { file_search: { hybrid: { rerank: { enabled: false } } } } } });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('file_search eval: environment against a later dotenv.config()', () => {
  // modelService and sapAIService call dotenv.config() at load: from a cwd with a .env it would fill
  // every key the runner deleted. Blank keys exist, so dotenv leaves them alone.
  const KEYS = ['VALKEY_URL', 'ADMIN_SERVICE_URL', 'FILE_SEARCH_DATABASE_URL', 'FILE_SEARCH_MIGRATION_DATABASE_URL', 'POSTGRES_URL'];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fseval-dotenv-'));
    for (const k of [...KEYS, 'CONFIG_FILE_PATH', 'UNIFIED_TOKEN_SYSTEM_ENABLED', 'GATEWAY_STANDALONE', 'DISABLE_FILE_LOGGING', 'LOG_LEVEL']) {
      saved[k] = process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the cleared keys blank when a .env is loaded afterwards', () => {
    prepareEnvironment({ env: null, verbose: false }, CONFIGS.baseline, process.env, dir);
    const cwdEnv = path.join(dir, 'cwd.env');
    fs.writeFileSync(cwdEnv, KEYS.map((k) => `${k}=live-${k}`).join('\n'));
    dotenv.config({ path: cwdEnv });
    for (const k of KEYS) expect(process.env[k]).toBe('');
  });
});

describe('file_search eval: results', () => {
  function results(name: string, recall5: number, extra: Partial<ResultsFile> = {}): ResultsFile {
    const s = { questions: 2, recall: { 5: recall5, 10: 1, 20: 1 }, mrr: 0.5, ndcg10: 0.6 };
    return {
      version: 1, complete: true, stopReasons: [], startedAt: '', finishedAt: '', config: { name, ...CONFIGS[name] },
      pipeline: { key: 'k' }, corpusManifestSha256: 'c', store: {}, modes: {}, judge: null, perQuestion: [],
      questions: { sha256: 'q', corpusManifestSha256: 'c', total: 2, evaluated: 2, failed: 0 },
      cost: { maxUsd: 5, spentUsd: 0.5, embeddingTokens: 0, rerankSearchUnits: 0, chatInputTokens: 0, chatOutputTokens: 0, prices: PRICES },
      metrics: { overall: s, byKind: { pdf: s }, multihopAnyQuote: null, latencyMs: { p50: 100, p95: 300 }, fragmentRuleHits: 1 },
      ...extra,
    };
  }

  it('names the file by UTC timestamp and config', () => {
    expect(resultsFileName(new Date('2026-10-08T09:15:02.123Z'), 'text-heavy')).toBe('2026-10-08T09-15-02Z-text-heavy.json');
  });

  it('prints every metric with the change B - A, per kind, and warns about incomparable runs', () => {
    const out = compareResults(results('baseline', 0.5), results('text-heavy', 0.75));
    expect(out).toMatch(/overall recall@5\s+0\.500\s+0\.750\s+\+0\.250/);
    expect(out).toMatch(/pdf recall@5\s+0\.500\s+0\.750\s+\+0\.250/);
    expect(out).toMatch(/latency p95 ms\s+300\s+300\s+\+0/);
    expect(out).not.toMatch(/WARNING/);
    const warned = compareResults(results('baseline', 0.5),
      results('no-rerank', 0.5, { complete: false, stopReasons: ['search: ceiling'], corpusManifestSha256: 'other' }));
    expect(warned).toMatch(/WARNING: the runs used different corpora/);
    expect(warned).toMatch(/WARNING: B is incomplete: search: ceiling/);
  });

  it('warns when one run counts parent sections as hits, and prints the returned volume and context tokens', () => {
    const chunkRun = results('structure', 0.5, { relevance: 'chunk', returnedTokens: { questions: 2, meanTop5: 2000, meanAll: 8000 },
      store: { chunks: 160, context: null } });
    const parentRun = results('parent', 0.75, { relevance: 'parent', returnedTokens: { questions: 2, meanTop5: 6000, meanAll: 20000 },
      store: { chunks: 160, context: { inputTokens: 900, cachedTokens: 100 } } });
    const out = compareResults(chunkRun, parentRun);
    expect(out).toMatch(/WARNING: A counts a chunk as a hit, B a parent/);
    expect(out).toMatch(/returned tokens top 5 \(mean\)\s+2000\s+6000\s+\+4000/);
    expect(out).toMatch(/store chunks\s+160\s+160\s+\+0/);
    expect(out).toMatch(/context prompt tokens\s+-\s+1000\s+-/);
    expect(compareResults(results('baseline', 0.5), results('structure', 0.5, { relevance: 'chunk' }))).not.toMatch(/WARNING/);
  });
});

describe('file_search eval: database lifecycle', () => {
  const ops = (start: () => Promise<string>, remove: () => void = jest.fn()) => ({ start: jest.fn(start), remove: jest.fn(remove) });

  it('removes its own container even when it never became ready, and keeps the original error', async () => {
    const o = ops(async () => { throw new Error('fseval-pg did not accept connections within 60 s'); });
    await expect(withDatabase({ dsn: null, keepDb: false, log: () => {} }, async () => 'unused', o))
      .rejects.toThrow(/did not accept connections/);
    expect(o.remove).toHaveBeenCalledTimes(1);
  });

  it('does not let a failed removal mask the run\'s own error or result', async () => {
    const logs: string[] = [];
    const failing = ops(async () => 'dsn', () => { throw new Error('docker gone'); });
    await expect(withDatabase({ dsn: null, keepDb: false, log: (m) => logs.push(m) }, async () => { throw new Error('run failed'); }, failing))
      .rejects.toThrow('run failed');
    await expect(withDatabase({ dsn: null, keepDb: false, log: (m) => logs.push(m) }, async (dsn) => `ok ${dsn}`, failing))
      .resolves.toBe('ok dsn');
    expect(logs.filter((l) => /could not remove fseval-pg: Error: docker gone/.test(l))).toHaveLength(2);
  });

  it('leaves the container with --keep-db, and never starts or removes one for --dsn', async () => {
    const kept = ops(async () => 'dsn');
    await withDatabase({ dsn: null, keepDb: true, log: () => {} }, async () => 0, kept);
    expect(kept.remove).not.toHaveBeenCalled();
    const given = ops(async () => 'dsn');
    await expect(withDatabase({ dsn: 'postgresql://given', keepDb: false, log: () => {} }, async (d) => d, given)).resolves.toBe('postgresql://given');
    expect(given.start).not.toHaveBeenCalled();
    expect(given.remove).not.toHaveBeenCalled();
  });
});

describe('file_search eval: store key', () => {
  function sourceTree(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fseval-src-'));
    fs.mkdirSync(path.join(dir, 'extractors', 'ooxml'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'extractors', 'registry.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(dir, 'extractors', 'ooxml', 'xlsx.ts'), 'export const x = 1;');
    for (const f of INGESTION_SOURCES.filter((s) => s.endsWith('.ts'))) fs.writeFileSync(path.join(dir, f), `// ${f}`);
    return dir;
  }
  const parts = (ingestion: string): StoreKeyParts => ({ manifest: 'm', embedding: 'model/1024', chunking: '{}', contextual: 'off', ingestion, parsing: '{}' });

  it('a changed ingestion fingerprint yields a different store key', () => {
    const dir = sourceTree();
    try {
      const before = ingestionFingerprint(dir);
      expect(ingestionFingerprint(dir)).toBe(before);
      fs.writeFileSync(path.join(dir, 'chunker.ts'), '// chunker.ts, changed');
      const chunkerChanged = ingestionFingerprint(dir);
      fs.writeFileSync(path.join(dir, 'extractors', 'pptx.ts'), 'export const b = 2;');
      const extractorAdded = ingestionFingerprint(dir);
      const bumped = ingestionFingerprint(dir, INGESTION_VERSION + 1);
      fs.writeFileSync(path.join(dir, 'contextWriter.ts'), '// contextWriter.ts, changed');
      const contextWriterChanged = ingestionFingerprint(dir);
      fs.writeFileSync(path.join(dir, 'extractors', 'ooxml', 'xlsx.ts'), 'export const x = 2;');
      const readerChanged = ingestionFingerprint(dir);
      const fingerprints = [before, chunkerChanged, extractorAdded, bumped, contextWriterChanged, readerChanged];
      expect(new Set(fingerprints).size).toBe(6);
      expect(new Set(fingerprints.map((f) => storeKey(parts(f)))).size).toBe(6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the default fingerprint covers the gateway\'s own ingestion sources, the W2 chunking path included', () => {
    expect(ingestionFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    for (const source of ['extractors', 'extractors/ooxml', 'chunkingSetting.ts', 'chunkPipeline.ts', 'chunkRows.ts', 'structureChunker.ts', 'structureScanner.ts',
      'structureChunkThread.ts', 'structureChunkWorker.ts', 'contextWriter.ts', 'orchestrationCompletion.ts',
      'visionTranscriber.ts', 'pages.ts']) {
      expect(INGESTION_SOURCES).toContain(source);
    }
  });

  it('names the parts that differ from a previous store', () => {
    expect(changedKeyParts({ fseval_parts: parts('a') }, parts('b'))).toEqual(['ingestion']);
    expect(changedKeyParts({ fseval_parts: { ...parts('a'), chunking: 'x' } }, parts('b'))).toEqual(['chunking', 'ingestion']);
    expect(changedKeyParts({ fseval_parts: { ...parts('b'), contextual: '{"model":"x"}' } }, parts('b'))).toEqual(['contextual']);
    expect(changedKeyParts({ fseval_key: 'old' }, parts('b'))).toBeNull();
    expect(changedKeyParts(null, parts('b'))).toBeNull();
  });
});

/** The gateway configuration a run generates: shipped defaults, the configuration's context model. */
function gatewayConfig(model: string = CONTEXT_MODELS.flashLite, contextual: Record<string, unknown> = {}): FileSearchConfig {
  return {
    embeddingModel: 'text-embedding-3-large', embeddingDimensions: 1024,
    chunking: { strategy: 'structure', maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true },
    contextual: {
      model, maxDocumentTokens: 32000, concurrency: 4, requestTimeoutMs: 30000, fileDeadlineMs: 360000,
      maxInputTokensPerFile: 20000000, ...contextual,
    },
  } as unknown as FileSearchConfig;
}
const settingsOf = (config: EvalConfig, fileSearch = gatewayConfig(config.contextual?.model)) =>
  pipelineSettings('manifest-sha', config, fileSearch);

describe('file_search eval: chunking configurations (W2)', () => {
  const W2 = ['structure', 'structure-no-rerank', 'structure-c20', 'contextual', 'contextual-no-rerank', 'contextual-c20',
    'contextual-haiku', 'contextual-rerank-ctx', 'parent'];

  it('ships the configurations of the chunking evaluation with their settings', () => {
    for (const name of W2) expect(parseArgs(['--env', 'e', '--config', name]).config).toBe(name);
    const structure = { type: 'structure', max_tokens: 800, overlap_tokens: 0 };
    for (const name of W2) expect(CONFIGS[name].storeChunking).toEqual(structure);
    expect(CONFIGS.structure.contextual).toBeUndefined();
    expect(CONFIGS.contextual.contextual).toEqual({ model: 'gemini-3.5-flash-lite' });
    expect(CONFIGS['contextual-haiku'].contextual).toEqual({ model: 'anthropic--claude-4.5-haiku' });
    expect(CONFIGS['structure-no-rerank'].fileSearch).toEqual({ hybrid: { rerank: { enabled: false } } });
    expect(CONFIGS['contextual-no-rerank'].fileSearch).toEqual({ hybrid: { rerank: { enabled: false } } });
    expect(CONFIGS['structure-c20'].candidates).toBe(20);
    expect(CONFIGS['contextual-c20'].candidates).toBe(20);
    expect(CONFIGS['contextual-rerank-ctx'].rerankInput).toBe('context_and_text');
    expect(CONFIGS.parent.parentSections).toEqual({ maxTokens: 1500 });
    expect(CONFIGS.baseline.storeChunking).toBeUndefined();
  });

  it('writes the typed fields into the generated file_search section, leaving the shared objects alone', () => {
    const section = (name: string) => (apiConfigFor(CONFIGS[name]) as any).api_config.capabilities.file_search;
    expect(section('baseline')).toEqual({});
    expect(section('structure')).toEqual({});
    expect(section('contextual-c20')).toEqual({ contextual: { model: 'gemini-3.5-flash-lite' }, hybrid: { candidates: 20 } });
    expect(section('contextual-no-rerank')).toEqual({ contextual: { model: 'gemini-3.5-flash-lite' }, hybrid: { rerank: { enabled: false } } });
    expect(section('contextual-haiku')).toEqual({ contextual: { model: 'anthropic--claude-4.5-haiku' } });
    expect(section('parent')).toEqual({ parent_sections: { max_tokens: 1500, scope: 'tool' } });
    const merged = apiConfigFor({ description: '', fileSearch: CONFIGS['structure-no-rerank'].fileSearch, candidates: 20 }) as any;
    expect(merged.api_config.capabilities.file_search).toEqual({ hybrid: { rerank: { enabled: false }, candidates: 20 } });
    expect(CONFIGS['structure-no-rerank'].fileSearch).toEqual({ hybrid: { rerank: { enabled: false } } });
  });
});

describe('file_search eval: the store key separates chunking and contextual settings (review focus 5)', () => {
  it('search-only variants share their store; every ingestion setting has a store of its own', () => {
    const key = (name: string) => settingsOf(CONFIGS[name]).key;
    const groups = [
      ['baseline', 'no-rerank', 'text-heavy', 'lexical-all', 'ts-rank-cd'],
      ['structure', 'structure-no-rerank', 'structure-c20', 'parent'],
      ['contextual', 'contextual-no-rerank', 'contextual-c20', 'contextual-rerank-ctx'],
      ['contextual-haiku'],
    ];
    for (const group of groups) expect(new Set(group.map(key)).size).toBe(1);
    expect(new Set(groups.map((g) => key(g[0]))).size).toBe(groups.length);
  });

  it('changes with the chunking sizes, contextual on or off, the context model and its settings', () => {
    const structure = settingsOf(CONFIGS.structure);
    const contextual = settingsOf(CONFIGS.contextual);
    const haiku = settingsOf(CONFIGS['contextual-haiku']);
    const smaller = settingsOf({ ...CONFIGS.structure, storeChunking: { type: 'structure', max_tokens: 400, overlap_tokens: 0 } });
    const window = settingsOf(CONFIGS.contextual, gatewayConfig(CONTEXT_MODELS.flashLite, { maxDocumentTokens: 16000 }));
    expect(new Set([structure, contextual, haiku, smaller, window].map((s) => s.key)).size).toBe(5);

    expect(structure.parts.contextual).toBe('off');
    expect(JSON.parse(contextual.parts.contextual)).toMatchObject({ model: 'gemini-3.5-flash-lite', maxDocumentTokens: 32000 });
    const recorded = { fseval_parts: structure.parts };
    expect(changedKeyParts(recorded, contextual.parts)).toEqual(['chunking', 'contextual']);
    expect(changedKeyParts({ fseval_parts: contextual.parts }, haiku.parts)).toEqual(['contextual']);
    expect(changedKeyParts({ fseval_parts: contextual.parts }, window.parts)).toEqual(['contextual']);
    expect(changedKeyParts(recorded, smaller.parts)).toEqual(['chunking']);
  });

  it('creates the store with the configuration\'s own setting, and chunks with it', () => {
    // The installation default is structure with contexts; the baseline stays the W1 static store.
    expect(settingsOf(CONFIGS.baseline)).toMatchObject({
      storeChunking: { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false },
      chunking: { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false }, contextual: null,
    });
    const contextual = settingsOf(CONFIGS['contextual-haiku']);
    expect(contextual.storeChunking).toEqual({ type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true });
    expect(contextual.chunking).toEqual(contextual.storeChunking);
    expect(contextual.contextual).toMatchObject({ model: 'anthropic--claude-4.5-haiku' });
  });

  it('a file static strategy wins over the store setting, so it keys the store as static', () => {
    const fileStatic = settingsOf({ ...CONFIGS.contextual, chunking: { type: 'static', static: { max_chunk_size_tokens: 400, chunk_overlap_tokens: 100 } } });
    expect(fileStatic.chunking).toEqual({ type: 'static', max_tokens: 400, overlap_tokens: 100, contextual: false });
    expect(fileStatic.contextual).toBeNull();
    expect(fileStatic.parts.contextual).toBe('off');
  });

  it('refuses a gateway configuration that would write contexts with another model, and contextual without structure', () => {
    expect(() => settingsOf(CONFIGS['contextual-haiku'], gatewayConfig(CONTEXT_MODELS.flashLite)))
      .toThrow(/would write contexts with gemini-3.5-flash-lite, the configuration names anthropic--claude-4.5-haiku/);
    expect(() => settingsOf({ description: '', fileSearch: {}, contextual: { model: CONTEXT_MODELS.flashLite } }))
      .toThrow(/need a structure storeChunking/);
    expect(() => settingsOf({ description: '', fileSearch: {}, storeChunking: { type: 'static', max_tokens: 800, overlap_tokens: 0 },
      contextual: { model: CONTEXT_MODELS.flashLite } })).toThrow();
  });
});

describe('file_search eval: context-model prices', () => {
  const table = { m: { inputPer1kTokens: 0.001, cacheWritePer1kTokens: 0.00125, cachedReadPer1kTokens: 0.0001, outputPer1kTokens: 0.005 } };
  const chat = { embeddingPer1kTokens: 0, rerankPerSearchUnit: 0, chatInputPer1kTokens: 0.0025, chatOutputPer1kTokens: 0.01 };

  it('prices uncached input at the cache-write rate where it is higher, cache reads and output at theirs', () => {
    const meter = new CostMeter(5, chat, table);
    meter.addContext('m', 100_000, 1_000_000, 10_000);
    meter.addContext('m', -5, 0, 0);
    expect(meter.spentUsd).toBeCloseTo(0.125 + 0.1 + 0.05, 10);
    expect(meter.snapshot()).toMatchObject({
      context: { m: { inputTokens: 100_000, cachedTokens: 1_000_000, outputTokens: 10_000 } }, contextPrices: { m: table.m },
    });
    // An estimate is the whole prompt as sent, priced as if nothing were cached.
    expect(meter.contextEstimateUsd('m', { input: 1_000_000, outputUpperBound: 10_000 })).toBeCloseTo(1.25 + 0.05, 10);
  });

  it('refuses a context model without a price row, naming it and where to add one', () => {
    const meter = new CostMeter(5, chat, table);
    for (const call of [() => meter.contextPrices('anthropic--claude-4.5-opus'), () => meter.contextUsd('anthropic--claude-4.5-opus', 1, 0, 0),
      () => meter.contextEstimateUsd('anthropic--claude-4.5-opus', { input: 1, outputUpperBound: 0 })]) {
      expect(call).toThrow(UnpricedModelError);
      expect(call).toThrow(/no price row for the context model anthropic--claude-4\.5-opus: add one to CONTEXT_PRICES in .*costMeter\.ts/);
    }
  });

  it('prices the judge by its own row: gemini-3.5-flash by default, gpt-4.1 selectable, an unpriced one refused', () => {
    expect(parseArgs(['--env', 'e']).judgeModel).toBe('gemini-3.5-flash');
    expect(parseArgs(['--env', 'e', '--judge-model', 'gpt-4.1']).judgeModel).toBe('gpt-4.1');
    expect(pricesForJudge('gemini-3.5-flash')).toEqual({ ...PRICES, ...{ chatInputPer1kTokens: 0.001, chatOutputPer1kTokens: 0.006 } });
    expect(pricesForJudge('gpt-4.1')).toEqual(PRICES);
    expect(new CostMeter(5, pricesForJudge('gemini-3.5-flash')).chatUsd(1000, 1000)).toBeCloseTo(0.007, 10);
    expect(JUDGE_PRICES['gemini-3.5-flash'].inputPer1kTokens).toBeGreaterThanOrEqual(0.0005);
    expect(() => pricesForJudge('o3')).toThrow(/no price row for the judge model o3: add one to JUDGE_PRICES/);
  });

  it('ships a row for both context models of the evaluation', () => {
    for (const model of Object.values(CONTEXT_MODELS)) expect(CONTEXT_PRICES[model]).toBeDefined();
    expect(CONTEXT_PRICES['anthropic--claude-4.5-haiku'].cachedReadPer1kTokens)
      .toBeLessThan(CONTEXT_PRICES['anthropic--claude-4.5-haiku'].inputPer1kTokens);
  });
});

describe('file_search eval: the ingestion ceiling with context costs', () => {
  const entries: ManifestEntry[] = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']
    .map((file) => ({ file, kind: 'markdown', sha256: 'x', bytes: 1000 }));
  const prices = { embeddingPer1kTokens: 0.001, rerankPerSearchUnit: 0, chatInputPer1kTokens: 0.0025, chatOutputPer1kTokens: 0.01 };
  const ctxTable = { ctx: { inputPer1kTokens: 0.001, cacheWritePer1kTokens: 0.001, cachedReadPer1kTokens: 0.0001, outputPer1kTokens: 0.002 } };
  const completed = (inputTokens: number): FileResult => ({
    status: 'completed', chunks: 10, embeddingTokens: 10_000,
    context: { inputTokens, cachedTokens: 0, outputTokens: 0, failedChunks: 0 },
  });

  it('stops before the file whose estimate could pass the ceiling, never exceeds it, and says how far it got', async () => {
    const meter = new CostMeter(3, prices, ctxTable);
    const ingest = jest.fn(async () => completed(890_000)); // $0.01 embedding + $0.89 context = $0.90 a file
    const estimate = jest.fn(async () => ({ usd: 1, context: { input: 1_000_000, outputUpperBound: 0, calls: 10 } }));
    const logs: string[] = [];
    const out = await ingestFiles(entries, { meter, contextModel: 'ctx', estimate, ingest, log: (m) => logs.push(m) });
    expect(ingest).toHaveBeenCalledTimes(3);
    expect(out.ingested).toBe(3);
    expect(meter.spentUsd).toBeCloseTo(2.7, 10);
    expect(meter.spentUsd).toBeLessThanOrEqual(3);
    expect(out.stopReason).toMatch(/spending ceiling reached: \$2\.7000 spent \+ \$1\.0000 estimated would pass --max-usd 3 /);
    expect(out.stopReason).toMatch(/\(before d\.md, file 4 of 5 to ingest; 3 file\(s\) ingested this run, the last c\.md\)$/);
    expect(meter.snapshot().context).toEqual({ ctx: { inputTokens: 2_670_000, cachedTokens: 0, outputTokens: 0 } });
    expect(logs[0]).toMatch(/^processed a\.md \(1\), context 890000 in \/ 0 cached \/ 0 out, 0 chunk\(s\) without context; \$0\.9000 spent$/);
  });

  it('says so when it stops before the first file', async () => {
    const meter = new CostMeter(0.5, prices, ctxTable);
    const ingest = jest.fn(async () => completed(1));
    const out = await ingestFiles(entries, {
      meter, contextModel: 'ctx', ingest, log: () => {}, estimate: async () => ({ usd: 0.6, context: null }),
    });
    expect(ingest).not.toHaveBeenCalled();
    expect(out).toEqual({ ingested: 0, stopReason: expect.stringMatching(/before a\.md, file 1 of 5 to ingest; no file ingested this run\)$/) });
  });

  it('books the context estimate for a file that did not complete: its job holds none of the tokens it spent', async () => {
    const meter = new CostMeter(5, prices, ctxTable);
    const ingest = jest.fn(async (): Promise<FileResult> => ({ ...completed(0), status: 'in_progress', chunks: 0, embeddingTokens: 0 }));
    const logs: string[] = [];
    await ingestFiles(entries.slice(0, 1), {
      meter, contextModel: 'ctx', ingest, log: (m) => logs.push(m),
      estimate: async () => ({ usd: 0.5, context: { input: 400_000, outputUpperBound: 2000, calls: 10 } }),
    });
    expect(meter.snapshot().context).toEqual({ ctx: { inputTokens: 400_000, cachedTokens: 0, outputTokens: 2000 } });
    expect(logs[0]).toMatch(/a\.md did not complete \(in_progress\); its context estimate is booked/);
  });

  it('books no context without a context model, and warns about a file whose job reported no embedding tokens', async () => {
    const meter = new CostMeter(5, prices, ctxTable);
    const logs: string[] = [];
    await ingestFiles(entries.slice(0, 1), {
      meter, contextModel: null, log: (m) => logs.push(m), estimate: async () => ({ usd: 0, context: null }),
      ingest: async () => ({ ...completed(500), embeddingTokens: 0 }),
    });
    expect(meter.snapshot().context).toEqual({});
    expect(logs[0]).toMatch(/^WARNING: a\.md completed with 10 chunks but its job reported 0 embedding tokens/);
  });
});

describe('file_search eval: context estimate per file', () => {
  const EVAL_DIR = path.resolve(__dirname, '../../../../ci/file-search-eval');
  const setting = { type: 'structure' as const, max_tokens: 800, overlap_tokens: 0, contextual: true };

  it('counts the calls ingestion will make from the file\'s own text and chunks', async () => {
    const file = 'markdown/user-chapter-6-opencode.md';
    const bytes = fs.readFileSync(path.join(EVAL_DIR, 'corpus', file));
    const estimate = await estimateFileContext(file, bytes, setting, { maxDocumentTokens: 32000 });
    const text = bytes.toString('utf8');
    const chunks = chunkStructured(text, { maxTokens: 800, overlapTokens: 0, format: 'markdown' }).filter((c) => /\S/.test(c.text));
    expect(estimate.calls).toBe(chunks.length);
    expect(estimate.calls).toBeGreaterThan(1);
    expect(estimate.input).toBeGreaterThan(estimate.calls * countTokens(text) * 0.9);
    // cl100k counts raised by 1.2 for the context models' own tokenizers; output is already their bound.
    const writer = estimateContextTokens(countTokens(text), chunks.length, { maxDocumentTokens: 32000 });
    expect(CONTEXT_TOKENIZER_MARGIN).toBe(1.2);
    expect(estimate).toEqual({ ...writer, input: Math.ceil(writer.input * 1.2) });
  });

  it('falls back to a bytes-based guess when the file cannot be extracted here', async () => {
    const estimate = await estimateFileContext('x.unknown-type', Buffer.alloc(12_000, 'a'), setting, {});
    const writer = estimateContextTokens(4000, 10, {});
    expect(estimate).toEqual({ ...writer, input: Math.ceil(writer.input * 1.2) });
  });
});

describe('file_search eval: returned text volume and parent sections', () => {
  it('records the tokens of the returned texts per question', async () => {
    const run = await evaluateQuestions([question('q001')], {
      meter: new FakeMeter(), normalise, estimateUsd: () => 0, search: searchAt(2), countTokens: (t) => t.length,
    });
    // 'filler' = 6, the hit at rank 2 = '... answer of q001 ...' (22): top 5 = 4 x 6 + 22, all = 19 x 6 + 22.
    expect(run.records[0].returnedTokens).toEqual({ top5: 46, all: 136 });
    expect(returnedTokenSummary(run.records)).toEqual({ questions: 1, meanTop5: 46, meanAll: 136 });
    expect(returnedTokenSummary([{ id: 'q', kind: 'markdown', error: 'x' }])).toBeNull();
  });

  it('gives the judge a parent section uncut when asked to', () => {
    const long = 'x'.repeat(MAX_CONTEXT_CHARS + 500);
    const hits = [{ filename: 'markdown/a.md', text: long }];
    expect(answerPrompt(question('q1'), hits).user).not.toContain(long);
    expect(answerPrompt(question('q1'), hits, 9000).user).toContain(long);
  });
});

describe('file_search eval: OCR and vision configurations (W3)', () => {
  const W3 = ['ocr', 'vision-no_text', 'vision-auto'];

  it('ships the parsing configurations on the baseline store, and only they read scans or page images', () => {
    expect(CONFIGS.ocr).toMatchObject({ fileSearch: {}, ocr: true });
    expect(CONFIGS.ocr.vision).toBeUndefined();
    expect(CONFIGS['vision-no_text']).toMatchObject({ ocr: true, vision: { mode: 'no_text', model: 'gemini-3.5-flash-lite' } });
    expect(CONFIGS['vision-auto']).toMatchObject({ ocr: true, vision: { mode: 'auto', model: 'gemini-3.5-flash-lite' } });
    for (const name of W3) expect(CONFIGS[name].storeChunking).toBeUndefined();
    for (const [name, config] of Object.entries(CONFIGS)) {
      if (!W3.includes(name)) expect([name, config.ocr, config.vision]).toEqual([name, undefined, undefined]);
    }
  });

  it('runs a vision configuration only with --allow-vision; --plan needs neither credentials nor the flag', () => {
    expect(() => parseArgs(['--env', 'e', '--config', 'vision-auto'])).toThrow(/sends PDF page images to gemini-3\.5-flash-lite.*--plan.*--allow-vision/);
    expect(() => parseArgs(['--env', 'e', '--config', 'vision-no_text'])).toThrow(/--allow-vision/);
    expect(parseArgs(['--env', 'e', '--config', 'vision-auto', '--allow-vision'])).toMatchObject({ config: 'vision-auto', allowVision: true });
    expect(parseArgs(['--env', 'e', '--config', 'ocr'])).toMatchObject({ config: 'ocr', allowVision: false, plan: false });
    expect(parseArgs(['--plan', '--config', 'vision-auto'])).toMatchObject({ plan: true, env: null, allowVision: false });
    expect(() => parseArgs(['--plan', '--config', 'nope'])).toThrow(/unknown --config/);
    expect(() => parseArgs(['--config', 'ocr'])).toThrow(/--env/);
  });

  it('switches OCR and vision by the configuration alone, whatever the shell said', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fseval-w3-'));
    try {
      const envOf = (name: string) => {
        const env: NodeJS.ProcessEnv = { FILE_SEARCH_OCR: 'auto', FILE_SEARCH_VISION: 'auto' };
        const { configFile } = prepareEnvironment({ env: null, verbose: false }, CONFIGS[name], env, dir);
        return { env, section: JSON.parse(fs.readFileSync(configFile, 'utf8')).api_config.capabilities.file_search };
      };
      expect(envOf('baseline').env).toMatchObject({ FILE_SEARCH_OCR: 'off', FILE_SEARCH_VISION: 'off' });
      expect(envOf('contextual').env).toMatchObject({ FILE_SEARCH_OCR: 'off', FILE_SEARCH_VISION: 'off' });
      expect(envOf('ocr')).toEqual({
        env: expect.objectContaining({ FILE_SEARCH_OCR: 'auto', FILE_SEARCH_VISION: 'off' }),
        section: { parsing: { ocr: { languages: ['eng'] } } },
      });
      expect(envOf('vision-auto')).toEqual({
        env: expect.objectContaining({ FILE_SEARCH_OCR: 'auto', FILE_SEARCH_VISION: 'auto' }),
        section: { parsing: { ocr: { languages: ['eng'] }, vision: { model: VISION_MODEL, default_mode: 'off' } } },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keys a store by OCR, the vision mode and the vision settings', () => {
    const withParsing = (vision: Record<string, unknown> = {}) => ({
      ...gatewayConfig(),
      parsing: { ocr: { languages: ['eng'] }, vision: { ...VISION_DEFAULTS, defaultMode: 'off', ...vision } },
    }) as unknown as FileSearchConfig;
    const of = (name: string, fs2 = withParsing()) => settingsOf(CONFIGS[name], fs2);
    const [baseline, ocr, noText, auto] = ['baseline', 'ocr', 'vision-no_text', 'vision-auto'].map((n) => of(n));
    expect(new Set([baseline, ocr, noText, auto].map((x) => x.key)).size).toBe(4);
    expect(baseline.parts.parsing).toBe('{"ocr":"off","vision":"off"}');
    expect(baseline.vision).toBeNull();
    expect(JSON.parse(ocr.parts.parsing)).toEqual({ ocr: ['eng'], vision: 'off' });
    expect(changedKeyParts({ fseval_parts: baseline.parts }, ocr.parts)).toEqual(['parsing']);
    expect(changedKeyParts({ fseval_parts: ocr.parts }, noText.parts)).toEqual(['chunking', 'parsing']);
    expect(changedKeyParts({ fseval_parts: noText.parts }, auto.parts)).toEqual(['chunking']);
    expect(noText.storeChunking).toEqual({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false, vision: 'no_text' });
    expect(noText.chunking).toEqual(noText.storeChunking);
    expect(noText.vision).toMatchObject({ model: 'gemini-3.5-flash-lite', maxPagesPerFile: 50 });
    const capped = of('vision-no_text', withParsing({ maxPagesPerFile: 10 }));
    expect(changedKeyParts({ fseval_parts: noText.parts }, capped.parts)).toEqual(['parsing']);
    expect(() => of('vision-auto', withParsing({ model: 'gemini-3.8-flash' })))
      .toThrow(/would transcribe pages with gemini-3\.8-flash, the configuration names gemini-3\.5-flash-lite/);
  });

  it('prices vision by its own row and refuses an unpriced vision model', () => {
    expect(VISION_PRICES['gemini-3.5-flash-lite']).toEqual(CONTEXT_PRICES['gemini-3.5-flash-lite']);
    const meter = new CostMeter(5);
    expect(meter.visionUsd('gemini-3.5-flash-lite', 10_000, 0, 1_000)).toBeCloseTo(0.005 + 0.003, 10);
    meter.addVision('gemini-3.5-flash-lite', 10_000, 0, 1_000);
    expect(meter.spentUsd).toBeCloseTo(0.008, 10);
    expect(meter.snapshot()).toMatchObject({
      vision: { 'gemini-3.5-flash-lite': { inputTokens: 10_000, cachedTokens: 0, outputTokens: 1_000 } },
      visionPrices: { 'gemini-3.5-flash-lite': VISION_PRICES['gemini-3.5-flash-lite'] },
    });
    expect(new CostMeter(5).snapshot()).not.toHaveProperty('vision');
    expect(() => meter.addVision('gpt-4.1', 1, 0, 1)).toThrow(UnpricedModelError);
    expect(() => meter.visionPrices('gpt-4.1')).toThrow(/no price row for the vision model gpt-4\.1: add one to VISION_PRICES/);
  });

  it('taps the vision usage events only, input with cache writes as uncached, and hands them over once', async () => {
    const tap = new VisionUsageTap();
    const emitter = { emit: async (_e: unknown) => { throw new Error('the original emitter must not run'); } };
    tap.install(emitter);
    await emitter.emit({ endpoint: 'file_search/vision', model: 'm', inputTokens: 1000, cacheCreationInputTokens: 200, cacheReadInputTokens: 50, outputTokens: 300 });
    await emitter.emit({ endpoint: 'file_search/ingest', model: 'e', inputTokens: 99999, outputTokens: 0 });
    await emitter.emit({ endpoint: 'file_search/vision', model: 'm', inputTokens: 1235, outputTokens: 350 });
    expect(tap.take()).toEqual({ inputTokens: 2435, cachedTokens: 50, outputTokens: 650, calls: 2 });
    expect(tap.take()).toEqual({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, calls: 0 });
  });

  it('books each file\'s vision calls as reported, also for a file that did not complete', async () => {
    const meter = new CostMeter(5);
    const reported = [
      { inputTokens: 2500, cachedTokens: 0, outputTokens: 700, calls: 2 },
      { inputTokens: 1250, cachedTokens: 0, outputTokens: 0, calls: 1 },
    ];
    const files: ManifestEntry[] = [{ file: 'scanned/a.pdf', kind: 'scanned', sha256: 'x', bytes: 10 }, { file: 'scanned/b.pdf', kind: 'scanned', sha256: 'y', bytes: 10 }];
    const results: FileResult[] = [
      { status: 'completed', chunks: 2, embeddingTokens: 100, context: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, failedChunks: 0 },
        parsing: { ocrPages: 0, ocrSkippedPages: 0, visionPages: 2, visionSkippedPages: 0 } },
      { status: 'failed', chunks: 0, embeddingTokens: 0, context: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, failedChunks: 0 } },
    ];
    const logs: string[] = [];
    await ingestFiles(files, {
      meter, contextModel: null, log: (m) => logs.push(m),
      vision: { model: 'gemini-3.5-flash-lite', take: () => reported.shift()! },
      estimate: async () => ({ usd: 0.1, context: null }),
      ingest: async () => results.shift()!,
    });
    expect(meter.snapshot().vision).toEqual({ 'gemini-3.5-flash-lite': { inputTokens: 3750, cachedTokens: 0, outputTokens: 700 } });
    expect(logs[0]).toMatch(/^processed scanned\/a\.pdf \(1\), OCR 0 page\(s\), vision 2 page\(s\) in 2 call\(s\); \$/);
  });

  it('estimates a file\'s vision calls by the transcriber\'s caps', () => {
    expect(fileVisionEstimate(7, { ...VISION_DEFAULTS })).toEqual({
      model: 'gemini-3.5-flash-lite', pages: 7, input: 7 * 1250, outputUpperBound: 7 * 4096, outputExpected: 7 * 400,
    });
    expect(fileVisionEstimate(80, { ...VISION_DEFAULTS }).pages).toBe(50);
    expect(fileVisionEstimate(0, { ...VISION_DEFAULTS })).toMatchObject({ pages: 0, input: 0, outputUpperBound: 0 });
  });

  (process.env.FILE_SEARCH_TEST_BINARIES === '1' ? it : it.skip)('selects the corpus pages each mode sends (pdftotext)', async () => {
    const corpus = path.resolve(__dirname, '../../../../ci/file-search-eval/corpus');
    const pagesOf = (file: string, mode: 'no_text' | 'auto') => visionPagesOf(file, fs.readFileSync(path.join(corpus, file)), mode);
    const scanned = await pagesOf('scanned/user-chapter-1-introduction.pdf', 'no_text');
    expect(scanned.selected).toEqual(Array.from({ length: scanned.pages }, (_, i) => i + 1));
    expect((await pagesOf('pdf/developer-chapter-2-architecture.pdf', 'no_text')).selected).toEqual([]);
    expect((await pagesOf('pdf/developer-chapter-2-architecture.pdf', 'auto')).selected).toEqual([]);
    expect((await pagesOf('table/developer-tables.pdf', 'auto')).selected).toEqual([1, 2, 3, 4, 5]);
    expect(await visionPagesOf('pptx/deck.pptx', Buffer.from('x'), 'auto')).toEqual({ pages: 0, selected: [] });
  });
});
