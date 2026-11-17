/**
 * The requests of the Payload Traces tab: the OData read of AdminService.PayloadTraces and
 * RawTraceIndex, and the download URLs (GET /api/logs/traces/:id/download and /api/logs/raw/:id/download[?stage=],
 * srv/admin-service-traces.ts). No UI5 imports, so it runs under jest.
 *
 * The list needs a time range (spec 4.2); the filter text works within it, sent as one OData quoted
 * string like the Gateway log's search (logQuery.ts), and the service searches it literally in the
 * masked prompt and answer and the facts (srv/payload-trace-search.ts).
 */
import type { UtcRange } from './timeRange';

/** The most rows one read returns (@cds.query.limit on PayloadTraces). */
export const TRACE_LIMIT = 2000;
const COLUMNS = 'ID,capturedAt,requestId,endpoint,model,keyName,userEmail,statusCode,durationMs,inputTokens,outputTokens,masked,truncated,omitted,raw,promptSealed';
const RAW_COLUMNS = 'ID,requestId,sessionId,capturedAt,stageIndex,cutStages';
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export type TraceListQuery = { ok: true; query: string } | { ok: false; reason: 'range-required' };

const enc = encodeURIComponent;

/** An instant goes into the filter unquoted (Edm.DateTimeOffset), so only an ISO instant may. */
function instant(value: string): string {
  if (!ISO_INSTANT.test(value)) throw new RangeError(`Not an ISO instant: ${value}`);
  return value;
}

/** An OData string literal: in single quotes, a quote inside doubled. */
const quoted = (value: string): string => `'${String(value).replace(/'/g, "''")}'`;

/**
 * The query part of the list read: the facts of the traces captured in the range, newest first.
 * The range is two chained conditions on capturedAt (one when an end is open); no range, no query.
 */
export function traceListQuery(range: UtcRange | null, search: string): TraceListQuery {
  const conditions: string[] = [];
  if (range?.from) conditions.push(`capturedAt ge ${instant(range.from)}`);
  if (range?.to) conditions.push(`capturedAt le ${instant(range.to)}`);
  if (!conditions.length) return { ok: false, reason: 'range-required' };
  const parts = [`$select=${COLUMNS}`, `$orderby=${enc('capturedAt desc,ID desc')}`, `$top=${TRACE_LIMIT}`, `$filter=${enc(conditions.join(' and '))}`];
  const text = String(search ?? '').trim();
  if (text) parts.push(`$search=${enc(`"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`)}`);
  parts.push('$count=true');
  return { ok: true, query: parts.join('&') };
}

/**
 * The raw traces of the same range. With payload capture off, a request captured raw has no light
 * trace, so the list adds these (traceView.ts withRawOnly); null without a range.
 */
export function rawListQuery(range: UtcRange | null): string | null {
  const conditions: string[] = [];
  if (range?.from) conditions.push(`capturedAt ge ${instant(range.from)}`);
  if (range?.to) conditions.push(`capturedAt le ${instant(range.to)}`);
  if (!conditions.length) return null;
  return `$select=ID,requestId,capturedAt&$orderby=${enc('capturedAt desc,ID desc')}&$top=${TRACE_LIMIT}&$filter=${enc(conditions.join(' and '))}`;
}

/** The trace of one request (the Gateway log's "Payload trace" link): no time range needed. */
export function traceByRequestQuery(requestId: string): string {
  return `$select=${COLUMNS}&$filter=${enc(`requestId eq ${quoted(requestId)}`)}&$orderby=${enc('capturedAt desc')}&$top=1`;
}

/** The raw traces of one request: names, sizes and cut marks of the stages, never their content. */
export function rawIndexQuery(requestId: string): string {
  return `$select=${RAW_COLUMNS}&$filter=${enc(`requestId eq ${quoted(requestId)}`)}&$orderby=${enc('capturedAt desc')}`;
}

/**
 * A trace's download (its facts and text) or a raw trace's (all stages as one JSON file, or with
 * `stage` that one stage as its own file, recorded as a download). The REST base is /api in local
 * development and /admin/api behind nginx (logQuery.ts restBase).
 */
export function downloadUrl(kind: 'trace' | 'raw', id: string, restBasePath = '/api', stage?: string): string {
  const url = `${restBasePath}/logs/${kind === 'trace' ? 'traces' : 'raw'}/${enc(id)}/download`;
  return kind === 'raw' && stage ? `${url}?stage=${enc(stage)}` : url;
}
