const cds = require('@sap/cds');

/**
 * Envelope rows written before SecurityNotifications carried the request context hold no IP.
 * Copy clientIP / userAgent / endpoint / requestId from the source event named by sourceEntity
 * once, on startup. Idempotent: only rows with clientIP IS NULL are read, and a row whose source
 * event has no IP either stays null (nothing to copy). Rotation notifications
 * (sourceEntity = 'AwsCredentialRotations') carry no request context by design.
 */
const NOTIFICATIONS = 'sap.llm.gateway.admin.SecurityNotifications';
const SOURCES: Array<[string, string]> = [
  ['ApiKeySecurityEvents', 'sap.llm.gateway.admin.ApiKeySecurityEvents'],
  ['AwsCredentialSecurityEvents', 'sap.llm.gateway.admin.AwsCredentialSecurityEvents']
];
const CHUNK = 200;

export async function backfillNotificationContext(db: any): Promise<number> {
  const { SELECT, UPDATE } = cds.ql;
  let updated = 0;
  for (const [sourceEntity, table] of SOURCES) {
    const pending: any[] = await db.run(
      SELECT.from(NOTIFICATIONS).columns('ID', 'sourceID').where({ sourceEntity, clientIP: null })
    );
    if (pending.length === 0) continue;
    const ids = [...new Set(pending.map((n) => n.sourceID).filter(Boolean))];
    const events = new Map<string, any>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows: any[] = await db.run(
        SELECT.from(table).columns('ID', 'clientIP', 'userAgent', 'endpoint', 'requestId')
          .where({ ID: { in: ids.slice(i, i + CHUNK) } })
      );
      rows.forEach((e) => events.set(e.ID, e));
    }
    for (const n of pending) {
      const e = events.get(n.sourceID);
      if (!e || !e.clientIP) continue;
      await db.run(UPDATE(NOTIFICATIONS)
        .set({ clientIP: e.clientIP, userAgent: e.userAgent ?? null, endpoint: e.endpoint ?? null, requestId: e.requestId ?? null })
        .where({ ID: n.ID }));
      updated += 1;
    }
  }
  return updated;
}
