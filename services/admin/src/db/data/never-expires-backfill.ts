const cds = require('@sap/cds');

/**
 * Grandfathering, made explicit.
 *
 * Before the neverExpires column existed, "expiresAt is null" was how a credential that predates
 * the expiration feature kept working - the rule lived in the absence of a date. The flag makes
 * that state a deliberate, admin-set property instead, so those legacy rows are migrated to it
 * once: every API key and AWS credential with no expiration date is flagged as never-expiring.
 *
 * Idempotent - the WHERE clause matches nothing on a second run, so it is safe on every boot and
 * on every deployment target (SQLite dev, Postgres via schema_evolution).
 */
const ENTITIES = [
  'sap.llm.gateway.admin.ApiKeys',
  'sap.llm.gateway.admin.AwsCredentials',
];

export async function backfillNeverExpires(db: any): Promise<number> {
  const { UPDATE } = cds.ql;
  let updated = 0;
  for (const entity of ENTITIES) {
    const affected = await db.run(
      UPDATE(entity)
        .set({ neverExpires: true })
        .where('expiresAt is null and (neverExpires = false or neverExpires is null)')
    );
    updated += Number(affected) || 0;
  }
  return updated;
}
