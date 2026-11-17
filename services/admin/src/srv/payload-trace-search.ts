/**
 * The search of payload traces, the OData `$search` on AdminService.PayloadTraces: the WHOLE trimmed
 * text, literally and case-insensitively, in the masked prompt and answer and the request's facts. The
 * sealed prompt is never searched (spec 5.6: what is sealed is reached through its request).
 *
 * Like the gateway log's search (gateway-log-search.ts, which explains why CAP's own search is
 * replaced), the condition is CAP's `contains` over `tolower` of both sides: no LIKE, so %, _, quotes
 * and backslashes match only themselves, and the term is a bound parameter on both databases.
 */
import { searchText } from './gateway-log-search';

// The columns named by @cds.search on AdminService.PayloadTraces (admin-service.cds).
export const PAYLOAD_TRACE_SEARCH_COLUMNS = ['prompt', 'answer', 'requestId', 'model', 'endpoint', 'keyName', 'userEmail'];

/** The search condition as a CXN expression; null for a text that is empty after trimming (no search). */
export function payloadTraceSearchCondition(text: unknown): any[] | null {
  const term = typeof text === 'string' ? text.trim() : '';
  if (!term) return null;
  const xpr: any[] = [];
  for (const column of PAYLOAD_TRACE_SEARCH_COLUMNS) {
    if (xpr.length) xpr.push('or');
    xpr.push({ func: 'contains', args: [{ func: 'tolower', args: [{ ref: [column] }] }, { func: 'tolower', args: [{ val: term }] }] });
  }
  return [{ xpr }];
}

/** Replaces a `$search` on PayloadTraces by the literal whole-text condition. */
export function registerPayloadTraceSearch(service: any): void {
  service.before('READ', 'PayloadTraces', (req: any) => {
    const select = req.query?.SELECT;
    if (!select?.search) return;
    const condition = payloadTraceSearchCondition(searchText(select.search));
    delete select.search;
    if (condition) req.query.where(condition);
  });
}
