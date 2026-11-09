/**
 * Tool policy entities (tool governance spec 2026-09-16 §4/§5) are admin-only: ToolPolicies,
 * ToolPolicyAllows, ToolPolicyDenies and ToolUsageDaily must all refuse a plain user's READ (and,
 * for ToolPolicies, its CRUD) with 403. Regression for the review finding that these projections
 * initially carried no entity-level @restrict, unlike their QuotaProfiles sibling.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'tpa-admin@test.com': { id: 'tpa-admin@test.com', roles: ['admin', 'user'] },
  'tpa-user@test.com': { id: 'tpa-user@test.com', roles: ['user'] } } };

const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'tpa-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'tpa-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';

describe('Tool policy entities are admin-only', () => {
  it('a user gets 403 on ToolPolicies and ToolUsageDaily; an admin gets 200', async () => {
    expect((await ok(GET(`${S}/ToolPolicies`, USER))).status).toBe(403);
    expect((await GET(`${S}/ToolPolicies`, ADMIN)).status).toBe(200);
    expect((await ok(GET(`${S}/ToolUsageDaily`, USER))).status).toBe(403);
    expect((await GET(`${S}/ToolUsageDaily`, ADMIN)).status).toBe(200);
  });

  it('a user gets 403 on ToolPolicyAllows and ToolPolicyDenies; an admin gets 200', async () => {
    expect((await ok(GET(`${S}/ToolPolicyAllows`, USER))).status).toBe(403);
    expect((await GET(`${S}/ToolPolicyAllows`, ADMIN)).status).toBe(200);
    expect((await ok(GET(`${S}/ToolPolicyDenies`, USER))).status).toBe(403);
    expect((await GET(`${S}/ToolPolicyDenies`, ADMIN)).status).toBe(200);
  });

  it('a user cannot CREATE a ToolPolicy; an admin can', async () => {
    expect((await ok(POST(`${S}/ToolPolicies`, { name: 'User-attempted' }, USER))).status).toBe(403);
    expect((await POST(`${S}/ToolPolicies`, { name: 'Admin-created' }, ADMIN)).status).toBe(201);
  });
});
