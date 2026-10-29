import { getDefaultLogger } from '@libs/logger';
import { pricingTwins } from './pricingTwins';
import { readApiConfigBlock } from '../utils/apiConfigFile';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export interface SapNativeResult {
  genAiTokens: number;
  capacityUnits: number;
  sapCost: number | null;
  sapCostCurrency: string | null;
}

// Loaded once from api_config.json (same file the admin already reads for siem/platform).
let _apiConfig: any = null;
function apiConfig(): any {
  if (!_apiConfig) {
    try {
      _apiConfig = readApiConfigBlock();
    } catch (error) {
      logger.error('sapCapacityService', 'Failed to load api_config.json', error instanceof Error ? error : new Error(String(error)));
      _apiConfig = {};
    }
  }
  return _apiConfig;
}

/** The currency the SAP capacity-unit prices are billed in: SAP_BILLING_CURRENCY (three letters), else USD. */
export function billingCurrency(env: NodeJS.ProcessEnv = process.env): string {
  return explicitBillingCurrency(env) ?? 'USD';
}

/**
 * SAP_BILLING_CURRENCY when it is set to a valid code, else null. When set, price rows of other
 * currencies are not considered for cost; when null, any currency counts (instances that added
 * non-USD rows by hand keep working).
 */
export function explicitBillingCurrency(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = String(env.SAP_BILLING_CURRENCY ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

export function isProductive(): boolean {
  return apiConfig()?.platform?.billing?.productive === true;
}

/**
 * The cache billing factors every configured provider key carries, keyed by the lower-cased key.
 * The one place that decides which usage rows a factor applies to: live capture
 * (getCacheBillingFactors) and the nightly cost recalculation (a SQL CASE over the row's
 * provider) both resolve through it. A usage row's provider is the ModelCosts provider SAP
 * publishes for the model ("Anthropic"), the configuration key is lower case ("anthropic"), so the
 * match ignores case. Providers without an entry get 1.
 */
export function cacheBillingFactorsByProvider(): Map<string, { read: number; write: number }> {
  const num = (v: any, d: number) => (typeof v === 'number' && v >= 0 ? v : d);
  const out = new Map<string, { read: number; write: number }>();
  for (const [key, p] of Object.entries<any>(apiConfig()?.providers ?? {})) {
    const k = key.toLowerCase();
    if (out.has(k)) continue;
    out.set(k, {
      read: num(p?.sap_cache_read_token_billing_factor, 1),
      write: num(p?.sap_cache_write_token_billing_factor, 1)
    });
  }
  return out;
}

export function getCacheBillingFactors(provider: string): { read: number; write: number } {
  return cacheBillingFactorsByProvider().get(String(provider ?? '').toLowerCase()) ?? { read: 1, write: 1 };
}

// Seams (spied in tests, real in prod).
// GenAI tokens -> Capacity Units. SAP-confirmed uniform across bills (SAP Note 3437766). This
// is the DEFAULT/fallback; the effective factor is configurable via platform.billing.cuFactor.
export const SAP_CU_FACTOR = 1.90385;

// Effective CU conversion factor: platform.billing.cuFactor when set to a positive number, else
// the SAP_CU_FACTOR default. A single global value (not per usage type), read the same way as the
// productive flag and applied to every usage event's genAiTokens -> capacityUnits.
export function cuFactor(): number {
  const v = apiConfig()?.platform?.billing?.cuFactor;
  return typeof v === 'number' && v > 0 ? v : SAP_CU_FACTOR;
}

export async function _lookupRate(model: string, at: Date): Promise<any | null> {
  const db = await cds.connect.to('db');
  const { SELECT } = cds.ql;
  const iso = at.toISOString();
  // The per-model GenAI conversion rates (SAP Note 3437766: "GenAI tokens per 1,000 model
  // tokens") are the model discovery data the gateway already syncs from
  // /v2/lm/scenarios/foundation-models/models into ModelCosts - so they are sourced from
  // there rather than a hand-maintained table. ModelCosts stores per-1,000-token figures;
  // divide by 1,000 for the per-single-model-token rate computeSapNative multiplies by.
  const query = (id: string) => db.run(
    SELECT.from('sap.llm.gateway.admin.ModelCosts')
      .where('model =', id, "and (pricingKind is null or pricingKind <> 'list_price') and dateFrom <=", iso, 'and dateTo >=', iso)
      .orderBy('dateFrom desc')
  );
  // Try every id this model's price may be maintained under, in the same order as
  // modelCostService.getModelPricing (pricingTwins), so a deep-context call and the
  // deployment/bare-model fallback both resolve identically here.
  let rows: any[] | undefined;
  for (const id of pricingTwins(model)) {
    rows = await query(id);
    if (rows?.[0]) break;
  }
  const mc = rows?.[0];
  if (!mc) return null;
  const per1k = (v: any) => (v === null || v === undefined ? null : Number(v) / 1000);
  return {
    inputGenAiRate: per1k(mc.inputCost),
    outputGenAiRate: per1k(mc.outputCost),
    cacheReadGenAiRate: per1k(mc.cacheReadInputCost),
    cacheWriteGenAiRate: per1k(mc.cacheCreationInputCost),
    imageGenAiRate: null, // not published per model; computeSapNative falls back to input
    imageOutputGenAiRate: per1k(mc.imageOutputCost),
    audioInputGenAiRate: per1k(mc.audioInputCost),
    audioOutputGenAiRate: per1k(mc.audioOutputCost),
    cuFactor: cuFactor()
  };
}

/**
 * The capacity-unit price in force at `at` for the usage type. With a tenant's price region, a row
 * of that region is preferred; without one (or without such a row) the newest row of any region,
 * as before price regions existed.
 */
export async function _lookupPrice(usageType: string, at: Date, region: string | null = null): Promise<any | null> {
  const db = await cds.connect.to('db');
  const { SELECT } = cds.ql;
  const iso = at.toISOString();
  const currency = explicitBillingCurrency();
  let query = SELECT.from('sap.llm.gateway.admin.SapCapacityUnitPrice')
    .where({ usageType }).and({ dateFrom: { '<=': iso } }).and({ dateTo: { '>=': iso } });
  if (currency) query = query.and({ currency });
  const rows = await db.run(query.orderBy('dateFrom desc'));
  return (region ? rows?.find((r: any) => r.region === region) : undefined) ?? rows?.[0] ?? null;
}

export function _cacheFactors(provider: string): { read: number; write: number } {
  return getCacheBillingFactors(provider);
}

export async function computeSapNative(input: {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  at: Date;
  productive: boolean;
  /** The serving tenant's capacity-unit price region; null = any region. */
  priceRegion?: string | null;
}): Promise<SapNativeResult | null> {
  const rate = await (module.exports as any)._lookupRate(input.model, input.at);
  if (!rate) return null;

  const n = (v: any) => Number(v ?? 0);
  const inR = n(rate.inputGenAiRate);
  const outR = n(rate.outputGenAiRate ?? rate.inputGenAiRate);
  const crR = n(rate.cacheReadGenAiRate ?? rate.inputGenAiRate);
  const cwR = n(rate.cacheWriteGenAiRate ?? rate.inputGenAiRate);
  const imR = n(rate.imageGenAiRate ?? rate.inputGenAiRate);

  const f = (module.exports as any)._cacheFactors(input.provider);

  // Modality splits (image spec §3, audio spec §3): image and audio tokens are subsets of the
  // totals, priced at their manual GenAI rates when maintained, else the text rate of their
  // direction (itself falling back to input). The totals never change, only the split of their
  // GenAI-token contribution.
  const imageOut = Math.max(0, n(input.imageOutputTokens));
  const audioOut = Math.max(0, n(input.audioOutputTokens));
  const audioIn = Math.min(Math.max(0, n(input.audioInputTokens)), n(input.inputTokens));
  const textIn = Math.max(0, n(input.inputTokens) - audioIn);
  const textOut = Math.max(0, n(input.outputTokens) - imageOut - audioOut);
  const imgOutR = n(rate.imageOutputGenAiRate ?? rate.outputGenAiRate ?? rate.inputGenAiRate);
  const audInR = n(rate.audioInputGenAiRate ?? rate.inputGenAiRate);
  const audOutR = n(rate.audioOutputGenAiRate ?? rate.outputGenAiRate ?? rate.inputGenAiRate);

  const genAiTokens =
    textIn * inR + audioIn * audInR +
    textOut * outR + imageOut * imgOutR + audioOut * audOutR +
    (input.cacheReadInputTokens * f.read) * crR +
    (input.cacheCreationInputTokens * f.write) * cwR +
    input.imageInputTokens * imR;

  const capacityUnits = genAiTokens * n(rate.cuFactor);

  const usageType = input.productive ? 'productive' : 'non-productive';
  const price = await (module.exports as any)._lookupPrice(usageType, input.at, input.priceRegion ?? null);
  if (!price) {
    return { genAiTokens, capacityUnits, sapCost: null, sapCostCurrency: null };
  }

  return {
    genAiTokens,
    capacityUnits,
    sapCost: capacityUnits * n(price.pricePerCu),
    sapCostCurrency: price.currency ?? 'USD'
  };
}
