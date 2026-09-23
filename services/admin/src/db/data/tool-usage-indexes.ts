/**
 * Secondary indexes for the tool usage tables, created on every admin boot.
 *
 * CAP's schema evolution (`cds-deploy` with `schema_evolution: auto`, which the Docker and Kyma
 * admin run before starting) creates and alters tables, columns, views and constraints, but it
 * generates no secondary indexes on SQLite or PostgreSQL, and `@sql.append` can only extend the
 * CREATE TABLE statement itself. The raw ToolUsage table gains a row per tool per request and is
 * scanned by the nightly retention DELETE on `validFrom`, so the indexes it needs are created here
 * instead, the same way the gateway creates its file_search indexes.
 *
 * Idempotent and portable: CREATE INDEX IF NOT EXISTS with unquoted identifiers runs unchanged on
 * SQLite and PostgreSQL (PostgreSQL folds the names to the lower-case tables CAP created), so a
 * restart, an upgrade and a fresh install all end in the same state with no manual step. Never
 * throws: a rejected statement (a table not deployed yet on a local SQLite file, or two replicas
 * racing on the same index) is logged by the caller and retried on the next boot.
 */
export interface IndexSpec { name: string; table: string; columns: string[]; }

export const TOOL_USAGE_INDEXES: IndexSpec[] = [
  // nightly retention: DELETE ... WHERE validFrom < cutoff
  { name: 'idx_toolusage_validfrom', table: 'sap_llm_gateway_admin_ToolUsage', columns: ['validFrom'] },
  // per-user investigation of one tool
  { name: 'idx_toolusage_email_identity', table: 'sap_llm_gateway_admin_ToolUsage', columns: ['email', 'identity'] },
  // inventory day range and daily retention: the primary key starts with email, not day
  { name: 'idx_toolusagedaily_day', table: 'sap_llm_gateway_admin_ToolUsageDaily', columns: ['day'] }
];

export interface IndexResult { ensured: number; failed: { name: string; error: string }[]; }

export async function ensureToolUsageIndexes(db: { run: (sql: string) => Promise<any> }): Promise<IndexResult> {
  const result: IndexResult = { ensured: 0, failed: [] };
  for (const idx of TOOL_USAGE_INDEXES) {
    try {
      await db.run(`CREATE INDEX IF NOT EXISTS ${idx.name} ON ${idx.table} (${idx.columns.join(', ')})`);
      result.ensured += 1;
    } catch (error) {
      result.failed.push({ name: idx.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
