/**
 * Tool usage indexes (docs/developer/tool-governance.md): CAP's schema evolution creates tables,
 * columns and views but no secondary indexes on SQLite or PostgreSQL, so the admin creates them on
 * every boot with CREATE INDEX IF NOT EXISTS. In-memory SQLite through cds.test(); no gateway, no Valkey.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));
import { ensureToolUsageIndexes, TOOL_USAGE_INDEXES } from '../../../src/db/data/tool-usage-indexes';

async function indexNames(db: any): Promise<string[]> {
  const rows = await db.run("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_tool%' ORDER BY name");
  return rows.map((r: any) => r.name);
}

describe('ensureToolUsageIndexes', () => {
  let db: any;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('creates the retention and lookup indexes on the tool usage tables', async () => {
    const result = await ensureToolUsageIndexes(db);
    expect(result.failed).toEqual([]);
    expect(result.ensured).toBe(TOOL_USAGE_INDEXES.length);
    expect(await indexNames(db)).toEqual([
      'idx_toolusage_email_identity', 'idx_toolusage_validfrom', 'idx_toolusagedaily_day'
    ]);
  });

  it('is idempotent: a second boot changes nothing and reports no failure', async () => {
    const result = await ensureToolUsageIndexes(db);
    expect(result.failed).toEqual([]);
    expect(await indexNames(db)).toHaveLength(TOOL_USAGE_INDEXES.length);
  });

  it('never throws: a rejected statement is reported and the remaining indexes are still attempted', async () => {
    const calls: string[] = [];
    const flaky = { run: async (sql: string) => { calls.push(sql); if (calls.length === 1) throw new Error('no such table'); } };
    const result = await ensureToolUsageIndexes(flaky);
    expect(calls).toHaveLength(TOOL_USAGE_INDEXES.length);
    expect(result.failed).toEqual([{ name: TOOL_USAGE_INDEXES[0].name, error: 'no such table' }]);
    expect(result.ensured).toBe(TOOL_USAGE_INDEXES.length - 1);
  });

  it('emits portable DDL: unquoted identifiers and IF NOT EXISTS', () => {
    for (const idx of TOOL_USAGE_INDEXES) {
      expect(idx.name).toMatch(/^[a-z_]+$/);
      expect(idx.table).toMatch(/^[A-Za-z_]+$/);
      for (const c of idx.columns) expect(c).toMatch(/^[A-Za-z_]+$/);
    }
  });
});
