/**
 * What a payload trace shows in the list and in its detail: its facts, and for a raw trace the list
 * of its stages (names, sizes, cut marks; never content). No UI5 imports, so it runs under jest; the
 * controller translates the text keys and formats the time.
 */

export interface TraceRow {
  ID: string;
  requestId?: string | null;
  capturedAt?: string | null;
  endpoint?: string | null;
  model?: string | null;
  keyName?: string | null;
  userEmail?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  masked?: unknown;
  truncated?: unknown;
  omitted?: string | null;
  raw?: unknown;
  /** A sealed prompt is stored (a trace that was not masked, captured while payload capture was on). */
  promptSealed?: unknown;
  /** A raw trace without a light trace (payload capture was off): ID is the raw trace's. */
  rawOnly?: boolean;
}

export interface RawRow { ID: string; requestId?: string | null; capturedAt?: string | null }

export type StatusState = 'Success' | 'Warning' | 'Error' | 'None';

export interface TraceFacts {
  route: string;
  model: string;
  keyName: string;
  userEmail: string;
  /** The key's name and its user's address, as far as known. */
  keyAndUser: string;
  status: string;
  statusState: StatusState;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  masked: boolean;
  raw: boolean;
  promptSealed: boolean;
  truncated: boolean;
  omitted: string;
  /** Text keys for the content column: masked or not masked, and raw when the stages were captured. */
  contentKeys: string[];
}

export interface Stage { name: string; size: string; cut: boolean }

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function statusState(code: number | null): StatusState {
  if (code === null) return 'None';
  if (code >= 400) return 'Error';
  if (code >= 300) return 'Warning';
  return 'Success';
}

export function traceFacts(row: TraceRow): TraceFacts {
  const statusCode = numberOrNull(row.statusCode);
  const masked = Boolean(row.masked);
  const raw = Boolean(row.raw);
  const keyName = text(row.keyName);
  const userEmail = text(row.userEmail);
  return {
    route: text(row.endpoint),
    model: text(row.model),
    keyName,
    userEmail,
    keyAndUser: [keyName, userEmail].filter((part) => part !== '').join(' · '),
    status: statusCode === null ? '' : String(statusCode),
    statusState: statusState(statusCode),
    durationMs: numberOrNull(row.durationMs),
    inputTokens: numberOrNull(row.inputTokens),
    outputTokens: numberOrNull(row.outputTokens),
    masked,
    raw,
    promptSealed: Boolean(row.promptSealed),
    truncated: Boolean(row.truncated),
    omitted: text(row.omitted),
    contentKeys: row.rawOnly ? ['contentRaw'] : [masked ? 'contentMasked' : 'contentNotMasked', ...(raw ? ['contentRaw'] : [])]
  };
}

/**
 * What the detail offers of a light trace's content: masked text at once; a sealed prompt behind
 * "Show content" (opening it is recorded); nothing for a trace without either, such as the facts-only
 * trace of a raw capture recorded while payload capture was off (its stages are offered instead).
 */
export function contentState(facts: TraceFacts): 'masked' | 'sealed' | 'none' {
  if (facts.masked) return 'masked';
  return facts.promptSealed ? 'sealed' : 'none';
}

/**
 * The list: the light traces, and the raw traces of requests that have none (captured raw while
 * payload capture was off), newest first. The service searched the light traces; a raw-only row
 * is kept when its request id holds the filter text, in upper or lower case.
 */
export function withRawOnly(rows: TraceRow[], raw: RawRow[], search: string): TraceRow[] {
  return merged(rows, rawOnlyOf(rows, raw, search));
}

const at = (row: { capturedAt?: string | null }) => Date.parse(String(row.capturedAt ?? '')) || 0;

/** The raw traces without a light trace among `rows` whose request id holds the filter text, as rows. */
function rawOnlyOf(rows: TraceRow[], raw: RawRow[], search: string): TraceRow[] {
  const known = new Set(rows.map((row) => row.requestId).filter((id) => !!id));
  const term = String(search ?? '').trim().toLowerCase();
  return raw
    .filter((r) => r && r.ID && !known.has(r.requestId) && (!term || String(r.requestId ?? '').toLowerCase().includes(term)))
    .map((r) => ({ ID: r.ID, requestId: r.requestId ?? null, capturedAt: r.capturedAt ?? null, raw: true, rawOnly: true }));
}

function merged(rows: TraceRow[], added: TraceRow[]): TraceRow[] {
  if (!added.length) return rows;
  return [...rows, ...added].sort((a, b) => at(b) - at(a));
}

/**
 * The rows of the list from the two reads, and whether the light read was cut at `limit`. The gateway
 * stamps a raw trace when its request starts and the light trace when it ends, so a raw trace is never
 * newer than its light trace. A cut read (newest first) therefore gets only the raw-only rows newer than
 * its oldest row: an older one may have its light trace beyond the cut and would show twice. `rawLeftOut`
 * says that raw-only rows are missing: some were older than the cut, or the raw read itself was full.
 * `total` is the service's count of the light traces.
 */
export function traceListRows(light: { entries: TraceRow[]; count: number | null }, raw: RawRow[], search: string, limit: number): { rows: TraceRow[]; cut: boolean; total: number | null; rawLeftOut: boolean } {
  const cut = light.count !== null ? light.count > light.entries.length : light.entries.length >= limit;
  const candidates = rawOnlyOf(light.entries, raw, search);
  let added = candidates;
  if (cut) {
    const oldest = light.entries.reduce((min, row) => Math.min(min, at(row)), Number.POSITIVE_INFINITY);
    added = candidates.filter((row) => at(row) > oldest);
  }
  return { rows: merged(light.entries, added), cut, total: light.count, rawLeftOut: added.length < candidates.length || raw.length >= limit };
}

function size(bytes: unknown, locale: string): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${number.format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${number.format(bytes / 1024)} KB`;
  return `${number.format(bytes / (1024 * 1024))} MB`;
}

/**
 * The stages of a raw trace from its stageIndex (the JSON text of [{ name, bytes, cut }], or the
 * array), in the order they were recorded. A repeated stage name arrives as `name#2`; names are
 * unique per request, so a stage is opened by its name. An index that cannot be read has no stages.
 */
export function stageList(index: unknown, locale = 'en'): Stage[] {
  let entries: unknown = index;
  if (typeof index === 'string') {
    try { entries = JSON.parse(index); } catch (error) { return []; }
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry.name === 'string')
    .map((entry) => ({ name: entry.name as string, size: size(entry.bytes, locale), cut: entry.cut === true }));
}

/** The tab's bar: payload capture as the Logs page's record says, else as the configuration says. */
export function captureTextKey(settings: { payloadCaptureEnabled: boolean | null; configurationPayloadCaptureEnabled: boolean | null }): string {
  const on = settings.payloadCaptureEnabled ?? settings.configurationPayloadCaptureEnabled;
  return on === true ? 'captureOn' : 'captureOff';
}

/**
 * The warning while the gateway writes payload files (PAYLOAD_LOGGING_ENABLED or the configuration's
 * payload_logging_enabled): those files are not masked in every stage, and reading them is not audited.
 */
export function fileLoggingTextKey(enabled: boolean | null | undefined): string {
  return enabled === true ? 'payloadFilesOn' : '';
}

/** The warning of a seal key that is not strong (D1): anyone who knows its value can decrypt the stages. */
export function weakKeyTextKey(status: string | null | undefined): string {
  switch (status) {
    case 'missing': return 'weakKeyMissing';
    case 'too-short': return 'weakKeyTooShort';
    case 'publicly-known': return 'weakKeyPubliclyKnown';
    default: return '';
  }
}

/**
 * The text key for a trace or stage that cannot be shown: `problem` of openPayloadTrace and
 * openRawStage, or `error` of a refused download (whose own message is English only).
 */
export function problemKey(code: string | null | undefined): string {
  switch (code) {
    case 'keys-differ': return 'traceKeysDiffer';
    case 'malformed': return 'traceMalformed';
    case 'not_found': return 'traceNotFound';
    default: return 'traceReadFailed';
  }
}
