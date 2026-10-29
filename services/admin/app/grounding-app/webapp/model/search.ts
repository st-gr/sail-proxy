/** The Test retrieval form: request building and result rows. No UI5 imports: these run under jest. */
import { fixed } from './format';

export const MAX_QUERY_LENGTH = 8192;
const MIN_RESULTS = 1;
const MAX_RESULTS = 50;

export interface SearchForm { query: string; maxResults: number | string; threshold: string; rewrite: boolean }
export type SearchProblem = 'query_empty' | 'query_too_long' | 'results_invalid' | 'threshold_invalid';
export type SearchRequest =
  | { ok: true; body: { query: string; max_num_results: number; ranking_options?: { score_threshold: number }; rewrite_query?: boolean } }
  | { ok: false; problem: SearchProblem };

export interface SearchRow { rank: number; fileId: string; filename: string; pages: string; score: string; text: string }

/** The gateway's `pages` extension as the cell shows it: "4", "4–5", or "" for a file without pages. */
export function pagesText(pages: any): string {
  const first = pages?.first;
  const last = pages?.last;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) return '';
  return first === last ? String(first) : `${first}–${last}`;
}

/** The Search button's rule: something to search for. A query over the limit (the gateway's own, 8192) is refused locally by buildSearchRequest. */
export function canSearch(query: string): boolean {
  return query.trim() !== '';
}

export function buildSearchRequest(form: SearchForm): SearchRequest {
  const query = form.query.trim();
  if (query === '') return { ok: false, problem: 'query_empty' };
  if (query.length > MAX_QUERY_LENGTH) return { ok: false, problem: 'query_too_long' };

  const rawResults = typeof form.maxResults === 'string' ? form.maxResults.trim() : form.maxResults;
  const results = rawResults === '' ? NaN : Number(rawResults);
  if (!Number.isInteger(results) || results < MIN_RESULTS || results > MAX_RESULTS) return { ok: false, problem: 'results_invalid' };

  const body: { query: string; max_num_results: number; ranking_options?: { score_threshold: number }; rewrite_query?: boolean } = { query, max_num_results: results };

  const rawThreshold = form.threshold.trim();
  if (rawThreshold !== '') {
    const threshold = Number(rawThreshold);
    if (!/^\d*\.?\d+$/.test(rawThreshold) || threshold > 1) return { ok: false, problem: 'threshold_invalid' };
    body.ranking_options = { score_threshold: threshold };
  }
  if (form.rewrite) body.rewrite_query = true;
  return { ok: true, body };
}

const SHORT_PASSAGE_CHARS = 600;
const SHORT_PASSAGE_LINES = 6;

/** Whether the passage cell, which shows six lines, needs a "More" link: an estimate, the cell's width is unknown here. */
export function isLongPassage(text: string): boolean {
  return text.length > SHORT_PASSAGE_CHARS || text.split('\n').length > SHORT_PASSAGE_LINES;
}

/** The gateway's search answer as table rows, in the order it ranked them. */
/** `locale` is the cockpit language the controller passes; jest passes none and gets 'en-US'. */
export function toSearchRows(body: any, locale = 'en-US'): SearchRow[] {
  const hits: any[] = Array.isArray(body?.data) ? body.data : [];
  return hits.map((hit, index) => {
    const score = typeof hit?.score === 'number' && Number.isFinite(hit.score) ? fixed(hit.score, 3, locale) : '';
    const parts: any[] = Array.isArray(hit?.content) ? hit.content : [];
    const text = parts.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n\n');
    return { rank: index + 1, fileId: String(hit?.file_id || ''), filename: String(hit?.filename || ''), pages: pagesText(hit?.pages), score, text };
  });
}
