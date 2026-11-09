/**
 * getUsageStatistics and cockpit grounding usage. The grounding cockpit calls the gateway with the
 * admin service key, and each usage row carries the acting user's e-mail (usageEventProcessor
 * rowOwnerEmail). A non-admin's per-key, provider, endpoint and model tables therefore filter by
 * the row e-mail, as the e-mail table does, so their cockpit usage shows in every table. The
 * service key's per-key row is flagged isServiceKey, which the Usage app turns into a label.
 * Boots the real AdminService via cds.test() on in-memory SQLite with mocked users; runs bare -
 * never touches db/admin.db or :4004.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'ob-admin@test.com': { id: 'ob-admin@test.com', roles: ['admin', 'user'] },
    'ob-user@test.com': { id: 'ob-user@test.com', roles: ['user'] }
  }
};

const { GET } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'ob-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'ob-user@test.com', password: 'x' } };
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const SERVICE_KEY_EMAIL = 'admin2gateway.service.key';
const VALID_FROM = '2026-09-15T10:00:00.000Z';
const STATS = "/odata/v4/admin/getUsageStatistics(startDate=2026-09-01,endDate=2026-09-30,granularity='day')";

const row = (apiKey: string, keyName: string, email: string, model: string, endpoint: string, n: number, unit = 'tokens') => ({
  apiKey_ID: apiKey, keyName, email, validFrom: VALID_FROM, validTo: '9999-12-31T23:59:59.999Z',
  provider: 'sap', model, endpoint, statusCode: 200, inputTokens: 10, outputTokens: 0, totalTokens: 10,
  responseTime: 100, unit, usageSignature: `ob-${apiKey}-${email}-${n}`
});

const seed = async () => {
  const { INSERT } = cds.ql;
  await cds.db.run(INSERT.into(KEYS).entries([
    { ID: 'k-svc', key: 'sk-svc', name: 'Admin Service to Gateway', email: SERVICE_KEY_EMAIL, isActive: true },
    { ID: 'k-own', key: 'sk-own', name: 'own', email: 'ob-user@test.com', isActive: true },
    { ID: 'k-oth', key: 'sk-oth', name: 'other', email: 'ob-other@test.com', isActive: true }
  ]));
  await cds.db.run(INSERT.into(KEY_USAGE).entries([
    // cockpit grounding usage on behalf of two users, through the service key
    row('k-svc', 'Admin Service to Gateway', 'ob-user@test.com', 'ob-rerank', '/v1/rerank', 1, 'units'),
    row('k-svc', 'Admin Service to Gateway', 'ob-user@test.com', 'ob-embed', '/v1/embeddings', 2),
    row('k-svc', 'Admin Service to Gateway', 'ob-other@test.com', 'ob-embed', '/v1/embeddings', 3),
    // own-key usage of each user
    row('k-own', 'own', 'ob-user@test.com', 'ob-chat', '/v1/chat/completions', 4),
    row('k-oth', 'other', 'ob-other@test.com', 'ob-chat', '/v1/chat/completions', 5)
  ]));
  // AWS credentials stay filtered by the credential owner
  await cds.db.run(INSERT.into(AWS).entries([
    { ID: 'c-own', accessKeyId: 'AKIAOBOWN', secretHash: 'h', salt: 's', name: 'own-aws', email: 'ob-user@test.com', userId: 'ob-user@test.com', isActive: true },
    { ID: 'c-oth', accessKeyId: 'AKIAOBOTH', secretHash: 'h', salt: 's', name: 'other-aws', email: 'ob-other@test.com', userId: 'ob-other@test.com', isActive: true }
  ]));
  await cds.db.run(INSERT.into(AWS_USAGE).entries(['c-own', 'c-oth'].map((credential_ID) => ({
    credential_ID, userId: credential_ID === 'c-own' ? 'ob-user@test.com' : 'ob-other@test.com', validFrom: VALID_FROM,
    validTo: '9999-12-31T23:59:59.999Z', provider: 'aws-bedrock', modelId: 'ob-bedrock', statusCode: 200,
    inputTokens: 10, outputTokens: 5, responseTime: 100, usageSignature: `ob-aws-${credential_ID}`
  }))));
};

const requests = (list: any[], field: string, value: string) => list.find((r: any) => r[field] === value)?.totalRequests;

let user: any;
let admin: any;

describe('getUsageStatistics with cockpit grounding usage', () => {
  beforeAll(async () => {
    await seed();
    const u = await GET(STATS, USER);
    const a = await GET(STATS, ADMIN);
    expect(u.status).toBe(200);
    expect(a.status).toBe(200);
    user = u.data;
    admin = a.data;
  });

  describe('a non-admin sees the usage on their behalf in every table', () => {
    it('per key: the service key with their rows only, beside their own key', () => {
      expect(requests(user.apiKeyUsage, 'keyId', 'k-svc')).toBe(2);
      expect(requests(user.apiKeyUsage, 'keyId', 'k-own')).toBe(1);
      expect(user.apiKeyUsage.map((r: any) => r.keyId).sort()).toEqual(['k-own', 'k-svc']);
    });

    it('per provider', () => {
      expect(requests(user.providerUsage, 'provider', 'sap')).toBe(3);
    });

    it('per endpoint', () => {
      expect(requests(user.endpointUsage, 'endpoint', '/v1/rerank')).toBe(1);
      expect(requests(user.endpointUsage, 'endpoint', '/v1/embeddings')).toBe(1);
      expect(requests(user.endpointUsage, 'endpoint', '/v1/chat/completions')).toBe(1);
    });

    it('per model', () => {
      expect(requests(user.modelUsage, 'modelId', 'ob-rerank')).toBe(1);
      expect(requests(user.modelUsage, 'modelId', 'ob-embed')).toBe(1);
      expect(requests(user.modelUsage, 'modelId', 'ob-chat')).toBe(1);
    });

    it('agrees with the e-mail table', () => {
      expect(user.emailUsage.map((r: any) => r.email)).toEqual(['ob-user@test.com']);
      // the three API-key rows of the per-key table plus the AWS credential's row
      const perKey = user.apiKeyUsage.reduce((n: number, r: any) => n + r.totalRequests, 0);
      expect(perKey).toBe(3);
      expect(requests(user.emailUsage, 'email', 'ob-user@test.com')).toBe(perKey + 1);
    });
  });

  describe("a non-admin's AWS credential tables (these answered 500 for a non-admin before)", () => {
    it('per credential: their own credential only', () => {
      expect(user.awsCredentialUsage.map((r: any) => r.credentialId)).toEqual(['c-own']);
    });

    it('per provider: their own credential only', () => {
      expect(requests(user.providerUsage, 'provider', 'aws-bedrock')).toBe(1);
      expect(requests(admin.providerUsage, 'provider', 'aws-bedrock')).toBe(2);
    });

    it('per model: their own credential only', () => {
      expect(requests(user.modelUsage, 'modelId', 'ob-bedrock')).toBe(1);
      expect(requests(admin.modelUsage, 'modelId', 'ob-bedrock')).toBe(2);
    });
  });

  describe('the per-key rows say which key is the service key', () => {
    it('for a non-admin', () => {
      expect(user.apiKeyUsage.find((r: any) => r.keyId === 'k-svc').isServiceKey).toBe(true);
      expect(user.apiKeyUsage.find((r: any) => r.keyId === 'k-own').isServiceKey).toBe(false);
    });

    it('for an admin, whose service-key row aggregates every user', () => {
      expect(requests(admin.apiKeyUsage, 'keyId', 'k-svc')).toBe(3);
      expect(admin.apiKeyUsage.find((r: any) => r.keyId === 'k-svc').isServiceKey).toBe(true);
      expect(admin.apiKeyUsage.filter((r: any) => r.isServiceKey).length).toBe(1);
    });

    it("does not hand out the key owner's e-mail", () => {
      for (const r of [...user.apiKeyUsage, ...admin.apiKeyUsage]) expect(r).not.toHaveProperty('keyOwnerEmail');
    });
  });
});
