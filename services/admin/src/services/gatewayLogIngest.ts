/**
 * The admin service's half of the gateway log. The gateway appends its log to the `gateway-log`
 * Valkey stream in batches (field `batch`, a JSON array of ShippedLogEntry); this reads the stream
 * through the `gateway-log-ingest` consumer group and stores the entries in GatewayLogEntries.
 *
 * - An entry is recognised by where it came from: its key is `<stream entry id>-<index in batch>`,
 *   written with UPSERT, so a stream entry delivered twice ends as the same rows. (`seq` restarts
 *   with every gateway process and two replicas can produce the same `(t, seq)`.)
 * - The stream entry is acknowledged (XACK) and deleted (XDEL) only after its rows are committed.
 * - A malformed stream entry, or a write the database rejects with a data error, would fail the same
 *   way on every redelivery: it is counted, acknowledged and deleted so it cannot block the stream.
 * - No database transaction is held across a Valkey call: read first, then one short cds.tx.
 */
import Redis from 'iovalkey';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const GATEWAY_LOG_ENTITY = 'sap.llm.gateway.admin.GatewayLogEntries';
const STREAM_NAME = 'gateway-log';
const CONSUMER_GROUP = 'gateway-log-ingest';
const RECLAIM_MIN_IDLE_MS = 60_000;
const WARN_INTERVAL_MS = 60_000;
const INSERT_CHUNK = 500;
const LIMITS = { level: 5, component: 80, requestId: 60, message: 2000, error: 500 };

/** The shape the gateway ships (services/gateway/src/services/logShipper.ts), declared here, not imported. */
export interface ShippedLogEntry {
  t: string;
  seq: number;
  level: string;
  component: string;
  requestId?: string;
  message: string;
  error?: string;
}

/** The part of the Valkey client the ingest uses (a fake in the tests). */
export interface GatewayLogStreamClient {
  xgroup(...args: any[]): Promise<any>;
  xreadgroup(...args: any[]): Promise<any>;
  xautoclaim(...args: any[]): Promise<any>;
  xack(...args: any[]): Promise<any>;
  xdel(...args: any[]): Promise<any>;
  disconnect(): void;
}

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

/** `api_config.observability.gateway_log` with its defaults (as the gateway reads it); a wrong type gives the default. */
export function gatewayLogSettings(config: any): { enabled: boolean; retentionHours: number; maxEntries: number; minLevel: string } {
  const block = config?.api_config?.observability?.gateway_log;
  const b = block && typeof block === 'object' ? block : {};
  const count = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  const level = typeof b.min_level === 'string' ? b.min_level.toUpperCase() : '';
  return {
    enabled: typeof b.enabled === 'boolean' ? b.enabled : true,
    retentionHours: count(b.retention_hours, 48),
    maxEntries: count(b.max_entries, 2000000),
    minLevel: LEVELS.includes(level) ? level : 'INFO',
  };
}

const stats = { malformedEntries: 0, skippedEntries: 0, storedEntries: 0 };
let lastWarning = 0;
export const ingestStats = (): typeof stats => ({ ...stats });
export const resetIngestStats = (): void => { stats.malformedEntries = 0; stats.skippedEntries = 0; stats.storedEntries = 0; lastWarning = 0; };

/** At most one warning a minute, so a stream of bad entries cannot flood the log. */
function warnRateLimited(message: string, detail: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastWarning < WARN_INTERVAL_MS) return;
  lastWarning = now;
  logger.warn('GatewayLogIngest', message, { ...detail, malformedEntries: stats.malformedEntries, skippedEntries: stats.skippedEntries });
}

/** A string with no lone surrogate: PostgreSQL cannot take one (the driver sends rows as JSON). */
const wellFormed = (value: string): string => (typeof (value as any).toWellFormed === 'function'
  ? (value as any).toWellFormed()
  : value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD'));

/** A string cut to the column (never in the middle of a surrogate pair), well-formed; NUL characters removed (PostgreSQL text cannot hold them). */
function text(value: unknown, limit: number): string {
  const whole = String(value).replace(/\u0000/g, '');
  let cut = whole.slice(0, limit);
  if (whole.length > limit && /[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return wellFormed(cut);
}

function rowOf(streamId: string, index: number, e: any, storedAt: string): Record<string, unknown> | null {
  if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.t !== 'string') return null;
  const loggedAt = new Date(e.t);
  if (Number.isNaN(loggedAt.getTime())) return null;
  return {
    ID: `${streamId}-${index}`,
    loggedAt: loggedAt.toISOString(),
    seq: typeof e.seq === 'number' && Number.isSafeInteger(e.seq) ? e.seq : 0,
    level: typeof e.level === 'string' && LEVELS.includes(e.level.toUpperCase()) ? e.level.toUpperCase() : 'INFO',
    component: typeof e.component === 'string' ? text(e.component, LIMITS.component) : '',
    requestId: typeof e.requestId === 'string' && e.requestId ? text(e.requestId, LIMITS.requestId) : null,
    message: e.message === undefined || e.message === null ? '' : text(e.message, LIMITS.message),
    error: typeof e.error === 'string' && e.error ? text(e.error, LIMITS.error) : null,
    storedAt,
  };
}

/**
 * Stores one stream entry's batch; returns how many rows it wrote. An entry that is not an object or
 * lacks a usable `t` is skipped and counted. Written with UPSERT, so storing the same stream entry
 * again writes the same rows (only `storedAt`, the admin's time of the write, is refreshed).
 */
export async function storeBatch(streamId: string, batch: ShippedLogEntry[]): Promise<number> {
  const rows: Record<string, unknown>[] = [];
  const storedAt = new Date().toISOString();
  batch.forEach((e, i) => {
    const row = rowOf(streamId, i, e, storedAt);
    if (row) rows.push(row); else stats.skippedEntries++;
  });
  if (rows.length === 0) return 0;
  try {
    await cds.tx(async (tx: any) => {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await tx.run(cds.ql.UPSERT.into(GATEWAY_LOG_ENTITY).entries(rows.slice(i, i + INSERT_CHUNK)));
      }
    });
    stats.storedEntries += rows.length;
    return rows.length;
  } catch (error) {
    if (!isPermanentDataError(error)) throw error;
  }
  // One row the database refuses must not cost the batch: write the rows one at a time, each in its
  // own short transaction. The write is idempotent, so rows already written by the failed attempt are harmless.
  let stored = 0;
  for (const row of rows) {
    try {
      await cds.tx(async (tx: any) => { await tx.run(cds.ql.UPSERT.into(GATEWAY_LOG_ENTITY).entries([row])); });
      stored++;
    } catch (error) {
      if (!isPermanentDataError(error)) throw error; // the stream entry stays for redelivery
      stats.skippedEntries++;
      warnRateLimited('The database refused one gateway-log entry with a data error; skipped', { id: row.ID, error: error instanceof Error ? error.message : String(error) });
    }
  }
  stats.storedEntries += stored;
  return stored;
}

/** A Postgres data exception or integrity violation (SQLSTATE class 22 or 23): redelivery cannot fix it. */
const isPermanentDataError = (error: unknown): boolean => {
  const code = (error as any)?.code;
  return typeof code === 'string' && /^2[23][0-9A-Z]{3}$/.test(code);
};

async function acknowledge(client: GatewayLogStreamClient, id: string): Promise<void> {
  await client.xack(STREAM_NAME, CONSUMER_GROUP, id);
  try {
    await client.xdel(STREAM_NAME, id);
  } catch (error) {
    // Acknowledged already; the stream's own cap removes it in time.
    logger.debug('GatewayLogIngest', 'Could not delete an acknowledged stream entry', { id, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Stores one stream entry and acknowledges it; never throws for the entry's own content. */
export async function handleStreamEntry(client: GatewayLogStreamClient, id: string, fields: string[]): Promise<void> {
  const at = Array.isArray(fields) ? fields.indexOf('batch') : -1;
  const raw = at !== -1 ? fields[at + 1] : undefined;
  let batch: unknown;
  if (typeof raw === 'string' && raw !== '') {
    try { batch = JSON.parse(raw); } catch { batch = undefined; }
  }
  if (!Array.isArray(batch)) {
    stats.malformedEntries++;
    warnRateLimited('A gateway-log stream entry is not a batch of log entries; dropped', { id });
    await acknowledge(client, id);
    return;
  }
  try {
    await storeBatch(id, batch as ShippedLogEntry[]);
  } catch (error) {
    if (isPermanentDataError(error)) {
      stats.malformedEntries++;
      warnRateLimited('The database rejected a gateway-log stream entry with a data error; dropped', { id, error: error instanceof Error ? error.message : String(error) });
      await acknowledge(client, id);
      return;
    }
    warnRateLimited('A gateway-log stream entry could not be stored; left for redelivery', { id, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  await acknowledge(client, id);
}

const isTestProcess = (): boolean => process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;

export interface GatewayLogIngestHandle { stop: () => Promise<void>; done: Promise<void> }

/**
 * Starts the consume loop. Returns null (and starts nothing) without VALKEY_URL, and in a test
 * process unless a client is injected. `stop` ends the loop and closes the connection.
 */
export function startGatewayLogIngest(opts: { client?: GatewayLogStreamClient; allowInTest?: boolean } = {}): GatewayLogIngestHandle | null {
  let client = opts.client;
  if (!client) {
    if (isTestProcess() && !opts.allowInTest) return null;
    if (!process.env.VALKEY_URL) {
      logger.info('GatewayLogIngest', 'Valkey URL not configured - the gateway log is not collected');
      return null;
    }
    client = new Redis(process.env.VALKEY_URL) as unknown as GatewayLogStreamClient;
    (client as any).on?.('error', (error: Error) => logger.warn('GatewayLogIngest', `Valkey connection error: ${error.message}`));
  }
  const stream = client;
  const consumer = `admin-${process.pid}`;
  let running = true;
  let groupReady = false;

  const ensureGroup = async (): Promise<void> => {
    if (groupReady) return;
    try {
      await stream.xgroup('CREATE', STREAM_NAME, CONSUMER_GROUP, '0', 'MKSTREAM');
    } catch (err: any) {
      if (!String(err?.message || '').includes('BUSYGROUP')) throw err;
    }
    groupReady = true;
  };

  const handle = async (entries: any): Promise<void> => {
    for (const item of entries ?? []) {
      if (!running) return;
      if (!Array.isArray(item) || !item[1]) continue; // a reclaimed entry already trimmed away
      await handleStreamEntry(stream, item[0], item[1]);
    }
  };

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        await ensureGroup();
        // Entries a dead consumer read but never acknowledged.
        const claimed: any = await stream.xautoclaim(STREAM_NAME, CONSUMER_GROUP, consumer, RECLAIM_MIN_IDLE_MS, '0');
        await handle(claimed?.[1]);
        const res: any = await stream.xreadgroup('GROUP', CONSUMER_GROUP, consumer, 'COUNT', '20', 'BLOCK', '5000', 'STREAMS', STREAM_NAME, '>');
        for (const [, entries] of res ?? []) await handle(entries);
      } catch (error) {
        if (!running) break;
        // The stream was lost (Valkey restarted without persistence): create the group again.
        if (String((error as any)?.message || '').includes('NOGROUP')) groupReady = false;
        logger.warn('GatewayLogIngest', 'Stream consume error; retrying', { error: error instanceof Error ? error.message : String(error) });
        await new Promise((r) => setTimeout(r, 1000).unref());
      }
    }
  };

  const done = loop();
  const stop = async (): Promise<void> => {
    running = false;
    try { stream.disconnect(); } catch { /* already closed */ }
  };
  return { stop, done };
}
