// The session settings every recall runs with, and the probe and memory that decide whether the pgvector
// ones are sent (split out of repository.ts, which re-exports the public ones).
import type { PoolClient } from 'pg';
import { getDefaultLogger } from '@libs/logger';
import { forgetAnnIndexCheck } from './annPath';
import { driverErrorCode } from './recallErrors';

const logger = getDefaultLogger();

// pgvector's HNSW scan returns at most hnsw.ef_search neighbours (default 40)
// BEFORE the store, owner, generation and attribute predicates filter them, and
// the index is shared by every store — so a recall served from the index could
// come back with far fewer than the 50 candidates it asked for. Today's plans
// do not use the index for recall (each arm's ORDER BY carries a tiebreaker the
// index cannot supply, so Postgres keeps an exact top-N — EXPLAINed on
// pg16/pgvector 0.8.6, test/fileSearch/integration/recallShape.test.ts); these
// settings are what keeps recall whole should a plan ever pick it.
const EF_SEARCH_MIN = 100;
const EF_SEARCH_MAX = 1000; // pgvector's upper bound for hnsw.ef_search

export function recallEfSearch(limit: number): number {
  return Math.min(Math.max(limit * 2, EF_SEARCH_MIN), EF_SEARCH_MAX);
}

// hnsw.iterative_scan (pgvector 0.8+) lets the scan continue past ef_search
// when the post-filter discarded too much. Setting it on an older pgvector is
// an error once the library has loaded ("hnsw" is a reserved prefix), so the
// installed version is probed once and the answer cached. A probe that fails
// is not cached and answers "unsupported", so search never fails for it.
let iterativeScanProbe: Promise<boolean> | null = null;
export let recallSettingsRejected = false;

function versionAtLeast(version: string | undefined, min: number[]): boolean {
  if (typeof version !== 'string') return false;
  const parts = version.split('.').map((p) => parseInt(p, 10));
  for (let i = 0; i < min.length; i += 1) {
    const v = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (v !== min[i]) return v > min[i];
  }
  return true;
}

export function supportsIterativeScan(client: PoolClient): Promise<boolean> {
  if (!iterativeScanProbe) {
    iterativeScanProbe = client
      .query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
      .then(({ rows }) => versionAtLeast(rows[0]?.extversion, [0, 8, 0]))
      .catch(() => {
        iterativeScanProbe = null;
        return false;
      });
  }
  return iterativeScanProbe;
}

// The SQLSTATEs that mean "this server does not support the setting":
// undefined_object (unrecognized configuration parameter) and
// invalid_parameter_value. Only these are remembered; a cancel, a timeout or
// a lost connection says nothing about the server's support.
const SETTING_UNSUPPORTED_CODES = new Set(['42704', '22023']);

/**
 * Applies the recall session settings inside the caller's open transaction
 * (SET LOCAL ends with it). The pgvector settings are wrapped in a savepoint so
 * a failing setting costs the setting, never the search. A rejection meaning
 * "unsupported" is remembered and they are not tried again in this process;
 * any other failure skips them for this call only. `jit = off` is sent on its
 * own first, every time.
 *
 * `jit = off`: recall is a short statement whose cost estimate can still cross
 * `jit_above_cost` (the HNSW index's costing does), and compiling it then costs
 * more than running it — 12–15 ms per query in the 2026-10-06 spike.
 */
export async function applyRecallSettings(client: PoolClient, limit: number, iterativeScan: boolean): Promise<void> {
  // On its own, before the savepoint: a rejected pgvector setting rolls back to
  // the savepoint and may latch the batch off, and neither may take JIT's
  // setting with it. `jit` is a core setting on every Postgres pgvector runs on.
  await client.query('SET LOCAL jit = off');
  if (recallSettingsRejected) return;
  // Both values are this module's own constants and a validated integer —
  // SET takes no bind parameters.
  const settings = [`SET LOCAL hnsw.ef_search = ${recallEfSearch(limit)}`];
  // strict_order, not relaxed_order (ruling R5): if a plan ever reads the index,
  // the rows still come back in exact distance order for ROW_NUMBER and LIMIT.
  if (iterativeScan) settings.push("SET LOCAL hnsw.iterative_scan = 'strict_order'");
  try {
    await client.query(`SAVEPOINT recall_settings; ${settings.join('; ')}; RELEASE SAVEPOINT recall_settings`);
  } catch (error: any) {
    await client.query('ROLLBACK TO SAVEPOINT recall_settings');
    const code = driverErrorCode(error);
    if (SETTING_UNSUPPORTED_CODES.has(code)) {
      recallSettingsRejected = true;
      logger.warn('FileSearchRepository',
        `Recall runs without its pgvector settings; the server rejected them (${code})`);
    } else {
      logger.warn('FileSearchRepository', `Recall skipped its pgvector settings once (${code})`);
    }
  }
}

/** Test-only: forget the cached pgvector probe, any rejected settings and the approximate-search index check. */
export function __resetRecallSettingsForTests(): void {
  iterativeScanProbe = null;
  recallSettingsRejected = false;
  forgetAnnIndexCheck();
}
