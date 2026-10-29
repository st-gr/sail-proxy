/**
 * Pure helpers for the Cost tab's SAP tenant selector (SAP bills per subaccount, so an invoice is
 * compared with one tenant's usage). No UI5 imports, so jest runs it.
 */
export interface TenantRow {
  zone: string;
  displayName?: string | null;
}

export interface TenantOption {
  key: string;
  text: string;
}

export interface TenantOptions {
  options: TenantOption[];
  /** The Select shows only when there is a choice, that is with more than one tenant. */
  visible: boolean;
  /** The preselected key: the only tenant, else "" (all tenants). */
  selected: string;
}

/** SapTenants is admin-only on the server: only an admin reads it (any other viewer would log a 403). */
export function readsSapTenants(userContext: { isAdmin?: boolean } | null | undefined): boolean {
  return userContext?.isAdmin === true;
}

/** The list filters narrowing a SAP figure to one tenant; none for all tenants. */
export function tenantFilter(tenant: string | null | undefined): Array<{ path: string; operator: string; value1: string }> {
  return tenant ? [{ path: 'sapTenant', operator: 'EQ', value1: tenant }] : [];
}

/** The Select items (displayName or zone, by name) behind the "All tenants" entry. */
export function tenantOptions(tenants: TenantRow[], allText = ''): TenantOptions {
  const named = tenants
    .map((t) => ({ key: t.zone, text: t.displayName || t.zone }))
    .sort((a, b) => a.text.localeCompare(b.text));
  if (named.length <= 1) return { options: named, visible: false, selected: named[0]?.key ?? '' };
  return { options: [{ key: '', text: allText }, ...named], visible: true, selected: '' };
}

/**
 * The stats views hold a row per key and tenant; with all tenants selected one row per key is shown,
 * so the numeric fields of a key's rows are summed (currency-neutral fields only).
 */
export function foldByApiKey(rows: Array<Record<string, any>>, fields: string[]): Array<Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const { sapTenant: _tenant, ...rest } = row;
    const kept = out.get(row.apiKey_ID);
    if (!kept) {
      out.set(row.apiKey_ID, { ...rest, ...Object.fromEntries(fields.map((f) => [f, Number(row[f]) || 0])) });
      continue;
    }
    for (const f of fields) kept[f] += Number(row[f]) || 0;
  }
  return [...out.values()];
}

export interface CurrencyFigure {
  currency: string;
  cost: number;
}

export interface RowCost {
  /** The one figure, only when the key was billed in a single currency. */
  sapCost: number | null;
  sapCostCurrency: string | null;
  sapCostByCurrency: CurrencyFigure[];
}

const byCurrency = (totals: Map<string, number>): CurrencyFigure[] =>
  [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cost]) => ({ currency, cost }));

/** A key's SAP cost per currency over all its tenants; unpriced rows (no currency) add nothing. */
export function costFiguresByKey(rows: Array<Record<string, any>>): Record<string, CurrencyFigure[]> {
  const maps = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row.sapCostCurrency) continue;
    const totals = maps.get(row.apiKey_ID) ?? new Map<string, number>();
    totals.set(row.sapCostCurrency, (totals.get(row.sapCostCurrency) ?? 0) + (Number(row.totalSapCost) || 0));
    maps.set(row.apiKey_ID, totals);
  }
  return Object.fromEntries([...maps.entries()].map(([key, totals]) => [key, byCurrency(totals)]));
}

/** One table row's cost: the single figure for one currency, else only the per-currency figures. */
export function rowCost(figures: CurrencyFigure[] | undefined): RowCost {
  const list = figures ?? [];
  return list.length === 1
    ? { sapCost: list[0].cost, sapCostCurrency: list[0].currency, sapCostByCurrency: list }
    : { sapCost: null, sapCostCurrency: null, sapCostByCurrency: list };
}

/** The footer: per-currency totals of the rows, one figure only when there is a single currency. */
export function totalsCost(rows: RowCost[]): RowCost {
  const totals = new Map<string, number>();
  for (const row of rows) for (const f of row.sapCostByCurrency) totals.set(f.currency, (totals.get(f.currency) ?? 0) + f.cost);
  return rowCost(byCurrency(totals));
}

type Format = (cost: number, currency: string) => string;

/**
 * The SAP cost tile value: with several currencies one figure per currency (never summed), a single
 * currency exactly the single figure, none the empty state of the single figure.
 */
export function sapCostTileText(format: Format, total: number | null, currency: string | null, byCurrency: CurrencyFigure[] | undefined): string {
  if (byCurrency && byCurrency.length > 1) return byCurrency.map((f) => format(f.cost, f.currency)).join(" | ");
  return total === null || total === undefined ? "" : format(total, currency || "");
}

/** The currency named in the tile subheader: all currencies when several, else the one (USD until known). */
export function sapCostTileCurrencies(currency: string | null, byCurrency: CurrencyFigure[] | undefined): string {
  if (byCurrency && byCurrency.length > 1) return byCurrency.map((f) => f.currency).join(", ");
  return currency || "USD";
}

export interface ConnectionRow {
  name: string;
  title?: string | null;
  providerType?: string | null;
}

/** The Connection Select: "All connections" and each connection with external usage (title or name); hidden without any. */
export function connectionOptions(connections: ConnectionRow[], usedNames: string[], allText = ''): { options: TenantOption[]; visible: boolean } {
  const byName = new Map(connections.map((c) => [c.name, c]));
  const named = usedNames
    .filter((name) => byName.get(name)?.providerType !== 'sap-ai-core')
    .map((name) => ({ key: name, text: byName.get(name)?.title || name }))
    .sort((a, b) => a.text.localeCompare(b.text));
  return named.length ? { options: [{ key: '', text: allText }, ...named], visible: true } : { options: [], visible: false };
}

/** The getUsageStatistics parameters of the two independent filters; an empty one is left out. */
export function usageParams(tenant: string | null | undefined, connection: string | null | undefined): { tenant?: string; connection?: string } {
  return { ...(tenant ? { tenant } : {}), ...(connection ? { connection } : {}) };
}
