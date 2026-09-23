import { toQuotaView } from '../webapp/model/quotaDisplay';

const status = (over: any = {}) => ({
  email: 'u@test.com', status: 'active', roles: ['user'],
  limits: { requestsPerMinute: 60, spendPerDay: null, spendPerWeek: null, spendPerMonth: 20, tokensPerDay: 1000, tokensPerWeek: null, tokensPerMonth: 50000 },
  used: { minuteRequests: 12, day: { requests: 3, tokens: 900, sapCost: 0.4 }, week: { requests: 3, tokens: 900, sapCost: 0.4 }, month: { requests: 30, tokens: 15000, sapCost: 4.5 } },
  resetsAt: { day: '2026-09-17T00:00:00.000Z', week: '2026-09-21T00:00:00.000Z', month: '2026-10-01T00:00:00.000Z' },
  ...over
});

describe('toQuotaView', () => {
  it('renders used / limit rows with percentages and states, "unlimited" without a limit', () => {
    const v = toQuotaView(status());
    expect(v.available).toBe(true);
    expect(v.deactivated).toBe(false);
    const byKey = Object.fromEntries(v.rows.map((r) => [r.key, r]));
    expect(byKey.requestsMinute).toBeUndefined();
    expect(v.rows.map((r) => r.key)).toEqual(['spendDay', 'spendWeek', 'spendMonth', 'tokensDay', 'tokensWeek', 'tokensMonth']);
    expect(byKey.tokensDay).toMatchObject({ used: '900', limit: '1,000', percent: 90, state: 'Error' });
    expect(byKey.spendDay).toMatchObject({ label: 'Spend today', used: '0.40 USD', limit: 'unlimited', percent: 0, unlimited: true, state: 'None' });
    expect(byKey.spendMonth).toMatchObject({ label: 'Spend this month', used: '4.50 USD', limit: '20.00 USD', percent: 23, state: 'Success' });
    expect(byKey.tokensMonth).toMatchObject({ percent: 30, state: 'Success' });
  });
  it('warns from 75 %, errors from 90 %, caps at 100 %', () => {
    const v = toQuotaView(status({ used: { minuteRequests: 48, day: { requests: 0, tokens: 2000, sapCost: 0 }, week: { requests: 0, tokens: 0, sapCost: 0 }, month: { requests: 0, tokens: 0, sapCost: 0 } } }));
    const byKey = Object.fromEntries(v.rows.map((r) => [r.key, r]));
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
  it('keeps the per-minute rate guard as one line of text, "unlimited" without a limit', () => {
    expect(toQuotaView(status()).minuteText).toBe('Requests this minute: 12 / 60');
    expect(toQuotaView(status({ limits: { ...status().limits, requestsPerMinute: null } })).minuteText).toBe('Requests this minute: 12 / unlimited');
    // counts are grouped like the token rows, and an unavailable status has no line at all
    expect(toQuotaView(status({ limits: { ...status().limits, requestsPerMinute: 2000 }, used: { ...status().used, minuteRequests: 1234 } })).minuteText)
      .toBe('Requests this minute: 1,234 / 2,000');
    expect(toQuotaView(null).minuteText).toBe('');
  });
  it('a deactivated account and a missing status', () => {
    expect(toQuotaView(status({ status: 'deactivated' }))).toMatchObject({ deactivated: true, statusText: 'Your account is deactivated. Contact an administrator.' });
    expect(toQuotaView(null)).toMatchObject({ available: false, rows: [] });
  });
  it('carries the bullet-chart figures: target and scale for limited rows, thresholds at 75/90 %', () => {
    const byKey = Object.fromEntries(toQuotaView(status()).rows.map((r) => [r.key, r]));
    // tokensDay: 900 of 1,000 -> error colour, scale ends at the limit
    expect(byKey.tokensDay).toMatchObject({ actual: 900, target: 1000, max: 1000, color: 'Error', thresholds: [{ value: 750, color: 'Critical' }, { value: 900, color: 'Error' }] });
    // spendMonth: 4.5 of 20 -> good
    expect(byKey.spendMonth).toMatchObject({ actual: 4.5, target: 20, max: 20, color: 'Good' });
  });
  it('keeps an overshoot visible: the scale ends at the used amount when it exceeds the limit', () => {
    const v = toQuotaView(status({ used: { minuteRequests: 0, day: { requests: 0, tokens: 1300, sapCost: 0 }, week: { requests: 0, tokens: 0, sapCost: 0 }, month: { requests: 0, tokens: 0, sapCost: 0 } } }));
    const row = v.rows.find((r) => r.key === 'tokensDay')!;
    expect(row).toMatchObject({ actual: 1300, target: 1000, max: 1300, color: 'Error', percent: 100, percentText: '130 %' });
  });
  it('scales unlimited rows to 1.25 x the largest used value of the same unit, neutral, no target, no thresholds', () => {
    // spendDay and spendWeek are unlimited (0.4 each); tokensWeek is unlimited (900) beside limited
    // tokens rows. The scale ends a quarter above the largest bar, so that bar fills 80 %.
    const byKey = Object.fromEntries(toQuotaView(status()).rows.map((r) => [r.key, r]));
    expect(byKey.spendDay).toMatchObject({ actual: 0.4, target: null, max: 0.5, color: 'Neutral', thresholds: [], unlimited: true });
    expect(byKey.spendWeek).toMatchObject({ actual: 0.4, target: null, max: 0.5, color: 'Neutral' });
    expect(byKey.tokensWeek).toMatchObject({ actual: 900, target: null, max: 1125, color: 'Neutral' });
    // all-zero unlimited rows get a scale of 1 so the control still renders
    const zero = toQuotaView(status({ used: { minuteRequests: 0, day: { requests: 0, tokens: 0, sapCost: 0 }, week: { requests: 0, tokens: 0, sapCost: 0 }, month: { requests: 0, tokens: 0, sapCost: 0 } } }));
    expect(zero.rows.find((r) => r.key === 'spendDay')).toMatchObject({ actual: 0, max: 1, color: 'Neutral' });
  });
  it('colours turn at exactly 75 and 90 percent', () => {
    const at = (tokens: number) => toQuotaView(status({ used: { minuteRequests: 0, day: { requests: 0, tokens, sapCost: 0 }, week: { requests: 0, tokens: 0, sapCost: 0 }, month: { requests: 0, tokens: 0, sapCost: 0 } } })).rows.find((r) => r.key === 'tokensDay')!.color;
    expect(at(740)).toBe('Good');
    expect(at(750)).toBe('Critical');
    expect(at(899)).toBe('Critical');
    expect(at(900)).toBe('Error');
  });
  it('formats the reset time through the injected formatter, per window, and leaves it empty without a timestamp', () => {
    const seen: string[] = [];
    const v = toQuotaView(status(), undefined, (iso) => { seen.push(iso); return `at ${iso.slice(0, 10)}`; });
    const byKey = Object.fromEntries(v.rows.map((r) => [r.key, r]));
    expect(byKey.spendDay.resetText).toBe('Resets at 2026-09-17');
    expect(byKey.tokensWeek.resetText).toBe('Resets at 2026-09-21');
    expect(byKey.tokensMonth.resetText).toBe('Resets at 2026-10-01');
    expect(new Set(seen)).toEqual(new Set(['2026-09-17T00:00:00.000Z', '2026-09-21T00:00:00.000Z', '2026-10-01T00:00:00.000Z']));
    const none = toQuotaView(status({ resetsAt: undefined }));
    expect(none.rows.every((r) => r.resetText === '')).toBe(true);
  });
  it('groups the card by unit: a summary line per unit, chart rows only for limited windows, a no-limit note otherwise', () => {
    const v = toQuotaView(status(), undefined, (iso) => `at ${iso.slice(0, 10)}`);
    expect(v.groups.map((g) => g.key)).toEqual(['spend', 'tokens']);
    const [spend, tokens] = v.groups;
    expect(spend).toMatchObject({ label: 'Spend', summary: 'today 0.40 USD · this week 0.40 USD · this month 4.50 USD', noLimitText: '' });
    expect(spend.rows.map((r) => r.key)).toEqual(['spendMonth']);
    expect(spend.rows[0].percentText).toBe('23 %');
    expect(tokens.summary).toBe('today 900 · this week 900 · this month 15,000');
    expect(tokens.rows.map((r) => r.key)).toEqual(['tokensDay', 'tokensMonth']);
    expect(v.resetText).toBe('Windows reset · day at 2026-09-17 · week at 2026-09-21 · month at 2026-10-01');
    // every window still appears in rows (the popover and the journeys read them)
    expect(v.rows).toHaveLength(6);
  });
  it('renders the effective tool policy as one line', () => {
    const s: any = { status: 'active', limits: {}, used: { minuteRequests: 0, day: { requests: 0, tokens: 0, sapCost: 0 }, week: { requests: 0, tokens: 0, sapCost: 0 }, month: { requests: 0, tokens: 0, sapCost: 0 } }, toolPolicy: { name: 'Team', mode: 'strip' } };
    expect(toQuotaView(s).toolPolicyText).toBe('Tool policy: Team (strip)');
    delete s.toolPolicy;
    expect(toQuotaView(s).toolPolicyText).toBe('');
    expect(toQuotaView(null).toolPolicyText).toBe('');
  });
  it('says when a unit has no limits at all, and leaves the footer empty without reset timestamps', () => {
    const none = toQuotaView(status({ limits: { requestsPerMinute: null, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null }, resetsAt: undefined }));
    expect(none.groups[0]).toMatchObject({ noLimitText: 'No spend limits apply.', rows: [] });
    expect(none.groups[1]).toMatchObject({ noLimitText: 'No token limits apply.', rows: [] });
    expect(none.resetText).toBe('');
    expect(toQuotaView(null).groups).toEqual([]);
  });
});
