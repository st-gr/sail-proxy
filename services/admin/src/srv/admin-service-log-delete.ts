/**
 * deleteStoredLogs on AdminService (admin only, see admin-service.cds): empties what the service
 * stores of the gateway's log, on request. `what` names the part: `log` (the gateway log,
 * GatewayLogEntries), `traces` (PayloadTraces and RawTraces) or `all` (all three); anything else is
 * refused with a translated 400 and deletes nothing.
 *
 * Each table is one condition-less DELETE, all in one short transaction. The answer says how many log
 * entries went (what the DELETE reports; cds returns the affected rows on SQLite and PostgreSQL) and how
 * many traces (the distinct requests of both trace tables, read before the deletes); `deleted` is their
 * sum. The audit event
 * `logging.stored.delete` follows in its own transaction once the delete has committed, so no
 * transaction is open across another await (the admin's SQLite has one connection). Entries the
 * gateway sends afterwards are stored again. recordAuditEvent logs a failed audit write at ERROR and
 * does not throw: the action still answers with the count.
 */
import { GATEWAY_LOG_ENTITY } from '../services/gatewayLogIngest';
import { PAYLOAD_TRACE_ENTITY, RAW_TRACE_ENTITY } from '../services/payloadTraceIngest';
import { recordAuditEvent } from '../services/auditEventService';
import { clientContext } from '../utils/clientIp';

const cds = require('@sap/cds');

/** What each known `what` empties; `log` and `traces` say which counts apply. */
const PARTS: Record<string, { log: boolean; traces: boolean; resourceType: string }> = {
  log: { log: true, traces: false, resourceType: 'GatewayLog' },
  traces: { log: false, traces: true, resourceType: 'PayloadTraces' },
  all: { log: true, traces: true, resourceType: 'StoredLogs' }
};

/**
 * The requests the trace tables hold: a raw-captured request has a payload trace and raw stages, and
 * the Payload traces tab shows it as one trace, so it counts once. A row without a request id counts
 * on its own.
 */
async function distinctTraces(tx: any): Promise<number> {
  const ids = new Set<string>();
  for (const entity of [PAYLOAD_TRACE_ENTITY, RAW_TRACE_ENTITY]) {
    const rows = await tx.run(cds.ql.SELECT.from(entity).columns('ID', 'requestId'));
    for (const row of rows) ids.add(row.requestId ? `r:${row.requestId}` : `${entity}:${row.ID}`);
  }
  return ids.size;
}

async function deleteStoredLogs(req: any): Promise<{ deleted: number; logEntries: number; traces: number }> {
  const what = req.data?.what;
  const part = typeof what === 'string' && Object.prototype.hasOwnProperty.call(PARTS, what) ? PARTS[what] : undefined;
  if (!part) return req.reject({ status: 400, code: 'LOGGING_DELETE_UNKNOWN', message: 'LOGGING_DELETE_UNKNOWN', args: [String(what ?? '')] });
  const counts = await cds.tx(async (tx: any) => {
    let logEntries = 0;
    let traces = 0;
    if (part.log) logEntries = Number(await tx.run(cds.ql.DELETE.from(GATEWAY_LOG_ENTITY))) || 0;
    if (part.traces) {
      traces = await distinctTraces(tx);
      await tx.run(cds.ql.DELETE.from(PAYLOAD_TRACE_ENTITY));
      await tx.run(cds.ql.DELETE.from(RAW_TRACE_ENTITY));
    }
    return { deleted: logEntries + traces, logEntries, traces };
  });
  await cds.tx(() => recordAuditEvent({
    actorId: req.user?.id || 'anonymous', actorType: 'admin_user', action: 'logging.stored.delete',
    resourceType: part.resourceType, resourceId: what, outcome: 'success', severity: 'medium',
    ...clientContext(req), details: JSON.stringify({ what, ...counts })
  }));
  return counts;
}

export function registerLogDeleteHandlers(service: any): void {
  service.on('deleteStoredLogs', deleteStoredLogs);
}
