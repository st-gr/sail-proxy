/**
 * Users & quotas handlers (spec §4), registered on AdminService from admin-service.ts init(). All
 * rules live in usersService / userLifecycleService / userQuotaService; this file maps requests to
 * them and errors to HTTP statuses, mirroring admin-service-library.ts.
 */
import { getDefaultLogger } from '@libs/logger';
import { getUser, touch, USERS, DbLike } from '../services/usersService';
import * as lifecycle from '../services/userLifecycleService';
import * as quota from '../services/userQuotaService';
import * as counters from '../services/usageCounters';
import { usageSummary } from '../services/usageSummaryService';
import { LIMIT_FIELDS, validateConstraints, defaultText, effectiveLimitText } from '../services/quotaLimits';
import { criticality } from '../services/quotaCriticality';
import { credentialRateLimitsFor, setCredentialRateLimits, RateLimitTarget } from '../services/rateLimitsService';
import { invalidateForEmails, clearLocalValidationCache } from '../services/credentialInvalidation';
import { recordAuditEvent } from '../services/auditEventService';
import { clientContext } from '../utils/clientIp';
import { isAdminRole } from '../services/modelEntitlementService';
import { cacheInvalidationService } from '../services/cacheInvalidationService';
import { applyQueryOptions } from './odataInMemory';
import { policyBlockFor } from '../services/toolPolicyService';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
const DEFAULT_QUOTA_STATUS_PAGE_SIZE = 25;
const MAX_QUOTA_STATUS_PAGE_SIZE = 200;
const EDITABLE = new Set<string>([...LIMIT_FIELDS, 'displayName']);
const DRAFT_META = new Set(['email', 'IsActiveEntity', 'HasActiveEntity', 'HasDraftEntity', 'DraftAdministrativeData_DraftUUID', 'DraftAdministrativeData', 'modifiedAt', 'modifiedBy', 'createdAt', 'createdBy']);
const WINDOWS = ['Day', 'Week', 'Month'] as const;
// Every key flatten() (or afterReadUsers itself) writes onto a Users/Users.drafts row: never client
// input, but draftActivate reads the draft row back through the same READ pipeline that populates
// them, then resubmits the full row to UPDATE - so the read-only check below must not trip on them.
// `quotaProfile_ID` and `toolPolicy_ID` are deliberately NOT here: neither is written by the READ
// pipeline, and assignQuotaProfile/unassignQuotaProfile (resp. assignToolPolicy/unassignToolPolicy)
// are their only write path. The users-app annotates quotaProfile_ID Common.FieldControl: #ReadOnly,
// so cds already drops it from a draft PATCH payload before this loop runs - the exclusion just
// keeps the guard from ever accepting either should that annotation move or be missing.
const VIRTUAL_FIELDS = new Set<string>([
  'usedRequestsMinute', 'sapCostCurrency', 'quotaProfileName', 'resetsAtDay', 'resetsAtWeek', 'resetsAtMonth', 'canDeactivate', 'canReactivate', 'statusCriticality',
  ...WINDOWS.flatMap((w) => [`usedSpend${w}`, `usedTokens${w}`, `remainingSpend${w}`, `remainingTokens${w}`, `effectiveSpendPer${w}Currency`, `criticalitySpend${w}`, `criticalityTokens${w}`]),
  ...LIMIT_FIELDS.flatMap((f) => { const F = f[0].toUpperCase() + f.slice(1); return [`effective${F}`, `limitSource${F}`, `${f}DefaultText`]; })
]);

const roles = (req: any): string[] => { const r = req.user?.roles || req.user?.scope || []; return Array.isArray(r) ? r : Object.keys(r); };
const actor = (req: any): string => req.user?.id || 'anonymous';
const keyEmail = (req: any): string => { const p = req.params?.[0]; return decodeURIComponent(typeof p === 'object' ? p.email : p); };
const ctxOf = (req: any, reason?: string) => ({ actor: actor(req), reason, ...clientContext(req) });

function fail(req: any, e: any): void {
  if (e instanceof lifecycle.UserDeactivatedError) { req.reject({ status: 403, code: e.code, message: e.message }); return; }
  const message = e instanceof Error ? e.message : String(e);
  if (/is not a user|not found/.test(message)) { req.reject(404, message); return; }
  logger.error('AdminService/Users', 'unexpected error', e instanceof Error ? e : new Error(message));
  req.reject(500, message);
}

/** Flatten a QuotaStatus onto a Users row / UserQuotaStatus row (the "virtual fields" of spec §4). */
function flatten(s: quota.QuotaStatus): Record<string, any> {
  const out: Record<string, any> = { usedRequestsMinute: s.used.minuteRequests, sapCostCurrency: s.sapCostCurrency, quotaProfileName: s.quotaProfileName, resetsAtDay: s.resetsAt.day, resetsAtWeek: s.resetsAt.week, resetsAtMonth: s.resetsAt.month };
  for (const w of WINDOWS) {
    const lw = w.toLowerCase() as 'day' | 'week' | 'month';
    out[`usedSpend${w}`] = s.used[lw].sapCost; out[`usedTokens${w}`] = s.used[lw].tokens;
    out[`remainingSpend${w}`] = s.remaining[`spend${w}` as const]; out[`remainingTokens${w}`] = s.remaining[`tokens${w}` as const];
  }
  for (const f of LIMIT_FIELDS) {
    const F = f[0].toUpperCase() + f.slice(1);
    out[`effective${F}`] = s.limits[f]; out[`limitSource${F}`] = s.limitSource[f];
  }
  return out;
}

/**
 * The virtuals a Users row carries beyond its own columns, from that user's QuotaStatus. Shared by
 * the after-READ fan-out and by userRowWithVirtuals() below.
 */
function applyStatusVirtuals(row: any, s: quota.QuotaStatus): void {
  // Users declares used*/effective*/limitSource*/resetsAt* only (spec §4) - remaining* is
  // UserQuotaStatus-only, so drop it here or CAP rejects the unmodeled property.
  const fields = flatten(s);
  for (const w of WINDOWS) { delete fields[`remainingSpend${w}`]; delete fields[`remainingTokens${w}`]; }
  Object.assign(row, fields);
  // An effective limit's currency is present only with the limit: the users-app renders the
  // currency beside an empty amount, and "USD" alone would read as a value, not as unlimited.
  for (const w of WINDOWS) row[`effectiveSpendPer${w}Currency`] = row[`effectiveSpendPer${w}`] == null ? null : s.sapCostCurrency;
  // Bullet-chart colours for the users-app (annotations read criticality from a field, spec §2).
  for (const w of WINDOWS) {
    row[`criticalitySpend${w}`] = criticality(row[`usedSpend${w}`], row[`effectiveSpendPer${w}`]);
    row[`criticalityTokens${w}`] = criticality(row[`usedTokens${w}`], row[`effectiveTokensPer${w}`]);
  }
  // What an EMPTY constraint inherits, named beside the empty field (spec §4.2).
  for (const f of LIMIT_FIELDS) row[`${f}DefaultText`] = defaultText(f, s);
}

/**
 * OData V4 serialises Edm.Int64 as a JSON string when the client asks for IEEE754Compatible
 * (the UI5 V4 model always does); CAP stringifies only what the database returns, so the computed
 * Integer64 virtuals are coerced here for such clients. UI5's Int64 type throws on a JSON number
 * when it converts for a float property — the users-app bullet charts' target value.
 */
export function wantsIeee754(req: any): boolean {
  return /IEEE754Compatible=true/i.test(String(req?.headers?.accept || ''));
}
function stringifyInt64Virtuals(row: any): void {
  for (const w of WINDOWS) {
    for (const k of [`usedTokens${w}`, `effectiveTokensPer${w}`]) if (row[k] !== null && row[k] !== undefined) row[k] = String(row[k]);
  }
}

/** The lifecycle flags the list and the object page render; set even when the quota status failed. */
function applyLifecycleFlags(row: any): void {
  row.canDeactivate = row.status === 'active'; row.canReactivate = row.status === 'deactivated';
  row.statusCriticality = row.status === 'active' ? 3 : 1;
}

/**
 * One Users row carrying the virtuals the READ pipeline would have written onto it. A `returns
 * Users` action's answer is serialized straight out of its handler and is never dispatched as a
 * READ, so the after-READ handler below never sees it: assignQuotaProfile/unassignQuotaProfile
 * (admin-service-quota-profiles.ts) build their answer through here instead.
 */
export async function userRowWithVirtuals(email: string, ieee754 = false): Promise<any> {
  const row = await cds.run(cds.ql.SELECT.one.from('AdminService.Users').where({ email }));
  if (!row) return row;
  applyStatusVirtuals(row, await quota.status(cds, email));
  if (ieee754) stringifyInt64Virtuals(row);
  applyLifecycleFlags(row);
  return row;
}

async function requireUser(db: DbLike, req: any, email: string) {
  const user = await getUser(db, email);
  if (!user) { req.reject(404, `User ${email} not found`); return null; }
  return user;
}

/**
 * The stored Users row an UPDATE is about, read at most once per request.
 *
 * Two before-UPDATE handlers need it - the constraint check weighs the patch against the values
 * already stored, and the draft's read-only comparison reads the same row - and the admin's SQLite
 * has a single connection, so the second one reuses what the first read instead of asking again.
 * The promise is memoized, not its result, so two handlers in the same request share one query
 * whichever order they run in.
 */
const currentUserByRequest = new WeakMap<object, Promise<any>>();
function currentUserOf(req: any): Promise<any> {
  let pending = currentUserByRequest.get(req);
  if (!pending) {
    pending = getUser(cds, req.data?.email ?? keyEmail(req));
    currentUserByRequest.set(req, pending);
  }
  return pending;
}

// ---- UserCredentials: $filter/$orderby/$top/$skip/$count in memory (odataInMemory.ts) -----
const CREDENTIAL_FIELDS = new Set(['credentialId', 'type', 'email', 'name', 'isActive', 'lockedByUserDeactivation', 'expiresAt', 'neverExpires', 'lastUsed']);

/**
 * The un-cleansed OData query. AdminService is draft-enabled (Users/ApiKeys/AwsCredentials), and
 * CAP's lean-draft handling (libx/_runtime/fiori/lean-draft.js) cleanses every query dispatched
 * through the service - including this non-draft entity's - replacing req.query.SELECT with a
 * generic default (limit 1000, order by key) and stashing the real $filter/$orderby/$top/$skip/
 * $count on a module-private `Symbol('original')`. Recovered here by description rather than by
 * importing the symbol (lean-draft.js does not export it). Falls back to the query itself outside
 * a draft-enabled service, where the symbol is never attached.
 */
function realQuery(query: any): any {
  const sym = Object.getOwnPropertySymbols(query || {}).find((s) => s.description === 'original');
  return (sym && query[sym]) || query;
}

/** A bare `email eq '...'` $filter (the common case - the object page filters by the row's own
 * email) is the only condition worth pushing down to the DB, since it is the one UserCredentials
 * field both underlying tables actually have as a column. */
function soleEmailEquality(where: any[] | undefined): string | undefined {
  if (!Array.isArray(where) || where.length !== 3 || where[1] !== '=') return undefined;
  const [lhs, , rhs] = where;
  if (lhs?.ref?.[0] === 'email' && rhs && 'val' in rhs) return rhs.val;
  if (rhs?.ref?.[0] === 'email' && lhs && 'val' in lhs) return lhs.val;
  return undefined;
}

export function registerUserHandlers(service: any): void {
  // ---- Users: read-only fields, validation, base-table redirect, virtuals ----------------
  // The read-only-field comparison runs ONLY for the draft (a client PATCH carries exactly the
  // fields it sent). draftActivate resubmits the WHOLE draft row as an UPDATE on the active
  // 'Users' entity, including columns usersService.touch()/lifecycle/quota rewrite between
  // draftEdit and activation (lastSeenAt, rolesSnapshot, status, quotaResetAt, ...) - comparing
  // those against the CURRENT row here would 400 a legitimate save on nothing but timing. The
  // 'on UPDATE' writer below only ever persists EDITABLE fields regardless, so skipping the
  // comparison on 'Users' cannot let a server-owned column through.
  service.before('UPDATE', ['Users', 'Users.drafts'], async (req: any) => {
    // Against the stored row, not the patch alone: a save that sends one window has to be weighed
    // against the others already stored, or `tokensPerDay 100` beside a stored `tokensPerMonth 10`
    // is never compared with anything. `currentUserOf` is the one read the draft handler shares.
    const errors = validateConstraints(req.data || {}, await currentUserOf(req));
    if (errors.length) { req.reject(400, errors.join('; ')); return; }
  });
  service.before('UPDATE', 'Users.drafts', async (req: any) => {
    const current = await currentUserOf(req);
    for (const [k, v] of Object.entries(req.data || {})) {
      if (EDITABLE.has(k) || DRAFT_META.has(k) || VIRTUAL_FIELDS.has(k)) continue;
      const stored = (current as any)?.[k];
      const same = v === stored || (v == null && stored == null) || (v != null && stored != null && String(v) === String(stored));
      if (!same) { req.reject(400, `${k} is read-only`); return; }
    }
  });
  service.on('UPDATE', 'Users', async (req: any) => {
    const email = req.data?.email ?? keyEmail(req);
    const patch: any = {};
    for (const k of EDITABLE) if (k in (req.data || {})) patch[k] = req.data[k] === '' ? null : req.data[k];
    const editedFields = { ...patch };
    patch.modifiedAt = new Date().toISOString(); patch.modifiedBy = actor(req);
    await cds.run(cds.ql.UPDATE(USERS).set(patch).where({ email }));
    await quota.publish(cds, email);
    await invalidateForEmails(cds, [email], 'constraints');
    await recordAuditEvent({ actorId: actor(req), actorType: 'admin_user', action: 'user.set_constraints', resourceType: 'User', resourceId: email, outcome: 'success', severity: 'medium', ...clientContext(req), details: JSON.stringify(editedFields) });
    return cds.run(cds.ql.SELECT.one.from('AdminService.Users').where({ email }));
  });
  service.after('READ', ['Users', 'Users.drafts'], async (rows: any, req: any) => {
    const list = (Array.isArray(rows) ? rows : rows ? [rows] : []).filter((row: any) => row?.email);
    if (list.length === 0) return;
    // One statusMany for the whole page rather than one status() per row: the quota currency and
    // the platform defaults are resolved once for the page and the fan-out is chunked and yields
    // between chunks (userQuotaService), so a wide list page - and every Common.SideEffects round
    // trip that re-reads it - cannot hold the admin's single SQLite connection for its whole
    // length. A row whose status failed is missing from the map and keeps its stored values.
    const statuses = await quota.statusMany(cds, list.map((row: any) => row.email));
    const ieee754 = wantsIeee754(req);
    for (const row of list) {
      const s = statuses.get(row.email);
      if (s) applyStatusVirtuals(row, s);
      if (s && ieee754) stringifyInt64Virtuals(row);
      applyLifecycleFlags(row);
    }
  });

  // ---- read-only companions -------------------------------------------------------------
  service.on('READ', 'UserCredentials', async (req: any) => {
    const { SELECT } = cds.ql;
    const cols = ['ID', 'email', 'name', 'isActive', 'lockedByUserDeactivation', 'expiresAt', 'neverExpires', 'lastUsed'];
    // AdminService is draft-enabled (Users/ApiKeys/AwsCredentials); CAP's lean-draft handling
    // cleanses every query in the service, including this non-draft entity's - the "public"
    // req.query carries a generic default (limit 1000, order by key) and the true $filter/
    // $orderby/$top/$skip/$count is stashed on realQuery() below. A freshly built SELECT.from(...)
    // inherits that ambient where/orderBy/limit too unless given its own - hence the explicit
    // .where() on every sub-query, even the unfiltered case.
    const real = realQuery(req.query).SELECT ?? {};
    const soleEmail = soleEmailEquality(real.where);
    // The only DB-side optimisation: a bare `email eq '...'` condition (the common case - the
    // object page filters by the row's own email) is pushed down since both tables have the
    // column; anything else (type, credentialId are not columns either table has) is evaluated
    // in memory below against the full merged set.
    const query = (table: string) => SELECT.from(table).columns(...cols).where(soleEmail ? { email: soleEmail } : { ID: { '!=': null } });
    const keys = (await cds.run(query('sap.llm.gateway.admin.ApiKeys'))).map((k: any) => ({ credentialId: k.ID, type: 'api_key', ...k, ID: undefined }));
    const creds = (await cds.run(query('sap.llm.gateway.admin.AwsCredentials'))).map((c: any) => ({ credentialId: c.ID, type: 'aws_credential', ...c, ID: undefined }));
    const all = [...keys, ...creds].map(({ ID, ...r }) => r);

    const key = req.params?.[0]; const wanted = typeof key === 'object' ? key.credentialId : key;
    if (wanted) return all.find((r) => r.credentialId === wanted);

    // soleEmail was already applied at the DB level above - re-filtering it in memory would be
    // redundant (harmless, but skipped rather than relied upon).
    try {
      const { rows, count } = applyQueryOptions(all, { where: soleEmail ? undefined : real.where, orderBy: real.orderBy, limit: real.limit }, CREDENTIAL_FIELDS);
      if (real.count) (rows as any).$count = count;
      return rows;
    } catch (e) {
      req.reject(400, e instanceof Error ? e.message : 'unsupported $filter on UserCredentials');
    }
  });
  service.on('READ', 'UserQuotaStatus', async (req: any) => {
    const { SELECT } = cds.ql;
    const key = req.params?.[0]; const one = typeof key === 'object' ? key.email : key;
    // Key-addressed reads stay as they are: one row, current currency lookup.
    if (one) {
      const email = decodeURIComponent(one);
      const s = await quota.status(cds, email);
      return { email, status: s.status, lastSeenAt: s.lastSeenAt, quotaResetAt: s.quotaResetAt, ...s.limits, ...flatten(s) };
    }
    // AdminService is draft-enabled: the real $top/$skip/$count is on realQuery(), not on
    // req.query itself (see realQuery()'s doc comment above).
    const real = realQuery(req.query).SELECT ?? {};
    const requestedRows = real.limit?.rows?.val;
    const pageSize = Math.min(typeof requestedRows === 'number' ? requestedRows : DEFAULT_QUOTA_STATUS_PAGE_SIZE, MAX_QUOTA_STATUS_PAGE_SIZE);
    const offset = real.limit?.offset?.val ?? 0;
    const page: any[] = await cds.run(SELECT.from(USERS).columns('email').orderBy('email').limit(pageSize, offset));
    const statuses = await quota.statusMany(cds, page.map((u: any) => u.email));
    const rows = [];
    for (const u of page) {
      const s = statuses.get(u.email);
      if (!s) throw new Error(`quota status unavailable for ${u.email}`);
      rows.push({ email: u.email, status: s.status, lastSeenAt: s.lastSeenAt, quotaResetAt: s.quotaResetAt, ...s.limits, ...flatten(s) });
    }
    if (real.count) {
      const [{ total }] = await cds.run(SELECT.from(USERS).columns('count(*) as total'));
      (rows as any).$count = Number(total) || 0;
    }
    return rows;
  });

  // ---- actions --------------------------------------------------------------------------
  const deactivate = async (req: any, email: string, reason?: string) => {
    try { if (!(await requireUser(cds, req, email))) return; return await lifecycle.deactivate(cds, email, ctxOf(req, reason)); } catch (e) { return fail(req, e); }
  };
  const reactivate = async (req: any, email: string) => {
    try { if (!(await requireUser(cds, req, email))) return; return await lifecycle.reactivate(cds, email, ctxOf(req)); } catch (e) { return fail(req, e); }
  };
  const reset = async (req: any, email: string) => {
    const user = await getUser(cds, email);
    if (!user) return { email, ok: false, message: 'not found', quotaResetAt: null };
    const now = new Date();
    // The watermark and the buckets move together (spec §3.4): rows are never deleted, the buckets
    // are. Plain sequential cds.run() calls, both joining the request's own ambient transaction -
    // NOT cds.tx(fn), which always opens an independent root transaction (lib/srv/srv-tx.js) and
    // deadlocks the admin's single SQLite connection against the one this request already holds
    // (the same root cause documented at modelCostService.ts:getServiceApiKey).
    await cds.run(cds.ql.UPDATE(USERS).set({ quotaResetAt: now }).where({ email }));
    await cds.run(cds.ql.DELETE.from(counters.BUCKETS).where({ email }));
    await quota.publish(cds, email);
    await recordAuditEvent({ actorId: actor(req), actorType: 'admin_user', action: 'user.reset_quota', resourceType: 'User', resourceId: email, outcome: 'success', severity: 'medium', ...clientContext(req) });
    return { email, ok: true, message: 'reset', quotaResetAt: now };
  };
  service.on('deactivate', 'Users', (req: any) => deactivate(req, keyEmail(req), req.data?.reason));
  service.on('reactivate', 'Users', (req: any) => reactivate(req, keyEmail(req)));
  service.on('resetQuota', 'Users', (req: any) => reset(req, keyEmail(req)));
  service.on('deactivateUser', (req: any) => deactivate(req, req.data.email, req.data.reason));
  service.on('reactivateUser', (req: any) => reactivate(req, req.data.email));
  service.on('resetUserQuotas', async (req: any) => {
    const out = [];
    for (const email of new Set<string>((req.data.emails || []).filter(Boolean))) out.push(await reset(req, email));
    return out;
  });
  service.on('rebuildUsageCounters', async (req: any) => {
    const emails = [...new Set<string>((req.data.emails || []).filter(Boolean))];
    const scope = emails.length > 0 ? emails : undefined;
    try {
      const r = await counters.rebuild(cds, { emails: scope });
      if (scope) await quota.publishMany(cds, scope); else await quota.republishAll();
      await recordAuditEvent({ actorId: actor(req), actorType: 'admin_user', action: 'user.rebuild_usage_counters', resourceType: 'User', resourceId: scope ? scope.join(',') : '*', outcome: 'success', severity: 'medium', ...clientContext(req), details: JSON.stringify({ users: r.users, buckets: r.buckets, durationMs: r.durationMs }) });
      return scope
        ? scope.map((email) => ({ email, ok: true, buckets: r.bucketsByUser[email] ?? 0, message: 'rebuilt' }))
        : [{ email: '*', ok: true, buckets: r.buckets, message: `rebuilt ${r.users} users` }];
    } catch (e) { return fail(req, e); }
  });
  service.on('setUserConstraints', async (req: any) => {
    const { email, constraints = {} } = req.data;
    const current = await requireUser(cds, req, email);
    if (!current) return;
    // The row requireUser just read is what the patch is weighed against - a constraint action
    // sends only the fields it changes, so the windows it does not send are the stored ones.
    const errors = validateConstraints(constraints, current);
    if (errors.length) { req.reject(400, errors.join('; ')); return; }
    const patch: any = { modifiedAt: new Date().toISOString(), modifiedBy: actor(req) };
    for (const f of LIMIT_FIELDS) if (constraints[f] !== undefined) patch[f] = constraints[f];
    await cds.run(cds.ql.UPDATE(USERS).set(patch).where({ email }));
    await quota.publish(cds, email);
    await invalidateForEmails(cds, [email], 'constraints');
    await recordAuditEvent({ actorId: actor(req), actorType: 'admin_user', action: 'user.set_constraints', resourceType: 'User', resourceId: email, outcome: 'success', severity: 'medium', ...clientContext(req), details: JSON.stringify(constraints) });
    return cds.run(cds.ql.SELECT.one.from('AdminService.Users').where({ email }));
  });
  service.on('userQuotaStatus', async (req: any) => {
    if (!(await requireUser(cds, req, req.data.email))) return;
    return quota.status(cds, req.data.email);
  });
  service.on('myQuotaStatus', async (req: any) => {
    await touch(cds, actor(req), { roles: roles(req) });
    // profileLimits and platformLimits are the raw inputs of the resolution, carried on QuotaStatus
    // only for the admin READ path's defaultText (quotaLimits.defaultText). They are admin
    // configuration - the platform-wide defaults and a shared profile's figures - and cds does not
    // prune keys the return type does not model (Object.assign onto the OData result), so they are
    // stripped here: the caller gets their own effective limits and their profile's NAME, no more.
    const { profileLimits, platformLimits, ...mine } = await quota.status(cds, actor(req));
    const block = await policyBlockFor(cds.db, actor(req));
    return { ...mine, toolPolicy: { name: block.policyName, mode: block.mode } };
  });
  // The home tiles: an administrator sees every user's month, everyone else their own.
  service.on('myUsageSummary', async (req: any) => usageSummary(cds, { email: actor(req), isAdmin: isAdminRole(roles(req)) }));
  // The models whose usage is counted in cells (SAP-RPT): names models, not usage, so every
  // signed-in caller (admin or not) may read it - drives the Unit column in Usage Analytics.
  service.on('usageUnits', async () => {
    const rows = await cds.run(cds.ql.SELECT.distinct.from('sap.llm.gateway.admin.ApiKeyUsage').columns('model', 'unit').where({ unit: 'cells' }));
    return rows.map((r: any) => ({ model: r.model, unit: r.unit }));
  });

  // ---- per-credential rate limits ------------------------------------------------------
  const rateLimitAction = (entity: 'ApiKeys' | 'AwsCredentials') => async (req: any) => {
    const p = req.params?.[0]; const ID = typeof p === 'object' ? p.ID : p;
    const values: any = {};
    for (const f of ['requestsPerMinute', 'requestsPerHour', 'requestsPerDay'] as const) {
      if (req.data[f] === undefined) continue;                 // absent: leave the field unchanged
      if (req.data[f] === null) { values[f] = null; continue; } // explicit null: clear the per-credential limit
      if (!Number.isInteger(req.data[f]) || req.data[f] < 1) { req.reject(400, `${f} must be an integer >= 1`); return; }
      values[f] = req.data[f];
    }
    const table = `sap.llm.gateway.admin.${entity}`;
    const row = await cds.run(cds.ql.SELECT.one.from(table).columns('ID', 'email', entity === 'ApiKeys' ? 'key' : 'accessKeyId').where({ ID }));
    if (!row) { req.reject(404, `${entity} ${ID} not found`); return; }
    if (!isAdminRole(roles(req)) && row.email !== actor(req)) { req.reject(403, 'only the owner or an administrator may set rate limits'); return; }
    const target: RateLimitTarget = entity === 'ApiKeys' ? { apiKeyId: ID } : { awsCredentialId: ID };
    // RateLimits.requestsPerHour/Day carry a CDS `default` (60/1000/10000) for the legacy
    // ApiKeys.rateLimits composition; a brand-new per-credential row must not silently pick those
    // up for a field the caller left out, so an unset field is nulled explicitly on first insert.
    const existing = await cds.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.RateLimits').columns('ID')
      .where(entity === 'ApiKeys' ? { apiKey_ID: ID } : { awsCredential_ID: ID }));
    if (!existing) for (const f of ['requestsPerMinute', 'requestsPerHour', 'requestsPerDay'] as const) if (values[f] === undefined) values[f] = null;
    const stored = await setCredentialRateLimits(cds, target, values);
    try {
      if (entity === 'ApiKeys') { await cacheInvalidationService.invalidateApiKey(row.key, 'manual', `rate-limits-${Date.now()}`); clearLocalValidationCache([row.key], []); }
      else { await cacheInvalidationService.invalidateAwsCredential(row.accessKeyId, 'manual', `rate-limits-${Date.now()}`); clearLocalValidationCache([], [row.accessKeyId]); }
    } catch (e) { logger.warn('AdminService/Users', `rate-limit cache invalidation failed: ${e instanceof Error ? e.message : String(e)}`); }
    await recordAuditEvent({ actorId: actor(req), actorType: isAdminRole(roles(req)) ? 'admin_user' : 'user', action: `${entity === 'ApiKeys' ? 'api_key' : 'aws_credential'}.rate_limits`, resourceType: entity === 'ApiKeys' ? 'ApiKey' : 'AwsCredential', resourceId: ID, outcome: 'success', severity: 'low', ...clientContext(req), details: JSON.stringify(values) });
    return stored;
  };
  service.on('setRateLimits', 'ApiKeys', rateLimitAction('ApiKeys'));
  service.on('setRateLimits', 'AwsCredentials', rateLimitAction('AwsCredentials'));
  service.after('READ', ['ApiKeys', 'ApiKeys.drafts', 'AwsCredentials', 'AwsCredentials.drafts'], async (rows: any, req: any) => {
    const isAws = String(req.target?.name || '').includes('AwsCredentials');
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const ids = list.filter((r: any) => r?.ID).map((r: any) => r.ID);
    if (ids.length === 0) return;
    // One SELECT for the whole page (chunked at 200), not one per row - the ApiKeys/AwsCredentials
    // list is an existing main screen on the admin's single SQLite connection.
    const limits = await credentialRateLimitsFor(cds, isAws ? 'awsCredential' : 'apiKey', ids);
    const empty = { requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null };
    for (const row of list) {
      if (!row?.ID) continue;
      Object.assign(row, limits.get(row.ID) ?? empty);
    }
    // The owner's user-level per-minute limit, the second layer the gateway checks: one quota
    // status per distinct owner on the page (statusMany fans out in bounded chunks), rendered with
    // its source so the credential page shows both layers side by side.
    // A $select without `email` (a list column, a $select probe) still needs the owner: one
    // SELECT by ID fills the gap for exactly those rows.
    const ownerOf = new Map<string, string>(list.filter((r: any) => typeof r?.email === 'string').map((r: any) => [r.ID, r.email]));
    const withoutEmail = ids.filter((id: string) => !ownerOf.has(id));
    if (withoutEmail.length) {
      const entity = isAws ? 'sap.llm.gateway.admin.AwsCredentials' : 'sap.llm.gateway.admin.ApiKeys';
      for (const r of await cds.run(cds.ql.SELECT.from(entity).columns('ID', 'email').where({ ID: { in: withoutEmail } }))) {
        if (typeof r.email === 'string') ownerOf.set(r.ID, r.email);
      }
    }
    const owners = [...new Set([...ownerOf.values()].filter((e) => e.length > 0))];
    const statuses = owners.length ? await quota.statusMany(cds, owners) : new Map();
    for (const row of list) {
      if (!row?.ID) continue;
      const email = ownerOf.get(row.ID);
      const s = email ? statuses.get(email) : undefined;
      row.ownerRequestsPerMinuteText = s ? effectiveLimitText('requestsPerMinute', s) : 'unlimited';
    }
  });
}
