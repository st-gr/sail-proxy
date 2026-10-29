// RE-EMBEDDING — a store whose embedding model is no longer the configured one
// is re-embedded in place (plan Decisions 1-6, 10-12, 14). Nothing here is
// HTTP-aware; the routes (owner and admin) call these functions.
//
// A store's chunks carry a generation and readers see only the store's
// `active_generation` (recallSql.ts). A re-embed job copies every file's chunk
// text of the active generation into generation `active + 1`, embedded with the
// job's TARGET model, pinned when the job starts (`fs_jobs.target_*`), so a
// configuration change mid-job leaves the store outdated again afterwards but
// never mixed. The old generation keeps answering searches until THE SWITCH: one
// transaction that checks every file is present in the target generation, sets
// the store's `active_generation`, `embedding_model` and `embedding_dim`, and
// deletes the old generation. Search re-reads both the generation and the model
// in its recall snapshot, so it sees the store entirely before or entirely after.
//
// A RE-CHUNK (rechunk.ts) is this same job with a pinned `target_chunking`: its
// items chunk each file again from its blob instead of copying the chunk text, and
// the switch also sets the store's `chunking`.
//
// WORK ITEMS: one `fs_reembed_items` row per file, claimed by the ingest
// worker's loops (reembedWorker.ts, which also holds the switch) with the ingestion queue's claim, lease and retry semantics —
// but only when no upload is waiting (ingestWorker.ts runLoop). A file attached
// while the job runs is written into both generations by ingestion itself
// (commitChunks), which records its item completed; a detach or file delete
// removes the item with the file (storeFiles.ts, batches.ts); store expiry
// cancels the open items and the job then fails.
//
// LOCK ORDER (jobs.ts): `vector_stores` first, then `vector_store_files` (in
// file_id order), then `fs_jobs`, then `fs_reembed_items`. Every change of a
// re-embed's state — start, switch, cancel, retry, finish — locks the store row
// FOR UPDATE first. Ingestion's commitChunks and the item commit hold it FOR
// SHARE, so neither can see a job change under its feet, and a job row is only
// ever locked after its store's row. A bulk parent is locked after its child.
import type { PoolClient } from 'pg';
import { getFileSearchConfig } from '../services/configService';
import { embeddingState, EmbeddingState } from './embeddingState';
import { newJobId } from './ids';
import { jobSummary, jobSummaryAnyOwner, JobSummary, RetryResult } from './jobs';
import { publishIngestHint } from './ingestHint';
import {
  requirePool, inTransaction, settleParent, lockStoreAndReadJob, finalizeJob, JobRow,
} from './reembedWorker';

// ---------------------------------------------------------------------------
// Estimates (Decisions 11, 12)
// ---------------------------------------------------------------------------

/** What a re-embed of one store would embed: the active generation's files,
 *  chunks and the chunker's token estimate of their text (labelled "estimated
 *  tokens" — the provider counts its own). No money: the gateway knows no prices. */
export interface StoreEstimate {
  files: number;
  chunks: number;
  estimated_tokens: number;
  state: EmbeddingState;
}

export type SkipReason = 'dimension_mismatch' | 'expired' | 'reembed_running';

export interface SkippedStore {
  store_id: string;
  owner_email: string;
  reason: SkipReason;
}

export interface OutdatedEstimate {
  stores: number;
  files: number;
  chunks: number;
  estimated_tokens: number;
  skipped: SkippedStore[];
}

/** Per-store counters of the active generation, by the same rule for one store and for all.
 *  The tokens are what a re-embed sends (chunkRows.ts embeddingInputOf): a chunk's text and, when
 *  it has one, its context — counted as a quarter token per character plus the blank line
 *  between them (contexts have no stored count); a chunk of only whitespace, which is stored
 *  without a vector, is not embedded and not counted. */
const STORE_COUNTS_SQL = `
  (SELECT COUNT(*) FROM vector_store_files f WHERE f.store_id = vs.id AND f.status = 'completed')::int AS files,
  (SELECT COUNT(*) FROM vector_store_chunks c
    WHERE c.store_id = vs.id AND c.generation = vs.active_generation)::int AS chunks,
  (SELECT COALESCE(SUM(COALESCE(c.tokens, 0)
                       + CASE WHEN c.context IS NULL THEN 0 ELSE ceil(length(c.context) / 4.0)::int + 1 END), 0)
     FROM vector_store_chunks c
    WHERE c.store_id = vs.id AND c.generation = vs.active_generation
      AND c.embedding IS NOT NULL)::bigint AS estimated_tokens`;

function configTarget(): { embeddingModel: string; embeddingDimensions: number } {
  const config = getFileSearchConfig();
  return { embeddingModel: config.embeddingModel, embeddingDimensions: config.embeddingDimensions };
}

/** The estimate for one store of `ownerEmail`, or null when the owner has no
 *  such store (a shared store of another owner included — spec §5.1). */
export async function estimateStore(ownerEmail: string, storeId: string): Promise<StoreEstimate | null> {
  const { rows } = await requirePool().query(
    `SELECT vs.embedding_model, vs.embedding_dim, ${STORE_COUNTS_SQL}
       FROM vector_stores vs WHERE vs.id = $1 AND vs.owner_email = $2`,
    [storeId, ownerEmail],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    files: row.files,
    chunks: row.chunks,
    estimated_tokens: Number(row.estimated_tokens),
    state: embeddingState(row, configTarget()),
  };
}

interface OutdatedCandidate {
  id: string;
  owner_email: string;
  files: number;
  chunks: number;
  estimated_tokens: number;
  skip: SkipReason | null;
}

/** Every store, of any owner, whose model or dimension differs from the
 *  configuration, with why it would be skipped (or null when it is included). */
async function outdatedCandidates(): Promise<OutdatedCandidate[]> {
  const target = configTarget();
  const { rows } = await requirePool().query(
    `SELECT vs.id, vs.owner_email, vs.status, vs.embedding_model, vs.embedding_dim,
            EXISTS (SELECT 1 FROM fs_jobs j
                     WHERE j.store_id = vs.id AND j.kind = 'reembed_store' AND j.finished_at IS NULL) AS running,
            ${STORE_COUNTS_SQL}
       FROM vector_stores vs
      WHERE vs.embedding_model <> $1 OR vs.embedding_dim <> $2
      ORDER BY vs.id`,
    [target.embeddingModel, target.embeddingDimensions],
  );
  return rows.map((row) => {
    let skip: SkipReason | null = null;
    if (embeddingState(row, target) === 'dimension_mismatch') skip = 'dimension_mismatch';
    else if (row.status === 'expired') skip = 'expired';
    else if (row.running) skip = 'reembed_running';
    return {
      id: row.id,
      owner_email: row.owner_email,
      files: row.files,
      chunks: row.chunks,
      estimated_tokens: Number(row.estimated_tokens),
      skip,
    };
  });
}

/** The bulk estimate over every owner's outdated stores, and the stores a bulk
 *  re-embed would skip, with the reason. */
export async function estimateOutdated(): Promise<OutdatedEstimate> {
  const candidates = await outdatedCandidates();
  const included = candidates.filter((c) => c.skip === null);
  return {
    stores: included.length,
    files: included.reduce((n, c) => n + c.files, 0),
    chunks: included.reduce((n, c) => n + c.chunks, 0),
    estimated_tokens: included.reduce((n, c) => n + c.estimated_tokens, 0),
    skipped: candidates
      .filter((c) => c.skip !== null)
      .map((c) => ({ store_id: c.id, owner_email: c.owner_email, reason: c.skip as SkipReason })),
  };
}

/** The unfinished `reembed_store` job of each of `storeIds` that has one (at
 *  most one per store: the unique running index), for the store objects'
 *  `reembed_job_id`. One query for the whole page. */
export async function unfinishedReembedJobs(storeIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (storeIds.length === 0) return result;
  const { rows } = await requirePool().query<{ store_id: string; id: string }>(
    `SELECT store_id, id FROM fs_jobs
      WHERE kind = 'reembed_store' AND finished_at IS NULL AND store_id = ANY($1::text[])`,
    [storeIds],
  );
  for (const row of rows) result.set(row.store_id, row.id);
  return result;
}

// ---------------------------------------------------------------------------
// Start (Decisions 3, 5, 10, 14)
// ---------------------------------------------------------------------------

/** Who starts a re-embed: the e-mail recorded as `started_by` and the
 *  credential, stamped like a batch's for later usage accounting (Decision 14). */
export interface ReembedActor {
  email: string;
  credentialId?: string | null;
  authType?: string | null;
}

export type StartRefusal = 'not_found' | 'store_dimension_mismatch' | 'store_expired' | 'reembed_running' | 'store_current';

export type StartResult = { ok: true; job: JobSummary } | { ok: false; error: StartRefusal };

type StartCore = { ok: true; jobId: string; items: number } | { ok: false; error: StartRefusal };

/**
 * Creates the job and one item per completed file inside the caller's
 * transaction, under the lock order: the store FOR UPDATE (no attach, detach,
 * ingestion commit or other re-embed change can interleave), the completed files
 * FOR SHARE in file_id order, then the job and its items. A refusal has written
 * nothing.
 */
async function startInTransaction(
  client: PoolClient, ownerEmail: string, storeId: string, actor: ReembedActor, parentId: string | null,
  target: { embeddingModel: string; embeddingDimensions: number },
): Promise<StartCore> {
  const refuse = (error: StartRefusal): StartCore => ({ ok: false, error });
  const { rows } = await client.query(
        `SELECT id, owner_email, status, embedding_model, embedding_dim, active_generation
           FROM vector_stores WHERE id = $1 AND owner_email = $2 FOR UPDATE`,
    [storeId, ownerEmail],
  );
  const store = rows[0];
  if (!store) return refuse('not_found');
  const state = embeddingState(store, target);
  if (state === 'dimension_mismatch') return refuse('store_dimension_mismatch');
  if (store.status === 'expired') return refuse('store_expired');
  const running = await client.query(
    `SELECT 1 FROM fs_jobs WHERE store_id = $1 AND kind = 'reembed_store' AND finished_at IS NULL`, [storeId]);
  if ((running.rowCount ?? 0) > 0) return refuse('reembed_running');
  // Re-embedding stored chunk text with the same model would reproduce the
  // same vectors (ruling R1).
  if (state === 'current') return refuse('store_current');

  return insertStoreJob(client, store, actor, parentId,
    { model: target.embeddingModel, dim: target.embeddingDimensions, chunking: null });
}

/**
 * The job and one item per completed file, under the store lock the caller holds (FOR
 * UPDATE, after its refusal checks): the store's other generations are dropped (a failed
 * earlier job that was never cancelled left one behind; this job supersedes it — retry
 * refuses a superseded job), the completed files are locked FOR SHARE in file_id order, then
 * the job and its items are written. `target.chunking` non-null makes it a re-chunk
 * (rechunk.ts): its items chunk the file again by that setting instead of copying the chunks;
 * with `reextract` (reextract.ts) only the files an older extractor read, the others are copied
 * with their vectors.
 */
export async function insertStoreJob(
  client: PoolClient,
  store: { id: string; owner_email: string; active_generation: number },
  actor: ReembedActor,
  parentId: string | null,
  target: { model: string; dim: number; chunking: Record<string, unknown> | null; reextract?: boolean },
): Promise<{ ok: true; jobId: string; items: number }> {
  const storeId = store.id;
  await client.query(
    'DELETE FROM vector_store_chunks WHERE store_id = $1 AND generation <> $2', [storeId, store.active_generation]);
  const files = await client.query<{ file_id: string }>(
    `SELECT file_id FROM vector_store_files WHERE store_id = $1 AND status = 'completed'
      ORDER BY file_id FOR SHARE`,
    [storeId],
  );
  const jobId = newJobId();
  await client.query(
    `INSERT INTO fs_jobs (id, kind, parent_id, owner_email, started_by, credential_id, auth_type, store_id,
                          target_model, target_dim, target_generation, target_chunking, reextract)
     VALUES ($1, 'reembed_store', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [jobId, parentId, store.owner_email, actor.email, actor.credentialId ?? null, actor.authType ?? null, storeId,
      target.model, target.dim, store.active_generation + 1,
      target.chunking === null ? null : JSON.stringify(target.chunking), target.reextract === true ? true : null],
  );
  const fileIds = files.rows.map((r) => r.file_id);
  if (fileIds.length > 0) {
    await client.query(
      `INSERT INTO fs_reembed_items (job_id, store_id, file_id)
       SELECT $1, $2, file_id FROM unnest($3::text[]) AS file_id`,
      [jobId, storeId, fileIds],
    );
  }
  return { ok: true, jobId, items: fileIds.length };
}

/** After a start commits: an empty store switches at once; otherwise the worker
 *  loops are woken (best effort — they poll anyway). */
export async function afterStart(storeId: string, jobId: string, items: number): Promise<void> {
  if (items === 0) {
    await finalizeJob(jobId);
  } else {
    await publishIngestHint(storeId, '');
  }
}

/**
 * Starts re-embedding `storeId` of `ownerEmail` with the configured model.
 * Owner-scoped: the admin entry resolves the store's owner first and passes it,
 * with the admin as `actor` (the job shows in the owner's Jobs, started by the
 * admin). Refuses a store whose dimension differs (`store_dimension_mismatch`),
 * an expired store, a store with a re-embed already running, and a store that
 * is already on the configured model (`store_current`, ruling R1).
 */
export async function startReembed(ownerEmail: string, storeId: string, actor: ReembedActor): Promise<StartResult> {
  const target = configTarget();
  let started: StartCore;
  try {
    started = await inTransaction<StartCore>(async (client) => {
      const value = await startInTransaction(client, ownerEmail, storeId, actor, null, target);
      return { commit: value.ok, value };
    });
  } catch (error: any) {
    // The unique "one running re-embed per store" index: a concurrent start won.
    if (error?.code === '23505') return { ok: false, error: 'reembed_running' };
    throw error;
  }
  if (!started.ok) return started;
  await afterStart(storeId, started.jobId, started.items);
  const job = await jobSummary(started.jobId, ownerEmail);
  if (!job) throw new Error('reembed job vanished right after its start');
  return { ok: true, job };
}

export type BulkStartResult =
  | { ok: true; job: JobSummary; skipped: SkippedStore[] }
  | { ok: false; error: 'nothing_to_reembed' };

/**
 * Re-embeds every outdated store of every owner (Decision 11): a parent
 * `reembed_bulk` job owned by the acting admin (ruling R2: `owner_email` = the
 * admin, no store) and one `reembed_store` child per included store, owned by
 * the store's owner and started by the admin. Stores with another dimension,
 * expired stores and stores already re-embedding are skipped and reported; a
 * store that changed between the estimate and its own start is skipped with the
 * refusal's reason. Nothing to re-embed: `nothing_to_reembed`, no job.
 *
 * The parent and every child are created in ONE transaction, the stores locked
 * in id order (the order deleteFileDetachingEverywhere locks several stores
 * in): a child that finished while its siblings were still being created would
 * otherwise find no unfinished sibling and finish the parent early.
 */
export async function startBulkReembed(actor: ReembedActor): Promise<BulkStartResult> {
  const candidates = await outdatedCandidates();
  const included = candidates.filter((c) => c.skip === null);
  const skipped: SkippedStore[] = candidates
    .filter((c) => c.skip !== null)
    .map((c) => ({ store_id: c.id, owner_email: c.owner_email, reason: c.skip as SkipReason }));
  if (included.length === 0) return { ok: false, error: 'nothing_to_reembed' };

  const target = configTarget();
  const parentId = newJobId();
  const children: Array<{ storeId: string; jobId: string; items: number }> = [];
  const lateSkips: SkippedStore[] = [];
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO fs_jobs (id, kind, owner_email, started_by, credential_id, auth_type, target_model, target_dim)
       VALUES ($1, 'reembed_bulk', $2, $2, $3, $4, $5, $6)`,
      [parentId, actor.email, actor.credentialId ?? null, actor.authType ?? null,
        target.embeddingModel, target.embeddingDimensions],
    );
    for (const store of included) { // ordered by id (outdatedCandidates)
      // eslint-disable-next-line no-await-in-loop
      const started = await startInTransaction(client, store.owner_email, store.id, actor, parentId, target);
      if (started.ok) {
        children.push({ storeId: store.id, jobId: started.jobId, items: started.items });
      } else if (started.error === 'store_expired' || started.error === 'reembed_running'
        || started.error === 'store_dimension_mismatch') {
        lateSkips.push({
          store_id: store.id,
          owner_email: store.owner_email,
          reason: started.error === 'store_expired' ? 'expired'
            : started.error === 'reembed_running' ? 'reembed_running' : 'dimension_mismatch',
        });
      }
      // not_found (deleted meanwhile) and store_current (configuration changed
      // back meanwhile) leave nothing to re-embed and nothing to report.
    }
    return { commit: children.length > 0, value: undefined };
  });
  if (children.length === 0) return { ok: false, error: 'nothing_to_reembed' };
  skipped.push(...lateSkips);
  for (const child of children) {
    // eslint-disable-next-line no-await-in-loop
    await afterStart(child.storeId, child.jobId, child.items);
  }
  const job = await jobSummary(parentId, actor.email);
  if (!job) throw new Error('bulk reembed job vanished right after its start');
  return { ok: true, job, skipped };
}

// ---------------------------------------------------------------------------
// Cancel and retry (Decisions 6, 10)
// ---------------------------------------------------------------------------

export type CancelResult = { ok: true; job: JobSummary } | { ok: false; error: 'not_found' };

/** A re-embed job visible to `ownerEmail`, or to an admin (null) of any owner.
 *  Only the re-embed kinds: a file batch is not found here (Decision 10). */
async function findReembedJob(ownerEmail: string | null, jobId: string): Promise<JobRow | null> {
  const { rows } = await requirePool().query<JobRow>(
    `SELECT * FROM fs_jobs WHERE id = $1 AND kind IN ('reembed_store', 'reembed_bulk')
        AND ($2::text IS NULL OR owner_email = $2)`,
    [jobId, ownerEmail],
  );
  return rows[0] ?? null;
}

async function summaryFor(ownerEmail: string | null, jobId: string): Promise<JobSummary | null> {
  return ownerEmail === null ? jobSummaryAnyOwner(jobId) : jobSummary(jobId, ownerEmail);
}

/**
 * Whether the store moved on past `job`: another re-embed of the store started
 * after it (or still runs), or its target is no longer the generation after the
 * active one. A newer start reuses the number active+1, so a superseded job's
 * target generation may well be its successor's. Under the caller's store lock.
 */
async function isSuperseded(
  client: PoolClient, job: JobRow, store: { active_generation: number },
): Promise<boolean> {
  const newer = await client.query(
    `SELECT 1 FROM fs_jobs WHERE store_id = $1 AND kind = 'reembed_store' AND id <> $2
        AND (finished_at IS NULL OR created_at > $3)`,
    [job.store_id, job.id, job.created_at]);
  return (newer.rowCount ?? 0) > 0 || job.target_generation !== store.active_generation + 1;
}

/**
 * Cancels one store's re-embed: its open items `cancelled`, its target
 * generation deleted, the job finished as cancelled — one transaction under the
 * store lock, so the store keeps answering from its active generation
 * throughout. A finished job that switched, or one already cancelled, is left
 * as it is; a job that failed can be cancelled to discard its generation —
 * unless it is superseded: then the generation of that number belongs to the
 * store's active state or to the successor, and only the cancel is latched.
 */
async function cancelStoreJob(jobId: string): Promise<void> {
  await inTransaction(async (client) => {
    const locked = await lockStoreAndReadJob(client, jobId);
    if (!locked) return { commit: false, value: undefined };
    const { job, store } = locked;
    if (job.cancel_requested || (job.finished_at && job.error === null)) return { commit: false, value: undefined };
    await client.query(
      `UPDATE fs_reembed_items SET status = 'cancelled', claimed_at = NULL WHERE job_id = $1 AND status = 'in_progress'`,
      [jobId]);
    if (!(await isSuperseded(client, job, store))) {
      await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1 AND generation = $2',
        [job.store_id, job.target_generation]);
    }
    await client.query(
      'UPDATE fs_jobs SET cancel_requested = true, finished_at = COALESCE(finished_at, now()) WHERE id = $1', [jobId]);
    await settleParent(client, job.parent_id);
    return { commit: true, value: undefined };
  });
}

/**
 * Cancels a re-embed job of `ownerEmail` (an admin passes null: any owner).
 * A bulk parent gets its cancel latch and cancels every child that is still
 * running or failed. Answers with the job as it is afterwards.
 */
export async function cancelReembed(ownerEmail: string | null, jobId: string): Promise<CancelResult> {
  const job = await findReembedJob(ownerEmail, jobId);
  if (!job) return { ok: false, error: 'not_found' };
  if (job.kind === 'reembed_store') {
    await cancelStoreJob(jobId);
  } else {
    const children = await requirePool().query<{ id: string }>(
      `SELECT id FROM fs_jobs WHERE parent_id = $1 AND NOT cancel_requested
          AND (finished_at IS NULL OR error IS NOT NULL) ORDER BY id`, [jobId]);
    if (!job.cancel_requested && (children.rowCount ?? 0) > 0) {
      await requirePool().query('UPDATE fs_jobs SET cancel_requested = true WHERE id = $1', [jobId]);
    }
    for (const child of children.rows) {
      // eslint-disable-next-line no-await-in-loop
      await cancelStoreJob(child.id);
    }
    await inTransaction(async (client) => ({ commit: true, value: await settleParent(client, jobId) }));
  }
  const summary = await summaryFor(ownerEmail, jobId);
  if (!summary) return { ok: false, error: 'not_found' };
  return { ok: true, job: summary };
}

/**
 * Re-opens the failed items of one failed store job and un-finishes it (and its
 * parent). Refused while it runs (`job_running`), for an expired store, and when
 * there is nothing to retry: not failed, cancelled, or superseded — the store
 * moved on (another re-embed started or switched since).
 */
async function retryStoreJob(jobId: string): Promise<RetryResult> {
  try {
    return await inTransaction<RetryResult>(async (client) => {
      const refuse = (error: 'not_found' | 'job_running' | 'store_expired' | 'nothing_to_retry') =>
        ({ commit: false, value: { ok: false as const, error } });
      const locked = await lockStoreAndReadJob(client, jobId);
      if (!locked) return refuse('not_found');
      const { job, store } = locked;
      if (store.status === 'expired') return refuse('store_expired');
      if (!job.finished_at) return refuse('job_running');
      if (job.cancel_requested || job.error === null) return refuse('nothing_to_retry');
      if (await isSuperseded(client, job, store)) return refuse('nothing_to_retry');
      const reopened = await client.query(
        `UPDATE fs_reembed_items SET status = 'in_progress', attempts = 0, last_error = NULL, claimed_at = NULL
          WHERE job_id = $1 AND status = 'failed'`,
        [jobId]);
      if ((reopened.rowCount ?? 0) === 0) return refuse('nothing_to_retry');
      await client.query('UPDATE fs_jobs SET finished_at = NULL, error = NULL WHERE id = $1', [jobId]);
      if (job.parent_id) {
        await client.query('UPDATE fs_jobs SET finished_at = NULL WHERE id = $1', [job.parent_id]);
      }
      return { commit: true, value: { ok: true as const, job_id: jobId, retried: reopened.rowCount ?? 0 } };
    });
  } catch (error: any) {
    // The unique "one running re-embed per store" index.
    if (error?.code === '23505') return { ok: false, error: 'job_running' };
    throw error;
  }
}

/**
 * Retries a failed re-embed job of `ownerEmail` (an admin passes null: any
 * owner): its failed items are re-opened and the job runs again from where it
 * stopped. For a bulk parent, every failed child is retried; `retried` counts
 * the re-opened items.
 */
export async function retryReembed(ownerEmail: string | null, jobId: string): Promise<RetryResult> {
  const job = await findReembedJob(ownerEmail, jobId);
  if (!job) return { ok: false, error: 'not_found' };
  let result: RetryResult;
  if (job.kind === 'reembed_store') {
    result = await retryStoreJob(jobId);
  } else if (job.cancel_requested) {
    result = { ok: false, error: 'nothing_to_retry' };
  } else {
    const children = await requirePool().query<{ id: string }>(
      `SELECT id FROM fs_jobs WHERE parent_id = $1 AND finished_at IS NOT NULL AND NOT cancel_requested
          AND error IS NOT NULL ORDER BY id`, [jobId]);
    let retried = 0;
    for (const child of children.rows) {
      // eslint-disable-next-line no-await-in-loop
      const one = await retryStoreJob(child.id);
      if (one.ok) retried += one.retried;
    }
    result = retried > 0 ? { ok: true, job_id: jobId, retried } : { ok: false, error: 'nothing_to_retry' };
  }
  if (result.ok) await publishIngestHint(job.store_id ?? '', '');
  return result;
}
