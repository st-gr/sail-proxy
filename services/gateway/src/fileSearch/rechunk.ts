// RE-CHUNKING — a store's chunking setting is changed by chunking its files again into a new
// generation (plan Q6, research §2.4). Nothing here is HTTP-aware; the grounding routes (owner
// and admin) call these functions.
//
// A re-chunk IS a re-embed job (`reembed_store`, reembed.ts) whose pinned
// `fs_jobs.target_chunking` is non-null: the same items, claim, lease, retry, cancel, switch
// and the one-unfinished-job-per-store index. Only three things differ:
//  - an item reads the file's blob and runs it through ingestion's pipeline by the target
//    setting (extract → chunk → context when contextual → embed with the STORE's model,
//    reembedWorker.ts rechunkedRows) instead of copying the stored chunk text;
//  - ingestion during the job writes the store's setting into the active generation and the
//    target setting into the new one (ingestWorker.ts commitChunks, per-generation chunk sets);
//  - the switch also sets `vector_stores.chunking` to the target and recounts usage bytes.
// Cancel deletes the new generation and leaves the store's chunking and generation as they
// were; a failed job leaves them too (Retry continues, Cancel discards).
//
// A contextual target is refused (`context_model_unavailable`) when one tiny call finds the
// context model not served. A re-chunk to the store's own setting is refused
// (`chunking_current`) unless the setting is contextual and chunks of the active generation lack
// their model-written context (an outage during ingestion): then it fills them.
//
// A target with a vision mode (W3) is refused (`vision_model_unavailable`) when one tiny call with
// an image finds the vision model not served, or vision is switched off on this gateway
// (FILE_SEARCH_VISION=off, as in the npm standalone CLI). Every PDF of the store is then read again
// with that mode: the estimate counts its pages (an upper bound) × the per-page tokens.
//
// Every setting change is a re-chunk, contextual on → off included: the stored context holds
// the LLM sentence between the heading path and a table header, which cannot be told apart
// from the header reliably, so dropping it means chunking again. That costs the blob reads,
// the extraction and the embeddings, but no context call.
//
// MEMORY: a re-chunk item holds what an ingestion holds (the blob, the extracted text, the
// chunks and vectors of one file), and the ingest worker's loops claim items one at a time
// each, so the peak is ingestion's: the largest extraction × `ingestion.concurrency`.
import type { PoolClient } from 'pg';
import { getDefaultLogger } from '@libs/logger';
import { getFileSearchConfig } from '../services/configService';
import { ChunkingSetting, chunkingKey, resolveChunking } from './chunkingSetting';
import { checkContextModel, CONTEXT_WRITER_DEFAULTS, estimateContextTokens } from './contextWriter';
import { FINAL_CONTEXT_STOPS } from './contextStop';
import { isPdfFile } from './extractors/registry';
import {
  checkVisionModel, estimateVisionTokens, resolveVisionSettings, visionImagesUnmasked, visionModeOf, visionSwitchedOff,
  VisionSettings, warnVisionUnmasked,
} from './visionTranscriber';
import { embed, EmbeddingModelUnavailableError } from './embedder';
import { embeddingState } from './embeddingState';
import { jobSummary, JobSummary } from './jobs';
import { afterStart, insertStoreJob, ReembedActor } from './reembed';
import { inTransaction, requirePool } from './reembedWorker';
import { completionUsageRecord, emitFileSearchUsage, storedFileSearchCaller, workerRequestId } from './usage';

const logger = getDefaultLogger();

/** The `name` a "model not served" failure is persisted under (serializeError keeps it). */
const MODEL_UNAVAILABLE_ERROR_NAME = new EmbeddingModelUnavailableError('').name;

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

/** Every number is an estimate: the extracted text is not stored, so its size is derived from
 *  the active generation's chunks, and the new chunk count from the target setting. */
export interface RechunkEstimate {
  store_id: string;
  /** The store's setting now (NULL = static 800/400); null when the stored value is invalid. */
  current: ChunkingSetting | null;
  target: ChunkingSetting;
  /** The target equals the current setting: a start is refused, unless it fills missing contexts
   *  (`chunks_without_context` > 0). */
  unchanged: boolean;
  /** Embedded chunks of the active generation without a model-written context, counted only when
   *  the store's setting is contextual (else 0). With `unchanged`, a start re-chunks to fill them. */
  chunks_without_context: number;
  /** The store's unfinished re-embed or re-chunk, which a start would wait for (409). */
  running_job_id: string | null;
  /** The model the re-chunk embeds with: the store's own. */
  embedding_model: string;
  /** That model was already found not served (a file of the store, or an item of a job on that
   *  model, failed with "model not served"): a start would answer 409 `store_model_unavailable`
   *  — the store needs a re-embed first. False means no such failure is known; the start checks
   *  the model itself (the estimate makes no call). */
  embedding_model_unavailable: boolean;
  /** Completed files: each is read, extracted and chunked again. */
  files: number;
  /** Embedded chunks of the active generation (a chunk of only whitespace is not embedded). */
  current_chunks: number;
  /** Embedded chunks after the re-chunk. */
  estimated_chunks: number;
  /** Tokens the embedding model is sent: chunk text plus overlap plus context. */
  estimated_embedding_tokens: number;
  /** The context model, when the target is contextual (else null and the two counts are 0). */
  context_model: string | null;
  /** Prompt tokens of the context calls, cache reads included (caching lowers the price, not this). */
  estimated_context_input_tokens: number;
  /** An upper bound: every call's reply at its maximum length. */
  estimated_context_output_tokens: number;
  /** The vision model, when the target has a vision mode (else null and the vision counts are 0). */
  vision_model: string | null;
  /** PDFs that would be read with the target's vision mode (a file's own static strategy keeps it). */
  vision_files: number;
  /** An upper bound: `max_pages_per_file` for each of those PDFs, whatever the mode selects and
   *  however long the file is. The stored chunks cannot say more: the highest page a chunk names is
   *  not the file's page count (trailing pages without text — what no_text and auto look for —
   *  produce no chunk), and the real count is not stored. */
  estimated_vision_pages: number;
  /** Those pages × the per-page estimate (≈ 1,250 tokens: image and prompt), within the ceilings. */
  estimated_vision_input_tokens: number;
  /** An upper bound: every page's reply at its maximum length, within the per-file ceiling. */
  estimated_vision_output_tokens: number;
  /** Vision is switched off on this gateway (FILE_SEARCH_VISION=off; always in the npm standalone
   *  CLI): a start with a vision mode is refused (`vision_model_unavailable`). */
  vision_switched_off: boolean;
  /** The target sends page images to the vision model while pseudonymization applies to file_search
   *  content: the images are not masked (visionTranscriber.ts VISION_UNMASKED_WARNING). */
  vision_unmasked_warning: boolean;
}

/** A file's embedded chunks in the active generation: how many, their stored token counts,
 *  and how many continue the piece before them (overlapping it by the setting's overlap). */
export interface FileChunkStats {
  chunks: number;
  tokens: number;
  continuations: number;
}

/** Structure chunks follow sections, most of them shorter than the maximum: on the evaluation
 *  corpus 41–159 chunks where an even fill of max_tokens would give 24–69. Half is assumed. */
export const STRUCTURE_FILL = 0.5;
/** Tokens a structure chunk's context adds to its embedding input: the heading path line. */
export const HEADING_CONTEXT_TOKENS = 12;
/** …and, when contextual, the LLM sentence(s) (measured replies 26–39 tokens; capped at 600 chars). */
export const SENTENCE_CONTEXT_TOKENS = 60;

function chunkCountFor(documentTokens: number, to: ChunkingSetting): number {
  if (documentTokens <= 0) return 0;
  const windows = documentTokens <= to.max_tokens
    ? 1 : 1 + Math.ceil((documentTokens - to.max_tokens) / (to.max_tokens - to.overlap_tokens));
  if (to.type === 'static') return windows;
  return Math.max(windows, Math.ceil(documentTokens / (STRUCTURE_FILL * to.max_tokens)));
}

/** Tokens a chunk's context adds to its embedding input under `to`. */
function perChunkContextTokens(to: ChunkingSetting): number {
  return to.type === 'structure' ? HEADING_CONTEXT_TOKENS + (to.contextual ? SENTENCE_CONTEXT_TOKENS : 0) : 0;
}

/** One file's estimate (pure). Exact chunk counts when only `contextual` changes between two
 *  structure settings of the same sizes: the chunker then cuts the same chunks. */
export function estimateFileRechunk(
  stats: FileChunkStats, from: ChunkingSetting, to: ChunkingSetting,
): { documentTokens: number; chunks: number; embeddingTokens: number } {
  if (stats.chunks <= 0) return { documentTokens: 0, chunks: 0, embeddingTokens: 0 };
  // The text once: every continuation repeated about `overlap` tokens of the piece before it.
  const documentTokens = Math.max(
    stats.tokens - stats.continuations * from.overlap_tokens, Math.ceil(stats.tokens / stats.chunks),
  );
  const sameCuts = from.type === 'structure' && to.type === 'structure'
    && from.max_tokens === to.max_tokens && from.overlap_tokens === to.overlap_tokens;
  if (!sameCuts) return { documentTokens, ...estimateDocumentChunks(documentTokens, to) };
  return { documentTokens, chunks: stats.chunks, embeddingTokens: stats.tokens + stats.chunks * perChunkContextTokens(to) };
}

/** The chunks and embedding tokens of a document of `documentTokens` tokens chunked by `to` (pure). */
export function estimateDocumentChunks(documentTokens: number, to: ChunkingSetting): { chunks: number; embeddingTokens: number } {
  const chunks = chunkCountFor(documentTokens, to);
  const text = documentTokens + Math.max(chunks - 1, 0) * to.overlap_tokens;
  return { chunks, embeddingTokens: chunks > 0 ? text + chunks * perChunkContextTokens(to) : 0 };
}

/**
 * One file's vision estimate (pure), or null when the file is not a PDF or `to` has no vision mode.
 * An honest upper bound: every PDF counts at the per-file page cap. The stored chunks give no page
 * count to lower it by — the highest page a chunk names misses trailing pages without text (no chunk
 * covers them, and they are exactly what no_text and auto send), and the file's real page count is
 * not stored (reading it would mean reading every blob).
 */
export function estimateFileVision(
  filename: string, to: ChunkingSetting, settings: VisionSettings,
): { pages: number; input: number; outputUpperBound: number } | null {
  if (visionModeOf(to) === 'off' || !isPdfFile(filename)) return null;
  return estimateVisionTokens(settings.maxPagesPerFile, settings);
}

export function storeSetting(raw: unknown): ChunkingSetting | null {
  try {
    return resolveChunking({ store: raw ?? null });
  } catch {
    return null; // an invalid stored setting: a re-chunk is how it gets a valid one
  }
}

/**
 * Embedded chunks of the store's active generation whose context holds no model-written sentence.
 * A context is `heading path \n sentence \n table header` (chunkPipeline.ts chunkContext), the parts
 * present; the heading path is also its own column and a table header's first line is a table row
 * (it holds a `|`), while a sentence is one line of plain text. So a chunk lacks its sentence when
 * its context, after a leading heading-path line, is empty or starts with a line holding `|`. A
 * sentence that itself holds a `|` counts as missing (a re-chunk it allows is harmless). Only
 * structured chunks count (`section` set): a file attached with an explicit static strategy stays
 * static through every re-chunk, and static and legacy rows have section, heading path and
 * context NULL, so counting them would offer a fill that never converges. Nor do the chunks of a file
 * whose contexts stopped at its token limit, or at its time limit again on the fill's retry
 * (contextStop.ts FINAL_CONTEXT_STOPS): another fill would stop there again. Counted only for a contextual setting; one index range over
 * the store's active generation.
 */
async function chunksWithoutContext(
  db: { query: PoolClient['query'] }, storeId: string, generation: number, setting: ChunkingSetting | null,
): Promise<number> {
  if (!setting?.contextual) return 0;
  const { rows: [row] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT CASE
                WHEN context IS NULL THEN ''
                WHEN heading_path IS NOT NULL AND context = heading_path THEN ''
                WHEN heading_path IS NOT NULL AND left(context, length(heading_path) + 1) = heading_path || E'\n'
                  THEN substr(context, length(heading_path) + 2)
                ELSE context
              END AS rest
         FROM vector_store_chunks
        WHERE store_id = $1 AND generation = $2 AND embedding IS NOT NULL AND section IS NOT NULL
          AND file_id NOT IN (SELECT file_id FROM vector_store_files
                               WHERE store_id = $1 AND context_stopped = ANY($3::text[]))) c
      WHERE rest = '' OR split_part(rest, E'\n', 1) LIKE '%|%'`,
    [storeId, generation, FINAL_CONTEXT_STOPS],
  );
  return Number(row?.n ?? 0);
}

/** The store row an estimate reads (owner-scoped; undefined when the owner has no such store): its
 *  setting, model and active generation, its unfinished re-embed or re-chunk, and whether its model
 *  was already found not served. */
export async function estimateStoreRow(ownerEmail: string, storeId: string): Promise<{
  id: string; chunking: unknown; embedding_model: string; active_generation: number;
  running_job_id: string | null; model_unavailable: boolean;
} | undefined> {
  const { rows: [store] } = await requirePool().query(
    `SELECT vs.id, vs.chunking, vs.embedding_model, vs.active_generation,
            (SELECT j.id FROM fs_jobs j WHERE j.store_id = vs.id AND j.kind = 'reembed_store'
                AND j.finished_at IS NULL LIMIT 1) AS running_job_id,
            (EXISTS (SELECT 1 FROM vector_store_files f
                      WHERE f.store_id = vs.id AND f.status = 'failed' AND f.last_error->>'name' = $3)
             OR EXISTS (SELECT 1 FROM fs_reembed_items i JOIN fs_jobs j ON j.id = i.job_id
                         WHERE i.store_id = vs.id AND i.status = 'failed' AND j.target_model = vs.embedding_model
                           AND i.last_error->>'name' = $3)) AS model_unavailable
       FROM vector_stores vs WHERE vs.id = $1 AND vs.owner_email = $2`,
    [storeId, ownerEmail, MODEL_UNAVAILABLE_ERROR_NAME],
  );
  return store;
}

/**
 * What re-chunking `storeId` of `ownerEmail` to `target` would cost, or null when the owner has
 * no such store (a shared store of another owner included). Reads one aggregate row per
 * completed file (counts and stored token sums of the active generation — no chunk text, no
 * blob, no embedding or LLM call): one index range over the store's active generation and one
 * row per file.
 */
export async function estimateRechunk(
  ownerEmail: string, storeId: string, target: ChunkingSetting,
): Promise<RechunkEstimate | null> {
  const pool = requirePool();
  const store = await estimateStoreRow(ownerEmail, storeId);
  if (!store) return null;
  // Two plain reads joined here rather than in SQL: a join of the files with the per-file
  // aggregate is planned as a nested loop over the aggregate when the statistics are stale (a
  // store just filled), re-aggregating the store's chunks once per file.
  const { rows: files } = await pool.query<{ file_id: string; chunking_strategy: unknown; filename: string }>(
    `SELECT vsf.file_id, vsf.chunking_strategy, f.filename
       FROM vector_store_files vsf JOIN fs_files f ON f.id = vsf.file_id
      WHERE vsf.store_id = $1 AND vsf.status = 'completed'`, [storeId]);
  const { rows: aggregates } = await pool.query<{
    file_id: string; chunks: number; tokens: string; continuations: number;
  }>(
    `SELECT file_id, COUNT(*)::int AS chunks, COALESCE(SUM(tokens), 0)::bigint AS tokens,
            COUNT(*) FILTER (WHERE section_offset > 0 OR (section IS NULL AND ord > 0))::int AS continuations
       FROM vector_store_chunks
      WHERE store_id = $1 AND generation = $2 AND embedding IS NOT NULL
      GROUP BY file_id`,
    [storeId, store.active_generation],
  );
  const statsOf = new Map(aggregates.map((a) => [a.file_id, a]));

  const current = storeSetting(store.chunking);
  const missingContexts = await chunksWithoutContext(pool, store.id, store.active_generation, current);
  const contextConfig = getFileSearchConfig().contextual;
  const contextSettings = {
    maxDocumentTokens: contextConfig?.maxDocumentTokens,
    maxInputTokensPerFile: contextConfig?.maxInputTokensPerFile,
  };
  const estimate: RechunkEstimate = {
    store_id: store.id,
    current,
    target,
    unchanged: current !== null && chunkingKey(current) === chunkingKey(target),
    chunks_without_context: missingContexts,
    running_job_id: store.running_job_id ?? null,
    embedding_model: store.embedding_model,
    embedding_model_unavailable: store.model_unavailable === true,
    files: files.length,
    current_chunks: 0,
    estimated_chunks: 0,
    estimated_embedding_tokens: 0,
    context_model: target.contextual ? contextConfig?.model ?? CONTEXT_WRITER_DEFAULTS.model : null,
    estimated_context_input_tokens: 0,
    estimated_context_output_tokens: 0,
    vision_model: null,
    vision_files: 0,
    estimated_vision_pages: 0,
    estimated_vision_input_tokens: 0,
    estimated_vision_output_tokens: 0,
    vision_switched_off: visionSwitchedOff() !== null,
    vision_unmasked_warning: visionImagesUnmasked(visionModeOf(target)),
  };
  const visionSettings = resolveVisionSettings();
  if (visionModeOf(target) !== 'off') estimate.vision_model = visionSettings.model;
  for (const row of files) {
    // Each file as it is chunked now and as it would be: its own static strategy wins in both.
    const from = resolveChunking({ file: row.chunking_strategy, store: current ?? null });
    const to = resolveChunking({ file: row.chunking_strategy, store: target });
    const aggregate = statsOf.get(row.file_id);
    const stats = aggregate
      ? { chunks: aggregate.chunks, tokens: Number(aggregate.tokens), continuations: aggregate.continuations }
      : { chunks: 0, tokens: 0, continuations: 0 };
    const file = estimateFileRechunk(stats, from, to);
    estimate.current_chunks += stats.chunks;
    estimate.estimated_chunks += file.chunks;
    estimate.estimated_embedding_tokens += file.embeddingTokens;
    if (to.contextual) {
      const context = estimateContextTokens(file.documentTokens, file.chunks, contextSettings);
      estimate.estimated_context_input_tokens += context.input;
      estimate.estimated_context_output_tokens += context.outputUpperBound;
    }
    const vision = estimateFileVision(row.filename, to, visionSettings);
    if (vision) {
      estimate.vision_files += 1;
      estimate.estimated_vision_pages += vision.pages;
      estimate.estimated_vision_input_tokens += vision.input;
      estimate.estimated_vision_output_tokens += vision.outputUpperBound;
    }
  }
  return estimate;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type RechunkRefusal = 'not_found' | 'store_dimension_mismatch' | 'store_expired' | 'reembed_running'
  | 'chunking_current' | 'store_model_unavailable' | 'context_model_unavailable' | 'vision_model_unavailable';

export type RechunkStartResult = { ok: true; job: JobSummary } | { ok: false; error: RechunkRefusal };

type StartCore = { ok: true; jobId: string; items: number } | { ok: false; error: RechunkRefusal };

const STORE_SQL = `SELECT id, owner_email, status, embedding_model, embedding_dim, active_generation, chunking
                     FROM vector_stores WHERE id = $1 AND owner_email = $2`;

/** Missing contexts a re-chunk to the store's own setting would fill (0 for any other target). */
async function contextsToFill(db: { query: PoolClient['query'] }, store: any, target: ChunkingSetting): Promise<number> {
  if (!store) return 0;
  const current = storeSetting(store.chunking);
  if (current === null || chunkingKey(current) !== chunkingKey(target)) return 0;
  return chunksWithoutContext(db, store.id, store.active_generation, current);
}
const RUNNING_SQL = `SELECT 1 FROM fs_jobs WHERE store_id = $1 AND kind = 'reembed_store' AND finished_at IS NULL`;

/** The refusals a store's row and its running job decide (all but the model checks). A target
 *  equal to the store's setting is current unless it fills `missingContexts` missing contexts. */
function refusalOf(store: any, running: boolean, target: ChunkingSetting, missingContexts: number): RechunkRefusal | null {
  if (!store) return 'not_found';
  const config = getFileSearchConfig();
  // The vector column has the configured width: such a store takes no new chunks at all.
  if (embeddingState(store, { embeddingModel: config.embeddingModel, embeddingDimensions: config.embeddingDimensions })
    === 'dimension_mismatch') return 'store_dimension_mismatch';
  if (store.status === 'expired') return 'store_expired';
  if (running) return 'reembed_running';
  const current = storeSetting(store.chunking);
  if (current !== null && chunkingKey(current) === chunkingKey(target) && missingContexts === 0) return 'chunking_current';
  return null;
}

async function startInTransaction(
  client: PoolClient, ownerEmail: string, storeId: string, target: ChunkingSetting, actor: ReembedActor,
): Promise<StartCore> {
  const { rows: [store] } = await client.query(`${STORE_SQL} FOR UPDATE`, [storeId, ownerEmail]);
  const running = store ? ((await client.query(RUNNING_SQL, [storeId])).rowCount ?? 0) > 0 : false;
  const refusal = refusalOf(store, running, target, await contextsToFill(client, store, target));
  if (refusal) return { ok: false, error: refusal };
  // The store's own model: a re-chunk changes how the files are cut, never the model (an
  // outdated store stays outdated and is re-embedded on its own).
  return insertStoreJob(client, store, actor, null, {
    model: store.embedding_model,
    dim: store.embedding_dim,
    chunking: { ...target },
  });
}

/** How long the start waits for its one-text check of the store's model. */
const MODEL_CHECK_TIMEOUT_MS = 15_000;

/**
 * Whether the orchestration still serves `store`'s embedding model, asked with one short text
 * (a few tokens, billed like the re-chunk's embeddings). Only the embedder's own "not served"
 * answer counts as no: any other failure (a timeout, a 5xx) lets the start go on, and the job
 * then stops at its first item that finds the model not served (reembedWorker.ts).
 */
async function modelServed(
  store: { id: string; embedding_model: string; embedding_dim: number }, ownerEmail: string, actor: ReembedActor,
): Promise<boolean> {
  const caller = storedFileSearchCaller(actor.credentialId ?? null, actor.authType ?? null, ownerEmail);
  try {
    await embed(['model check'], 'query', { model: store.embedding_model, dimensions: store.embedding_dim }, {
      deadline: Date.now() + MODEL_CHECK_TIMEOUT_MS,
      onUsage: (u) => emitFileSearchUsage(caller, {
        endpoint: 'file_search/reembed',
        model: store.embedding_model,
        inputTokens: u.promptTokens,
        unit: 'tokens',
        responseTime: u.elapsedMs,
        requestId: workerRequestId('reembed'),
      }),
    });
    return true;
  } catch (error) {
    if (error instanceof EmbeddingModelUnavailableError) return false;
    logger.warn('Rechunk', 'Could not check the store\'s embedding model before a re-chunk; starting anyway', {
      storeId: store.id, error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * Whether the context model answers, asked with one tiny context call (billed as
 * `file_search/context` usage of the owner, like the re-chunk's contexts). Only a refusal or a
 * missing deployment counts as no; a timeout or a 5xx lets the start go on with a warning (the
 * writer then leaves chunks without contexts, which a same-setting re-chunk can fill later).
 */
async function contextModelServed(store: { id: string }, ownerEmail: string, actor: ReembedActor): Promise<boolean> {
  const caller = storedFileSearchCaller(actor.credentialId ?? null, actor.authType ?? null, ownerEmail);
  const check = await checkContextModel({
    onCall: (r) => emitFileSearchUsage(caller, {
      ...completionUsageRecord('file_search/context', r.model, r.usage, r.elapsedMs),
      requestId: workerRequestId('context'),
    }),
  });
  if (check.result === 'unknown') {
    logger.warn('Rechunk', 'Could not check the context model before a re-chunk; starting anyway', {
      storeId: store.id, model: check.model,
    });
  }
  return check.result !== 'unavailable';
}

/**
 * Whether the vision model reads an image, asked with one tiny call (a blank 16 × 16 image, billed as
 * `file_search/vision` usage of the owner, like the re-chunk's transcriptions). 'unavailable' —
 * refused, no deployment, or vision switched off on this gateway (no call then) — is no; a timeout
 * or a 5xx lets the start go on with a warning (pages whose calls fail keep their text or go to OCR).
 */
async function visionModelServed(store: { id: string }, ownerEmail: string, actor: ReembedActor): Promise<boolean> {
  const caller = storedFileSearchCaller(actor.credentialId ?? null, actor.authType ?? null, ownerEmail);
  const check = await checkVisionModel({
    onCall: (r) => emitFileSearchUsage(caller, {
      ...completionUsageRecord('file_search/vision', r.model, r.usage, r.elapsedMs),
      requestId: workerRequestId('vision'),
    }),
  });
  if (check.result === 'unknown') {
    logger.warn('Rechunk', 'Could not check the vision model before a re-chunk; starting anyway', {
      storeId: store.id, model: check.model,
    });
  }
  return check.result !== 'unavailable';
}

/**
 * The models a job chunking files again by `target` calls, each checked with one tiny billed call
 * (the store's embedding model; the context model when contextual; the vision model with a vision
 * mode): the refusal of the first not served, or null. Shared with the re-extract (reextract.ts).
 */
export async function unservedModel(
  store: { id: string; embedding_model: string; embedding_dim: number }, ownerEmail: string, actor: ReembedActor,
  target: ChunkingSetting,
): Promise<'store_model_unavailable' | 'context_model_unavailable' | 'vision_model_unavailable' | null> {
  if (!(await modelServed(store, ownerEmail, actor))) return 'store_model_unavailable';
  if (target.contextual && !(await contextModelServed(store, ownerEmail, actor))) return 'context_model_unavailable';
  if (visionModeOf(target) !== 'off' && !(await visionModelServed(store, ownerEmail, actor))) return 'vision_model_unavailable';
  return null;
}

/**
 * Starts re-chunking `storeId` of `ownerEmail` to `target` (validated by the caller), pinned on
 * the job. Owner-scoped like startReembed: the admin entry resolves the owner first and passes
 * it, with the admin as `actor`. Refuses an unknown store, a store whose dimension differs from
 * the configuration, an expired store, a store with a re-embed or re-chunk running, a target
 * equal to the store's setting (unless it is contextual and fills missing contexts), a contextual
 * target whose context model is not served (`context_model_unavailable`), a target with a vision
 * mode whose vision model is not served or where vision is switched off
 * (`vision_model_unavailable`), and a store whose
 * embedding model is no longer served
 * (`store_model_unavailable`: every file would be extracted and given contexts, then fail on
 * its embedding — the store needs a re-embed first). The refusals are checked once before the
 * model check (no call for a start that is refused anyway) and again under the store lock. An
 * empty store switches at once.
 */
export async function startRechunk(
  ownerEmail: string, storeId: string, target: ChunkingSetting, actor: ReembedActor,
): Promise<RechunkStartResult> {
  const pool = requirePool();
  const { rows: [store] } = await pool.query(STORE_SQL, [storeId, ownerEmail]);
  const running = store ? ((await pool.query(RUNNING_SQL, [storeId])).rowCount ?? 0) > 0 : false;
  const early = refusalOf(store, running, target, await contextsToFill(pool, store, target));
  if (early) return { ok: false, error: early };
  const unserved = await unservedModel(store, ownerEmail, actor, target);
  if (unserved) return { ok: false, error: unserved };
  const vision = visionModeOf(target);

  let started: StartCore;
  try {
    started = await inTransaction<StartCore>(async (client) => {
      const value = await startInTransaction(client, ownerEmail, storeId, target, actor);
      return { commit: value.ok, value };
    });
  } catch (error: any) {
    // The unique "one running re-embed per store" index: a concurrent start won.
    if (error?.code === '23505') return { ok: false, error: 'reembed_running' };
    throw error;
  }
  if (!started.ok) return started;
  warnVisionUnmasked(vision, { storeId, jobId: started.jobId });
  await afterStart(storeId, started.jobId, started.items);
  const job = await jobSummary(started.jobId, ownerEmail);
  if (!job) throw new Error('rechunk job vanished right after its start');
  return { ok: true, job };
}
