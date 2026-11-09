// RE-EMBEDDING, the worker side (plan Decisions 4 and 6): the work-item queue
// the ingest worker's loops drain when no upload is waiting, the switch that
// ends a job, and the settling of jobs nothing else will finish. The routes'
// side — estimates, start, cancel, retry — is reembed.ts, whose module comment
// describes generations, items and the lock order every function here keeps.
import type { Pool, PoolClient } from 'pg';
import { getPool } from './db';
import { FileSearchBusyError } from './dbBusy';
import { getFileSearchConfig } from '../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { embed, EmbeddingModelUnavailableError } from './embedder';
import { enqueueIngestion } from './repository';
import { publishIngestHint } from './ingestHint';
import {
  LEASE_MINUTES, BUSY_RETRY_SECONDS, BUSY_HANDBACK_SET, BUSY_HANDBACK_LAST_ERROR_SQL, PROCESS_BUDGET_MS, serializeError,
} from './workQueue';
import { emitFileSearchUsage, storedFileSearchCaller, workerRequestId } from './usage';
import { embeddingInputOf, insertChunkRows } from './chunkRows';
import { openBlob } from './blob/blobStore';
import { EXTRACTION_VERSION, readAgain, UnsupportedFileTypeError } from './extractors/registry';
import { isOcrEnabled } from './extractors/ocrAvailability';
import { DocumentReadError } from './extractors/ooxml/limits';
import { ChunkingStrategyError, chunkingKey, resolveChunking } from './chunkingSetting';
import {
  ContextTotals, estimatedChunkCount, ExtractedSize, FileHasTooManyChunksError, FileTooLargeError, maxChunksPerFile, prepareFileChunks,
} from './chunkPipeline';
import { busyReason, FileMemory, FileSearchMemoryBusyError, MAX_MEMORY_HANDBACKS, textReserveBytes, vectorReserveBytes } from './memoryBudget';
import { StructureChunkOutOfMemoryError } from './structureChunkThread';
import { recordedContextStop } from './contextStop';
import { addJobContextTotals, addJobOcrTotals, OcrCounters } from './jobs';
import { logOcrTotals, OcrMemo, ocrPendingOf } from './extractors/pdfOcr';
import { logVisionTotals, VisionMemo } from './visionTranscriber';
import { withLatestSapTarget } from '../sap/sapTarget';

const logger = getDefaultLogger();

export function requirePool(): Pool {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  return pool;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  // Swallowed: a failing ROLLBACK fires precisely when the connection is already
  // broken, and throwing it would replace the error that explains why.
  await client.query('ROLLBACK').catch(() => {});
}

/** Runs `work` in a transaction. `work` returns `commit: false` to roll back
 *  a refusal or a no-op without an error. */
export async function inTransaction<T>(work: (client: PoolClient) => Promise<{ commit: boolean; value: T }>): Promise<T> {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const { commit, value } = await work(client);
    if (commit) await client.query('COMMIT');
    else await rollbackQuietly(client);
    return value;
  } catch (e) {
    await rollbackQuietly(client);
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The work-item queue (Decision 4)
// ---------------------------------------------------------------------------

export interface ReembedItem {
  jobId: string;
  storeId: string;
  fileId: string;
}

/**
 * Items that exhausted their attempts while their lease expired (the worker died
 * mid-item) turn `failed`, like ingestion's zombies; their jobs are finished
 * afterwards when nothing else is open.
 */
async function reapReembedZombies(maxRetries: number): Promise<void> {
  const { rows } = await requirePool().query<{ job_id: string }>(
    `UPDATE fs_reembed_items
        SET status = 'failed', claimed_at = NULL, last_error = $2::jsonb
      WHERE (job_id, file_id) IN (
        SELECT job_id, file_id FROM fs_reembed_items
         WHERE status = 'in_progress' AND attempts >= $1
           AND (claimed_at IS NULL OR claimed_at < now() - ($3::int * interval '1 minute'))
         ORDER BY job_id, file_id
         FOR UPDATE)
      RETURNING job_id`,
    [maxRetries, JSON.stringify({
      message: 'Re-embedding was interrupted after exhausting its retry budget (the worker likely crashed or restarted mid-attempt).',
      name: 'MaxRetriesExceededZombie',
    }), LEASE_MINUTES],
  );
  for (const jobId of [...new Set(rows.map((r) => r.job_id))].sort()) {
    // eslint-disable-next-line no-await-in-loop
    await finalizeJob(jobId);
  }
}

/**
 * Claims the oldest open item of a job that is neither cancelled nor finished:
 * lease free or expired, under the retry budget (`ingestion.maxRetries`). The
 * pick is a CTE with FOR UPDATE SKIP LOCKED, so one claim takes exactly one row
 * (see claimNext in ingestWorker.ts and db0d2b27). Stamps `started_at` on the
 * job and its bulk parent at the first claim.
 */
export async function claimNextReembedItem(): Promise<ReembedItem | null> {
  const pool = getPool();
  if (!pool) return null;
  const { maxRetries } = getFileSearchConfig().ingestion;
  await reapReembedZombies(maxRetries);
  const { rows } = await pool.query<{ job_id: string; store_id: string; file_id: string }>(
    `WITH picked AS (
       SELECT i.job_id, i.file_id FROM fs_reembed_items i
         JOIN fs_jobs j ON j.id = i.job_id
        WHERE i.status = 'in_progress'
          AND (i.claimed_at IS NULL OR i.claimed_at < now() - ($2::int * interval '1 minute'))
          AND i.attempts < $1
          AND NOT j.cancel_requested AND j.finished_at IS NULL
        ORDER BY i.created_at LIMIT 1
        FOR UPDATE OF i SKIP LOCKED)
     UPDATE fs_reembed_items it SET claimed_at = now(), attempts = it.attempts + 1
       FROM picked
      WHERE it.job_id = picked.job_id AND it.file_id = picked.file_id
     RETURNING it.job_id, it.store_id, it.file_id`,
    [maxRetries, LEASE_MINUTES],
  );
  if (rows.length === 0) return null;
  const item = { jobId: rows[0].job_id, storeId: rows[0].store_id, fileId: rows[0].file_id };
  // Separate autocommitted statements, one row each: never two job rows locked
  // at once outside the stores-first order. A failure only delays the stamp.
  try {
    const job = await pool.query<{ parent_id: string | null }>(
      'UPDATE fs_jobs SET started_at = COALESCE(started_at, now()) WHERE id = $1 RETURNING parent_id', [item.jobId]);
    const parentId = job.rows[0]?.parent_id;
    if (parentId) {
      await pool.query('UPDATE fs_jobs SET started_at = now() WHERE id = $1 AND started_at IS NULL', [parentId]);
    }
  } catch (error) {
    logger.warn('Reembed', 'Could not stamp the job\'s started_at; the next claim retries it', {
      jobId: item.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return item;
}

type ItemCommit = 'committed' | 'last' | 'skipped';

/** A chunk row for the target generation: the source generation's row (a re-embed copies it)
 *  or the file chunked again by the job's setting (a re-chunk). */
interface SourceChunk {
  ord: number;
  text: string;
  tokens: number | null;
  context: string | null;
  section: number | null;
  section_offset: number | null;
  heading_path: string | null;
  page_start: number | null;
  page_end: number | null;
}

/** How an item's chunks reach the target generation besides `chunks`: `copy` — a re-extract's file
 *  read by the current extractors already — copies the source generation's rows with their vectors
 *  (no embedding); `extractionVersion` is the extractor version the item read the file with (null when
 *  it did not read it), which the switch writes to the file. */
interface ItemCommitOptions {
  context?: ContextTotals;
  ocr?: OcrCounters;
  copy?: boolean;
  extractionVersion?: number | null;
  /** A re-chunk's file context stop for the target generation (contextStop.ts), which the switch writes to the file. */
  contextStopped?: string | null;
}

/**
 * Writes one item's chunks into the job's target generation and completes the
 * item (adding a re-chunk's context spend and OCR page counts to the job), after re-checking under the lock order that the store still reads the
 * source generation, the file is still a completed member of the store, and the
 * job is neither cancelled nor finished. A file that is no longer a completed
 * member drops its item. Returns 'last' when no item of the job is open any more.
 */
async function commitItem(
  item: ReembedItem, sourceGeneration: number, chunks: SourceChunk[], vectors: Array<Float32Array | number[] | null>, tokens: number,
  options: ItemCommitOptions = {},
): Promise<ItemCommit> {
  const { context, ocr } = options;
  return inTransaction<ItemCommit>(async (client) => {
    const skip = { commit: false, value: 'skipped' as ItemCommit };
    const store = await client.query<{ active_generation: number }>(
      'SELECT active_generation FROM vector_stores WHERE id = $1 FOR SHARE', [item.storeId]);
    if (store.rowCount === 0 || store.rows[0].active_generation !== sourceGeneration) return skip;
    const file = await client.query<{ status: string }>(
      'SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2 FOR SHARE', [item.storeId, item.fileId]);
    if (file.rowCount === 0 || file.rows[0].status !== 'completed') {
      await client.query(
        `DELETE FROM fs_reembed_items WHERE job_id = $1 AND file_id = $2 AND status = 'in_progress'`,
        [item.jobId, item.fileId]);
      return { commit: true, value: 'skipped' };
    }
    // Every change of the job's state takes the store FOR UPDATE, which this
    // transaction's FOR SHARE excludes until it ends. The row is still locked
    // here — the lock the token UPDATE below takes anyway — so the job is locked
    // before its item (jobs before items, as in commitChunks).
    const job = await client.query<{ cancel_requested: boolean; finished_at: Date | null; target_generation: number }>(
      'SELECT cancel_requested, finished_at, target_generation FROM fs_jobs WHERE id = $1 FOR NO KEY UPDATE',
      [item.jobId]);
    const j = job.rows[0];
    if (!j || j.cancel_requested || j.finished_at) return skip;
    const locked = await client.query<{ status: string }>(
      'SELECT status FROM fs_reembed_items WHERE job_id = $1 AND file_id = $2 FOR UPDATE', [item.jobId, item.fileId]);
    if (locked.rows[0]?.status !== 'in_progress') return skip;

    await client.query(
      'DELETE FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2 AND generation = $3',
      [item.storeId, item.fileId, j.target_generation],
    );
    if (options.copy) {
      // The rows as they are, vectors and context_tsv included: the store's model, the same text.
      await client.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding, generation, context, context_tsv,
                                          section, section_offset, heading_path, page_start, page_end)
         SELECT store_id, file_id, ord, text, tokens, embedding, $4, context, context_tsv,
                section, section_offset, heading_path, page_start, page_end
           FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2 AND generation = $3`,
        [item.storeId, item.fileId, sourceGeneration, j.target_generation]);
    }
    // The rows as they are — text, structure, context (its context_tsv is rebuilt from it by
    // the shared statement) — with the target model's vectors.
    await insertChunkRows(client, item.storeId, item.fileId, j.target_generation, chunks.map((c, i) => ({
      ord: c.ord,
      text: c.text,
      tokens: c.tokens,
      vector: vectors[i] ?? null,
      context: c.context,
      section: c.section,
      sectionOffset: c.section_offset,
      headingPath: c.heading_path,
      pageStart: c.page_start,
      pageEnd: c.page_end,
    })));
    const n = Math.max(Math.trunc(tokens) || 0, 0);
    await client.query('UPDATE fs_jobs SET embedding_tokens = embedding_tokens + $2 WHERE id = $1', [item.jobId, n]);
    if (context) await addJobContextTotals(client, item.jobId, context);
    if (ocr) await addJobOcrTotals(client, item.jobId, ocr);
    await client.query(
      `UPDATE fs_reembed_items SET status = 'completed', tokens = $3, claimed_at = NULL, last_error = NULL,
                                   extraction_version = $4, ocr_pending = $5, context_stopped = $6
        WHERE job_id = $1 AND file_id = $2`,
      [item.jobId, item.fileId, n, options.extractionVersion ?? null,
        options.extractionVersion == null ? null : ocrPendingOf(ocr), options.contextStopped ?? null],
    );
    const open = await client.query(
      `SELECT 1 FROM fs_reembed_items WHERE job_id = $1 AND status = 'in_progress' LIMIT 1`, [item.jobId]);
    return { commit: true, value: (open.rowCount ?? 0) > 0 ? 'committed' : 'last' };
  });
}

/** A busy pool is not the item's fault: handed back without spending an attempt (BUSY_HANDBACK_SET). */
async function handBackBusy(item: ReembedItem, error: FileSearchBusyError, memoryHandbacks?: number): Promise<void> {
  logger.warn('Reembed', `Re-embedding of store ${item.storeId}, file ${item.fileId} deferred: ${busyReason(error)}`,
    { jobId: item.jobId });
  await requirePool().query(
    `UPDATE fs_reembed_items SET ${BUSY_HANDBACK_SET}, last_error = ${BUSY_HANDBACK_LAST_ERROR_SQL}
      WHERE job_id = $3 AND file_id = $4 AND status = 'in_progress'`,
    [BUSY_RETRY_SECONDS, LEASE_MINUTES, item.jobId, item.fileId,
      JSON.stringify({ ...serializeError(error), ...(memoryHandbacks ? { memory_handbacks: memoryHandbacks } : {}) })],
  ).catch(() => {}); // the lease expires instead
}

/** Failures no retry can mend: the target model is not served; and, for a re-chunk, a file the
 *  target setting's extraction cannot read (an unsupported type, a broken PowerPoint/Excel file), a file over the token limit,
 *  a file with more chunks than the ceiling for its vectors, a file whose chunking needs more heap than the chunker
 *  thread may use, an invalid setting. */
function isPermanentItemFailure(error: unknown): boolean {
  return error instanceof EmbeddingModelUnavailableError
    || error instanceof UnsupportedFileTypeError
    || error instanceof DocumentReadError
    || error instanceof FileTooLargeError
    || error instanceof FileHasTooManyChunksError
    || error instanceof StructureChunkOutOfMemoryError
    || error instanceof ChunkingStrategyError;
}

/** A failed attempt: permanent (isPermanentItemFailure) or the budget spent turns the item
 *  `failed`; otherwise it is open again at once. */
async function handleItemFailure(item: ReembedItem, error: unknown, maxRetries: number): Promise<void> {
  // A memory wait that timed out is handed back without an attempt MAX_MEMORY_HANDBACKS times (a busy
  // pool or a stop in between keeps the count; a real failure resets it); after that it spends the attempt like any
  // transient failure (memoryBudget.ts).
  let memoryHandbacks: number | undefined;
  if (error instanceof FileSearchMemoryBusyError && error.reason === 'timeout') { // a stopping worker is never the file's fault
    const { rows } = await requirePool().query<{ n: number | null }>(
      `SELECT (last_error->>'memory_handbacks')::int AS n FROM fs_reembed_items WHERE job_id = $1 AND file_id = $2`,
      [item.jobId, item.fileId]);
    memoryHandbacks = (rows[0]?.n ?? 0) + 1;
  }
  if (error instanceof FileSearchBusyError && (memoryHandbacks === undefined || memoryHandbacks <= MAX_MEMORY_HANDBACKS)) {
    await handBackBusy(item, error, memoryHandbacks);
    return;
  }
  const permanent = isPermanentItemFailure(error);
  if (error instanceof EmbeddingModelUnavailableError) {
    logger.warn('Reembed', `Re-embedding failed for store ${item.storeId}, file ${item.fileId}: `
      + `the target model '${error.model}' is not served`, { jobId: item.jobId });
  } else {
    // Metadata only, as for ingestion: never chunk text.
    logger.error('Reembed', `Re-embedding attempt failed for store ${item.storeId}, file ${item.fileId}`,
      error instanceof Error ? error : new Error(String(error)), { jobId: item.jobId, permanent });
  }
  const { rows } = await requirePool().query<{ status: string }>(
    `UPDATE fs_reembed_items
        SET status = CASE WHEN $3::boolean OR attempts >= $4 THEN 'failed' ELSE 'in_progress' END,
            claimed_at = NULL, last_error = $5::jsonb
      WHERE job_id = $1 AND file_id = $2 AND status = 'in_progress'
      RETURNING status`,
    [item.jobId, item.fileId, permanent, maxRetries,
      JSON.stringify({ ...serializeError(error), ...(memoryHandbacks ? { memory_handbacks: memoryHandbacks } : {}) })],
  );
  if (error instanceof EmbeddingModelUnavailableError) await failOpenRechunkItems(item, error);
  if (rows[0]?.status === 'failed') await finalizeJob(item.jobId);
}

/**
 * A re-chunk embeds with the store's own model: once that model is found not served, every
 * other file of the job would run its extraction and context calls only to fail the same way.
 * Its open items fail at once with the same error (an item in flight finishes its work, and its
 * commit then finds the item failed and writes nothing); Retry re-opens them all once the model
 * is served again. A plain re-embed is left as it was.
 */
async function failOpenRechunkItems(item: ReembedItem, error: EmbeddingModelUnavailableError): Promise<void> {
  const { rowCount } = await requirePool().query(
    `UPDATE fs_reembed_items i SET status = 'failed', claimed_at = NULL, last_error = $2::jsonb
       FROM fs_jobs j
      WHERE i.job_id = $1 AND j.id = i.job_id AND j.target_chunking IS NOT NULL AND i.status = 'in_progress'`,
    [item.jobId, JSON.stringify(serializeError(error))],
  );
  if ((rowCount ?? 0) > 0) {
    logger.warn('Reembed', `Re-chunk of store ${item.storeId} stopped: its embedding model is not served`,
      { jobId: item.jobId, itemsFailed: rowCount });
  }
}

/**
 * Re-embeds one claimed item: reads the file's chunk text of the store's active
 * generation — or, when the job re-chunks, chunks the file again from its blob by
 * the job's target setting (rechunkedRows) — embeds it with the job's target model
 * (sub-batched by the embedder) and commits it into the target generation. When it
 * was the last open item the job is finalized (the switch) right away.
 */
export async function processReembedItem(item: ReembedItem): Promise<void> {
  try {
    // One SAP target for the whole item: its embedding and completion calls and their usage events.
    await withLatestSapTarget(() => processReembedItemUnguarded(item));
  } catch (error) {
    // A busy pool outside the attempt's own error handling (its first read): hand it back too.
    if (!(error instanceof FileSearchBusyError)) throw error;
    await handBackBusy(item, error);
  }
}

async function processReembedItemUnguarded(item: ReembedItem): Promise<void> {
  const pool = requirePool();
  const { rows } = await pool.query(
    `SELECT i.status, j.cancel_requested, j.finished_at, j.target_model, j.target_dim, j.target_chunking,
            j.reextract, vs.active_generation, vs.chunking AS store_chunking, j.credential_id, j.auth_type, j.owner_email,
            vsf.status AS file_status, vsf.chunking_strategy, vsf.extraction_version, vsf.ocr_pending, vsf.context_stopped,
            f.filename, f.sha256
       FROM fs_reembed_items i
       JOIN fs_jobs j ON j.id = i.job_id
       JOIN vector_stores vs ON vs.id = i.store_id
       LEFT JOIN vector_store_files vsf ON vsf.store_id = i.store_id AND vsf.file_id = i.file_id
       LEFT JOIN fs_files f ON f.id = i.file_id
      WHERE i.job_id = $1 AND i.file_id = $2`,
    [item.jobId, item.fileId],
  );
  const ctx = rows[0];
  if (!ctx || ctx.status !== 'in_progress' || ctx.cancel_requested || ctx.finished_at) return;
  const { maxRetries } = getFileSearchConfig().ingestion;
  // Billed to the job's credential (the admin service key: re-embeds start only
  // on the grounding routes) on behalf of the store's owner, also when an admin
  // started the job (plan Decision 2).
  const caller = storedFileSearchCaller(ctx.credential_id, ctx.auth_type, ctx.owner_email);
  const rechunk = ctx.target_chunking != null;
  // A re-extract reads again only the files the current extractors read better; the others keep
  // their chunks and vectors (copied by the commit).
  // The same rule as the start's selection (reextract.ts), with this gateway's OCR asked per item.
  const copy = rechunk && ctx.reextract === true
    && !readAgain(String(ctx.filename ?? ''), ctx.extraction_version, ctx.ocr_pending, ctx.ocr_pending === true && await isOcrEnabled());
  // Every item has a deadline below its lease, a plain re-embed too: a wait for memory takes at
  // most half of it (memoryBudget.ts waitUntil), so no item outlives its lease because of a wait.
  const deadline = Date.now() + PROCESS_BUDGET_MS;

  let outcome: ItemCommit;
  // The memory this item holds until its commit (memoryBudget.ts FileMemory).
  const memory = new FileMemory(deadline);
  let textBytes = 0;
  try {
    let chunks: SourceChunk[];
    let context: ContextTotals | undefined;
    let ocr: OcrCounters | undefined;
    // Kept chunks keep the file's context stop; chunks written again record their own (contextStop.ts).
    let contextStopped: string | null = ctx.context_stopped ?? null;
    if (!rechunk) {
      const source = await pool.query<SourceChunk>(
        `SELECT ord, text, tokens, context, section, section_offset, heading_path, page_start, page_end
           FROM vector_store_chunks
          WHERE store_id = $1 AND file_id = $2 AND generation = $3 ORDER BY ord`,
        [item.storeId, item.fileId, ctx.active_generation],
      );
      chunks = source.rows;
      // No extracted text here: the stored chunk texts and contexts are what is held. A plain re-embed
      // copies stored chunks and has no chunk ceiling: a file stored before the ceiling existed may
      // reserve more than the whole budget and then proceeds alone (memoryBudget.ts).
      // Its size is known before the wait: the text and the exact vectors.
      textBytes = textReserveBytes(chunks.reduce((n, c) => n + c.text.length + (c.context?.length ?? 0), 0));
      const embeddableCount = chunks.filter((c) => embeddingInputOf(c) !== null).length;
      await memory.reserve([{ key: 'item', bytes: textBytes + vectorReserveBytes(embeddableCount, ctx.target_dim) }]);
    } else if (ctx.file_status !== 'completed' || !ctx.sha256 || copy) {
      // Detached, deleted or re-ingesting meanwhile: nothing to chunk; the commit drops the item.
      // Or kept by a re-extract: the commit copies its rows.
      chunks = [];
    } else {
      ({ chunks, context, ocr } = await rechunkedRows(item, ctx, caller, deadline, async (x) => {
        // Right after extraction, before chunking and any context call: the text and the estimated vectors.
        const setting = resolveChunking({ file: ctx.chunking_strategy, store: ctx.target_chunking });
        const maxChunks = maxChunksPerFile(ctx.target_dim, getFileSearchConfig().limits.maxTokensPerFile);
        textBytes = textReserveBytes(x.textChars);
        await memory.reserve([{
          key: 'item', bytes: textBytes + vectorReserveBytes(estimatedChunkCount(x.estimatedTokens, setting, maxChunks), ctx.target_dim),
        }]);
      }));
      contextStopped = recordedContextStop(context?.stopped, ctx.context_stopped, sameSettingAsStore(ctx));
    }
    // Embedded as ingestion embedded them: the context with the text (a re-embed makes no new
    // context call), and a chunk of only whitespace not at all.
    const inputs = chunks.map((c) => embeddingInputOf(c));
    const embeddable = inputs.flatMap((input, i) => (input === null ? [] : [i]));
    const vectors: Array<Float32Array | null> = chunks.map(() => null);
    let tokens = 0;
    // The real size: a smaller one returns the difference, a larger one grows by it without waiting.
    const over = memory.settle('item', textBytes + vectorReserveBytes(embeddable.length, ctx.target_dim));
    if (over > 0) {
      logger.info('Reembed', 'An item needs more memory than estimated; its reservation grew', {
        jobId: item.jobId, fileId: item.fileId, bytesOverEstimate: over,
      });
    }
    if (embeddable.length > 0) {
      const result = await embed(embeddable.map((i) => inputs[i] as string), 'document',
        { model: ctx.target_model, dimensions: ctx.target_dim }, {
          deadline,
          // One event per embedding request, as for ingestion.
          onUsage: (u) => emitFileSearchUsage(caller, {
            endpoint: 'file_search/reembed',
            model: ctx.target_model,
            inputTokens: u.promptTokens,
            unit: 'tokens',
            responseTime: u.elapsedMs,
            requestId: workerRequestId('reembed'),
          }),
        });
      embeddable.forEach((chunkIndex, k) => { vectors[chunkIndex] = result.vectors[k]; });
      tokens = result.usage.totalTokens;
    }
    outcome = await commitItem(item, ctx.active_generation, chunks, vectors, tokens, {
      context, ocr, copy, extractionVersion: rechunk && !copy ? EXTRACTION_VERSION : null, contextStopped,
    });
  } catch (error) {
    // Released before the failure's database round trip; the finally's second release is a no-op.
    memory.release();
    await handleItemFailure(item, error, maxRetries);
    return;
  } finally {
    memory.release();
  }
  if (outcome === 'last') await finalizeJob(item.jobId);
}

/** The job chunks the file by the setting it is chunked by now (the fill, a re-extract): a context
 *  stop recorded under that setting is then being retried (contextStop.ts). */
function sameSettingAsStore(ctx: { chunking_strategy: unknown; target_chunking: unknown; store_chunking: unknown }): boolean {
  try {
    return chunkingKey(resolveChunking({ file: ctx.chunking_strategy, store: ctx.target_chunking }))
      === chunkingKey(resolveChunking({ file: ctx.chunking_strategy, store: ctx.store_chunking ?? null }));
  } catch {
    return false; // an invalid stored setting: the job gives the file a valid one, a first try
  }
}

/**
 * A re-chunk item's rows: the file's blob (from the storage its row names) extracted, chunked
 * and — when the target setting is contextual — given contexts by the job's target setting,
 * resolved with the file's own strategy (a file attached with an explicit static strategy keeps
 * it), through the pipeline ingestion uses (chunkPipeline.ts). The context calls are billed
 * like the embeddings. A retry re-spends them: only the committed attempt reaches the job's
 * counters, the usage events record every call.
 */
async function rechunkedRows(
  item: ReembedItem,
  ctx: { filename: string; sha256: string; chunking_strategy: unknown; target_chunking: unknown; target_dim: number },
  caller: ReturnType<typeof storedFileSearchCaller>, deadline: number, onExtracted: (text: ExtractedSize) => Promise<void>,
): Promise<{ chunks: SourceChunk[]; context?: ContextTotals; ocr: OcrCounters }> {
  const config = getFileSearchConfig();
  const setting = resolveChunking({ file: ctx.chunking_strategy, store: ctx.target_chunking });
  const bytes = await openBlob(ctx.sha256);
  const ocrMemo = new OcrMemo();
  const visionMemo = new VisionMemo();
  let prepared;
  try {
    prepared = await prepareFileChunks(ctx.filename, bytes, setting, {
      extractTimeoutMs: config.ingestion.extractTimeoutMs,
      maxTokensPerFile: config.limits.maxTokensPerFile,
      deadline,
      caller,
      embeddingDimensions: ctx.target_dim,
      onExtracted,
      ocr: { memo: ocrMemo, sha256: ctx.sha256 },
      vision: { memo: visionMemo },
    });
  } finally {
    logOcrTotals(ocrMemo, { storeId: item.storeId, fileId: item.fileId, jobId: item.jobId });
    logVisionTotals(visionMemo, { storeId: item.storeId, fileId: item.fileId, jobId: item.jobId });
  }
  return {
    ocr: { ...ocrMemo.totals(), ...visionMemo.counters() },
    chunks: prepared.chunks.map((c) => ({
      ord: c.ord,
      text: c.text,
      tokens: c.tokens,
      context: c.context,
      section: c.section,
      section_offset: c.sectionOffset,
      heading_path: c.headingPath,
      page_start: c.pageStart,
      page_end: c.pageEnd,
    })),
    context: prepared.context,
  };
}

// ---------------------------------------------------------------------------
// Finishing a job: the switch (Decision 6), failure, expiry
// ---------------------------------------------------------------------------

/** The `name` the embedder's model-unavailable failure is persisted under
 *  (serializeError keeps `error.name`): files that failed for it are re-queued
 *  at the switch, so they ingest with the new model. */
const MODEL_UNAVAILABLE_ERROR_NAME = new EmbeddingModelUnavailableError('').name;

/**
 * Finishes a bulk parent whose children are all finished. Locks the parent
 * first, then re-checks with a fresh snapshot (as jobs.settleFinishedIfTerminal
 * does), so two children finishing concurrently cannot both miss the other.
 * Runs inside the caller's transaction, after the child's row (child → parent).
 */
export async function settleParent(client: PoolClient, parentId: string | null): Promise<boolean> {
  if (!parentId) return false;
  const locked = await client.query(
    `SELECT id FROM fs_jobs WHERE id = $1 AND kind = 'reembed_bulk' AND finished_at IS NULL FOR UPDATE`, [parentId]);
  if ((locked.rowCount ?? 0) === 0) return false;
  const result = await client.query(
    `UPDATE fs_jobs p SET finished_at = now()
      WHERE p.id = $1 AND p.finished_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fs_jobs c WHERE c.parent_id = p.id AND c.finished_at IS NULL)`,
    [parentId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface JobRow {
  id: string;
  kind: string;
  parent_id: string | null;
  owner_email: string | null;
  store_id: string | null;
  cancel_requested: boolean;
  finished_at: Date | null;
  error: unknown;
  created_at: Date;
  target_model: string;
  target_dim: number;
  target_generation: number;
  /** Non-null: the job re-chunks the store to this setting (rechunk.ts). */
  target_chunking: Record<string, unknown> | null;
  /** A re-extract (reextract.ts): a re-chunk to the store's own setting of the files an older extractor read. */
  reextract: boolean | null;
}

/** The store row FOR UPDATE, then the job — the order every state change uses. */
export async function lockStoreAndReadJob(
  client: PoolClient, jobId: string,
): Promise<{ job: JobRow; store: { status: string; active_generation: number } } | null> {
  const pre = await client.query<{ store_id: string | null }>('SELECT store_id FROM fs_jobs WHERE id = $1', [jobId]);
  const storeId = pre.rows[0]?.store_id;
  if (!storeId) return null;
  const store = await client.query<{ status: string; active_generation: number }>(
    'SELECT status, active_generation FROM vector_stores WHERE id = $1 FOR UPDATE', [storeId]);
  if (store.rowCount === 0) return null;
  const job = await client.query<JobRow>(`SELECT * FROM fs_jobs WHERE id = $1 AND kind = 'reembed_store'`, [jobId]);
  if (!job.rows[0] || job.rows[0].store_id !== storeId) return null;
  return { job: job.rows[0], store: store.rows[0] };
}

/** Marks the job finished (with `error` when it did not switch) and settles its parent. */
async function finishJob(client: PoolClient, job: JobRow, error: Record<string, unknown> | null): Promise<void> {
  await client.query('UPDATE fs_jobs SET finished_at = now(), error = $2::jsonb WHERE id = $1',
    [job.id, error ? JSON.stringify(error) : null]);
  await settleParent(client, job.parent_id);
}

type FinalizeOutcome = 'switched' | 'failed' | 'expired' | 'reopened' | 'open' | 'none';

/**
 * Brings a re-embed job whose items are all done to its end, in one transaction
 * under the lock order (store FOR UPDATE, then files, then jobs):
 *
 *  - store expired: open items cancelled, the target generation deleted, job failed;
 *  - an item still open: nothing (the worker is not done);
 *  - an item failed: job failed, store untouched, the target generation kept so
 *    Retry continues where it stopped (Cancel deletes it);
 *  - a completed file of the store without a completed item, or (a re-embed only)
 *    with another chunk count in the target generation than in the active one: its
 *    item is (re)opened and the switch waits — never a switch that loses a file. A
 *    re-chunk's counts differ by design (another setting, even another extraction:
 *    a file may have chunks under one setting and none under the other), so there
 *    the completed item is the proof, written with its chunks in one transaction;
 *  - otherwise THE SWITCH: the store's `active_generation`, `embedding_model`
 *    and `embedding_dim` become the job's target — and a re-chunk's
 *    `target_chunking` the store's `chunking`, with each file's `usage_bytes`
 *    recounted from its new chunks — the old generation is deleted,
 *    files that failed because the old model was not served are re-queued
 *    (ingested with the new model), the job is finished.
 */
export async function finalizeJob(jobId: string): Promise<FinalizeOutcome> {
  const requeued: string[] = [];
  let storeId = '';
  const outcome = await inTransaction<FinalizeOutcome>(async (client) => {
    const locked = await lockStoreAndReadJob(client, jobId);
    if (!locked || locked.job.finished_at) return { commit: false, value: 'none' };
    const { job, store } = locked;
    storeId = job.store_id!;
    if (job.cancel_requested) return { commit: false, value: 'none' }; // cancel finishes its job itself

    if (store.status === 'expired') {
      await client.query(
        `UPDATE fs_reembed_items SET status = 'cancelled', claimed_at = NULL WHERE job_id = $1 AND status = 'in_progress'`,
        [jobId]);
      if (job.target_generation !== store.active_generation) {
        await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1 AND generation = $2',
          [storeId, job.target_generation]);
      }
      await finishJob(client, job, { code: 'store_expired', message: 'The vector store expired before the re-embed finished.' });
      return { commit: true, value: 'expired' };
    }

    const counts = await client.query<{ open: number; failed: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'in_progress')::int AS open,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM fs_reembed_items WHERE job_id = $1`, [jobId]);
    if (counts.rows[0].open > 0) return { commit: false, value: 'open' };
    if (counts.rows[0].failed > 0) {
      await finishJob(client, job, job.target_chunking === null ? {
        code: 'reembed_failed',
        message: `${counts.rows[0].failed} file(s) could not be re-embedded; the store still answers with its previous model.`,
      } : {
        code: 'rechunk_failed',
        message: `${counts.rows[0].failed} file(s) could not be re-chunked; the store still answers with its previous chunking.`,
      });
      return { commit: true, value: 'failed' };
    }

    // Completeness, under the store lock: no completed file can appear or vanish now.
    const missing = await client.query(
      `INSERT INTO fs_reembed_items (job_id, store_id, file_id)
       SELECT $1, $2, f.file_id FROM vector_store_files f
        WHERE f.store_id = $2 AND f.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM fs_reembed_items i WHERE i.job_id = $1 AND i.file_id = f.file_id)
       ON CONFLICT (job_id, file_id) DO NOTHING
       RETURNING file_id`,
      [jobId, storeId]);
    const mismatched = job.target_chunking !== null ? { rowCount: 0 } : await client.query(
      `UPDATE fs_reembed_items i
          SET status = 'in_progress', attempts = 0, claimed_at = NULL, last_error = NULL
        WHERE i.job_id = $1 AND i.status <> 'in_progress'
          AND (SELECT COUNT(*) FROM vector_store_chunks c
                WHERE c.store_id = $2 AND c.file_id = i.file_id AND c.generation = $3)
           <> (SELECT COUNT(*) FROM vector_store_chunks c
                WHERE c.store_id = $2 AND c.file_id = i.file_id AND c.generation = $4)
       RETURNING i.file_id`,
      [jobId, storeId, store.active_generation, job.target_generation]);
    if ((missing.rowCount ?? 0) + (mismatched.rowCount ?? 0) > 0) {
      logger.warn('Reembed', 'The switch found files missing from the new generation; re-opened their items', {
        jobId, storeId, missing: missing.rowCount ?? 0, mismatched: mismatched.rowCount ?? 0,
      });
      return { commit: true, value: 'reopened' };
    }

    // A plain re-embed keeps the store's chunking (COALESCE with a NULL target), and so does a
    // re-extract (its target is the store's own setting, resolved).
    await client.query(
      `UPDATE vector_stores SET active_generation = $2, embedding_model = $3, embedding_dim = $4,
                                chunking = COALESCE($5::jsonb, chunking)
        WHERE id = $1`,
      [storeId, job.target_generation, job.target_model, job.target_dim,
        job.target_chunking === null || job.reextract === true ? null : JSON.stringify(job.target_chunking)]);
    if (job.target_chunking !== null) {
      // usage_bytes is the stored chunk text (as commitChunks counts it), now of the new chunks;
      // a file its item (or ingestion during the job) read takes that item's extractor version;
      // every file takes its item's context stop (contextStop.ts), that of the new generation.
      await client.query(
        `UPDATE vector_store_files f
            SET usage_bytes = (SELECT COALESCE(SUM(octet_length(c.text)), 0) FROM vector_store_chunks c
                                WHERE c.store_id = f.store_id AND c.file_id = f.file_id AND c.generation = $2),
                extraction_version = COALESCE((SELECT i.extraction_version FROM fs_reembed_items i
                                                WHERE i.job_id = $3 AND i.file_id = f.file_id), f.extraction_version),
                ocr_pending = COALESCE((SELECT i.ocr_pending FROM fs_reembed_items i
                                         WHERE i.job_id = $3 AND i.file_id = f.file_id), f.ocr_pending),
                context_stopped = (SELECT i.context_stopped FROM fs_reembed_items i
                                    WHERE i.job_id = $3 AND i.file_id = f.file_id)
          WHERE (f.store_id, f.file_id) IN (
            SELECT store_id, file_id FROM vector_store_files
             WHERE store_id = $1 AND status = 'completed'
             ORDER BY file_id FOR UPDATE)`,
        [storeId, job.target_generation, jobId]);
    }
    await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1 AND generation <> $2',
      [storeId, job.target_generation]);
    // Files that failed only because the old model was not served ingest again,
    // now with the store's new model (Task 2 review m1). Files before jobs.
    const reopened = await client.query<{ file_id: string; batch_id: string | null }>(
      `UPDATE vector_store_files SET status = 'in_progress', attempts = 0, last_error = NULL, claimed_at = NULL
        WHERE (store_id, file_id) IN (
          SELECT store_id, file_id FROM vector_store_files
           WHERE store_id = $1 AND status = 'failed' AND last_error->>'name' = $2
           ORDER BY file_id FOR UPDATE)
        RETURNING file_id, batch_id`,
      [storeId, MODEL_UNAVAILABLE_ERROR_NAME]);
    const batchIds = [...new Set(reopened.rows.map((r) => r.batch_id).filter((b): b is string => !!b))].sort();
    if (batchIds.length > 0) {
      await client.query('UPDATE fs_jobs SET finished_at = NULL WHERE batch_id = ANY($1::text[])', [batchIds]);
    }
    requeued.push(...reopened.rows.map((r) => r.file_id));
    await finishJob(client, job, null);
    return { commit: true, value: 'switched' };
  });
  if (outcome === 'switched') {
    logger.info('Reembed', 'Switched a store to its re-embedded generation', {
      jobId, storeId, requeuedFiles: requeued.length,
    });
    for (const fileId of requeued) {
      // eslint-disable-next-line no-await-in-loop
      await enqueueIngestion(storeId, fileId);
    }
  } else if (outcome === 'reopened') {
    await publishIngestHint(storeId, '');
  }
  return outcome;
}

/**
 * Finishes what nothing else will: re-embed jobs with no open item left (their
 * last item was detached, or the process died between an item and the switch)
 * and bulk parents whose children are all finished. Called by the idle worker
 * loop and by the job sweeper's orphan settling. Returns how many jobs it finished.
 */
export async function settleIdleReembedJobs(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const idle = await pool.query<{ id: string }>(
    `SELECT j.id FROM fs_jobs j
      WHERE j.kind = 'reembed_store' AND j.finished_at IS NULL AND NOT j.cancel_requested
        AND NOT EXISTS (SELECT 1 FROM fs_reembed_items i WHERE i.job_id = j.id AND i.status = 'in_progress')
      ORDER BY j.id`,
  );
  let finished = 0;
  for (const { id } of idle.rows) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await finalizeJob(id);
    if (outcome === 'switched' || outcome === 'failed' || outcome === 'expired') finished += 1;
  }
  const parents = await pool.query<{ id: string }>(
    `SELECT p.id FROM fs_jobs p
      WHERE p.kind = 'reembed_bulk' AND p.finished_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fs_jobs c WHERE c.parent_id = p.id AND c.finished_at IS NULL)
      ORDER BY p.id`,
  );
  for (const { id } of parents.rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await inTransaction(async (client) => ({ commit: true, value: await settleParent(client, id) }))) finished += 1;
  }
  return finished;
}
