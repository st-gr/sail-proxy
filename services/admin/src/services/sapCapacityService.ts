import { getDefaultLogger } from '@libs/logger';
import * as fs from 'fs';
import * as path from 'path';
import { pricingTwins } from './pricingTwins';

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
      const p = path.resolve(__dirname, '../../api_config.json');
      _apiConfig = JSON.parse(fs.readFileSync(p, 'utf8')).api_config ?? {};
    } catch (error) {
      logger.error('sapCapacityService', 'Failed to load api_config.json', error instanceof Error ? error : new Error(String(error)));
      _apiConfig = {};
    }
  }
  return _apiConfig;
}

export function isProductive(): boolean {
  return apiConfig()?.platform?.billing?.productive === true;
}

export function getCacheBillingFactors(provider: string): { read: number; write: number } {
  const p = apiConfig()?.providers?.[provider] ?? {};
  const num = (v: any, d: number) => (typeof v === 'number' && v >= 0 ? v : d);
  return {
    read: num(p.sap_cache_read_token_billing_factor, 1),
    write: num(p.sap_cache_write_token_billing_factor, 1)
  };
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
      .where('model =', id, 'and dateFrom <=', iso, 'and dateTo >=', iso)
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

export async function _lookupPrice(usageType: string, at: Date): Promise<any | null> {
  const db = await cds.connect.to('db');
  const { SELECT } = cds.ql;
  const iso = at.toISOString();
  const rows = await db.run(
    SELECT.from('sap.llm.gateway.admin.SapCapacityUnitPrice')
      .where('usageType =', usageType, 'and dateFrom <=', iso, 'and dateTo >=', iso)
      .orderBy('dateFrom desc')
  );
  return rows?.[0] ?? null;
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
  const price = await (module.exports as any)._lookupPrice(usageType, input.at);
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
