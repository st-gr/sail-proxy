// Shared by the two work queues the ingest worker drains: ingestion
// (`vector_store_files` rows, ingestWorker.ts) and re-embedding
// (`fs_reembed_items` rows, reembed.ts). Both lease a claimed row for the same
// time and persist a failed attempt's error the same sanitised way.

// Bound as a parameter (never interpolated) into the claim and zombie-reaper SQL
// of both queues (ingestWorker.ts, reembed.ts), each as `$N::int * interval '1 minute'` —
// Postgres can't parameterise an interval literal directly, but it can
// multiply one. Kept as one named constant so the doc comment and every
// query can't silently drift apart.
export const LEASE_MINUTES = 15;

// The time one file's processing may take from its start, extraction included: below the
// lease, so a file still being worked on is never re-claimed by a second worker. Ingestion
// (ingestWorker.ts processOne) and the re-chunk of one file (reembedWorker.ts) share it.
export const PROCESS_BUDGET_MS = 12 * 60 * 1000;

/**
 * A claimed item whose attempt failed only because the file_search pool was busy
 * (FileSearchBusyError) is handed back WITHOUT spending an attempt: `attempts` returns
 * to its value before the claim, and the claim is backdated so the item is claimable
 * again after this many seconds instead of at once (the pool is busy; an immediate
 * retry would only add to it). The SET fragment every queue uses; $1 = this delay,
 * $2 = LEASE_MINUTES.
 */
export const BUSY_RETRY_SECONDS = 30;
export const BUSY_HANDBACK_SET =
  `attempts = GREATEST(attempts - 1, 0),
   claimed_at = now() - ($2::int * interval '1 minute') + ($1::int * interval '1 second')`;

/**
 * `last_error` of a busy handback: $5, the handback's error. When $5 carries no `memory_handbacks` (a pool-busy or
 * stopping handback) the row's count is kept, so such a handback between two memory timeouts never resets it and
 * MAX_MEMORY_HANDBACKS (memoryBudget.ts) still bounds the unspent memory handbacks.
 */
export const BUSY_HANDBACK_LAST_ERROR_SQL =
  `CASE WHEN NOT ($5::jsonb ? 'memory_handbacks') AND jsonb_typeof(last_error -> 'memory_handbacks') = 'number'
        THEN $5::jsonb || jsonb_build_object('memory_handbacks', last_error -> 'memory_handbacks')
        ELSE $5::jsonb END`;

// Bounds how much of a persisted `last_error.message` a maintainer keeps —
// generous for a human-readable summary, small next to a raw stack trace.
const MAX_LAST_ERROR_MESSAGE_LENGTH = 500;

/**
 * Sanitizes an error message before it is persisted to `vector_store_files.
 * last_error` (ingestWorker.ts's `handleFailure`; reembed.ts persists a
 * re-embed item's `fs_reembed_items.last_error` the same way) and served back over `GET
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
export function sanitizeErrorMessage(message: string): string {
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

export function serializeError(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) {
    return { message: sanitizeErrorMessage(error.message), name: error.name };
  }
  return { message: sanitizeErrorMessage(String(error)) };
}
