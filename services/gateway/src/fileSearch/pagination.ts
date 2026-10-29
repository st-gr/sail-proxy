/**
 * Cursor pagination helpers shared by the file_search HTTP list endpoints
 * (`GET /files`, and later `GET /vector_stores` etc). Keyset pagination on
 * `(created_at, id)` — never `LIMIT/OFFSET` — because offset pagination
 * produces duplicates and gaps under concurrent insertion, which is exactly
 * the condition file ingestion creates.
 */

import { firstValue, queryString } from '../utils/queryParam';

export type PageOrder = 'asc' | 'desc';

export interface PageParams {
  limit: number;
  order: PageOrder;
  after: string | null;
  before: string | null;
}

export interface PageLimits {
  defaultLimit: number;
  maxLimit: number;
}

const MIN_LIMIT = 1;
/** OpenAI's vector-store lists: default 20, at most 100. */
const DEFAULT_PAGE_LIMITS: PageLimits = { defaultLimit: 20, maxLimit: 100 };

/** OpenAI's `GET /files`: "Limit can range between 1 and 10,000, and the default is 10,000"
 *  (openai-python types/file_list_params.py). A file row is a few hundred bytes on the wire. */
export const FILES_PAGE_LIMITS: Readonly<PageLimits> = Object.freeze({ defaultLimit: 10000, maxLimit: 10000 });

/**
 * Parses `limit`/`order`/`after`/`before` off an Express `req.query`-shaped
 * object. Never throws: malformed input degrades to the documented default
 * rather than a 500, matching OpenAI's own list-endpoint behavior. `limits`
 * are the list's default and maximum page size (the vector-store lists' unless given).
 */
export function parsePageParams(query: Record<string, unknown>, limits: PageLimits = DEFAULT_PAGE_LIMITS): PageParams {
  const rawLimit = firstValue(query?.limit);
  const parsed = typeof rawLimit === 'string' || typeof rawLimit === 'number' ? Number(rawLimit) : NaN;
  const limit = Number.isFinite(parsed)
    ? Math.min(limits.maxLimit, Math.max(MIN_LIMIT, Math.trunc(parsed)))
    : limits.defaultLimit;

  const rawOrder = firstValue(query?.order);
  const order: PageOrder = rawOrder === 'asc' ? 'asc' : 'desc';

  return {
    limit,
    order,
    after: queryString(query?.after),
    before: queryString(query?.before),
  };
}

export interface Page<T extends { id: string }> {
  data: T[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

/**
 * Builds a page from rows fetched with `LIMIT limit + 1` (the caller's job —
 * this function just trims). Taking one extra row is what makes `has_more`
 * correct without a second `COUNT` query: if more rows came back than fit on
 * the page, there was at least one more row beyond it.
 */
export function buildPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const has_more = rows.length > limit;
  const data = has_more ? rows.slice(0, limit) : rows;
  return {
    data,
    has_more,
    first_id: data.length > 0 ? data[0].id : null,
    last_id: data.length > 0 ? data[data.length - 1].id : null,
  };
}
