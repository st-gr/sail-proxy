/**
 * List-price lookup for a Connection model's usage (sub-project C): the admin-maintained
 * list_price row in force at the request instant, never the current one and never an SAP GenAI row.
 * Real in-memory SQLite.
 */
import { join } from 'path';

const cds = require('@sap/cds');

import { listPriceAt, listCostOf } from '../../../src/services/externalUsagePricing';

const COSTS = 'sap.llm.gateway.admin.ModelCosts';
const OPEN_END = '9999-12-31T00:00:00.000Z';

describe('external usage pricing', () => {
  let db: any;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../../src/db/schema')).to(db);
  });
  beforeEach(async () => { await db.run(cds.ql.DELETE.from(COSTS)); });

  it('listCostOf charges cache tokens at their own rate, or the input rate when none is set', () => {
    const price = { inputCost: 0.15, outputCost: 0.6, cacheReadInputCost: 0.075, cacheCreationInputCost: null, currency: 'USD' };
    const cost = listCostOf(price, { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 2000, cacheCreationInputTokens: 100 });
    expect(cost).toBeCloseTo(0.615, 9);
  });

  it('listCostOf rounds to the 6 decimals of the stored column', () => {
    const price = { inputCost: 0.000123, outputCost: 0, cacheReadInputCost: null, cacheCreationInputCost: null, currency: 'USD' };
    // raw 7 * 0.000123 / 1000 = 8.61e-7
    expect(listCostOf(price, { inputTokens: 7, outputTokens: 0 })).toBe(0.000001);
    expect(listCostOf(price, { inputTokens: 3, outputTokens: 0 })).toBe(0);
  });

  it('listPriceAt returns the row in force at the instant, not the current one', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-06-01T00:00:00.000Z');
    await db.run(cds.ql.INSERT.into(COSTS).entries([
      { model: 'gpt-4o-mini--oa', dateFrom: t0.toISOString(), dateTo: t1.toISOString(), inputCost: 0.10, outputCost: 0.4, pricingKind: 'list_price', currency: 'USD' },
      { model: 'gpt-4o-mini--oa', dateFrom: t1.toISOString(), dateTo: OPEN_END, inputCost: 0.20, outputCost: 0.8, pricingKind: 'list_price', currency: 'USD' },
    ]));
    expect((await listPriceAt(db, 'gpt-4o-mini--oa', new Date(t1.getTime() - 1)))?.inputCost).toBeCloseTo(0.10, 9);
    expect((await listPriceAt(db, 'gpt-4o-mini--oa', t1))?.inputCost).toBeCloseTo(0.20, 9);
  });

  it('listPriceAt ignores SAP GenAI rows for the same id', async () => {
    await db.run(cds.ql.INSERT.into(COSTS).entries([
      { model: 'gpt-4o-mini--oa', dateFrom: '2026-01-01T00:00:00.000Z', dateTo: OPEN_END, inputCost: 2.5, outputCost: 10, pricingKind: 'sap_genai' },
    ]));
    expect(await listPriceAt(db, 'gpt-4o-mini--oa', new Date('2026-03-01T00:00:00.000Z'))).toBeNull();
  });
});
