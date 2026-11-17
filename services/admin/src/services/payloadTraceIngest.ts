/**
 * The admin service's half of payload traces. The gateway appends one light trace per request to the
 * `payload-traces` Valkey stream (field `trace`, a PayloadTraceMessage) and the sealed stages of a raw
 * capture to `raw-traces` (field `raw`, a RawTraceMessage); this reads each stream through its own
 * consumer group (`payload-trace-ingest`, `raw-trace-ingest`) on its own connection and stores the
 * messages in PayloadTraces and RawTraces.
 *
 * - The row's key is the stream entry's id, written with UPSERT: an entry delivered twice is one row.
 * - Nothing sealed is opened here; what a row keeps of a message is decided in payloadTraceRows.ts.
 * - `keyName` and `userEmail` are resolved per batch: ApiKeys by ID (the gateway's credential id of
 *   an API key is its row ID), AwsCredentials by ID or by access key id.
 * - A raw trace marks the light row of its request `raw`, and a light row stored after its raw trace
 *   is marked too. (The gateway already sets `raw` on the light trace of a request in a raw session.)
 * - Acknowledged (XACK) and deleted (XDEL) only after the rows are committed. A malformed message, or
 *   a row the database refuses with a data error, is counted and acknowledged so it cannot block the
 *   stream. No transaction is held across a Valkey call.
 */
import Redis from 'iovalkey';
import { getDefaultLogger } from '@libs/logger';
import { traceRow, rawRow } from './payloadTraceRows';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const PAYLOAD_TRACE_ENTITY = 'sap.llm.gateway.admin.PayloadTraces';
export const RAW_TRACE_ENTITY = 'sap.llm.gateway.admin.RawTraces';
const API_KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS_CREDENTIALS = 'sap.llm.gateway.admin.AwsCredentials';
const RECLAIM_MIN_IDLE_MS = 60_000;
const WARN_INTERVAL_MS = 60_000;

/**
 * The streams, as the gateway writes them (services/gateway/src/services/securityEventEmitter.ts), and
 * the entries per read and per reclaim: a raw trace may be ~2.75 MB, so its batch stays at 5.
 */
const STREAMS = {
  light: { stream: 'payload-traces', group: 'payload-trace-ingest', field: 'trace', count: '20' },
  raw: { stream: 'raw-traces', group: 'raw-trace-ingest', field: 'raw', count: '5' }
} as const;
export type TraceStreamKind = keyof typeof STREAMS;

/** One stream entry: its id and its parsed message (anything; it is checked before it is stored). */
export interface TraceEntry { id: string; message: unknown }

/** The part of the Valkey client the ingest uses (a fake in the tests). */
export interface TraceStreamClient {
  xgroup(...args: any[]): Promise<any>;
  xreadgroup(...args: any[]): Promise<any>;
  xautoclaim(...args: any[]): Promise<any>;
  xack(...args: any[]): Promise<any>;
  xdel(...args: any[]): Promise<any>;
  disconnect(): void;
}

/**
 * `api_config.observability.payload_capture` with the defaults the gateway applies (D7); a value of
 * the wrong type gives the default, 0 hours stay 0, a max_duration_minutes that is not a whole number
 * of at least 1 (the schema's minimum) gives the default.
 */
export function payloadCaptureSettings(config: any): { enabled: boolean; retentionHours: number; raw: { maxDurationMinutes: number; retentionHours: number } } {
  const block = config?.api_config?.observability?.payload_capture;
  const b = block && typeof block === 'object' ? block : {};
  const r = b.raw && typeof b.raw === 'object' ? b.raw : {};
  const count = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  return {
    enabled: typeof b.enabled === 'boolean' ? b.enabled : false,
    retentionHours: count(b.retention_hours, 48),
    raw: {
      maxDurationMinutes: Number.isInteger(r.max_duration_minutes) && r.max_duration_minutes >= 1 ? r.max_duration_minutes : 240,
      retentionHours: count(r.retention_hours, 24)
    }
  };
}

const stats = { stored: 0, malformed: 0 };
let lastWarning = 0;
export const traceIngestStats = (): typeof stats => ({ ...stats });
export const resetTraceIngestStats = (): void => { stats.stored = 0; stats.malformed = 0; lastWarning = 0; };

/** At most one warning a minute. Never names content: ids and error messages only. */
function warnRateLimited(message: string, detail: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastWarning < WARN_INTERVAL_MS) return;
  lastWarning = now;
  logger.warn('PayloadTraceIngest', message, { ...detail, malformed: stats.malformed });
}

/** A Postgres data exception or integrity violation (SQLSTATE class 22 or 23): redelivery cannot fix it. */
const isPermanentDataError = (error: unknown): boolean => {
  const code = (error as any)?.code;
  return typeof code === 'string' && /^2[23][0-9A-Z]{3}$/.test(code);
};

/**
 * Writes the rows in one short transaction; when the database refuses them with a data error, one at
 * a time, skipping (and counting) each row it refuses. `after` runs in the same transaction. Rejects
 * on any other error: the stream entries then stay for redelivery.
 */
async function writeRows(entity: string, rows: Record<string, any>[], after?: (tx: any, rows: Record<string, any>[]) => Promise<void>): Promise<number> {
  const write = (part: Record<string, any>[]) => cds.tx(async (tx: any) => {
    await tx.run(cds.ql.UPSERT.into(entity).entries(part));
    if (after) await after(tx, part);
  });
  try {
    await write(rows);
    stats.stored += rows.length;
    return rows.length;
  } catch (error) {
    if (!isPermanentDataError(error)) throw error;
  }
  let stored = 0;
  for (const row of rows) {
    try {
      await write([row]);
      stored++;
    } catch (error) {
      if (!isPermanentDataError(error)) throw error;
      stats.malformed++;
      warnRateLimited('The database refused one payload trace with a data error; skipped', { id: row.ID, error: error instanceof Error ? error.message : String(error) });
    }
  }
  stats.stored += stored;
  return stored;
}

const unique = (values: unknown[]): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];

/** keyName and userEmail per credential id, read once for the batch. */
async function credentialsOf(tx: any, ids: string[]): Promise<Map<string, { keyName: string | null; userEmail: string | null }>> {
  const found = new Map<string, { keyName: string | null; userEmail: string | null }>();
  if (ids.length === 0) return found;
  const { SELECT } = cds.ql;
  const keys: any[] = await tx.run(SELECT.from(API_KEYS).columns('ID', 'name', 'email').where({ ID: { in: ids } }));
  for (const k of keys) found.set(k.ID, { keyName: k.name ?? null, userEmail: k.email ?? null });
  const aws: any[] = await tx.run(SELECT.from(AWS_CREDENTIALS).columns('ID', 'accessKeyId', 'name', 'email', 'userId')
    .where({ ID: { in: ids } }).or({ accessKeyId: { in: ids } }));
  for (const a of aws) {
    const who = { keyName: a.name ?? null, userEmail: a.email ?? a.userId ?? null };
    if (ids.includes(a.ID)) found.set(a.ID, who);
    if (ids.includes(a.accessKeyId)) found.set(a.accessKeyId, who);
  }
  return found;
}

/** Stores light traces; returns how many rows it wrote. A message that is not a light trace is skipped and counted. */
export async function storeTraces(entries: TraceEntry[]): Promise<number> {
  const rows: Record<string, any>[] = [];
  for (const e of entries) {
    const row = traceRow(e.id, e.message);
    if (row) rows.push(row); else stats.malformed++;
  }
  if (rows.length === 0) return 0;
  // Read first, in its own short transaction: the credentials and which requests already have a raw trace.
  const { credentials, withRaw } = await cds.tx(async (tx: any) => {
    const requestIds = unique(rows.map((r) => r.requestId));
    const raws: any[] = await tx.run(cds.ql.SELECT.from(RAW_TRACE_ENTITY).columns('requestId').where({ requestId: { in: requestIds } }));
    return { credentials: await credentialsOf(tx, unique(rows.map((r) => r.credentialId))), withRaw: new Set(raws.map((r) => r.requestId)) };
  });
  for (const row of rows) {
    const who = row.credentialId ? credentials.get(row.credentialId) : undefined;
    row.keyName = who?.keyName ?? null;
    row.userEmail = who?.userEmail ?? null;
    row.raw = row.raw || withRaw.has(row.requestId);
  }
  return writeRows(PAYLOAD_TRACE_ENTITY, rows);
}

/** Stores raw traces and marks the light rows of their requests; returns how many rows it wrote. */
export async function storeRawTraces(entries: TraceEntry[]): Promise<number> {
  const rows: Record<string, any>[] = [];
  for (const e of entries) {
    const row = rawRow(e.id, e.message);
    if (row) rows.push(row); else stats.malformed++;
  }
  if (rows.length === 0) return 0;
  return writeRows(RAW_TRACE_ENTITY, rows, async (tx, written) => {
    // Not .set({ raw: true }): cds reads an argument with a truthy `raw` property as a tagged template.
    await tx.run(cds.ql.UPDATE(PAYLOAD_TRACE_ENTITY).set('raw =', true).where({ requestId: { in: unique(written.map((r) => r.requestId)) } }));
  });
}

async function acknowledge(client: TraceStreamClient, kind: TraceStreamKind, id: string): Promise<void> {
  const { stream, group } = STREAMS[kind];
  await client.xack(stream, group, id);
  try {
    await client.xdel(stream, id);
  } catch (error) {
    // Acknowledged already; the stream's own cap removes it in time.
    logger.debug('PayloadTraceIngest', 'Could not delete an acknowledged stream entry', { id, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Stores the entries of one read and acknowledges them. A malformed entry is counted and acknowledged;
 * when the rows cannot be committed for another reason than a data error, nothing is acknowledged.
 */
export async function handleTraceStreamEntries(client: TraceStreamClient, kind: TraceStreamKind, items: any[]): Promise<void> {
  const { field } = STREAMS[kind];
  const ids: string[] = [];
  const entries: TraceEntry[] = [];
  for (const item of items ?? []) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1])) continue; // a reclaimed entry already trimmed away
    const [id, fields] = item;
    ids.push(id);
    const at = fields.indexOf(field);
    const raw = at !== -1 ? fields[at + 1] : undefined;
    let message: unknown;
    try { message = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : undefined; } catch { message = undefined; }
    if (message === undefined) {
      stats.malformed++;
      warnRateLimited(`A ${STREAMS[kind].stream} stream entry is not a JSON message; dropped`, { id });
    } else {
      entries.push({ id, message });
    }
  }
  if (ids.length === 0) return;
  if (entries.length > 0) {
    try {
      await (kind === 'light' ? storeTraces(entries) : storeRawTraces(entries));
    } catch (error) {
      if (!isPermanentDataError(error)) {
        warnRateLimited(`${STREAMS[kind].stream} stream entries could not be stored; left for redelivery`, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      stats.malformed += entries.length;
      warnRateLimited(`The database rejected ${STREAMS[kind].stream} stream entries with a data error; dropped`, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const id of ids) await acknowledge(client, kind, id);
}

const isTestProcess = (): boolean => process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;

export interface PayloadTraceIngestHandle { stop: () => Promise<void>; done: Promise<void> }

function consume(client: TraceStreamClient, kind: TraceStreamKind, isRunning: () => boolean): Promise<void> {
  const { stream, group, count } = STREAMS[kind];
  const consumer = `admin-${process.pid}`;
  let groupReady = false;
  const ensureGroup = async (): Promise<void> => {
    if (groupReady) return;
    try {
      await client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (err: any) {
      if (!String(err?.message || '').includes('BUSYGROUP')) throw err;
    }
    groupReady = true;
  };
  return (async () => {
    while (isRunning()) {
      try {
        await ensureGroup();
        // Entries a dead consumer read but never acknowledged.
        const claimed: any = await client.xautoclaim(stream, group, consumer, RECLAIM_MIN_IDLE_MS, '0', 'COUNT', count);
        if (claimed?.[1]?.length) await handleTraceStreamEntries(client, kind, claimed[1]);
        const res: any = await client.xreadgroup('GROUP', group, consumer, 'COUNT', count, 'BLOCK', '5000', 'STREAMS', stream, '>');
        for (const [, entries] of res ?? []) {
          if (!isRunning()) break;
          await handleTraceStreamEntries(client, kind, entries);
        }
      } catch (error) {
        if (!isRunning()) break;
        // The stream was lost (Valkey restarted without persistence): create the group again.
        if (String((error as any)?.message || '').includes('NOGROUP')) groupReady = false;
        logger.warn('PayloadTraceIngest', `${stream} stream consume error; retrying`, { error: error instanceof Error ? error.message : String(error) });
        await new Promise((r) => setTimeout(r, 1000).unref());
      }
    }
  })();
}

/**
 * Starts both consume loops, each on its own connection (a blocking read holds its connection).
 * Returns null (and starts nothing) without VALKEY_URL, and in a test process unless `createClient`
 * is injected. `stop` ends the loops and closes the connections.
 */
export function startPayloadTraceIngest(opts: { createClient?: () => TraceStreamClient; allowInTest?: boolean } = {}): PayloadTraceIngestHandle | null {
  let createClient = opts.createClient;
  if (!createClient) {
    if (isTestProcess() && !opts.allowInTest) return null;
    const url = process.env.VALKEY_URL;
    if (!url) {
      logger.info('PayloadTraceIngest', 'Valkey URL not configured - payload traces are not collected');
      return null;
    }
    createClient = () => {
      const client = new Redis(url);
      client.on('error', (error: Error) => logger.warn('PayloadTraceIngest', `Valkey connection error: ${error.message}`));
      return client as unknown as TraceStreamClient;
    };
  }
  let running = true;
  const clients = [createClient(), createClient()];
  const done = Promise.all([consume(clients[0], 'light', () => running), consume(clients[1], 'raw', () => running)]).then(() => undefined);
  const stop = async (): Promise<void> => {
    running = false;
    for (const c of clients) {
      try { c.disconnect(); } catch { /* already closed */ }
    }
  };
  return { stop, done };
}
