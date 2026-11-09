/**
 * The local provider's roles come from LOCAL_USER_MAPPING by email. Dex up to v2.37 sent no groups for
 * its local accounts; newer Dex sends the groups the Dex configuration lists for them
 * (sap-llm-gateway-admin / -user), which the local ROLE_MAPPING (keyed by email) does not name. A
 * mapped email must keep its role either way, or the local admin becomes a regular user on upgrade.
 *
 * @see ../../src/middleware/authMiddleware.ts
 */
import { AuthMiddleware } from '../../src/middleware/authMiddleware';

const LOCAL_MAPPING = '{"admin@example.com":"admin","user@example.com":"user"}';

async function rolesFor(email: string, groups: string | undefined, provider = 'local', roleMapping: Record<string, string> = JSON.parse(LOCAL_MAPPING)) {
  process.env.IDENTITY_PROVIDER = provider;
  const middleware = new AuthMiddleware({ deployTarget: 'docker', roleMapping });
  const req: any = { path: '/odata/v4/admin/whoami', url: '/odata/v4/admin/whoami', method: 'POST', headers: { 'x-auth-request-email': email, ...(groups !== undefined ? { 'x-auth-request-groups': groups } : {}) } };
  await middleware.authenticate(req, { status: () => ({ json: () => undefined }) } as any, jest.fn());
  return req.user.roles as string[];
}

describe('local provider roles', () => {
  const saved = { provider: process.env.IDENTITY_PROVIDER, mapping: process.env.LOCAL_USER_MAPPING };
  beforeEach(() => { process.env.LOCAL_USER_MAPPING = LOCAL_MAPPING; });
  afterAll(() => {
    if (saved.provider === undefined) delete process.env.IDENTITY_PROVIDER; else process.env.IDENTITY_PROVIDER = saved.provider;
    if (saved.mapping === undefined) delete process.env.LOCAL_USER_MAPPING; else process.env.LOCAL_USER_MAPPING = saved.mapping;
  });

  it('maps by email when Dex sends no groups (Dex v2.37)', async () => {
    expect(await rolesFor('admin@example.com', undefined)).toEqual(['admin']);
    expect(await rolesFor('user@example.com', '')).toEqual(['user']);
  });

  it('keeps the email mapping when Dex sends the local accounts\' groups (Dex v2.46)', async () => {
    expect(await rolesFor('admin@example.com', 'sap-llm-gateway-admin')).toEqual(['admin']);
    expect(await rolesFor('user@example.com', 'sap-llm-gateway-user')).toEqual(['user']);
  });

  it('maps an unlisted local user\'s groups as before', async () => {
    expect(await rolesFor('other@example.com', 'ops', 'local', { ops: 'admin' })).toEqual(['admin']);
    expect(await rolesFor('other@example.com', 'ops')).toEqual(['user']);
  });

  it('leaves other providers on group mapping, whatever LOCAL_USER_MAPPING says', async () => {
    expect(await rolesFor('admin@example.com', 'sap-llm-gateway-user', 'ldap', { 'sap-llm-gateway-user': 'user' })).toEqual(['user']);
    expect(await rolesFor('admin@example.com', 'sap-llm-gateway-admin', 'okta', { 'sap-llm-gateway-admin': 'admin' })).toEqual(['admin']);
  });
});
