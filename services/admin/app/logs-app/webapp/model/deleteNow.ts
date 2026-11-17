/**
 * What the page says and does after "Delete now" has asked the service to empty the stored log.
 * No UI5 imports: the controller helper passes the bundle's translator and a number formatter.
 */
import type { ApiResult, Translator } from './api';
import { countText } from './listTexts';

export interface DeleteOutcome {
  ok: boolean;
  /** The success message with its count, or the service's own message on a failure. */
  text: string;
  /** A success empties and reloads the list; a failure leaves it as it is. */
  reloadList: boolean;
}

/** What "Delete now" empties: the stored log, the payload traces (light and raw), or both. */
export type DeleteWhat = 'log' | 'traces' | 'all';

/** The text keys' part after "deleteDone" for each choice: the log's entries, the traces, or both. */
const DONE_PREFIX: Record<DeleteWhat, string> = { log: 'deleteDone', traces: 'deleteDoneTraces', all: 'deleteDoneAll' };

/** What deleteStoredLogs answers: the log entries and the traces (requests) it removed, and their sum. */
export interface DeleteCounts { deleted: number; logEntries: number; traces: number }

const countOf = (body: unknown, field: 'logEntries' | 'traces'): number | null => {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * One, none, or many of what was deleted; both name the log entries and the traces apart
 * ("Deleted: 20 log entries, 1 trace."). A count that did not come back is not guessed.
 */
export function deleteDoneText(body: unknown, what: DeleteWhat, t: Translator, format: (n: number) => string): string {
  const prefix = DONE_PREFIX[what] ?? DONE_PREFIX.log;
  const logEntries = countOf(body, 'logEntries');
  const traces = countOf(body, 'traces');
  if (what === 'all') {
    if (logEntries === null || traces === null) return t(`${prefix}Unknown`);
    if (logEntries + traces === 0) return t(`${prefix}None`);
    return t(prefix, [countText(logEntries, 'countLogEntriesOne', 'countLogEntries', t, format), countText(traces, 'countTracesOne', 'countTraces', t, format)]);
  }
  const count = what === 'traces' ? traces : logEntries;
  if (count === null) return t(`${prefix}Unknown`);
  if (count === 0) return t(`${prefix}None`);
  return count === 1 ? t(`${prefix}One`) : t(`${prefix}Many`, [format(count)]);
}

export function deleteOutcome(result: ApiResult<DeleteCounts>, what: DeleteWhat, t: Translator, format: (n: number) => string): DeleteOutcome {
  if (result.ok) return { ok: true, text: deleteDoneText(result.body, what, t, format), reloadList: true };
  return { ok: false, text: result.error?.message ?? '', reloadList: false };
}

/** Whether a delete emptied the payload traces, so that the traces list reads again. */
export function tracesTouched(what: DeleteWhat | undefined): boolean {
  return what === 'traces' || what === 'all';
}

/** Whether a delete emptied the stored gateway log, so that the Gateway log reads again. */
export function logTouched(what: DeleteWhat | undefined): boolean {
  return what === 'log' || what === 'all';
}

/** What made the list read again: the person (search, level, range, Refresh, Live), a poll of Live, or the delete itself. */
export type ListTrigger = 'user' | 'poll' | 'delete';

/** The success message stays for a poll and for the delete's own reload; anything else the person does with the list hides it. */
export function deleteResultAfter(current: string, trigger: ListTrigger): string {
  return trigger === 'user' ? '' : current;
}

/**
 * The remembered row keys that are still shown (the journey's check after a confirmed delete; a plain
 * JavaScript copy is in webapp/test/integration/pages/Logs.js).
 */
export function shownAfter(remembered: string[], shown: string[]): string[] {
  const now = new Set(shown);
  return remembered.filter((key) => now.has(key));
}

/** A row as the journey remembers it: its key and its time (ms). */
export interface KeyedRow { key: string; at: number }

/**
 * After a cancelled delete: the remembered rows that are missing. A remembered row that is not shown
 * is missing, unless the view is full (it holds `limit` rows, the app's DEFAULT_LIMIT) and the row is
 * not newer than the oldest row shown now: only then can newer entries have pushed it out. With fewer
 * rows than the limit, every remembered row must still be shown. The journey's plain JavaScript copy
 * is in webapp/test/integration/pages/Logs.js (iSeeNothingDeleted).
 */
export function missingWithinWindow(remembered: KeyedRow[], shown: KeyedRow[], limit: number): string[] {
  const full = shown.length >= limit;
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of shown) if (row.at < oldest) oldest = row.at;
  const now = new Set(shown.map((row) => row.key));
  return remembered.filter((row) => !now.has(row.key) && !(full && row.at <= oldest)).map((row) => row.key);
}
