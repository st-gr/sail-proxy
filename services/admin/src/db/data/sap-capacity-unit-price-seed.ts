const cds = require('@sap/cds');

interface PriceRow {
  dateFrom: string; dateTo: string; pricePerCu: number; currency: string;
  servicePlan: string; usageType: 'productive' | 'non-productive'; region: string; sku: string;
}
const END = '9999-12-31T23:59:59.999Z';
// From the SAP BTP Enterprise Agreement price list, 07-02 Extended (confirm exact valid-from
// dates against the contract; the 2026-06-30 vs 2026-07-30 boundary is noted in the spec §9).
export const SAP_CU_PRICE_SEED: PriceRow[] = [
  // Current rows listed first so a plain `.find(usageType === ...)` resolves to the
  // in-force price rather than a superseded historical one.
  { dateFrom: '2026-07-30T00:00:00.000Z', dateTo: END, pricePerCu: 1.20, currency: 'USD', servicePlan: 'extended', usageType: 'non-productive', region: 'US', sku: '8017491' },
  { dateFrom: '2026-07-30T00:00:00.000Z', dateTo: END, pricePerCu: 1.38, currency: 'USD', servicePlan: 'extended', usageType: 'productive', region: 'US', sku: '8017491' },
  { dateFrom: '2026-04-23T00:00:00.000Z', dateTo: '2026-07-29T23:59:59.999Z', pricePerCu: 1.23, currency: 'USD', servicePlan: 'extended', usageType: 'non-productive', region: 'US', sku: '8017491' },
];

export async function seedSapCapacityUnitPrice(db: any): Promise<number> {
  const { INSERT, SELECT } = cds.ql;
  const existing = await db.run(SELECT.from('sap.llm.gateway.admin.SapCapacityUnitPrice').columns('usageType', 'dateFrom'));
  const have = new Set(existing.map((r: any) => `${r.usageType}|${r.dateFrom}`));
  const toInsert = SAP_CU_PRICE_SEED.filter(r => !have.has(`${r.usageType}|${r.dateFrom}`));
  if (toInsert.length) await db.run(INSERT.into('sap.llm.gateway.admin.SapCapacityUnitPrice').entries(toInsert));
  return toInsert.length;
}
