/**
 * Pure view-model derivation for the shell's "My quota" card and profile block: one row per
 * dimension the user cares about first, used / limit as display strings, a percentage for the
 * progress indicator and a value state (warning from 75 %, error from 90 %). No UI5 imports, so
 * it is unit-tested with jest like the model-library-app's webapp/model modules.
 */
export interface WindowUsageLike { requests: number; tokens: number; sapCost: number; }
export interface QuotaStatusLike {
  status: string;
  limits: Record<string, number | null>;
  used: { minuteRequests: number; day: WindowUsageLike; week: WindowUsageLike; month: WindowUsageLike };
  /** The currency every spend figure and spend limit is denominated in; the server defaults it to USD. */
  sapCostCurrency?: string | null;
}
/** Formats an amount in a currency — the controller injects UI5's locale-aware NumberFormat. */
export type MoneyFormatter = (amount: number, currency: string) => string;
export interface QuotaRow { key: string; label: string; used: string; limit: string; percent: number; unlimited: boolean; state: 'None' | 'Success' | 'Warning' | 'Error'; }
export interface QuotaView { available: boolean; deactivated: boolean; statusText: string; rows: QuotaRow[]; }

const int = (n: number) => Math.round(n).toLocaleString('en-US');
/** Two decimals and the code, no locale: the fallback when no UI5 formatter is injected (jest, and nothing else). */
const defaultMoney: MoneyFormatter = (n, currency) => `${n.toFixed(2)} ${currency}`;

function row(key: string, label: string, used: number, limit: number | null, fmt: (n: number) => string): QuotaRow {
  if (limit === null || limit === undefined) return { key, label, used: fmt(used), limit: 'unlimited', percent: 0, unlimited: true, state: 'None' };
  const percent = limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  const state = percent >= 90 ? 'Error' : percent >= 75 ? 'Warning' : 'Success';
  return { key, label, used: fmt(used), limit: fmt(limit), percent, unlimited: false, state };
}

export function toQuotaView(s: QuotaStatusLike | null, money: MoneyFormatter = defaultMoney): QuotaView {
  if (!s || !s.used || !s.limits) return { available: false, deactivated: false, statusText: 'Quota information is not available.', rows: [] };
  const deactivated = s.status === 'deactivated';
  // Every spend figure and spend limit carries its currency ("0.40 USD / 20.00 USD"); a zero is just
  // "0" — nothing was spent, so there is no currency to name.
  const currency = s.sapCostCurrency || 'USD';
  const amount = (n: number) => (n === 0 ? '0' : money(n, currency));
  return {
    available: true, deactivated,
    statusText: deactivated ? 'Your account is deactivated. Contact an administrator.' : '',
    rows: [
      row('requestsMinute', 'Requests this minute', s.used.minuteRequests ?? 0, s.limits.requestsPerMinute, int),
      row('spendDay', 'Spend today', s.used.day.sapCost, s.limits.spendPerDay, amount),
      row('spendMonth', 'Spend this month', s.used.month.sapCost, s.limits.spendPerMonth, amount),
      row('tokensDay', 'Tokens today', s.used.day.tokens, s.limits.tokensPerDay, int),
      row('tokensMonth', 'Tokens this month', s.used.month.tokens, s.limits.tokensPerMonth, int)
    ]
  };
}
