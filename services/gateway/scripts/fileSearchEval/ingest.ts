/**
 * Puts the corpus into a vector store through the gateway's own ingestion path: the blob store and
 * `fs_files` row an upload writes, `createBatch` (the file_batches route's attach), then the worker's
 * `processOne` (extract, chunk, embed, commit), one file at a time. Nothing of that is re-implemented.
 *
 * One store per key = sha256(corpus manifest sha256 + pipeline settings: embedding model and
 * dimension, the chunking setting files are chunked with, the context writer's settings (model
 * included) when chunks are contextual + the ingestion fingerprint: the ingestion path's source files
 * as they are on disk, plus INGESTION_VERSION). The store is created with the configuration's own
 * chunking setting. A run finding the store reuses it: completed and failed files are left as they
 * are, files still in_progress (an interrupted run) are processed again, missing ones attached.
 * Each file gets a batch of its own, so its job's counters (embedding tokens, context tokens) are
 * that file's usage for the meter. Before each file the meter must accept an estimate of its cost:
 * its embeddings and, for contextual chunks, its context calls (estimateContextTokens over the file's
 * own extracted text and chunks, priced as if nothing were cached) and, for vision, the pages its
 * mode selects at the transcriber's upper bound (parsing.ts). Vision calls are booked as they
 * report their usage (VisionUsageTap). OCR and the vision settings are part of the store key.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getPool } from '../../src/fileSearch/db';
import { retainBlob, sha256Of } from '../../src/fileSearch/blob/blobStore';
import { createStore } from '../../src/fileSearch/repository';
import { createBatch } from '../../src/fileSearch/batches';
import { processOne } from '../../src/fileSearch/ingestWorker';
import {
  ChunkingSetting, LEGACY_CHUNKING, resolveChunking, validateChunkingSetting,
} from '../../src/fileSearch/chunkingSetting';
import { ContextTokenEstimate, ContextWriterSettings, estimateContextTokens } from '../../src/fileSearch/contextWriter';
import { chunkStructured, countTokens } from '../../src/fileSearch/structureChunker';
import { extractStructuredText } from '../../src/fileSearch/extractors/registry';
import { isBlank } from '../../src/fileSearch/chunkRows';
import { EMBED_TOKEN_ESTIMATE_FACTOR } from '../../src/fileSearch/embedder';
import { newFileId } from '../../src/fileSearch/ids';
import { insertFileRow } from '../../src/fileSearch/fileRows';
import { FileSearchConfig, getFileSearchConfig } from '../../src/services/configService';
import { resolveVisionSettings, VisionSettings } from '../../src/fileSearch/visionTranscriber';
import { BudgetExceededError, ContextTokens, Meter } from './costMeter';
import { EVAL_CALLER, FileVisionEstimate, fileVisionEstimate, visionPagesOf } from './parsing';
import type { EvalConfig } from './options';

export const EVAL_OWNER = 'file-search-eval@example.invalid';

export interface ManifestEntry { file: string; kind: string; sha256: string; bytes: number }

export interface PipelineSettings {
  key: string;
  parts: StoreKeyParts;
  embeddingModel: string;
  embeddingDim: number;
  /** The store's own setting, written when the store is created. */
  storeChunking: ChunkingSetting;
  /** The setting every file is chunked with: a file `chunking` strategy wins over the store's. */
  chunking: ChunkingSetting;
  /** The context writer's settings when the chunks are contextual, else null. */
  contextual: ContextWriterSettings | null;
  /** OCR's languages when the configuration reads scans, else null (FILE_SEARCH_OCR=off). */
  ocr: { languages: string[] } | null;
  /** The transcriber's settings when the chunking setting has a vision mode, else null. */
  vision: VisionSettings | null;
}

/** What the store key is made of; each part is recorded in the store's metadata to explain a non-reuse. */
export interface StoreKeyParts {
  manifest: string; embedding: string; chunking: string; contextual: string; ingestion: string;
  /** OCR and vision (W3): how PDF pages without enough text are read. */
  parsing: string;
}

/** The configuration fields that decide how the corpus is ingested (the rest are search only). */
export type IngestionConfig = Pick<EvalConfig, 'chunking' | 'storeChunking' | 'contextual' | 'ocr' | 'vision'>;

/** Bump for an ingestion behaviour change outside INGESTION_SOURCES (a dependency, a config default). */
export const INGESTION_VERSION = 2;

/** The ingestion path's sources, relative to src/fileSearch; a directory stands for its *.ts files. */
export const INGESTION_SOURCES: readonly string[] = [
  'extractors', 'extractors/ooxml', 'chunker.ts', 'embedder.ts', 'ingestWorker.ts',
  'chunkingSetting.ts', 'chunkPipeline.ts', 'chunkRows.ts', 'structureChunker.ts', 'structureScanner.ts',
  'structureChunkThread.ts', 'structureChunkWorker.ts', 'contextWriter.ts', 'orchestrationCompletion.ts',
  'visionTranscriber.ts', 'pages.ts',
];

const FILE_SEARCH_SRC = path.resolve(__dirname, '../../src/fileSearch');

/** sha256 over INGESTION_VERSION and the ingestion sources as they are on disk now. */
export function ingestionFingerprint(srcDir = FILE_SEARCH_SRC, version = INGESTION_VERSION): string {
  const hash = crypto.createHash('sha256').update(`ingestion-version ${version}\n`);
  for (const source of INGESTION_SOURCES) {
    const files = fs.statSync(path.join(srcDir, source)).isDirectory()
      ? fs.readdirSync(path.join(srcDir, source)).filter((f) => f.endsWith('.ts')).sort().map((f) => `${source}/${f}`)
      : [source];
    for (const file of files) hash.update(`${file}\n`).update(fs.readFileSync(path.join(srcDir, file))).update('\n');
  }
  return hash.digest('hex');
}

export function storeKey(parts: StoreKeyParts): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** The key parts that differ from a previous store's metadata; null when it recorded none. */
export function changedKeyParts(previous: Record<string, unknown> | null, parts: StoreKeyParts): string[] | null {
  const recorded = previous?.fseval_parts as Partial<StoreKeyParts> | undefined;
  if (!recorded || typeof recorded !== 'object') return null;
  return (Object.keys(parts) as Array<keyof StoreKeyParts>).filter((name) => recorded[name] !== parts[name]);
}

/** The context writer's totals over the store's files, as their jobs counted them. */
export interface StoreContextTotals {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  failedChunks: number;
  /** cached / (input + cached): the share of the prompt read from a cache. */
  cacheReadShare: number;
}

export interface StoreSummary {
  storeId: string;
  reused: boolean;
  files: number;
  completed: number;
  failed: Array<{ file: string; error: string | null }>;
  pending: number;
  chunks: number;
  /** Chunks per corpus kind (markdown, pdf, table, scanned). */
  chunksByKind: Record<string, number>;
  /** Null unless the chunks are contextual. */
  context: StoreContextTotals | null;
  /** OCR and vision pages over the store's files (W3; absent from results written before). */
  parsing?: ParsingCounters;
  ingestedThisRun: number;
  /** Why ingestion stopped before every file was processed (the spending ceiling), else null. */
  stopReason: string | null;
}

/**
 * The settings a configuration ingests with and its store key. `fileSearch` is the configuration
 * the gateway runs with (the runner's generated api_config); it must name the configuration's
 * context model, or the key would describe contexts the gateway does not write.
 */
export function pipelineSettings(
  manifestSha256: string, config: IngestionConfig = {}, fileSearch: FileSearchConfig = getFileSearchConfig(),
): PipelineSettings {
  if (config.contextual && !config.storeChunking) throw new Error('contextual chunks need a structure storeChunking');
  // Without a storeChunking, the W1 baseline's static 800/400, whatever the installation default.
  const storeChunking = validateChunkingSetting({
    ...(config.storeChunking ?? LEGACY_CHUNKING),
    contextual: config.contextual !== undefined,
    ...(config.vision ? { vision: config.vision.mode } : {}),
  }, 'storeChunking');
  const chunking = resolveChunking({ file: config.chunking ?? null, store: storeChunking });
  if (config.contextual && fileSearch.contextual.model !== config.contextual.model) {
    throw new Error(`the gateway would write contexts with ${fileSearch.contextual.model}, `
      + `the configuration names ${config.contextual.model}`);
  }
  const contextual = chunking.contextual ? { ...fileSearch.contextual } : null;
  // The transcriber reads the gateway's configuration; `fileSearch` is that configuration (the runner's).
  const vision = chunking.vision ? resolveVisionSettings({ ...(fileSearch.parsing?.vision ?? {}) }) : null;
  if (config.vision && vision?.model !== config.vision.model) {
    throw new Error(`the gateway would transcribe pages with ${vision?.model ?? 'no model'}, `
      + `the configuration names ${config.vision.model}`);
  }
  const ocr = config.ocr ? { languages: [...(fileSearch.parsing?.ocr?.languages ?? ['eng'])] } : null;
  const settings = {
    embeddingModel: fileSearch.embeddingModel,
    embeddingDim: fileSearch.embeddingDimensions,
    storeChunking,
    chunking,
    contextual,
    ocr,
    vision,
  };
  const parts: StoreKeyParts = {
    manifest: manifestSha256,
    embedding: `${settings.embeddingModel}/${settings.embeddingDim}`,
    chunking: JSON.stringify(chunking),
    // Every contextual setting, concurrency and timeouts included: those rarely change the contexts,
    // so this over-separates stores on purpose rather than reuse one written under other settings.
    contextual: contextual ? JSON.stringify(contextual) : 'off',
    ingestion: ingestionFingerprint(),
    // The vision mode is in `chunking`; its model and limits, and whether OCR runs, here.
    parsing: JSON.stringify({ ocr: ocr ? ocr.languages : 'off', vision: vision ?? 'off' }),
  };
  return { key: storeKey(parts), parts, ...settings };
}

/** Conservative token estimate before extraction: four bytes a token, doubled for the chunk overlap,
 *  times the embedder's own under-count factor. PDFs carry far fewer tokens than bytes. */
export function estimateFileTokens(bytes: number): number {
  return Math.ceil((bytes / 4) * 2 * EMBED_TOKEN_ESTIMATE_FACTOR);
}

/** The context estimate counts cl100k tokens; Gemini and Claude count the same text with their own
 *  tokenizers, which can come out higher. The input estimate is raised by this factor for that. */
export const CONTEXT_TOKENIZER_MARGIN = 1.2;

/**
 * The context calls of one file by the writer's own rule (estimateContextTokens), from the file's
 * extracted text and its structure chunks — what ingestion will send, before any call is made —
 * with the input raised by CONTEXT_TOKENIZER_MARGIN. When the extraction fails here, a bytes-based
 * guess: three bytes a token, chunks half the maximum size.
 */
export async function estimateFileContext(
  filename: string, bytes: Buffer, setting: ChunkingSetting, contextual: Partial<ContextWriterSettings>,
): Promise<ContextTokenEstimate> {
  let documentTokens: number;
  let chunks: number;
  try {
    const { text, format } = await extractStructuredText(filename, bytes);
    chunks = chunkStructured(text, { maxTokens: setting.max_tokens, overlapTokens: setting.overlap_tokens, format })
      .filter((c) => !isBlank(c.text)).length;
    documentTokens = countTokens(text);
  } catch {
    documentTokens = Math.ceil(bytes.length / 3);
    chunks = Math.ceil(documentTokens / (setting.max_tokens / 2));
  }
  const estimate = estimateContextTokens(documentTokens, chunks, contextual);
  return { ...estimate, input: Math.ceil(estimate.input * CONTEXT_TOKENIZER_MARGIN) };
}

/** What a file is expected to cost before it is ingested. */
export interface FileEstimate { usd: number; context: ContextTokenEstimate | null; vision?: FileVisionEstimate | null }

/** What ingesting a file cost, as its job counted it. */
export interface FileResult {
  status: string;
  chunks: number;
  embeddingTokens: number;
  context: { inputTokens: number; cachedTokens: number; outputTokens: number; failedChunks: number };
  /** The job's OCR and vision page counters. */
  parsing?: ParsingCounters;
}

/** fs_jobs' OCR and vision page counters (W3). */
export interface ParsingCounters { ocrPages: number; ocrSkippedPages: number; visionPages: number; visionSkippedPages: number }

/**
 * Ingests `todo` one file at a time. Before each file the meter must accept the file's estimate;
 * when it refuses, the loop stops there and says how far it got. After each file its job's counters
 * are booked. A file that did not complete has no context tokens in its job (the counters are written
 * with its chunks), but its calls were made: its context estimate is booked instead.
 */
export async function ingestFiles(todo: ManifestEntry[], deps: {
  meter: Meter;
  contextModel: string | null;
  /** The vision model when the chunking setting has a vision mode, with what its calls reported
   *  since the last file (VisionUsageTap.take). */
  vision?: { model: string; take: () => ContextTokens & { calls: number } } | null;
  estimate: (entry: ManifestEntry) => Promise<FileEstimate>;
  ingest: (entry: ManifestEntry) => Promise<FileResult>;
  log: (m: string) => void;
}): Promise<{ ingested: number; stopReason: string | null }> {
  const { meter, log, contextModel } = deps;
  let ingested = 0;
  for (const [i, entry] of todo.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const estimate = await deps.estimate(entry);
    try {
      meter.ensure(estimate.usd);
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      const done = ingested ? `${ingested} file(s) ingested this run, the last ${todo[i - 1].file}` : 'no file ingested this run';
      return { ingested, stopReason: `${error.message} (before ${entry.file}, file ${i + 1} of ${todo.length} to ingest; ${done})` };
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await deps.ingest(entry);
    meter.addEmbedding(result.embeddingTokens);
    // Every vision call is booked as it reported, whether or not the file completed.
    const vision = deps.vision ? deps.vision.take() : null;
    if (deps.vision && vision && vision.calls > 0) {
      meter.addVision!(deps.vision.model, vision.inputTokens, vision.cachedTokens, vision.outputTokens);
    }
    if (result.status === 'completed' && result.chunks > 0 && result.embeddingTokens === 0) {
      log(`WARNING: ${entry.file} completed with ${result.chunks} chunks but its job reported 0 embedding tokens; `
        + 'the cost meter under-counts this file');
    }
    if (contextModel) {
      if (result.status === 'completed') {
        meter.addContext(contextModel, result.context.inputTokens, result.context.cachedTokens, result.context.outputTokens);
      } else if (estimate.context) {
        meter.addContext(contextModel, estimate.context.input, 0, estimate.context.outputUpperBound);
        log(`${entry.file} did not complete (${result.status}); its context estimate is booked, its job holds no context tokens`);
      }
    }
    ingested += 1;
    const pages = result.parsing && (result.parsing.ocrPages || result.parsing.visionPages || vision?.calls)
      ? `, OCR ${result.parsing.ocrPages} page(s), vision ${result.parsing.visionPages} page(s) in ${vision?.calls ?? 0} call(s)`
      : '';
    const ctx = contextModel && result.status === 'completed'
      ? `, context ${result.context.inputTokens} in / ${result.context.cachedTokens} cached / ${result.context.outputTokens} out, `
        + `${result.context.failedChunks} chunk(s) without context`
      : '';
    log(`processed ${entry.file} (${ingested})${pages}${ctx}; $${meter.snapshot().spentUsd.toFixed(4)} spent`);
  }
  return { ingested, stopReason: null };
}

const MIME: Record<string, string> = {
  '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

async function findOrCreateStore(name: string, settings: PipelineSettings, log: (m: string) => void): Promise<{ id: string; created: boolean }> {
  const pool = getPool()!;
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM vector_stores WHERE owner_email = $1 AND name = $2 ORDER BY created_at LIMIT 1', [EVAL_OWNER, name]);
  if (rows[0]) return { id: rows[0].id, created: false };
  const { rows: previous } = await pool.query<{ name: string; metadata: Record<string, unknown> | null }>(
    `SELECT name, metadata FROM vector_stores WHERE owner_email = $1 AND name LIKE 'fseval-%'
      ORDER BY created_at DESC LIMIT 1`, [EVAL_OWNER]);
  if (previous[0]) {
    const changed = changedKeyParts(previous[0].metadata, settings.parts);
    log(`not reusing store ${previous[0].name}: ${changed ? `${changed.join(', ')} changed` : 'it recorded no key parts'}`);
  }
  const store = await createStore({
    ownerEmail: EVAL_OWNER, name, metadata: { fseval_key: settings.key, fseval_parts: settings.parts },
    chunking: settings.storeChunking,
  });
  return { id: store.id, created: true };
}

/** Writes what an upload writes: the content-addressed blob and the `fs_files` row (filesController). */
async function uploadFile(filename: string, bytes: Buffer): Promise<string> {
  const sha = sha256Of(bytes);
  await retainBlob(sha, bytes, MIME[path.extname(filename)] ?? 'application/octet-stream');
  const id = newFileId();
  await insertFileRow({ id, ownerEmail: EVAL_OWNER, filename, purpose: 'assistants', sha256: sha, sizeBytes: bytes.length });
  return id;
}

/** The file's status, chunk count and its job's counters (provider-reported embedding tokens, context tokens). */
async function fileState(storeId: string, fileId: string): Promise<FileResult> {
  const { rows } = await getPool()!.query<Record<string, string | null> & { status: string; chunks: number }>(
    `SELECT f.status, j.embedding_tokens::text AS tokens,
            j.context_input_tokens::text AS ctx_in, j.context_cached_tokens::text AS ctx_cached,
            j.context_output_tokens::text AS ctx_out, j.context_failed_chunks::text AS ctx_failed,
            j.ocr_pages::text AS ocr, j.ocr_skipped_pages::text AS ocr_skipped,
            j.vision_pages::text AS vis, j.vision_skipped_pages::text AS vis_skipped,
            (SELECT count(*)::int FROM vector_store_chunks c WHERE c.store_id = f.store_id AND c.file_id = f.file_id) AS chunks
       FROM vector_store_files f
       LEFT JOIN fs_jobs j ON j.batch_id = f.batch_id AND j.store_id = f.store_id
      WHERE f.store_id = $1 AND f.file_id = $2`, [storeId, fileId]);
  const r = rows[0];
  return {
    status: r?.status ?? 'missing',
    chunks: r?.chunks ?? 0,
    embeddingTokens: Number(r?.tokens ?? 0),
    context: {
      inputTokens: Number(r?.ctx_in ?? 0), cachedTokens: Number(r?.ctx_cached ?? 0),
      outputTokens: Number(r?.ctx_out ?? 0), failedChunks: Number(r?.ctx_failed ?? 0),
    },
    parsing: {
      ocrPages: Number(r?.ocr ?? 0), ocrSkippedPages: Number(r?.ocr_skipped ?? 0),
      visionPages: Number(r?.vis ?? 0), visionSkippedPages: Number(r?.vis_skipped ?? 0),
    },
  };
}

/** The OCR and vision counters of every file's job in the store (one batch per file). */
async function storeParsingTotals(storeId: string): Promise<ParsingCounters> {
  const { rows } = await getPool()!.query<{ o: string; os: string; v: string; vs: string }>(
    `SELECT coalesce(sum(j.ocr_pages), 0)::text AS o, coalesce(sum(j.ocr_skipped_pages), 0)::text AS os,
            coalesce(sum(j.vision_pages), 0)::text AS v, coalesce(sum(j.vision_skipped_pages), 0)::text AS vs
       FROM vector_store_files vsf JOIN fs_jobs j ON j.batch_id = vsf.batch_id AND j.store_id = vsf.store_id
      WHERE vsf.store_id = $1`, [storeId]);
  const [ocrPages, ocrSkippedPages, visionPages, visionSkippedPages] = [rows[0].o, rows[0].os, rows[0].v, rows[0].vs].map(Number);
  return { ocrPages, ocrSkippedPages, visionPages, visionSkippedPages };
}

/** The context counters of every file's job in the store (one batch per file). */
async function storeContextTotals(storeId: string): Promise<StoreContextTotals> {
  const { rows } = await getPool()!.query<{ i: string; c: string; o: string; f: string }>(
    `SELECT coalesce(sum(j.context_input_tokens), 0)::text AS i, coalesce(sum(j.context_cached_tokens), 0)::text AS c,
            coalesce(sum(j.context_output_tokens), 0)::text AS o, coalesce(sum(j.context_failed_chunks), 0)::text AS f
       FROM vector_store_files vsf JOIN fs_jobs j ON j.batch_id = vsf.batch_id AND j.store_id = vsf.store_id
      WHERE vsf.store_id = $1`, [storeId]);
  const [inputTokens, cachedTokens, outputTokens, failedChunks] = [rows[0].i, rows[0].c, rows[0].o, rows[0].f].map(Number);
  const prompt = inputTokens + cachedTokens;
  return { inputTokens, cachedTokens, outputTokens, failedChunks, cacheReadShare: prompt ? cachedTokens / prompt : 0 };
}

export async function ensureStore(opts: {
  corpusDir: string; manifest: ManifestEntry[]; settings: PipelineSettings;
  chunking?: Record<string, unknown>; meter: Meter; embeddingUsd: (tokens: number) => number;
  /** USD of a context estimate for the settings' context model (CostMeter.contextEstimateUsd). */
  contextEstimateUsd?: (model: string, estimate: ContextTokenEstimate) => number;
  /** USD of a vision estimate at its upper bound (CostMeter.visionUsd); required when vision is on. */
  visionEstimateUsd?: (estimate: FileVisionEstimate) => number;
  /** What the vision calls reported since the last file; required when vision is on. */
  takeVision?: () => ContextTokens & { calls: number };
  log: (m: string) => void;
}): Promise<StoreSummary> {
  const pool = getPool()!;
  const { settings, meter, log } = opts;
  const store = await findOrCreateStore(`fseval-${settings.key.slice(0, 16)}`, settings, log);
  const { rows: attached } = await pool.query<{ filename: string; file_id: string; status: string }>(
    `SELECT f.filename, vsf.file_id, vsf.status FROM vector_store_files vsf JOIN fs_files f ON f.id = vsf.file_id
      WHERE vsf.store_id = $1`, [store.id]);
  const byName = new Map(attached.map((r) => [r.filename, r]));
  const todo = opts.manifest.filter((entry) => byName.get(entry.file)?.status === undefined
    || byName.get(entry.file)!.status === 'in_progress');
  const read = (entry: ManifestEntry): Buffer => {
    const bytes = fs.readFileSync(path.join(opts.corpusDir, entry.file));
    if (sha256Of(bytes) !== entry.sha256) throw new Error(`${entry.file} does not match its manifest sha256`);
    return bytes;
  };
  const contextModel = settings.contextual?.model ?? null;

  const visionSettings = settings.vision;
  if (visionSettings && !opts.takeVision) throw new Error('vision is on, but nothing books its calls');
  const { ingested, stopReason } = await ingestFiles(todo, {
    meter, log, contextModel,
    vision: visionSettings ? { model: visionSettings.model, take: opts.takeVision! } : null,
    estimate: async (entry) => {
      const embedding = opts.embeddingUsd(estimateFileTokens(entry.bytes));
      let vision: FileVisionEstimate | null = null;
      let visionUsd = 0;
      if (visionSettings && settings.chunking.vision) {
        const { selected } = await visionPagesOf(entry.file, read(entry), settings.chunking.vision);
        vision = fileVisionEstimate(selected.length, visionSettings);
        visionUsd = opts.visionEstimateUsd ? opts.visionEstimateUsd(vision) : Number.POSITIVE_INFINITY; // never unpriced
      }
      if (!settings.contextual) return { usd: embedding + visionUsd, context: null, vision };
      const context = await estimateFileContext(entry.file, read(entry), settings.chunking, settings.contextual);
      const contextUsd = opts.contextEstimateUsd
        ? opts.contextEstimateUsd(settings.contextual.model, context)
        : Number.POSITIVE_INFINITY; // never ingest contextual chunks unpriced
      return { usd: embedding + visionUsd + contextUsd, context, vision };
    },
    ingest: async (entry) => {
      let fileId = byName.get(entry.file)?.file_id;
      if (!fileId) {
        fileId = await uploadFile(entry.file, read(entry));
        // With vision, the files carry a credential so the transcriber's usage events reach the tap.
        await createBatch(store.id, [fileId], null, opts.chunking ?? null, visionSettings ? { ...EVAL_CALLER } : {});
      }
      await processOne(store.id, fileId);
      return fileState(store.id, fileId);
    },
  });

  const { rows: status } = await pool.query<{ filename: string; status: string; error: string | null; chunks: number }>(
    `SELECT f.filename, vsf.status, vsf.last_error->>'name' AS error,
            (SELECT count(*)::int FROM vector_store_chunks c WHERE c.store_id = vsf.store_id AND c.file_id = vsf.file_id) AS chunks
       FROM vector_store_files vsf JOIN fs_files f ON f.id = vsf.file_id WHERE vsf.store_id = $1`, [store.id]);
  const kindOf = new Map(opts.manifest.map((e) => [e.file, e.kind]));
  const chunksByKind: Record<string, number> = {};
  for (const s of status) {
    const kind = kindOf.get(s.filename) ?? 'other';
    chunksByKind[kind] = (chunksByKind[kind] ?? 0) + s.chunks;
  }
  return {
    storeId: store.id,
    reused: !store.created && ingested === 0,
    files: status.length,
    completed: status.filter((s) => s.status === 'completed').length,
    failed: status.filter((s) => s.status === 'failed').map((s) => ({ file: s.filename, error: s.error })),
    pending: status.filter((s) => s.status === 'in_progress').length,
    chunks: status.reduce((n, s) => n + s.chunks, 0),
    chunksByKind,
    context: settings.contextual ? await storeContextTotals(store.id) : null,
    parsing: await storeParsingTotals(store.id),
    ingestedThisRun: ingested,
    stopReason,
  };
}
