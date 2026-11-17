/**
 * The requests of the Gateway Log tab: the OData read of AdminService.GatewayLog and the export URL
 * (GET /api/logs/gateway/export, srv/admin-service-logs.ts). No UI5 imports, so it runs under jest.
 *
 * The search finds the whole text as typed, literally and case-insensitively, in message, component
 * and request id (the service's srv/gateway-log-search.ts). It is sent as one OData quoted string
 * (`"…"` with \" and \\ inside), because the OData URL parser refuses an unpaired double quote; the
 * service unwraps it. The level is a minimum.
 */

export const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const COLUMNS = 'ID,loggedAt,seq,level,component,requestId,message,error,storedAt';
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface EntriesQuery {
  top: number;
  /** A poll: entries the admin stored after this instant (liveLog.ts nextPollCursor). */
  storedAfter?: string;
  /** A time range: both ends included. */
  from?: string;
  to?: string;
  level?: string;
  search?: string;
  count?: boolean;
}

export interface ExportQuery { from?: string; to?: string; level?: string; search?: string }

/** WARN means WARN and ERROR; '' or an unknown level means all levels (an empty list). */
export function levelsAtOrAbove(level: string | null | undefined): string[] {
  const at = LEVELS.indexOf(String(level ?? '').trim().toUpperCase());
  return at === -1 ? [] : LEVELS.slice(at);
}

export function levelFilter(level: string | null | undefined): string | null {
  const levels = levelsAtOrAbove(level);
  return levels.length ? `(${levels.map((l) => `level eq '${l}'`).join(' or ')})` : null;
}

/** An instant goes into the filter unquoted (Edm.DateTimeOffset), so only an ISO instant may. */
function instant(value: string): string {
  if (!ISO_INSTANT.test(value)) throw new RangeError(`Not an ISO instant: ${value}`);
  return value;
}

const enc = encodeURIComponent;

/**
 * A poll of Live: the search and level the shown rows were read with (the applied ones, which the
 * highlighting uses too), not what is typed but not yet applied; what was stored after the cursor.
 */
export function pollQuery(cursor: string | null, applied: { search: string; level: string }, top: number): EntriesQuery {
  return { top, search: applied.search, level: applied.level, ...(cursor ? { storedAfter: cursor } : {}) };
}

export function entriesUrl(base: string, query: EntriesQuery): string {
  const conditions: string[] = [];
  if (query.storedAfter) conditions.push(`storedAt gt ${instant(query.storedAfter)}`);
  if (query.from) conditions.push(`loggedAt ge ${instant(query.from)}`);
  if (query.to) conditions.push(`loggedAt le ${instant(query.to)}`);
  const levels = levelFilter(query.level);
  if (levels) conditions.push(levels);
  const parts = [`$select=${COLUMNS}`, `$orderby=${enc('loggedAt desc,seq desc,ID desc')}`, `$top=${Math.max(1, Math.floor(query.top))}`];
  if (conditions.length) parts.push(`$filter=${enc(conditions.join(' and '))}`);
  const search = String(query.search ?? '').trim();
  if (search) parts.push(`$search=${enc(`"${search.replace(/[\\"]/g, (c) => `\\${c}`)}"`)}`);
  if (query.count) parts.push('$count=true');
  return `${base}/GatewayLog?${parts.join('&')}`;
}

/** Behind nginx (Docker, Kyma) the admin service's /api is served under /admin/api. */
export function restBase(deployTarget: string | null | undefined): string {
  return deployTarget === 'docker' ? '/admin/api' : '/api';
}

export function exportUrl(restBasePath: string, query: ExportQuery): string {
  const parts: string[] = [];
  if (query.from) parts.push(`from=${enc(query.from)}`);
  if (query.to) parts.push(`to=${enc(query.to)}`);
  const search = String(query.search ?? '').trim();
  if (search) parts.push(`search=${enc(search)}`);
  if (levelsAtOrAbove(query.level).length) parts.push(`level=${enc(String(query.level).trim().toUpperCase())}`);
  return `${restBasePath}/logs/gateway/export${parts.length ? `?${parts.join('&')}` : ''}`;
}
