/** Reloading a keyset-paged list as the user has it on screen. No UI5 imports. */
import type { ApiResult } from './api';

export type PageFetcher = (options: { after?: string; limit: number }) => Promise<ApiResult<any>>;

/**
 * Reloads the first `shown` rows of a list the gateway pages by an id cursor (`after` = the last id of the page before,
 * at most `maxPage` rows per request). Asks for one page when it covers the window, else follows `last_id` page by page,
 * so a list the user paged past the gateway's largest page keeps all its rows. A job that arrived meanwhile only enters
 * at the top; a cursor never repeats or skips a row. The answer has the shape of a single page.
 */
export async function loadWindow(fetchPage: PageFetcher, shown: number, pageSize: number, maxPage: number): Promise<ApiResult<any>> {
  const want = Math.max(pageSize, shown);
  const data: any[] = [];
  const seen = new Set<string>();
  let hasMore = false;
  let lastId = '';
  let result: ApiResult<any> | null = null;
  let restarted = false;
  do {
    const options: { after?: string; limit: number } = { limit: Math.min(maxPage, want - data.length) };
    if (lastId) options.after = lastId;
    result = await fetchPage(options);
    if (!result.ok) return result;
    const page: any[] = Array.isArray(result.body?.data) ? result.body.data : [];
    // An empty last page right after a cursor: the cursor's row is gone. Start again from the top, once.
    if (lastId && page.length === 0 && result.body?.has_more !== true && !restarted) {
      restarted = true;
      data.length = 0;
      seen.clear();
      lastId = '';
      hasMore = true;
      continue;
    }
    for (const entry of page) {
      const id = entry?.id;
      if (id !== undefined && seen.has(id)) continue;
      if (id !== undefined) seen.add(id);
      data.push(entry);
    }
    hasMore = result.body?.has_more === true;
    lastId = String(result.body?.last_id || '');
    // No cursor to continue from: stop rather than ask for the first page again.
    if (hasMore && !lastId) hasMore = false;
  } while (hasMore && data.length < want);
  return { ...result, body: { ...result.body, data, has_more: hasMore, last_id: lastId || null } };
}

export const POLL_BASE_MS = 3000;
export const POLL_MAX_MS = 15000;

/** The next refresh delay: back to the base after any change, doubling (up to the maximum) while nothing changed. */
export function nextPollInterval(current: number, changed: boolean): number {
  return changed ? POLL_BASE_MS : Math.min(POLL_MAX_MS, Math.max(POLL_BASE_MS, current) * 2);
}

/** True while the browser tab is in the background: a refresh then waits for the tab to come back. */
export function documentHidden(): boolean {
  return (globalThis as any).document?.hidden === true;
}

export interface HeadRefresh { ok: true; rows: any[]; hasMore: boolean; lastId: string }

/**
 * Refreshes the top of a list the user has paged through. Only the rows down to the deepest one still active, plus one
 * page, are asked for again (a long list costs one request per tick, not one per loaded page); the already loaded tail
 * is kept as it is, continued after the last refreshed row (so a job that arrived meanwhile shifts rows but neither
 * repeats nor drops one) and keeps its cursor. `everything` (after a user action that can wake a finished job anywhere
 * in the list) asks for all loaded rows once. `rows` and the result are mapped rows with `id` and `active`.
 */
export async function refreshHead(
  fetchPage: PageFetcher, rows: any[], cursor: { hasMore: boolean; lastId: string },
  toRow: (entry: any) => any, pageSize: number, maxPage: number, everything = false
): Promise<HeadRefresh | ApiResult<any>> {
  let deepest = -1;
  rows.forEach((row, i) => { if (row.active) deepest = i; });
  const need = everything ? Math.max(pageSize, rows.length) : Math.min(rows.length, Math.max(pageSize, deepest + 1 + pageSize));
  const result = await loadWindow(fetchPage, need, pageSize, maxPage);
  if (!result.ok) return result;
  const head: any[] = (result.body.data as any[]).map(toRow);
  const ids = new Set(head.map((row) => row.id));
  const at = head.length ? rows.findIndex((row) => row.id === head[head.length - 1].id) : -1;
  const tail = result.body.has_more === true && at >= 0 ? rows.slice(at + 1).filter((row) => !ids.has(row.id)) : [];
  if (tail.length) return { ok: true, rows: head.concat(tail), hasMore: cursor.hasMore, lastId: cursor.lastId };
  return { ok: true, rows: head, hasMore: result.body.has_more === true, lastId: String(result.body.last_id || '') };
}
