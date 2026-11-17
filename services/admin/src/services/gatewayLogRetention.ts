/**
 * Retention of the gateway log: rows older than the retention time go, then the oldest rows beyond
 * the maximum count. Payload traces go after `payload_capture.retention_hours`, raw traces after
 * `payload_capture.raw.retention_hours`. Runs every ten minutes whether or not storing or capture is
 * switched on, so rows still age out after it was switched off. A value of 0 means "no limit of that
 * kind". Deletes in batches (select the keys of one batch, delete those keys): DELETE ... LIMIT does
 * not exist on PostgreSQL, and each batch is its own short transaction.
 */
import { getDefaultLogger } from '@libs/logger';
import { GATEWAY_LOG_ENTITY, gatewayLogSettings } from './gatewayLogIngest';
import { PAYLOAD_TRACE_ENTITY, RAW_TRACE_ENTITY, payloadCaptureSettings } from './payloadTraceIngest';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

const BATCH_SIZE = 5000;
const INTERVAL_MS = 10 * 60_000;
const FIRST_RUN_MS = 60_000;

type RetentionSettings = { retentionHours: number; maxEntries: number };

async function deleteKeys(keys: string[], entity: string = GATEWAY_LOG_ENTITY): Promise<void> {
  await cds.tx(async (tx: any) => { await tx.run(cds.ql.DELETE.from(entity).where({ ID: { in: keys } })); });
}

async function selectKeys(select: any): Promise<string[]> {
  const found: { ID: string }[] = await cds.tx(async (tx: any) => tx.run(select));
  return found.map((r) => r.ID);
}

export async function sweepGatewayLog(now: Date, settings: RetentionSettings, batchSize: number = BATCH_SIZE): Promise<{ byAge: number; byCount: number }> {
  const { SELECT } = cds.ql;
  let byAge = 0;
  let byCount = 0;

  if (settings.retentionHours > 0) {
    const cutoff = new Date(now.getTime() - settings.retentionHours * 3_600_000).toISOString();
    for (;;) {
      const keys = await selectKeys(SELECT.from(GATEWAY_LOG_ENTITY).columns('ID').where({ loggedAt: { '<': cutoff } }).limit(batchSize));
      if (keys.length === 0) break;
      await deleteKeys(keys);
      byAge += keys.length;
      if (keys.length < batchSize) break;
    }
  }

  if (settings.maxEntries > 0) {
    const counted: any = await cds.tx(async (tx: any) => tx.run(SELECT.one.from(GATEWAY_LOG_ENTITY).columns('count(*) as n')));
    let excess = Number(counted?.n ?? 0) - settings.maxEntries;
    while (excess > 0) {
      const keys = await selectKeys(SELECT.from(GATEWAY_LOG_ENTITY).columns('ID').orderBy('loggedAt', 'seq', 'ID').limit(Math.min(excess, batchSize)));
      if (keys.length === 0) break;
      await deleteKeys(keys);
      byCount += keys.length;
      excess -= keys.length;
    }
  }
  return { byAge, byCount };
}

/** Deletes the rows of `entity` captured before `now` minus `retentionHours`, in batches; 0 deletes none. Returns the count. */
async function sweepByCapturedAt(entity: string, now: Date, retentionHours: number, batchSize: number): Promise<number> {
  if (!(retentionHours > 0)) return 0;
  const cutoff = new Date(now.getTime() - retentionHours * 3_600_000).toISOString();
  let deleted = 0;
  for (;;) {
    const keys = await selectKeys(cds.ql.SELECT.from(entity).columns('ID').where({ capturedAt: { '<': cutoff } }).limit(batchSize));
    if (keys.length === 0) break;
    await deleteKeys(keys, entity);
    deleted += keys.length;
    if (keys.length < batchSize) break;
  }
  return deleted;
}

export const sweepPayloadTraces = (now: Date, retentionHours: number, batchSize: number = BATCH_SIZE): Promise<number> =>
  sweepByCapturedAt(PAYLOAD_TRACE_ENTITY, now, retentionHours, batchSize);

export const sweepRawTraces = (now: Date, retentionHours: number, batchSize: number = BATCH_SIZE): Promise<number> =>
  sweepByCapturedAt(RAW_TRACE_ENTITY, now, retentionHours, batchSize);

/** The ACTIVE configuration (the row with isActive, highest version first), parsed; undefined without one. */
async function activeConfiguration(): Promise<any> {
  const rows: any[] = await cds.tx(async (tx: any) => tx.run(
    cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations').columns('configData').where({ isActive: true }).orderBy('version desc').limit(1)));
  try { return rows?.[0]?.configData ? JSON.parse(rows[0].configData) : undefined; } catch { return undefined; }
}

/** The settings of the ACTIVE configuration, or the defaults. */
export async function activeRetentionSettings(): Promise<ReturnType<typeof gatewayLogSettings>> {
  return gatewayLogSettings(await activeConfiguration());
}

/** The trace retention times of the ACTIVE configuration, or the defaults (48 and 24 hours). */
export async function activePayloadCaptureRetention(): Promise<{ retentionHours: number; rawRetentionHours: number }> {
  const settings = payloadCaptureSettings(await activeConfiguration());
  return { retentionHours: settings.retentionHours, rawRetentionHours: settings.raw.retentionHours };
}

/** The longest raw capture session the ACTIVE configuration allows, in minutes, or the default (240). */
export async function activeRawCaptureMaxMinutes(): Promise<number> {
  return payloadCaptureSettings(await activeConfiguration()).raw.maxDurationMinutes;
}

const isTestProcess = (): boolean => process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;

export interface GatewayLogRetentionHandle { stop: () => void; timers: NodeJS.Timeout[] }

/** Starts the retention timer (unref-ed, so it never keeps a process alive). Null in a test process unless allowed. */
export function startGatewayLogRetention(opts: { allowInTest?: boolean; intervalMs?: number; firstRunMs?: number } = {}): GatewayLogRetentionHandle | null {
  if (isTestProcess() && !opts.allowInTest) return null;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    const now = new Date();
    try {
      const result = await sweepGatewayLog(now, await activeRetentionSettings());
      if (result.byAge + result.byCount > 0) logger.info('GatewayLogRetention', `Deleted ${result.byAge} gateway log entries by age and ${result.byCount} by count`);
    } catch (error) {
      logger.warn('GatewayLogRetention', `The gateway log retention run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // On its own: a failing log sweep must not keep raw traces beyond their retention.
    try {
      const traces = await activePayloadCaptureRetention();
      const light = await sweepPayloadTraces(now, traces.retentionHours);
      const raw = await sweepRawTraces(now, traces.rawRetentionHours);
      if (light + raw > 0) logger.info('GatewayLogRetention', `Deleted ${light} payload traces and ${raw} raw traces by age`);
    } catch (error) {
      logger.warn('GatewayLogRetention', `The payload trace retention run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => { void run(); }, opts.firstRunMs ?? FIRST_RUN_MS);
  const every = setInterval(() => { void run(); }, opts.intervalMs ?? INTERVAL_MS);
  first.unref();
  every.unref();
  return { timers: [first, every], stop: () => { clearTimeout(first); clearInterval(every); } };
}
