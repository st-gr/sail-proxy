/**
 * Per-user quota figures (spec §3): usage sums per calendar window over both usage entities,
 * effective limits, the status the OData surface reports and the state document the gateway
 * reads from Valkey. Documents are rewritten on every usage batch that touches the user, on every
 * constraint/status change, on configuration activation, and once a minute for users whose
 * document predates the current day (rollover). Reads only — the single SQLite connection is
 * never held across a gateway call here (there is none).
 */
import { getDefaultLogger } from '@libs/logger';
import { getUser, parseRoles, USERS, DbLike } from './usersService';
import { effectiveLimits, platformQuotaDefaults, LIMIT_FIELDS, Limits, LimitSource } from './quotaLimits';
import { getProfile, getProfilesByIds, ProfileRow } from './quotaProfilesService';
import { WindowName, windowStarts, nextResets } from './quotaWindows';
import { quotaStateStore, quotaKeyFor, userMinuteKey, QUOTA_DOCUMENT_TTL_SECONDS } from './quotaStateStore';
import { _lookupPrice, isProductive } from './sapCapacityService';
import { readBuckets, windowsFromBuckets, windowHorizon, WindowUsage as BucketWindowUsage, BucketRow } from './usageCounters';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
// Every fan-out over users on the single SQLite connection (statusMany for a page of Users,
// publishMany, republishAll) is walked in chunks of this size, yielding (a macrotask, not just an
// await) between chunks so a long fan-out cannot starve the connection for the length of the whole
// run (spec §3 / §2).
const FANOUT_CHUNK = 25;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// sapCost is the one SAP-native aggregate that is NOT currency-neutral (db/schema/api-keys.cds):
// `sapCost` below is the total in the quota currency only (quotaCurrency(), rows priced in any
// other currency are excluded from it); `sapCostByCurrency` lists every currency actually seen,
// same pattern as reconciliationService's groupBy('sapCostCurrency').
export type WindowUsage = BucketWindowUsage;
export interface QuotaStateDocument {
  email: string; status: 'active' | 'deactivated'; limits: Limits; sapCostCurrency: string;
  used: Record<WindowName, WindowUsage>; windowStart: Record<WindowName, string>;
  quotaResetAt: string | null; updatedAt: string;
}
export interface QuotaStatus {
  email: string; status: 'active' | 'deactivated'; roles: string[];
  limits: Limits; limitSource: LimitSource; quotaProfileName: string | null; sapCostCurrency: string;
  // The two raw inputs of the resolution beside the user's own values, so a consumer can say what a
  // CLEARED constraint would inherit (quotaLimits.defaultText) while the user still carries a value
  // of their own. Not modelled in CDS and never flattened onto a row.
  profileLimits: Partial<Limits> | null; platformLimits: Limits;
  used: { minuteRequests: number } & Record<WindowName, WindowUsage>;
  remaining: { spendDay: number | null; spendWeek: number | null; spendMonth: number | null; tokensDay: number | null; tokensWeek: number | null; tokensMonth: number | null };
  resetsAt: Record<WindowName, Date>; quotaResetAt: string | null; lastSeenAt: string | null;
}

// Memoised for 60 s like platformQuotaDefaults' cache below: every fan-out (a page of
// UserQuotaStatus, republishAll, publishMany) resolves the currency ONCE and passes it down,
// rather than one _lookupPrice per user.
const CURRENCY_CACHE_MS = 60_000;
let currencyCache: { at: number; value: string } | null = null;

/** The spend quota's denomination: the currency of the currently-active SAP capacity-unit price. */
export async function quotaCurrency(now: Date): Promise<string> {
  if (currencyCache && Date.now() - currencyCache.at < CURRENCY_CACHE_MS) return currencyCache.value;
  let value: string;
  try {
    const price = await _lookupPrice(isProductive() ? 'productive' : 'non-productive', now);
    value = price?.currency ?? 'USD';
  } catch {
    value = 'USD';
  }
  currencyCache = { at: Date.now(), value };
  return value;
}

const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** The quota profile assigned to a user row, or null when it carries none (spec 2026-09-08 §2). */
async function userProfile(db: DbLike, user: { quotaProfile_ID?: string | null } | null): Promise<ProfileRow | null> {
  return user?.quotaProfile_ID ? getProfile(db, user.quotaProfile_ID) : null;
}

/** A profile's seven limits alone, as numbers: the rest of the row (ID, description, managed
 *  columns) has no business riding on a QuotaStatus, which myQuotaStatus hands to the user it is
 *  about, and the Decimal columns come back as strings on Postgres - `Limits` promises numbers. */
export function profileLimitsOf(profile: ProfileRow | null): Limits | null {
  if (!profile) return null;
  return Object.fromEntries(LIMIT_FIELDS.map((f) => {
    const v = profile[f];
    return [f, v === null || v === undefined ? null : Number(v)];
  })) as Limits;
}

/** Mixed-currency rows are visible in sapCostByCurrency; only the quota currency feeds spend quotas. */
function warnMixedCurrencies(email: string, used: Record<WindowName, WindowUsage>, currency: string): void {
  const seen = Object.keys(used.month.sapCostByCurrency);
  if (seen.length > 1) logger.warn('UserQuotaService', `${email} has usage in more than one sapCost currency: ${seen.join(', ')} — only ${currency} feeds spend quotas`);
}

/** Day / week / month usage of one user from the buckets (spec §3.3). `_quotaResetAt` stays for
 *  signature compatibility: a reset deletes the buckets, so the read applies no watermark. */
export async function computeUsage(db: DbLike, email: string, now: Date, _quotaResetAt: Date | string | null, currency?: string): Promise<Record<WindowName, WindowUsage>> {
  const cur = currency ?? await quotaCurrency(now);
  const used = windowsFromBuckets(await readBuckets(db, [email], windowHorizon(now)), now, cur);
  warnMixedCurrencies(email, used, cur);
  return used;
}

/** The same for a page of users with ONE bucket query; every requested e-mail is present (zeros when it has no buckets). */
export async function computeUsageMany(db: DbLike, emails: string[], now: Date, currency: string): Promise<Map<string, Record<WindowName, WindowUsage>>> {
  const out = new Map<string, Record<WindowName, WindowUsage>>();
  const list = [...new Set(emails.filter(Boolean))];
  if (list.length === 0) return out;
  const byEmail = new Map<string, BucketRow[]>();
  for (const r of await readBuckets(db, list, windowHorizon(now))) byEmail.set(r.email, [...(byEmail.get(r.email) ?? []), r]);
  for (const email of list) {
    const used = windowsFromBuckets(byEmail.get(email) ?? [], now, currency);
    warnMixedCurrencies(email, used, currency);
    out.set(email, used);
  }
  return out;
}

/** Requests in the sliding minute, from the gateway's own buckets (0 when Valkey is not there). */
export async function currentMinuteRequests(email: string, now: Date): Promise<number> {
  const minute = Math.floor(now.getTime() / 60_000);
  const [current, previous] = await Promise.all([quotaStateStore.getNumber(userMinuteKey(email, minute)), quotaStateStore.getNumber(userMinuteKey(email, minute - 1))]);
  const elapsed = (now.getTime() % 60_000) / 60_000;
  return Math.round((current + previous * (1 - elapsed)) * 100) / 100;
}

export async function buildDocument(db: DbLike, email: string, now: Date = new Date(), currency?: string, used?: Record<WindowName, WindowUsage>): Promise<QuotaStateDocument> {
  const user = await getUser(db, email);
  const { limits } = effectiveLimits(user, await userProfile(db, user), await platformQuotaDefaults(db));
  const starts = windowStarts(now);
  const sapCostCurrency = currency ?? await quotaCurrency(now);
  return {
    email, status: user?.status ?? 'active', limits, sapCostCurrency,
    used: used ?? await computeUsage(db, email, now, user?.quotaResetAt ?? null, sapCostCurrency),
    windowStart: { day: starts.day.toISOString(), week: starts.week.toISOString(), month: starts.month.toISOString() },
    quotaResetAt: user?.quotaResetAt ? new Date(user.quotaResetAt).toISOString() : null,
    updatedAt: now.toISOString()
  };
}

/** `currency` and `platform` are the two page-wide values a fan-out resolves once and passes in
 * (statusMany below); omitted, each is resolved here, which is what the single-row callers do.
 * `used`, likewise, is the page-wide computeUsageMany() result for this row when statusMany calls in.
 * `profile` is the row's quota profile when the page has already read it: `undefined` means "read it
 * here", `null` means "this user has none". */
export async function status(db: DbLike, email: string, now: Date = new Date(), currency?: string, platform?: Limits, used?: Record<WindowName, WindowUsage>, profile?: ProfileRow | null): Promise<QuotaStatus> {
  const user = await getUser(db, email);
  const assigned = profile === undefined ? await userProfile(db, user) : profile;
  const platformLimits = platform ?? await platformQuotaDefaults(db);
  const { limits, limitSource } = effectiveLimits(user, assigned, platformLimits);
  const sapCostCurrency = currency ?? await quotaCurrency(now);
  const usedNow = used ?? await computeUsage(db, email, now, user?.quotaResetAt ?? null, sapCostCurrency);
  const rem = (limit: number | null, value: number) => (limit === null ? null : round(Math.max(0, limit - value)));
  return {
    email, status: user?.status ?? 'active', roles: parseRoles(user?.rolesSnapshot), limits, limitSource,
    quotaProfileName: assigned?.name ?? null, profileLimits: profileLimitsOf(assigned), platformLimits, sapCostCurrency,
    used: { minuteRequests: await currentMinuteRequests(email, now), ...usedNow },
    remaining: {
      spendDay: rem(limits.spendPerDay, usedNow.day.sapCost), spendWeek: rem(limits.spendPerWeek, usedNow.week.sapCost), spendMonth: rem(limits.spendPerMonth, usedNow.month.sapCost),
      tokensDay: rem(limits.tokensPerDay, usedNow.day.tokens), tokensWeek: rem(limits.tokensPerWeek, usedNow.week.tokens), tokensMonth: rem(limits.tokensPerMonth, usedNow.month.tokens)
    },
    resetsAt: nextResets(now), quotaResetAt: user?.quotaResetAt ? new Date(user.quotaResetAt).toISOString() : null,
    lastSeenAt: user?.lastSeenAt ?? null
  };
}

/**
 * The page's quota profiles in ONE assignment read and ONE profile read, e-mail -> profile (null
 * where the user has none). `null` for the whole page when either read fails: every row then falls
 * back to resolving its own profile in status(), which keeps a page-wide failure from costing more
 * than an extra query per row.
 */
async function pageProfiles(db: DbLike, emails: string[]): Promise<Map<string, ProfileRow | null> | null> {
  try {
    const rows: any[] = await db.run(cds.ql.SELECT.from(USERS).columns('email', 'quotaProfile_ID').where({ email: { in: emails } }));
    const byId = await getProfilesByIds(db, rows.map((r) => r.quotaProfile_ID).filter(Boolean));
    return new Map(rows.map((r) => [r.email, r.quotaProfile_ID ? byId.get(r.quotaProfile_ID) ?? null : null]));
  } catch (error) {
    logger.debug('UserQuotaService', `page profile read failed, falling back to per-user reads: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The status of a whole page of users (the Users list read of spec §4). The quota
 * currency and the platform defaults are resolved ONCE for the page and passed into every row's
 * status(), and the page is walked in chunks of FANOUT_CHUNK with a macrotask yield between them —
 * the publishChunked shape. On the admin's single SQLite connection that bounds how long one list
 * page occupies the connection before other requests (including the gateway's validation callback)
 * can interleave; it opens no transaction of its own and holds none across a Valkey read any
 * longer than a single status() does. A row whose status cannot be computed is absent from the
 * map — the caller decides what to leave on such a row.
 */
export async function statusMany(db: DbLike, emails: string[], now: Date = new Date()): Promise<Map<string, QuotaStatus>> {
  const out = new Map<string, QuotaStatus>();
  if (emails.length === 0) return out;
  const currency = await quotaCurrency(now);
  const platform = await platformQuotaDefaults(db);
  const usage = await computeUsageMany(db, emails, now, currency);
  const assigned = await pageProfiles(db, emails);
  for (let i = 0; i < emails.length; i += FANOUT_CHUNK) {
    await Promise.all(emails.slice(i, i + FANOUT_CHUNK).map(async (email) => {
      try {
        out.set(email, await status(db, email, now, currency, platform, usage.get(email), assigned ? assigned.get(email) ?? null : undefined));
      } catch (error) {
        logger.warn('UserQuotaService', `status failed for ${email}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    if (i + FANOUT_CHUNK < emails.length) await yieldToEventLoop();
  }
  return out;
}

// ---- publisher ------------------------------------------------------------------------------
const publishedDay = new Map<string, string>();   // email -> windowStart.day of the last document

export async function publish(db: DbLike, email: string, now: Date = new Date(), currency?: string, used?: Record<WindowName, WindowUsage>): Promise<boolean> {
  try {
    const doc = await buildDocument(db, email, now, currency, used);
    const ok = await quotaStateStore.setJson(quotaKeyFor(email), doc, QUOTA_DOCUMENT_TTL_SECONDS);
    if (ok) publishedDay.set(email, doc.windowStart.day);
    return ok;
  } catch (error) {
    logger.warn('UserQuotaService', `publish failed for ${email}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Publishes every email once, chunked and yielding between chunks (see FANOUT_CHUNK); returns
 * the number of successful publishes. Shared by publishMany and republishAll. */
async function publishChunked(db: DbLike, emails: string[], currency: string): Promise<number> {
  let n = 0;
  for (let i = 0; i < emails.length; i += FANOUT_CHUNK) {
    const chunk = emails.slice(i, i + FANOUT_CHUNK);
    const usage = await computeUsageMany(db, chunk, new Date(), currency);
    for (const email of chunk) if (await publish(db, email, new Date(), currency, usage.get(email))) n += 1;
    if (i + FANOUT_CHUNK < emails.length) await yieldToEventLoop();
  }
  return n;
}

export async function publishMany(db: DbLike, emails: Iterable<string>): Promise<void> {
  const list = [...new Set(emails)].filter(Boolean);
  if (list.length === 0) return;
  const currency = await quotaCurrency(new Date());
  await publishChunked(db, list, currency);
}
/** Every known user, e.g. after a platform.quotas change or at startup. Returns the count published. */
export async function republishAll(): Promise<number> {
  const db = await cds.connect.to('db');
  const rows: any[] = await db.run(cds.ql.SELECT.from(USERS).columns('email'));
  const currency = await quotaCurrency(new Date());
  return publishChunked(db, rows.map((r) => r.email).filter(Boolean), currency);
}

let timer: NodeJS.Timeout | null = null;
/** Once a minute: rewrite documents whose day window has rolled over (spec §2). */
export function startRolloverTimer(): void {
  if (timer) return;
  timer = setInterval(async () => {
    const today = windowStarts(new Date()).day.toISOString();
    const stale = [...publishedDay].filter(([, day]) => day !== today).map(([email]) => email);
    if (stale.length === 0) return;
    try { const db = await cds.connect.to('db'); await publishMany(db, stale); }
    catch (error) { logger.warn('UserQuotaService', `rollover failed: ${error instanceof Error ? error.message : String(error)}`); }
  }, 60_000);
  timer.unref?.();
}
export function stopRolloverTimer(): void { if (timer) { clearInterval(timer); timer = null; } }
