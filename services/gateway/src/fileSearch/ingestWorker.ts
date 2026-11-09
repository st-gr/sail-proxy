// Asynchronous file_search ingestion worker.
//
// The `vector_store_files` row IS the job: `attachFile` (Task 10) inserts it
// with status='in_progress', and this module claims those rows with
// `FOR UPDATE SKIP LOCKED` so multiple gateway replicas never claim the
// same one, extracts text, chunks it, embeds every chunk, and writes the
// chunks — or marks the row `failed` with `last_error`.
//
// VALKEY HINT: wired up via ingestHint.ts. `storeFiles.ts`'s
// `enqueueIngestion` publishes; `startIngestWorker` below subscribes and
// wakes every idle loop immediately on a hint. Strictly an accelerator —
// per the design doc, "the database row is the source of truth; valkey is
// an accelerator" — never awaited for correctness: every claim/lease/retry
// test in ingestWorker.test.ts and its integration counterpart runs with no
// VALKEY_URL set and proves polling alone still drains the queue.
//
// CONCURRENCY HAZARD (see Task 10's report / storeFiles.ts's own comments):
// `vector_store_chunks` has NO foreign key. `deleteStoreCascade` takes
// `FOR UPDATE` on the `vector_stores` row, then deletes chunks, THEN deletes
// the `vector_store_files` row (in that order — the chunk delete comes
// FIRST, which is exactly what makes it dangerous, see below). `deleteStoreFile`
// (a per-file detach) now ALSO takes `FOR UPDATE` on `vector_stores` first
// (fixed post-review — see storeFiles.ts's doc comment on that function for
// the deadlock this closes), before deleting the `vector_store_files` row.
// `commitChunks` re-verifies both rows before writing. The two guards protect
// against two DIFFERENT delete paths, each independently, and neither is a
// substitute for the other — this took three review rounds to pin down
// precisely, so read this exactly as written before changing either one:
//
//   - `FOR SHARE` on `vector_stores` is load-bearing against
//     `deleteStoreCascade`. Consider ingestion acquiring its locks first and
//     holding its transaction open (e.g. a slow embedding call) while
//     `deleteStoreCascade` starts: without `FOR SHARE`, the cascade's own
//     `FOR UPDATE` on `vector_stores` succeeds immediately, its
//     `DELETE FROM vector_store_chunks` runs and finds nothing (ingestion
//     hasn't inserted yet), and only THEN does it block, on the
//     `vector_store_files` row ingestion is holding — by which point its
//     own chunk-delete step has already run and will never run again, so
//     ingestion's later insert survives forever once the cascade finishes
//     deleting everything else around it. VERIFIED: removing `FOR SHARE`
//     orphans chunks in the ingestion-locks-first ordering, three
//     consecutive runs, 2/2 orphaned chunks every time — see
//     ingestWorker.integration.test.ts's "[ingestion-locks-first]...
//     store-cascade delete" test.
//   - The `vector_store_files` block (the `SELECT ... FOR UPDATE` PLUS the
//     `rowCount === 0 || status !== 'in_progress'` rollback that follows
//     it) is load-bearing against `deleteStoreFile`, and `FOR SHARE` does
//     NOT cover it: a per-file detach that fully commits leaves the STORE
//     row intact (only a cascade removes it), so `FOR SHARE` succeeds
//     either way and cannot by itself detect that a detach happened. It is
//     the existence/status ROLLBACK CHECK specifically — not the
//     `FOR UPDATE` locking modifier — that closes this race: once the
//     detach has committed, the row is simply gone, and an ordinary
//     (unlocked) read after a commit sees that under normal MVCC rules.
//     VERIFIED, two mutations against the SAME "[delete-completes-first]
//     ... per-file detach" test, three review rounds and a live-Postgres
//     adjudication apart:
//       - removing the WHOLE block (the SELECT and the rollback check) —
//         FAILS: 1 orphaned chunk, `chunkCount` 1 instead of 0.
//       - keeping the SELECT and its rollback check, dropping ONLY the
//         `FOR UPDATE` modifier — PASSES, 22/22, three consecutive runs.
//     So: the existence/status check is what prevents this orphan. The
//     `FOR UPDATE` modifier is NOT demonstrably load-bearing for orphan
//     prevention in any interleaving tested — it only serialises against an
//     in-flight, UNCOMMITTED detach, which no test here forces without also
//     making the check itself catch the outcome. It is kept for two
//     reasons unrelated to that specific claim: (1) cheap insurance against
//     that in-flight-uncommitted case, so a future change to timing or to
//     `deleteStoreFile` doesn't quietly reopen a window; (2) the
//     `status = 'in_progress'` part of the SAME check is independently
//     load-bearing for a completely different property — it is what makes
//     re-processing an already-terminal row a no-op, unrelated to deletes.
//     Do not read "the FOR UPDATE modifier isn't demonstrably load-bearing"
//     as "the block is redundant" — those are different claims about
//     different things, and conflating them is exactly the mistake made
//     (in both directions) across the last three review rounds. Never
//     remove the block. The modifier may be debated; the block may not be.
import { EventEmitter } from 'events';
import { getPool, isFileSearchAvailable } from './db';
import { FileSearchBusyError } from './dbBusy';
import { getFileSearchConfig } from '../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { EXTRACTION_VERSION, UnsupportedFileTypeError } from './extractors/registry';
import { DocumentReadError } from './extractors/ooxml/limits';
import { sweepStaleExtractDirs } from './extractors/runners';
import type { Chunk } from './chunker';
import { ChunkingSetting, ChunkingStrategyError, chunkingKey, resolveChunking } from './chunkingSetting';
import {
  ContextTotals, estimatedChunkCount, ExtractedSize, FileHasTooManyChunksError, FileTooLargeError, maxChunksPerFile, PreparedChunk,
  prepareFileChunks,
} from './chunkPipeline';
import { recordedContextStop } from './contextStop';
import {
  busyReason, clearMemoryWaitStopSignal, FileMemory, FileSearchMemoryBusyError, MAX_MEMORY_HANDBACKS, setMemoryWaitStopSignal,
  textReserveBytes, vectorReserveBytes, waitUntil,
} from './memoryBudget';
import { embeddingInputOf, insertChunkRows } from './chunkRows';
import { closeStructureChunkThread, StructureChunkOutOfMemoryError } from './structureChunkThread';
import { closeOfficeReaderThread } from './extractors/ooxml/ooxmlThread';
import { embed, EmbeddingModelUnavailableError } from './embedder';
import { openBlob } from './blob/blobStore';
import { assertStoreDimension, StoreDimensionMismatchError } from './repository';
import { subscribeIngestHints, closePublisher, IngestHintSubscription } from './ingestHint';
import {
  markStartedIfNeeded, settleFinishedIfTerminal, addTokens, addContextTotals, addJobContextTotals, addOcrTotals, OcrCounters,
} from './jobs';
import { logOcrTotals, OcrMemo, ocrPendingOf } from './extractors/pdfOcr';
import { logVisionTotals, VisionMemo } from './visionTranscriber';
import { claimNextReembedItem, processReembedItem, settleIdleReembedJobs } from './reembedWorker';
import {
  LEASE_MINUTES, BUSY_RETRY_SECONDS, BUSY_HANDBACK_SET, BUSY_HANDBACK_LAST_ERROR_SQL, PROCESS_BUDGET_MS,
  sanitizeErrorMessage, serializeError,
} from './workQueue';
import { emitFileSearchUsage, FileSearchCaller, storedFileSearchCaller, workerRequestId } from './usage';
import { withLatestSapTarget } from '../sap/sapTarget';

const logger = getDefaultLogger();

// How often an idle worker loop polls for new work when nothing woke it
// early. Only matters while the queue is empty; a loop that just claimed and
// processed a job loops straight back into claimNext without waiting.
const POLL_INTERVAL_MS = 2000;

// How often processOne re-reads the store and embeds again after commitChunks
// found the store on a model it had no vectors for (a re-embed started or
// switched meanwhile). Each round only embeds the models still missing; two
// switches inside one ingestion are already unusual.
const MAX_STALE_COMMITS = 3;

// PROCESS_BUDGET_MS (workQueue.ts) bounds one processOne from its start, extraction
// included: below the 15-minute lease (LEASE_MINUTES), so a file still being embedded is
// never re-claimed by a second worker. Every embed call of the file — two models while
// its store re-embeds, two chunk sets while it re-chunks, again after a stale commit —
// shares this one deadline.

export interface Job {
  storeId: string;
  fileId: string;
}

/** Thrown when one ingestion ran out of its time budget (`PROCESS_BUDGET_MS`)
 *  before it could embed again. Transient: the next claim starts afresh. */
export class IngestionDeadlineExceededError extends Error {
  constructor(readonly budgetMs: number) {
    super(`Ingesting the file took longer than its ${budgetMs} ms budget`);
    this.name = 'IngestionDeadlineExceededError';
  }
}

export { FileTooLargeError };

/** Permanent failures must never be retried against the attempt budget —
 *  retrying them can never succeed, so doing so only wastes the budget a
 *  transient failure (a timeout, an upstream 500) genuinely needs. */
function isPermanentFailure(error: unknown): boolean {
  return (
    error instanceof UnsupportedFileTypeError ||
    // A broken, hostile or over-limit PowerPoint/Excel file: a retry reads the same bytes.
    error instanceof DocumentReadError ||
    error instanceof FileTooLargeError ||
    // More chunks than the ceiling for its vectors: the same file chunks the same way again.
    error instanceof FileHasTooManyChunksError ||
    // Chunking it needs more heap than the chunker thread may use: a retry needs the same.
    error instanceof StructureChunkOutOfMemoryError ||
    error instanceof StoreDimensionMismatchError ||
    // The orchestration does not serve the store's model; it will not on a retry
    // either — the store needs a re-embed.
    error instanceof EmbeddingModelUnavailableError ||
    // The store's chunking setting is invalid (hand-edited): no retry can chunk the file.
    error instanceof ChunkingStrategyError
  );
}

/**
 * Sweeps rows that are permanently unreachable by the claim query below:
 * still `status='in_progress'`, but `attempts` has already reached
 * `maxRetries` — meaning `attempts < $1` will never select them again — AND
 * the lease has expired (no live worker is plausibly still mid-attempt on
 * them; a live lease is left alone so this never races a worker that is
 * actively about to call `handleFailure`/`commitChunks` itself).
 *
 * Without this, a worker process dying (crash, OOM, deploy) immediately
 * after `claimNext`'s FINAL claim on a row — before `processOne` ever
 * reaches `handleFailure` or `commitChunks` — leaves that row stuck
 * `in_progress` forever: nothing will ever claim it again (its own attempt
 * budget forbids it), and nothing was left running to mark it `failed`. The
 * OpenAI-compatible API would then show such a store's file as perpetually
 * "in_progress" with no way to ever resolve. This reaper turns that
 * permanent zombie into an observable `failed` state instead.
 *
 * The rows are locked in `(store_id, file_id)` order first — the order a job
 * retry locks a batch's members in (jobs.ts) — so the two cannot deadlock.
 *
 * A reaped row may be the last open member of its batch, so the batch's job
 * is settled in the same transaction (decision 5 of the jobs plan): a crash
 * between the two would otherwise leave the job unfinished for good.
 */
async function reapZombies(maxRetries: number): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ batch_id: string | null }>(
      `UPDATE vector_store_files
         SET status = 'failed', claimed_at = NULL, last_error = $2::jsonb
       WHERE (store_id, file_id) IN (
         SELECT store_id, file_id FROM vector_store_files
          WHERE status = 'in_progress'
            AND attempts >= $1
            AND (claimed_at IS NULL OR claimed_at < now() - ($3::int * interval '1 minute'))
          ORDER BY store_id, file_id
          FOR UPDATE)
       RETURNING batch_id`,
      [maxRetries, JSON.stringify({
        message: 'Ingestion was interrupted after exhausting its retry budget (the worker likely crashed, ' +
          'was OOM-killed, or restarted mid-attempt) and could not automatically resolve to a terminal state.',
        name: 'MaxRetriesExceededZombie',
      }), LEASE_MINUTES],
    );
    // Sorted, so two reapers settle shared jobs in the same order.
    const batchIds = [...new Set((rows ?? []).map((r) => r.batch_id).filter((b): b is string => !!b))].sort();
    for (const batchId of batchIds) {
      // eslint-disable-next-line no-await-in-loop
      await settleFinishedIfTerminal(client, batchId);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Atomically claims the oldest eligible `vector_store_files` row across the
 * whole table: `status='in_progress'`, a lease that has either never been
 * taken or has expired (a crashed worker's job becomes reclaimable without
 * any heartbeat), and under the retry budget. `FOR UPDATE SKIP LOCKED`
 * inside the subquery is what makes this safe across multiple concurrent
 * gateway replicas: two concurrent callers never see (and so never return)
 * the same row — the loser's subquery simply skips the row the winner
 * already holds a lock on, rather than blocking on it.
 *
 * This is the ONLY place `attempts` is incremented. `processOne` must not
 * repeat that increment — see its own doc comment.
 *
 * Opportunistically reaps zombies (see `reapZombies`) first, on the same
 * cadence workers already poll at — no separate timer/interval needed.
 */
export async function claimNext(): Promise<Job | null> {
  const pool = getPool();
  if (!pool) return null;
  const config = getFileSearchConfig();
  await reapZombies(config.ingestion.maxRetries);
  // The pick is a CTE, not an `IN (subquery)`: a CTE with FOR UPDATE runs exactly once. As an
  // IN subquery the planner may put it, unmaterialised, on the inner side of a nested-loop semi
  // join and rescan it per outer row; a rescan skips the row this statement already updated, so
  // LIMIT 1 yields the next one and one UPDATE claimed several rows - of which only rows[0] is
  // ever processed, the rest sitting leased and untouched until the lease expires.
  const { rows } = await pool.query(
    `WITH picked AS (
       SELECT store_id, file_id FROM vector_store_files
       WHERE status = 'in_progress'
         AND (claimed_at IS NULL OR claimed_at < now() - ($2::int * interval '1 minute'))
         AND attempts < $1
       ORDER BY created_at LIMIT 1
       FOR UPDATE SKIP LOCKED)
     UPDATE vector_store_files f SET claimed_at = now(), attempts = f.attempts + 1
       FROM picked
      WHERE f.store_id = picked.store_id AND f.file_id = picked.file_id
     RETURNING f.store_id, f.file_id, f.batch_id`,
    [config.ingestion.maxRetries, LEASE_MINUTES],
  );
  if (rows.length === 0) return null;
  // The first claim of any member starts the batch's job; later claims leave
  // started_at alone. A separate statement after the claim's own commit: if
  // the process dies in between, or this statement fails, the next claim of a
  // member stamps it — so a failure is logged and never drops the claim,
  // which has already consumed an attempt.
  if (rows[0].batch_id) {
    try {
      await markStartedIfNeeded(pool, rows[0].batch_id);
    } catch (error) {
      logger.warn('IngestWorker', 'Could not stamp the job\'s started_at; the next claim retries it', {
        batchId: rows[0].batch_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { storeId: rows[0].store_id, fileId: rows[0].file_id };
}

interface JobContext {
  status: string;
  chunkingStrategy: unknown;
  /** The store's chunking setting (`vector_stores.chunking`; NULL = static 800/400). */
  storeChunking: unknown;
  filename: string;
  sha256: string;
  /** The store's pinned model and dimension — what this file is embedded with
   *  (plan Decision 2, ruling R3), whatever the configured model is now. */
  embeddingModel: string;
  embeddingDim: number;
  /** The target model of the store's running re-embed, or null: a file ingested
   *  while one runs is embedded with both models (plan Decision 2). Which
   *  generations it is written to is decided again under the store lock in
   *  commitChunks — this read only says which vectors to prepare. */
  reembedTarget: { model: string; dimensions: number } | null;
  /** The pinned target setting of that job when it re-chunks (`fs_jobs.target_chunking`), or
   *  null (a plain re-embed, or none): the target generation then gets chunks of that setting. */
  rechunkTarget: unknown;
  /** The batch this file was attached as part of, or `null` for the
   *  single-file attach path (`attachFile`'s default). */
  batchId: string | null;
  /** Whether cancellation was requested for that batch. Always `false` for a
   *  file that belongs to no batch. */
  cancelRequested: boolean;
  /** Who pays for this file's embedding requests (see legacyBatchCaller), or
   *  null when nobody can be identified: then no usage is recorded. */
  caller: FileSearchCaller | null;
}

/**
 * The batch join is a LEFT JOIN, and `cancel_requested` is COALESCEd, for the
 * same reason: `batch_id` is NULL for every file attached outside a batch —
 * which is every file on the single-file `POST /vector_stores/{id}/files`
 * path. An inner join here would make `loadContext` return null for those and
 * silently stop ingesting them altogether.
 *
 * Reading the flag HERE rather than in a query of its own keeps the normal
 * ingest path at exactly the same number of round trips it had before
 * cancellation existed: the cancelling UPDATE below only runs when a batch has
 * actually been cancelled.
 */
async function loadContext(storeId: string, fileId: string): Promise<JobContext | null> {
  const pool = getPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT vsf.status, vsf.chunking_strategy, vs.chunking AS store_chunking, vsf.batch_id, f.filename, f.sha256,
            vs.embedding_model, vs.embedding_dim,
            rj.target_model, rj.target_dim, rj.target_chunking,
            COALESCE(b.cancel_requested, false) AS cancel_requested,
            vsf.credential_id, vsf.auth_type, vsf.on_behalf_of
     FROM vector_store_files vsf
     JOIN fs_files f ON f.id = vsf.file_id
     JOIN vector_stores vs ON vs.id = vsf.store_id
     LEFT JOIN vector_store_batches b ON b.id = vsf.batch_id AND b.store_id = vsf.store_id
     LEFT JOIN fs_jobs rj ON rj.store_id = vsf.store_id AND rj.kind = 'reembed_store'
                         AND rj.finished_at IS NULL AND NOT rj.cancel_requested
     WHERE vsf.store_id = $1 AND vsf.file_id = $2`,
    [storeId, fileId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const caller = row.credential_id
    ? storedFileSearchCaller(row.credential_id, row.auth_type, row.on_behalf_of)
    : await legacyBatchCaller(storeId, row.batch_id);
  return {
    status: row.status,
    chunkingStrategy: row.chunking_strategy,
    storeChunking: row.store_chunking,
    filename: row.filename,
    sha256: row.sha256,
    embeddingModel: row.embedding_model,
    embeddingDim: row.embedding_dim,
    reembedTarget: row.target_model ? { model: row.target_model, dimensions: row.target_dim } : null,
    rechunkTarget: row.target_model ? row.target_chunking ?? null : null,
    batchId: row.batch_id ?? null,
    cancelRequested: row.cancel_requested === true,
    caller,
  };
}

/**
 * The payer of a file attached before usage was recorded (its stamp is null):
 * the credential of its batch's job, or null for a single attach or a job that
 * recorded none (a batch from before fs_jobs) — no credential is invented.
 *
 * onBehalfOf is the job's `owner_email` (the store's owner), as for a stamped
 * attach: ingestion is the owner's usage, also when an admin started the batch.
 * The job row does not say whether its credential is the admin service key,
 * and it need not: the admin honours onBehalfOf only when the credential is
 * the admin service key, so on an OpenAI-API batch it is ignored there. Runs only for unstamped rows,
 * so the extra round trip is paid by legacy rows alone.
 */
async function legacyBatchCaller(storeId: string, batchId: string | null): Promise<FileSearchCaller | null> {
  if (!batchId) return null;
  const pool = getPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT credential_id, auth_type, owner_email FROM fs_jobs
      WHERE batch_id = $1 AND store_id = $2 AND kind = 'file_batch'`,
    [batchId, storeId],
  );
  const job = rows[0];
  if (!job) return null;
  return storedFileSearchCaller(job.credential_id, job.auth_type, job.owner_email);
}

/**
 * Marks every still-`in_progress` member of a cancelled batch `cancelled`, in
 * one statement.
 *
 * SCOPED BY `store_id` AND `batch_id`, never by `batch_id` alone: this
 * codebase enforces its tenant boundary by predicate everywhere (see
 * `batches.ts`'s module comment and `storeAccessPredicateSql`), never by id
 * entropy, and a write that rewrites other people's rows is the worst place to
 * make an exception. Dropping `batch_id` instead would cancel every sibling
 * batch in the same store — the mutation "does not cancel files from a
 * DIFFERENT batch in the same store" exists to catch.
 *
 * `status = 'in_progress'` is what makes this non-retroactive. A member that
 * already reached `completed` (or `failed`) keeps that status and its chunks:
 * cancellation stops future work, it does not undo finished work. It also
 * makes the statement idempotent, so two worker loops that concurrently claim
 * two members of the same cancelled batch simply have the loser update zero
 * rows.
 *
 * The members are locked in file_id order first — the order a job retry locks
 * them in (jobs.ts) — so the two cannot deadlock.
 *
 * Returns the number of files this call actually stopped — metadata only, for
 * the log line at the call site.
 */
async function cancelRemainingBatchFiles(storeId: string, batchId: string): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE vector_store_files
          SET status = 'cancelled', claimed_at = NULL
        WHERE store_id = $1 AND batch_id = $2 AND status = 'in_progress'
          AND file_id IN (
            SELECT file_id FROM vector_store_files
             WHERE store_id = $1 AND batch_id = $2 AND status = 'in_progress'
             ORDER BY file_id
             FOR UPDATE)`,
      [storeId, batchId],
    );
    // The batch has no member in_progress now: its job finishes here.
    await settleFinishedIfTerminal(client, batchId);
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** The vectors of one file's chunks embedded with one model (index-aligned with the chunks;
 *  null for a chunk that is not embedded, see embeddingInputOf), and the provider's token count. */
export interface EmbeddedChunks {
  vectors: Array<Float32Array | number[] | null>;
  tokens: number;
}

/** A chunk as commitChunks stores it: the prepared row; the structure fields may be left out (static). */
export type CommitChunk = Chunk & Partial<Omit<PreparedChunk, 'ord' | 'text' | 'tokens'>>;

/** What commitChunks did: wrote the file; found nothing to do (a delete or a
 *  terminal row won the race); or found that the store needs vectors of a model
 *  it was not given — the store's model or its running re-embed changed after
 *  the caller read them — and wrote nothing. */
export type CommitOutcome = 'committed' | 'skipped' | 'stale';

/**
 * One file's chunks by one chunking setting, with their vectors per model. While the store
 * re-chunks, the active generation needs the file chunked by the store's setting and the
 * target generation by the job's: two sets. `key` is the setting's chunkingKey; null = a set
 * that serves every generation when it is the only set (the tests' single-set commit).
 */
export interface ChunkSet {
  key: string | null;
  chunks: CommitChunk[];
  embedded: Readonly<Record<string, EmbeddedChunks>>;
  /** The context writer's spend on these chunks (contextual settings only). */
  context?: ContextTotals;
}

/**
 * Writes chunks + embeddings and flips the row to `completed`, all inside
 * one transaction that re-verifies the store and the attachment still exist
 * under lock immediately before writing — see the module doc comment for
 * the full, adjudicated account of what each of the two checks below
 * actually closes: `FOR SHARE` is load-bearing against `deleteStoreCascade`,
 * the `vector_store_files` block is load-bearing against `deleteStoreFile`
 * (via its existence/status check, not its `FOR UPDATE` modifier), and
 * neither substitutes for the other. Silently rolls back and returns (no
 * throw, no error recorded) if either check fails: that is a legitimate
 * race with a delete, not an ingestion failure.
 *
 * WHICH GENERATIONS are decided here, under the store's `FOR SHARE` lock, never
 * from a value the caller read earlier: the store's active generation with the
 * store's model, plus — while a re-embed of the store runs — the job's target
 * generation with the job's target model (plan Decision 2), whose work item is
 * then recorded completed so the switch counts this file. Every re-embed state
 * change (start, switch, cancel, retry) takes the store row `FOR UPDATE`, so
 * neither can change before this transaction ends. `embedded` holds the vectors
 * per model; when a needed model is missing (a switch or a start happened since
 * the caller read the store) nothing is written and 'stale' tells the caller to
 * embed again. Only the generations written are deleted first, so an ingestion
 * retry never wipes a generation it does not write.
 *
 * WHICH CHUNKS go to each generation are decided here as well: the active
 * generation takes the set chunked by the store's setting, a re-chunk's target
 * generation the set chunked by the job's `target_chunking` (a plain re-embed's
 * target takes the active set again) — each resolved with the file's own
 * strategy (chunkingSetting.ts). A set the caller did not prepare is 'stale' too,
 * so a re-chunk that started or switched since the caller read the store makes
 * it chunk again. Usage bytes, the batch's counters and the re-embed's counters
 * come from the set written to the generation they describe.
 *
 * Two test-only hooks, both no-ops in production:
 * - `onStoreShareAcquiredForTests` fires right after `FOR SHARE` succeeds,
 *   before the `vector_store_files` lock is even attempted — the only way
 *   to construct the actual lock-order CYCLE a deadlock needs (see
 *   storeFiles.ts's `deleteStoreFile` doc comment for the mechanism): a
 *   test can kick off a concurrent delete from here so it acquires the
 *   `vector_store_files` row while this transaction is still only holding
 *   `FOR SHARE`, then let this transaction attempt the second lock and
 *   observe whether the two sides cycle.
 * - `onLocksAcquiredForTests` fires once BOTH locks are held, before any
 *   write — for the simpler "ingestion holds everything, a delete blocks
 *   entirely behind it" orderings, which can never cycle (see the module
 *   doc comment) but can still orphan chunks if the wrong lock is missing.
 */
async function commitChunks(
  storeId: string, fileId: string, chunks: CommitChunk[],
  embedded: Readonly<Record<string, EmbeddedChunks>>,
  onStoreShareAcquiredForTests?: () => Promise<void>,
  onLocksAcquiredForTests?: () => Promise<void>,
  context?: ContextTotals,
): Promise<CommitOutcome> {
  return commitChunkSets(storeId, fileId, [{ key: null, chunks, embedded, context }],
    { onStoreShareAcquiredForTests, onLocksAcquiredForTests });
}

/** commitChunkSets' optional parts: the file's OCR page counts and the two test-only hooks. */
interface CommitChunkSetsOptions {
  /** The file's OCR page counts (one per file, whatever the number of sets): added to its batch's job. */
  ocr?: OcrCounters;
  onStoreShareAcquiredForTests?: () => Promise<void>;
  onLocksAcquiredForTests?: () => Promise<void>;
}

/** commitChunks with one chunk set per chunking setting (see ChunkSet and the doc comment above). */
async function commitChunkSets(
  storeId: string, fileId: string, sets: ChunkSet[], options: CommitChunkSetsOptions = {},
): Promise<CommitOutcome> {
  const { ocr, onStoreShareAcquiredForTests, onLocksAcquiredForTests } = options;
  const pool = getPool();
  if (!pool) return 'skipped';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load-bearing guard against deleteStoreCascade — see the module doc
    // comment for the full mutation-verified picture. Blocks a concurrent
    // cascade at its shared first step, before it can reach the
    // DELETE FROM vector_store_chunks that would otherwise run too early
    // and miss chunks this transaction hasn't inserted yet.
    const storeRows = await client.query<{ active_generation: number; embedding_model: string; chunking: unknown }>(
      'SELECT active_generation, embedding_model, chunking FROM vector_stores WHERE id = $1 FOR SHARE', [storeId]);
    if (storeRows.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return 'skipped';
    }

    if (onStoreShareAcquiredForTests) await onStoreShareAcquiredForTests();

    // THIS BLOCK (the SELECT plus the rollback check below) is load-bearing
    // against deleteStoreFile — see the module doc comment for the full,
    // adjudicated account and the two mutations that pinned this down
    // precisely. Do not remove the block. Within it, the `FOR UPDATE`
    // modifier specifically is NOT demonstrably load-bearing for orphan
    // prevention (verified: dropping only the modifier, keeping the
    // existence/status check, still passes 22/22) — it is cheap insurance
    // against an in-flight, uncommitted concurrent detach, kept
    // deliberately rather than because a test currently requires it.
    const vsfRows = await client.query(
      `SELECT status, batch_id, chunking_strategy FROM vector_store_files WHERE store_id = $1 AND file_id = $2 FOR UPDATE`,
      [storeId, fileId],
    );
    if (vsfRows.rowCount === 0 || vsfRows.rows[0].status !== 'in_progress') {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return 'skipped';
    }

    if (onLocksAcquiredForTests) await onLocksAcquiredForTests();

    // The generations to write and the chunk set each takes, read under the store lock
    // (see the doc comment). An invalid store setting throws here: a permanent failure.
    const store = storeRows.rows[0];
    const running = await client.query<{
      id: string; target_model: string; target_generation: number; target_chunking: unknown;
    }>(
      `SELECT id, target_model, target_generation, target_chunking FROM fs_jobs
        WHERE store_id = $1 AND kind = 'reembed_store' AND finished_at IS NULL AND NOT cancel_requested`,
      [storeId],
    );
    const job = running.rows[0];
    const fileStrategy = vsfRows.rows[0].chunking_strategy;
    const activeKey = chunkingKey(resolveChunking({ file: fileStrategy, store: store.chunking ?? null }));
    const writes = [{ generation: store.active_generation, model: store.embedding_model, key: activeKey }];
    if (job) {
      const targetKey = job.target_chunking == null
        ? activeKey : chunkingKey(resolveChunking({ file: fileStrategy, store: job.target_chunking }));
      writes.push({ generation: job.target_generation, model: job.target_model, key: targetKey });
    }
    // A key-less set is commitChunks' single-set form (its callers are tests): it serves every
    // generation, and only when it is the only set. Ingestion (processOne) always keys its sets,
    // so a generation whose setting has no set of its own is 'stale' — never written with the
    // chunks of another setting.
    const single = sets.length === 1 && sets[0].key === null ? sets[0] : null;
    const setFor = (key: string) => single ?? sets.find((s) => s.key === key);
    if (writes.some((w) => !setFor(w.key)?.embedded[w.model])) {
      await client.query('ROLLBACK').catch(() => {});
      return 'stale';
    }

    for (const write of writes) {
      // Defensive, not a sign of a race: chunks are only ever written here,
      // after full success, so a prior partial write can only exist if an
      // earlier attempt crashed mid-transaction (which the transaction itself
      // would have rolled back) — cheap idempotency insurance regardless.
      // Scoped to the generation written: a re-embed may be writing another
      // generation of this same file, and an ingestion retry must not wipe it.
      await client.query(
        'DELETE FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2 AND generation = $3',
        [storeId, fileId, write.generation],
      );
      // The generation's chunk set (text, structure, context) with its model's vectors.
      const set = setFor(write.key)!;
      const { vectors } = set.embedded[write.model];
      // eslint-disable-next-line no-await-in-loop
      await insertChunkRows(client, storeId, fileId, write.generation, set.chunks.map((chunk, i) => ({
        ord: chunk.ord,
        text: chunk.text,
        tokens: chunk.tokens,
        vector: vectors[i] ?? null,
        context: chunk.context ?? null,
        section: chunk.section ?? null,
        sectionOffset: chunk.sectionOffset ?? null,
        headingPath: chunk.headingPath ?? null,
        pageStart: chunk.pageStart ?? null,
        pageEnd: chunk.pageEnd ?? null,
      })));
    }
    const active = setFor(activeKey)!;
    const usageBytes = active.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, 'utf8'), 0);

    // A fresh ingestion is a first try: a context stop is recorded as such (contextStop.ts).
    await client.query(
      `UPDATE vector_store_files
         SET status = 'completed', usage_bytes = $3, last_error = NULL, claimed_at = NULL, extraction_version = $4,
             ocr_pending = $5, context_stopped = $6
       WHERE store_id = $1 AND file_id = $2`,
      [storeId, fileId, usageBytes, EXTRACTION_VERSION, ocrPendingOf(ocr), recordedContextStop(active.context?.stopped, null, false)],
    );

    // The batch's job, in this same transaction: the tokens count once per
    // embedded member (a commit that rolls back counts nothing, and a
    // re-processed completed member never gets here), and finished_at is set
    // when this was the last member in_progress. Lock order: files, then jobs.
    const batchId: string | null = vsfRows.rows[0].batch_id ?? null;
    if (batchId) {
      await addTokens(client, batchId, active.embedded[store.embedding_model].tokens);
      if (active.context) await addContextTotals(client, batchId, active.context);
      // The file's OCR and vision pages, done once for every set (OcrMemo, VisionMemo): counted on the batch's job only.
      if (ocr) await addOcrTotals(client, batchId, ocr);
      await settleFinishedIfTerminal(client, batchId);
    }

    // The re-embed's work item for this file: completed, so the switch counts the
    // file as present in the target generation. Jobs before items, like the item
    // commit in reembed.ts. A re-chunk's job also counts the target set's context
    // spend (a plain re-embed's target reuses the active set: nothing more spent).
    if (job) {
      const target = setFor(writes[1].key)!;
      const targetTokens = Math.trunc(target.embedded[job.target_model].tokens) || 0;
      await client.query(
        'UPDATE fs_jobs SET embedding_tokens = embedding_tokens + $2 WHERE id = $1', [job.id, Math.max(targetTokens, 0)]);
      if (target !== active && target.context) await addJobContextTotals(client, job.id, target.context);
      await client.query(
        `INSERT INTO fs_reembed_items (job_id, store_id, file_id, status, tokens, extraction_version, ocr_pending,
                                       context_stopped)
         VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7)
         ON CONFLICT (job_id, file_id) DO UPDATE
           SET status = 'completed', tokens = EXCLUDED.tokens, claimed_at = NULL, last_error = NULL,
               extraction_version = EXCLUDED.extraction_version, ocr_pending = EXCLUDED.ocr_pending,
               context_stopped = EXCLUDED.context_stopped`,
        [job.id, storeId, fileId, Math.max(targetTokens, 0), EXTRACTION_VERSION, ocrPendingOf(ocr),
          recordedContextStop(target.context?.stopped, null, false)],
      );
    }

    await client.query('COMMIT');
    return 'committed';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Records a failed attempt with one atomic UPDATE (no read-then-write gap),
 * followed in the same transaction by settling the batch's job when the
 * member turned terminal:
 * permanent failures (see `isPermanentFailure`) go straight to `failed`
 * regardless of the remaining retry budget; everything else stays
 * `in_progress` — reclaimable immediately, since `claimed_at` is cleared
 * rather than left to expire on its own 15-minute lease — until `attempts`
 * (incremented exclusively by `claimNext`, once per real claim) reaches
 * `maxRetries`, at which point it also becomes `failed`. A row already
 * mutated out of `in_progress` by a concurrent delete matches zero rows here
 * and is silently left alone.
 */
async function handleFailure(storeId: string, fileId: string, error: unknown, maxRetries: number): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  // A memory wait that timed out is handed back without an attempt MAX_MEMORY_HANDBACKS times (a busy
  // pool or a stop in between keeps the count; a real failure resets it); after that it spends the attempt like any
  // transient failure (memoryBudget.ts).
  let memoryHandbacks: number | undefined;
  if (error instanceof FileSearchMemoryBusyError && error.reason === 'timeout') { // a stopping worker is never the file's fault
    const { rows } = await pool.query<{ n: number | null }>(
      `SELECT (last_error->>'memory_handbacks')::int AS n FROM vector_store_files WHERE store_id = $1 AND file_id = $2`,
      [storeId, fileId]);
    memoryHandbacks = (rows[0]?.n ?? 0) + 1;
  }
  if (error instanceof FileSearchBusyError && (memoryHandbacks === undefined || memoryHandbacks <= MAX_MEMORY_HANDBACKS)) {
    await handBackBusy(storeId, fileId, error, memoryHandbacks);
    return;
  }
  const permanent = isPermanentFailure(error);
  const errInfo = { ...serializeError(error), ...(memoryHandbacks ? { memory_handbacks: memoryHandbacks } : {}) };

  // Metadata only — never the extracted text, chunk text, or filename (user
  // document content) directly. `error.message` here is a library-generated
  // message (extractor/embedder/DB driver), not raw document content — but
  // pandoc/pdftotext stderr can legitimately quote a fragment of the
  // document they failed to parse, so `error.message` is NOT unconditionally
  // safe on its own merits; it's runners.ts's `sanitizeStderrForError` that
  // truncates and strips control characters BEFORE that message ever
  // reaches the Error this function receives, closing that specific gap.
  if (error instanceof EmbeddingModelUnavailableError) {
    // An expected state with a known remedy (re-embed the store), not a fault.
    logger.warn('IngestWorker', `Ingestion attempt failed for store ${storeId}, file ${fileId}: `
      + `the store's embedding model '${error.model}' is not served`, { permanent });
  } else {
    logger.error(
      'IngestWorker',
      `Ingestion attempt failed for store ${storeId}, file ${fileId}`,
      error instanceof Error ? error : new Error(String(error)),
      { permanent },
    );
  }

  // A member that turns `failed` here may be the last one in_progress, so its
  // job is settled in the same transaction.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: string; batch_id: string | null }>(
      `UPDATE vector_store_files
         SET status = CASE WHEN $3::boolean OR attempts >= $4 THEN 'failed' ELSE 'in_progress' END,
             claimed_at = NULL,
             last_error = $5::jsonb
       WHERE store_id = $1 AND file_id = $2 AND status = 'in_progress'
       RETURNING status, batch_id`,
      [storeId, fileId, permanent, maxRetries, JSON.stringify(errInfo)],
    );
    const row = rows?.[0];
    if (row?.batch_id && row.status !== 'in_progress') {
      await settleFinishedIfTerminal(client, row.batch_id);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * A claimed file whose attempt failed only because the database pool (or the memory budget) was busy: handed back
 * without spending an attempt (see BUSY_HANDBACK_SET). Best effort: if even this fails, the
 * lease expires and the attempt stays spent.
 */
async function handBackBusy(
  storeId: string, fileId: string, error: FileSearchBusyError, memoryHandbacks?: number,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  logger.warn('IngestWorker', `Ingestion of store ${storeId}, file ${fileId} deferred: ${busyReason(error)}`);
  await pool.query(
    `UPDATE vector_store_files SET ${BUSY_HANDBACK_SET}, last_error = ${BUSY_HANDBACK_LAST_ERROR_SQL}
      WHERE store_id = $3 AND file_id = $4 AND status = 'in_progress'`,
    [BUSY_RETRY_SECONDS, LEASE_MINUTES, storeId, fileId,
      JSON.stringify({ ...serializeError(error), ...(memoryHandbacks ? { memory_handbacks: memoryHandbacks } : {}) })],
  ).catch((e) => logger.warn('IngestWorker', 'Could not hand a deferred ingestion back; its lease expires instead',
    { storeId, fileId, error: e instanceof Error ? e.message : String(e) }));
}

/**
 * The chunk sets a file of this store needs, as last read (commitChunks decides again under
 * the store lock): the store's own setting with the store's model, and — while a re-embed
 * runs — its target model, by the job's target setting when it re-chunks (a separate set) or
 * by the store's setting when it only re-embeds (the same set, a second model).
 */
function neededChunkSets(ctx: JobContext): Array<{ setting: ChunkingSetting; models: Array<{ model: string; dimensions: number }> }> {
  const own = resolveChunking({ file: ctx.chunkingStrategy, store: ctx.storeChunking ?? null });
  const storeModel = { model: ctx.embeddingModel, dimensions: ctx.embeddingDim };
  if (!ctx.reembedTarget) return [{ setting: own, models: [storeModel] }];
  const targetModel = { model: ctx.reembedTarget.model, dimensions: ctx.reembedTarget.dimensions };
  if (ctx.rechunkTarget == null) return [{ setting: own, models: [storeModel, targetModel] }];
  const target = resolveChunking({ file: ctx.chunkingStrategy, store: ctx.rechunkTarget });
  if (chunkingKey(target) === chunkingKey(own)) return [{ setting: own, models: [storeModel, targetModel] }];
  return [{ setting: own, models: [storeModel] }, { setting: target, models: [targetModel] }];
}

/**
 * Processes one already-`in_progress` `vector_store_files` row to completion:
 * fetches its blob, extracts text, chunks it, embeds every chunk, and writes
 * the chunks — or marks the row `failed` via `handleFailure`.
 *
 * Deliberately does NOT touch `attempts`: that is `claimNext`'s exclusive
 * responsibility (see its doc comment). This function only reads the row's
 * CURRENT `attempts` (via `handleFailure`'s single atomic UPDATE) to decide,
 * on failure, whether the budget for THIS row is exhausted.
 *
 * Safe to call directly on a freshly-attached row (attempts=0, claimed_at
 * null) without going through `claimNext` first — the lease is `claimNext`'s
 * fairness mechanism for choosing WHICH row to work on next across a busy
 * table; once a specific (storeId, fileId) pair is already known, doing the
 * work doesn't depend on it. Also a true no-op (no extract/chunk/embed call)
 * when the row is missing or already terminal — re-processing an
 * already-completed file never re-embeds it.
 *
 * Honours batch cancellation, between files: if this file belongs to a batch
 * whose cancellation was requested, it stops the whole batch instead of
 * ingesting — see the comment on that check below for why the boundary is
 * here and nowhere finer-grained.
 *
 * Bounded in time by `options.budgetMs` (default `PROCESS_BUDGET_MS`, below the
 * lease): no embed call starts past the deadline, and each gets the deadline to
 * stop its own sub-batches at; running out is a transient failure.
 */
export async function processOne(
  storeId: string, fileId: string, options: { budgetMs?: number } = {},
): Promise<void> {
  try {
    // One SAP target for the whole item: its embedding and completion calls and their usage events.
    await withLatestSapTarget(() => processOneUnguarded(storeId, fileId, options));
  } catch (error) {
    // A busy pool outside the attempt's own error handling (its first read): hand it back too.
    if (!(error instanceof FileSearchBusyError)) throw error;
    await handBackBusy(storeId, fileId, error);
  }
}

async function processOneUnguarded(
  storeId: string, fileId: string, options: { budgetMs?: number },
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const budgetMs = options.budgetMs ?? PROCESS_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  let ctx = await loadContext(storeId, fileId);
  if (!ctx || ctx.status !== 'in_progress') return;

  // Cooperative cancellation: checked BETWEEN files, never mid-file. A file
  // already past claimNext runs to completion — interrupting mid-embed would
  // leave chunks partially written, and the transaction that commits them is
  // the thing keeping the store consistent. The cost of finishing one more
  // file is bounded and small; the cost of a torn write is not.
  //
  // This is the ONE decision point. It sits after the terminal-status check
  // above (an already-`completed` row is never re-examined) and before any
  // extract/embed work, so a cancelled batch costs one claim and one UPDATE
  // rather than a document's worth of ingestion.
  //
  // Cancelling the WHOLE batch here, not just this file, is what makes the
  // batch reach a terminal status at all: `claimNext` only ever returns
  // `in_progress` rows, so skipping without the UPDATE would leave the rest of
  // the batch claimable forever and `deriveBatchStatus` reporting
  // `in_progress` forever. It also means the batch is swept exactly once — the
  // members are terminal afterwards, so no later cycle claims them again.
  //
  // The mid-file race resolves itself with no extra machinery: a sibling loop
  // already embedding another member of this batch will find its row no longer
  // `in_progress` in `commitChunks`'s locked re-check and roll back cleanly,
  // and `handleFailure`'s own `status = 'in_progress'` predicate likewise
  // cannot resurrect a row this statement just cancelled.
  if (ctx.batchId && ctx.cancelRequested) {
    const stopped = await cancelRemainingBatchFiles(storeId, ctx.batchId);
    // Ids and counts only — never the filename or any extracted text.
    logger.info('IngestWorker', 'Stopped ingesting a cancelled file batch', {
      storeId,
      batchId: ctx.batchId,
      filesCancelled: stopped,
    });
    return;
  }

  const config = getFileSearchConfig();
  // PDF pages read by OCR, kept for every chunk set of this ingestion (a re-chunk extracts twice).
  const ocrMemo = new OcrMemo();
  // Likewise the pages a vision model transcribed (only when the store's setting opted in).
  const visionMemo = new VisionMemo();
  const memory = new FileMemory(deadline);
  try {
    // Cheap defense-in-depth: a store whose pinned embedding_dim has drifted
    // from the live config can never successfully embed for this store (see
    // storeValidation.ts's own comment on why the pinned dimension exists) — fail
    // fast rather than burn an embeddings call and the retry budget on a
    // store that is permanently stuck until an operator recreates it.
    await assertStoreDimension({ embedding_dim: ctx.embeddingDim });

    // From the storage the blob row names, not the configured backend. A BlobUnavailableError is
    // retried like any transient failure (credentials or the bucket may come back).
    const bytes = await openBlob(ctx.sha256);

    // One chunk set per chunking setting the store needs — its own setting (the file's static
    // strategy wins, NULL = 800/400) and, while it re-chunks, the job's target setting. Each is
    // extracted, chunked and given contexts once; a stale commit below only prepares what it
    // lacks and embeds the models still missing.
    const sets = new Map<string, ChunkSet & { inputs: Array<string | null>; embeddable: number[] }>();
    // The memory this file holds until its commit (memoryBudget.ts FileMemory): right after the first
    // extraction — before any chunking or context call — the text and an estimate of the vectors of
    // every chunk set and model still to prepare are reserved, waiting at most half of the remaining
    // budget (or until the worker stops: then the file is handed back unspent); after chunking each
    // set is settled to its real size, a larger one growing by the difference only.
    const maxChunks = (need: { models: Array<{ dimensions: number }> }) =>
      maxChunksPerFile(Math.max(...need.models.map((m) => m.dimensions)), config.limits.maxTokensPerFile);
    const dimsOf = (need: { models: Array<{ dimensions: number }> }) => need.models.reduce((n, m) => n + m.dimensions, 0);
    const textBytes = new Map<string, number>();
    for (let attempt = 1; ; attempt += 1) {
      const needs = neededChunkSets(ctx);
      for (const need of needs) {
        const key = chunkingKey(need.setting);
        if (sets.has(key)) continue;
        const onExtracted = async (x: ExtractedSize): Promise<void> => {
          textBytes.set(key, textReserveBytes(x.textChars));
          await memory.reserve(needs.filter((n) => !sets.has(chunkingKey(n.setting))).map((n) => ({
            key: chunkingKey(n.setting),
            bytes: textReserveBytes(x.textChars)
              + vectorReserveBytes(estimatedChunkCount(x.estimatedTokens, n.setting, maxChunks(n)), dimsOf(n)),
          })));
        };
        // eslint-disable-next-line no-await-in-loop
        const prepared = await prepareFileChunks(ctx.filename, bytes, need.setting, {
          extractTimeoutMs: config.ingestion.extractTimeoutMs,
          maxTokensPerFile: config.limits.maxTokensPerFile,
          deadline,
          caller: ctx.caller,
          // The chunk ceiling holds for the largest vectors the set gets.
          embeddingDimensions: Math.max(...need.models.map((m) => m.dimensions)),
          onExtracted,
          ocr: { memo: ocrMemo, sha256: ctx.sha256 },
          vision: { memo: visionMemo },
        });
        // What each chunk is embedded with; a chunk of only whitespace is stored but not embedded.
        const inputs = prepared.chunks.map((c) => embeddingInputOf(c));
        sets.set(key, {
          key, chunks: prepared.chunks, context: prepared.context, embedded: {},
          inputs, embeddable: inputs.flatMap((input, i) => (input === null ? [] : [i])),
        });
      }
      // Each set at its real size, for every model it is embedded with (a stale commit may add one).
      for (const need of needs) {
        const key = chunkingKey(need.setting);
        const real = (textBytes.get(key) ?? 0) + vectorReserveBytes(sets.get(key)!.embeddable.length, dimsOf(need));
        const over = memory.settle(key, real);
        if (over > 0) {
          logger.info('IngestWorker', 'A file needs more memory than estimated; its reservation grew', {
            storeId, fileId, bytesOverEstimate: over,
          });
        }
      }
      for (const need of needs) {
        const set = sets.get(chunkingKey(need.setting))!;
        const { chunks, inputs, embeddable } = set;
        const embedded = set.embedded as Record<string, EmbeddedChunks>;
        // The store's model, never the configured one: a store holds one model's
        // vectors at all times, and its search embeds queries with that same model.
        // While the store re-embeds, also the job's target model (Decision 2).
        for (const target of need.models) {
          if (embedded[target.model]) continue;
          if (embeddable.length === 0) {
            embedded[target.model] = { vectors: chunks.map(() => null), tokens: 0 };
            continue;
          }
          if (Date.now() >= deadline) throw new IngestionDeadlineExceededError(budgetMs);
          const { caller } = ctx;
          // eslint-disable-next-line no-await-in-loop
          const result = await embed(embeddable.map((i) => inputs[i] as string), 'document', target, {
            deadline,
            // One event per embedding request, recorded as it succeeds: a later
            // failure or a stale commit does not undo what SAP already billed.
            onUsage: (u) => emitFileSearchUsage(caller, {
              endpoint: 'file_search/ingest',
              model: target.model,
              inputTokens: u.promptTokens,
              unit: 'tokens',
              responseTime: u.elapsedMs,
              requestId: workerRequestId('ingest'),
            }),
          });
          const vectors: Array<Float32Array | null> = chunks.map(() => null);
          embeddable.forEach((chunkIndex, k) => { vectors[chunkIndex] = result.vectors[k]; });
          embedded[target.model] = { vectors, tokens: result.usage.totalTokens };
          // Metadata only (counts, never chunk text). The total is also added to
          // the batch's (or the re-embed's) job in commitChunks.
          logger.debug('IngestWorker', 'Ingestion embedding usage', {
            storeId,
            fileId,
            model: target.model,
            chunkCount: chunks.length,
            embeddedCount: embeddable.length,
            promptTokens: result.usage.promptTokens,
            totalTokens: result.usage.totalTokens,
          });
        }
      }

      // eslint-disable-next-line no-await-in-loop
      const outcome = await commitChunkSets(storeId, fileId, [...sets.values()], {
        ocr: { ...ocrMemo.totals(), ...visionMemo.counters() },
      });
      if (outcome !== 'stale') break;
      if (attempt >= MAX_STALE_COMMITS) {
        throw new Error('The store\'s embedding model or chunking changed repeatedly while this file was being ingested');
      }
      // eslint-disable-next-line no-await-in-loop
      const next = await loadContext(storeId, fileId);
      if (!next || next.status !== 'in_progress') return;
      ctx = next;
    }
  } catch (error) {
    await handleFailure(storeId, fileId, error, config.ingestion.maxRetries);
  } finally {
    memory.release();
    logOcrTotals(ocrMemo, { storeId, fileId });
    logVisionTotals(visionMemo, { storeId, fileId });
  }
}

// ---------------------------------------------------------------------------
// The worker loop: N concurrent claim-and-process cycles (N =
// ingestion.concurrency), polling when idle. `wake` exists solely so
// `stopIngestWorker` can resolve every idle loop's sleep immediately instead
// of waiting out up to POLL_INTERVAL_MS per loop on shutdown.
// ---------------------------------------------------------------------------

interface WorkerState {
  stopped: boolean;
  /** Aborted by stopIngestWorker: ends every wait for memory at once (the claim is handed back). */
  stop: AbortController;
  loops: Promise<void>[];
  wake: EventEmitter;
  hintSubscription: IngestHintSubscription;
  /** When this process last looked for idle re-embed jobs (Date.now()). */
  lastIdleSettle: number;
}

let workerState: WorkerState | null = null;

function waitForWakeOrTimeout(state: WorkerState, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(onWake, ms);
    // Never keep the event loop (or a test) alive just for this poll timer.
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    function onWake() {
      clearTimeout(timer);
      state.wake.removeListener('wake', onWake);
      resolve();
    }
    state.wake.once('wake', onWake);
  });
}

async function runLoop(state: WorkerState): Promise<void> {
  while (!state.stopped) {
    let job: Job | null = null;
    try {
      job = await claimNext();
    } catch (error: any) {
      logger.error('IngestWorker', 'claimNext failed', error instanceof Error ? error : new Error(String(error)));
    }

    if (job) {
      // Finish work already claimed even if stop fired concurrently — the
      // claim already consumed an attempt, so abandoning it would waste the
      // budget and leave the row locked out until its lease expires.
      try {
        await processOne(job.storeId, job.fileId);
      } catch (error: any) {
        // processOne catches its own extract/chunk/embed/commit errors via
        // handleFailure; reaching here means something failed outside that
        // (e.g. the DB itself is unreachable) — log and keep the loop alive.
        logger.error('IngestWorker', 'processOne threw unexpectedly',
          error instanceof Error ? error : new Error(String(error)), { storeId: job.storeId, fileId: job.fileId });
      }
      continue;
    }

    if (state.stopped) break;

    // The second queue: re-embed work items, tried only when no upload is
    // waiting, so user uploads keep priority (plan Decision 4).
    let item: Awaited<ReturnType<typeof claimNextReembedItem>> = null;
    try {
      item = await claimNextReembedItem();
    } catch (error: any) {
      logger.error('IngestWorker', 'claimNextReembedItem failed', error instanceof Error ? error : new Error(String(error)));
    }
    if (item) {
      try {
        await processReembedItem(item);
      } catch (error: any) {
        logger.error('IngestWorker', 'processReembedItem threw unexpectedly',
          error instanceof Error ? error : new Error(String(error)), { jobId: item.jobId, fileId: item.fileId });
      }
      continue;
    }

    // Idle: finish re-embeds that have nothing left to claim (their last item was
    // detached, a crash came between an item and the switch). Throttled per process.
    if (Date.now() - state.lastIdleSettle >= POLL_INTERVAL_MS) {
      state.lastIdleSettle = Date.now();
      try {
        await settleIdleReembedJobs();
      } catch (error: any) {
        logger.error('IngestWorker', 'settleIdleReembedJobs failed', error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (state.stopped) break;
    await waitForWakeOrTimeout(state, POLL_INTERVAL_MS);
  }
}

/**
 * Starts `ingestion.concurrency` concurrent claim-and-process loops. A no-op
 * (logged, not thrown) if file_search is unavailable — no database
 * configured is the normal state for a standalone install — or if already
 * running.
 */
export function startIngestWorker(): void {
  if (workerState) return;
  if (!isFileSearchAvailable()) {
    logger.info('IngestWorker', 'file_search is unavailable (no database configured, or disabled); ingestion worker not started');
    return;
  }
  const config = getFileSearchConfig();
  const wake = new EventEmitter();
  wake.setMaxListeners(0);
  // Strictly a latency accelerator: subscribeIngestHints is a no-op
  // subscription when valkey isn't configured (see ingestHint.ts), in which
  // case this callback simply never fires and every loop drains purely via
  // its own poll interval — see the module doc comment.
  const hintSubscription = subscribeIngestHints(() => wake.emit('wake'));
  const state: WorkerState = { stopped: false, stop: new AbortController(), loops: [], wake, hintSubscription, lastIdleSettle: 0 };
  workerState = state;
  setMemoryWaitStopSignal(state.stop.signal);
  // Leftovers of a gateway killed mid-extraction. Only directories older than the extraction
  // timeout plus a margin (a run outlives it by the SIGKILL grace; floor 10 min) go, so a live run (this gateway's or another's) stays. Best effort, off the boot path.
  sweepStaleExtractDirs(Math.max(config.ingestion.extractTimeoutMs + 60_000, 10 * 60_000)).then(
    (removed) => {
      if (removed > 0) logger.info('IngestWorker', `Removed ${removed} leftover fs-extract temporary director${removed === 1 ? 'y' : 'ies'}`);
    },
    (error) => logger.warn('IngestWorker', `Sweep of leftover fs-extract directories failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  for (let i = 0; i < config.ingestion.concurrency; i++) {
    state.loops.push(runLoop(state));
  }
  logger.info('IngestWorker', `Started with concurrency ${config.ingestion.concurrency}`);
}

/** Stops all loops, waiting for any in-flight `processOne` call to finish
 *  first. Safe to call when the worker was never started. */
export async function stopIngestWorker(): Promise<void> {
  const state = workerState;
  if (!state) return;
  workerState = null;
  state.stopped = true;
  state.stop.abort(); // every wait for memory ends now; claims in flight finish
  state.wake.emit('wake');
  await Promise.all(state.loops);
  clearMemoryWaitStopSignal(state.stop.signal); // not a newer worker's, started while this one drained
  // Symmetric cleanup: the subscriber (opened by this same start cycle) and
  // the publisher (lazily opened, possibly by an earlier enqueueIngestion
  // call, and reused across the whole process) both get closed on stop —
  // previously only the subscriber did.
  await state.hintSubscription.close();
  await closePublisher();
  await closeStructureChunkThread();
  await closeOfficeReaderThread();
}

export function __isRunningForTests(): boolean {
  return workerState !== null;
}

/**
 * Exposes `commitChunks` (including its test-only `onLocksAcquiredForTests`
 * hook) so ingestWorker.integration.test.ts can force the
 * "ingestion-locks-first, holds the transaction open across a concurrent
 * delete" ordering deterministically — see the module doc comment and
 * commitChunks's own doc comment. Never called this way in production.
 */
export { commitChunks as __commitChunksForTests };

/** commitChunkSets, for the per-generation chunk-set tests (rechunk.test.ts). Never called this way in production. */
export { commitChunkSets as __commitChunkSetsForTests };

/**
 * Exposes `sanitizeErrorMessage` for a direct, hermetic unit test of its
 * control-character/path/length transformations (ingestWorker.test.ts).
 * ingestWorker.integration.test.ts additionally proves this is genuinely
 * WIRED IN to `handleFailure` against a real Postgres error and a
 * realistic spawn-failure message; this export is for the transformation
 * logic itself, independent of what a live run happens to produce. Never
 * imported this way in production.
 */
export { sanitizeErrorMessage as __sanitizeErrorMessageForTests };
