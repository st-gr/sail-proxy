import { toQuotaView } from '../webapp/model/quotaDisplay';

const status = (over: any = {}) => ({
  email: 'u@test.com', status: 'active', roles: ['user'],
  limits: { requestsPerMinute: 60, spendPerDay: null, spendPerWeek: null, spendPerMonth: 20, tokensPerDay: 1000, tokensPerWeek: null, tokensPerMonth: 50000 },
  used: { minuteRequests: 12, day: { requests: 3, tokens: 900, sapCost: 0.4 }, week: { requests: 3, tokens: 900, sapCost: 0.4 }, month: { requests: 30, tokens: 15000, sapCost: 4.5 } },
  ...over
});

describe('toQuotaView', () => {
  it('renders used / limit rows with percentages and states, "unlimited" without a limit', () => {
    const v = toQuotaView(status());
    expect(v.available).toBe(true);
    expect(v.deactivated).toBe(false);
    const byKey = Object.fromEntries(v.rows.map((r) => [r.key, r]));
    expect(byKey.requestsMinute).toMatchObject({ used: '12', limit: '60', percent: 20, unlimited: false, state: 'Success' });
    expect(byKey.tokensDay).toMatchObject({ used: '900', limit: '1,000', percent: 90, state: 'Error' });
    expect(byKey.spendDay).toMatchObject({ label: 'Spend today', used: '0.40 USD', limit: 'unlimited', percent: 0, unlimited: true, state: 'None' });
    expect(byKey.spendMonth).toMatchObject({ label: 'Spend this month', used: '4.50 USD', limit: '20.00 USD', percent: 23, state: 'Success' });
    expect(byKey.tokensMonth).toMatchObject({ percent: 30, state: 'Success' });
  });
  it('warns from 75 %, errors from 90 %, caps at 100 %', () => {
    const v = toQuotaView(status({ used: { minuteRequests: 48, day: { requests: 0, tokens: 2000, sapCost: 0 }, week: { requests: 0, tokens: 0, sapCost: 0 }, month: { requests: 0, tokens: 0, sapCost: 0 } } }));
    const byKey = Object.fromEntries(v.rows.map((r) => [r.key, r]));
    expect(byKey.requestsMinute).toMatchObject({ percent: 80, state: 'Warning' });
    expect(byKey.tokensDay).toMatchObject({ percent: 100, state: 'Error' });
    // nothing spent: a bare 0, no currency to name
    expect(byKey.spendDay).toMatchObject({ used: '0', limit: 'unlimited' });
    expect(byKey.spendMonth).toMatchObject({ used: '0', limit: '20.00 USD' });
  });
  it('puts the status currency on every non-zero spend figure, USD when the server sends none, through the injected formatter', () => {
    const byKey = (v: ReturnType<typeof toQuotaView>) => Object.fromEntries(v.rows.map((r) => [r.key, r]));
    expect(byKey(toQuotaView(status({ sapCostCurrency: 'CHF' }))).spendDay.used).toBe('0.40 CHF');
    expect(byKey(toQuotaView(status())).spendDay.used).toBe('0.40 USD');

    const seen: string[] = [];
    const eur = byKey(toQuotaView(status({ sapCostCurrency: 'EUR' }), (n, c) => { seen.push(c); return `${c} ${n.toFixed(1)}`; }));
    expect(eur.spendMonth).toMatchObject({ label: 'Spend this month', used: 'EUR 4.5', limit: 'EUR 20.0' });
    expect(new Set(seen)).toEqual(new Set(['EUR']));
    // the token and request rows never go through the money formatter
    expect(eur.tokensDay.used).toBe('900');
  });
  it('a deactivated account and a missing status', () => {
    expect(toQuotaView(status({ status: 'deactivated' }))).toMatchObject({ deactivated: true, statusText: 'Your account is deactivated. Contact an administrator.' });
    expect(toQuotaView(null)).toMatchObject({ available: false, rows: [] });
  });
});
