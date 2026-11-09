/**
 * Task 9 (tool governance spec 2026-09-16 §5): validation responses carry the caller's tool
 * policy block (`toolPolicy`) beside `entitlement` and `user`, and an API key that names its own
 * narrowing policy also carries `keyToolPolicy`. Assignments are made directly through `cds.db`
 * (Task 11 wires the assignToolPolicy/setApiKeyToolPolicy OData handlers) so this test pins the
 * validation payload, not the write path.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'tpv-user@test.com': { id: 'tpv-user@test.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));

const { GET } = cds.test(path.resolve(__dirname, '../../..'));
const validationService = require('../../../src/srv/validation-service').instance;
import * as users from '../../../src/services/usersService';
import * as toolPolicy from '../../../src/services/toolPolicyService';

const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const POLICIES = 'sap.llm.gateway.admin.ToolPolicies';
const ALLOWS = 'sap.llm.gateway.admin.ToolPolicyAllows';
const DENIES = 'sap.llm.gateway.admin.ToolPolicyDenies';

const USER_EMAIL = 'tpv-user@test.com';
const KEY_VALUE = 'sk-test-tool-policy-validation-key-01';
const KEY_ID = 'tpv-key-1';

const svc: any = validationService;
let db: any;

beforeAll(async () => { db = await cds.connect.to('db'); });

beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [ALLOWS, DENIES, POLICIES, KEYS, USERS]) await db.run(DELETE.from(t));
  svc.cache?.apiKeys?.clear?.();
  await users.touch(db, USER_EMAIL, { roles: ['user'] });
  await db.run(INSERT.into(KEYS).entries({ ID: KEY_ID, key: KEY_VALUE, name: 'tpv-key', email: USER_EMAIL, isActive: true }));
});

function apiKeyUrl(): string {
  return `/odata/v4/validation/validateApiKey(key='${KEY_VALUE}',clientIp='127.0.0.1',userAgent='jest')`;
}

describe('validation responses carry tool policy blocks', () => {
  it('an unassigned key returns the default policy and no key block', async () => {
    const { data } = await GET(apiKeyUrl());
    const payload = data.metadata ?? data;
    expect(payload.toolPolicy).toEqual({ policyId: expect.any(String), policyName: 'Default', mode: 'monitor', allow: [], deny: [], sensitive: [], untrusted: [] });
    expect(payload.keyToolPolicy).toBeUndefined();
  });

  it('assigned user and key policies ride the response', async () => {
    const { INSERT } = cds.ql;
    const policyId = cds.utils.uuid();
    await db.run(INSERT.into(POLICIES).entries({ ID: policyId, name: 'Team', mode: 'strip', isDefault: false }));
    await db.run(INSERT.into(ALLOWS).entries({ ID: cds.utils.uuid(), policy_ID: policyId, pattern: 'function:*' }));
    await toolPolicy.assignUser(db, USER_EMAIL, policyId);
    await toolPolicy.assignApiKey(db, KEY_ID, policyId);

    const { data } = await GET(apiKeyUrl());
    const payload = data.metadata ?? data;
    expect(payload.toolPolicy).toMatchObject({ policyName: 'Team', mode: 'strip', allow: ['function:*'] });
    expect(payload.keyToolPolicy).toMatchObject({ policyName: 'Team' });
  });
});
