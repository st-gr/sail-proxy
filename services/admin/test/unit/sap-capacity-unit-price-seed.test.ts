import { SAP_CU_PRICE_SEED } from '../../src/db/data/sap-capacity-unit-price-seed';

describe('SapCapacityUnitPrice seed', () => {
  it('seeds both usage types for the Extended plan', () => {
    const nonprod = SAP_CU_PRICE_SEED.find(r => r.usageType === 'non-productive');
    const prod = SAP_CU_PRICE_SEED.find(r => r.usageType === 'productive');
    expect(nonprod?.pricePerCu).toBe(1.20);
    expect(prod?.pricePerCu).toBe(1.38);
    expect(nonprod?.currency).toBe('USD');
  });

  it('keeps non-productive as a temporal series (1.23 then 1.20)', () => {
    const series = SAP_CU_PRICE_SEED.filter(r => r.usageType === 'non-productive')
      .sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));
    expect(series.map(r => r.pricePerCu)).toEqual([1.23, 1.20]);
    // temporal windows do not overlap
    expect(series[0].dateTo < series[1].dateFrom).toBe(true);
  });
});
