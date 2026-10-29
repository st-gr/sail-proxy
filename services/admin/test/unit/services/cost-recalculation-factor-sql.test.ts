/**
 * The cache billing factors reach the recalculation SQL as a CASE over the lower-cased row
 * provider. A configuration key written in mixed case ("Anthropic") still matches, and a factor
 * other than 1 shows up in the Postgres and the SQLite statement alike.
 */
jest.mock('../../../src/utils/apiConfigFile', () => ({
  ...jest.requireActual('../../../src/utils/apiConfigFile'),
  readApiConfigBlock: () => ({
    providers: {
      Anthropic: { sap_cache_read_token_billing_factor: 2, sap_cache_write_token_billing_factor: 1.25 },
      openai: { sap_cache_read_token_billing_factor: 1, sap_cache_write_token_billing_factor: 1 }
    }
  })
}));

import { CostRecalculationService } from '../../../src/services/costRecalculationService';
import { cacheBillingFactorsByProvider, getCacheBillingFactors } from '../../../src/services/sapCapacityService';

const TABLE = 'sap_llm_gateway_admin_ApiKeyUsage';

describe('cache billing factors in the recalculation SQL', () => {
  it('a mixed-case configuration key matches the row provider in any case', () => {
    expect(getCacheBillingFactors('anthropic')).toEqual({ read: 2, write: 1.25 });
    expect(getCacheBillingFactors('Anthropic')).toEqual({ read: 2, write: 1.25 });
    expect(getCacheBillingFactors('OpenAI')).toEqual({ read: 1, write: 1 });
  });

  it('the Postgres statement scales by CASE LOWER(u.provider)', () => {
    const sql: string = (new CostRecalculationService() as any)
      .buildUpdateSQL(TABLE, 'u.model = mc.model', true, cacheBillingFactorsByProvider());
    expect(sql).toContain("(CASE LOWER(u.provider) WHEN 'anthropic' THEN 2 ELSE 1 END)");
    expect(sql).toContain("(CASE LOWER(u.provider) WHEN 'anthropic' THEN 1.25 ELSE 1 END)");
    expect(sql).not.toContain("'openai'");
  });

  it('the SQLite statement scales by CASE LOWER(<table>.provider)', () => {
    const sql: string = (new CostRecalculationService() as any)
      .buildUpdateSQL(TABLE, 'u.model = mc.model', false, cacheBillingFactorsByProvider());
    expect(sql).toContain(`(CASE LOWER(${TABLE}.provider) WHEN 'anthropic' THEN 2 ELSE 1 END)`);
  });

  it('without a factor other than 1 the statement carries no CASE', () => {
    const sql: string = (new CostRecalculationService() as any)
      .buildUpdateSQL(TABLE, 'u.model = mc.model', true, new Map([['openai', { read: 1, write: 1 }]]));
    expect(sql).not.toContain('CASE LOWER');
  });
});
