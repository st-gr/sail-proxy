/**
 * The search of the gateway log, shared by the OData `$search` on AdminService.GatewayLog and the
 * export's `search` parameter (admin-service-logs.ts): the WHOLE trimmed text, literally and
 * case-insensitively, in message, component or requestId.
 *
 * CAP's own `search` function (cds 8.9.7, @cap-js/db-service cql-functions.js) applies only the first
 * word and reads a leading double quote as quoting, so `$search` is taken off the request before it
 * reaches the database and replaced by this condition. The condition is CAP's `contains` over
 * `tolower` of both sides, which each database renders itself (instr on SQLite, strpos on PostgreSQL,
 * the term as a bound parameter): no LIKE, so %, _, quotes and backslashes match only themselves.
 */

// The columns named by @cds.search on GatewayLogEntries (db/schema/gateway-log.cds).
export const SEARCH_COLUMNS = ['message', 'component', 'requestId'];

/** The search condition as a CXN expression; null for a text that is empty after trimming (no search). */
export function gatewayLogSearchCondition(text: unknown): any[] | null {
  const term = typeof text === 'string' ? text.trim() : '';
  if (!term) return null;
  const xpr: any[] = [];
  for (const column of SEARCH_COLUMNS) {
    if (xpr.length) xpr.push('or');
    xpr.push({ func: 'contains', args: [{ func: 'tolower', args: [{ ref: [column] }] }, { func: 'tolower', args: [{ val: term }] }] });
  }
  return [{ xpr }];
}

// The whole text as one OData quoted string: "…" with \" and \\ inside.
const QUOTED = /^\s*"((?:[^"\\]|\\.)*)"\s*$/;

/**
 * The text of a parsed `$search` (the OData parser gives the whole text as one value). The URL parser
 * refuses an unpaired double quote, so the Logs page sends the text as one quoted string; that one is
 * unwrapped. Any other text is taken as it is, quotes included.
 */
export function searchText(search: unknown): string {
  if (!Array.isArray(search)) return '';
  const text = search.filter((part) => part && typeof part === 'object' && 'val' in part).map((part) => String(part.val)).join(' ');
  const quoted = QUOTED.exec(text);
  return quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : text;
}

/** Replaces a `$search` on GatewayLog by the literal whole-text condition. */
export function registerGatewayLogSearch(service: any): void {
  service.before('READ', 'GatewayLog', (req: any) => {
    const select = req.query?.SELECT;
    if (!select?.search) return;
    const condition = gatewayLogSearchCondition(searchText(select.search));
    delete select.search;
    if (condition) req.query.where(condition);
  });
}
