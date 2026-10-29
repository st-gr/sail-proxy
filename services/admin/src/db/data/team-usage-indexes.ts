// services/admin/src/db/data/team-usage-indexes.ts
/**
 * Secondary indexes for the team columns, created on every admin boot like tool-usage-indexes.ts:
 * CAP's schema evolution creates none. Idempotent on SQLite and PostgreSQL (unquoted identifiers
 * fold to the lower-case tables CAP created). Never throws: failures are reported for the caller's log.
 */
import { IndexSpec, IndexResult } from './tool-usage-indexes';

export const TEAM_INDEXES: IndexSpec[] = [
  // Teams by Cost and the team rebuild: rows of one team in a date range
  { name: 'idx_apikeyusage_team_date', table: 'sap_llm_gateway_admin_ApiKeyUsage', columns: ['team_ID', 'validFrom'] },
  { name: 'idx_awscredentialusage_team_date', table: 'sap_llm_gateway_admin_AwsCredentialUsage', columns: ['team_ID', 'validFrom'] },
  // a user's memberships (primary lookup on every validation)
  { name: 'idx_teammembers_email', table: 'sap_llm_gateway_admin_TeamMembers', columns: ['email'] }
];

export async function ensureTeamIndexes(db: { run: (sql: string) => Promise<any> }): Promise<IndexResult> {
  const result: IndexResult = { ensured: 0, failed: [] };
  for (const idx of TEAM_INDEXES) {
    try {
      await db.run(`CREATE INDEX IF NOT EXISTS ${idx.name} ON ${idx.table} (${idx.columns.join(', ')})`);
      result.ensured += 1;
    } catch (error) {
      result.failed.push({ name: idx.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
