import { sapBillingTable } from '../webapp/model/sapBilling';

// getUsageStatistics.sapBilling.credentials: one row per credential and currency, for the chosen period.
const row = (credentialType: string, credentialId: string, name: string, sapCostCurrency: string | null, cu: number, cost: number, extra: Record<string, number> = {}) => ({
  credentialType, credentialId, name, sapCostCurrency, totalRequests: 1,
  totalImageInputTokens: 0, totalImageOutputTokens: 0, totalAudioInputTokens: 0, totalAudioOutputTokens: 0,
  totalGenAiTokens: cu * 10, totalCapacityUnits: cu, totalSapCost: cost, ...extra,
});

describe('sapBillingTable', () => {
  const owners = { 'k-1': { name: 'laptop', email: 'jane.roe@example.org' } };

  it('gives one table row per credential: neutral figures summed over its currencies, cost per currency', () => {
    const { rows } = sapBillingTable([
      row('apiKey', 'k-1', 'laptop', 'USD', 2, 1.5, { totalImageInputTokens: 7 }),
      row('apiKey', 'k-1', 'laptop', 'EUR', 3, 2.0),
      row('apiKey', 'k-1', 'laptop', null, 1, 0),          // unpriced: counted, adds no cost figure
    ], owners);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ apiKey_ID: 'k-1', apiKeyName: 'laptop', apiKeyEmail: 'jane.roe@example.org', totalCapacityUnits: 6, totalGenAiTokens: 60, totalImageInputTokens: 7 });
    expect(rows[0].sapCost).toBeNull();                    // two currencies: no single figure
    expect(rows[0].sapCostByCurrency).toEqual([{ currency: 'EUR', cost: 2 }, { currency: 'USD', cost: 1.5 }]);
    expect(rows[0].pricePerCu).toBeNull();
  });

  it('lists an AWS credential by its own name, and closes the row arithmetic for one currency', () => {
    const { rows } = sapBillingTable([row('awsCredential', 'c-9', 'aws-own', 'USD', 4, 3)], owners);
    expect(rows[0]).toMatchObject({ apiKey_ID: 'c-9', apiKeyName: 'aws-own', credentialType: 'awsCredential', sapCost: 3, sapCostCurrency: 'USD' });
    expect(rows[0].apiKeyEmail).toBeUndefined();
    expect(rows[0].pricePerCu).toBeCloseTo(0.75, 6);
  });

  it('totals: the tile\'s figure is the sum of the rows of the period, keys and AWS credentials together', () => {
    const { totals } = sapBillingTable([
      row('apiKey', 'k-1', 'laptop', 'USD', 2, 1.5),
      row('awsCredential', 'c-9', 'aws-own', 'USD', 4, 3),
    ], owners);
    expect(totals).toMatchObject({ totalSapCost: 4.5, sapCostCurrency: 'USD', totalCapacityUnits: 6, totalGenAiTokens: 60 });
    expect(totals.pricePerCu).toBeCloseTo(0.75, 6);
    expect(totals.sapCostByCurrency).toEqual([{ currency: 'USD', cost: 4.5 }]);
  });

  it('two currencies are listed, never summed into one figure; no rows give the empty state', () => {
    const two = sapBillingTable([row('apiKey', 'k-1', 'laptop', 'USD', 2, 1.5), row('apiKey', 'k-2', 'ci', 'EUR', 1, 2)], owners).totals;
    expect(two.sapCostCurrency).toBeNull();
    expect(two.sapCostByCurrency).toEqual([{ currency: 'EUR', cost: 2 }, { currency: 'USD', cost: 1.5 }]);
    const none = sapBillingTable([], owners);
    expect(none.rows).toEqual([]);
    expect(none.totals).toMatchObject({ totalSapCost: 0, sapCostByCurrency: [], sapCostCurrency: null, totalCapacityUnits: 0 });
  });
});
