import { getDefaultLogger } from '@libs/logger';
import { billingCurrency } from '../../services/sapCapacityService';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

const PRICE = 'sap.llm.gateway.admin.SapCapacityUnitPrice';
const APPLIED = 'sap.llm.gateway.admin.SetupPriceApplied';
const END = '9999-12-31T23:59:59.999Z';

const USAGE_TYPES: Array<{ usageType: 'productive' | 'non-productive'; envKey: string }> = [
  { usageType: 'productive', envKey: 'SAP_CU_PRICE_PRODUCTIVE' },
  { usageType: 'non-productive', envKey: 'SAP_CU_PRICE_NON_PRODUCTIVE' }
];

/** A price the Decimal(10,6) column holds: positive, finite, at most 6 decimals after rounding. */
function parsePrice(raw: string | undefined): number | null {
  if (raw === undefined || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n * 1_000_000) / 1_000_000;
  return rounded > 0 && rounded < 10_000 ? rounded : null;
}

/**
 * Turns the setup scripts' capacity-unit prices (SAP_CU_PRICE_*) in a non-USD billing currency
 * into SapCapacityUnitPrice rows valid from `now`. A usage type is acted on only when its price or
 * currency differs from what SetupPriceApplied recorded, so rates edited later in the SAP Rates
 * app survive a restart. Price rows are only ever inserted, never updated or deleted. Returns the
 * number of rows inserted.
 */
export async function applySetupPriceRates(db: any, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<number> {
  const currency = billingCurrency(env);
  if (currency === 'USD') return 0;
  const { INSERT, SELECT, UPSERT } = cds.ql;
  let inserted = 0;
  for (const { usageType, envKey } of USAGE_TYPES) {
    const raw = env[envKey];
    const price = parsePrice(raw);
    if (price === null) {
      if (raw !== undefined && String(raw).trim() !== '') logger.warn('setupPriceRates', `${envKey} is not a valid price; ignored`);
      continue;
    }
    const [done] = await db.run(SELECT.from(APPLIED).where({ usageType }));
    if (done && done.currency === currency && Number(done.pricePerCu) === price) continue;
    await db.run(INSERT.into(PRICE).entries({
      dateFrom: now.toISOString(), dateTo: END, pricePerCu: price, currency, usageType
    }));
    await db.run(UPSERT.into(APPLIED).entries({ usageType, currency, pricePerCu: price }));
    inserted++;
  }
  return inserted;
}
