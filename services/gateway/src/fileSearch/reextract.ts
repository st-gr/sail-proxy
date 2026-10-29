// RE-EXTRACTION (W3) — files a store's ingestion read before the extractors improved are read again
// on the owner's (or an admin's) request, after an estimate; never automatically on an upgrade.
// Nothing here is HTTP-aware; the grounding routes (owner and admin) call these functions.
//
// WHICH FILES. Every ingestion stamps the file with the extractor version it read it with
// (vector_store_files.extraction_version = registry.ts EXTRACTION_VERSION; NULL = read before the
// stamp existed). A completed file is AFFECTED when its format is read better since its version
// (registry.ts readBetterNow): with version 1 that is every PDF read before W3 — OCR of pages without
// text, page numbers, and the store's vision mode. Once read again it carries the current version
// and is never affected again, until a later version names its format. A file is affected too when
// its read left pages without text because OCR could not run there (vector_store_files.ocr_pending:
// OCR switched off, as in the npm standalone CLI, or tesseract missing) and OCR runs on this gateway
// now; pages past the OCR cap or whose OCR failed never make it pending (registry.ts readAgain, the
// same rule for the selection here and the worker's items). Every other completed file is KEPT.
// A failed file refused as an unsupported type that this build reads (PowerPoint, Excel, and .doc
// where antiword runs) never had chunks: the start queues it again through the file retry
// (jobs.ts retryFile), as the Retry of a failed file in the cockpit does — it is then read like a
// new upload.
//
// HOW. A re-extract is a re-chunk (rechunk.ts) to the store's own setting with `fs_jobs.reextract`
// set: the same job, items, claim, lease, retry, cancel and the one-unfinished-job-per-store index.
// An affected file's item reads its blob and chunks it again, as a re-chunk item does; a kept file's
// item copies its rows with their vectors into the new generation (no extraction, no embedding). The
// switch (reembedWorker.ts finalizeJob) leaves the store's setting as it is and stamps the files the
// job read. So the store answers from its old chunks until the switch, a cancel keeps them, and a
// failed job keeps them too (Retry continues, Cancel discards).
//
// COST. An affected file costs what its re-chunk costs: the embeddings, the contexts when the
// setting is contextual, and vision when it has a mode. The estimate counts each, from the file's
// chunks now; a PDF without a single chunk (scanned, so OCR or vision may read it now) is counted at
// the most pages they read of one file, with an assumed amount of text per page; vision as for a
// re-chunk, an upper bound.
import type { PoolClient } from 'pg';
import { getFileSearchConfig } from '../services/configService';
import { ChunkingSetting, resolveChunking } from './chunkingSetting';
import { CONTEXT_WRITER_DEFAULTS, estimateContextTokens } from './contextWriter';
import { embeddingState } from './embeddingState';
import { isOcrEnabled } from './extractors/ocrAvailability';
import { OCR_LIMITS } from './extractors/pdfOcr';
import { isPdfFile, isSupportedFilename, readAgain, UnsupportedFileTypeError } from './extractors/registry';
import { jobSummary, JobSummary, retryFile } from './jobs';
import {
  estimateDocumentChunks, estimateFileRechunk, estimateFileVision, estimateStoreRow, storeSetting, unservedModel,
} from './rechunk';
import { afterStart, insertStoreJob, ReembedActor } from './reembed';
import { inTransaction, requirePool } from './reembedWorker';
import {
  resolveVisionSettings, visionImagesUnmasked, visionModeOf, visionSwitchedOff, warnVisionUnmasked,
} from './visionTranscriber';

/** The `name` a refused type is persisted under (serializeError keeps it). */
const UNSUPPORTED_ERROR_NAME = new UnsupportedFileTypeError('x').name;

/** Text tokens assumed per OCR page in the estimate (a full page of running text is about this). */
export const OCR_TOKENS_PER_PAGE = 500;

export interface ReextractEstimate {
  store_id: string;
  /** The store's setting the files are chunked with again (NULL = static 800/400); null when the
   *  stored value is invalid: a start is then refused (`store_chunking_invalid`). */
  setting: ChunkingSetting | null;
  /** The store's unfinished re-embed or re-chunk, which a start with files to read waits for (409). */
  running_job_id: string | null;
  embedding_model: string;
  /** The store's model was already found not served: a start would answer `store_model_unavailable`. */
  embedding_model_unavailable: boolean;
  /** Completed files read again: their format is read better now than when they were read, or OCR runs
   *  here now on pages their read left without text. */
  files: number;
  /** Completed files kept as they are (copied with their vectors: no cost). */
  kept_files: number;
  /** OCR runs on this gateway (never in the npm standalone CLI): pages without text are read. */
  ocr_available: boolean;
  /** Of `files`: PDFs without a single embedded chunk now (scanned) that OCR or the store's vision mode
   *  may read now, each counted at the most pages either reads of one file × `OCR_TOKENS_PER_PAGE`. */
  files_without_text: number;
  /** Embedded chunks of the files read again, now. */
  current_chunks: number;
  /** Their embedded chunks afterwards, and the tokens the embedding model is sent (estimates). */
  estimated_chunks: number;
  estimated_embedding_tokens: number;
  /** The context model when the setting is contextual (else null and the two counts are 0). */
  context_model: string | null;
  estimated_context_input_tokens: number;
  /** An upper bound: every call's reply at its maximum length. */
  estimated_context_output_tokens: number;
  /** The vision fields as for a re-chunk (rechunk.ts RechunkEstimate), over the PDFs read again. */
  vision_model: string | null;
  vision_files: number;
  estimated_vision_pages: number;
  estimated_vision_input_tokens: number;
  estimated_vision_output_tokens: number;
  vision_switched_off: boolean;
  vision_unmasked_warning: boolean;
  /** Failed files refused as an unsupported type that this build reads (PowerPoint, Excel, and .doc
   *  where antiword runs): a start queues them again, and they are read like a new upload. */
  retry_files: number;
}

interface CompletedFile {
  file_id: string; chunking_strategy: unknown; filename: string; extraction_version: number | null; ocr_pending: boolean | null;
}

const COMPLETED_FILES_SQL = `SELECT vsf.file_id, vsf.chunking_strategy, vsf.extraction_version, vsf.ocr_pending, f.filename
                               FROM vector_store_files vsf JOIN fs_files f ON f.id = vsf.file_id
                              WHERE vsf.store_id = $1 AND vsf.status = 'completed'`;

/** The store's files a re-extract acts on: the completed files it reads again (`ocrEnabled`: OCR runs on
 *  this gateway), and the failed files it queues again. One read of the completed members and one of
 *  the failed ones. */
async function filesOf(db: { query: PoolClient['query'] }, storeId: string, ocrEnabled: boolean): Promise<{
  affected: CompletedFile[]; kept: number; retry: string[];
}> {
  const { rows } = await db.query<CompletedFile>(COMPLETED_FILES_SQL, [storeId]);
  const affected = rows.filter((r) => readAgain(r.filename, r.extraction_version, r.ocr_pending, ocrEnabled));
  const { rows: failed } = await db.query<{ file_id: string; filename: string }>(
    `SELECT vsf.file_id, f.filename FROM vector_store_files vsf JOIN fs_files f ON f.id = vsf.file_id
      WHERE vsf.store_id = $1 AND vsf.status = 'failed' AND vsf.last_error->>'name' = $2
      ORDER BY vsf.file_id`, [storeId, UNSUPPORTED_ERROR_NAME]);
  return {
    affected,
    kept: rows.length - affected.length,
    retry: failed.filter((r) => isSupportedFilename(r.filename)).map((r) => r.file_id),
  };
}

/**
 * What re-extracting `storeId` of `ownerEmail` would cost, or null when the owner has no such store
 * (a shared store of another owner included). No blob, embedding or model call: the store row, its
 * members, and one aggregate row per file read again (counts and stored token sums of the active
 * generation, over those files only).
 */
export async function estimateReextract(ownerEmail: string, storeId: string): Promise<ReextractEstimate | null> {
  const pool = requirePool();
  const store = await estimateStoreRow(ownerEmail, storeId);
  if (!store) return null;
  const ocr = await isOcrEnabled();
  const { affected, kept, retry } = await filesOf(pool, store.id, ocr);
  const setting = storeSetting(store.chunking);
  const estimate: ReextractEstimate = {
    store_id: store.id,
    setting,
    running_job_id: store.running_job_id ?? null,
    embedding_model: store.embedding_model,
    embedding_model_unavailable: store.model_unavailable === true,
    files: affected.length,
    kept_files: kept,
    ocr_available: ocr,
    files_without_text: 0,
    current_chunks: 0,
    estimated_chunks: 0,
    estimated_embedding_tokens: 0,
    context_model: null,
    estimated_context_input_tokens: 0,
    estimated_context_output_tokens: 0,
    vision_model: null,
    vision_files: 0,
    estimated_vision_pages: 0,
    estimated_vision_input_tokens: 0,
    estimated_vision_output_tokens: 0,
    vision_switched_off: visionSwitchedOff() !== null,
    vision_unmasked_warning: false,
    retry_files: retry.length,
  };
  if (setting === null || affected.length === 0) return estimate;

  const { rows: aggregates } = await pool.query<{ file_id: string; chunks: number; tokens: string; continuations: number }>(
    `SELECT file_id, COUNT(*)::int AS chunks, COALESCE(SUM(tokens), 0)::bigint AS tokens,
            COUNT(*) FILTER (WHERE section_offset > 0 OR (section IS NULL AND ord > 0))::int AS continuations
       FROM vector_store_chunks
      WHERE store_id = $1 AND generation = $2 AND embedding IS NOT NULL AND file_id = ANY($3::text[])
      GROUP BY file_id`,
    [store.id, store.active_generation, affected.map((f) => f.file_id)],
  );
  const statsOf = new Map(aggregates.map((a) => [a.file_id, a]));
  const contextConfig = getFileSearchConfig().contextual;
  const contextSettings = { maxDocumentTokens: contextConfig?.maxDocumentTokens, maxInputTokensPerFile: contextConfig?.maxInputTokensPerFile };
  const visionSettings = resolveVisionSettings();
  if (setting.contextual) estimate.context_model = contextConfig?.model ?? CONTEXT_WRITER_DEFAULTS.model;
  const visionOn = visionModeOf(setting) !== 'off';
  if (visionOn) {
    estimate.vision_model = visionSettings.model;
    estimate.vision_unmasked_warning = visionImagesUnmasked(visionModeOf(setting));
  }
  // The most pages of a PDF without text OCR or vision reads (a file-static PDF keeps the store's mode).
  const textlessPages = Math.max(ocr ? OCR_LIMITS.maxPagesPerFile : 0, visionOn ? visionSettings.maxPagesPerFile : 0);
  for (const file of affected) {
    // The file as it is chunked now: its own static strategy wins.
    const to = resolveChunking({ file: file.chunking_strategy, store: setting });
    const vision = estimateFileVision(file.filename, to, visionSettings);
    if (vision) {
      estimate.vision_files += 1;
      estimate.estimated_vision_pages += vision.pages;
      estimate.estimated_vision_input_tokens += vision.input;
      estimate.estimated_vision_output_tokens += vision.outputUpperBound;
    }
    const aggregate = statsOf.get(file.file_id);
    let chunks: number;
    let embeddingTokens: number;
    let documentTokens: number;
    if (aggregate) {
      const stats = { chunks: aggregate.chunks, tokens: Number(aggregate.tokens), continuations: aggregate.continuations };
      ({ chunks, embeddingTokens, documentTokens } = estimateFileRechunk(stats, to, to));
      estimate.current_chunks += stats.chunks;
    } else if (textlessPages > 0 && isPdfFile(file.filename)) {
      estimate.files_without_text += 1;
      documentTokens = textlessPages * OCR_TOKENS_PER_PAGE;
      ({ chunks, embeddingTokens } = estimateDocumentChunks(documentTokens, to));
    } else {
      continue; // no text now, and nothing that would read any
    }
    estimate.estimated_chunks += chunks;
    estimate.estimated_embedding_tokens += embeddingTokens;
    if (to.contextual) {
      const context = estimateContextTokens(documentTokens, chunks, contextSettings);
      estimate.estimated_context_input_tokens += context.input;
      estimate.estimated_context_output_tokens += context.outputUpperBound;
    }
  }
  return estimate;
}

export type ReextractRefusal = 'not_found' | 'store_dimension_mismatch' | 'store_expired' | 'reembed_running'
  | 'nothing_to_reextract' | 'store_chunking_invalid' | 'store_model_unavailable' | 'context_model_unavailable'
  | 'vision_model_unavailable';

/** `job`: the re-extract job, or null when no completed file needed it (only failed files were queued
 *  again); `retried_files`: the failed files queued again; `refused_files`: those the file retry refused,
 *  with its reason (`job_running`: a file of their batch is still being read; `nothing_to_retry`: the batch
 *  was cancelled, or the file is no longer failed). */
export type ReextractStartResult =
  | { ok: true; job: JobSummary | null; retried_files: number; refused_files: Array<{ file_id: string; error: string }> }
  | { ok: false; error: ReextractRefusal };

const STORE_SQL = `SELECT id, owner_email, status, embedding_model, embedding_dim, active_generation, chunking
                     FROM vector_stores WHERE id = $1 AND owner_email = $2`;
const RUNNING_SQL = `SELECT 1 FROM fs_jobs WHERE store_id = $1 AND kind = 'reembed_store' AND finished_at IS NULL`;

/** The refusals the store row, its running job and its files decide (all but the model checks). */
function refusalOf(store: any, running: boolean, affected: number, retry: number): ReextractRefusal | null {
  if (!store) return 'not_found';
  const config = getFileSearchConfig();
  if (embeddingState(store, { embeddingModel: config.embeddingModel, embeddingDimensions: config.embeddingDimensions })
    === 'dimension_mismatch') return 'store_dimension_mismatch';
  if (store.status === 'expired') return 'store_expired';
  if (affected === 0) return retry === 0 ? 'nothing_to_reextract' : null;
  if (running) return 'reembed_running';
  if (storeSetting(store.chunking) === null) return 'store_chunking_invalid';
  return null;
}

type StartCore = { ok: true; jobId: string | null; items: number } | { ok: false; error: ReextractRefusal };

/**
 * Starts re-extracting `storeId` of `ownerEmail` (the admin entry resolves the owner first and passes
 * it, with the admin as `actor`). Refuses an unknown store, a store whose dimension differs from the
 * configuration, an expired store, a store with nothing to read or queue again
 * (`nothing_to_reextract`), and — when completed files are to be read again — a store with a re-embed
 * or re-chunk running, a store whose setting is invalid (`store_chunking_invalid`: change the
 * chunking instead) and a model of the job not served (the re-chunk's checks: one tiny billed call
 * each). The refusals are checked before the model checks and again under the store lock. With no
 * completed file to read again, only the failed files are queued (no job, no call).
 */
export async function startReextract(ownerEmail: string, storeId: string, actor: ReembedActor): Promise<ReextractStartResult> {
  const pool = requirePool();
  const { rows: [store] } = await pool.query(STORE_SQL, [storeId, ownerEmail]);
  // OCR availability is asked once: the selection under the lock uses the same answer.
  const ocrEnabled = store ? await isOcrEnabled() : false;
  const early = store ? await filesOf(pool, storeId, ocrEnabled) : { affected: [], kept: 0, retry: [] };
  const running = store ? ((await pool.query(RUNNING_SQL, [storeId])).rowCount ?? 0) > 0 : false;
  const refusal = refusalOf(store, running, early.affected.length, early.retry.length);
  if (refusal) return { ok: false, error: refusal };

  let started: StartCore = { ok: true, jobId: null, items: 0 };
  if (early.affected.length > 0) {
    const setting = storeSetting(store.chunking) as ChunkingSetting;
    const unserved = await unservedModel(store, ownerEmail, actor, setting);
    if (unserved) return { ok: false, error: unserved };
    try {
      started = await inTransaction<StartCore>(async (client) => {
        const { rows: [locked] } = await client.query(`${STORE_SQL} FOR UPDATE`, [storeId, ownerEmail]);
        const files = locked ? await filesOf(client, storeId, ocrEnabled) : { affected: [], kept: 0, retry: [] };
        const busy = locked ? ((await client.query(RUNNING_SQL, [storeId])).rowCount ?? 0) > 0 : false;
        const late = refusalOf(locked, busy, files.affected.length, files.retry.length);
        if (late) return { commit: false, value: { ok: false, error: late } };
        // Read again meanwhile (an upload of the same files, a re-chunk that switched): only the queue is left.
        if (files.affected.length === 0) return { commit: false, value: { ok: true, jobId: null, items: 0 } };
        const value = await insertStoreJob(client, locked, actor, null, {
          model: locked.embedding_model,
          dim: locked.embedding_dim,
          chunking: { ...(storeSetting(locked.chunking) as ChunkingSetting) },
          reextract: true,
        });
        return { commit: true, value };
      });
    } catch (error: any) {
      // The unique "one running re-embed per store" index: a concurrent start won.
      if (error?.code === '23505') return { ok: false, error: 'reembed_running' };
      throw error;
    }
    if (!started.ok) return started;
    if (started.jobId) {
      warnVisionUnmasked(visionModeOf(setting), { storeId, jobId: started.jobId });
      await afterStart(storeId, started.jobId, started.items);
    }
  }

  // The failed files this build reads now, through the file retry (its batch rules, its queue).
  // Every refusal is answered (refused_files), so a start whose queuing was refused says why.
  let retried = 0;
  const refused: Array<{ file_id: string; error: string }> = [];
  for (const fileId of early.retry) {
    // eslint-disable-next-line no-await-in-loop
    const result = await retryFile(storeId, fileId, ownerEmail);
    if (result.ok) retried += 1;
    else refused.push({ file_id: fileId, error: result.error });
  }
  if (!started.jobId && early.retry.length === 0) return { ok: false, error: 'nothing_to_reextract' };
  const job = started.jobId ? await jobSummary(started.jobId, ownerEmail) : null;
  if (started.jobId && !job) throw new Error('reextract job vanished right after its start');
  return { ok: true, job, retried_files: retried, refused_files: refused };
}
