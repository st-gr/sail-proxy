/**
 * Invoice Reconciliation Service
 *
 * Administrator-facing reconciliation between what sail-proxy captured (per-request SAP-native
 * fields on ApiKeyUsage: capacityUnits, sapCost/sapCostCurrency, genAiTokens, cacheReadInputTokens,
 * cacheCreationInputTokens) and the operator-entered SAP invoice line items for the same billing
 * period. From that it backs out the implied calibration factors:
 *
 *   impliedCuFactor         = invoice.capacityUnits / invoice.genAiTokens
 *   impliedCacheReadFactor  = invoice.cacheReadInputTokens / capturedCacheReadInputTokens
 *   impliedCacheWriteFactor = invoice.cacheWriteInputTokens / capturedCacheWriteInputTokens
 *
 * These are SUGGESTIONS for the operator to review after the SAP inquiry — this service never
 * writes them anywhere. The operator sets sap_cache_*_token_billing_factor in api_config.json
 * themselves (spec Sec11.3).
 *
 * Only usage-driven line items are in scope for the CU comparison. Hourly-provisioning items
 * (Baseline CU, Infer-S Node Hour, Grounding, Observability) have no representation on
 * ApiKeyUsage — it is exclusively per-request accounting — so summing this table already
 * excludes them; there is nothing extra to filter (spec Sec3.4).
 */
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

const USAGE_ENTITY = 'sap.llm.gateway.admin.ApiKeyUsage';

export interface ReconciliationInvoice {
  genAiTokens?: number;
  capacityUnits?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ReconciliationInput {
  from: Date;
  to: Date;
  invoice?: ReconciliationInvoice;
}

export interface ReconciliationResult {
  capacityUnits: number;
  sapCostByCurrency: Record<string, number>;
  capturedGenAiTokens: number;
  capturedCacheReadInputTokens: number;
  capturedCacheWriteInputTokens: number;
  impliedCuFactor: number | null;
  impliedCacheReadFactor: number | null;
  impliedCacheWriteFactor: number | null;
}

// numerator/denominator both come from the caller (invoice figures, or invoice vs. captured);
// null whenever either side is missing or the denominator is zero — never divide by zero, never
// fabricate a factor from a partial invoice.
function impliedFactor(numerator: number | undefined, denominator: number | undefined): number | null {
  if (numerator === undefined || numerator === null) return null;
  if (!denominator) return null;
  return numerator / denominator;
}

export async function reconcile(input: ReconciliationInput): Promise<ReconciliationResult> {
  const db = await cds.connect.to('db');
  const { SELECT } = cds.ql;

  const fromIso = input.from.toISOString();
  const toIso = input.to.toISOString();

  const [totals] = await db.run(
    SELECT.from(USAGE_ENTITY)
      .where('validFrom >=', fromIso, 'and validFrom <=', toIso)
      .columns([
        'COALESCE(sum(capacityUnits), 0) as capacityUnits',
        'COALESCE(sum(genAiTokens), 0) as genAiTokens',
        'COALESCE(sum(cacheReadInputTokens), 0) as cacheReadInputTokens',
        'COALESCE(sum(cacheCreationInputTokens), 0) as cacheCreationInputTokens'
      ])
  );

  const currencyRows = await db.run(
    SELECT.from(USAGE_ENTITY)
      .where('validFrom >=', fromIso, 'and validFrom <=', toIso)
      .columns([
        'sapCostCurrency',
        'COALESCE(sum(sapCost), 0) as sapCost'
      ])
      .groupBy('sapCostCurrency')
  );

  const sapCostByCurrency: Record<string, number> = {};
  for (const row of currencyRows ?? []) {
    if (!row.sapCostCurrency) continue; // rows with no priced sapCost never resolved a currency
    sapCostByCurrency[row.sapCostCurrency] = Number(row.sapCost ?? 0);
  }

  const capacityUnits = Number(totals?.capacityUnits ?? 0);
  const capturedGenAiTokens = Number(totals?.genAiTokens ?? 0);
  const capturedCacheReadInputTokens = Number(totals?.cacheReadInputTokens ?? 0);
  const capturedCacheWriteInputTokens = Number(totals?.cacheCreationInputTokens ?? 0);

  const invoice = input.invoice ?? {};

  const result: ReconciliationResult = {
    capacityUnits,
    sapCostByCurrency,
    capturedGenAiTokens,
    capturedCacheReadInputTokens,
    capturedCacheWriteInputTokens,
    impliedCuFactor: impliedFactor(invoice.capacityUnits, invoice.genAiTokens),
    impliedCacheReadFactor: impliedFactor(invoice.cacheReadInputTokens, capturedCacheReadInputTokens),
    impliedCacheWriteFactor: impliedFactor(invoice.cacheWriteInputTokens, capturedCacheWriteInputTokens)
  };

  logger.info('ReconciliationService', 'Invoice reconciliation computed', {
    from: fromIso,
    to: toIso,
    capacityUnits: result.capacityUnits,
    impliedCuFactor: result.impliedCuFactor,
    impliedCacheReadFactor: result.impliedCacheReadFactor,
    impliedCacheWriteFactor: result.impliedCacheWriteFactor
  });

  return result;
}
