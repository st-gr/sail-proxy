import { toHomeView } from '../webapp/model/homeTiles';

const summary = (over: any = {}) => ({
  scope: 'self', monthStart: '2026-09-01', requests: 1234, tokens: 987654, users: 1, sapCost: 12.5, sapCostCurrency: 'USD', otherCurrencies: [],
  ...over
});

describe('toHomeView', () => {
  it('scope self: requests, tokens and SAP cost tiles for the caller, no user count', () => {
    const v = toHomeView(summary());
    expect(v.available).toBe(true);
    expect(v.tiles.map((t) => t.key)).toEqual(['requests', 'tokens', 'sapCost']);
    const byKey = Object.fromEntries(v.tiles.map((t) => [t.key, t]));
    expect(byKey.requests).toMatchObject({ header: 'Requests', subheader: 'Your usage this month', value: '1,234' });
    expect(byKey.tokens).toMatchObject({ value: '987,654' });
    expect(byKey.sapCost).toMatchObject({ header: 'SAP cost', subheader: 'USD (Capacity-Unit billing)', value: '12.50 USD', footer: '' });
  });
  it('scope all: the same tiles for every user plus the user count', () => {
    const v = toHomeView(summary({ scope: 'all', users: 7 }));
    expect(v.tiles.map((t) => t.key)).toEqual(['requests', 'tokens', 'sapCost', 'users']);
    expect(v.tiles[0].subheader).toBe('All users, this month');
    expect(v.tiles[3]).toMatchObject({ header: 'Active users', value: '7' });
  });
  it('hands the injected formatters the raw numbers and the currency', () => {
    const v = toHomeView(summary({ sapCostCurrency: 'EUR' }), { int: (n) => `#${n}`, money: (n, c) => `${c}${n}` });
    const byKey = Object.fromEntries(v.tiles.map((t) => [t.key, t]));
    expect(byKey.requests.value).toBe('#1234');
    expect(byKey.sapCost).toMatchObject({ value: 'EUR12.5', subheader: 'EUR (Capacity-Unit billing)' });
  });
  it('names the currencies the cost figure leaves out, and defaults the currency to USD', () => {
    const v = toHomeView(summary({ sapCostCurrency: '', otherCurrencies: ['EUR', 'CHF'] }));
    const cost = v.tiles.find((t) => t.key === 'sapCost')!;
    expect(cost.subheader).toBe('USD (Capacity-Unit billing)');
    expect(cost.footer).toBe('Not included: EUR, CHF');
  });
  it('no summary (the request failed) means no tiles', () => {
    expect(toHomeView(null)).toEqual({ available: false, scopeText: '', tiles: [] });
    expect(toHomeView({} as any).available).toBe(false);
  });
});
