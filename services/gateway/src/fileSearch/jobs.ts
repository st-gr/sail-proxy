// JOBS — the data layer behind the cockpit's Jobs screen. Nothing here is
// HTTP-aware.
//
// Four kinds:
//  - 'file_batch': one `fs_jobs` row per `vector_store_batches` row, created by
//    `createBatch` (and backfilled by the schema script for batches older than
//    the table). The job adds what the batch cannot say about itself — who
//    started it, with which credential, when it started and finished, how many
//    embedding tokens it used.
//  - 'reembed_store': one store re-embedded into a new generation (reembed.ts),
//    with one `fs_reembed_items` row per file — or re-chunked, when its
//    `target_chunking` is set (rechunk.ts), or re-extracted when `reextract` is set too
//    (reextract.ts).
//  - 'reembed_bulk': the parent of one 'reembed_store' child per store, started
//    by an admin for every outdated store at once.
//  - 'blob_migration': every blob moved to another storage backend
//    (blob/blobMigration.ts), with one `fs_blob_migration_items` row per blob.
//
// STATE AND COUNTERS ARE DERIVED, NEVER STORED, for the same reason the batch's
// status is (see batches.ts): the member rows and the one-way cancel latches are
// the only source of truth, and a read computes from them. The rules, in order:
//
// file_batch (members: the batch's `vector_store_files`, latch on the batch):
//   a member in_progress, cancel requested   -> 'cancelling'
//   a member in_progress, none ever claimed  -> 'queued'   (every attempts = 0)
//   a member in_progress                     -> 'running'
//   cancel requested                         -> 'cancelled'
//   a member failed                          -> 'completed_with_errors'
//   otherwise                                -> 'completed'
// A file batch is never terminal while a member is in_progress and never 'failed'.
//
// reembed_store (members: its items; latch `fs_jobs.cancel_requested`). The
// store switches only when every item is done, so a re-embed succeeds or fails
// as a whole; reembed.ts sets `finished_at` (and `error` when it did not switch):
//   cancel requested, not finished           -> 'cancelling'
//   cancel requested                         -> 'cancelled'
//   not finished, an item open, none claimed -> 'queued'
//   not finished                             -> 'running'
//   error set                                -> 'failed'
//   otherwise                                -> 'completed'
//
// reembed_bulk (members: its children, counted by their own outcome; tokens are
// the children's sum):
//   a child unfinished, cancel requested     -> 'cancelling'
//   a child unfinished, none started         -> 'queued'
//   a child unfinished                       -> 'running'
//   cancel requested                         -> 'cancelled'
//   a child failed and one completed         -> 'completed_with_errors'
//   a child failed                           -> 'failed'
//   only cancelled children                  -> 'cancelled'
//   otherwise                                -> 'completed'
//
// blob_migration (members: its items; latch `fs_jobs.cancel_requested`; each
// item stands alone, so some may fail while the rest moved):
//   cancel requested, not finished           -> 'cancelling'
//   cancel requested                         -> 'cancelled'
//   not finished, an item open, none claimed -> 'queued'
//   not finished                             -> 'running'
//   an item failed and one completed         -> 'completed_with_errors'
//   an item failed                           -> 'failed'
//   otherwise                                -> 'completed'
//
// LOCK ORDER, in every transaction here and in the worker hooks' callers:
// `vector_stores` first, then `vector_store_files`, then `fs_jobs`. Several
// `vector_store_files` rows are locked in file_id order (`ORDER BY file_id …
// FOR UPDATE`), as the worker's batch cancel and zombie reaper do, so a retry
// and a worker update over the same members cannot deadlock.
import type { Pool, PoolClient } from 'pg';
import { getPool } from './db';
import { newJobId } from './ids';
import { enqueueIngestion } from './repository';

type Queryable = Pool | PoolClient;

export type JobState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export interface JobSummary {
  id: string;
  kind: string;
  store_id: string | null;
  store_name: string | null;
  batch_id: string | null;
  state: JobState;
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  in_progress: number;
  embedding_tokens: number;
  /** A re-chunk's pinned target setting (`reembed_store` that re-chunks), else null. */
  target_chunking: Record<string, unknown> | null;
  /** A re-extract (reextract.ts): `target_chunking` is the store's own setting, and only the files an
   *  older extractor read are read again. */
  reextract: boolean;
  /** The context writer's spend (see fs_jobs' context counters): batches and re-chunks. */
  context_input_tokens: number;
  context_cached_tokens: number;
  context_output_tokens: number;
  context_failed_chunks: number;
  /** PDF pages without a text layer (fs_jobs' page counters): read by OCR, left without OCR text,
   *  written by the vision model, selected for vision but kept their text. */
  ocr_pages: number;
  ocr_skipped_pages: number;
  vision_pages: number;
  vision_skipped_pages: number;
  error: Record<string, unknown> | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  started_by: string | null;
}

export type JobErrorCode = 'not_found' | 'job_running' | 'store_expired' | 'nothing_to_retry' | 'superseded';

export type RetryResult =
  | { ok: true; job_id: string | null; retried: number }
  | { ok: false; error: JobErrorCode };

function requirePool(): Pool {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  return pool;
}

export interface FileBatchJobInput {
  storeId: string;
  batchId: string;
  /** The acting user; defaults to the store's owner. */
  startedBy?: string | null;
  credentialId?: string | null;
  authType?: string | null;
}

/**
 * Inserts the job row for a file batch and returns its id. `owner_email` is
 * read from the store row in the same statement, as the backfill does, so the
 * job's owner can never disagree with the store's. A store that vanished in
 * the meantime raises 23503 on `store_id` — the same SQLSTATE the batch insert
 * raises for the same cause.
 */
export async function createFileBatchJob(client: Queryable, input: FileBatchJobInput): Promise<string> {
  const id = newJobId();
  await client.query(
    `INSERT INTO fs_jobs (id, kind, owner_email, started_by, credential_id, auth_type, store_id, batch_id)
     VALUES ($1, 'file_batch',
             (SELECT owner_email FROM vector_stores WHERE id = $2),
             COALESCE($3, (SELECT owner_email FROM vector_stores WHERE id = $2)),
             $4, $5, $2, $6)`,
    [id, input.storeId, input.startedBy ?? null, input.credentialId ?? null, input.authType ?? null, input.batchId],
  );
  return id;
}

/**
 * The derived-state query. `where` filters `fs_jobs j` (inside the aggregate),
 * `outer` filters the derived rows (where `state` exists), `tail` orders and
 * limits. One aggregate over the member rows per job:
 *
 *  - `f.batch_id = j.batch_id` scopes the counts to the job's batch — dropping
 *    it would count every sibling batch and unbatched file of the store.
 *  - `total` is the sum of the four known buckets, not COUNT(*), so the four
 *    counters always sum to it (the batch poll contract).
 *
 * `withOwner` adds `owner_email` to the output, for the admin's all-owner list
 * (admin.ts); the owner's own reads leave it off, so their shape is unchanged.
 */
export function derivedJobsSql(where: string, outer = '', tail = '', withOwner = false): string {
  // One aggregate per kind, each a LATERAL that matches no row for the other
  // kinds (an aggregate without GROUP BY still yields its one row of zeros), so
  // every job gets exactly one row of counters from its own members.
  return `
    WITH agg AS (
      SELECT j.id, j.kind, j.owner_email, j.store_id, s.name AS store_name, j.batch_id,
             CASE WHEN j.kind = 'reembed_bulk' THEN ch.tokens ELSE j.embedding_tokens END AS embedding_tokens,
             j.error, j.created_at, j.started_at, j.finished_at, j.started_by,
             j.target_chunking, COALESCE(j.reextract, false) AS reextract, j.context_input_tokens, j.context_cached_tokens, j.context_output_tokens,
             j.context_failed_chunks, j.ocr_pages, j.ocr_skipped_pages, j.vision_pages, j.vision_skipped_pages,
             CASE WHEN j.kind = 'file_batch' THEN COALESCE(b.cancel_requested, false)
                  ELSE j.cancel_requested END                     AS cancel_requested,
             fb.done + ri.done + ch.done + bm.done                AS done,
             fb.failed + ri.failed + ch.failed + bm.failed        AS failed,
             fb.cancelled + ri.cancelled + ch.cancelled + bm.cancelled AS cancelled,
             fb.in_progress + ri.in_progress + ch.in_progress + bm.in_progress AS in_progress,
             fb.ever_claimed OR ri.ever_claimed OR ch.ever_claimed OR bm.ever_claimed AS ever_claimed
        FROM fs_jobs j
        LEFT JOIN vector_stores s ON s.id = j.store_id
        LEFT JOIN vector_store_batches b ON b.id = j.batch_id AND b.store_id = j.store_id
        CROSS JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE f.status = 'completed')::int   AS done,
                 COUNT(*) FILTER (WHERE f.status = 'failed')::int      AS failed,
                 COUNT(*) FILTER (WHERE f.status = 'cancelled')::int   AS cancelled,
                 COUNT(*) FILTER (WHERE f.status = 'in_progress')::int AS in_progress,
                 COALESCE(bool_or(f.attempts > 0), false)              AS ever_claimed
            FROM vector_store_files f
           WHERE j.kind = 'file_batch' AND f.store_id = j.store_id AND f.batch_id = j.batch_id) fb
        CROSS JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE i.status = 'completed')::int   AS done,
                 COUNT(*) FILTER (WHERE i.status = 'failed')::int      AS failed,
                 COUNT(*) FILTER (WHERE i.status = 'cancelled')::int   AS cancelled,
                 COUNT(*) FILTER (WHERE i.status = 'in_progress')::int AS in_progress,
                 COALESCE(bool_or(i.attempts > 0), false)              AS ever_claimed
            FROM fs_reembed_items i
           WHERE j.kind = 'reembed_store' AND i.job_id = j.id) ri
        CROSS JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE c.finished_at IS NOT NULL AND NOT c.cancel_requested
                                    AND c.error IS NULL)::int          AS done,
                 COUNT(*) FILTER (WHERE c.finished_at IS NOT NULL AND NOT c.cancel_requested
                                    AND c.error IS NOT NULL)::int      AS failed,
                 COUNT(*) FILTER (WHERE c.finished_at IS NOT NULL AND c.cancel_requested)::int AS cancelled,
                 COUNT(*) FILTER (WHERE c.finished_at IS NULL)::int    AS in_progress,
                 COALESCE(bool_or(c.started_at IS NOT NULL), false)    AS ever_claimed,
                 COALESCE(SUM(c.embedding_tokens), 0)::bigint          AS tokens
            FROM fs_jobs c
           WHERE j.kind = 'reembed_bulk' AND c.parent_id = j.id) ch
        CROSS JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE m.status = 'completed')::int   AS done,
                 COUNT(*) FILTER (WHERE m.status = 'failed')::int      AS failed,
                 COUNT(*) FILTER (WHERE m.status = 'cancelled')::int   AS cancelled,
                 COUNT(*) FILTER (WHERE m.status = 'in_progress')::int AS in_progress,
                 COALESCE(bool_or(m.attempts > 0), false)              AS ever_claimed
            FROM fs_blob_migration_items m
           WHERE j.kind = 'blob_migration' AND m.job_id = j.id) bm
       WHERE ${where}
    ), derived AS (
      SELECT agg.*,
             done + failed + cancelled + in_progress AS total,
             CASE
               WHEN kind = 'reembed_store' THEN CASE
                 WHEN cancel_requested AND finished_at IS NULL THEN 'cancelling'
                 WHEN cancel_requested THEN 'cancelled'
                 WHEN finished_at IS NULL AND in_progress > 0 AND NOT ever_claimed THEN 'queued'
                 WHEN finished_at IS NULL THEN 'running'
                 WHEN error IS NOT NULL THEN 'failed'
                 ELSE 'completed'
               END
               WHEN kind = 'blob_migration' THEN CASE
                 WHEN cancel_requested AND finished_at IS NULL THEN 'cancelling'
                 WHEN cancel_requested THEN 'cancelled'
                 WHEN finished_at IS NULL AND in_progress > 0 AND NOT ever_claimed THEN 'queued'
                 WHEN finished_at IS NULL THEN 'running'
                 WHEN failed > 0 AND done > 0 THEN 'completed_with_errors'
                 WHEN failed > 0 THEN 'failed'
                 ELSE 'completed'
               END
               WHEN kind = 'reembed_bulk' THEN CASE
                 WHEN in_progress > 0 AND cancel_requested THEN 'cancelling'
                 WHEN in_progress > 0 AND NOT ever_claimed THEN 'queued'
                 WHEN in_progress > 0 THEN 'running'
                 WHEN cancel_requested THEN 'cancelled'
                 WHEN failed > 0 AND done > 0 THEN 'completed_with_errors'
                 WHEN failed > 0 THEN 'failed'
                 WHEN cancelled > 0 AND done = 0 THEN 'cancelled'
                 ELSE 'completed'
               END
               WHEN in_progress > 0 AND cancel_requested THEN 'cancelling'
               WHEN in_progress > 0 AND NOT ever_claimed THEN 'queued'
               WHEN in_progress > 0 THEN 'running'
               WHEN cancel_requested THEN 'cancelled'
               WHEN failed > 0 THEN 'completed_with_errors'
               ELSE 'completed'
             END AS state
        FROM agg
    )
    SELECT id, kind, store_id, store_name, batch_id, state, total, done, failed, cancelled, in_progress,
           embedding_tokens, target_chunking, reextract, context_input_tokens, context_cached_tokens, context_output_tokens,
           context_failed_chunks, ocr_pages, ocr_skipped_pages, vision_pages, vision_skipped_pages,
           error, created_at, started_at, finished_at, started_by${withOwner ? ', owner_email' : ''}
      FROM derived
     ${outer ? `WHERE ${outer}` : ''}
     ${tail}`;
}

export function toSummary(row: any): JobSummary {
  // bigint arrives as a string from node-postgres.
  return {
    ...row,
    embedding_tokens: Number(row.embedding_tokens),
    context_input_tokens: Number(row.context_input_tokens),
    context_cached_tokens: Number(row.context_cached_tokens),
    context_output_tokens: Number(row.context_output_tokens),
    context_failed_chunks: Number(row.context_failed_chunks),
    ocr_pages: Number(row.ocr_pages),
    ocr_skipped_pages: Number(row.ocr_skipped_pages),
    vision_pages: Number(row.vision_pages),
    vision_skipped_pages: Number(row.vision_skipped_pages),
  };
}

/** One job of `ownerEmail`, or null — another owner's job is indistinguishable
 *  from one that does not exist. */
export async function jobSummary(jobId: string, ownerEmail: string): Promise<JobSummary | null> {
  const { rows } = await requirePool().query(
    derivedJobsSql('j.id = $1 AND j.owner_email = $2'),
    [jobId, ownerEmail],
  );
  return rows[0] ? toSummary(rows[0]) : null;
}

/** One job of any owner, with its owner — for the admin's re-embed cancel and
 *  retry (plan Decision 10), which act across owners. */
export async function jobSummaryAnyOwner(jobId: string): Promise<(JobSummary & { owner_email: string | null }) | null> {
  const { rows } = await requirePool().query(derivedJobsSql('j.id = $1', '', '', true), [jobId]);
  return rows[0] ? (toSummary(rows[0]) as JobSummary & { owner_email: string | null }) : null;
}

export interface ListJobsOptions {
  /** Page size the CALLER asked for; up to `limit + 1` rows come back so
   *  `pagination.buildPage` can compute `has_more`. */
  limit: number;
  /** Job id of the last row of the previous page. */
  after?: string | null;
  /** Restrict to one derived state. */
  state?: JobState | null;
}

/**
 * The owner's jobs, newest first, keyset-paged on `(created_at, id)`.
 *
 * The cursor is resolved inside the statement, scoped to the same owner, so
 * `created_at` is compared at full microsecond precision (never round-tripped
 * through a JS Date) and an unknown or foreign cursor compares against NULL —
 * an empty page, not page one. The `state` filter applies after derivation.
 */
export async function listJobs(ownerEmail: string, opts: ListJobsOptions): Promise<JobSummary[]> {
  const params: unknown[] = [ownerEmail];
  let where = 'j.owner_email = $1';
  if (opts.after) {
    params.push(opts.after);
    where += ` AND (j.created_at, j.id) < (SELECT c.created_at, c.id FROM fs_jobs c
                                            WHERE c.id = $${params.length} AND c.owner_email = $1)`;
  }
  let outer = '';
  if (opts.state) {
    params.push(opts.state);
    outer = `state = $${params.length}`;
  }
  params.push(opts.limit + 1);
  const { rows } = await requirePool().query(
    derivedJobsSql(where, outer, `ORDER BY created_at DESC, id DESC LIMIT $${params.length}`),
    params,
  );
  return rows.map(toSummary);
}

/** Worker hook: stamps `started_at` on the first claim of a member. */
export async function markStartedIfNeeded(client: Queryable, batchId: string): Promise<void> {
  await client.query(
    'UPDATE fs_jobs SET started_at = now() WHERE batch_id = $1 AND started_at IS NULL',
    [batchId],
  );
}

/**
 * Worker hook: sets `finished_at` when no member is in_progress any more.
 * Returns whether this call set it. Must run in the transaction that changed
 * the member's status.
 *
 * The job row is locked FIRST, in its own statement. Two transactions finishing
 * the last two members concurrently would otherwise each see the other's
 * member still in_progress (READ COMMITTED) and neither would settle the job.
 * With the lock, the second waits for the first to commit, and its following
 * statement takes a fresh snapshot that sees the first's member as finished.
 */
export async function settleFinishedIfTerminal(client: Queryable, batchId: string): Promise<boolean> {
  const locked = await client.query(
    'SELECT id FROM fs_jobs WHERE batch_id = $1 AND finished_at IS NULL FOR UPDATE',
    [batchId],
  );
  if (locked.rowCount === 0) return false;
  const result = await client.query(
    `UPDATE fs_jobs j SET finished_at = now()
      WHERE j.batch_id = $1 AND j.finished_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM vector_store_files f
                         WHERE f.store_id = j.store_id AND f.batch_id = j.batch_id AND f.status = 'in_progress')`,
    [batchId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Worker hook: adds the provider's token usage for one embedded member. */
export async function addTokens(client: Queryable, batchId: string, n: number): Promise<void> {
  if (!Number.isFinite(n) || n <= 0) return;
  await client.query(
    'UPDATE fs_jobs SET embedding_tokens = embedding_tokens + $2 WHERE batch_id = $1',
    [batchId, Math.trunc(n)],
  );
}

/** Adds one file's context-writer spend to its batch's job (see fs_jobs' context counters). */
export async function addContextTotals(
  client: Queryable, batchId: string, totals: ContextCounters,
): Promise<void> {
  await addContextCounters(client, 'batch_id', batchId, totals);
}

/** Adds one file's context-writer spend to a job by its id (a re-chunk's `reembed_store` job). */
export async function addJobContextTotals(
  client: Queryable, jobId: string, totals: ContextCounters,
): Promise<void> {
  await addContextCounters(client, 'id', jobId, totals);
}

type ContextCounters = { input: number; cachedRead: number; output: number; failed: number };

async function addContextCounters(
  client: Queryable, column: 'batch_id' | 'id', value: string, totals: ContextCounters,
): Promise<void> {
  const n = (v: number) => Math.max(Math.trunc(Number.isFinite(v) ? v : 0), 0);
  await client.query(
    `UPDATE fs_jobs SET context_input_tokens = context_input_tokens + $2, context_cached_tokens = context_cached_tokens + $3,
                        context_output_tokens = context_output_tokens + $4, context_failed_chunks = context_failed_chunks + $5
      WHERE ${column} = $1`,
    [value, n(totals.input), n(totals.cachedRead), n(totals.output), n(totals.failed)],
  );
}

/** One file's page counts: OCR (pdfOcr.ts OcrTotals: pages read, pages left without OCR text)
 *  and vision (visionTranscriber.ts VisionMemo.counters: pages the model wrote, selected pages
 *  that kept their text). */
export type OcrCounters = {
  ocrPages: number; skippedPages: number; visionPages?: number; visionSkippedPages?: number;
  /** The OCR memo's pages without text and why OCR did not run (pdfOcr.ts ocrPendingOf); not counted on jobs. */
  candidates?: number; unavailable?: string | null;
};

/** Adds one file's page counts to its batch's job (fs_jobs.ocr_pages / ocr_skipped_pages /
 *  vision_pages / vision_skipped_pages). */
export async function addOcrTotals(client: Queryable, batchId: string, totals: OcrCounters): Promise<void> {
  await addOcrCounters(client, 'batch_id', batchId, totals);
}

/** Adds one file's OCR page counts to a job by its id (a re-chunk's `reembed_store` job). */
export async function addJobOcrTotals(client: Queryable, jobId: string, totals: OcrCounters): Promise<void> {
  await addOcrCounters(client, 'id', jobId, totals);
}

async function addOcrCounters(
  client: Queryable, column: 'batch_id' | 'id', value: string, totals: OcrCounters,
): Promise<void> {
  const n = (v: number | undefined) => Math.max(Math.trunc(typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);
  const counts = [n(totals.ocrPages), n(totals.skippedPages), n(totals.visionPages), n(totals.visionSkippedPages)];
  if (counts.every((c) => c === 0)) return; // a file without scanned or transcribed pages
  await client.query(
    `UPDATE fs_jobs SET ocr_pages = ocr_pages + $2, ocr_skipped_pages = ocr_skipped_pages + $3,
                        vision_pages = vision_pages + $4, vision_skipped_pages = vision_skipped_pages + $5
      WHERE ${column} = $1`,
    [value, ...counts],
  );
}

const REOPEN_SQL = `status = 'in_progress', attempts = 0, last_error = NULL, claimed_at = NULL`;

/**
 * Runs `work` in a transaction that first locks the owner's store FOR UPDATE —
 * the documented lock order — and applies the checks every retry shares.
 * Hints are published after COMMIT, best effort, for the reopened files.
 */
async function inStoreTransaction(
  storeId: string,
  ownerEmail: string,
  work: (client: PoolClient) => Promise<{ result: RetryResult; reopened: string[] }>,
): Promise<RetryResult> {
  const client = await requirePool().connect();
  let outcome: { result: RetryResult; reopened: string[] };
  try {
    await client.query('BEGIN');
    const store = await client.query<{ status: string }>(
      'SELECT status FROM vector_stores WHERE id = $1 AND owner_email = $2 FOR UPDATE',
      [storeId, ownerEmail],
    );
    if (store.rowCount === 0) {
      outcome = { result: { ok: false, error: 'not_found' }, reopened: [] };
    } else if (store.rows[0].status === 'expired') {
      outcome = { result: { ok: false, error: 'store_expired' }, reopened: [] };
    } else {
      outcome = await work(client);
    }
    if (outcome.result.ok) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK').catch(() => {});
    }
  } catch (e) {
    // Swallow a failing ROLLBACK: it fires precisely when the connection is
    // already broken, and letting it throw replaces the error that explains why.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  for (const fileId of outcome.reopened) {
    // eslint-disable-next-line no-await-in-loop
    await enqueueIngestion(storeId, fileId);
  }
  return outcome.result;
}

/**
 * Checks shared by both retries once the store is locked: the batch must not
 * be running (a member in_progress) and must not be cancelled (the worker would
 * cancel a reopened member at once; a cancel is the user's decision). Locks the
 * batch's member rows (files after stores, per the lock order), in file_id order.
 */
async function batchRefusal(client: PoolClient, storeId: string, batchId: string): Promise<JobErrorCode | null> {
  const members = await client.query<{ status: string }>(
    'SELECT status FROM vector_store_files WHERE store_id = $1 AND batch_id = $2 ORDER BY file_id FOR UPDATE',
    [storeId, batchId],
  );
  if (members.rows.some((r) => r.status === 'in_progress')) return 'job_running';
  const batch = await client.query<{ cancel_requested: boolean }>(
    'SELECT cancel_requested FROM vector_store_batches WHERE id = $1 AND store_id = $2',
    [batchId, storeId],
  );
  if (batch.rows[0]?.cancel_requested) return 'nothing_to_retry';
  return null;
}

/**
 * Re-opens the failed members of a finished file-batch job: status back to
 * in_progress with attempts, last_error and the lease cleared, and the job's
 * `finished_at` cleared. Cancelled members stay cancelled.
 */
export async function retryJob(jobId: string, ownerEmail: string): Promise<RetryResult> {
  const { rows } = await requirePool().query<{ store_id: string | null; batch_id: string | null }>(
    `SELECT store_id, batch_id FROM fs_jobs WHERE id = $1 AND owner_email = $2 AND kind = 'file_batch'`,
    [jobId, ownerEmail],
  );
  const job = rows[0];
  if (!job || !job.store_id || !job.batch_id) return { ok: false, error: 'not_found' };
  const { store_id: storeId, batch_id: batchId } = job;

  return inStoreTransaction(storeId, ownerEmail, async (client) => {
    const refusal = await batchRefusal(client, storeId, batchId);
    if (refusal) return { result: { ok: false, error: refusal }, reopened: [] };
    const reopened = await client.query<{ file_id: string }>(
      `UPDATE vector_store_files SET ${REOPEN_SQL}
        WHERE store_id = $1 AND batch_id = $2 AND status = 'failed'
        RETURNING file_id`,
      [storeId, batchId],
    );
    if (reopened.rowCount === 0) return { result: { ok: false, error: 'nothing_to_retry' }, reopened: [] };
    await client.query('UPDATE fs_jobs SET finished_at = NULL WHERE id = $1', [jobId]);
    const fileIds = reopened.rows.map((r) => r.file_id);
    return { result: { ok: true, job_id: jobId, retried: fileIds.length }, reopened: fileIds };
  });
}

/**
 * Re-opens one failed file of the owner's store, under the same rules as
 * `retryJob` when the file belongs to a batch. `job_id` is the batch's job, or
 * null for a file attached outside any batch.
 */
export async function retryFile(storeId: string, fileId: string, ownerEmail: string): Promise<RetryResult> {
  return inStoreTransaction(storeId, ownerEmail, async (client) => {
    // batch_id is read unlocked: with the store locked FOR UPDATE no attach
    // (its FK takes KEY SHARE on the store) or detach (it locks the store
    // first) can change the row's membership. Locking the file alone first
    // would break the file_id order when it is a batch member, so a member is
    // locked with its batch, in batchRefusal.
    const file = await client.query<{ batch_id: string | null }>(
      'SELECT batch_id FROM vector_store_files WHERE store_id = $1 AND file_id = $2',
      [storeId, fileId],
    );
    if (file.rowCount === 0) return { result: { ok: false, error: 'not_found' }, reopened: [] };
    const batchId = file.rows[0].batch_id;
    if (batchId) {
      const refusal = await batchRefusal(client, storeId, batchId);
      if (refusal) return { result: { ok: false, error: refusal }, reopened: [] };
    }
    // The status under the row lock (already held for a batch member).
    const locked = await client.query<{ status: string }>(
      'SELECT status FROM vector_store_files WHERE store_id = $1 AND file_id = $2 FOR UPDATE',
      [storeId, fileId],
    );
    if (locked.rows[0]?.status !== 'failed') return { result: { ok: false, error: 'nothing_to_retry' }, reopened: [] };

    await client.query(
      `UPDATE vector_store_files SET ${REOPEN_SQL} WHERE store_id = $1 AND file_id = $2`,
      [storeId, fileId],
    );
    let jobId: string | null = null;
    if (batchId) {
      const job = await client.query<{ id: string }>(
        'UPDATE fs_jobs SET finished_at = NULL WHERE batch_id = $1 RETURNING id',
        [batchId],
      );
      jobId = job.rows[0]?.id ?? null;
    }
    return { result: { ok: true, job_id: jobId, retried: 1 }, reopened: [fileId] };
  });
}
