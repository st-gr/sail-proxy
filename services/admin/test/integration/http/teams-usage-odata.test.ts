/** Teams by cost and SAP billing by team (spec 2026-10-14 §6) over the usage rows' team snapshot, deleted teams included. */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: { 'tu-admin@test.com': { id: 'tu-admin@test.com', roles: ['admin', 'user'] }, 'tu-user@test.com': { id: 'tu-user@test.com', roles: ['user'] } } };
const { GET } = cds.test(path.resolve(__dirname, '../../..'));
const ADMIN = { auth: { username: 'tu-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'tu-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage'; const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage'; const TEAMS = 'sap.llm.gateway.admin.Teams';
const row = (o: any) => ({ validFrom: '2026-10-14T09:00:00.000Z', validTo: '9999-12-31T00:00:00.000Z', provider: 'anthropic', statusCode: 200, responseTime: 100, inputTokens: 100, outputTokens: 50, totalTokens: 150, totalCost: 0.1, genAiTokens: 10, capacityUnits: 1, sapCost: 0.5, sapCostCurrency: 'USD', usageSignature: `s-${Math.random()}`, ...o });

beforeEach(async () => {
  for (const t of [KEY_USAGE, AWS_USAGE, TEAMS]) await cds.db.run(cds.ql.DELETE.from(t));
  await cds.db.run(cds.ql.INSERT.into(TEAMS).entries({ ID: 't-a', name: 'Alpha' }));
  await cds.db.run(cds.ql.INSERT.into(KEY_USAGE).entries([
    row({ apiKey_ID: 'k1', email: 'tu-user@test.com', model: 'm', team_ID: 't-a', teamName: 'Alpha' }),
    row({ apiKey_ID: 'k2', email: 'tu-admin@test.com', model: 'm', team_ID: 't-a', teamName: 'Alpha', sapCostCurrency: 'EUR' }),
    row({ apiKey_ID: 'k1', email: 'tu-user@test.com', model: 'm', team_ID: 't-gone', teamName: 'Deleted team' }),
    row({ apiKey_ID: 'k1', email: 'tu-user@test.com', model: 'm' })
  ]));
  await cds.db.run(cds.ql.INSERT.into(AWS_USAGE).entries([row({ credential_ID: 'c1', userId: 'tu-user@test.com', modelId: 'm', team_ID: 't-a', teamName: 'Alpha', inputTokens: 1, outputTokens: 0 })]));
});

it('getUsageStatistics returns teamUsage over both tables; a deleted team keeps its snapshot name; rows without a team fold into one entry', async () => {
  const r = await GET(`${S}/getUsageStatistics(startDate=2026-10-01,endDate=2026-10-31,granularity='day')`, ADMIN);
  const byName = Object.fromEntries(r.data.teamUsage.map((t: any) => [t.teamName ?? '(none)', t]));
  expect(byName.Alpha).toMatchObject({ teamId: 't-a', totalRequests: 3, totalInputTokens: 201, uniqueUsers: 2 });
  expect(byName['Deleted team']).toMatchObject({ teamId: 't-gone', totalRequests: 1 });
  expect(byName['(none)']).toMatchObject({ teamId: null, totalRequests: 1 });
  const mine = await GET(`${S}/getUsageStatistics(startDate=2026-10-01,endDate=2026-10-31,granularity='day')`, USER);
  expect(mine.data.teamUsage.find((t: any) => t.teamName === 'Alpha').totalRequests).toBe(2);   // own rows only
});

it('TeamSapBillingStats groups both tables per team and currency, admin only', async () => {
  const rows = (await GET(`${S}/TeamSapBillingStats`, ADMIN)).data.value;
  const alphaUsd = rows.find((x: any) => x.teamId === 't-a' && x.sapCostCurrency === 'USD');
  expect(alphaUsd).toMatchObject({ teamName: 'Alpha', totalRequests: 2 });
  expect(Number(alphaUsd.totalSapCost)).toBeCloseTo(1, 6); expect(Number(alphaUsd.totalCapacityUnits)).toBe(2);
  expect(rows.find((x: any) => x.teamId === 't-a' && x.sapCostCurrency === 'EUR').totalRequests).toBe(1);
  expect(rows.find((x: any) => x.teamName === 'Deleted team')).toBeTruthy();
  expect(rows.find((x: any) => x.teamId === '00000000-0000-0000-0000-000000000000')).toMatchObject({ teamName: null, totalRequests: 1 });
  expect((await ok(GET(`${S}/TeamSapBillingStats`, USER))).status).toBe(403);
});
