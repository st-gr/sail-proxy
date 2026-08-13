// Asynchronous file_search ingestion worker.
//
// The `vector_store_files` row IS the job: `attachFile` (Task 10) inserts it
// with status='in_progress', and this module claims those rows with
// `FOR UPDATE SKIP LOCKED` so multiple gateway replicas never claim the
// same one, extracts text, chunks it, embeds every chunk, and writes the
// chunks — or marks the row `failed` with `last_error`.
//
// VALKEY HINT: wired up via ingestHint.ts. `repository.ts`'s
// `enqueueIngestion` publishes; `startIngestWorker` below subscribes and
// wakes every idle loop immediately on a hint. Strictly an accelerator —
// per the design doc, "the database row is the source of truth; valkey is
// an accelerator" — never awaited for correctness: every claim/lease/retry
// test in ingestWorker.test.ts and its integration counterpart runs with no
// VALKEY_URL set and proves polling alone still drains the queue.
//
// CONCURRENCY HAZARD (see Task 10's report / repository.ts's own comments):
// `vector_store_chunks` has NO foreign key. `deleteStoreCascade` takes
// `FOR UPDATE` on the `vector_stores` row, then deletes chunks, THEN deletes
// the `vector_store_files` row (in that order — the chunk delete comes
// FIRST, which is exactly what makes it dangerous, see below). `deleteStoreFile`
// (a per-file detach) now ALSO takes `FOR UPDATE` on `vector_stores` first
// (fixed post-review — see repository.ts's doc comment on that function for
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
import { getFileSearchConfig } from '../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { extractText, UnsupportedFileTypeError } from './extractors/registry';
import { chunkText, resolveChunkingStrategy, estimateTokens, Chunk } from './chunker';
import { embed } from './embedder';
import { getBackend } from './blob/blobStore';
import { assertStoreDimension, StoreDimensionMismatchError } from './repository';
import { subscribeIngestHints, closePublisher, IngestHintSubscription } from './ingestHint';

const logger = getDefaultLogger();

// Bound as a parameter (never interpolated) into both reapZombies's and
// claimNext's own SQL below, each as `$N::int * interval '1 minute'` —
// Postgres can't parameterise an interval literal directly, but it can
// multiply one. Kept as one named constant so the doc comment and both
// queries can't silently drift apart.
const LEASE_MINUTES = 15;

// How often an idle worker loop polls for new work when nothing woke it
// early. Only matters while the queue is empty; a loop that just claimed and
// processed a job loops straight back into claimNext without waiting.
const POLL_INTERVAL_MS = 2000;

export interface Job {
  storeId: string;
  fileId: string;
}

/** Thrown when extracted text exceeds `limits.maxTokensPerFile`. Permanent —
 *  the file will never get smaller by retrying. */
export class FileTooLargeError extends Error {
  constructor(readonly tokens: number, readonly maxTokens: number) {
    super(`Extracted text is ~${tokens} tokens, exceeding the configured limit of ${maxTokens} tokens per file`);
    this.name = 'FileTooLargeError';
  }
}

/** Permanent failures must never be retried against the attempt budget —
 *  retrying them can never succeed, so doing so only wastes the budget a
 *  transient failure (a timeout, an upstream 500) genuinely needs. */
function isPermanentFailure(error: unknown): boolean {
  return (
    error instanceof UnsupportedFileTypeError ||
    error instanceof FileTooLargeError ||
    error instanceof StoreDimensionMismatchError
  );
}

// Bounds how much of a persisted `last_error.message` a maintainer keeps —
// generous for a human-readable summary, small next to a raw stack trace.
const MAX_LAST_ERROR_MESSAGE_LENGTH = 500;

/**
 * Sanitizes an error message before it is persisted to `vector_store_files.
 * last_error` (`handleFailure` below) and served back over `GET
 * /vector_stores/{id}/files` and `.../files/{id}` (`vectorStoresController.
 * ts`'s `toStoreFileObject`). Only the file's own owner can ever see this
 * value — this is not a cross-tenant leak — but this branch's rule
 * everywhere else is that no API-facing surface echoes a raw driver string
 * or a filesystem path, and `last_error` is the one place that rule was
 * never applied: `error.message` here can be a raw Postgres driver message
 * (a query inside `commitChunks` failing, e.g. a constraint violation or a
 * connectivity error) or `runners.ts`'s child-process launch failure, which
 * embeds the extractor binary's fully resolved absolute path (e.g. `spawn
 * /usr/local/bin/pandoc EACCES` — see `resolveBinary`'s doc comment).
 *
 * Strips control characters (the same log/terminal-injection concern
 * `runners.ts`'s own `sanitizeStderrForError` guards against for stderr
 * specifically), collapses any absolute filesystem path to a placeholder,
 * and bounds the length. `error.name` (a stable, safe category like
 * `UnsupportedFileTypeError`/`ExtractionTimeoutError`/`Error`) is kept
 * unmodified alongside it, so an owner can still tell what KIND of failure
 * occurred even once the message itself is redacted/truncated.
 */
function sanitizeErrorMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  const noControlChars = message.replace(/[\x00-\x1f\x7f]/g, ' ');
  // Matches a Unix-style absolute path (`/`, then one or more `/`-separated
  // segments) wherever it appears in the message — not just at the start —
  // since these errors are usually a larger sentence with the path embedded
  // partway through (e.g. "spawn /usr/local/bin/pandoc EACCES").
  const noPaths = noControlChars.replace(/\/(?:[^\s/]+\/)+[^\s/]*/g, '[path]');
  const collapsed = noPaths.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_LAST_ERROR_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_LAST_ERROR_MESSAGE_LENGTH)}… [truncated]`
    : collapsed;
}

function serializeError(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) {
    return { message: sanitizeErrorMessage(error.message), name: error.name };
  }
  return { message: sanitizeErrorMessage(String(error)) };
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
 */
async function reapZombies(maxRetries: number): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `UPDATE vector_store_files
       SET status = 'failed', claimed_at = NULL, last_error = $2::jsonb
     WHERE status = 'in_progress'
       AND attempts >= $1
       AND (claimed_at IS NULL OR claimed_at < now() - ($3::int * interval '1 minute'))`,
    [maxRetries, JSON.stringify({
      message: 'Ingestion was interrupted after exhausting its retry budget (the worker likely crashed, ' +
        'was OOM-killed, or restarted mid-attempt) and could not automatically resolve to a terminal state.',
      name: 'MaxRetriesExceededZombie',
    }), LEASE_MINUTES],
  );
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
  const { rows } = await pool.query(
    `UPDATE vector_store_files SET claimed_at = now(), attempts = attempts + 1
     WHERE (store_id, file_id) IN (
       SELECT store_id, file_id FROM vector_store_files
       WHERE status = 'in_progress'
         AND (claimed_at IS NULL OR claimed_at < now() - ($2::int * interval '1 minute'))
         AND attempts < $1
       ORDER BY created_at LIMIT 1
       FOR UPDATE SKIP LOCKED)
     RETURNING store_id, file_id`,
    [config.ingestion.maxRetries, LEASE_MINUTES],
  );
  if (rows.length === 0) return null;
  return { storeId: rows[0].store_id, fileId: rows[0].file_id };
}

interface JobContext {
  status: string;
  chunkingStrategy: unknown;
  filename: string;
  sha256: string;
  embeddingDim: number;
  /** The batch this file was attached as part of, or `null` for the
   *  single-file attach path (`attachFile`'s default). */
  batchId: string | null;
  /** Whether cancellation was requested for that batch. Always `false` for a
   *  file that belongs to no batch. */
  cancelRequested: boolean;
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
    `SELECT vsf.status, vsf.chunking_strategy, vsf.batch_id, f.filename, f.sha256, vs.embedding_dim,
            COALESCE(b.cancel_requested, false) AS cancel_requested
     FROM vector_store_files vsf
     JOIN fs_files f ON f.id = vsf.file_id
     JOIN vector_stores vs ON vs.id = vsf.store_id
     LEFT JOIN vector_store_batches b ON b.id = vsf.batch_id AND b.store_id = vsf.store_id
     WHERE vsf.store_id = $1 AND vsf.file_id = $2`,
    [storeId, fileId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    status: row.status,
    chunkingStrategy: row.chunking_strategy,
    filename: row.filename,
    sha256: row.sha256,
    embeddingDim: row.embedding_dim,
    batchId: row.batch_id ?? null,
    cancelRequested: row.cancel_requested === true,
  };
}

/**
 * Marks every still-`in_progress` member of a cancelled batch `cancelled`, in
 * one statement.
 *
 * SCOPED BY `store_id` AND `batch_id`, never by `batch_id` alone: this
 * codebase enforces its tenant boundary by predicate everywhere (see
 * `batches.ts`'s module comment and `STORE_ACCESS_PREDICATE_SQL`), never by id
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
 * Returns the number of files this call actually stopped — metadata only, for
 * the log line at the call site.
 */
async function cancelRemainingBatchFiles(storeId: string, batchId: string): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const result = await pool.query(
    `UPDATE vector_store_files
        SET status = 'cancelled', claimed_at = NULL
      WHERE store_id = $1 AND batch_id = $2 AND status = 'in_progress'`,
    [storeId, batchId],
  );
  return result.rowCount ?? 0;
}

async function readBlobBytes(sha256: string): Promise<Buffer> {
  const bytes = await getBackend().get(sha256);
  if (!bytes) {
    throw new Error(`Blob ${sha256} was not found in the configured blob storage backend`);
  }
  return bytes;
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
 * Two test-only hooks, both no-ops in production:
 * - `onStoreShareAcquiredForTests` fires right after `FOR SHARE` succeeds,
 *   before the `vector_store_files` lock is even attempted — the only way
 *   to construct the actual lock-order CYCLE a deadlock needs (see
 *   repository.ts's `deleteStoreFile` doc comment for the mechanism): a
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
  storeId: string, fileId: string, chunks: Chunk[], vectors: number[][],
  onStoreShareAcquiredForTests?: () => Promise<void>,
  onLocksAcquiredForTests?: () => Promise<void>,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load-bearing guard against deleteStoreCascade — see the module doc
    // comment for the full mutation-verified picture. Blocks a concurrent
    // cascade at its shared first step, before it can reach the
    // DELETE FROM vector_store_chunks that would otherwise run too early
    // and miss chunks this transaction hasn't inserted yet.
    const storeRows = await client.query('SELECT id FROM vector_stores WHERE id = $1 FOR SHARE', [storeId]);
    if (storeRows.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return;
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
      `SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2 FOR UPDATE`,
      [storeId, fileId],
    );
    if (vsfRows.rowCount === 0 || vsfRows.rows[0].status !== 'in_progress') {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return;
    }

    if (onLocksAcquiredForTests) await onLocksAcquiredForTests();

    // Defensive, not a sign of a race: chunks are only ever written here,
    // after full success, so a prior partial write can only exist if an
    // earlier attempt crashed mid-transaction (which the transaction itself
    // would have rolled back) — cheap idempotency insurance regardless.
    await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);

    let usageBytes = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const vector = vectors[i];
      usageBytes += Buffer.byteLength(chunk.text, 'utf8');
      await client.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
         VALUES ($1,$2,$3,$4,$5,$6::vector)`,
        [storeId, fileId, chunk.ord, chunk.text, chunk.tokens, `[${vector.join(',')}]`],
      );
    }

    await client.query(
      `UPDATE vector_store_files
         SET status = 'completed', usage_bytes = $3, last_error = NULL, claimed_at = NULL
       WHERE store_id = $1 AND file_id = $2`,
      [storeId, fileId, usageBytes],
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Records a failed attempt in one atomic statement (no read-then-write gap):
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
  const permanent = isPermanentFailure(error);
  const errInfo = serializeError(error);

  // Metadata only — never the extracted text, chunk text, or filename (user
  // document content) directly. `error.message` here is a library-generated
  // message (extractor/embedder/DB driver), not raw document content — but
  // pandoc/pdftotext stderr can legitimately quote a fragment of the
  // document they failed to parse, so `error.message` is NOT unconditionally
  // safe on its own merits; it's runners.ts's `sanitizeStderrForError` that
  // truncates and strips control characters BEFORE that message ever
  // reaches the Error this function receives, closing that specific gap.
  logger.error(
    'IngestWorker',
    `Ingestion attempt failed for store ${storeId}, file ${fileId}`,
    error instanceof Error ? error : new Error(String(error)),
    { permanent },
  );

  await pool.query(
    `UPDATE vector_store_files
       SET status = CASE WHEN $3::boolean OR attempts >= $4 THEN 'failed' ELSE 'in_progress' END,
           claimed_at = NULL,
           last_error = $5::jsonb
     WHERE store_id = $1 AND file_id = $2 AND status = 'in_progress'`,
    [storeId, fileId, permanent, maxRetries, JSON.stringify(errInfo)],
  );
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
 */
export async function processOne(storeId: string, fileId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const ctx = await loadContext(storeId, fileId);
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
  try {
    // Cheap defense-in-depth: a store whose pinned embedding_dim has drifted
    // from the live config can never successfully embed for this store (see
    // repository.ts's own comment on why the pinned dimension exists) — fail
    // fast rather than burn an embeddings call and the retry budget on a
    // store that is permanently stuck until an operator recreates it.
    await assertStoreDimension({ embedding_dim: ctx.embeddingDim });

    const bytes = await readBlobBytes(ctx.sha256);
    const text = await extractText(ctx.filename, bytes, { timeoutMs: config.ingestion.extractTimeoutMs });

    const totalTokens = estimateTokens(text);
    if (totalTokens > config.limits.maxTokensPerFile) {
      throw new FileTooLargeError(totalTokens, config.limits.maxTokensPerFile);
    }

    const strategy = resolveChunkingStrategy(ctx.chunkingStrategy);
    const chunks = chunkText(text, strategy);

    let vectors: number[][] = [];
    if (chunks.length > 0) {
      const result = await embed(chunks.map((c) => c.text), 'document');
      vectors = result.vectors;
      // Metadata only (counts, never chunk text) — surfaced for Plan 3's
      // future cost-attribution work; no attribution table exists yet.
      logger.debug('IngestWorker', 'Ingestion embedding usage', {
        storeId,
        fileId,
        chunkCount: chunks.length,
        promptTokens: result.usage.promptTokens,
        totalTokens: result.usage.totalTokens,
      });
    }

    await commitChunks(storeId, fileId, chunks, vectors);
  } catch (error) {
    await handleFailure(storeId, fileId, error, config.ingestion.maxRetries);
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
  loops: Promise<void>[];
  wake: EventEmitter;
  hintSubscription: IngestHintSubscription;
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
  const state: WorkerState = { stopped: false, loops: [], wake, hintSubscription };
  workerState = state;
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
  state.wake.emit('wake');
  await Promise.all(state.loops);
  // Symmetric cleanup: the subscriber (opened by this same start cycle) and
  // the publisher (lazily opened, possibly by an earlier enqueueIngestion
  // call, and reused across the whole process) both get closed on stop —
  // previously only the subscriber did.
  await state.hintSubscription.close();
  await closePublisher();
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
