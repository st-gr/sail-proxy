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
/** Formats a whole number with grouping — the controller injects UI5's locale-aware NumberFormat. */
export type IntFormatter = (n: number) => string;
/**
 * Resolves an i18n key with optional {0}, {1} … arguments — the controller injects the resource
 * bundle; jest passes none and gets the English defaults below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string, args?: (string | number)[]) => string;

/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  'quota.unavailable': 'Quota information is not available.',
  'quota.deactivated': 'Your account is deactivated. Contact an administrator.',
  'quota.spendDay': 'Spend today',
  'quota.spendWeek': 'Spend this week',
  'quota.spendMonth': 'Spend this month',
  'quota.tokensDay': 'Tokens today',
  'quota.tokensWeek': 'Tokens this week',
  'quota.tokensMonth': 'Tokens this month',
  'quota.unlimited': 'unlimited',
  'quota.resets': 'Resets {0}',
  'quota.spendLabel': 'Spend',
  'quota.tokensLabel': 'Tokens',
  'quota.noSpendLimits': 'No spend limits apply.',
  'quota.noTokenLimits': 'No token limits apply.',
  'quota.summary': 'today {0} · this week {1} · this month {2}',
  'quota.minute': 'Requests this minute: {0} / {1}',
  'quota.toolPolicy': 'Tool policy: {0} ({1})',
  'quota.windowsReset': 'Windows reset',
  'quota.resetPart': '{0} {1}',
  'quota.windowDay': 'day',
  'quota.windowWeek': 'week',
  'quota.windowMonth': 'month'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};
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

/** Grouped in en-US: the fallback when no UI5 formatter is injected (jest, and nothing else). */
const defaultInt: IntFormatter = (n) => Math.round(n).toLocaleString('en-US');
/** Two decimals and the code, no locale: the fallback when no UI5 formatter is injected (jest, and nothing else). */
const defaultMoney: MoneyFormatter = (n, currency) => `${n.toFixed(2)} ${currency}`;
const defaultDate: DateFormatter = (iso) => iso;

type Unit = 'spend' | 'tokens';
interface RowSpec { key: string; label: string; unit: Unit; window: 'day' | 'week' | 'month'; used: number; limit: number | null; }

function row(spec: RowSpec, fmt: (n: number) => string, unlimitedMax: number, resetText: string, unlimitedLabel: string): QuotaRow {
  const { key, label, used, limit } = spec;
  if (limit === null || limit === undefined) {
    return { key, label, used: fmt(used), limit: unlimitedLabel, percent: 0, unlimited: true, state: 'None',
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

export function toQuotaView(s: QuotaStatusLike | null, money: MoneyFormatter = defaultMoney, formatDate: DateFormatter = defaultDate, t: Translator = defaultTranslate, int: IntFormatter = defaultInt): QuotaView {
  if (!s || !s.used || !s.limits) return { available: false, deactivated: false, statusText: t('quota.unavailable'), rows: [], groups: [], resetText: '', minuteText: '', toolPolicyText: '' };
  const deactivated = s.status === 'deactivated';
  const unlimited = t('quota.unlimited');
  const windowKey: Record<'day' | 'week' | 'month', string> = { day: 'quota.windowDay', week: 'quota.windowWeek', month: 'quota.windowMonth' };
  // Every spend figure and spend limit carries its currency ("0.40 USD / 20.00 USD"); a zero is just
  // "0" — nothing was spent, so there is no currency to name.
  const currency = s.sapCostCurrency || 'USD';
  const amount = (n: number) => (n === 0 ? '0' : money(n, currency));
  const reset = (w: 'day' | 'week' | 'month') => { const iso = s.resetsAt?.[w]; return iso ? t('quota.resets', [formatDate(iso)]) : ''; };
  const minuteLimit = s.limits.requestsPerMinute;
  const specs: RowSpec[] = [
    { key: 'spendDay', label: t('quota.spendDay'), unit: 'spend', window: 'day', used: s.used.day.sapCost, limit: s.limits.spendPerDay },
    { key: 'spendWeek', label: t('quota.spendWeek'), unit: 'spend', window: 'week', used: s.used.week.sapCost, limit: s.limits.spendPerWeek },
    { key: 'spendMonth', label: t('quota.spendMonth'), unit: 'spend', window: 'month', used: s.used.month.sapCost, limit: s.limits.spendPerMonth },
    { key: 'tokensDay', label: t('quota.tokensDay'), unit: 'tokens', window: 'day', used: s.used.day.tokens, limit: s.limits.tokensPerDay },
    { key: 'tokensWeek', label: t('quota.tokensWeek'), unit: 'tokens', window: 'week', used: s.used.week.tokens, limit: s.limits.tokensPerWeek },
    { key: 'tokensMonth', label: t('quota.tokensMonth'), unit: 'tokens', window: 'month', used: s.used.month.tokens, limit: s.limits.tokensPerMonth }
  ];
  // Unlimited rows share one scale per unit: 1.25 x the largest used value among them, so the
  // largest bar ends at 80 % and still has visible headroom (1 when all are 0). A bar without a
  // target conveys magnitude relative to its siblings, nothing more.
  const unlimitedMax: Record<Unit, number> = { spend: 0, tokens: 0 };
  for (const sp of specs) if (sp.limit === null || sp.limit === undefined) unlimitedMax[sp.unit] = Math.max(unlimitedMax[sp.unit], sp.used || 0);
  for (const u of ['spend', 'tokens'] as Unit[]) unlimitedMax[u] = unlimitedMax[u] > 0 ? unlimitedMax[u] * UNLIMITED_HEADROOM : 1;
  const rows = specs.map((sp) => row(sp, sp.unit === 'spend' ? amount : int, unlimitedMax[sp.unit], reset(sp.window), unlimited));
  // The card groups by unit: one summary line of the three windows, then a chart only under a
  // window that has a limit — a bar without a limit to compare against says nothing.
  const group = (key: Unit, label: string, noLimitKey: string): QuotaGroup => {
    const mine = rows.filter((r) => specs.find((sp) => sp.key === r.key)!.unit === key);
    const [d, w, m] = mine;
    return { key, label, summary: t('quota.summary', [d.used, w.used, m.used]),
      noLimitText: mine.every((r) => r.unlimited) ? t(noLimitKey) : '', rows: mine.filter((r) => !r.unlimited) };
  };
  // Day, week and month reset at the same moments for spend and tokens: one footer for the card.
  const resetParts = (['day', 'week', 'month'] as const).filter((w) => !!s.resetsAt?.[w]).map((w) => t('quota.resetPart', [t(windowKey[w]), formatDate(s.resetsAt![w] as string)]));
  return {
    available: true, deactivated,
    statusText: deactivated ? t('quota.deactivated') : '',
    // The per-minute requests limit is a rate guard, not a budget: one line of text, no bar.
    minuteText: t('quota.minute', [int(s.used.minuteRequests || 0), minuteLimit === null || minuteLimit === undefined ? unlimited : int(minuteLimit)]),
    toolPolicyText: s.toolPolicy?.name ? t('quota.toolPolicy', [s.toolPolicy.name, s.toolPolicy.mode]) : '',
    rows,
    groups: [group('spend', t('quota.spendLabel'), 'quota.noSpendLimits'), group('tokens', t('quota.tokensLabel'), 'quota.noTokenLimits')],
    resetText: resetParts.length ? `${t('quota.windowsReset')} · ${resetParts.join(' · ')}` : ''
  };
}
