// REEMBED FAILURES — the files a re-embed job could not re-embed, for the
// cockpit's job page. Nothing here is HTTP-aware and nothing here checks who
// asks: the owner's route resolves the job owner-scoped first, the admin's
// route sits behind the groundingAdmin guard (plan review focus 5).
//
// WHAT IT NEVER SELECTS: chunk text, or any part of `last_error` but the
// sanitised `message` the worker stored (serializeError). The integration
// suite pins the row keys.
//
// PAGING: keyset on the items' primary key `(job_id, file_id)`, ascending, so a
// bulk parent's failures come grouped by child (one child per store). `after`
// is the previous page's `last_id`, `<job_id>/<file_id>`. Returns up to
// `limit + 1` rows; the caller trims with `pagination.buildPage`.
import type { Pool } from 'pg';
import { getPool } from './db';
import { AdminQueryInputError, MAX_ADMIN_PAGE_LIMIT } from './admin';

export interface ReembedFailureRow {
  /** `<job_id>/<file_id>`: the paging cursor. */
  id: string;
  /** The `reembed_store` job the item belongs to (the child, for a bulk parent). */
  job_id: string;
  store_id: string;
  store_name: string | null;
  file_id: string;
  /** Null once the file was deleted. */
  filename: string | null;
  last_error: { message: string | null };
  attempts: number;
}

export interface ListReembedFailuresOptions {
  limit: number;
  after?: string | null;
}

const MAX_CURSOR_LENGTH = 200;
const NUL_BYTE = String.fromCharCode(0);

function requirePool(): Pool {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  return pool;
}

/** `<job_id>/<file_id>`, or an AdminQueryInputError (a 400). */
function parseCursor(after: string): [string, string] {
  const slash = after.indexOf('/');
  if (after.length > MAX_CURSOR_LENGTH || after.includes(NUL_BYTE) || slash < 1 || slash === after.length - 1) {
    throw new AdminQueryInputError('after must be <job_id>/<file_id>.');
  }
  return [after.slice(0, slash), after.slice(slash + 1)];
}

/**
 * The failed items of re-embed job `jobId`: its own items for a `reembed_store`,
 * its children's for a `reembed_bulk` (one statement covers both; a file batch
 * has no items and answers none). The caller has already decided the job may be
 * read.
 */
export async function listReembedFailures(jobId: string, opts: ListReembedFailuresOptions): Promise<ReembedFailureRow[]> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_ADMIN_PAGE_LIMIT) {
    throw new AdminQueryInputError(`limit must be an integer from 1 to ${MAX_ADMIN_PAGE_LIMIT}.`);
  }
  const params: unknown[] = [jobId];
  let cursor = '';
  if (opts.after !== undefined && opts.after !== null) {
    const [afterJob, afterFile] = parseCursor(opts.after);
    params.push(afterJob, afterFile);
    cursor = 'AND (i.job_id, i.file_id) > ($2, $3)';
  }
  params.push(opts.limit + 1);
  const { rows } = await requirePool().query(
    `SELECT i.job_id || '/' || i.file_id AS id, i.job_id, i.store_id, s.name AS store_name, i.file_id, f.filename,
            jsonb_build_object('message', i.last_error->>'message') AS last_error, i.attempts
       FROM fs_reembed_items i
       LEFT JOIN vector_stores s ON s.id = i.store_id
       LEFT JOIN fs_files f ON f.id = i.file_id
      WHERE i.status = 'failed'
        AND i.job_id IN (SELECT j.id FROM fs_jobs j
                          WHERE j.kind = 'reembed_store' AND (j.id = $1 OR j.parent_id = $1))
        ${cursor}
      ORDER BY i.job_id, i.file_id
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}
