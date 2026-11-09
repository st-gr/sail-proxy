/**
 * Quota enforcement (spec §2), after validation on every LLM-serving route. Order: deactivated
 * user → 401; requests per minute (user, then team, then key scope, two-bucket sliding window,
 * exact in Valkey) and per-key hour/day buckets → 429; spend/tokens admission from the user's
 * state document, then the team's pool document (quota:team:<id>) → 429. The gateway never calls the admin here. Valkey unreachable: the same algorithm
 * on per-pod memory buckets plus one quota_unenforced event per five minutes. Standalone mode:
 * per-key RPM in memory only (RATE_LIMIT_RPM, default 100), no user scope.
 */
import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { getDefaultLogger } from '@libs/logger';
import securityEventEmitter from '../services/securityEventEmitter';
import { getClientIp } from '../utils/clientIp';
import { redactUrl } from '../utils/redactUrl';
import { getTrustForwardedFor } from '../services/configService';
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { userFromRequest, teamFromRequest, UserBlock, TeamBlock } from '../utils/userBlock';
import { RateLimitStore, MemoryRateLimitStore, ValkeyRateLimitStore } from '../services/rateLimitStore';
import { QuotaStateReader, AdmissionDocument, WindowName } from '../services/quotaStateReader';

const logger = getDefaultLogger();
const DEFAULT_STANDALONE_RPM = 100;
const UNENFORCED_EVERY_MS = 5 * 60_000;

export interface Caller {
  authType: 'api_key' | 'aws_credential';
  credentialId: string;              // ApiKeys/AwsCredentials row id (never the raw secret)
  email: string | null;
  keyLimits: { minute: number | null; hour: number | null; day: number | null };
  user: UserBlock | null;
  team: TeamBlock | null;
}
export interface Exceeded {
  type: 'rate_limit_exceeded' | 'quota_exceeded';
  scope: 'user' | 'key' | 'team'; team?: string; dimension: 'requests' | 'tokens' | 'spend';
  window: 'minute' | 'hour' | 'day' | 'week' | 'month';
  limit: number; used: number; resetsAt: number;   // epoch ms
}
export interface QuotaDeps {
  store: () => RateLimitStore | null;   // null = no shared store (standalone / not configured)
  clock?: () => number;
  standalone?: () => boolean;
  stateReader?: () => QuotaStateReader | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function standaloneRpm(): number {
  const v = parseInt(process.env.RATE_LIMIT_RPM || '', 10);
  return Number.isInteger(v) && v >= 1 ? v : DEFAULT_STANDALONE_RPM;
}

export function callerFromRequest(req: any): Caller | null {
  const u = req.unifiedAuth?.valid ? req.unifiedAuth.data : null;
  if (u) {
    const rl = u.rateLimits || {};
    return {
      authType: req.unifiedAuth.authType, credentialId: u.keyId || u.credentialId || u.id || 'unknown',
      email: u.email || u.userId || null,
      keyLimits: { minute: num(rl.requestsPerMinute), hour: num(rl.requestsPerHour), day: num(rl.requestsPerDay) },
      user: userFromRequest(req), team: teamFromRequest(req)
    };
  }
  if (req.isAwsAuthenticated && req.awsAuth) {
    const rl = req.awsAuth.rateLimits || {};
    return { authType: 'aws_credential', credentialId: req.awsAuth.credentialId || req.awsAuth.accessKeyId || 'unknown',
      email: req.awsAuth.userId || null,
      keyLimits: { minute: num(rl.requestsPerMinute), hour: num(rl.requestsPerHour), day: num(rl.requestsPerDay) },
      user: userFromRequest(req), team: teamFromRequest(req) };
  }
  if (req.apiKey?.key) {   // local validation (standalone / fallback): the row id when known, else a hash — never the secret
    return { authType: 'api_key', credentialId: req.apiKey.id || `sha256:${sha(req.apiKey.key).slice(0, 16)}`,
      email: req.apiKey.email || null, keyLimits: { minute: standaloneRpm(), hour: null, day: null }, user: null, team: null };
  }
  return null;
}

async function sliding(store: RateLimitStore, prefix: string, now: number): Promise<{ used: number; resetsAt: number }> {
  const minute = Math.floor(now / 60_000);
  const current = await store.incr(`${prefix}:${minute}`, 120);
  const previous = await store.get(`${prefix}:${minute - 1}`);
  const elapsed = (now % 60_000) / 60_000;
  return { used: current + previous * (1 - elapsed), resetsAt: (minute + 1) * 60_000 };
}
async function fixed(store: RateLimitStore, key: string, ttl: number, resetsAt: number): Promise<{ used: number; resetsAt: number }> {
  return { used: await store.incr(key, ttl), resetsAt };
}

/** Whose quota an event names: the caller, or the payer a cockpit grounding call is checked for. */
type QuotaSubject = Pick<Caller, 'credentialId' | 'authType' | 'email'>;

/** quota_exceeded at most once a minute per user/dimension/window; quota_unenforced once per five minutes. */
function createQuotaEvents(clock: () => number) {
  const lastExceeded = new Map<string, number>();
  let lastUnenforced = 0;
  return {
    exceeded(req: any, subject: QuotaSubject, x: Exceeded): void {
      const now = clock();
      const throttleKey = `${subject.email || subject.credentialId}|${x.dimension}|${x.window}`;
      if ((lastExceeded.get(throttleKey) ?? 0) > now - 60_000) return;
      lastExceeded.set(throttleKey, now);
      Promise.resolve(securityEventEmitter.emitQuotaExceeded({
        credentialId: subject.credentialId, authType: subject.authType, ownerEmail: subject.email ?? undefined,
        clientIP: getClientIp(req, getTrustForwardedFor()), userAgent: req.get?.('user-agent'),
        endpoint: redactUrl(req.originalUrl), method: req.method, requestId: req.id, statusCode: 429,
        scope: x.scope, dimension: x.dimension, window: x.window, limit: x.limit, used: x.used
      })).catch((e) => logger.warn('QuotaEnforcement', `quota_exceeded event failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    unenforced(req: any, reason: string): void {
      const now = clock();
      if (lastUnenforced > now - UNENFORCED_EVERY_MS) return;
      lastUnenforced = now;
      Promise.resolve(securityEventEmitter.emitQuotaUnenforced({ reason, clientIP: getClientIp(req, getTrustForwardedFor()), endpoint: redactUrl(req.originalUrl), requestId: req.id }))
        .catch((e) => logger.warn('QuotaEnforcement', `quota_unenforced event failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  };
}

const DAY = 86_400_000;
function windowStartsUtc(now: number): Record<WindowName, number> {
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { day, week: day - ((new Date(day).getUTCDay() + 6) % 7) * DAY, month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
}
function windowEndsUtc(now: number): Record<WindowName, number> {
  const s = windowStartsUtc(now);
  const d = new Date(now);
  return { day: s.day + DAY, week: s.week + 7 * DAY, month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

/** Spend/tokens per window against the document (its limits are fresher than the wire block's). */
function checkAdmission(doc: AdmissionDocument, wireLimits: Partial<UserBlock['limits']>, now: number, scope: 'user' | 'team' = 'user', team?: string): Exceeded | null {
  const starts = windowStartsUtc(now);
  const ends = windowEndsUtc(now);
  const limits: any = { ...wireLimits, ...(doc.limits || {}) };
  for (const w of ['day', 'week', 'month'] as WindowName[]) {
    const W = w[0].toUpperCase() + w.slice(1);
    // A document from before this window began describes the previous window: nothing used yet.
    const fresh = Date.parse(doc.windowStart?.[w] ?? '') >= starts[w];
    const used = fresh ? doc.used?.[w] : undefined;
    const tokensLimit = num(limits[`tokensPer${W}`]);
    if (tokensLimit !== null && (used?.tokens ?? 0) >= tokensLimit)
      return { type: 'quota_exceeded', scope, ...(team ? { team } : {}), dimension: 'tokens', window: w, limit: tokensLimit, used: used?.tokens ?? 0, resetsAt: ends[w] };
    const spendLimit = num(limits[`spendPer${W}`]);
    if (spendLimit !== null && (used?.sapCost ?? 0) >= spendLimit)
      return { type: 'quota_exceeded', scope, ...(team ? { team } : {}), dimension: 'spend', window: w, limit: spendLimit, used: used?.sapCost ?? 0, resetsAt: ends[w] };
  }
  return null;
}

export function createQuotaEnforcement(deps: QuotaDeps) {
  const clock = deps.clock ?? Date.now;
  const standalone = deps.standalone ?? isStandaloneMode;
  const memory = new MemoryRateLimitStore(clock);
  const events = createQuotaEvents(clock);
  // deps.store() is resolved once and then reused for the life of this middleware, not
  // re-invoked per request: the memory store's counters live in the object itself, so a
  // factory that mints a fresh instance on every call (as tests do) would never accumulate.
  // A Valkey wrapper's counters live server-side, so reusing the same wrapper is free and
  // correct there too. Kept null (not yet cached) until deps.store() first returns non-null
  // — this still picks up Valkey once configureQuotaEnforcement runs after this singleton is
  // constructed at module load, before which sharedStore is still null. Once cached, ongoing
  // Valkey unavailability is still caught per request: checkRequests below throws when the
  // client itself is down (enableOfflineQueue: false), which is the fail-open + event path.
  let cachedShared: RateLimitStore | null = null;
  // Same once-resolution as cachedShared, and for the same reason: the brief's test hands a
  // thunk that mints a fresh QuotaStateReader per call, whose own 10 s cache would never
  // accumulate if that thunk were re-invoked every request. Kept null until deps.stateReader?.()
  // first returns non-null.
  let cachedReader: QuotaStateReader | null = null;

  const headers = (res: Response, limit: number, used: number, resetsAt: number) => {
    res.set({
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(Math.max(0, Math.floor(limit - used))),
      'X-RateLimit-Reset': String(Math.floor(resetsAt / 1000))
    });
  };
  const reject = (res: Response, x: Exceeded) => {
    headers(res, x.limit, x.used, x.resetsAt);
    res.set({ 'Retry-After': String(Math.max(1, Math.ceil((x.resetsAt - clock()) / 1000))) });
    res.status(429).json({ error: { type: x.type, scope: x.scope, ...(x.team ? { team: x.team } : {}), dimension: x.dimension, window: x.window,
      limit: x.limit, used: Math.round(x.used * 1000) / 1000, resets_at: new Date(x.resetsAt).toISOString() } });
  };

  /**
   * RPM/hour/day checks against one store, in order: user-minute, key-minute, key-hour,
   * key-day. Throws when the store does. Stops at the first exceeded check — a request already
   * refused for (say) the user-minute limit must not still burn the key's hour/day budget, or a
   * client retrying against a tight per-minute limit gets locked out of the whole hour without
   * ever having been served.
   */
  async function checkRequests(store: RateLimitStore, caller: Caller, now: number): Promise<{ exceeded: Exceeded | null; tightest: { limit: number; used: number; resetsAt: number } | null }> {
    const checks: Array<{ scope: 'user' | 'key' | 'team'; window: 'minute' | 'hour' | 'day'; limit: number; run: () => Promise<{ used: number; resetsAt: number }> }> = [];
    const userLimit = num(caller.user?.limits?.requestsPerMinute);
    // The bucket that identifies the PERSON, not the credential: an AWS credential's
    // unifiedAuth/awsAuth carries only a userId (no email), so a caller's API-key traffic and
    // AWS-credential traffic must share one user-scope bucket via the canonical UserBlock.email
    // — caller.email (the credential's own identity, possibly a userId) is only a fallback.
    const userKeyEmail = caller.user?.email || caller.email;
    if (userKeyEmail && userLimit !== null) checks.push({ scope: 'user', window: 'minute', limit: userLimit, run: () => sliding(store, `rl:user:${sha(userKeyEmail)}`, now) });
    const teamLimit = num(caller.team?.limits?.requestsPerMinute);
    if (caller.team && teamLimit !== null) checks.push({ scope: 'team', window: 'minute', limit: teamLimit, run: () => sliding(store, `rl:team:${caller.team!.teamId}`, now) });
    if (caller.keyLimits.minute !== null) checks.push({ scope: 'key', window: 'minute', limit: caller.keyLimits.minute, run: () => sliding(store, `rl:key:${caller.credentialId}`, now) });
    if (caller.keyLimits.hour !== null) {
      const hour = Math.floor(now / 3_600_000);
      checks.push({ scope: 'key', window: 'hour', limit: caller.keyLimits.hour, run: () => fixed(store, `rl:key:${caller.credentialId}:h:${hour}`, 7200, (hour + 1) * 3_600_000) });
    }
    if (caller.keyLimits.day !== null) {
      const day = Math.floor(now / 86_400_000);
      checks.push({ scope: 'key', window: 'day', limit: caller.keyLimits.day, run: () => fixed(store, `rl:key:${caller.credentialId}:d:${day}`, 172_800, (day + 1) * 86_400_000) });
    }
    let exceeded: Exceeded | null = null;
    let tightest: { limit: number; used: number; resetsAt: number } | null = null;
    for (const c of checks) {
      const { used, resetsAt } = await c.run();
      if (used > c.limit) { exceeded = { type: 'rate_limit_exceeded', scope: c.scope, ...(c.scope === 'team' ? { team: caller.team!.teamName } : {}), dimension: 'requests', window: c.window, limit: c.limit, used, resetsAt }; break; }
      if (!tightest || c.limit - used < tightest.limit - tightest.used) tightest = { limit: c.limit, used, resetsAt };
    }
    return { exceeded, tightest };
  }

  return async function quotaEnforcement(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const caller = callerFromRequest(req);
      if (!caller) {
        res.status(401).json({ error: { message: 'No valid authentication found for quota enforcement', type: 'authentication_error' } });
        return;
      }
      if (caller.user?.status === 'deactivated') {
        res.status(401).json({ error: { type: 'user_deactivated', message: 'This user account is deactivated' } });
        return;
      }
      const now = clock();
      const isStandalone = standalone();
      const shared = isStandalone ? null : (cachedShared ?? (cachedShared = deps.store()));
      let result: Awaited<ReturnType<typeof checkRequests>>;
      try {
        result = await checkRequests(shared ?? memory, caller, now);
      } catch (error) {
        // Valkey unreachable: same algorithm on this pod's buckets, and say so once per five minutes.
        events.unenforced(req, `rate-limit store unavailable: ${error instanceof Error ? error.message : String(error)}`);
        result = await checkRequests(memory, caller, now);
      }
      if (result.exceeded) { events.exceeded(req, caller, result.exceeded); reject(res, result.exceeded); return; }
      // Spend and tokens: only a caller with a user block on the wire can have user-level quotas.
      // The admission guard and the state lookup must agree on which e-mail to use — the guard
      // used to check caller.email while the lookup below resolved caller.user.email first,
      // so a caller whose user.email differed from caller.email could pass the guard and then
      // silently look up the wrong (or no) document.
      const userKeyEmail = caller.user?.email || caller.email;
      if (caller.user && userKeyEmail && !isStandalone) {
        const reader = cachedReader ?? (cachedReader = deps.stateReader?.() ?? null);
        const doc = reader ? await reader.get(userKeyEmail) : undefined;
        if (doc === undefined) {
          events.unenforced(req, 'quota state unavailable');
        } else if (doc) {
          const exceeded = checkAdmission(doc, caller.user.limits, now);
          if (exceeded) { events.exceeded(req, caller, exceeded); reject(res, exceeded); return; }
        }
      }
      if (caller.team && !isStandalone) {
        const reader = cachedReader ?? (cachedReader = deps.stateReader?.() ?? null);
        const teamDoc = reader ? await reader.getTeam(caller.team.teamId) : undefined;
        if (teamDoc === undefined) events.unenforced(req, 'team quota state unavailable');
        else if (teamDoc) {
          const exceeded = checkAdmission(teamDoc, caller.team.limits, now, 'team', caller.team.teamName);
          if (exceeded) { events.exceeded(req, caller, exceeded); reject(res, exceeded); return; }
        }
      }
      if (result.tightest) headers(res, result.tightest.limit, result.tightest.used, result.tightest.resetsAt);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---- process-wide instance, configured from index.ts -------------------------------------------
let sharedStore: ValkeyRateLimitStore | null = null;
let sharedReader: QuotaStateReader | null = null;
export function configureQuotaEnforcement(opts: { valkeyClient?: any }): void {
  sharedStore = opts.valkeyClient ? new ValkeyRateLimitStore(opts.valkeyClient) : null;
  sharedReader = new QuotaStateReader(opts.valkeyClient);
}

export interface OwnerAdmissionDeps {
  /** Must return the same reader on every call: its ten-second cache is what keeps this one GET per user. */
  stateReader: () => QuotaStateReader | null;
  clock?: () => number;
  standalone?: () => boolean;
}

/**
 * The spend/token admission above (checkAdmission), keyed on an e-mail instead of a credential:
 * for a call made FOR a user who sent no credential of their own — the cockpit's grounding routes,
 * checked against whoever pays: the store owner for store work, the searcher for a search
 * (middlewares/groundingQuota.ts). Only the
 * document decides (it carries the effective limits); no requests-per-minute check (no RPM on
 * cockpit calls). Fails open like the model routes: unreadable state → null plus one
 * quota_unenforced event; standalone → null. Returns what was exceeded, or null to admit.
 */
export function createOwnerAdmission(deps: OwnerAdmissionDeps) {
  const clock = deps.clock ?? Date.now;
  const standalone = deps.standalone ?? isStandaloneMode;
  const events = createQuotaEvents(clock);
  return async function admitOwner(req: any, email: string): Promise<Exceeded | null> {
    if (standalone()) return null;
    const reader = deps.stateReader();
    const doc = reader ? await reader.get(email) : undefined;
    if (doc === undefined) { events.unenforced(req, 'quota state unavailable'); return null; }
    if (!doc) return null;
    const exceeded = checkAdmission(doc, {}, clock());
    let result = exceeded;
    if (!result && doc.primaryTeamId) {
      const teamDoc = await reader!.getTeam(doc.primaryTeamId);
      if (teamDoc === undefined) events.unenforced(req, 'team quota state unavailable');
      else if (teamDoc) result = checkAdmission(teamDoc, {}, clock(), 'team', teamDoc.teamName);
    }
    if (result) events.exceeded(req, { credentialId: req.serviceAuth?.serviceKey?.id || 'grounding', authType: 'api_key', email }, result);
    return result;
  };
}
/** The process-wide owner admission, on the reader configureQuotaEnforcement sets. */
export const admitOwner = createOwnerAdmission({ stateReader: () => sharedReader });

const quotaEnforcement = createQuotaEnforcement({
  store: () => (sharedStore && sharedStore.ready() ? sharedStore : null),
  stateReader: () => sharedReader
});
export default quotaEnforcement;
