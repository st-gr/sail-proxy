/**
 * Pure fold of getUsageStatistics().connectionUsage for the Connections cost tile. Connection
 * prices are list prices in the currency the admin set per model, so the tile shows one figure per
 * currency and never sums across currencies. The unpriced requests (currency null) carry no cost.
 * No UI5 imports, so jest runs it.
 */
export interface ConnectionUsageRow {
  connection: string;
  provider: string;
  currency: string | null;
  totalRequests: number;
  totalTokens: number;
  totalListCost: number;
  unpricedRequests: number;
}

export interface CurrencyCost {
  currency: string;
  cost: number;
}

/** The Connection list cost per currency, in currency order; rows without a currency add nothing. */
export function costByCurrency(rows: ConnectionUsageRow[]): CurrencyCost[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.currency) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + (Number(row.totalListCost) || 0));
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cost]) => ({ currency, cost }));
}

export interface ConnectionChartState {
  connectionUsage: ConnectionUsageRow[];
  connectionCost: CurrencyCost[];
  hasConnectionUsage: boolean;
}

/** The view-model state for the Connections tile and panel; spread into the `/charts` node. */
export function connectionChartState(connectionUsage: ConnectionUsageRow[] | undefined): ConnectionChartState {
  const rows = connectionUsage || [];
  return { connectionUsage: rows, connectionCost: costByCurrency(rows), hasConnectionUsage: rows.length > 0 };
}

/**
 * The requests that ran on SAP AI Core: the overall total less the Connection requests. The token
 * cost estimate covers SAP requests only, so the average cost per request divides by this count.
 */
export function sapRequestCount(totalRequests: number, connectionUsage: ConnectionUsageRow[] | undefined): number {
  const connection = (connectionUsage || []).reduce((sum, r) => sum + (Number(r.totalRequests) || 0), 0);
  return Math.max(0, totalRequests - connection);
}

/** The average SAP cost per request: the token-cost estimate over the SAP requests, 0 when there are none. */
export function avgCostPerRequest(totalCost: number, totalRequests: number, connectionUsage: ConnectionUsageRow[] | undefined): number {
  const sapRequests = sapRequestCount(totalRequests, connectionUsage);
  return sapRequests > 0 ? totalCost / sapRequests : 0;
}
