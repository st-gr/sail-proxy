/**
 * Pure view-model for the profile popover's Teams block (spec 2026-10-14 §9): one line per
 * membership naming the team, whether it is the primary one and whether the caller administers it,
 * and one line with the team's month pool, so a member can tell when the team budget, not their
 * own, is what will stop them. No UI5 imports; jest-tested like quotaDisplay.ts.
 */
export interface MyTeamLike { teamId: string; name: string; role: string; isPrimary: boolean; pool?: { limits: Record<string, number | string | null>; used: { month: { sapCost: number | string; tokens: number | string } }; sapCostCurrency?: string | null } | null; }
export type Translator = (key: string, args?: (string | number)[]) => string;
export type MoneyFormatter = (amount: number, currency: string) => string;
export type IntFormatter = (n: number) => string;
export interface TeamLine { teamId: string; name: string; membershipText: string; poolText: string; }
export interface TeamsView { available: boolean; lines: TeamLine[]; }

const EN_TEXTS: Record<string, string> = {
  'teams.title': 'Teams',
  'teams.primary': 'primary',
  'teams.admin': 'team admin',
  'teams.unlimited': 'unlimited',
  'teams.pool': '{0}: {1} / {2} · {3} / {4} tokens this month'
};
const defaultTranslate: Translator = (key, args) => { const p = EN_TEXTS[key] ?? key; return args ? p.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : p; };
const defaultMoney: MoneyFormatter = (n, c) => `${n.toFixed(2)} ${c}`;
const defaultInt: IntFormatter = (n) => Math.round(n).toLocaleString('en-US');

export function toTeamsView(teams: MyTeamLike[] | null | undefined, money: MoneyFormatter = defaultMoney, int: IntFormatter = defaultInt, t: Translator = defaultTranslate): TeamsView {
  if (!Array.isArray(teams) || teams.length === 0) return { available: false, lines: [] };
  const unlimited = t('teams.unlimited');
  return { available: true, lines: teams.map((m) => {
    const marks = [m.name, m.isPrimary ? t('teams.primary') : '', m.role === 'admin' ? t('teams.admin') : ''].filter(Boolean);
    const currency = m.pool?.sapCostCurrency || 'USD';
    const spendLimit = m.pool?.limits?.spendPerMonth; const tokenLimit = m.pool?.limits?.tokensPerMonth;
    const poolText = m.pool ? t('teams.pool', [m.name, money(Number(m.pool.used.month.sapCost) || 0, currency), spendLimit == null ? unlimited : money(Number(spendLimit), currency),
      int(Number(m.pool.used.month.tokens) || 0), tokenLimit == null ? unlimited : int(Number(tokenLimit))]) : '';
    return { teamId: m.teamId, name: m.name, membershipText: marks.join(' · '), poolText };
  }) };
}
