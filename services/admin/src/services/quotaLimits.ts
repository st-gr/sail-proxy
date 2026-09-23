/**
 * Quota limits: the seven constraint fields, the platform defaults from `platform.quotas`, and the
 * user > profile > platform > unlimited resolution the validation payload, the state document and
 * the OData status all share (spec §1; the profile step is spec 2026-09-08). Platform defaults come
 * from the ACTIVE configuration (ApiConfigurations, like admin-service-library.ts's
 * activeConfigJson) with api_config.json as the fallback, cached for a minute and invalidated on
 * activation (config-service.ts), so "a config change republishes all documents" (spec §3) sees the
 * new values.
 */
import fs from 'fs';
import path from 'path';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const LIMIT_FIELDS = [
  'requestsPerMinute', 'spendPerDay', 'spendPerWeek', 'spendPerMonth', 'tokensPerDay', 'tokensPerWeek', 'tokensPerMonth'
] as const;
export type LimitField = typeof LIMIT_FIELDS[number];
export type Limits = Record<LimitField, number | null>;
export type LimitSource = Record<LimitField, 'user' | 'profile' | 'platform' | 'unlimited'>;
const INTEGER_FIELDS: ReadonlySet<string> = new Set(['requestsPerMinute', 'tokensPerDay', 'tokensPerWeek', 'tokensPerMonth']);

export const UNLIMITED: Limits = Object.freeze(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, null]))) as Limits;

type DbLike = { run(q: any): Promise<any> };
const CACHE_MS = 60_000;
let cached: { at: number; limits: Limits } | null = null;

export function invalidateQuotaDefaults(): void { cached = null; }

function toLimits(quotas: any): Limits {
  const out: any = { ...UNLIMITED };
  for (const f of LIMIT_FIELDS) {
    const v = quotas?.[f];
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[f] = n;
  }
  return out;
}

async function activePlatform(db?: DbLike): Promise<any> {
  const unwrap = (o: any) => (o && typeof o === 'object' ? (o.api_config ?? o) : {});
  if (db) {
    try {
      const { SELECT } = cds.ql;
      const rows = await db.run(SELECT.from('sap.llm.gateway.admin.ApiConfigurations').columns('configData')
        .where({ isActive: true }).orderBy('version desc').limit(1));
      if (rows.length > 0 && rows[0].configData) return unwrap(JSON.parse(rows[0].configData))?.platform ?? {};
    } catch { /* fall through to the file */ }
  }
  try {
    return unwrap(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../api_config.json'), 'utf8')))?.platform ?? {};
  } catch {
    return {};
  }
}

/** platform.quotas of the active configuration (file fallback); absent or invalid values are unlimited. */
export async function platformQuotaDefaults(db?: DbLike): Promise<Limits> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.limits;
  const limits = toLimits((await activePlatform(db))?.quotas);
  cached = { at: Date.now(), limits };
  return limits;
}

export const DAILY_RUN_AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * platform.maintenance.dailyRunAtUtc of the active configuration: 'HH:MM' (UTC) or null when unset
 * or invalid. Read at startup and on activation only, so it is not cached.
 */
export async function maintenanceRunAtUtc(db?: DbLike): Promise<string | null> {
  const v = (await activePlatform(db))?.maintenance?.dailyRunAtUtc;
  if (typeof v !== 'string') return null;
  if (!DAILY_RUN_AT_PATTERN.test(v)) {
    logger.warn('QuotaLimits', `platform.maintenance.dailyRunAtUtc '${v}' is not HH:MM — ignoring`);
    return null;
  }
  return v;
}

/** Per field: the user's own value, else the assigned profile's, else the platform default, else unlimited. */
export function effectiveLimits(user: Partial<Record<LimitField, any>> | null, profile: Partial<Record<LimitField, any>> | null, platform: Limits): { limits: Limits; limitSource: LimitSource } {
  const limits: any = {};
  const limitSource: any = {};
  const own = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));
  for (const f of LIMIT_FIELDS) {
    const u = own(user?.[f]); const p = own(profile?.[f]);
    if (u !== null && Number.isFinite(u)) { limits[f] = u; limitSource[f] = 'user'; }
    else if (p !== null && Number.isFinite(p)) { limits[f] = p; limitSource[f] = 'profile'; }
    else if (platform[f] !== null) { limits[f] = platform[f]; limitSource[f] = 'platform'; }
    else { limits[f] = null; limitSource[f] = 'unlimited'; }
  }
  return { limits, limitSource };
}

/**
 * What defaultText() needs of a QuotaStatus: the two RAW inputs of the resolution beside the user's
 * own values, plus the profile's name and the currency the spend figures are denominated in.
 * Declared structurally rather than imported from userQuotaService, which imports this module.
 */
export type DefaultTextSource = {
  profileLimits: Partial<Limits> | null; platformLimits: Limits;
  quotaProfileName: string | null; sapCostCurrency: string;
};

/**
 * The text the users-app prints beside an EMPTY constraint (spec §4.2): the figure that would apply
 * if the field were cleared, and where it comes from — `"1,000,000 (Standard profile)"`,
 * `"25.00 USD (platform)"` or `"unlimited"`.
 *
 * The fallback is resolved per field with the user's own value left out entirely, so the text keeps
 * saying what a cleared field inherits even while the user carries a value of their own — and a
 * field the assigned profile leaves null still names the platform default rather than reading
 * "unlimited" because a profile happens to be assigned.
 */
/** What a resolved quota status carries for one limit and its source (spec 2026-09-08 §2). */
export interface EffectiveLimitSource {
  limits: Limits;
  limitSource: LimitSource;
  quotaProfileName: string | null;
  sapCostCurrency: string;
}

/**
 * The limit that applies to a user for one field, with where it comes from: "200 (own
 * constraint)", "60 (Standard profile)", "30 (platform)" or "unlimited"; spend carries two
 * decimals and the billing currency. A credential's page shows this for its owner beside the
 * credential's own limits - the two layers the gateway checks in turn.
 */
export function effectiveLimitText(f: LimitField, s: EffectiveLimitSource): string {
  const value = s.limits[f];
  if (value === null || value === undefined) return 'unlimited';
  const figure = f.startsWith('spend') ? `${Number(value).toFixed(2)} ${s.sapCostCurrency}` : Number(value).toLocaleString('en-US');
  switch (s.limitSource[f]) {
    case 'user': return `${figure} (own constraint)`;
    case 'profile': return `${figure} (${s.quotaProfileName} profile)`;
    default: return `${figure} (platform)`;
  }
}

export function defaultText(f: LimitField, s: DefaultTextSource): string {
  const { limits, limitSource } = effectiveLimits(null, s.profileLimits ?? null, s.platformLimits);
  const value = limits[f];
  if (value === null) return 'unlimited';
  const figure = f.startsWith('spend') ? `${value.toFixed(2)} ${s.sapCostCurrency}` : value.toLocaleString('en-US');
  return limitSource[f] === 'profile' ? `${figure} (${s.quotaProfileName} profile)` : `${figure} (platform)`;
}

/**
 * The window pairs a metric's limits have to respect, narrower window first. A day cannot be
 * allowed more than a week, nor a week more than a month: the wider window is the harder ceiling,
 * so the pair could never be honoured together. Day against month is checked in its own right -
 * with the week unlimited, neither of the other two comparisons says anything about it.
 */
const WINDOW_ORDER: ReadonlyArray<readonly ['Day' | 'Week' | 'Month', 'Day' | 'Week' | 'Month']> = [
  ['Day', 'Week'], ['Week', 'Month'], ['Day', 'Month']
];
const ORDERED_METRICS = ['tokens', 'spend'] as const;

/**
 * One limit as a comparable number, or null where there is nothing to compare: null and '' are the
 * two ways a field says UNLIMITED (the form clears to the empty string), and unlimited is not
 * "more" than any figure. A value that is not a finite number is null here as well - the per-field
 * check above has already named it, and an ordering complaint about a value nobody can read on top
 * of that would only obscure it.
 */
function comparableLimit(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Validation for constraint edits: null clears, otherwise non-negative, integer where typed, and
 * the three windows of a metric ordered day <= week <= month.
 *
 * The ordering is judged on the MERGED values - `current` overlaid by `patch` - because an edit is
 * a patch: `tokensPerDay 100` sent on its own has to be weighed against the month already stored,
 * or the pair the gateway ends up enforcing is never checked at all. By the same token a patch is
 * only ever blamed for the state it PRODUCES, so one that repairs an existing violation, or that
 * clears a field to unlimited, is accepted. `current` is optional: a caller with no stored row
 * (or none in hand) validates the patch alone, exactly as before.
 */
export function validateConstraints(patch: Record<string, any>, current?: Record<string, any> | null): string[] {
  const errors: string[] = [];
  for (const f of LIMIT_FIELDS) {
    if (!(f in patch) || patch[f] === null || patch[f] === undefined) continue;
    const n = typeof patch[f] === 'string' ? Number(patch[f]) : patch[f];
    if (INTEGER_FIELDS.has(f)) {
      if (!Number.isInteger(n) || n < 0) errors.push(`${f} must be a non-negative integer`);
    } else if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      errors.push(`${f} must be a non-negative number`);
    }
  }
  const merged: Record<string, number | null> = {};
  for (const f of LIMIT_FIELDS) merged[f] = comparableLimit(f in patch ? patch[f] : current?.[f]);
  for (const metric of ORDERED_METRICS) {
    for (const [narrow, wide] of WINDOW_ORDER) {
      const lower = merged[`${metric}Per${narrow}`];
      const upper = merged[`${metric}Per${wide}`];
      if (lower !== null && upper !== null && lower > upper) {
        errors.push(`${metric}Per${narrow} must not exceed ${metric}Per${wide}`);
      }
    }
  }
  return errors;
}
