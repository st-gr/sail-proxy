// Store activity after a search, and the file_search tool's pre-turn access guard (split out of
// repository.ts, which re-exports them).
import { getPool } from './db';
import { RECOMPUTE_EXPIRES_AT_SQL } from './stores';
import { storeAccessPredicateSql } from './recallSql';
import { assertStoreDimension, assertStoreNotExpired } from './storeValidation';

// ---------------------------------------------------------------------------
// Search (Task 12)
// ---------------------------------------------------------------------------

/**
 * Touches `last_active_at` (and, via `RECOMPUTE_EXPIRES_AT_SQL`, slides
 * `expires_at` along with it) for every store in `storeIds`, in one grouped
 * UPDATE rather than one per store. Called by `search.ts`'s
 * `searchVectorStores` after a search completes — the design spec requires
 * `last_active_at` to be touched "on every search and every file mutation",
 * since `expires_after.anchor` is `'last_active_at'`.
 *
 * A plain UPDATE (not a transaction with an explicit `FOR UPDATE`): it takes
 * an ordinary row-level write lock on each matched `vector_stores` row for
 * the duration of this one statement, which is enough to serialize safely
 * against the expiry sweeper's own `FOR UPDATE` re-check (see
 * `expirySweeper.ts`) without risking a lock-order deadlock — this function
 * only ever touches the single `vector_stores` table, so there is no second
 * table whose lock order could cycle against it.
 */
export async function touchStoreActivity(storeIds: string[]): Promise<void> {
  if (storeIds.length === 0) return;
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `UPDATE vector_stores SET last_active_at = now(), expires_at = ${RECOMPUTE_EXPIRES_AT_SQL} WHERE id = ANY($1)`,
    [storeIds],
  );
}

// ---------------------------------------------------------------------------
// The `file_search` tool's pre-turn access guard (Task 6)
// ---------------------------------------------------------------------------

/**
 * Thrown for a `file_search` TOOL request the caller got wrong — an empty
 * `vector_store_ids`, or an id the caller may not read. Callers map this to
 * HTTP 400 with `code: 'invalid_request_error'`.
 *
 * Lives in the data layer, as the other repository-level input errors do
 * (`RecallInputError`, `AttributeValidationError`), rather than in
 * `pluginSupport/fileSearch/descriptor.ts` where the tool layer also throws it:
 * `assertStoresAccessible` below is its first thrower, and a descriptor-owned
 * class would make `src/fileSearch/` (core) import from `src/plugins/` — the
 * wrong direction, and a cycle, since the descriptor imports this module.
 */
export class ToolRequestError extends Error {
  readonly status = 400;
  readonly code = 'invalid_request_error';
  constructor(message: string) {
    super(message);
    this.name = 'ToolRequestError';
  }
}

/**
 * Refuses a `file_search` tool request that names a vector store the caller
 * cannot read, or cannot search, BEFORE the turn opens. Throws
 * `ToolRequestError` (400) naming the first inaccessible id,
 * `StoreExpiredError` (409) for an accessible-but-expired store, or
 * `StoreDimensionMismatchError` (409) for one whose pinned `embedding_dim`
 * has drifted from the live configuration; resolves silently when every id is
 * readable and searchable.
 *
 * This is the one honest moment in the whole tool flow. Once the response
 * stream is live, a typo'd `vector_store_id` and an empty corpus are
 * indistinguishable to the caller forever — both are simply "no passages
 * found" — so a mistake that is not caught here is never reported at all.
 *
 * EVERY PRE-CONDITION `searchVectorStores` ENFORCES MUST BE CHECKED HERE TOO,
 * for that same reason: anything it refuses but this admits becomes a turn
 * that opens and then fails on every single call, with nothing the caller can
 * see. That is not a general principle to apply loosely — it is a mechanical
 * one. The per-store loop below mirrors `search.ts`'s own, in the same order,
 * calling the same two assertions on the same three columns its sibling query
 * selects (`id`, `status`, `embedding_dim`). If a third pre-condition is ever
 * added there, it belongs here too, and
 * `storeAccessGuard.test.ts`'s "agrees with searchVectorStores about which
 * stores are usable" is what will say so: it compares the two functions'
 * failures field for field against a real database, on every axis.
 *
 * Both 409s keep their own status rather than being folded into the 400: an
 * expired or dimension-drifted store is a real, actionable state of a store
 * the caller demonstrably may read — not a malformed request — and the
 * distinction leaks nothing, because the ownership check has already passed
 * by the time either can be raised.
 *
 * NOT AN EXISTENCE ORACLE: an unknown id and a live id owned by someone else
 * produce the SAME error, with the same status and the same wording. A
 * distinct status (403 for "exists but not yours", 404 for "no such store")
 * would let any caller enumerate which store ids exist on the deployment by
 * reading the difference. `searchVectorStores` already makes this exact
 * choice — see `SearchStoreNotFoundError`'s "404, never 403" note in
 * `search.ts` — and this must not diverge from it.
 *
 * Ownership is `storeAccessPredicateSql`, the same fragment
 * `recallCandidates` ANDs into both its CTEs — not a second rule that happens
 * to agree today. `teamIds` are the caller's teams from this request's
 * validation; none (the default) grants no team share.
 *
 * `ownerEmail` may be undefined (`PrepareCtx` types it so): the predicate then
 * matches shared stores (and team-shared ones when `teamIds` are given) only, which is fail-safe — an unowned private store is
 * rejected rather than admitted. It is not treated as an error here because a
 * request that reaches the model with only shared stores is still a coherent
 * request; `recallCandidates` throws on an empty `ownerEmail` later if the
 * search itself is ever attempted with one.
 */
export async function assertStoresAccessible(
  storeIds: string[],
  ownerEmail: string | undefined,
  teamIds: readonly string[] = [],
): Promise<void> {
  if (storeIds.length === 0) return;
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  // The same three columns `search.ts`'s sibling ownership query selects, for
  // the same two assertions below.
  const { rows } = await pool.query<{ id: string; status: string; embedding_dim: number }>(
    `SELECT vs.id, vs.status, vs.embedding_dim FROM vector_stores vs
      WHERE vs.id = ANY($1) AND ${storeAccessPredicateSql('$3')}`,
    [storeIds, ownerEmail ?? null, teamIds],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = storeIds.find((id) => !found.has(id));
  if (missing !== undefined) {
    // Deliberately the same message for "no such store" and "not yours" —
    // see the NOT AN EXISTENCE ORACLE note above.
    throw new ToolRequestError(`Unknown vector store: ${missing}`);
  }
  // Strictly AFTER the accessibility check, never interleaved with it: a 409
  // is only ever raised for a store the caller has already proved it may read,
  // so it can never become the oracle the 400 above is careful not to be.
  // (`rows` contains only readable stores by construction, so this holds
  // whatever order the caller listed its ids in.)
  //
  // Assertion order matches `search.ts`'s loop exactly — expiry, then
  // dimension — so a store that is BOTH expired and drifted fails identically
  // in both places rather than by whichever check happened to run first.
  for (const store of rows) {
    assertStoreNotExpired(store);
    // eslint-disable-next-line no-await-in-loop
    await assertStoreDimension(store);
  }
}
