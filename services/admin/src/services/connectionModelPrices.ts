/**
 * What a ConnectionModels read shows of its price: the list price in force now (ModelCosts rows of
 * pricingKind list_price) and, for the price dialog, a suggestion - the current price if there is
 * one, else LiteLLM's (USD installations only: the snapshot is in USD). One query per table for
 * the whole result, never one per row.
 */
import { suggestListPrice } from './listPriceSuggestion';
import { quotaCurrency } from './userQuotaService';

const cds = require('@sap/cds');
const CONNECTIONS = 'sap.llm.gateway.admin.ProviderConnections';
const CONNECTION_MODELS = 'sap.llm.gateway.admin.ConnectionModels';
const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

/** Fills the virtual price fields of the rows a read returned (one object or an array). */
export async function addPricesToModels(result: any, now: Date = new Date()): Promise<void> {
  const rows: any[] = (Array.isArray(result) ? result : [result]).filter((r) => r && r.ID);
  if (!rows.length) return;
  const { SELECT } = cds.ql;
  const models: any[] = await cds.run(SELECT.from(CONNECTION_MODELS).columns('ID', 'modelId', 'upstreamModel', 'connection_ID').where({ ID: { in: rows.map((r) => r.ID) } }));
  const byId = new Map(models.map((m) => [m.ID, m]));
  const connectionIds = [...new Set(models.map((m) => m.connection_ID))];
  const connections: any[] = connectionIds.length ? await cds.run(SELECT.from(CONNECTIONS).columns('ID', 'providerType').where({ ID: { in: connectionIds } })) : [];
  const providerOf = new Map(connections.map((c) => [c.ID, c.providerType]));
  const nowIso = now.toISOString();
  const modelIds = models.map((m) => m.modelId);
  const costs: any[] = modelIds.length ? await cds.run(SELECT.from(MODEL_COSTS)
    .columns('model', 'inputCost', 'outputCost', 'cacheReadInputCost', 'cacheCreationInputCost', 'currency')
    .where({ model: { in: modelIds } }).and({ pricingKind: 'list_price' }).and({ dateFrom: { '<=': nowIso } }).and({ dateTo: { '>': nowIso } })) : [];
  const priceOf = new Map(costs.map((c) => [c.model, c]));
  const usd = (await quotaCurrency(now)) === 'USD';
  for (const row of rows) {
    const model = byId.get(row.ID);
    const price = model ? priceOf.get(model.modelId) : undefined;
    row.isPriced = !!price;
    row.inputCost = num(price?.inputCost);
    row.outputCost = num(price?.outputCost);
    row.cacheReadCost = num(price?.cacheReadInputCost);
    row.cacheCreationCost = num(price?.cacheCreationInputCost);
    row.priceCurrency = price?.currency ?? null;
    const suggestion = price ? null : (usd && model ? suggestListPrice(providerOf.get(model.connection_ID), model.upstreamModel) : null);
    row.suggestedInputCost = price ? row.inputCost : suggestion?.inputCost ?? null;
    row.suggestedOutputCost = price ? row.outputCost : suggestion?.outputCost ?? null;
    row.suggestedCacheReadCost = price ? row.cacheReadCost : suggestion?.cacheReadCost ?? null;
    row.suggestedCacheCreationCost = price ? row.cacheCreationCost : suggestion?.cacheCreationCost ?? null;
  }
}

/** The expanded `models` of ProviderConnections rows get the same price fields, in one batch across all rows. */
export async function addPricesToExpandedModels(result: any, now: Date = new Date()): Promise<void> {
  const models = (Array.isArray(result) ? result : [result]).flatMap((c) => (Array.isArray(c?.models) ? c.models : []));
  await addPricesToModels(models, now);
}

/** Closes the open list-price rows of these models (history stays): a removed model leaves no live price behind. */
export async function closeListPrices(modelIds: string[], now: Date = new Date()): Promise<void> {
  if (!modelIds.length) return;
  const nowIso = now.toISOString();
  await cds.run(cds.ql.UPDATE(MODEL_COSTS).set({ dateTo: nowIso })
    .where({ model: { in: modelIds } }).and({ pricingKind: 'list_price' }).and({ dateTo: { '>': nowIso } }));
}
