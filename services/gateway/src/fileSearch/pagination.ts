/**
 * Cursor pagination helpers shared by the file_search HTTP list endpoints
 * (`GET /files`, and later `GET /vector_stores` etc). Keyset pagination on
 * `(created_at, id)` — never `LIMIT/OFFSET` — because offset pagination
 * produces duplicates and gaps under concurrent insertion, which is exactly
 * the condition file ingestion creates.
 */

export type PageOrder = 'asc' | 'desc';

export interface PageParams {
  limit: number;
  order: PageOrder;
  after: string | null;
  before: string | null;
}

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

function firstValue(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function stringOrNull(v: unknown): string | null {
  const s = firstValue(v);
  return typeof s === 'string' && s.length > 0 ? s : null;
}

/**
 * Parses `limit`/`order`/`after`/`before` off an Express `req.query`-shaped
 * object. Never throws: malformed input degrades to the documented default
 * rather than a 500, matching OpenAI's own list-endpoint behavior.
 */
export function parsePageParams(query: Record<string, unknown>): PageParams {
  const rawLimit = firstValue(query?.limit);
  const parsed = typeof rawLimit === 'string' || typeof rawLimit === 'number' ? Number(rawLimit) : NaN;
  const limit = Number.isFinite(parsed)
    ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(parsed)))
    : DEFAULT_LIMIT;

  const rawOrder = firstValue(query?.order);
  const order: PageOrder = rawOrder === 'asc' ? 'asc' : 'desc';

  return {
    limit,
    order,
    after: stringOrNull(query?.after),
    before: stringOrNull(query?.before),
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
