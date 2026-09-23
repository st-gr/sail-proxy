/**
 * Regression test for a task-8 review finding: `onCreateApiKey` (src/srv/admin-service.ts) inserted
 * req.data verbatim, so a CREATE payload could set `toolPolicy_ID` directly - bypassing the declared
 * only-write-path (`setApiKeyToolPolicy`, admin-service.cds). Fixed by stripping toolPolicy_ID in
 * onCreateApiKey before the insert, the same treatment already given to it in beforeUpdateApiKeyDraft
 * and onUpdateApiKey. Exercised through the real draft NEW -> draftActivate flow (the ApiKeys
 * projection is draft-enabled), which is how a CREATE event actually reaches onCreateApiKey over
 * OData - same scaffolding as credential-lock-flag.test.ts / users-odata.test.ts.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'akc-admin@test.com': { id: 'akc-admin@test.com', roles: ['admin', 'user'] } } };

const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'akc-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const POLICIES = 'sap.llm.gateway.admin.ToolPolicies';
const keyPath = (id: string, active: boolean) => `${S}/ApiKeys(ID=${id},IsActiveEntity=${active})`;

describe('a CREATE payload cannot set ApiKeys.toolPolicy_ID', () => {
  it('creating an API key through the draft NEW -> draftActivate flow with toolPolicy_ID set stores null', async () => {
    const [defaultPolicy] = await cds.db.run(cds.ql.SELECT.from(POLICIES).where({ isDefault: true }));
    expect(defaultPolicy).toBeTruthy();

    const draft = await POST(`${S}/ApiKeys`, {
      name: 'akc-key', email: 'akc-owner@test.com', toolPolicy_ID: defaultPolicy.ID
    }, ADMIN);
    expect(draft.status).toBe(201);
    const id = draft.data.ID;

    const activated = await POST(`${keyPath(id, false)}/AdminService.draftActivate`, {}, ADMIN);
    expect(activated.status).toBe(201);
    expect(activated.data.toolPolicy_ID).toBeNull();

    const row = (await GET(keyPath(id, true), ADMIN)).data;
    expect(row.toolPolicy_ID).toBeNull();
  });
});
