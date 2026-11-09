/**
 * Billing currency, the USD seed skip, and the setup scripts' capacity-unit rates. In-memory db.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import { quotaCurrency } from '../../../src/services/userQuotaService';
import { seedSapCapacityUnitPrice } from '../../../src/db/data/sap-capacity-unit-price-seed';
import { applySetupPriceRates } from '../../../src/db/data/setup-price-rates';
import { billingCurrency, _lookupPrice } from '../../../src/services/sapCapacityService';

const PRICE = 'sap.llm.gateway.admin.SapCapacityUnitPrice';
const APPLIED = 'sap.llm.gateway.admin.SetupPriceApplied';
const T0 = new Date('2026-10-28T10:00:00.000Z');
const T1 = new Date('2026-11-02T10:00:00.000Z');
const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const EUR = { SAP_BILLING_CURRENCY: 'EUR', SAP_CU_PRICE_PRODUCTIVE: '1.25', SAP_CU_PRICE_NON_PRODUCTIVE: '1.10' };

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE } = cds.ql;
  await db.run(DELETE.from(PRICE));
  await db.run(DELETE.from(APPLIED));
});
const rows = () => db.run(cds.ql.SELECT.from(PRICE).orderBy('dateFrom'));

describe('billingCurrency', () => {
  it('trims and upper-cases, and falls back to USD', () => {
    expect(billingCurrency(env({ SAP_BILLING_CURRENCY: ' eur ' }))).toBe('EUR');
    expect(billingCurrency(env({}))).toBe('USD');
    expect(billingCurrency(env({ SAP_BILLING_CURRENCY: 'euro' }))).toBe('USD');
  });
});

describe('seed', () => {
  it('USD seeds the USD rows', async () => {
    expect(await seedSapCapacityUnitPrice(db, 'USD')).toBe(3);
    expect((await rows()).every((r: any) => r.currency === 'USD')).toBe(true);
  });
  it('EUR skips the USD seed', async () => {
    expect(await seedSapCapacityUnitPrice(db, 'EUR')).toBe(0);
    expect(await rows()).toHaveLength(0);
  });
});

describe('applySetupPriceRates', () => {
  it('EUR prices insert one row per usage type', async () => {
    expect(await applySetupPriceRates(db, env(EUR), T0)).toBe(2);
    const r = await rows();
    expect(r.map((x: any) => [x.usageType, x.currency, Number(x.pricePerCu)]).sort()).toEqual([
      ['non-productive', 'EUR', 1.1], ['productive', 'EUR', 1.25]
    ]);
    expect(r[0].dateFrom).toBe(T0.toISOString());
    expect(r[0].servicePlan).toBe('extended');
  });

  it('inserts nothing for USD', async () => {
    expect(await applySetupPriceRates(db, env({ ...EUR, SAP_BILLING_CURRENCY: 'USD' }), T0)).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('unchanged setup prices insert nothing on restart', async () => {
    await applySetupPriceRates(db, env(EUR), T0);
    expect(await applySetupPriceRates(db, env(EUR), T1)).toBe(0);
    expect(await rows()).toHaveLength(2);
  });

  it('changed setup prices add rows from now and leave older rows', async () => {
    await applySetupPriceRates(db, env(EUR), T0);
    expect(await applySetupPriceRates(db, env({ ...EUR, SAP_CU_PRICE_PRODUCTIVE: '1.40' }), T1)).toBe(1);
    const r = await rows();
    expect(r).toHaveLength(3);
    expect(r.filter((x: any) => x.dateFrom === T0.toISOString())).toHaveLength(2);
    expect(Number((await _lookupPrice('productive', new Date('2026-11-03T00:00:00Z'))).pricePerCu)).toBe(1.4);
    expect(Number((await _lookupPrice('productive', new Date('2026-10-30T00:00:00Z'))).pricePerCu)).toBe(1.25);
  });

  it('a rate edited in the Rates app is not overwritten on restart', async () => {
    await applySetupPriceRates(db, env(EUR), T0);
    await db.run(cds.ql.UPDATE(PRICE).set({ pricePerCu: 9.99 }).where({ usageType: 'productive' }));
    expect(await applySetupPriceRates(db, env(EUR), T1)).toBe(0);
    const prod = (await rows()).find((x: any) => x.usageType === 'productive');
    expect(Number(prod.pricePerCu)).toBe(9.99);
  });

  it('invalid price is ignored with a warning', async () => {
    const warn = jest.spyOn(require('@libs/logger').getDefaultLogger(), 'warn').mockImplementation(() => undefined);
    try {
      expect(await applySetupPriceRates(db, env({ ...EUR, SAP_CU_PRICE_PRODUCTIVE: 'abc', SAP_CU_PRICE_NON_PRODUCTIVE: '-1' }), T0)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(await rows()).toHaveLength(0);
    } finally { warn.mockRestore(); }
  });

  it('_lookupPrice returns the new EUR row', async () => {
    await applySetupPriceRates(db, env(EUR), T0);
    const p = await _lookupPrice('non-productive', new Date('2026-10-29T00:00:00Z'), 'US');
    expect(p).toMatchObject({ currency: 'EUR', usageType: 'non-productive' });
    expect(Number(p.pricePerCu)).toBe(1.1);
  });
});

describe('price lookup follows the billing currency', () => {
  const AT = new Date('2026-11-03T00:00:00Z');
  afterEach(() => { delete process.env.SAP_BILLING_CURRENCY; });

  it('switching USD to EUR with prices: region and no-region lookups return the EUR row', async () => {
    await seedSapCapacityUnitPrice(db, 'USD');
    process.env.SAP_BILLING_CURRENCY = 'EUR';
    await applySetupPriceRates(db, env(EUR), new Date('2026-10-31T00:00:00Z'));
    for (const region of ['US', null]) {
      const p = await _lookupPrice('productive', AT, region);
      expect(p).toMatchObject({ currency: 'EUR' });
      expect(Number(p.pricePerCu)).toBe(1.25);
    }
  });

  it('EUR without prices: not priced, and quotaCurrency answers EUR', async () => {
    await seedSapCapacityUnitPrice(db, 'USD');
    process.env.SAP_BILLING_CURRENCY = 'EUR';
    expect(await _lookupPrice('productive', AT, 'US')).toBeNull();
    expect(await _lookupPrice('productive', AT)).toBeNull();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
    try { expect(await quotaCurrency(AT)).toBe('EUR'); } finally { nowSpy.mockRestore(); }
  });

  it('env unset with a hand-added EUR row: any currency counts, newest wins', async () => {
    await seedSapCapacityUnitPrice(db, 'USD');
    await db.run(cds.ql.INSERT.into(PRICE).entries({
      dateFrom: '2026-10-31T00:00:00.000Z', dateTo: '9999-12-31T23:59:59.999Z', pricePerCu: 2, currency: 'EUR', usageType: 'productive'
    }));
    expect(await _lookupPrice('productive', AT)).toMatchObject({ currency: 'EUR' });
    expect(await _lookupPrice('non-productive', AT, 'US')).toMatchObject({ currency: 'USD' });
  });

  it('a currency change with identical prices re-applies', async () => {
    await applySetupPriceRates(db, env(EUR), T0);
    expect(await applySetupPriceRates(db, env({ ...EUR, SAP_BILLING_CURRENCY: 'GBP' }), T1)).toBe(2);
    expect(await applySetupPriceRates(db, env({ ...EUR, SAP_BILLING_CURRENCY: 'GBP' }), T1)).toBe(0);
    expect((await rows()).filter((r: any) => r.currency === 'GBP')).toHaveLength(2);
  });
});
