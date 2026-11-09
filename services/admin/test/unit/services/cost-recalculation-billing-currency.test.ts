/** With SAP_BILLING_CURRENCY set, the recalculation SQL picks capacity-unit prices of that currency only. */
import { CostRecalculationService } from '../../../src/services/costRecalculationService';

const TABLE = 'sap_llm_gateway_admin_ApiKeyUsage';
const svc = () => new CostRecalculationService() as any;
const statements = () => [
  svc().buildUpdateSQL(TABLE, 'u.model = mc.model', true),
  svc().buildUpdateSQL(TABLE, 'u.model = mc.model', false),
  svc().buildTenantRepriceSQL(TABLE, false, 'productive', 'US'),
  svc().buildTenantRepriceSQL(TABLE, true, 'productive', null)
];

describe('billing currency in the recalculation SQL', () => {
  afterEach(() => { delete process.env.SAP_BILLING_CURRENCY; });

  it('limits every price lookup to the billing currency when it is set', () => {
    process.env.SAP_BILLING_CURRENCY = 'eur';
    for (const sql of statements()) expect(sql).toContain("p.currency = 'EUR'");
  });

  it('leaves the lookup open to any currency when it is unset', () => {
    for (const sql of statements()) expect(sql).not.toContain('p.currency =');
  });
});
