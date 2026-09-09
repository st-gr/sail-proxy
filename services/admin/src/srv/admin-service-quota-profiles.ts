/**
 * Quota profiles handlers (spec 2026-09-08), registered on AdminService from admin-service.ts
 * init(). A profile is a named set of the seven limits that sits between a user's own values and
 * platform.quotas; the rules it enforces here are the ones a user's own constraints already obey
 * (non-negative, ordered windows) plus the two a shared row needs: a unique, trimmed name, and no
 * deletion while somebody is assigned.
 *
 * assignQuotaProfile/unassignQuotaProfile are the ONLY write path for Users.quotaProfile_ID - the
 * draft's read-only guard (admin-service-users.ts) refuses a PATCH of it - so every assignment is
 * audited, republishes the user's quota document and invalidates their credential cache from one
 * place. Editing a profile's LIMITS does the same for every user assigned to it; a name- or
 * description-only edit is audited alone.
 *
 * Reads and writes join the request's own transaction through cds.run: a cds.tx(fn) here would open
 * an independent root transaction and deadlock the admin's single SQLite connection against the one
 * the request already holds (see admin-service-users.ts:reset).
 */
import { getUser, backfillUsers, USERS } from '../services/usersService';
import * as profiles from '../services/quotaProfilesService';
import * as quota from '../services/userQuotaService';
import { LIMIT_FIELDS, validateConstraints } from '../services/quotaLimits';
import { invalidateForEmails } from '../services/credentialInvalidation';
import { recordAuditEvent, AuditEventInput } from '../services/auditEventService';
import { clientContext } from '../utils/clientIp';
import { userRowWithVirtuals } from './admin-service-users';

const cds = require('@sap/cds');

const actor = (req: any): string => req.user?.id || 'anonymous';
/** The key of a QuotaProfiles request, whether CAP hands it over as `{ ID }` or as the bare UUID. */
const keyId = (req: any): string => { const p = req.params?.[0]; return typeof p === 'object' && p !== null ? p.ID : p; };
const audit = (req: any, action: string, resourceId: string): AuditEventInput => ({
  actorId: actor(req), actorType: 'admin_user', action, resourceType: 'QuotaProfile', resourceId,
  outcome: 'success', severity: 'medium', ...clientContext(req)
});
/** The limit fields a write actually carries: what the audit trail records as the change. */
const pickLimits = (data: Record<string, any>): Record<string, any> =>
  Object.fromEntries(LIMIT_FIELDS.filter((f) => f in (data || {})).map((f) => [f, data[f]]));
/** Managed columns ride along on every write; they are not a change anybody made. */
const MANAGED_FIELDS: ReadonlySet<string> = new Set(['ID', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy']);
/** The non-limit fields a write touched (name, description): what a rename records in the trail. */
const otherFields = (data: Record<string, any>): string[] =>
  Object.keys(data || {}).filter((f) => !MANAGED_FIELDS.has(f) && !(LIMIT_FIELDS as readonly string[]).includes(f));

/**
 * Write (or clear) one user's profile assignment: the association, the quota document the gateway
 * reads, the credential caches that still carry the old limits, and the audit trail - in that
 * order, so a failure never leaves a document promising more than the row says.
 */
async function setProfile(req: any, email: string, profileId: string | null): Promise<any> {
  if (!(await getUser(cds, email))) { req.reject(404, `${email} is not a user`); return; }
  if (profileId && !(await profiles.getProfile(cds, profileId))) { req.reject(404, 'quota profile not found'); return; }
  await cds.run(cds.ql.UPDATE(USERS).set({ quotaProfile_ID: profileId, modifiedAt: new Date().toISOString(), modifiedBy: actor(req) }).where({ email }));
  await quota.publish(cds, email);
  await invalidateForEmails(cds, [email], 'constraints');
  await recordAuditEvent({
    ...audit(req, profileId ? 'quota_profile.assign' : 'quota_profile.unassign', email),
    resourceType: 'User', details: JSON.stringify({ profileId })
  });
  return userRowWithVirtuals(email);
}

/** SQLite: "UNIQUE constraint failed: <table>.name"; Postgres: SQLSTATE 23505 "duplicate key value violates unique constraint". */
function isUniqueNameViolation(err: any): boolean {
  const message = String(err?.message ?? err ?? '');
  return err?.code === '23505' || /UNIQUE constraint failed|duplicate key value/i.test(message);
}

export function registerQuotaProfileHandlers(service: any): void {
  service.before(['CREATE', 'UPDATE'], 'QuotaProfiles', async (req: any) => {
    if (typeof req.data.name === 'string') req.data.name = req.data.name.trim();
    if (req.event === 'CREATE' && !req.data.name) { req.reject(400, 'name is required'); return; }
    const id = req.data.ID ?? (req.event === 'UPDATE' ? keyId(req) : undefined);
    // The name is what an administrator picks the profile by, so it is unique. Checked here rather
    // than left to the table's UNIQUE constraint, which surfaces as a 500: @assert.unique's generic
    // handler does not run for the redirected CREATE below.
    if (typeof req.data.name === 'string') {
      const clash = await cds.run(cds.ql.SELECT.one.from(profiles.PROFILES).columns('ID').where({ name: req.data.name }));
      if (clash && clash.ID !== id) { req.reject(400, `a quota profile named '${req.data.name}' already exists`); return; }
    }
    // A PATCH sends only the fields it changes, so the window order is judged on the stored row
    // overlaid by the patch - exactly as a user's own constraints are (admin-service-users.ts).
    const current = req.event === 'UPDATE' ? await profiles.getProfile(cds, id) : null;
    const errors = validateConstraints(req.data, current);
    if (errors.length) req.reject(400, errors.join('; '));
  });

  /**
   * CREATE is redirected to the base table: AdminService.QuotaProfiles is deployed as a SQL view,
   * and an INSERT into a view is rejected by the database (cqn4sql resolves UPDATE and DELETE to
   * the base table, CREATE is not) - the same redirect admin-service-library.ts does for
   * ModelCatalogs and admin-service.ts for ApiKeys.
   */
  service.on('CREATE', 'QuotaProfiles', async (req: any) => {
    const { INSERT, SELECT } = cds.ql;
    const now = new Date().toISOString();
    const data = { ...req.data, ID: req.data.ID ?? cds.utils.uuid(), createdAt: now, createdBy: actor(req), modifiedAt: now, modifiedBy: actor(req) };
    try {
      await cds.run(INSERT.into(profiles.PROFILES).entries(data));
    } catch (err: any) {
      // The name check above is a check-then-act: a second create with the same name that lands
      // in between loses to the table's UNIQUE constraint. That loser gets the same 400 as one
      // caught by the check, not the constraint's 500 (SQLite and Postgres word it differently).
      if (isUniqueNameViolation(err)) { req.reject(400, `a quota profile named '${data.name}' already exists`); return; }
      throw err;
    }
    // The redirect below bypasses the generic CREATE, and with it any after('CREATE') audit: the
    // trail spec §3 asks for (create, update, delete, assign, unassign) is written here.
    await recordAuditEvent({ ...audit(req, 'quota_profile.create', data.ID), details: JSON.stringify(pickLimits(req.data)) });
    return cds.run(SELECT.one.from(profiles.PROFILES).where({ ID: data.ID }));
  });

  service.after('READ', 'QuotaProfiles', async (rows: any) => {
    const list = (Array.isArray(rows) ? rows : rows ? [rows] : []).filter((r: any) => r?.ID);
    if (list.length === 0) return;
    // One grouped SELECT for the whole page, not one count per row: the admin has a single SQLite
    // connection and this is a list screen.
    const counts: any[] = await cds.run(cds.ql.SELECT.from(USERS).columns('quotaProfile_ID', 'count(*) as assigned')
      .where({ quotaProfile_ID: { in: list.map((r: any) => r.ID) } }).groupBy('quotaProfile_ID'));
    const byId = new Map<string, number>(counts.map((c: any) => [c.quotaProfile_ID, Number(c.assigned) || 0]));
    for (const row of list) row.assignedUsers = byId.get(row.ID) ?? 0;
  });

  service.after('UPDATE', 'QuotaProfiles', async (row: any, req: any) => {
    const id = row?.ID ?? req.data.ID ?? keyId(req);
    const limits = pickLimits(req.data);
    // The seven limits are the only part of a profile a quota document or a cached validation
    // carries: a name- or description-only PATCH is audited (with the fields it touched) but costs
    // no republish and no invalidation - on the single SQLite connection that is a fan-out over
    // every assignee for nothing.
    const changedLimits = Object.keys(limits).length > 0;
    await recordAuditEvent({ ...audit(req, 'quota_profile.update', id), details: JSON.stringify(changedLimits ? limits : { fields: otherFields(req.data) }) });
    if (!changedLimits) return;
    // Everyone assigned is now under different limits: their documents and their cached validations
    // both still carry the old ones.
    const emails = await profiles.assignedEmails(cds, id);
    if (emails.length) { await quota.publishMany(cds, emails); await invalidateForEmails(cds, emails, 'constraints'); }
  });

  service.before('DELETE', 'QuotaProfiles', async (req: any) => {
    const emails = await profiles.assignedEmails(cds, keyId(req));
    // Naming the users rather than cascading: dropping the profile would silently move every one of
    // them onto the platform defaults, which is the administrator's decision to make, not ours.
    if (emails.length) req.reject({ status: 409, code: 'quota_profile_assigned', message: `Profile is assigned to ${emails.length} user(s): ${emails.slice(0, 10).join(', ')}` });
  });
  service.after('DELETE', 'QuotaProfiles', async (_: any, req: any) => recordAuditEvent(audit(req, 'quota_profile.delete', keyId(req))));

  service.on('assignQuotaProfile', async (req: any) => setProfile(req, req.data.email, req.data.profileId));
  service.on('unassignQuotaProfile', async (req: any) => setProfile(req, req.data.email, null));

  service.on('quotaProfileUsers', async () => {
    const db = await cds.connect.to('db');
    const { SELECT } = cds.ql;
    // Self-healing, like libraryUsers: credentials inserted without a touch still get their row here.
    await backfillUsers(db);
    const rows: any[] = await db.run(SELECT.from(USERS).columns('email', 'displayName', 'status', 'quotaProfile_ID').orderBy('email'));
    const all: any[] = await db.run(SELECT.from(profiles.PROFILES).columns('ID', 'name'));
    const nameOf = new Map<string, string>(all.map((p: any) => [p.ID, p.name]));
    return rows.map((u: any) => ({
      email: u.email, displayName: u.displayName ?? null, status: u.status,
      profileId: u.quotaProfile_ID ?? null,
      profileName: u.quotaProfile_ID ? nameOf.get(u.quotaProfile_ID) ?? null : null
    }));
  });
}
