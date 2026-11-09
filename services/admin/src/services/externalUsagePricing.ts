/**
 * List pricing of a Connection model's usage (sub-project C): the admin-maintained list_price row
 * in force at the request instant, in the price's own currency. The SAP GenAI columns are never
 * touched. Token counts are exclusive: cache read/creation tokens are not part of inputTokens.
 */
import type { UsageEvent } from './usageEventProcessor';
import { round } from './usageCounters';

const cds = require('@sap/cds');

const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';

export interface ListPrice {
  inputCost: number;
  outputCost: number;
  cacheReadInputCost: number | null;
  cacheCreationInputCost: number | null;
  currency: string;
}

/** The list price of a client-visible model id in force at `at` (dateFrom <= at < dateTo), or null. */
export async function listPriceAt(db: any, modelId: string, at: Date): Promise<ListPrice | null> {
  const instant = at.toISOString();
  const [row] = await db.run(
    cds.ql.SELECT.from(MODEL_COSTS)
      .columns('inputCost', 'outputCost', 'cacheReadInputCost', 'cacheCreationInputCost', 'currency')
      .where({ model: modelId, pricingKind: 'list_price' })
      .and({ dateFrom: { '<=': instant } })
      .and({ dateTo: { '>': instant } })
      .orderBy('dateFrom desc')
      .limit(1)
  );
  if (!row) return null;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    inputCost: Number(row.inputCost),
    outputCost: Number(row.outputCost),
    cacheReadInputCost: num(row.cacheReadInputCost),
    cacheCreationInputCost: num(row.cacheCreationInputCost),
    currency: row.currency
  };
}

/** Cost of the tokens at the price (per 1K tokens), rounded to the 6 decimals of the stored column; a cache rate that is not set falls back to the input rate. */
export function listCostOf(
  price: ListPrice,
  tokens: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
): number {
  const cacheRead = price.cacheReadInputCost ?? price.inputCost;
  const cacheCreation = price.cacheCreationInputCost ?? price.inputCost;
  return round(
    (tokens.inputTokens * price.inputCost +
      tokens.outputTokens * price.outputCost +
      (tokens.cacheReadInputTokens ?? 0) * cacheRead +
      (tokens.cacheCreationInputTokens ?? 0) * cacheCreation) / 1000
  );
}

/** The three list-cost columns of an external event's usage row. */
export async function priceExternalEvent(
  db: any,
  event: UsageEvent
): Promise<{ listCost: number | null; listCostCurrency: string | null; pricingMissing: boolean }> {
  const price = await listPriceAt(db, event.model, event.timestamp ? new Date(event.timestamp * 1000) : new Date());
  if (!price) return { listCost: null, listCostCurrency: null, pricingMissing: true };
  return { listCost: listCostOf(price, event), listCostCurrency: price.currency, pricingMissing: false };
}
