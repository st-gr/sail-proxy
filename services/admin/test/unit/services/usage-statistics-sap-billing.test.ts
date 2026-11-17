/**
 * getUsageStatistics.sapBilling: the SAP Capacity-Unit figures (GenAI tokens, capacity units, SAP cost)
 * for the requested period, per credential (API keys AND AWS credentials) and per team.
 *
 * The Usage app's "SAP Cost" tile and SAP billing tables read the all-time views
 * ApiKeyUsageStats / ApiKeyUsageSapCostStats, so they ignored the chosen Time Period and left out
 * usage through AWS credentials (reported 2026-11-09). Boots the real AdminService via cds.test() on
 * in-memory SQLite with mocked users; runs bare.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'sb-admin@test.com': { id: 'sb-admin@test.com', roles: ['admin', 'user'] },
    'sb-user@test.com': { id: 'sb-user@test.com', roles: ['user'] }
  }
};

const { GET } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'sb-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'sb-user@test.com', password: 'x' } };
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const IN_PERIOD = '2026-09-15T10:00:00.000Z';
const BEFORE_PERIOD = '2026-08-20T10:00:00.000Z';
const stats = (extra = '') => `/odata/v4/admin/getUsageStatistics(startDate=2026-09-01,endDate=2026-09-30,granularity='day'${extra})`;
const TEAM = '11111111-1111-4111-8111-111111111111';

let n = 0;
const keyRow = (apiKey: string, email: string, validFrom: string, sap: Record<string, unknown>) => ({
  apiKey_ID: apiKey, keyName: apiKey, email, validFrom, validTo: '9999-12-31T23:59:59.999Z',
  provider: 'sap', model: 'sb-chat', endpoint: '/v1/chat/completions', statusCode: 200, inputTokens: 10,
  outputTokens: 0, totalTokens: 10, responseTime: 100, usageSignature: `sb-key-${++n}`, ...sap
});
const awsRow = (credential: string, validFrom: string, sap: Record<string, unknown>) => ({
  credential_ID: credential, credentialName: 'aws-own', userId: 'sb-user@test.com', validFrom, validTo: '9999-12-31T23:59:59.999Z',
  provider: 'bedrock', model: 'sb-claude', endpoint: '/model/invoke', statusCode: 200, inputTokens: 10,
  outputTokens: 0, responseTime: 100, usageSignature: `sb-aws-${++n}`, ...sap
});
const priced = (cu: number, cost: number, currency: string, tenant: string, extra: Record<string, unknown> = {}) =>
  ({ genAiTokens: cu * 10, capacityUnits: cu, sapCost: cost, sapCostCurrency: currency, sapTenant: tenant, ...extra });

let admin: any;
let adminTenantA: any;
let user: any;

const rowsOf = (data: any, id: string) => data.sapBilling.credentials.filter((r: any) => r.credentialId === id);

describe('getUsageStatistics sapBilling', () => {
  beforeAll(async () => {
    const { INSERT } = cds.ql;
    await cds.db.run(INSERT.into(KEYS).entries([
      { ID: 'sb-own', key: 'sk-sb-own', name: 'own', email: 'sb-user@test.com', isActive: true },
      { ID: 'sb-oth', key: 'sk-sb-oth', name: 'other', email: 'sb-other@test.com', isActive: true }
    ]));
    await cds.db.run(INSERT.into(AWS).entries([
      { ID: 'sb-aws', accessKeyId: 'TEST-SB-ACCESS-KEY-0', name: 'aws-own', userId: 'sb-user@test.com', email: 'sb-user@test.com', isActive: true }
    ]));
    await cds.db.run(INSERT.into(KEY_USAGE).entries([
      // in the period: the user's key in two tenants and two currencies, with a team snapshot
      keyRow('sb-own', 'sb-user@test.com', IN_PERIOD, priced(2, 1.5, 'USD', 'zone-a', { team_ID: TEAM, teamName: 'Blue', imageInputTokens: 7 })),
      keyRow('sb-own', 'sb-user@test.com', IN_PERIOD, priced(3, 2.0, 'EUR', 'zone-b', { team_ID: TEAM, teamName: 'Blue' })),
      // in the period: another owner's key
      keyRow('sb-oth', 'sb-other@test.com', IN_PERIOD, priced(5, 4.0, 'USD', 'zone-a')),
      // in the period but unpriced (no ModelCosts/price yet): counted, no currency
      keyRow('sb-oth', 'sb-other@test.com', IN_PERIOD, { genAiTokens: 10, capacityUnits: 1, sapTenant: 'zone-a' }),
      // BEFORE the period: must not appear in any figure
      keyRow('sb-own', 'sb-user@test.com', BEFORE_PERIOD, priced(100, 500, 'USD', 'zone-a', { team_ID: TEAM, teamName: 'Blue' })),
      keyRow('sb-oth', 'sb-other@test.com', BEFORE_PERIOD, priced(100, 500, 'USD', 'zone-a'))
    ]));
    await cds.db.run(INSERT.into(AWS_USAGE).entries([
      awsRow('sb-aws', IN_PERIOD, priced(4, 3.0, 'USD', 'zone-a', { team_ID: TEAM, teamName: 'Blue' })),
      awsRow('sb-aws', BEFORE_PERIOD, priced(100, 500, 'USD', 'zone-a', { team_ID: TEAM, teamName: 'Blue' }))
    ]));
    const [a, t, u] = await Promise.all([GET(stats(), ADMIN), GET(stats(",tenant='zone-a'"), ADMIN), GET(stats(), USER)]);
    expect(a.status).toBe(200);
    admin = a.data; adminTenantA = t.data; user = u.data;
  });

  it('sums a credential\'s rows of the period only, one row per credential and currency', () => {
    const own = rowsOf(admin, 'sb-own');
    expect(own.map((r: any) => r.sapCostCurrency).sort()).toEqual(['EUR', 'USD']);
    const usd = own.find((r: any) => r.sapCostCurrency === 'USD');
    expect(usd).toMatchObject({ credentialType: 'apiKey', totalRequests: 1, totalImageInputTokens: 7 });
    expect(Number(usd.totalCapacityUnits)).toBeCloseTo(2, 6);
    expect(Number(usd.totalGenAiTokens)).toBeCloseTo(20, 4);
    expect(Number(usd.totalSapCost)).toBeCloseTo(1.5, 6);
    // the 500 USD row of August is not in it
    const total = admin.sapBilling.credentials.reduce((s: number, r: any) => s + (Number(r.totalSapCost) || 0), 0);
    expect(total).toBeCloseTo(1.5 + 2.0 + 4.0 + 3.0, 6);
  });

  it('keeps unpriced rows apart: counted in capacity units, under no currency', () => {
    const unpriced = rowsOf(admin, 'sb-oth').find((r: any) => r.sapCostCurrency === null);
    expect(unpriced).toMatchObject({ totalRequests: 1 });
    expect(Number(unpriced.totalCapacityUnits)).toBeCloseTo(1, 6);
    expect(Number(unpriced.totalSapCost)).toBe(0);
  });

  it('includes usage through AWS credentials, with the credential\'s name', () => {
    const aws = rowsOf(admin, 'sb-aws');
    expect(aws).toHaveLength(1);
    expect(aws[0]).toMatchObject({ credentialType: 'awsCredential', name: 'aws-own', sapCostCurrency: 'USD', totalRequests: 1 });
    expect(Number(aws[0].totalSapCost)).toBeCloseTo(3.0, 6);
  });

  it('a tenant narrows it to that SAP tenant\'s rows', () => {
    const own = rowsOf(adminTenantA, 'sb-own');
    expect(own.map((r: any) => r.sapCostCurrency)).toEqual(['USD']);
    expect(rowsOf(adminTenantA, 'sb-aws')).toHaveLength(1);
  });

  it('teams: priced rows of the period per team and currency, both usage tables', () => {
    const blueUsd = admin.sapBilling.teams.find((r: any) => r.teamId === TEAM && r.sapCostCurrency === 'USD');
    expect(blueUsd).toMatchObject({ teamName: 'Blue', totalRequests: 2 });      // the key row and the AWS row
    expect(Number(blueUsd.totalSapCost)).toBeCloseTo(1.5 + 3.0, 6);
    expect(Number(blueUsd.totalCapacityUnits)).toBeCloseTo(2 + 4, 6);
    const noTeamUsd = admin.sapBilling.teams.find((r: any) => r.teamId === null && r.sapCostCurrency === 'USD');
    expect(Number(noTeamUsd.totalSapCost)).toBeCloseTo(4.0, 6);
  });

  it('a non-admin sees their own credentials only, and no team table', () => {
    expect([...new Set(user.sapBilling.credentials.map((r: any) => r.credentialId))].sort()).toEqual(['sb-aws', 'sb-own']);
    expect(user.sapBilling.teams).toEqual([]);
  });
});
