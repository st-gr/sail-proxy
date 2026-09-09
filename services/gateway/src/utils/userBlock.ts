/**
 * The `user` block on the wire (spec §2): status, roles and effective limits, attached by the admin
 * to every validation response beside `entitlement`. Absent = no user-level quota (standalone mode,
 * the local validation fallback) — the same fail-open reading the entitlement block uses.
 */
import type { UserBlock } from '../clients/adminServiceClient';
export type { UserBlock };

function isBlock(x: any): x is UserBlock {
  return !!x && typeof x === 'object' && typeof x.status === 'string' && !!x.limits && typeof x.limits === 'object';
}

export function userFromRequest(req: any): UserBlock | null {
  const candidates = [req?.unifiedAuth?.data?.user, req?.apiKeyInfo?.user, req?.awsAuth?.user];
  for (const c of candidates) {
    if (isBlock(c)) {
      return { email: String(c.email ?? ''), status: c.status === 'deactivated' ? 'deactivated' : 'active',
        roles: Array.isArray(c.roles) ? c.roles.filter((r: any) => typeof r === 'string') : [], limits: c.limits };
    }
  }
  return null;
}

/** Same rule as the admin's isAdminRole: exact 'admin'/'Admin' or an xsuaa '.admin' scope suffix. */
export function isAdminUser(block: UserBlock | null): boolean {
  return !!block && block.roles.some((r) => r === 'admin' || r === 'Admin' || r.endsWith('.admin'));
}
