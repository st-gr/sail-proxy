// Vector store rows: create, share, list and read, and the expiry deadline every activity recomputes
// (split out of repository.ts, which re-exports the public ones).
import { getPool } from './db';
import { getFileSearchConfig } from '../services/configService';
import { newVectorStoreId } from './ids';
import { ChunkingSetting, chunkingForNewStore, validateChunkingSetting } from './chunkingSetting';
import { storeAccessPredicateSql } from './recallSql';

// Recomputes `expires_at` from `expires_after`'s `days`, anchored to the SAME
// `now()` the calling statement sets `last_active_at` to (Postgres evaluates
// `now()` once per transaction, so two references to it within one statement
// agree). Every site that touches `last_active_at` because of genuine store
// *activity* -- attachFile and deleteStoreFile in storeFiles.ts, and storeAccess.ts's
// touchStoreActivity -- must recompute expires_at with this exact fragment,
// or expires_after:{anchor:'last_active_at'} silently degrades back into a
// fixed deadline pinned at creation (or at whichever call last forgot this;
// this was a real, shipped defect: vectorStoresController.ts's modify path
// computed expires_at from Date.now() instead of the store's own anchor, and
// neither attachFile nor deleteStoreFile recomputed it at all). Kept as one
// named constant so a future call site can't recompute it slightly
// differently and drift.
export const RECOMPUTE_EXPIRES_AT_SQL =
  `CASE WHEN expires_after IS NOT NULL ` +
  `THEN now() + ((expires_after->>'days')::int * interval '1 day') ` +
  `ELSE expires_at END`;

// The same deadline formula as RECOMPUTE_EXPIRES_AT_SQL, written for the INSERT
// in createStore where the row does not exist yet, so `expires_after` has to be
// read from the bound parameter rather than the column.
//
// It is SQL and not a JS `new Date()` for the reason the comment above gives:
// every site that writes `last_active_at` must agree on one clock. createStore
// was the site that did not — it bound a JS Date for `created_at`,
// `last_active_at` and the `expires_at` derived from them, so a store's
// `last_active_at` moved backwards on its first real activity whenever the
// application clock ran ahead of the database's, and `expires_at` jumped by
// that skew the first time anything recomputed it. Postgres evaluates `now()`
// once per transaction, so the two columns this expression feeds are stamped
// from the identical instant.
const initialExpiresAtSql = (expiresAfterParam: string): string =>
  `CASE WHEN ${expiresAfterParam}::jsonb IS NOT NULL `
  + `THEN now() + ((${expiresAfterParam}::jsonb->>'days')::int * interval '1 day') `
  + 'ELSE NULL END';

export interface VectorStoreRow {
  id: string;
  owner_email: string;
  is_shared: boolean;
  name: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  embedding_model: string;
  embedding_dim: number;
  /** The generation searches read (plan Decision 6); a re-embed switch moves it. */
  active_generation: number;
  /** The store's chunking setting, written at creation; NULL (a store created before the
   *  column) = static 800/400. Resolve through chunkingSetting.ts `resolveChunking`. */
  chunking: ChunkingSetting | null;
  expires_after: { anchor: string; days: number } | null;
  expires_at: Date | null;
  last_active_at: Date;
  created_at: Date;
}

export interface VectorStoreFileRow {
  store_id: string;
  file_id: string;
  attributes: Record<string, unknown> | null;
  chunking_strategy: Record<string, unknown> | null;
  status: string;
  last_error: Record<string, unknown> | null;
  usage_bytes: number | null;
  claimed_at: Date | null;
  attempts: number;
  batch_id: string | null;
  created_at: Date;
  credential_id: string | null;
  auth_type: string | null;
  on_behalf_of: string | null;
  /** contextStop.ts; absent on a database from before the column. */
  context_stopped?: string | null;
}

/** Who pays for a file's ingestion, stamped on its row at attach (see
 *  fileSearch/usage.ts): the attach call's credential and, on a cockpit
 *  (grounding) call only, the store's owner the service key acts for. */
export interface AttachStamp {
  credentialId?: string | null;
  authType?: string | null;
  onBehalfOf?: string | null;
}

/** Every value `vector_store_files.status` may hold — and therefore exactly
 *  the countable keys of `FileCounts` below. One list, so the store-level
 *  count path, the batch-level count path and the `?filter=` query-parameter
 *  validator cannot disagree about what a valid status is. */
export const VALID_FILE_STATUSES = ['in_progress', 'completed', 'failed', 'cancelled'] as const;
export type FileStatus = (typeof VALID_FILE_STATUSES)[number];

/**
 * Per-status counts over a set of `vector_store_files` rows — the shape both
 * `vector_store.file_counts` (grouped by `store_id`) and
 * `vector_store.file_batch.file_counts` (grouped by `batch_id`) are emitted
 * from.
 *
 * Declared HERE, in the data layer, rather than in either consumer: it was
 * originally local to `vectorStoresController.ts`, and `batches.ts` needs the
 * identical shape. Re-declaring it there would have produced two structurally
 * identical count types that agree today and drift later; importing the
 * controller's copy would have made `src/fileSearch/` depend on
 * `src/controllers/`, a direction that exists nowhere else in this codebase
 * (controllers import the repository, never the reverse). One definition, in
 * the layer that actually produces the numbers.
 */
export interface FileCounts {
  in_progress: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

export interface CreateStoreOptions {
  ownerEmail: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
  expiresAfter?: { anchor: 'last_active_at'; days: number } | null;
  isShared?: boolean;
  /** 'in_progress' when the caller is about to attach `file_ids` in the same
   *  request, 'completed' for an empty store — mirrors OpenAI's own status
   *  semantics for a freshly created store. Defaults to 'completed'. */
  initialStatus?: 'in_progress' | 'completed';
  /** An explicit store setting (validated here); left out, the installation default
   *  (`file_search.chunking`) is resolved now and written, so the store never drifts. */
  chunking?: ChunkingSetting;
}

/**
 * Creates a vector store, pinning `embedding_model`/`embedding_dim` to the
 * CURRENT configuration — a freshly created store can never itself trigger
 * `assertStoreDimension` (its pin matches by construction); the check exists
 * for stores that outlive a later configuration change.
 */
export async function createStore(opts: CreateStoreOptions): Promise<VectorStoreRow> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const config = getFileSearchConfig();
  const chunking = opts.chunking ? validateChunkingSetting(opts.chunking) : chunkingForNewStore();
  const id = newVectorStoreId();
  const { rows } = await pool.query<VectorStoreRow>(
    `INSERT INTO vector_stores
       (id, owner_email, is_shared, name, status, metadata, embedding_model, embedding_dim,
        expires_after, expires_at, chunking, last_active_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${initialExpiresAtSql('$9')}, $10, now(), now())
     RETURNING *`,
    [
      id,
      opts.ownerEmail,
      opts.isShared ?? false,
      opts.name ?? null,
      opts.initialStatus ?? 'completed',
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      config.embeddingModel,
      config.embeddingDimensions,
      opts.expiresAfter ? JSON.stringify(opts.expiresAfter) : null,
      JSON.stringify(chunking),
    ],
  );
  return rows[0];
}

/**
 * Shares a store with every user, or stops sharing it. Owner-scoped in SQL:
 * a store the acting user does not own — or that does not exist — is not
 * touched and yields `null` (map to not_found, never 403, so the answer is not
 * an existence oracle). Whether the acting user may share at all (an admin,
 * spec §5.1) is the route's check. One statement on `vector_stores` only, so
 * no lock order is involved; the next list or search reads the new value.
 */
export async function setStoreShared(storeId: string, actingEmail: string, shared: boolean): Promise<VectorStoreRow | null> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const { rows } = await pool.query<VectorStoreRow>(
    'UPDATE vector_stores SET is_shared = $3 WHERE id = $1 AND owner_email = $2 RETURNING *',
    [storeId, actingEmail, shared],
  );
  return rows[0] ?? null;
}

/**
 * Shares an owned store with a team (spec 2026-10-14 §8). Owner-scoped in SQL like
 * `setStoreShared`: a store the acting user does not own — or that does not exist — gets no share
 * and yields `null` (not_found, no existence oracle). Sharing twice is one share. Whether the
 * acting user may share with that team is the route's check.
 */
export async function shareStoreWithTeam(storeId: string, ownerEmail: string, teamId: string): Promise<VectorStoreRow | null> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  try {
    const { rows } = await pool.query<VectorStoreRow>(
      `WITH s AS (SELECT * FROM vector_stores WHERE id = $1 AND owner_email = $2),
            ins AS (INSERT INTO vector_store_team_shares (store_id, team_id, shared_by)
                    SELECT id, $3, $2 FROM s ON CONFLICT DO NOTHING)
       SELECT * FROM s`,
      [storeId, ownerEmail, teamId],
    );
    return rows[0] ?? null;
  } catch (error) {
    // The store was deleted between the read and the insert: the same answer as a missing store.
    if ((error as { code?: string })?.code === '23503') return null;
    throw error;
  }
}

/** Removes one team share; whether the caller may is the route's check. No share is a no-op. */
export async function unshareStoreFromTeam(storeId: string, teamId: string): Promise<void> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  await pool.query('DELETE FROM vector_store_team_shares WHERE store_id = $1 AND team_id = $2', [storeId, teamId]);
}

/** Every share of a deleted team (the admin calls this when it deletes the team); the count removed. */
export async function deleteTeamShares(teamId: string): Promise<number> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  return (await pool.query('DELETE FROM vector_store_team_shares WHERE team_id = $1', [teamId])).rowCount ?? 0;
}

/** The teams each store is shared with, sorted; one query for a page. A store with none is absent. */
export async function teamIdsOfStores(storeIds: string[]): Promise<Map<string, string[]>> {
  if (storeIds.length === 0) return new Map();
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const { rows } = await pool.query<{ store_id: string; team_ids: string[] }>(
    `SELECT store_id, array_agg(team_id ORDER BY team_id) AS team_ids
       FROM vector_store_team_shares WHERE store_id = ANY($1) GROUP BY store_id`,
    [storeIds],
  );
  return new Map(rows.map((r) => [r.store_id, r.team_ids]));
}

/** A store row by id regardless of owner or share (a platform admin unsharing); null when absent. */
export async function readStoreRow(storeId: string): Promise<VectorStoreRow | null> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const { rows } = await pool.query<VectorStoreRow>('SELECT * FROM vector_stores WHERE id = $1', [storeId]);
  return rows[0] ?? null;
}

/** A store as a user sees it: their own, or another owner's shared one (`owned` false). */
export type VisibleStoreRow = VectorStoreRow & { owned: boolean };

/** The largest page `listVisibleStores` serves — the list endpoints' own ceiling. */
export const MAX_VISIBLE_STORES_LIMIT = 100;

export interface ListVisibleStoresOptions {
  /** Page size the caller asked for; up to `limit + 1` rows come back so
   *  `pagination.buildPage` can compute `has_more`. */
  limit: number;
  /** Store id of the last row of the previous page. */
  after?: string | null;
  /** The caller's team ids, from this request's validation. Absent = none. */
  teamIds?: readonly string[];
}

/**
 * The stores `email` may read — their own, every one shared with all and every one shared with
 * one of `opts.teamIds` — newest first,
 * keyset-paged on `(created_at, id)`. Visibility is `storeAccessPredicateSql`,
 * the rule search already applies, so a store is listed exactly when it is
 * searchable. The cursor is resolved inside the statement under the same rule,
 * so a cursor naming a store the caller cannot see gives an empty page.
 */
export async function listVisibleStores(email: string, opts: ListVisibleStoresOptions): Promise<VisibleStoreRow[]> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  // An empty e-mail would quietly narrow to shared stores; a caller bug should throw.
  if (typeof email !== 'string' || email.length === 0) throw new Error('listVisibleStores: email must be a non-empty string');
  // The route clamps the page size (pagination.parsePageParams); anything else here is a caller bug.
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_VISIBLE_STORES_LIMIT) {
    throw new RangeError(`listVisibleStores: limit must be an integer from 1 to ${MAX_VISIBLE_STORES_LIMIT}`);
  }
  // An empty cursor means "no cursor" (as queryString reads it), not a cursor that matches nothing.
  const after = opts.after || null;
  // $1 cursor (or null), $2 email — the predicate's fixed position, $4 the caller's team ids.
  const cursor = after
    ? `AND (vs.created_at, vs.id) < (SELECT c.created_at, c.id FROM vector_stores c
                                      WHERE c.id = $1 AND ${storeAccessPredicateSql('$4', 'c')})`
    : 'AND $1::text IS NULL';
  const { rows } = await pool.query<VisibleStoreRow>(
    `SELECT vs.*, vs.owner_email = $2 AS owned
       FROM vector_stores vs
      WHERE ${storeAccessPredicateSql('$4')} ${cursor}
      ORDER BY vs.created_at DESC, vs.id DESC
      LIMIT $3`,
    [after, email, opts.limit + 1, opts.teamIds ?? []],
  );
  return rows;
}

/** One store `email` may read (own, shared with all or with one of `teamIds`), or null — a private
 *  store of another owner is indistinguishable from one that does not exist. `owned` stays the
 *  owner's alone: a team share grants read and search, never the owner-only routes. */
export async function readVisibleStore(
  email: string, storeId: string, teamIds: readonly string[] = [],
): Promise<VisibleStoreRow | null> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  if (typeof email !== 'string' || email.length === 0) throw new Error('readVisibleStore: email must be a non-empty string');
  const { rows } = await pool.query<VisibleStoreRow>(
    `SELECT vs.*, vs.owner_email = $2 AS owned FROM vector_stores vs WHERE vs.id = $1 AND ${storeAccessPredicateSql('$3')}`,
    [storeId, email, teamIds],
  );
  return rows[0] ?? null;
}
