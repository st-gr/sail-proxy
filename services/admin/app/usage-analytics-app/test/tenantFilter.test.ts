import { readsSapTenants, tenantFilter, tenantOptions, foldByApiKey, costFiguresByKey, rowCost, totalsCost, sapCostTileText, sapCostTileCurrencies, connectionOptions, usageParams } from '../webapp/model/tenantFilter';

describe('tenantFilter', () => {
  it('is empty without a tenant', () => {
    expect(tenantFilter(undefined)).toEqual([]);
    expect(tenantFilter(null)).toEqual([]);
    expect(tenantFilter('')).toEqual([]);
  });
  it('is one equality filter on sapTenant with a tenant', () => {
    expect(tenantFilter('acme-dev')).toEqual([{ path: 'sapTenant', operator: 'EQ', value1: 'acme-dev' }]);
  });
});

// SapTenants is admin-only on the server: any other viewer makes no request (no 403 in the log).
describe('readsSapTenants', () => {
  it('only for an admin', () => {
    expect(readsSapTenants({ isAdmin: true })).toBe(true);
    expect(readsSapTenants({ isAdmin: false })).toBe(false);
    expect(readsSapTenants({})).toBe(false);
    expect(readsSapTenants(null)).toBe(false);
    expect(readsSapTenants(undefined)).toBe(false);
  });
});

describe('tenantOptions', () => {
  const t = (zone: string, displayName?: string | null) => ({ zone, displayName: displayName ?? null });
  it('is hidden with at most one tenant and preselects the only one', () => {
    expect(tenantOptions([])).toEqual({ options: [], visible: false, selected: '' });
    expect(tenantOptions([t('acme-dev', 'Development')])).toEqual({ options: [{ key: 'acme-dev', text: 'Development' }], visible: false, selected: 'acme-dev' });
  });
  it('with several tenants shows All tenants first, displayName or zone', () => {
    expect(tenantOptions([t('b', null), t('a', 'Alpha')], 'All tenants')).toEqual({
      options: [{ key: '', text: 'All tenants' }, { key: 'a', text: 'Alpha' }, { key: 'b', text: 'b' }], visible: true, selected: ''
    });
  });
});

describe('foldByApiKey', () => {
  it('sums the numeric fields of one key across tenants', () => {
    const rows = [
      { apiKey_ID: 'k', sapTenant: 'a', totalGenAiTokens: '1.5', totalCapacityUnits: 1 },
      { apiKey_ID: 'k', sapTenant: 'b', totalGenAiTokens: 2, totalCapacityUnits: 2 },
      { apiKey_ID: 'j', sapTenant: 'a', totalGenAiTokens: 4, totalCapacityUnits: 4 }
    ];
    expect(foldByApiKey(rows, ['totalGenAiTokens', 'totalCapacityUnits'])).toEqual([
      { apiKey_ID: 'k', totalGenAiTokens: 3.5, totalCapacityUnits: 3 },
      { apiKey_ID: 'j', totalGenAiTokens: 4, totalCapacityUnits: 4 }
    ]);
  });
});

describe('SAP cost per currency (never one sum across currencies)', () => {
  const rows = [
    { apiKey_ID: 'k', sapTenant: 'a', sapCostCurrency: 'USD', totalSapCost: '2' },
    { apiKey_ID: 'k', sapTenant: 'b', sapCostCurrency: 'EUR', totalSapCost: 5 },
    { apiKey_ID: 'k', sapTenant: 'c', sapCostCurrency: 'USD', totalSapCost: 1 },
    { apiKey_ID: 'k', sapTenant: '', sapCostCurrency: null, totalSapCost: 0 },
    { apiKey_ID: 'j', sapTenant: 'a', sapCostCurrency: 'USD', totalSapCost: 4 }
  ];
  it('two currencies give two figures per key, same currency is summed', () => {
    const by = costFiguresByKey(rows);
    expect(by.k).toEqual([{ currency: 'EUR', cost: 5 }, { currency: 'USD', cost: 3 }]);
    expect(by.j).toEqual([{ currency: 'USD', cost: 4 }]);
  });
  it('a row shows one figure only for a single currency', () => {
    const by = costFiguresByKey(rows);
    expect(rowCost(by.j)).toEqual({ sapCost: 4, sapCostCurrency: 'USD', sapCostByCurrency: [{ currency: 'USD', cost: 4 }] });
    expect(rowCost(by.k)).toEqual({ sapCost: null, sapCostCurrency: null, sapCostByCurrency: by.k });
    expect(rowCost(undefined)).toEqual({ sapCost: null, sapCostCurrency: null, sapCostByCurrency: [] });
  });
  it('the footer totals per currency and shows one figure only for one currency', () => {
    const by = costFiguresByKey(rows);
    const mixed = totalsCost([rowCost(by.k), rowCost(by.j)]);
    expect(mixed).toEqual({ sapCost: null, sapCostCurrency: null, sapCostByCurrency: [{ currency: 'EUR', cost: 5 }, { currency: 'USD', cost: 7 }] });
    expect(totalsCost([rowCost(by.j)])).toEqual({ sapCost: 4, sapCostCurrency: 'USD', sapCostByCurrency: [{ currency: 'USD', cost: 4 }] });
  });
});

describe('the SAP cost tile', () => {
  const fmt = (c: number, cur: string) => `${c.toFixed(2)} ${cur || 'USD'}`;
  it('one currency is the single figure, as before', () => {
    expect(sapCostTileText(fmt, 4, 'EUR', [{ currency: 'EUR', cost: 4 }])).toBe('4.00 EUR');
    expect(sapCostTileCurrencies('EUR', [{ currency: 'EUR', cost: 4 }])).toBe('EUR');
  });
  it('two currencies give both figures, never a sum, and name both currencies', () => {
    const by = [{ currency: 'EUR', cost: 5 }, { currency: 'USD', cost: 7 }];
    expect(sapCostTileText(fmt, null, null, by)).toBe('5.00 EUR | 7.00 USD');
    expect(sapCostTileCurrencies(null, by)).toBe('EUR, USD');
  });
  it('no cost keeps the empty state', () => {
    expect(sapCostTileText(fmt, null, null, [])).toBe('');
    expect(sapCostTileText(fmt, null, null, undefined)).toBe('');
    expect(sapCostTileCurrencies(null, [])).toBe('USD');
  });
});

describe('connection options and usage parameters', () => {
  const conns = [
    { name: 'oa', title: 'OpenAI prod', providerType: 'openai' },
    { name: 'sap1', title: null, providerType: 'sap-ai-core' },
    { name: 'az', title: null, providerType: 'azure-openai' },
    { name: 'idle', title: 'No usage', providerType: 'openai' }
  ];
  it('lists the connections with usage by title or name, behind All connections; hidden without any', () => {
    expect(connectionOptions(conns, ['oa', 'az', 'sap1'], 'All connections')).toEqual({
      options: [{ key: '', text: 'All connections' }, { key: 'az', text: 'az' }, { key: 'oa', text: 'OpenAI prod' }], visible: true
    });
    expect(connectionOptions(conns, [], 'All connections')).toEqual({ options: [], visible: false });
    expect(connectionOptions(conns, ['sap1'], 'All connections')).toEqual({ options: [], visible: false });
  });
  it('a name without a connection row is shown by name', () => {
    expect(connectionOptions([], ['gone'], 'All').options[1]).toEqual({ key: 'gone', text: 'gone' });
  });
  it('without connection rows (a non-admin viewer) the options are the raw names, sorted, behind All connections', () => {
    expect(connectionOptions([], ['oa', 'az'], 'All connections')).toEqual({
      options: [{ key: '', text: 'All connections' }, { key: 'az', text: 'az' }, { key: 'oa', text: 'oa' }], visible: true
    });
  });
  it('builds the tenant and the connection parameters independently', () => {
    expect(usageParams('', '')).toEqual({});
    expect(usageParams('acme-dev', '')).toEqual({ tenant: 'acme-dev' });
    expect(usageParams('', 'oa')).toEqual({ connection: 'oa' });
    expect(usageParams('acme-dev', 'oa')).toEqual({ tenant: 'acme-dev', connection: 'oa' });
  });
});
