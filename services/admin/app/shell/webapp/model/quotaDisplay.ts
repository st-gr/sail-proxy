/**
 * Pure view-model derivation for the shell's "My quota" card and profile block: one row per
 * budget window the user cares about first, used / limit as display strings, a percentage for
 * the progress indicator, a value state (warning from 75 %, error from 90 %), the bullet-chart
 * figures (actual, target, scale, colour, thresholds) and a formatted reset time. No UI5
 * imports, so it is unit-tested with jest like the model-library-app's webapp/model modules. The
 * per-minute requests guard is not a window: it rides along as one line of text (minuteText).
 */
export interface WindowUsageLike { requests: number; tokens: number; sapCost: number; }
export interface QuotaStatusLike {
  status: string;
  limits: Record<string, number | null>;
  used: { minuteRequests: number; day: WindowUsageLike; week: WindowUsageLike; month: WindowUsageLike };
  /** The currency every spend figure and spend limit is denominated in; the server defaults it to USD. */
  sapCostCurrency?: string | null;
  /** 00:00 UTC boundaries of the next day / week / month window, ISO strings (absent in older responses). */
  resetsAt?: { day?: string | null; week?: string | null; month?: string | null } | null;
  /** The caller's effective tool policy (myQuotaStatus only); absent on older responses. */
  toolPolicy?: { name: string; mode: string } | null;
}
/** Formats an amount in a currency — the controller injects UI5's locale-aware NumberFormat. */
export type MoneyFormatter = (amount: number, currency: string) => string;
/** Formats a reset timestamp — the controller injects UI5's DateFormat (medium date, short time, local zone). */
export type DateFormatter = (iso: string) => string;
export type RowColor = 'Good' | 'Critical' | 'Error' | 'Neutral';
export interface Threshold { value: number; color: 'Critical' | 'Error'; }
export interface QuotaRow {
  key: string; label: string; used: string; limit: string; percent: number; unlimited: boolean; state: 'None' | 'Success' | 'Warning' | 'Error';
  /** Bullet-chart figures: the bar, the target line (null when unlimited), the scale end, the bar colour, the threshold markers. */
  actual: number; target: number | null; max: number; color: RowColor; thresholds: Threshold[];
  /** "Resets <date>" for the window, '' when no timestamp is known. */
  resetText: string;
  /** "32 %" of the limit, not capped ("105 %" past it); '' when unlimited. */
  percentText: string;
}
/** One unit (spend or tokens): a one-line summary of its three windows, and a chart row per LIMITED window. */
export interface QuotaGroup {
  key: 'spend' | 'tokens'; label: string;
  /** "today 0 · this week 0 · this month 8.40 USD" */
  summary: string;
  /** "No spend limits apply." when none of the unit's windows has a limit, else ''. */
  noLimitText: string;
  /** The unit's limited windows only — a bar means nothing without a limit to compare against. */
  rows: QuotaRow[];
}
export interface QuotaView {
  available: boolean; deactivated: boolean; statusText: string;
  /** All six windows, limited or not (the profile popover lists them; journeys read them). */
  rows: QuotaRow[];
  /** The card's layout: spend, then tokens. */
  groups: QuotaGroup[];
  /** "Windows reset · day <d> · week <w> · month <m>" once for the card ('' without timestamps). */
  resetText: string;
  /** "Requests this minute: <used> / <limit>" - the rate guard, which has no budget bar; '' when no status is available. */
  minuteText: string;
  /** "Tool policy: <name> (<mode>)" - the caller's effective tool policy; '' when absent. */
  toolPolicyText: string;
}

/** Warning from 75 %, error from 90 % — the same constants the admin's quotaCriticality helper uses. */
export const WARN_PERCENT = 75;
export const ERROR_PERCENT = 90;
/** An unlimited row's scale end, as a factor of the largest used value among its siblings. */
export const UNLIMITED_HEADROOM = 1.25;

const int = (n: number) => Math.round(n).toLocaleString('en-US');
/** Two decimals and the code, no locale: the fallback when no UI5 formatter is injected (jest, and nothing else). */
const defaultMoney: MoneyFormatter = (n, currency) => `${n.toFixed(2)} ${currency}`;
const defaultDate: DateFormatter = (iso) => iso;

type Unit = 'spend' | 'tokens';
interface RowSpec { key: string; label: string; unit: Unit; window: 'day' | 'week' | 'month'; used: number; limit: number | null; }

function row(spec: RowSpec, fmt: (n: number) => string, unlimitedMax: number, resetText: string): QuotaRow {
  const { key, label, used, limit } = spec;
  if (limit === null || limit === undefined) {
    return { key, label, used: fmt(used), limit: 'unlimited', percent: 0, unlimited: true, state: 'None',
      actual: used, target: null, max: unlimitedMax, color: 'Neutral', thresholds: [], resetText, percentText: '' };
  }
  const percent = limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  const ratio = limit <= 0 ? 1 : used / limit;
  const color: RowColor = ratio >= ERROR_PERCENT / 100 ? 'Error' : ratio >= WARN_PERCENT / 100 ? 'Critical' : 'Good';
  const state = color === 'Error' ? 'Error' : color === 'Critical' ? 'Warning' : 'Success';
  return { key, label, used: fmt(used), limit: fmt(limit), percent, unlimited: false, state,
    actual: used, target: limit, max: Math.max(limit, used), color,
    thresholds: [{ value: limit * WARN_PERCENT / 100, color: 'Critical' }, { value: limit * ERROR_PERCENT / 100, color: 'Error' }], resetText,
    percentText: `${Math.round(ratio * 100)} %` };
}

export function toQuotaView(s: QuotaStatusLike | null, money: MoneyFormatter = defaultMoney, formatDate: DateFormatter = defaultDate): QuotaView {
  if (!s || !s.used || !s.limits) return { available: false, deactivated: false, statusText: 'Quota information is not available.', rows: [], groups: [], resetText: '', minuteText: '', toolPolicyText: '' };
  const deactivated = s.status === 'deactivated';
  // Every spend figure and spend limit carries its currency ("0.40 USD / 20.00 USD"); a zero is just
  // "0" — nothing was spent, so there is no currency to name.
  const currency = s.sapCostCurrency || 'USD';
  const amount = (n: number) => (n === 0 ? '0' : money(n, currency));
  const reset = (w: 'day' | 'week' | 'month') => { const iso = s.resetsAt?.[w]; return iso ? `Resets ${formatDate(iso)}` : ''; };
  const minuteLimit = s.limits.requestsPerMinute;
  const specs: RowSpec[] = [
    { key: 'spendDay', label: 'Spend today', unit: 'spend', window: 'day', used: s.used.day.sapCost, limit: s.limits.spendPerDay },
    { key: 'spendWeek', label: 'Spend this week', unit: 'spend', window: 'week', used: s.used.week.sapCost, limit: s.limits.spendPerWeek },
    { key: 'spendMonth', label: 'Spend this month', unit: 'spend', window: 'month', used: s.used.month.sapCost, limit: s.limits.spendPerMonth },
    { key: 'tokensDay', label: 'Tokens today', unit: 'tokens', window: 'day', used: s.used.day.tokens, limit: s.limits.tokensPerDay },
    { key: 'tokensWeek', label: 'Tokens this week', unit: 'tokens', window: 'week', used: s.used.week.tokens, limit: s.limits.tokensPerWeek },
    { key: 'tokensMonth', label: 'Tokens this month', unit: 'tokens', window: 'month', used: s.used.month.tokens, limit: s.limits.tokensPerMonth }
  ];
  // Unlimited rows share one scale per unit: 1.25 x the largest used value among them, so the
  // largest bar ends at 80 % and still has visible headroom (1 when all are 0). A bar without a
  // target conveys magnitude relative to its siblings, nothing more.
  const unlimitedMax: Record<Unit, number> = { spend: 0, tokens: 0 };
  for (const sp of specs) if (sp.limit === null || sp.limit === undefined) unlimitedMax[sp.unit] = Math.max(unlimitedMax[sp.unit], sp.used || 0);
  for (const u of ['spend', 'tokens'] as Unit[]) unlimitedMax[u] = unlimitedMax[u] > 0 ? unlimitedMax[u] * UNLIMITED_HEADROOM : 1;
  const rows = specs.map((sp) => row(sp, sp.unit === 'spend' ? amount : int, unlimitedMax[sp.unit], reset(sp.window)));
  // The card groups by unit: one summary line of the three windows, then a chart only under a
  // window that has a limit — a bar without a limit to compare against says nothing.
  const group = (key: Unit, label: string, noun: string): QuotaGroup => {
    const mine = rows.filter((r) => specs.find((sp) => sp.key === r.key)!.unit === key);
    const [d, w, m] = mine;
    return { key, label, summary: `today ${d.used} · this week ${w.used} · this month ${m.used}`,
      noLimitText: mine.every((r) => r.unlimited) ? `No ${noun} limits apply.` : '', rows: mine.filter((r) => !r.unlimited) };
  };
  // Day, week and month reset at the same moments for spend and tokens: one footer for the card.
  const resetParts = (['day', 'week', 'month'] as const).filter((w) => !!s.resetsAt?.[w]).map((w) => `${w} ${formatDate(s.resetsAt![w] as string)}`);
  return {
    available: true, deactivated,
    statusText: deactivated ? 'Your account is deactivated. Contact an administrator.' : '',
    // The per-minute requests limit is a rate guard, not a budget: one line of text, no bar.
    minuteText: `Requests this minute: ${int(s.used.minuteRequests || 0)} / ${minuteLimit === null || minuteLimit === undefined ? 'unlimited' : int(minuteLimit)}`,
    toolPolicyText: s.toolPolicy?.name ? `Tool policy: ${s.toolPolicy.name} (${s.toolPolicy.mode})` : '',
    rows,
    groups: [group('spend', 'Spend', 'spend'), group('tokens', 'Tokens', 'token')],
    resetText: resetParts.length ? `Windows reset · ${resetParts.join(' · ')}` : ''
  };
}
