/**
 * The SAP billing table and its footer (the "SAP Cost" tile) from getUsageStatistics.sapBilling:
 * rows for the chosen Time Period, one per credential and currency, API keys and AWS credentials.
 * No UI5 imports, so jest runs it.
 */
import { costFiguresByKey, rowCost, totalsCost, RowCost } from "./tenantFilter";

export interface SapBillingCredentialRow {
  credentialType: string;
  credentialId: string;
  name?: string | null;
  sapCostCurrency: string | null;
  [figure: string]: unknown;
}

const NEUTRAL = ["totalImageInputTokens", "totalImageOutputTokens", "totalAudioInputTokens", "totalAudioOutputTokens", "totalGenAiTokens", "totalCapacityUnits"];
const sum = (rows: Array<Record<string, any>>, field: string): number => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);

export function sapBillingTable(
  credentials: SapBillingCredentialRow[],
  owners: Record<string, { name?: string; email?: string }>
): { rows: Array<Record<string, any>>; totals: Record<string, any> } {
  // The currency-neutral figures of a credential are summed over its currencies (and unpriced rows).
  const byId = new Map<string, Record<string, any>>();
  for (const c of credentials) {
    const kept = byId.get(c.credentialId) ?? {
      apiKey_ID: c.credentialId, credentialType: c.credentialType,
      // An API key shows its owner; an AWS credential has only its own name.
      apiKeyName: owners[c.credentialId]?.name ?? c.name ?? undefined,
      apiKeyEmail: owners[c.credentialId]?.email,
      ...Object.fromEntries(NEUTRAL.map((f) => [f, 0])),
    };
    for (const f of NEUTRAL) kept[f] += Number(c[f]) || 0;
    byId.set(c.credentialId, kept);
  }
  // Per credential and currency, never one sum across currencies; unpriced rows add no figure.
  const costById = costFiguresByKey(credentials.map((c) => ({ apiKey_ID: c.credentialId, sapCostCurrency: c.sapCostCurrency, totalSapCost: c.totalSapCost })));
  const rows = [...byId.values()].map((row) => {
    const cost = rowCost(costById[row.apiKey_ID]);
    const cu = Number(row.totalCapacityUnits) || 0;
    // Capacity Units x Price per CU = SAP Cost, so the row can be reconciled.
    return { ...row, ...cost, pricePerCu: cost.sapCost != null && cu > 0 ? cost.sapCost / cu : null };
  });

  const cost = totalsCost(rows as unknown as RowCost[]);
  const totalCapacityUnits = sum(rows, "totalCapacityUnits");
  const totals = {
    ...Object.fromEntries(NEUTRAL.map((f) => [f, sum(rows, f)])),
    // One total only for a single currency; several are listed, never summed. No cost at all stays 0.
    totalSapCost: cost.sapCostByCurrency.length ? cost.sapCost : 0,
    sapCostByCurrency: cost.sapCostByCurrency,
    sapCostCurrency: cost.sapCostCurrency,
    pricePerCu: totalCapacityUnits > 0 && cost.sapCost ? cost.sapCost / totalCapacityUnits : null,
  };
  return { rows, totals };
}
