/**
 * The SQLite self-heal (src/db/data/sqlite-schema-heal.ts): the dev admin never runs cds deploy, and a
 * CI run restores db/admin.db from its pre-run backup, so a file database can lag the model and every
 * read of the changed entity fails ("no such column: $U.toolPolicy_ID"). The planner below turns the
 * model's compiled DDL plus the live schema into ADDITIVE statements only: create missing tables, add
 * missing columns, recreate views. It never drops a table or a column, and it is a no-op when the
 * database already matches. Pure functions, no database.
 */
import { parseCreate, planSqliteHeal, applySqliteHeal, healableSqliteFile } from '../../../src/db/data/sqlite-schema-heal';

const TABLE = `CREATE TABLE sap_llm_gateway_admin_Users (
  email NVARCHAR(255) NOT NULL,
  displayName NVARCHAR(100),
  toolPolicy_ID NVARCHAR(36),
  status NVARCHAR(12) DEFAULT 'active',
  PRIMARY KEY(email)
)`;
const VIEW = `CREATE VIEW AdminService_Users AS SELECT
  Users_0.email,
  Users_0.toolPolicy_ID
FROM sap_llm_gateway_admin_Users AS Users_0`;

describe('parseCreate', () => {
  it('reads a table with its column definitions and ignores table constraints', () => {
    expect(parseCreate(TABLE)).toEqual({
      kind: 'table', name: 'sap_llm_gateway_admin_Users',
      columns: [
        { name: 'email', definition: "email NVARCHAR(255) NOT NULL" },
        { name: 'displayName', definition: 'displayName NVARCHAR(100)' },
        { name: 'toolPolicy_ID', definition: 'toolPolicy_ID NVARCHAR(36)' },
        { name: 'status', definition: "status NVARCHAR(12) DEFAULT 'active'" }
      ]
    });
  });
  it('reads a view name without its body', () => {
    expect(parseCreate(VIEW)).toMatchObject({ kind: 'view', name: 'AdminService_Users' });
  });
  it('returns null for anything else', () => {
    expect(parseCreate('PRAGMA foreign_keys = on')).toBeNull();
  });
});

describe('planSqliteHeal', () => {
  const live = (tables: Record<string, string[]>, _ignored: Record<string, string> = {}, views: Record<string, string[]> = {}) => ({
    tables: new Map(Object.entries(tables).map(([t, c]) => [t, new Set(c)])),
    views: new Map(Object.entries(views).map(([v, c]) => [v, new Set(c)]))
  });

  it('creates a table that does not exist yet', () => {
    const plan = planSqliteHeal([TABLE], live({}));
    expect(plan.statements).toEqual([TABLE]);
    expect(plan.summary).toMatchObject({ tablesCreated: 1, columnsAdded: 0, viewsRecreated: 0 });
  });

  it('adds only the missing columns of an existing table', () => {
    const plan = planSqliteHeal([TABLE], live({ sap_llm_gateway_admin_Users: ['email', 'displayName', 'status'] }));
    expect(plan.statements).toEqual(['ALTER TABLE sap_llm_gateway_admin_Users ADD COLUMN toolPolicy_ID NVARCHAR(36)']);
    expect(plan.summary).toMatchObject({ tablesCreated: 0, columnsAdded: 1 });
  });

  it('never drops a table or a column the model no longer has', () => {
    const plan = planSqliteHeal([TABLE], live({
      sap_llm_gateway_admin_Users: ['email', 'displayName', 'toolPolicy_ID', 'status', 'legacyColumn'],
      sap_llm_gateway_admin_Gone: ['x']
    }));
    expect(plan.statements).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/DROP/i);
  });

  it('skips a NOT NULL column without a default, which SQLite cannot add', () => {
    const stmt = 'CREATE TABLE T (\n  a NVARCHAR(5),\n  b NVARCHAR(5) NOT NULL\n)';
    const plan = planSqliteHeal([stmt], live({ T: ['a'] }));
    expect(plan.statements).toEqual([]);
    expect(plan.summary.skipped).toEqual([
      { object: 'T.b', reason: 'NOT NULL without a default cannot be added to an existing SQLite table' }
    ]);
  });

  it('recreates a view that is missing or whose COLUMN LIST changed, ignoring the driver rewriting its body', () => {
    // @cap-js/sqlite rewrites CURRENT_TIMESTAMP into STRFTIME(...) when it stores a view, so the stored
    // text never equals the compiled text: comparing bodies would recreate such a view on every boot.
    expect(planSqliteHeal([VIEW], live({})).statements).toEqual(['DROP VIEW IF EXISTS AdminService_Users', VIEW]);
    const sameColumns = live({}, {}, { AdminService_Users: ['email', 'toolPolicy_ID'] });
    expect(planSqliteHeal([VIEW], sameColumns).statements).toEqual([]);
    expect(planSqliteHeal([VIEW], sameColumns).summary.viewsRecreated).toBe(0);
    const staleColumns = live({}, {}, { AdminService_Users: ['email'] });
    expect(planSqliteHeal([VIEW], staleColumns).statements).toEqual(['DROP VIEW IF EXISTS AdminService_Users', VIEW]);
  });

  it('reads the column list of a view, including an alias and a quoted name', () => {
    const v = 'CREATE VIEW V AS SELECT A_0.id, A_0."key", A_0.x + 1 AS total FROM T AS A_0';
    expect(parseCreate(v)).toEqual({ kind: 'view', name: 'V', columns: [
      { name: 'id', definition: 'A_0.id' }, { name: 'key', definition: 'A_0."key"' }, { name: 'total', definition: 'A_0.x + 1 AS total' }
    ] });
  });

  it('plans a table before the views that read it', () => {
    const plan = planSqliteHeal([VIEW, TABLE], live({}));
    expect(plan.statements.indexOf(TABLE)).toBeLessThan(plan.statements.indexOf(VIEW));
  });
});

describe('applySqliteHeal', () => {
  it('runs the statements in order and reports what it did', async () => {
    const ran: string[] = [];
    const db = { run: async (sql: string) => { ran.push(sql); if (/ADD COLUMN/.test(sql)) throw new Error('locked'); } };
    const plan = planSqliteHeal([TABLE, VIEW], { tables: new Map([['sap_llm_gateway_admin_Users', new Set(['email'])]]), views: new Map() });
    const result = await applySqliteHeal(db, plan);
    expect(ran.length).toBe(plan.statements.length);
    expect(result.failed).toHaveLength(3); // the three ALTERs reject; the view statements still run
    expect(result.applied).toBe(plan.statements.length - 3);
  });
});

describe('healableSqliteFile', () => {
  it('accepts a file-backed SQLite database only', () => {
    expect(healableSqliteFile({ kind: 'sqlite', credentials: { url: 'db/admin.db' } })).toBe(true);
    expect(healableSqliteFile({ kind: 'sqlite', credentials: { url: ':memory:' } })).toBe(false);
    expect(healableSqliteFile({ kind: 'postgres', credentials: { url: 'postgres://x' } })).toBe(false);
    expect(healableSqliteFile({ kind: 'sqlite' })).toBe(false);
    expect(healableSqliteFile(undefined)).toBe(false);
  });
});
