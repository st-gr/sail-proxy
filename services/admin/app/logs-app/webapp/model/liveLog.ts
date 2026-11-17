/**
 * The live view's list of log entries. No UI5 imports, so it runs under jest.
 *
 * Several gateway processes write to the log, each with its own `seq`, and their batches arrive up to
 * a few seconds apart, or much later (a redelivery): an entry can arrive after a newer one is already
 * shown. So an entry is known by its `ID` (unique), the list is kept sorted by time, then `seq`, then
 * `ID`, and each poll follows the time of STORING on the admin's clock (`storedAt`), not the time an
 * entry was written: it asks for what was stored after its cursor, the admin's time of the previous
 * read minus an overlap; what is already shown is dropped from the answer. A poll that finds nothing
 * still moves its cursor, so its query stays bounded by the index on storedAt.
 */

export interface Entry {
  ID: string;
  loggedAt: string;
  /** Edm.Int64: OData V4 sends it as text. */
  seq: string | number | null;
  /** When the admin stored the entry, on its clock; null for a row stored before the column existed. */
  storedAt?: string | null;
  [field: string]: unknown;
}

export type Order = 'newestLast' | 'newestFirst';
export interface MergeResult<T extends Entry> { entries: T[]; added: number; dropped: number }

export const DEFAULT_LIMIT = 2000;
export const POLL_OVERLAP_MS = 5000;

function seqOf(entry: Entry): bigint {
  const text = String(entry.seq ?? '0').trim();
  return /^-?\d+$/.test(text) ? BigInt(text) : BigInt(0);
}

/** Oldest first: by time, then seq as an integer, then ID. */
export function compareEntries(a: Entry, b: Entry): number {
  const time = Date.parse(a.loggedAt) - Date.parse(b.loggedAt);
  if (time !== 0 && !Number.isNaN(time)) return time;
  const sa = seqOf(a);
  const sb = seqOf(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.ID < b.ID ? -1 : a.ID > b.ID ? 1 : 0;
}

/**
 * The shown list with the fetched entries merged in: no ID twice, sorted (oldest first for newest
 * last, newest first otherwise), at most `limit` entries, keeping the newest. `added` counts the
 * fetched entries that are now shown, `dropped` the entries the limit took out of the view.
 */
export function mergeEntries<T extends Entry>(shown: T[], fetched: T[], order: Order, limit: number): MergeResult<T> {
  const known = new Set(shown.map((entry) => entry.ID));
  const fresh: T[] = [];
  for (const entry of fetched) {
    if (known.has(entry.ID)) continue;
    known.add(entry.ID);
    fresh.push(entry);
  }
  const all = [...shown, ...fresh].sort(compareEntries);
  const kept = all.length > limit ? all.slice(all.length - limit) : all;
  const keptIds = new Set(kept.map((entry) => entry.ID));
  const added = fresh.filter((entry) => keptIds.has(entry.ID)).length;
  return { entries: order === 'newestLast' ? kept : kept.reverse(), added, dropped: all.length - kept.length };
}

export function mergeNewEntries<T extends Entry>(shown: T[], fetched: T[], order: Order, limit: number): T[] {
  return mergeEntries(shown, fetched, order, limit).entries;
}

/** What a read of the entries gave: whether it worked, the answer's Date header and its rows. */
export interface ReadOutcome { ok: boolean; serverDate?: string | null; entries?: Entry[] }

/**
 * The cursor of the next poll: the admin's time of this read (the answer's Date header) minus the
 * overlap; without a usable header the greatest storedAt among the rows read minus the overlap;
 * otherwise, and after a failed read, the previous cursor (null: no cursor yet).
 */
export function nextPollCursor(previous: string | null, read: ReadOutcome): string | null {
  if (!read.ok) return previous;
  let at = read.serverDate ? Date.parse(read.serverDate) : Number.NaN;
  if (Number.isNaN(at)) {
    at = Number.NEGATIVE_INFINITY;
    for (const entry of read.entries ?? []) {
      const stored = entry.storedAt ? Date.parse(entry.storedAt) : Number.NaN;
      if (stored > at) at = stored;
    }
  }
  return Number.isFinite(at) ? new Date(at - POLL_OVERLAP_MS).toISOString() : previous;
}

/** A poll that returned as many rows as it asked for may have cut off older new entries: the view reloads. */
export function pollWasCut(fetched: number, asked: number): boolean {
  return fetched >= asked;
}

/**
 * The first visible row that keeps the same entry at the top of the view after the list changed:
 * rows dropped or inserted above it move it, and the table must follow so the reader keeps their
 * place. 0 when the entry is gone or the view was at the top.
 */
export function anchoredFirstRow(before: Entry[], firstVisibleRow: number, after: Entry[]): number {
  if (firstVisibleRow <= 0) return 0;
  const anchor = before[firstVisibleRow];
  if (!anchor) return 0;
  const at = after.findIndex((entry) => entry.ID === anchor.ID);
  return at === -1 ? 0 : at;
}
