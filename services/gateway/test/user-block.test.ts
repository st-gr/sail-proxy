import { describe, it, expect } from '@jest/globals';
import { userFromRequest, isAdminUser, UserBlock } from '../src/utils/userBlock';
import { entitlementFromRequest } from '../src/utils/modelEntitlement';

// isAdminUser takes a typed UserBlock, so this helper is typed too; the other six limits fields
// are irrelevant to every assertion below and are filled with null (unlimited).
const block = (roles: string[]): UserBlock => ({
  email: 'u@test.com', status: 'active', roles,
  limits: { requestsPerMinute: 5, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null }
});

describe('userFromRequest', () => {
  it('reads the block from unified auth, legacy apiKeyInfo and awsAuth, and rejects junk', () => {
    expect(userFromRequest({ unifiedAuth: { data: { user: block([]) } } })?.email).toBe('u@test.com');
    expect(userFromRequest({ apiKeyInfo: { user: block([]) } })?.status).toBe('active');
    expect(userFromRequest({ awsAuth: { user: block([]) } })?.limits.requestsPerMinute).toBe(5);
    expect(userFromRequest({ unifiedAuth: { data: { user: { status: 'active' } } } })).toBeNull();   // no limits object
    expect(userFromRequest({})).toBeNull();
  });
});

describe('isAdminUser', () => {
  it('matches admin, Admin and an xsuaa .admin scope, nothing else', () => {
    expect(isAdminUser(block(['admin']))).toBe(true);
    expect(isAdminUser(block(['Admin']))).toBe(true);
    expect(isAdminUser(block(['app.admin']))).toBe(true);
    expect(isAdminUser(block(['admin-readonly', 'user']))).toBe(false);
    expect(isAdminUser(null)).toBe(false);
  });
});

describe('entitlementFromRequest lifts the assignment for administrators (spec §7.2 item 2)', () => {
  const listBlock = { catalogId: 'c', catalogName: 'T', mode: 'list', include: ['m1'] };
  it('an admin caller is unrestricted even with a list block on the wire', () => {
    expect(entitlementFromRequest({ unifiedAuth: { data: { entitlement: listBlock, user: block(['admin']) } } })).toBeNull();
  });
  it('a plain user keeps the block', () => {
    expect(entitlementFromRequest({ unifiedAuth: { data: { entitlement: listBlock, user: block(['user']) } } })).toMatchObject({ mode: 'list' });
  });
});
