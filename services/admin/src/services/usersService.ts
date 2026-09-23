/**
 * Users: the identity both per-user controls share (quotas and model entitlement, spec §3 / §7.2).
 * touch() creates or refreshes a row and never changes status or constraints; the backfill and the
 * one-shot assignment migration run at startup (admin-service.ts initializeUsers).
 */
import { effectiveLimits, platformQuotaDefaults, Limits } from './quotaLimits';
import { getProfile } from './quotaProfilesService';

const cds = require('@sap/cds');

export const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const PREFS = 'sap.llm.gateway.admin.UserPreferences';
const ASG = 'sap.llm.gateway.admin.ModelCatalogAssignments';
const SERVICE_KEY_SUFFIX = '.service.key';

/** `cds` inside a request handler (runs in the request transaction) or a connected db service. */
export type DbLike = { run(q: any): Promise<any> };

export interface UserRow {
  email: string; displayName: string | null; rolesSnapshot: string | null;
  firstSeenAt: string | null; lastSeenAt: string | null;
  status: 'active' | 'deactivated'; statusChangedAt: string | null; statusChangedBy: string | null; statusReason: string | null;
  requestsPerMinute: number | null; spendPerDay: number | string | null; spendPerWeek: number | string | null; spendPerMonth: number | string | null;
  tokensPerDay: number | null; tokensPerWeek: number | null; tokensPerMonth: number | null;
  quotaResetAt: string | null; entitlementCatalog_ID: string | null; quotaProfile_ID: string | null;
}

/** Platform service credentials (the admin's own gateway key) are not people. */
export function isServiceKeyEmail(email: string): boolean {
  return typeof email === 'string' && email.endsWith(SERVICE_KEY_SUFFIX);
}

export function parseRoles(rolesSnapshot: string | null | undefined): string[] {
  if (!rolesSnapshot) return [];
  try {
    const parsed = JSON.parse(rolesSnapshot);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export async function getUser(db: DbLike, email: string): Promise<UserRow | null> {
  const { SELECT } = cds.ql;
  const row = await db.run(SELECT.one.from(USERS).where({ email }));
  return row ? { ...row, entitlementCatalog_ID: row.entitlementCatalog_ID ?? null, quotaProfile_ID: row.quotaProfile_ID ?? null } : null;
}

/** Refresh an existing row's lastSeenAt (and displayName/rolesSnapshot if given) and return it. */
async function refreshUser(db: DbLike, email: string, now: Date, opts: { displayName?: string; roles?: string[] }): Promise<UserRow | null> {
  const { UPDATE } = cds.ql;
  const patch: any = { lastSeenAt: now };
  if (opts.displayName !== undefined) patch.displayName = opts.displayName;
  if (opts.roles) patch.rolesSnapshot = JSON.stringify(opts.roles);
  await db.run(UPDATE(USERS).set(patch).where({ email }));
  return getUser(db, email);
}

export async function touch(db: DbLike, email: string, opts: { displayName?: string; roles?: string[] } = {}): Promise<UserRow | null> {
  if (!email || isServiceKeyEmail(email)) return null;
  const now = new Date();
  const existing = await getUser(db, email);
  if (existing) return refreshUser(db, email, now, opts);
  // First contact. A page load sends several requests at once, and each finds no row. A plain INSERT
  // then fails on the duplicate key for all but one of them - and on PostgreSQL a failed statement
  // aborts the request's whole transaction, so nothing after it can run, a re-read included. (SQLite
  // has no such rule, which is how the earlier catch-and-re-read passed every local test while every
  // Docker and Kyma user's first page load reported an error and showed the wrong role.) UPSERT is
  // INSERT ... ON CONFLICT DO UPDATE on SQLite and PostgreSQL alike: the requests that lose the race
  // update the row the winner created instead of failing. It writes only the first-contact columns,
  // so status and limits keep their defaults or what the winner already stored, and firstSeenAt is
  // set only where it is still empty so the winner's first contact stands.
  const { UPSERT, UPDATE } = cds.ql;
  const entry: any = { email, lastSeenAt: now };
  if (opts.displayName !== undefined) entry.displayName = opts.displayName;
  if (opts.roles) entry.rolesSnapshot = JSON.stringify(opts.roles);
  await db.run(UPSERT.into(USERS).entries(entry));
  await db.run(UPDATE(USERS).set({ firstSeenAt: now }).where({ email, firstSeenAt: null }));
  return getUser(db, email);
}

/** A Users row for every distinct e-mail of ApiKeys, AwsCredentials and UserPreferences that has none. */
export async function backfillUsers(db: DbLike): Promise<number> {
  const { SELECT, INSERT } = cds.ql;
  const emails = new Set<string>();
  for (const table of [KEYS, AWS, PREFS]) {
    const rows: any[] = await db.run(SELECT.from(table).columns('email'));
    rows.forEach((r) => { if (r.email && !isServiceKeyEmail(r.email)) emails.add(r.email); });
  }
  const existing = new Set<string>((await db.run(SELECT.from(USERS).columns('email'))).map((u: any) => u.email));
  const now = new Date();
  let created = 0;
  for (const email of emails) {
    if (existing.has(email)) continue;
    await db.run(INSERT.into(USERS).entries({ email, firstSeenAt: now, lastSeenAt: now, status: 'active' }));
    created += 1;
  }
  return created;
}

/**
 * One-shot: copy every ModelCatalogAssignments row into Users.entitlementCatalog (creating the
 * user), then delete it — a drained source is what makes a later unassignment stick across boots.
 */
export async function migrateCatalogAssignments(db: DbLike): Promise<number> {
  const { SELECT, UPDATE, DELETE } = cds.ql;
  const rows: any[] = await db.run(SELECT.from(ASG).columns('email', 'catalog_ID'));
  let migrated = 0;
  for (const row of rows) {
    if (row.email && row.catalog_ID && !isServiceKeyEmail(row.email)) {
      const user = await touch(db, row.email);
      if (user && !user.entitlementCatalog_ID) {
        await db.run(UPDATE(USERS).set({ entitlementCatalog_ID: row.catalog_ID }).where({ email: row.email }));
      }
      migrated += 1;
    }
    await db.run(DELETE.from(ASG).where({ email: row.email }));
  }
  return migrated;
}

/** The `user` block of a validation response (spec §2): status, roles and the effective limits. */
export interface UserBlock { email: string; status: 'active' | 'deactivated'; roles: string[]; limits: Limits; }

export async function wireBlock(db: DbLike, email: string): Promise<UserBlock> {
  const user = await getUser(db, email);
  const profile = user?.quotaProfile_ID ? await getProfile(db, user.quotaProfile_ID) : null;
  const { limits } = effectiveLimits(user, profile, await platformQuotaDefaults(db));
  return { email, status: user?.status ?? 'active', roles: parseRoles(user?.rolesSnapshot), limits };
}
