/**
 * getUsageStatistics.connectionUsage: a Connection (external provider) model's usage rows
 * (origin 'external') grouped by connection, provider and list-price currency, apart from the SAP
 * tables. An unpriced row lands under currency null and counts in unpricedRequests. A non-admin sees
 * their own rows only, as in the other tables. Boots the real AdminService via cds.test() on
 * in-memory SQLite with mocked users; runs bare.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'cn-admin@test.com': { id: 'cn-admin@test.com', roles: ['admin', 'user'] },
    'cn-user@test.com': { id: 'cn-user@test.com', roles: ['user'] }
  }
};

const { GET } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'cn-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'cn-user@test.com', password: 'x' } };
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const VALID_FROM = '2026-09-15T10:00:00.000Z';
const STATS = "/odata/v4/admin/getUsageStatistics(startDate=2026-09-01,endDate=2026-09-30,granularity='day')";

const sapRow = (apiKey: string, email: string, n: number) => ({
  apiKey_ID: apiKey, keyName: apiKey, email, validFrom: VALID_FROM, validTo: '9999-12-31T23:59:59.999Z',
  provider: 'sap', model: 'cn-chat', endpoint: '/v1/chat/completions', statusCode: 200, inputTokens: 10,
  outputTokens: 0, totalTokens: 10, responseTime: 100, usageSignature: `cn-sap-${n}`
});

const extRow = (apiKey: string, email: string, n: number, extra: Record<string, unknown>) => ({
  apiKey_ID: apiKey, keyName: apiKey, email, validFrom: VALID_FROM, validTo: '9999-12-31T23:59:59.999Z',
  provider: 'openai', origin: 'external', connection: 'oa', model: 'oa-gpt', endpoint: '/v1/chat/completions',
  statusCode: 200, inputTokens: 100, outputTokens: 20, totalTokens: 120, responseTime: 100,
  usageSignature: `cn-ext-${n}`, ...extra
});

const seed = async () => {
  const { INSERT } = cds.ql;
  await cds.db.run(INSERT.into(KEYS).entries([
    { ID: 'k-own', key: 'sk-own', name: 'own', email: 'cn-user@test.com', isActive: true },
    { ID: 'k-oth', key: 'sk-oth', name: 'other', email: 'cn-other@test.com', isActive: true }
  ]));
  await cds.db.run(INSERT.into(KEY_USAGE).entries([
    sapRow('k-own', 'cn-user@test.com', 1)
  ]));
};

const seedExternal = async () => {
  const { INSERT } = cds.ql;
  await cds.db.run(INSERT.into(KEY_USAGE).entries([
    extRow('k-own', 'cn-user@test.com', 2, { listCost: 0.5, listCostCurrency: 'USD', pricingMissing: false }),
    extRow('k-oth', 'cn-other@test.com', 3, { listCost: 0.25, listCostCurrency: 'USD', pricingMissing: false }),
    extRow('k-oth', 'cn-other@test.com', 4, { pricingMissing: true })
  ]));
};

let user: any;
let admin: any;
let before: any;

describe('getUsageStatistics connectionUsage', () => {
  beforeAll(async () => {
    await seed();
    const a0 = await GET(STATS, ADMIN);
    expect(a0.status).toBe(200);
    before = a0.data;
    await seedExternal();
    const u = await GET(STATS, USER);
    const a = await GET(STATS, ADMIN);
    expect(u.status).toBe(200);
    expect(a.status).toBe(200);
    user = u.data;
    admin = a.data;
  });

  it('connectionUsage groups external rows by connection and currency', () => {
    const usd = admin.connectionUsage.find((r: any) => r.currency === 'USD');
    expect(usd).toMatchObject({ connection: 'oa', provider: 'openai', currency: 'USD', totalRequests: 2, totalTokens: 240, unpricedRequests: 0 });
    expect(Number(usd.totalListCost)).toBeCloseTo(0.75, 6);
    const unpriced = admin.connectionUsage.find((r: any) => r.currency === null);
    expect(unpriced).toMatchObject({ connection: 'oa', totalRequests: 1, unpricedRequests: 1 });
    expect(Number(unpriced.totalListCost)).toBe(0);
    expect(admin.connectionUsage).toHaveLength(2);
  });

  it('a non-admin sees only their own Connection usage', () => {
    expect(user.connectionUsage).toHaveLength(1);
    expect(user.connectionUsage[0]).toMatchObject({ connection: 'oa', currency: 'USD', totalRequests: 1 });
    expect(Number(user.connectionUsage[0].totalListCost)).toBeCloseTo(0.5, 6);
  });

  it('without external rows connectionUsage is empty and the other arrays are unchanged', async () => {
    expect(before.connectionUsage).toEqual([]);
    expect(before.apiKeyUsage.find((r: any) => r.keyId === 'k-own').totalRequests).toBe(1);
    expect(before.providerUsage).toEqual([expect.objectContaining({ provider: 'sap', totalRequests: 1, totalTokens: 10 })]);
    // the external rows count in the existing tables as before
    expect(admin.providerUsage.find((r: any) => r.provider === 'openai').totalRequests).toBe(3);
    // removing them gives the result from before they were seeded
    await cds.db.run(cds.ql.DELETE.from(KEY_USAGE).where({ origin: 'external' }));
    const after = (await GET(STATS, ADMIN)).data;
    expect(after.connectionUsage).toEqual([]);
    for (const k of ['apiKeyUsage', 'providerUsage', 'teamUsage', 'emailUsage', 'endpointUsage', 'modelUsage']) {
      expect(after[k]).toEqual(before[k]);
    }
  });
});
