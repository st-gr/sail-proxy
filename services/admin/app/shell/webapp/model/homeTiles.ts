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
  externalCost?: number;
  sapCostCurrency: string;
  otherCurrencies?: string[] | null;
}
export interface HomeTile {
  key: 'requests' | 'tokens' | 'sapCost' | 'externalCost' | 'users';
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
/**
 * Resolves an i18n key with optional {0} arguments — the controller injects the resource bundle;
 * jest passes none and gets the English defaults below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string, args?: (string | number)[]) => string;

const defaultFormatters: HomeFormatters = {
  int: (n) => Math.round(n).toLocaleString('en-US'),
  money: (n, c) => `${n.toFixed(2)} ${c}`
};

/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  'home.scopeAll': 'All users, this month',
  'home.scopeSelf': 'Your usage this month',
  'home.requests': 'Requests',
  'home.tokens': 'Tokens',
  'home.sapCost': 'SAP cost',
  'home.externalCost': 'Connections cost',
  'home.activeUsers': 'Active users',
  'home.sapCostSubheader': '{0} (Capacity-Unit billing)',
  'home.externalCostSubheader': '{0} (Connections list prices)',
  'home.usersSubheader': 'With usage this month',
  'home.notIncluded': 'Not included: {0}'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

export function toHomeView(s: UsageSummaryLike | null, fmt: HomeFormatters = defaultFormatters, t: Translator = defaultTranslate): HomeView {
  if (!s || typeof s.requests !== 'number') return { available: false, scopeText: '', tiles: [] };
  const all = s.scope === 'all';
  const scopeText = all ? t('home.scopeAll') : t('home.scopeSelf');
  const currency = s.sapCostCurrency || 'USD';
  const others = (s.otherCurrencies || []).filter(Boolean);
  const tiles: HomeTile[] = [
    { key: 'requests', header: t('home.requests'), subheader: scopeText, value: fmt.int(s.requests), footer: '', state: 'Neutral' },
    { key: 'tokens', header: t('home.tokens'), subheader: scopeText, value: fmt.int(s.tokens), footer: '', state: 'Neutral' },
    {
      key: 'sapCost', header: t('home.sapCost'), subheader: t('home.sapCostSubheader', [currency]), value: fmt.money(s.sapCost, currency),
      // cost in another currency is not summed into the figure: say so rather than hide it
      footer: others.length ? t('home.notIncluded', [others.join(', ')]) : '', state: 'Critical'
    }
  ];
  if ((s.externalCost ?? 0) > 0) {
    tiles.push({ key: 'externalCost', header: t('home.externalCost'), subheader: t('home.externalCostSubheader', [currency]), value: fmt.money(s.externalCost!, currency), footer: '', state: 'Critical' });
  }
  if (all) tiles.push({ key: 'users', header: t('home.activeUsers'), subheader: t('home.usersSubheader'), value: fmt.int(s.users), footer: '', state: 'Good' });
  return { available: true, scopeText, tiles };
}
