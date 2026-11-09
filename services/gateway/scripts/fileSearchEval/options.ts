/**
 * Command line and named configurations of the file_search evaluation runner. No gateway imports:
 * bootstrap.ts reads these before any gateway module is loaded.
 */
import type { HybridWeights } from '../../src/fileSearch/rrf';
import type { LexicalRankFunction } from '../../src/fileSearch/repository';
import type { RerankInput } from '../../src/fileSearch/search';
import type { VisionMode } from '../../src/fileSearch/visionTranscriber';

export interface EvalConfig {
  description: string;
  /** Written as api_config.capabilities.file_search (snake_case, as in api_config.json); {} = today's defaults. */
  fileSearch: Record<string, unknown>;
  /** SearchOptions.rankingOptions for every question. */
  rankingOptions?: { scoreThreshold?: number; hybridWeights?: HybridWeights };
  /** chunking_strategy for the attach (part of the store key); absent = auto (800/400). */
  chunking?: Record<string, unknown>;
  /** Ranking function of the full-text arm, a measurement only (no api_config key); absent = ts_rank. */
  lexicalRank?: LexicalRankFunction;
  /** The store's own chunking setting, written at store creation (part of the store key); absent =
   *  static 800/400, the W1 baseline. Not the installation default: the shipped api_config files set
   *  structure with contexts (since 2026-10-09), while the built-in default for an unset chunking
   *  block is static 800/400. Contextual chunks are asked for with `contextual`. */
  storeChunking?: { type: 'static' | 'structure'; max_tokens: number; overlap_tokens: number };
  /** Contextual chunks (needs a `structure` storeChunking), written by this model: the store setting's
   *  `contextual` and `file_search.contextual.model` (part of the store key). */
  contextual?: { model: string };
  /** Search only: hits come back as parent sections of at most `maxTokens` tokens, as the Responses
   *  tool returns them (`file_search.parent_sections`, searched with the tool's surface). */
  parentSections?: { maxTokens: number };
  /** Search only: `hybrid.candidates` per arm, fewer than the default 50, as a larger store would
   *  leave the reranker a smaller share of it. */
  candidates?: number;
  /** Search only: what the reranker reads per candidate; absent = the chunk text, as every
   *  configuration was measured (the production default, hybrid.rerank.input, is context and text). */
  rerankInput?: RerankInput;
  /** OCR of PDF pages without a text layer (W3): the run sets FILE_SEARCH_OCR to auto and refuses to
   *  start when tesseract cannot run here; absent = OCR switched off, as every earlier configuration
   *  was measured (part of the store key). */
  ocr?: boolean;
  /** Vision transcription of PDF pages (W3): the store setting's `vision` mode and
   *  `file_search.parsing.vision.model` (part of the store key). Billed per page image, so a run
   *  needs --allow-vision. */
  vision?: { mode: Exclude<VisionMode, 'off'>; model: string };
}

/** The context models the W2 evaluation compares (file_search.contextual.model). */
export const CONTEXT_MODELS = { flashLite: 'gemini-3.5-flash-lite', haiku: 'anthropic--claude-4.5-haiku' } as const;

const NO_RERANK = { hybrid: { rerank: { enabled: false } } };
/** Structure chunking at the default size, no overlap inside a section; the heading path is the context. */
const STRUCTURE = { type: 'structure', max_tokens: 800, overlap_tokens: 0 } as const;
const CONTEXTUAL = { model: CONTEXT_MODELS.flashLite };
/** The vision model the W3 evaluation measures (the shipped `file_search.parsing.vision.model`). */
export const VISION_MODEL = 'gemini-3.5-flash-lite';

/** Add a configuration here; the store is shared by every configuration with the same pipeline
 *  settings (embedding model and dimension, chunking), so a search-only change ingests nothing. */
export const CONFIGS: Record<string, EvalConfig> = {
  baseline: { description: 'static chunking 800/400, otherwise the shipped search defaults', fileSearch: {} },
  'text-heavy': {
    description: 'hybrid weights embedding 0.5 / text 1',
    fileSearch: {},
    rankingOptions: { hybridWeights: { embedding: 0.5, text: 1 } },
  },
  'embedding-heavy': {
    description: 'hybrid weights embedding 1 / text 0.5',
    fileSearch: {},
    rankingOptions: { hybridWeights: { embedding: 1, text: 0.5 } },
  },
  'no-rerank': {
    description: 'reranker disabled (RRF order)',
    fileSearch: { hybrid: { rerank: { enabled: false } } },
  },
  // With the reranker on, a small corpus hands it nearly every chunk, so the fusion weights
  // cannot move the final order; these two show the weights' own effect on the fused ranking.
  'no-rerank-text-heavy': {
    description: 'reranker disabled, hybrid weights embedding 0.5 / text 1',
    fileSearch: { hybrid: { rerank: { enabled: false } } },
    rankingOptions: { hybridWeights: { embedding: 0.5, text: 1 } },
  },
  'no-rerank-embedding-heavy': {
    description: 'reranker disabled, hybrid weights embedding 1 / text 0.5',
    fileSearch: { hybrid: { rerank: { enabled: false } } },
    rankingOptions: { hybridWeights: { embedding: 1, text: 0.5 } },
  },
  'lexical-all': {
    description: 'full-text arm requires every query word (lexical_query "all")',
    fileSearch: { hybrid: { lexical_query: 'all' } },
  },
  'ts-rank-cd': {
    description: 'full-text arm ranked with ts_rank_cd instead of ts_rank',
    fileSearch: {},
    lexicalRank: 'ts_rank_cd',
  },
  // The reranker hides fusion-level differences on this corpus; compare the full-text options without it.
  'no-rerank-lexical-all': {
    description: 'reranker disabled, full-text arm requires every query word',
    fileSearch: { hybrid: { rerank: { enabled: false }, lexical_query: 'all' } },
  },
  'no-rerank-ts-rank-cd': {
    description: 'reranker disabled, full-text arm ranked with ts_rank_cd',
    fileSearch: { hybrid: { rerank: { enabled: false } } },
    lexicalRank: 'ts_rank_cd',
  },
  // Chunking (W2). One store per ingestion setting: `structure` and its search variants share one,
  // the flash-lite contextual configurations another, Haiku a third. `baseline` is the static store.
  structure: {
    description: 'structure chunking 800/0, heading path as context',
    fileSearch: {}, storeChunking: STRUCTURE,
  },
  'structure-no-rerank': {
    description: 'structure chunking 800/0, reranker disabled',
    fileSearch: NO_RERANK, storeChunking: STRUCTURE,
  },
  'structure-c20': {
    description: 'structure chunking 800/0, 20 candidates per arm',
    fileSearch: {}, storeChunking: STRUCTURE, candidates: 20,
  },
  contextual: {
    description: `structure chunking 800/0 with contexts written by ${CONTEXT_MODELS.flashLite}`,
    fileSearch: {}, storeChunking: STRUCTURE, contextual: CONTEXTUAL,
  },
  'contextual-no-rerank': {
    description: `contextual chunks (${CONTEXT_MODELS.flashLite}), reranker disabled`,
    fileSearch: NO_RERANK, storeChunking: STRUCTURE, contextual: CONTEXTUAL,
  },
  'contextual-c20': {
    description: `contextual chunks (${CONTEXT_MODELS.flashLite}), 20 candidates per arm`,
    fileSearch: {}, storeChunking: STRUCTURE, contextual: CONTEXTUAL, candidates: 20,
  },
  'contextual-haiku': {
    description: `structure chunking 800/0 with contexts written by ${CONTEXT_MODELS.haiku}`,
    fileSearch: {}, storeChunking: STRUCTURE, contextual: { model: CONTEXT_MODELS.haiku },
  },
  'contextual-rerank-ctx': {
    description: `contextual chunks (${CONTEXT_MODELS.flashLite}), the reranker reads context and text`,
    fileSearch: {}, storeChunking: STRUCTURE, contextual: CONTEXTUAL, rerankInput: 'context_and_text',
  },
  // Run with --judge 40: answer quality is what parent sections are for. Its retrieval metrics
  // count a parent that contains a quote (compare its chunk-level ranking with `structure`).
  parent: {
    description: 'structure chunking 800/0, hits returned as parent sections of at most 1500 tokens',
    fileSearch: {}, storeChunking: STRUCTURE, parentSections: { maxTokens: 1500 },
  },
  // Parsing (W3), each on the W1 baseline store (static 800/400, shipped search) so only the reading
  // of the PDFs differs from `baseline`. Vision runs before OCR; OCR reads what vision left empty.
  ocr: {
    description: 'static chunking 800/400, OCR of PDF pages without a text layer (tesseract, eng)',
    fileSearch: {}, ocr: true,
  },
  'vision-no_text': {
    description: `static chunking 800/400, OCR, and ${VISION_MODEL} transcribes PDF pages without a text layer`,
    fileSearch: {}, ocr: true, vision: { mode: 'no_text', model: VISION_MODEL },
  },
  'vision-auto': {
    description: `static chunking 800/400, OCR, and ${VISION_MODEL} transcribes PDF pages with little or no text and table pages`,
    fileSearch: {}, ocr: true, vision: { mode: 'auto', model: VISION_MODEL },
  },
  // Large searches (W4), on the W1 baseline store. The corpus store (~100 chunks) is far below the
  // shipped exact_max_chunks (20,000), so both lower it: `bounded-lexical` shows the full-text bound
  // alone (common words dropped, ranked set capped), `ann` adds the approximate vector arm. Both need
  // the halfvec index (a fresh fseval database gets it) and analyzed statistics (the planner's
  // reltuples; unknown keeps both exact), and the corpus's statistics are not those of a large store.
  'bounded-lexical': {
    description: 'baseline store, exact_max_chunks 10: the full-text bound of large searches, vector arm exact',
    fileSearch: { ann: { enabled: false, exact_max_chunks: 10, min_fraction: 0.01 } },
  },
  ann: {
    description: 'baseline store, exact_max_chunks 10, min_fraction 0.01, approximate search on (and the full-text bound)',
    fileSearch: { ann: { enabled: true, exact_max_chunks: 10, min_fraction: 0.01 } },
  },
};

export interface Options {
  config: string;
  env: string | null;
  dsn: string | null;
  keepDb: boolean;
  maxUsd: number;
  judge: number;
  judgeModel: string;
  limit: number | null;
  compare: [string, string] | null;
  verbose: boolean;
  /** Print what the configuration would cost and which SAP calls it makes; run nothing. */
  plan: boolean;
  /** Required to run a configuration with `vision` (it sends page images to a billed model). */
  allowVision: boolean;
}

export const USAGE = `Usage (from services/gateway):
  pnpm run eval:file-search -- --env .env [--config ${Object.keys(CONFIGS).join('|')}]
      [--dsn postgresql://...] [--keep-db] [--max-usd 5] [--judge N] [--judge-model gemini-3.5-flash|gpt-4.1]
      [--limit N] [--verbose] [--allow-vision]
  pnpm run eval:file-search -- --plan [--config <name>] [--judge N] [--limit N]
  pnpm run eval:file-search -- --compare <resultA.json> <resultB.json>`;

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    config: 'baseline', env: null, dsn: null, keepDb: false, maxUsd: 5, judge: 0,
    judgeModel: 'gemini-3.5-flash', limit: null, compare: null, verbose: false, plan: false, allowVision: false,
  };
  const value = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const count = (v: string, name: string, min: number): number => {
    if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} must be an integer >= ${min}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--': break; // pnpm run forwards it
      case '--config': opts.config = value(i, a); i++; break;
      case '--env': opts.env = value(i, a); i++; break;
      case '--dsn': opts.dsn = value(i, a); i++; break;
      case '--keep-db': opts.keepDb = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--plan': opts.plan = true; break;
      case '--allow-vision': opts.allowVision = true; break;
      case '--max-usd': {
        const v = Number(value(i, a)); i++;
        if (!Number.isFinite(v) || v <= 0) throw new Error('--max-usd must be a positive number');
        opts.maxUsd = v;
        break;
      }
      case '--judge': opts.judge = count(value(i, a), a, 0); i++; break;
      case '--judge-model': opts.judgeModel = value(i, a); i++; break;
      case '--limit': opts.limit = count(value(i, a), a, 1); i++; break;
      case '--compare': opts.compare = [value(i, a), value(i + 1, a)]; i += 2; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!opts.compare) {
    const config = CONFIGS[opts.config];
    if (!config) throw new Error(`unknown --config ${opts.config}; known: ${Object.keys(CONFIGS).join(', ')}`);
    if (opts.plan) return opts; // reads the corpus only: no credentials, no database, no SAP call
    if (!opts.env) throw new Error('--env <path to services/gateway/.env> is required for a run');
    if (config.vision && !opts.allowVision) {
      throw new Error(`--config ${opts.config} sends PDF page images to ${config.vision.model}, billed per page: `
        + 'check its cost with --plan first, then add --allow-vision');
    }
  }
  return opts;
}
