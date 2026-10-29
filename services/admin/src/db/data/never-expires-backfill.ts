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
  const { SELECT, UPDATE } = cds.ql;
  let updated = 0;
  // Select the unflagged rows, then update them by ID. An UPDATE whose statement carries no bound
  // parameter - the flag and the IS NULL condition are both inlined literals - fails on PostgreSQL
  // (@cap-js/postgres 1.14: "Query values must be an array"), in string and object form alike; it
  // worked only on SQLite, so every Postgres deployment logged a warning at boot and never flagged
  // its legacy rows. `ID in (...)` always binds its values.
  for (const entity of ENTITIES) {
    const rows: Array<{ ID: string; neverExpires: boolean | null }> =
      await db.run(SELECT.from(entity).columns('ID', 'neverExpires').where({ expiresAt: null }));
    const ids = rows.filter((r) => r.neverExpires !== true).map((r) => r.ID);
    if (ids.length === 0) continue;
    const affected = await db.run(UPDATE(entity).set({ neverExpires: true }).where({ ID: { in: ids } }));
    updated += Number(affected) || 0;
  }
  return updated;
}
