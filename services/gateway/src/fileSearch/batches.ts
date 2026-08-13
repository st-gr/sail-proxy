// Vector-store FILE BATCH primitives — the data layer behind OpenAI's four
// `/vector_stores/{id}/file_batches` endpoints (create, retrieve, cancel, list
// files), which Tasks 3 and 4 wire up. Nothing here is HTTP-aware: no Express
// types, no status codes, no error envelopes.
//
// THE CENTRAL IDEA: a batch is a LABEL over `vector_store_files` rows that
// already exist, not a container that owns them. Membership is
// `vector_store_files.batch_id` — a column that has been in the shipped schema
// since it was added for exactly this feature and, until now, was never
// written or read by anything. `vector_store_batches` therefore stores only
// what cannot be recovered from its members: the id, the store it belongs to,
// when it was created, and whether cancellation was requested.
//
// STATUS AND `file_counts` ARE DERIVED ON READ, NEVER STORED. Storing them
// would require the ingestion worker to update a second source of truth on
// every per-file status transition — an invariant that has to hold across
// every possible interleaving of concurrent ingestions, cancellations and
// retries, and that no test can demonstrate for all of them. Derivation has no
// such invariant to violate: there is one source of truth, and a read computes
// from it. The cost is one aggregate query per read, over an index.
//
// TENANT BOUNDARY: every query below is scoped by `store_id` AND the batch id,
// never by the batch id alone. A `vsfb_` id carries 96 bits of entropy, but
// unguessability is not authorization — it is a secret that can be logged,
// pasted into a ticket, or leaked by a proxy. Every other query in this
// codebase is scoped by predicate (see `STORE_ACCESS_PREDICATE_SQL` and
// `deleteStoreFile`'s `ownerEmail` scoping); this one is too. The HTTP layer
// establishes that the caller owns `storeId`; these functions guarantee that a
// batch id from a different store resolves to nothing rather than to data.
import type { PoolClient } from 'pg';
import { getPool } from './db';
import { getDefaultLogger } from '@libs/logger';
import { newBatchId } from './ids';
import { attachFile, driverErrorCode, FileCounts, VectorStoreFileRow, VALID_FILE_STATUSES } from './repository';
import { PageOrder } from './pagination';

const logger = getDefaultLogger();

/**
 * OpenAI's `vector_store.file_batch.status` enum, reproduced in full so a
 * value round-tripped from an SDK client type-checks.
 *
 * `'failed'` is present because their enum has it. NOTHING in this
 * implementation returns it: a batch whose member file failed is reported
 * `completed`, with the failure visible in `file_counts.failed` — which is
 * what OpenAI itself does. A batch is a unit of *work submitted*, not a unit
 * of work that succeeds or fails as a whole.
 */
export type BatchStatus = 'in_progress' | 'completed' | 'cancelled' | 'failed';

/**
 * A batch row exactly as stored. Note what is NOT here: `status` and
 * `file_counts`, both derived — see `batchStatusAndCounts`.
 */
export interface BatchRow {
  id: string;
  store_id: string;
  cancel_requested: boolean;
  created_at: Date;
}

function emptyCounts(): FileCounts {
  return { in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
}

/**
 * The batch status rules, in order:
 *
 *   any member still `in_progress`       -> 'in_progress'
 *   cancellation requested, none running -> 'cancelled'
 *   otherwise                            -> 'completed'
 *
 * THE ORDER OF THE FIRST TWO IS LOAD-BEARING, and it is the one thing here
 * most likely to be "simplified" into a bug. A batch with cancellation
 * requested but files still ingesting is `in_progress`, NOT `cancelled`:
 * requesting cancellation sets a flag, it does not stop the worker mid-file.
 * `cancelled` is a TERMINAL status, and an SDK caller's
 * `fileBatches.createAndPoll(...)` loops until the status is terminal — so
 * returning `cancelled` while the worker is still writing hands that caller a
 * vector store that is still being mutated, at the exact moment the helper
 * promised it had settled. The flag says what was asked for; the member rows
 * say what is actually happening, and only they can end the batch.
 *
 * A member that FAILED does not make the batch `'failed'` — see `BatchStatus`.
 */
function deriveBatchStatus(cancelRequested: boolean, counts: FileCounts): BatchStatus {
  if (counts.in_progress > 0) return 'in_progress';
  if (cancelRequested) return 'cancelled';
  return 'completed';
}

/**
 * Creates a batch over `fileIds` and attaches every one of them to `storeId`,
 * stamped with the new batch's id.
 *
 * Attachment goes through `repository.attachFile` — the SAME function the
 * single-file `POST /vector_stores/{id}/files` path uses — rather than a
 * parallel INSERT of its own. That is deliberate: attach carries semantics
 * beyond the row insert (attribute validation, `status='in_progress'` so the
 * ingestion worker picks the row up, and sliding the store's
 * `last_active_at`/`expires_at`), and a second implementation would drift from
 * those the first time one of them changes.
 *
 * This is a LOW-LEVEL primitive, matching `attachFile`'s own contract: it does
 * NOT check store ownership, file ownership, the per-store file-count limit,
 * or the store's pinned embedding dimension. The HTTP layer does all of that,
 * for the whole `fileIds` list, before calling — exactly as it already does
 * for the single-file path.
 *
 * PARTIAL FAILURE: the batch row and the N attachments are not one
 * transaction (`attachFile` opens its own per file), so a failure partway
 * through — a duplicate `file_id`, or a file deleted by a concurrent request
 * between the caller's validation and this insert — would otherwise leave a
 * batch that permanently contains some of its files and a store holding
 * attachments nobody asked for. `discardPartialBatch` below undoes the whole
 * thing before the original error is rethrown, so the failure is
 * all-or-nothing from the caller's point of view.
 */
export async function createBatch(
  storeId: string,
  fileIds: string[],
  attributes: Record<string, unknown> | null | undefined,
  chunkingStrategy?: Record<string, unknown> | null,
): Promise<BatchRow> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');

  const id = newBatchId();
  // A store that does not exist raises 23503 on this FK, before any file is
  // touched — the same SQLSTATE `attachFile` raises for the same cause, so the
  // HTTP layer maps one code, not two.
  const { rows } = await pool.query<BatchRow>(
    `INSERT INTO vector_store_batches (id, store_id, cancel_requested, created_at)
     VALUES ($1,$2,false,$3)
     RETURNING id, store_id, cancel_requested, created_at`,
    [id, storeId, new Date()],
  );
  const batch = rows[0];

  try {
    for (const fileId of fileIds) {
      await attachFile(storeId, fileId, attributes, chunkingStrategy, id);
    }
  } catch (attachError) {
    await discardPartialBatch(storeId, id);
    throw attachError;
  }

  return batch;
}

/**
 * Undoes a `createBatch` that failed partway through: removes the chunks and
 * `vector_store_files` rows already stamped with `batchId`, then the batch row
 * itself. Scoped by `store_id` AND `batch_id`, over an id minted moments ago,
 * so it can only ever match rows this call created.
 *
 * LOCK ORDER: takes `vector_stores FOR UPDATE` before touching
 * `vector_store_files`, matching `deleteStoreFile`, `deleteStoreCascade` and
 * `ingestWorker.commitChunks`. Every write path that touches both tables locks
 * `vector_stores` first; taking them in the opposite order here would
 * reintroduce the deadlock documented on `deleteStoreFile`.
 *
 * NEVER THROWS — and that has to cover the connection handling, not just the
 * statements. It runs inside a `catch`, and the caller is about to rethrow the
 * error that explains what actually went wrong; letting a cleanup failure
 * escape would replace that error with a less informative one — the same
 * reasoning behind the swallowed `ROLLBACK` in `attachFile`, pinned for this
 * function in `test/fileSearch/rollbackMasking.test.ts`.
 *
 * The `pool.connect()` is INSIDE the try and the `release()` is guarded, both
 * deliberately. The realistic reason `createBatch` fails mid-batch is that the
 * database is unreachable or the pool is saturated — which is precisely when
 * this function's own `connect()` also fails. Acquiring the client outside the
 * try (or releasing it unguarded) would turn the `23505`/`23503` the HTTP layer
 * must map to a 409/404 into an opaque connection error, i.e. a 500, in exactly
 * the scenario the cleanup exists to survive.
 *
 * A cleanup that fails leaves an orphaned batch with some members, which is
 * bad; masking the cause is worse, so it is logged instead.
 */
async function discardPartialBatch(storeId: string, batchId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM vector_stores WHERE id = $1 FOR UPDATE', [storeId]);
    await client.query(
      `DELETE FROM vector_store_chunks
        WHERE store_id = $1
          AND file_id IN (SELECT file_id FROM vector_store_files WHERE store_id = $1 AND batch_id = $2)`,
      [storeId, batchId],
    );
    await client.query('DELETE FROM vector_store_files WHERE store_id = $1 AND batch_id = $2', [storeId, batchId]);
    await client.query('DELETE FROM vector_store_batches WHERE id = $1 AND store_id = $2', [batchId, storeId]);
    await client.query('COMMIT');
  } catch (cleanupError: any) {
    // `client` is undefined when it was the `connect()` itself that failed;
    // there is no transaction to roll back in that case.
    await client?.query('ROLLBACK').catch(() => {});
    logger.error('FileSearchBatches', 'Failed to roll back a partially created file batch', undefined, {
      storeId,
      batchId,
      code: driverErrorCode(cleanupError),
    });
  } finally {
    try {
      client?.release();
    } catch {
      // `release()` on an already-destroyed client throws. Swallowed for the
      // same reason as everything else here: the caller's original error is
      // the one worth reporting.
    }
  }
}

/**
 * The batch row, or `null` when no batch with that id exists IN THAT STORE.
 *
 * The `store_id` predicate is the tenant boundary, not a redundancy: without
 * it, a batch id observed anywhere (a log line, a shared trace, another
 * tenant's client) would resolve against any store the caller can name. A
 * batch belonging to another store must be indistinguishable from one that
 * never existed.
 */
export async function getBatch(storeId: string, batchId: string): Promise<BatchRow | null> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const { rows } = await pool.query<BatchRow>(
    `SELECT id, store_id, cancel_requested, created_at
       FROM vector_store_batches
      WHERE id = $1 AND store_id = $2`,
    [batchId, storeId],
  );
  return rows[0] ?? null;
}

/**
 * Derives the batch's status and per-status `file_counts` from its member
 * rows. Returns `null` for a batch that does not exist in `storeId` — the same
 * "absent is indistinguishable from another tenant's" contract as `getBatch`,
 * and the reason this does not simply return an all-zero `completed`: a batch
 * that does not exist and an empty batch that genuinely completed are
 * different answers, and only the caller can decide that the first is a 404.
 *
 * One query: the LEFT JOIN both proves the batch exists (and belongs to
 * `storeId`) and aggregates its members, so a batch cannot vanish between an
 * existence check and a count.
 *
 * `f.batch_id = b.id` in the join is what makes these counts the BATCH's and
 * not the whole store's. Dropping it silently turns every sibling batch in the
 * same store into a member of this one — the counts stay plausible, they are
 * just the wrong batch's.
 */
export async function batchStatusAndCounts(
  storeId: string,
  batchId: string,
): Promise<{ status: BatchStatus; file_counts: FileCounts } | null> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');

  const { rows } = await pool.query<{ cancel_requested: boolean; status: string | null; count: number }>(
    `SELECT b.cancel_requested, f.status AS status, COUNT(f.file_id)::int AS count
       FROM vector_store_batches b
       LEFT JOIN vector_store_files f
         ON f.store_id = b.store_id AND f.batch_id = b.id
      WHERE b.id = $1 AND b.store_id = $2
      GROUP BY b.cancel_requested, f.status`,
    [batchId, storeId],
  );

  // Zero rows means the LEFT JOIN's driving side matched nothing: no such
  // batch in this store. An EMPTY batch still yields exactly one row, with a
  // NULL status and a count of 0 (COUNT ignores the NULLs the join produced).
  if (rows.length === 0) return null;

  const counts = emptyCounts();
  for (const row of rows) {
    const n = Number(row.count);
    if (row.status === null) continue; // the LEFT JOIN's no-members row
    if (!(VALID_FILE_STATUSES as readonly string[]).includes(row.status)) {
      // Unreachable today: every writer of `vector_store_files.status` uses
      // one of the four values. There is no CHECK constraint enforcing that,
      // though, so this is what a future writer emitting a fifth value would
      // hit. `total` is skipped along with the bucket, deliberately: OpenAI's
      // `file_counts` is a fixed five-key object whose four buckets are
      // expected to sum to `total`, and a client may check that. Counting an
      // unbucketed file toward `total` would break the arithmetic on the wire;
      // adding a fifth key would break the shape. Under-reporting is the only
      // option that keeps the emitted object internally consistent — so the
      // anomaly is surfaced in the log rather than in the response.
      logger.warn('FileSearchBatches', 'Ignoring unexpected vector_store_files.status in batch counts', {
        storeId,
        batchId,
        status: row.status,
        count: n,
      });
      continue;
    }
    (counts as unknown as Record<string, number>)[row.status] = n;
    counts.total += n;
  }

  return { status: deriveBatchStatus(rows[0].cancel_requested, counts), file_counts: counts };
}

/**
 * Records that cancellation was requested for a batch. Returns `false` — never
 * a distinguishing error — when no such batch exists in `storeId`, matching
 * `deleteStoreFile`/`deleteStoreCascade`'s convention.
 *
 * Sets a flag and nothing else. It deliberately does NOT rewrite member files
 * to `'cancelled'`: per-file status transitions belong to the ingestion worker
 * (see `attachFile`'s note that it never writes `'completed'` for the same
 * reason), and a file already mid-ingestion would be marked cancelled here
 * only for the worker to complete it and mark it completed a moment later.
 * The batch reports `in_progress` until the worker actually stops — see
 * `deriveBatchStatus`.
 *
 * A one-way latch: `cancel_requested` is only ever set to true, so repeated
 * calls are idempotent and there is no un-cancel to race against.
 */
export async function requestBatchCancel(storeId: string, batchId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const result = await pool.query(
    'UPDATE vector_store_batches SET cancel_requested = true WHERE id = $1 AND store_id = $2',
    [batchId, storeId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ListBatchFilesOptions {
  /** Page size the CALLER asked for. This function fetches `limit + 1` rows;
   *  see the note on the return value. */
  limit: number;
  order: PageOrder;
  after?: string | null;
  before?: string | null;
  /** Restrict to one `vector_store_files.status`. */
  filter?: string | null;
}

/**
 * The scope BOTH file-list endpoints share: one store, OPTIONALLY narrowed to
 * one batch. Returns a fresh `where`/`params` pair the caller keeps appending
 * to, so `$n` numbering stays a function of what was actually pushed.
 *
 * `batchId === null` APPENDS NOTHING — deliberately, rather than emitting the
 * `($2::text IS NULL OR batch_id = $2)` form the obvious "make it nullable"
 * refactor reaches for. Two reasons, and both are load-bearing:
 *
 *  1. PLAN STABILITY on the hot store-level list. `idx_vsf_batch` is
 *     `(store_id, batch_id)`, so a `batch_id` predicate is not inert here: it
 *     is the second column of the index the store-level list already scans.
 *     Omitting the clause makes the emitted SQL for the store-level path
 *     BYTE-IDENTICAL to what it was before this builder existed, which makes
 *     plan identity a property of the text rather than something that happens
 *     to hold for the parameter values a benchmark used. The OR form does
 *     produce the same plan under a CUSTOM plan (measured — Postgres folds
 *     `NULL IS NULL` to true and the clause vanishes), but node-postgres's
 *     custom-plan behaviour is a consequence of it using UNNAMED prepared
 *     statements; under a generic plan the folded-away clause comes back as a
 *     residual `Filter` and the BATCH list loses its `Index Cond` on
 *     `idx_vsf_batch`. Not emitting the clause cannot regress either way.
 *  2. STABLE `$n` NUMBERING. With nothing pushed, the store-level list's
 *     status filter stays `$2` and its params stay `[storeId, filter, limit+1]`
 *     — the shape `test/fileSearch/vectorStoresController.test.ts` pins.
 */
function storeFileScope(storeId: string, batchId: string | null): { where: string; params: unknown[] } {
  const params: unknown[] = [storeId];
  let where = 'store_id = $1';
  if (batchId !== null) {
    params.push(batchId);
    where += ` AND batch_id = $${params.length}`;
  }
  return { where, params };
}

/**
 * Keyset page of the files in a store — ALL of them when `batchId` is null,
 * or just one batch's members when it is not — ordered by
 * `(created_at, file_id)`, never `LIMIT/OFFSET`, which produces duplicates
 * and gaps under exactly the concurrent insertion that ingestion creates.
 *
 * THIS IS THE ONLY KEYSET BUILDER BEHIND EITHER FILE-LIST ENDPOINT.
 * `GET /vector_stores/{id}/files` calls it with `batchId = null` and
 * `GET /vector_stores/{id}/file_batches/{batch_id}/files` with the batch id,
 * which is what makes "the batch list is the store list restricted to a
 * batch" true by construction rather than by two blocks that agree today.
 * They previously WERE two blocks; the response half was already unified
 * behind `sendStoreFilePage`, and this is its query-side counterpart. See
 * `storeFileScope` for why the batch predicate is appended conditionally
 * instead of being made unconditionally nullable.
 *
 * RETURNS UP TO `limit + 1` ROWS, IN FETCH ORDER — not a finished page. That
 * matches `pagination.buildPage`'s documented contract ("Builds a page from
 * rows fetched with `LIMIT limit + 1` (the caller's job — this function just
 * trims)"): the extra row is what makes `has_more` correct without a second
 * COUNT query. The HTTP layer calls `buildPage` on the result and, when
 * paginating backwards with `before`, reverses the trimmed page.
 *
 * An unknown `after`/`before` cursor yields `[]` rather than an error, so a
 * cursor pointing at a since-detached file degrades to an empty page instead
 * of a 500. The cursor is resolved IN THE SAME SCOPE as the page, so when
 * `batchId` is set a file id from a sibling batch is as good as no cursor at
 * all — and "as good as no cursor" means an empty page, not page one.
 */
export async function listBatchFiles(
  storeId: string,
  batchId: string | null,
  opts: ListBatchFilesOptions,
): Promise<VectorStoreFileRow[]> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');

  const { limit, order } = opts;
  const after = opts.after ?? null;
  const before = opts.before ?? null;
  const cursorId = after ?? before;

  // created_at is read back as TEXT, not as a Date, and rebound with an
  // explicit ::timestamptz below. A JS Date holds milliseconds; Postgres
  // timestamptz holds microseconds. Binding the Date therefore sends a cursor
  // slightly EARLIER than the row it names, and `(created_at, file_id) > cursor`
  // becomes true for that row itself — every page repeats its own first row.
  // This stayed hidden for as long as created_at was written from a JS Date and
  // so had nothing below the millisecond to lose; it surfaced the moment these
  // timestamps started coming from now().
  let cursorRow: { created_at: string; file_id: string } | null = null;
  if (cursorId) {
    const cursor = storeFileScope(storeId, batchId);
    cursor.params.push(cursorId);
    const cursorResult = await pool.query<{ created_at: string; file_id: string }>(
      `SELECT created_at::text AS created_at, file_id FROM vector_store_files
        WHERE ${cursor.where} AND file_id = $${cursor.params.length}`,
      cursor.params,
    );
    cursorRow = cursorResult.rows[0] ?? null;
    if (!cursorRow) return [];
  }

  const displaySortDir = order === 'asc' ? 'ASC' : 'DESC';
  const usingBefore = !!cursorRow && !after;
  const fetchSortDir = usingBefore ? (displaySortDir === 'ASC' ? 'DESC' : 'ASC') : displaySortDir;

  const { where: scopeWhere, params } = storeFileScope(storeId, batchId);
  let where = scopeWhere;
  if (opts.filter) {
    params.push(opts.filter);
    where += ` AND status = $${params.length}`;
  }
  if (cursorRow) {
    params.push(cursorRow.created_at, cursorRow.file_id);
    const cmp = after ? (order === 'asc' ? '>' : '<') : (order === 'asc' ? '<' : '>');
    where += ` AND (created_at, file_id) ${cmp} ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(limit + 1);

  const { rows } = await pool.query<VectorStoreFileRow>(
    `SELECT * FROM vector_store_files WHERE ${where}
      ORDER BY created_at ${fetchSortDir}, file_id ${fetchSortDir} LIMIT $${params.length}`,
    params,
  );
  return rows;
}
