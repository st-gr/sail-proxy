/**
 * The `user` block on the wire (spec §2): status, roles and effective limits, attached by the admin
 * to every validation response beside `entitlement`. Absent = no user-level quota (standalone mode,
 * the local validation fallback) — the same fail-open reading the entitlement block uses.
 */
import type { UserBlock, TeamBlock } from '../clients/adminServiceClient';
export type { UserBlock, TeamBlock };

function isBlock(x: any): x is UserBlock {
  return !!x && typeof x === 'object' && typeof x.status === 'string' && !!x.limits && typeof x.limits === 'object';
}

export function userFromRequest(req: any): UserBlock | null {
  const candidates = [req?.unifiedAuth?.data?.user, req?.apiKeyInfo?.user, req?.awsAuth?.user];
  for (const c of candidates) {
    if (isBlock(c)) {
      return { email: String(c.email ?? ''), status: c.status === 'deactivated' ? 'deactivated' : 'active',
        roles: Array.isArray(c.roles) ? c.roles.filter((r: any) => typeof r === 'string') : [], limits: c.limits,
        teamIds: Array.isArray(c.teamIds) ? c.teamIds.filter((t: any) => typeof t === 'string') : undefined };
    }
  }
  return null;
}

/** Same rule as the admin's isAdminRole: exact 'admin'/'Admin' or an xsuaa '.admin' scope suffix. */
export function isAdminUser(block: UserBlock | null): boolean {
  return !!block && block.roles.some((r) => r === 'admin' || r === 'Admin' || r.endsWith('.admin'));
}

function isTeamBlock(x: any): x is TeamBlock {
  return !!x && typeof x === 'object' && typeof x.teamId === 'string' && typeof x.teamName === 'string' && !!x.limits && typeof x.limits === 'object';
}

export function teamFromRequest(req: any): TeamBlock | null {
  for (const c of [req?.unifiedAuth?.data?.team, req?.awsAuth?.team]) if (isTeamBlock(c)) return { teamId: c.teamId, teamName: c.teamName, limits: c.limits };
  return null;
}

// Shares are stored lowercased, so every caller kind compares in lowercase.
const stringIds = (ids: unknown[]): string[] => ids.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());

/**
 * The caller's team ids for store visibility (spec 2026-10-14 §8), read from this request only (a
 * member removed from a team loses its shares on the next validation): a cockpit call's acting
 * user's (the acting headers; none when the admin sent none — never the service key's own block),
 * else the validated user block's, else none.
 */
export function callerTeamIds(req: any): string[] {
  const actor = req?.groundingActor;
  if (actor) return Array.isArray(actor.teamIds) ? stringIds(actor.teamIds) : [];
  return stringIds(userFromRequest(req)?.teamIds ?? []);
}
