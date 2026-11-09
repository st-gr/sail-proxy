/**
 * The gateway learns a caller's entitlement from the validation responses. Pin that the two
 * unified paths (validateApiKeyByToken / validateAwsCredentialByToken), the SigV4 path the
 * gateway actually calls (validateAwsCredentialsByToken) and the legacy validateApiKey all
 * carry the block computed from the owner's assignment, and that the cached paths keep it.
 */
import path from 'path';

// Makes @sap/cds's service-implementation lookup consider the .ts sibling of admin-service.cds
// (see model-entitlement-service.test.ts).
process.env.CDS_TYPESCRIPT = 'true';

const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
const cdsTest = cds.test(path.resolve(__dirname, '../../..'));

import * as ent from '../../../src/services/modelEntitlementService';

// The unified per-auth-type validators are private methods on the ValidationService class; the
// module exports the singleton the CDS service binds its handlers to, so drive that instance.
const validationService = require('../../../src/srv/validation-service').instance;

const LIB = 'sap.llm.gateway.admin.LibraryModels';
const CAT = 'sap.llm.gateway.admin.ModelCatalogs';
const MEM = 'sap.llm.gateway.admin.ModelCatalogMembers';
const EXC = 'sap.llm.gateway.admin.ModelCatalogExclusions';
const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';

const API_KEY = 'sk-test-entitlement-key-000000000000000000000001';
const WIRE_KEY = 'sk-test-entitlement-key-000000000000000000000002';
const ACCESS_KEY_ID = 'AKIATESTENTITLEMEN01';

const model = (modelId: string) => ({ modelId, baseModel: modelId, displayName: modelId, provider: 'Test', accessType: 'foundation', absent: false, lastSeenAt: new Date() });

const svc: any = validationService;

/** The token validateAwsCredentialsByToken decodes is whatever createValidationToken produced. */
async function awsValidationToken(): Promise<string> {
  const { token } = await svc.createValidationToken({
    data: { accessKeyId: ACCESS_KEY_ID, signature: 'sig', clientIp: '127.0.0.1', method: 'POST', endpoint: '/v1/messages' }
  });
  return token;
}

function clearCaches(): void {
  svc.cache.apiKeys.clear();
  svc.cache.awsCredentials.clear();
}

let db: any;

beforeAll(async () => { db = await cds.connect.to('db'); });
afterAll(() => { svc.destroy(); });

beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [USERS, MEM, EXC, CAT, LIB, KEYS, AWS]) await db.run(DELETE.from(t));
  await ent.ensureDefaultCatalog(db);
  await db.run(INSERT.into(LIB).entries([model('m1'), model('m2')]));
  await db.run(INSERT.into(KEYS).entries([
    { ID: 'k1', key: API_KEY, name: 'k', email: 'u@test.com', isActive: true, neverExpires: true },
    { ID: 'k2', key: WIRE_KEY, name: 'wire', email: 'u@test.com', isActive: true, neverExpires: true }
  ]));
  await db.run(INSERT.into(AWS).entries([
    { ID: 'aws1', accessKeyId: ACCESS_KEY_ID, name: 'aws', email: 'u@test.com', userId: 'u@test.com', isActive: true, neverExpires: true, secretHash: 'x', salt: 'y', region: 'us-east-1' }
  ]));
  clearCaches();
});

describe('unified API-key validation carries the entitlement block', () => {
  it('unassigned owner -> mode all, with the default catalog exclusions when present', async () => {
    const r1 = await svc.validateApiKeyByToken({ identifier: API_KEY, requestId: 'r1' }, 0);
    expect(r1.valid).toBe(true);
    expect(r1.data.entitlement).toEqual(expect.objectContaining({ mode: 'all', catalogName: 'Default' }));
    expect(r1.data.entitlement.exclude).toBeUndefined();

    const def = await ent.getDefaultCatalog(db);
    await ent.excludeModels(db, def, ['m2'], 'x');
    clearCaches();

    const r2 = await svc.validateApiKeyByToken({ identifier: API_KEY, requestId: 'r2' }, 0);
    expect(r2.data.entitlement).toEqual(expect.objectContaining({ mode: 'all', exclude: ['m2'] }));
  });

  it('assigned owner -> mode list with the members; the cached response keeps it', async () => {
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([{ ID: 'c1', name: 'Team', isDefault: false }]));
    await ent.addMembers(db, { ID: 'c1', name: 'Team', isDefault: false, parent_ID: null }, ['m1'], 'a');
    await ent.assignCatalog(db, 'u@test.com', 'c1');
    clearCaches();

    const r = await svc.validateApiKeyByToken({ identifier: API_KEY, requestId: 'r' }, 0);
    expect(r.auditInfo.cacheHit).toBe(false);
    expect(r.data.entitlement).toEqual({ catalogId: 'c1', catalogName: 'Team', mode: 'list', include: ['m1'] });

    const cached = await svc.validateApiKeyByToken({ identifier: API_KEY, requestId: 'r' }, 0);
    expect(cached.auditInfo.cacheHit).toBe(true);
    expect(cached.data.entitlement).toEqual(r.data.entitlement);
  });
});

describe('AWS credential validation carries the entitlement block', () => {
  it('validateAwsCredentialByToken puts it on data, and the cached response keeps it', async () => {
    const r = await svc.validateAwsCredentialByToken({ identifier: ACCESS_KEY_ID, requestId: 'r' }, 0);
    expect(r.valid).toBe(true);
    expect(r.data.entitlement).toEqual(expect.objectContaining({ mode: 'all', catalogName: 'Default' }));

    const cached = await svc.validateAwsCredentialByToken({ identifier: ACCESS_KEY_ID, requestId: 'r' }, 0);
    expect(cached.auditInfo.cacheHit).toBe(true);
    expect(cached.data.entitlement).toEqual(r.data.entitlement);
  });

  it('validateAwsCredentialsByToken puts the block into credentialMetadata', async () => {
    const def = await ent.getDefaultCatalog(db);
    await ent.excludeModels(db, def, ['m2'], 'x');

    const r = await svc.validateAwsCredentialsByToken({ data: { token: await awsValidationToken() } });
    expect(r.valid).toBe(true);
    expect(r.credentialMetadata.entitlement).toEqual(expect.objectContaining({ mode: 'all', exclude: ['m2'] }));
  });
});

describe('the block survives the OData wire', () => {
  // validation-service.cds declares a structured return type that does not list `entitlement`.
  // CAP 8 does not project action results onto it, but that is exactly the assumption the
  // gateway depends on, so pin it over HTTP rather than trusting the in-process object.
  it('validateUnifiedAuthByToken returns data.entitlement over HTTP', async () => {
    const tok = await cdsTest.POST('/odata/v4/validation/createUnifiedValidationToken', {
      authType: 'api_key', identifier: WIRE_KEY, clientIp: '127.0.0.1', userAgent: 'jest', method: 'POST', endpoint: '/v1/messages'
    });
    const res = await cdsTest.POST('/odata/v4/validation/validateUnifiedAuthByToken', { token: tok.data.token });
    expect(res.data.valid).toBe(true);
    expect(res.data.data.entitlement).toEqual(expect.objectContaining({ mode: 'all', catalogName: 'Default' }));
  });
});

describe('a missing default catalog does not open the wire', () => {
  // The startup seed is awaited now, but a default deleted at runtime (a bad migration, a manual
  // DELETE) used to make entitlementBlockFor throw, the caller swallow it, and the validation
  // come back with NO block - unrestricted, cached for an hour on both sides. Fail closed.
  it('validation still carries a block and the default is back afterwards', async () => {
    const { DELETE, SELECT } = cds.ql;
    await db.run(DELETE.from(CAT).where({ isDefault: true }));
    expect((await db.run(SELECT.from(CAT).where({ isDefault: true }))).length).toBe(0);
    clearCaches();

    const r = await svc.validateApiKeyByToken({ identifier: API_KEY, requestId: 'r-nodefault' }, 0);
    expect(r.valid).toBe(true);
    expect(r.data.entitlement).toEqual(expect.objectContaining({ mode: 'all', catalogName: 'Default' }));
    expect((await db.run(SELECT.from(CAT).where({ isDefault: true }))).length).toBe(1);
  });
});

describe('legacy validateApiKey carries the entitlement block', () => {
  it('puts it into metadata next to the owner e-mail', async () => {
    const r = await svc.validateApiKey({ data: { key: API_KEY, clientIp: '127.0.0.1' } });
    expect(r.valid).toBe(true);
    expect(r.metadata.email).toBe('u@test.com');
    expect(r.metadata.entitlement).toEqual(expect.objectContaining({ mode: 'all', catalogName: 'Default' }));
  });
});
