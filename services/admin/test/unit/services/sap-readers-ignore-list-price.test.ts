/**
 * The SAP-only readers must never see a Connection's list price or its external usage rows
 * (spec 2026-10-23 §6): getModelPricing, and the two SAP cost stats reads.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');

import { _lookupRate } from '../../../src/services/sapCapacityService';
import modelCostService from '../../../src/services/modelCostService';

const USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const COSTS = 'sap.llm.gateway.admin.ModelCosts';
const KEY_ID = uuidv4();

describe('SAP-only readers ignore Connection list prices and usage (real sqlite, un-mocked)', () => {
  let db: any;

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../../src/db/schema')).to(db);
    const { INSERT } = cds.ql;

    await db.run(INSERT.into(COSTS).entries({
      ID: uuidv4(), model: 'x--oa', dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '9999-12-31T23:59:59.999Z',
      inputCost: 7.5, outputCost: 9.5, provider: 'openai', source: 'manual', pricingKind: 'list_price', currency: 'EUR'
    }));

    // A priced external usage row: list cost set, the SAP columns null.
    await db.run(INSERT.into(USAGE).entries({
      ID: uuidv4(), apiKey_ID: KEY_ID, provider: 'openai', model: 'x--oa', origin: 'external',
      validFrom: '2026-03-10T00:00:00.000Z', validTo: '9999-12-31T23:59:59.999Z',
      inputTokens: 10, outputTokens: 5, inputCost: 0, outputCost: 0, totalCost: 0,
      listCost: 0.42, listCostCurrency: 'EUR'
    }));
  });

  it('getCachedPricing ignores a list price', async () => {
    const pricing = await (modelCostService as any).getCachedPricing('x--oa', new Date('2026-09-15T00:00:00Z'));
    expect(pricing).toBeNull();
  });

  it('_lookupRate ignores a list price under the same id', async () => {
    expect(await _lookupRate('x--oa', new Date('2026-09-15T00:00:00Z'))).toBeNull();
  });

  it('TeamSapBillingStats and ApiKeyUsageSapCostStats list no external row (guard: passes before the change)', async () => {
    const { SELECT } = cds.ql;
    const perKey = await db.run(SELECT.from('sap.llm.gateway.admin.ApiKeyUsageSapCostStats').where({ apiKey_ID: KEY_ID }));
    // An unpriced-by-SAP row groups under a null currency with a zero sum (as a legacy row does); the
    // list cost never reaches the view, so no currency row and no amount appears for the key.
    expect(perKey).toEqual([{ apiKey_ID: KEY_ID, sapCostCurrency: null, sapTenant: '', totalSapCost: 0 }]);

    // The TeamSapBillingStats read (admin-service-teams.ts) takes the same per-currency rows.
    const perTeam = await db.run(
      SELECT.from(USAGE).columns(['team_ID as teamId', 'sapCostCurrency', 'COALESCE(sum(sapCost), 0) as totalSapCost'])
        .where({ provider: { '!=': null }, sapCostCurrency: { '!=': null } }).groupBy('team_ID', 'sapCostCurrency')
    );
    expect(perTeam).toEqual([]);
  });
});
