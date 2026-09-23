/**
 * Additive self-heal for a file-backed SQLite database, run at admin boot.
 *
 * Why: the dev admin (`cds serve`) never deploys schema changes, and `pnpm run ci` restores
 * `db/admin.db` from the backup it took before the run — so a local database can lag the model, and
 * then every read of a changed entity fails ("no such column: $U.toolPolicy_ID"), which takes down
 * whoami, the quota status and the Fiori apps at once. PostgreSQL has no such gap: the Docker and
 * Kyma admin run `cds-deploy --profile pg` with `schema_evolution: auto` before starting.
 *
 * What it does: compares the model's compiled SQLite DDL with the live schema and applies ONLY
 * additive statements — create a missing table, add a missing column, recreate a view (views hold no
 * data). It never drops a table, never drops a column the model no longer declares, and never
 * rewrites a column's type, so it cannot lose data; anything it cannot do additively is reported and
 * left to the by-hand migration in docs/developer/tool-governance.md. It is a no-op once the database
 * matches, and it is skipped entirely unless the database is a SQLite FILE (in-memory test databases
 * are deployed fresh by cds.test, and PostgreSQL has its own deploy step).
 *
 * CAP's own schema evolution is not usable here: it keys off the `cds_model` table that only a
 * previous `cds deploy` writes, and on a database without that row it falls back to drop-create,
 * which would wipe the dev data this is meant to protect.
 */
export interface ParsedColumn { name: string; definition: string; }
export interface ParsedCreate { kind: 'table' | 'view'; name: string; columns?: ParsedColumn[]; }
export interface LiveSchema { tables: Map<string, Set<string>>; views: Map<string, Set<string>>; }
export interface HealSummary {
  tablesCreated: number; columnsAdded: number; viewsRecreated: number;
  skipped: { object: string; reason: string }[];
}
export interface HealPlan { statements: string[]; summary: HealSummary; }

const TABLE_CONSTRAINT = /^(PRIMARY\s+KEY|UNIQUE|CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i;

/** Splits a parenthesised column list on top-level commas. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0, quote: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}


/** Column names a compiled view selects: an alias when present, else the last dotted identifier. */
function viewColumns(afterSelect: string): ParsedColumn[] {
  let depth = 0, quote: string | null = null, end = afterSelect.length;
  for (let i = 0; i < afterSelect.length; i += 1) {
    const c = afterSelect[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && /\s/.test(c) && /^\s+FROM\s/i.test(afterSelect.slice(i, i + 7))) { end = i; break; }
  }
  const columns: ParsedColumn[] = [];
  for (const part of splitTopLevel(afterSelect.slice(0, end))) {
    const alias = /\sAS\s+"?(\w+)"?$/i.exec(part)?.[1];
    const tail = alias ?? /"?(\w+)"?\s*$/.exec(part.split('.').pop() ?? part)?.[1];
    if (tail) columns.push({ name: tail, definition: part });
  }
  return columns;
}

export function parseCreate(statement: string): ParsedCreate | null {
  const text = String(statement).trim().replace(/;\s*$/, '');
  const view = /^CREATE\s+VIEW\s+(\w+)\s+AS\s+SELECT\b/i.exec(text);
  if (view) return { kind: 'view', name: view[1], columns: viewColumns(text.slice(view[0].length)) };
  const table = /^CREATE\s+TABLE\s+(\w+)\s*\(/i.exec(text);
  if (!table) return null;
  const body = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
  const columns: ParsedColumn[] = [];
  for (const part of splitTopLevel(body)) {
    if (TABLE_CONSTRAINT.test(part)) continue;
    const name = /^"?(\w+)"?/.exec(part)?.[1];
    if (name) columns.push({ name, definition: part });
  }
  return { kind: 'table', name: table[1], columns };
}

/**
 * Turns the compiled DDL plus the live schema into additive statements. Tables and their columns come
 * first, so a view recreated afterwards can read the columns that were just added.
 */
export function planSqliteHeal(compiled: string[], live: LiveSchema): HealPlan {
  const summary: HealSummary = { tablesCreated: 0, columnsAdded: 0, viewsRecreated: 0, skipped: [] };
  const tableStatements: string[] = [];
  const viewStatements: string[] = [];
  for (const statement of compiled) {
    const parsed = parseCreate(statement);
    if (!parsed) continue;
    if (parsed.kind === 'table') {
      const existing = live.tables.get(parsed.name);
      if (!existing) {
        tableStatements.push(String(statement).replace(/;\s*$/, ''));
        summary.tablesCreated += 1;
        continue;
      }
      for (const column of parsed.columns ?? []) {
        if (existing.has(column.name)) continue;
        const notNullWithoutDefault = /\bNOT\s+NULL\b/i.test(column.definition) && !/\bDEFAULT\b/i.test(column.definition);
        if (notNullWithoutDefault) {
          summary.skipped.push({ object: `${parsed.name}.${column.name}`, reason: 'NOT NULL without a default cannot be added to an existing SQLite table' });
          continue;
        }
        tableStatements.push(`ALTER TABLE ${parsed.name} ADD COLUMN ${column.definition}`);
        summary.columnsAdded += 1;
      }
      continue;
    }
    // Compare COLUMN LISTS, never bodies: @cap-js/sqlite rewrites expressions such as
    // CURRENT_TIMESTAMP when it stores a view, so the stored text never equals the compiled text and
    // a body comparison would recreate those views on every boot. A view's columns are what a stale
    // definition gets wrong (it keeps the base table's old shape), and views hold no data.
    const current = live.views.get(parsed.name);
    const wanted = (parsed.columns ?? []).map((c) => c.name);
    if (current !== undefined && wanted.length > 0 && wanted.every((c) => current.has(c)) && current.size === wanted.length) continue;
    viewStatements.push(`DROP VIEW IF EXISTS ${parsed.name}`, String(statement).replace(/;\s*$/, ''));
    summary.viewsRecreated += 1;
  }
  return { statements: [...tableStatements, ...viewStatements], summary };
}

export interface HealResult { applied: number; failed: { statement: string; error: string }[]; summary: HealSummary; }

/** Runs a plan statement by statement: one rejection is reported, the rest still run. Never throws. */
export async function applySqliteHeal(db: { run: (sql: string) => Promise<any> }, plan: HealPlan): Promise<HealResult> {
  const result: HealResult = { applied: 0, failed: [], summary: plan.summary };
  for (const statement of plan.statements) {
    try {
      await db.run(statement);
      result.applied += 1;
    } catch (error) {
      result.failed.push({ statement: statement.slice(0, 120), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** True only for a file-backed SQLite database: in-memory tests and PostgreSQL are left alone. */
export function healableSqliteFile(dbConfig: any): boolean {
  if (!dbConfig || dbConfig.kind !== 'sqlite') return false;
  const url = dbConfig.credentials?.url;
  return typeof url === 'string' && url.length > 0 && url !== ':memory:' && !url.startsWith(':');
}

export async function readLiveSchema(db: { run: (sql: string) => Promise<any> }): Promise<LiveSchema> {
  const objects = await db.run("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view')");
  const tables = new Map<string, Set<string>>();
  const views = new Map<string, Set<string>>();
  for (const row of objects ?? []) {
    const columns = await db.run(`SELECT name FROM pragma_table_info('${row.name}')`);
    const names = new Set<string>((columns ?? []).map((c: any) => c.name));
    if (row.type === 'view') views.set(row.name, names); else tables.set(row.name, names);
  }
  return { tables, views };
}

/** The whole step: read the live schema, plan additively against the compiled DDL, apply. */
export async function healSqliteSchema(db: { run: (sql: string) => Promise<any> }, compiled: string[]): Promise<HealResult> {
  const live = await readLiveSchema(db);
  return applySqliteHeal(db, planSqliteHeal(compiled, live));
}
