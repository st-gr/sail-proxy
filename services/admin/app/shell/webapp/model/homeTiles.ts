/**
 * Pure view-model derivation for the shell's home tiles: this month's requests, tokens and SAP cost
 * from myUsageSummary(), plus the user count when the summary covers every user (administrators).
 * Display strings are produced here through injected formatters — the controller passes UI5's
 * locale-aware NumberFormat, jest passes none — so the module has no UI5 imports, like quotaDisplay.
 */
export interface UsageSummaryLike {
  scope: 'self' | 'all' | string;
  monthStart?: string;
  requests: number;
  tokens: number;
  users: number;
  sapCost: number;
  sapCostCurrency: string;
  otherCurrencies?: string[] | null;
}
export interface HomeTile {
  key: 'requests' | 'tokens' | 'sapCost' | 'users';
  header: string;
  subheader: string;
  value: string;
  footer: string;
  state: 'Neutral' | 'Good' | 'Critical';
}
export interface HomeView { available: boolean; scopeText: string; tiles: HomeTile[]; }
export interface HomeFormatters {
  int: (n: number) => string;
  money: (amount: number, currency: string) => string;
}

const defaultFormatters: HomeFormatters = {
  int: (n) => Math.round(n).toLocaleString('en-US'),
  money: (n, c) => `${n.toFixed(2)} ${c}`
};

export function toHomeView(s: UsageSummaryLike | null, fmt: HomeFormatters = defaultFormatters): HomeView {
  if (!s || typeof s.requests !== 'number') return { available: false, scopeText: '', tiles: [] };
  const all = s.scope === 'all';
  const scopeText = all ? 'All users, this month' : 'Your usage this month';
  const currency = s.sapCostCurrency || 'USD';
  const others = (s.otherCurrencies || []).filter(Boolean);
  const tiles: HomeTile[] = [
    { key: 'requests', header: 'Requests', subheader: scopeText, value: fmt.int(s.requests), footer: '', state: 'Neutral' },
    { key: 'tokens', header: 'Tokens', subheader: scopeText, value: fmt.int(s.tokens), footer: '', state: 'Neutral' },
    {
      key: 'sapCost', header: 'SAP cost', subheader: `${currency} (Capacity-Unit billing)`, value: fmt.money(s.sapCost, currency),
      // cost in another currency is not summed into the figure: say so rather than hide it
      footer: others.length ? `Not included: ${others.join(', ')}` : '', state: 'Critical'
    }
  ];
  if (all) tiles.push({ key: 'users', header: 'Active users', subheader: 'With usage this month', value: fmt.int(s.users), footer: '', state: 'Good' });
  return { available: true, scopeText, tiles };
}
