// A file's context stop (vector_store_files.context_stopped, research §5.5): the context writer
// stopped before it tried every chunk of the file because the file reached its time ('deadline')
// or token ('budget') limit, so some of its chunks keep no written context. Recorded per file by
// every ingestion and every re-chunk; the cockpit shows the file as "context incomplete".
//
// A token-limit stop is final at once: the fill would spend the same budget and stop at the same
// place, so the fill does not count its chunks as missing. A time-limit stop is retried once by the
// fill — a re-chunk to the store's own contextual setting, offered while chunks lack their context
// (rechunk.ts chunksWithoutContext) — with a fresh deadline (a re-chunk item gets its own budget).
// One that stops again is recorded as 'deadline_retried' and is final too, so the fill cannot loop.
// Any re-chunk to the setting the stop was recorded under counts as that one retry (a re-extract
// too); a re-chunk to another setting, or a new ingestion, is a first try again.
//
// The writer's other stops are not recorded here: 'failing' and 'no_deployment' are outages a later
// fill can mend (their chunks keep counting), 'aborted' never commits.
import type { ContextWriterStop } from './contextWriter';

export type RecordedContextStop = 'deadline' | 'budget' | 'deadline_retried';

/** The stops the fill leaves alone: their chunks do not count as missing contexts. */
export const FINAL_CONTEXT_STOPS: readonly RecordedContextStop[] = ['budget', 'deadline_retried'];

/**
 * The value one chunking of a file records. `retry`: this chunking re-chunked the file to the
 * setting its recorded stop (`previous`, non-null) was made under — the fill's retry.
 */
export function recordedContextStop(
  stopped: ContextWriterStop | undefined, previous: string | null | undefined, retry: boolean,
): RecordedContextStop | null {
  if (stopped === 'budget') return 'budget';
  if (stopped !== 'deadline') return null;
  return retry && previous ? 'deadline_retried' : 'deadline';
}
