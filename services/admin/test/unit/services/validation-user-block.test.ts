/**
 * The validation responses the gateway caches carry the credential's STORED rate limits and the
 * owner's `user` block (status, roles, effective limits) beside `entitlement` — on the unified
 * API-key path, the unified AWS path and the SigV4 path (spec §2, §7.2 item 2). Fail open: a
 * missing Users row means active, no roles, platform limits.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

const validationService = require('../../../src/srv/validation-service').instance;
import * as users from '../../../src/services/usersService';

const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const RL = 'sap.llm.gateway.admin.RateLimits';
const PROFILES = 'sap.llm.gateway.admin.QuotaProfiles';
const API_KEY = 'sk-test-user-block-key-0000000000000000000000001';
const ACCESS_KEY_ID = 'AKIATEST-USRBLOCK001'; // 20 chars (accessKeyId is String(20)); hyphenated so it can't be mistaken for a real AWS access key id

const svc: any = validationService;
let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [RL, USERS, KEYS, AWS, PROFILES]) await db.run(DELETE.from(t));
  svc.cache?.apiKeys?.clear?.(); svc.cache?.awsCredentials?.clear?.();
  await db.run(INSERT.into(KEYS).entries({ ID: 'k-ub', key: API_KEY, name: 'k', email: 'ub@test.com', isActive: true }));
  await db.run(INSERT.into(AWS).entries({ ID: 'c-ub', accessKeyId: ACCESS_KEY_ID, secretHash: 'h', salt: 's', name: 'c', email: 'ub@test.com', userId: 'ub@test.com', region: 'us-east-1', isActive: true }));
});

async function unifiedApiKey(): Promise<any> {
  const { token } = await svc.createUnifiedValidationToken({ data: { authType: 'api_key', identifier: API_KEY, clientIp: '127.0.0.1', method: 'POST', endpoint: '/v1/chat/completions' } });
  return svc.validateUnifiedAuthByToken({ data: { token } });
}

describe('validation carries stored rate limits and the user block', () => {
  it('unified API key path: RateLimits row by apiKey_ID, user block with roles and effective limits', async () => {
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(RL).entries({ ID: 'rl-1', apiKey_ID: 'k-ub', requestsPerMinute: 7, requestsPerHour: 70, requestsPerDay: 700 }));
    await users.touch(db, 'ub@test.com', { roles: ['admin', 'user'] });
    await db.run(cds.ql.UPDATE(USERS).set({ tokensPerDay: 1000 }).where({ email: 'ub@test.com' }));
    const r = await unifiedApiKey();
    expect(r.valid).toBe(true);
    expect(r.data.rateLimits).toEqual({ requestsPerMinute: 7, requestsPerHour: 70, requestsPerDay: 700 });
    expect(r.data.user).toMatchObject({ email: 'ub@test.com', status: 'active', roles: ['admin', 'user'] });
    expect(r.data.user.limits).toMatchObject({ tokensPerDay: 1000, requestsPerMinute: null });
    expect(r.data.entitlement).toBeDefined();
    const cached = await unifiedApiKey();       // the cache-hit answer carries the block too
    expect(cached.auditInfo.cacheHit).toBe(true);
    expect(cached.data.user.limits.tokensPerDay).toBe(1000);
  });

  it('a deactivated owner is reported as such; a missing Users row is active with no roles', async () => {
    await users.touch(db, 'ub@test.com');
    await db.run(cds.ql.UPDATE(USERS).set({ status: 'deactivated' }).where({ email: 'ub@test.com' }));
    expect((await unifiedApiKey()).data.user.status).toBe('deactivated');
    await db.run(cds.ql.DELETE.from(USERS));
    svc.cache.apiKeys.clear();
    expect((await unifiedApiKey()).data.user).toMatchObject({ status: 'active', roles: [] });
  });

  it("the owner's quota profile fills the limits the user leaves empty — requestsPerMinute reaches the gateway only here", async () => {
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(PROFILES).entries({ ID: 'p-ub', name: 'Standard', requestsPerMinute: 60, tokensPerDay: 5000000 }));
    await users.touch(db, 'ub@test.com', { roles: ['user'] });
    await db.run(cds.ql.UPDATE(USERS).set({ quotaProfile_ID: 'p-ub', tokensPerDay: 1000 }).where({ email: 'ub@test.com' }));
    expect((await unifiedApiKey()).data.user.limits).toMatchObject({ requestsPerMinute: 60, tokensPerDay: 1000 });
  });

  it('AWS credential without a RateLimits row: null per-key limits, user block present (SigV4 path)', async () => {
    const { token } = await svc.createValidationToken({ data: { accessKeyId: ACCESS_KEY_ID, signature: 'sig', clientIp: '127.0.0.1', method: 'POST', endpoint: '/v1/messages' } });
    const r = await svc.validateAwsCredentialsByToken({ data: { token, stringToSign: 'x', signature: 'sig' } });
    // signature validation itself is not the subject here; the metadata block is
    const meta = r.credentialMetadata ?? r.data;
    expect(meta.rateLimits).toEqual({ requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null });
    expect(meta.user).toMatchObject({ email: 'ub@test.com', status: 'active' });
  });

  it('AWS credential rate limits: a stored RateLimits row (by awsCredential_ID) is returned by the SigV4 path', async () => {
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(RL).entries({ ID: 'rl-aws-ub', awsCredential_ID: 'c-ub', requestsPerMinute: 3, requestsPerHour: 30, requestsPerDay: 300 }));
    const { token } = await svc.createValidationToken({ data: { accessKeyId: ACCESS_KEY_ID, signature: 'sig', clientIp: '127.0.0.1', method: 'POST', endpoint: '/v1/messages' } });
    const r = await svc.validateAwsCredentialsByToken({ data: { token, stringToSign: 'x', signature: 'sig' } });
    const meta = r.credentialMetadata ?? r.data;
    expect(meta.rateLimits).toEqual({ requestsPerMinute: 3, requestsPerHour: 30, requestsPerDay: 300 });
  });
});
