/**
 * The indexes of the gateway log and the payload traces, created on every admin boot like team-usage-indexes.ts: CAP's schema
 * evolution creates none. Idempotent on SQLite and PostgreSQL (unquoted identifiers fold to the
 * lower-case table CAP created). Never throws: failures are reported for the caller's log.
 */
import { IndexSpec, IndexResult } from './tool-usage-indexes';

export const GATEWAY_LOG_INDEXES: IndexSpec[] = [
  // the log view and the export (a time range, in order), and retention (the oldest rows)
  { name: 'idx_gatewaylogentries_loggedat', table: 'sap_llm_gateway_admin_GatewayLogEntries', columns: ['loggedAt'] },
  // the live view's poll (what was stored after its cursor)
  { name: 'idx_gatewaylogentries_storedat', table: 'sap_llm_gateway_admin_GatewayLogEntries', columns: ['storedAt'] },
  // the trace list (a time range) and retention; the request id: a raw trace marks its light trace
  { name: 'idx_payloadtraces_capturedat', table: 'sap_llm_gateway_admin_PayloadTraces', columns: ['capturedAt'] },
  { name: 'idx_payloadtraces_requestid', table: 'sap_llm_gateway_admin_PayloadTraces', columns: ['requestId'] },
  // retention, and the stages of one request
  { name: 'idx_rawtraces_capturedat', table: 'sap_llm_gateway_admin_RawTraces', columns: ['capturedAt'] },
  { name: 'idx_rawtraces_requestid', table: 'sap_llm_gateway_admin_RawTraces', columns: ['requestId'] }
];

export async function ensureGatewayLogIndexes(db: { run: (sql: string) => Promise<any> }): Promise<IndexResult> {
  const result: IndexResult = { ensured: 0, failed: [] };
  for (const idx of GATEWAY_LOG_INDEXES) {
    try {
      await db.run(`CREATE INDEX IF NOT EXISTS ${idx.name} ON ${idx.table} (${idx.columns.join(', ')})`);
      result.ensured += 1;
    } catch (error) {
      result.failed.push({ name: idx.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
