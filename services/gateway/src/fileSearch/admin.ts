// ADMIN QUERIES — the data layer behind the cockpit's Administration screen
// (spec 2026-10-01 §5.2 admin level, §7.5). Nothing here is HTTP-aware and
// nothing here checks the caller's role: the route guard does that. These are
// the only file_search reads that are NOT scoped by an owner's e-mail.
//
// WHAT THEY NEVER SELECT (spec §5.1, plan decision 9): chunk text, extracted
// text, blob bytes or locations, content hashes, or any part of `last_error`
// beyond the sanitised `message` and `name` the worker stored. Every statement
// names its columns; none uses `*`. The integration suite pins the row keys.
//
// PAGING: the lists are newest first, keyset-paged on `(created_at, id)` with
// the cursor resolved inside the statement (as jobs.listJobs does), so
// `created_at` is compared at full microsecond precision and an unknown
// cursor compares against NULL — an empty page, never page one. Each list
// returns up to `limit + 1` rows; the caller trims with `pagination.buildPage`,
// which is how `has_more` is known without a COUNT. The store and file lists
// walk `idx_vector_stores_created` / `idx_fs_files_created` backwards.
//
// INPUT: `owner` is an exact e-mail (bound, never a pattern); `status`,
// `state` and `limit` come from fixed sets. Invalid input throws
// AdminQueryInputError (map to 400).
import type { Pool } from 'pg';
import { getPool } from './db';
import { derivedJobsSql, toSummary, type JobState, type JobSummary } from './jobs';
import type { EmbeddingState } from './embeddingState';
import type { ChunkingSetting } from './chunkingSetting';

export class AdminQueryInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AdminQueryInputError';
  }
}

export const MAX_ADMIN_PAGE_LIMIT = 100;

/** A store's status as the API reports it: derived from its files, except
 *  `expired`, which is read from the row (see vectorStoresController's
 *  deriveStoreStatus). */
export const ADMIN_STORE_STATUSES = ['in_progress', 'completed', 'expired'] as const;
export type AdminStoreStatus = (typeof ADMIN_STORE_STATUSES)[number];

/** A store's embedding state against the configured model (embeddingState.ts), as a list filter. */
export const ADMIN_EMBEDDING_STATES = ['current', 'outdated', 'dimension_mismatch'] as const satisfies readonly EmbeddingState[];

// A Record over the union, so adding a JobState without listing it here fails to compile.
const JOB_STATE_SET: Record<JobState, true> = {
  queued: true, running: true, cancelling: true, cancelled: true,
  completed: true, completed_with_errors: true, failed: true,
};
export const ADMIN_JOB_STATES = Object.keys(JOB_STATE_SET) as JobState[];

const NUL_BYTE = String.fromCharCode(0);
const MAX_OWNER_LENGTH = 320;
const MAX_CURSOR_LENGTH = 200;

function requirePool(): Pool {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  return pool;
}

function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADMIN_PAGE_LIMIT) {
    throw new AdminQueryInputError(`limit must be an integer from 1 to ${MAX_ADMIN_PAGE_LIMIT}.`);
  }
  return limit;
}

/** A bound text value: a non-empty string without a NUL byte (Postgres text
 *  cannot hold one, and the driver error would surface as a 500). */
function checkText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes(NUL_BYTE)) {
    throw new AdminQueryInputError(`${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

const optionalOwner = (owner: string | null | undefined): string | null =>
  owner === undefined || owner === null ? null : checkText(owner, 'owner', MAX_OWNER_LENGTH);

const optionalCursor = (after: string | null | undefined): string | null =>
  after === undefined || after === null ? null : checkText(after, 'after', MAX_CURSOR_LENGTH);

/** The storage list pages on `owner_email`, so its cursor is an e-mail and takes the owner bound. */
const optionalOwnerCursor = (after: string | null | undefined): string | null =>
  after === undefined || after === null ? null : checkText(after, 'after', MAX_OWNER_LENGTH);

/** A store or file id no row can carry (empty, too long, a NUL byte): the owner lookups answer
 *  "no such row" for it, so an admin mutation 404s exactly where the owner's path does. */
const isLookupId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= MAX_CURSOR_LENGTH && !id.includes(NUL_BYTE);

/** Collects WHERE terms and their parameters with the placeholder numbering kept in one place. */
class Where {
  readonly params: unknown[] = [];
  private readonly terms: string[] = [];

  /** Binds `values` and adds `term`, in which each `?` stands for the next value's placeholder. */
  add(term: string, ...values: unknown[]): void {
    const pieces = term.split('?');
    if (pieces.length !== values.length + 1) throw new Error('placeholder count does not match the values');
    let sql = pieces[0];
    values.forEach((value, i) => {
      this.params.push(value);
      sql += `$${this.params.length}${pieces[i + 1]}`;
    });
    this.terms.push(sql);
  }

  addLiteral(term: string): void {
    this.terms.push(term);
  }

  sql(): string {
    return this.terms.length > 0 ? this.terms.join(' AND ') : 'true';
  }

  /** Binds the limit last and returns its placeholder. */
  limit(limit: number): string {
    this.params.push(limit + 1);
    return `$${this.params.length}`;
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface AdminOverview {
  stores: number;
  files: number;
  /** Sum of every file's size: what the owners uploaded. */
  logical_bytes: number;
  /** Sum of the stored blobs: content-addressed, one copy per distinct content. */
  physical_bytes: number;
  /** logical − physical, never below 0. */
  savings_bytes: number;
  failed_ingestions: number;
  /** Stores whose embedding state is `outdated` against the configured model:
   *  another model, the same dimension (embeddingState.ts) — expired stores left
   *  out, so the tile matches what the bulk re-embed processes (ruling R9). */
  outdated_stores: number;
}

/** The configured embedding model and dimension the overview compares stores with. */
export interface EmbeddingTarget {
  embeddingModel: string;
  embeddingDimensions: number;
}

/**
 * The overview tiles. Reads `vector_stores`, `fs_files`, `file_blobs`
 * (`size_bytes` only) and the failed `vector_store_files` rows — never
 * `vector_store_chunks`. `outdated_stores` is counted in SQL by embeddingState's
 * rule (dimension equal, model different), not by loading the stores; an
 * expired store is not counted, as the bulk re-embed skips it.
 */
export async function overview(target: EmbeddingTarget): Promise<AdminOverview> {
  const { rows } = await requirePool().query<Record<string, string>>(
    `SELECT (SELECT COUNT(*) FROM vector_stores)                                   AS stores,
            (SELECT COUNT(*) FROM fs_files)                                        AS files,
            (SELECT COALESCE(SUM(size_bytes), 0) FROM fs_files)                    AS logical_bytes,
            (SELECT COALESCE(SUM(size_bytes), 0) FROM file_blobs)                  AS physical_bytes,
            (SELECT COUNT(*) FROM vector_store_files WHERE status = 'failed')      AS failed_ingestions,
            (SELECT COUNT(*) FROM vector_stores
              WHERE embedding_dim = $2 AND embedding_model <> $1
                AND status <> 'expired')                                       AS outdated_stores`,
    [target.embeddingModel, target.embeddingDimensions],
  );
  // COUNT and SUM(bigint) arrive as strings from node-postgres.
  const row = rows[0];
  const logical = Number(row.logical_bytes);
  const physical = Number(row.physical_bytes);
  return {
    stores: Number(row.stores),
    files: Number(row.files),
    logical_bytes: logical,
    physical_bytes: physical,
    // A blob is retained before its fs_files row is inserted, so an upload in
    // flight can briefly make physical exceed logical.
    savings_bytes: Math.max(0, logical - physical),
    failed_ingestions: Number(row.failed_ingestions),
    outdated_stores: Number(row.outdated_stores),
  };
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** The columns of a store row an admin may see — every column of
 *  `vector_stores`, named, so a future column is not exposed by accident. */
const STORE_COLUMNS = `vs.id, vs.owner_email, vs.is_shared, vs.name, vs.status, vs.metadata, vs.embedding_model,
       vs.embedding_dim, vs.active_generation, vs.chunking, vs.expires_after, vs.expires_at, vs.last_active_at, vs.created_at`;

export interface AdminStoreRow {
  id: string;
  owner_email: string;
  is_shared: boolean;
  name: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  embedding_model: string;
  embedding_dim: number;
  active_generation: number;
  chunking: ChunkingSetting | null;
  expires_after: { anchor: string; days: number } | null;
  expires_at: Date | null;
  last_active_at: Date;
  created_at: Date;
}

export interface ListAllStoresOptions {
  owner?: string | null;
  /** The derived status the API reports. */
  status?: AdminStoreStatus | null;
  shared?: boolean | null;
  /** Only stores in this embedding state, measured against `target` — embeddingState's rule in SQL. */
  embeddingState?: { state: EmbeddingState; target: EmbeddingTarget } | null;
  /** Store id of the last row of the previous page. */
  after?: string | null;
  limit: number;
}

const IN_PROGRESS_FILE = `EXISTS (SELECT 1 FROM vector_store_files f WHERE f.store_id = vs.id AND f.status = 'in_progress')`;

/** Every owner's stores, newest first. The rows are `VectorStoreRow`-shaped, so
 *  the controller turns them into OpenAI store objects as it does the owner's. */
export async function listAllStores(opts: ListAllStoresOptions): Promise<AdminStoreRow[]> {
  const limit = checkLimit(opts.limit);
  const owner = optionalOwner(opts.owner);
  const after = optionalCursor(opts.after);
  const status = opts.status ?? null;
  if (status !== null && !(ADMIN_STORE_STATUSES as readonly string[]).includes(status)) {
    throw new AdminQueryInputError(`status must be one of ${ADMIN_STORE_STATUSES.join(', ')}.`);
  }
  const shared = opts.shared ?? null;
  if (shared !== null && typeof shared !== 'boolean') {
    throw new AdminQueryInputError('shared must be true or false.');
  }
  const embedding = opts.embeddingState ?? null;
  if (embedding !== null && !(ADMIN_EMBEDDING_STATES as readonly string[]).includes(embedding.state)) {
    throw new AdminQueryInputError(`embedding_state must be one of ${ADMIN_EMBEDDING_STATES.join(', ')}.`);
  }
  if (embedding !== null && (!embedding.target || typeof embedding.target.embeddingModel !== 'string'
    || !Number.isInteger(embedding.target.embeddingDimensions))) {
    // The controller passes the configured target; a missing one is a programming error, not input.
    throw new Error('embedding_state filter needs a target model and dimension');
  }

  const where = new Where();
  if (owner !== null) where.add('vs.owner_email = ?', owner);
  if (shared !== null) where.add('vs.is_shared = ?', shared);
  // embeddingState(): a dimension mismatch wins over a model difference.
  if (embedding?.state === 'dimension_mismatch') where.add('vs.embedding_dim <> ?', embedding.target.embeddingDimensions);
  if (embedding?.state === 'outdated') {
    where.add('vs.embedding_dim = ? AND vs.embedding_model <> ?', embedding.target.embeddingDimensions, embedding.target.embeddingModel);
  }
  if (embedding?.state === 'current') {
    where.add('vs.embedding_dim = ? AND vs.embedding_model = ?', embedding.target.embeddingDimensions, embedding.target.embeddingModel);
  }
  if (status === 'expired') where.addLiteral(`vs.status = 'expired'`);
  if (status === 'in_progress') where.addLiteral(`vs.status <> 'expired' AND ${IN_PROGRESS_FILE}`);
  if (status === 'completed') where.addLiteral(`vs.status <> 'expired' AND NOT ${IN_PROGRESS_FILE}`);
  if (after !== null) {
    where.add('(vs.created_at, vs.id) < (SELECT c.created_at, c.id FROM vector_stores c WHERE c.id = ?)', after);
  }
  const limitParam = where.limit(limit);
  const { rows } = await requirePool().query<AdminStoreRow>(
    `SELECT ${STORE_COLUMNS}
       FROM vector_stores vs
      WHERE ${where.sql()}
      ORDER BY vs.created_at DESC, vs.id DESC
      LIMIT ${limitParam}`,
    where.params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface AdminFileRow {
  id: string;
  owner_email: string;
  filename: string;
  purpose: string;
  size_bytes: number;
  created_at: Date;
  /** How many stores (of any owner) the file is attached to. */
  attachment_count: number;
}

export interface ListAllFilesOptions {
  owner?: string | null;
  /** File id of the last row of the previous page. */
  after?: string | null;
  limit: number;
}

/** Every owner's files, newest first: metadata only, no content hash. */
export async function listAllFiles(opts: ListAllFilesOptions): Promise<AdminFileRow[]> {
  const limit = checkLimit(opts.limit);
  const owner = optionalOwner(opts.owner);
  const after = optionalCursor(opts.after);

  const where = new Where();
  if (owner !== null) where.add('f.owner_email = ?', owner);
  if (after !== null) {
    where.add('(f.created_at, f.id) < (SELECT c.created_at, c.id FROM fs_files c WHERE c.id = ?)', after);
  }
  const limitParam = where.limit(limit);
  const { rows } = await requirePool().query(
    `SELECT f.id, f.owner_email, f.filename, f.purpose, f.size_bytes, f.created_at,
            (SELECT COUNT(*) FROM vector_store_files a WHERE a.file_id = f.id)::int AS attachment_count
       FROM fs_files f
      WHERE ${where.sql()}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ${limitParam}`,
    where.params,
  );
  return rows.map((row) => ({ ...row, size_bytes: Number(row.size_bytes) }));
}

// ---------------------------------------------------------------------------
// Failed ingestions
// ---------------------------------------------------------------------------

export interface AdminFailedAttachmentRow {
  /** `<store_id>/<file_id>` — the paging cursor, since an attachment has no id of its own. */
  id: string;
  store_id: string;
  store_name: string | null;
  file_id: string;
  filename: string;
  owner_email: string;
  /** Only the sanitised message and the error's class name, as the worker stored them. */
  last_error: { message: string | null; name: string | null };
  attempts: number;
  batch_id: string | null;
  created_at: Date;
}

export interface ListFailedAttachmentsOptions {
  /** The store owner's exact e-mail. */
  owner?: string | null;
  /** One file batch's failed members only (the job page of another owner's batch). */
  batchId?: string | null;
  /** `id` of the last row of the previous page (`<store_id>/<file_id>`). */
  after?: string | null;
  limit: number;
}

/**
 * Attachments whose ingestion failed, newest attachment first, keyset-paged
 * on `(created_at, store_id, file_id)` along `idx_vsf_failed`. Files have no
 * status of their own; a failure belongs to a file in a store.
 */
export async function listFailedAttachments(opts: ListFailedAttachmentsOptions): Promise<AdminFailedAttachmentRow[]> {
  const limit = checkLimit(opts.limit);
  const owner = optionalOwner(opts.owner);
  const batchId = opts.batchId === undefined || opts.batchId === null ? null : checkText(opts.batchId, 'batch_id', MAX_CURSOR_LENGTH);
  const after = optionalCursor(opts.after);

  const where = new Where();
  where.addLiteral(`vsf.status = 'failed'`);
  if (owner !== null) where.add('vs.owner_email = ?', owner);
  if (batchId !== null) where.add('vsf.batch_id = ?', batchId);
  if (after !== null) {
    const slash = after.indexOf('/');
    if (slash < 1 || slash === after.length - 1) throw new AdminQueryInputError('after must be <store_id>/<file_id>.');
    where.add(
      `(vsf.created_at, vsf.store_id, vsf.file_id) < (SELECT c.created_at, c.store_id, c.file_id FROM vector_store_files c
                                                         WHERE c.store_id = ? AND c.file_id = ?)`,
      after.slice(0, slash),
      after.slice(slash + 1),
    );
  }
  const limitParam = where.limit(limit);
  const { rows } = await requirePool().query(
    `SELECT vsf.store_id || '/' || vsf.file_id AS id, vsf.store_id, vs.name AS store_name, vsf.file_id,
            f.filename, vs.owner_email,
            jsonb_build_object('message', vsf.last_error->>'message', 'name', vsf.last_error->>'name') AS last_error,
            vsf.attempts, vsf.batch_id, vsf.created_at
       FROM vector_store_files vsf
       JOIN vector_stores vs ON vs.id = vsf.store_id
       JOIN fs_files f ON f.id = vsf.file_id
      WHERE ${where.sql()}
      ORDER BY vsf.created_at DESC, vsf.store_id DESC, vsf.file_id DESC
      LIMIT ${limitParam}`,
    where.params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Storage per owner
// ---------------------------------------------------------------------------

export interface OwnerStorageRow {
  owner_email: string;
  file_count: number;
  /** Logical bytes: the sum of the owner's file sizes (plan decision 3). */
  logical_bytes: number;
}

export interface StorageByOwnerOptions {
  /** `owner_email` of the last row of the previous page. */
  after?: string | null;
  limit: number;
}

/** File count and logical bytes per owner, ordered by e-mail and keyset-paged
 *  on it (an owner has no created_at). A SUM per owner reads every file row:
 *  EXPLAIN shows a Seq Scan of `fs_files` and a HashAggregate, not an index
 *  walk — the cost of one aggregate over the files table per page. */
export async function storageByOwner(opts: StorageByOwnerOptions): Promise<OwnerStorageRow[]> {
  const limit = checkLimit(opts.limit);
  const after = optionalOwnerCursor(opts.after);

  const where = new Where();
  if (after !== null) where.add('owner_email > ?', after);
  const limitParam = where.limit(limit);
  const { rows } = await requirePool().query(
    `SELECT owner_email, COUNT(*)::int AS file_count, COALESCE(SUM(size_bytes), 0) AS logical_bytes
       FROM fs_files
      WHERE ${where.sql()}
      GROUP BY owner_email
      ORDER BY owner_email
      LIMIT ${limitParam}`,
    where.params,
  );
  return rows.map((row) => ({ ...row, logical_bytes: Number(row.logical_bytes) }));
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type AdminJobSummary = JobSummary & { owner_email: string | null };

export interface ListAllJobsOptions {
  owner?: string | null;
  state?: JobState | null;
  /** Job id of the last row of the previous page. */
  after?: string | null;
  limit: number;
}

/** Every owner's jobs, newest first, with the state derived exactly as for the
 *  owner's own list (jobs.derivedJobsSql) and the owner added. */
export async function listAllJobs(opts: ListAllJobsOptions): Promise<AdminJobSummary[]> {
  const limit = checkLimit(opts.limit);
  const owner = optionalOwner(opts.owner);
  const after = optionalCursor(opts.after);
  const state = opts.state ?? null;
  if (state !== null && !ADMIN_JOB_STATES.includes(state)) {
    throw new AdminQueryInputError(`state must be one of ${ADMIN_JOB_STATES.join(', ')}.`);
  }

  const where = new Where();
  if (owner !== null) where.add('j.owner_email = ?', owner);
  if (after !== null) {
    where.add('(j.created_at, j.id) < (SELECT c.created_at, c.id FROM fs_jobs c WHERE c.id = ?)', after);
  }
  let outer = '';
  if (state !== null) {
    where.params.push(state);
    outer = `state = $${where.params.length}`;
  }
  const limitParam = where.limit(limit);
  const { rows } = await requirePool().query(
    derivedJobsSql(where.sql(), outer, `ORDER BY created_at DESC, id DESC LIMIT ${limitParam}`, true),
    where.params,
  );
  return rows.map((row) => toSummary(row) as AdminJobSummary);
}

// ---------------------------------------------------------------------------
// Owner resolution (plan decision 6)
// ---------------------------------------------------------------------------

/** The owner of a store, or null when there is no such store. Admin mutations
 *  resolve it first and then call the owner-scoped repository function;
 *  `owner_email` never changes after creation, so the answer cannot go stale.
 *  An id no row can carry is null too, so the admin route 404s like the owner's. */
export async function ownerOfStore(storeId: string): Promise<string | null> {
  if (!isLookupId(storeId)) return null;
  const { rows } = await requirePool().query<{ owner_email: string }>(
    'SELECT owner_email FROM vector_stores WHERE id = $1', [storeId],
  );
  return rows[0]?.owner_email ?? null;
}

/** The owner of a file, or null when there is no such file (an id no row can carry included). */
export async function ownerOfFile(fileId: string): Promise<string | null> {
  if (!isLookupId(fileId)) return null;
  const { rows } = await requirePool().query<{ owner_email: string }>(
    'SELECT owner_email FROM fs_files WHERE id = $1', [fileId],
  );
  return rows[0]?.owner_email ?? null;
}
