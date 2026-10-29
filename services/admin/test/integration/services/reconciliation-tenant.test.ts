/**
 * SAP bills per subaccount, so an invoice is compared with one tenant's usage only (spec
 * 2026-10-25 §6): reconcile() and the reconcileInvoice function take an optional tenant (the
 * tenant zone), and getUsageStatistics filters the SAP figures by it while the Connection figures
 * stay whole. An omitted tenant is today's behaviour (all rows). Boots the real AdminService via
 * cds.test() on in-memory SQLite; invented tenants, keys and models.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: { 'rt-admin@test.com': { id: 'rt-admin@test.com', roles: ['admin', 'user'] } } };

const { GET } = cds.test(path.resolve(__dirname, '../../..'));

import { reconcile } from '../../../src/services/reconciliationService';

const ADMIN = { auth: { username: 'rt-admin@test.com', password: 'x' } };
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const VALID_FROM = '2026-09-15T10:00:00.000Z';
const STATS = "/odata/v4/admin/getUsageStatistics(startDate=2026-09-01,endDate=2026-09-30,granularity='day'";
const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-09-30T23:59:59.999Z');

const row = (n: number, extra: Record<string, unknown>) => ({
  apiKey_ID: 'k-rt', keyName: 'rt', email: 'rt-admin@test.com', validFrom: VALID_FROM, validTo: '9999-12-31T23:59:59.999Z',
  provider: 'anthropic', model: 'rt-chat', endpoint: '/v1/chat/completions', statusCode: 200, inputTokens: 10, outputTokens: 0,
  totalTokens: 10, responseTime: 100, usageSignature: `rt-${n}`, ...extra
});

beforeAll(async () => {
  const { INSERT } = cds.ql;
  await cds.db.run(INSERT.into(KEYS).entries([{ ID: 'k-rt', key: 'sk-rt', name: 'rt', email: 'rt-admin@test.com', isActive: true }]));
  await cds.db.run(INSERT.into(KEY_USAGE).entries([
    row(1, { sapTenant: 'acme-dev', genAiTokens: 10, capacityUnits: 1, sapCost: 2, sapCostCurrency: 'USD', totalCost: 5 }),
    row(2, { sapTenant: 'acme-dev', genAiTokens: 20, capacityUnits: 2, sapCost: 4, sapCostCurrency: 'USD', totalCost: 6 }),
    row(3, { sapTenant: 'acme-prod', genAiTokens: 100, capacityUnits: 10, sapCost: 20, sapCostCurrency: 'EUR', totalCost: 7 }),
    row(4, { provider: 'openai', origin: 'external', connection: 'oa', model: 'oa-gpt', listCost: 0.5, listCostCurrency: 'USD', pricingMissing: false, totalCost: 0 })
  ]));
  await cds.db.run(INSERT.into(AWS_USAGE).entries([{
    credential_ID: 'c-rt', credentialName: 'rt-cred', userId: 'rt-admin@test.com', validFrom: VALID_FROM, validTo: '9999-12-31T23:59:59.999Z',
    provider: 'anthropic', modelId: 'rt-aws', statusCode: 200, inputTokens: 5, outputTokens: 0, usageSignature: 'rt-aws-1', sapTenant: 'acme-prod'
  }]));
});

describe('reconcile per tenant', () => {
  it('sums only that tenant\'s rows', async () => {
    const r = await reconcile({ from, to, tenant: 'acme-dev' });
    expect(r.capturedGenAiTokens).toBe(30);
    expect(r.capacityUnits).toBe(3);
    expect(r.sapCostByCurrency).toEqual({ USD: 6 });
  });
  it('an omitted or null tenant sums every row, as before', async () => {
    for (const input of [{ from, to }, { from, to, tenant: null }]) {
      const r = await reconcile(input);
      expect(r.capturedGenAiTokens).toBe(130);
      expect(r.capacityUnits).toBe(13);
      expect(r.sapCostByCurrency).toEqual({ USD: 6, EUR: 20 });
    }
  });
  it('a tenant without rows gives zeros', async () => {
    const r = await reconcile({ from, to, tenant: 'nobody' });
    expect(r.capacityUnits).toBe(0);
    expect(r.sapCostByCurrency).toEqual({});
  });
  it('the reconcileInvoice function passes the tenant on', async () => {
    const base = `/odata/v4/admin/reconcileInvoice(from=2026-09-01T00:00:00Z,to=2026-09-30T23:59:59Z,invoiceGenAiTokens=60,invoiceCapacityUnits=6,invoiceCacheReadInputTokens=0,invoiceCacheWriteInputTokens=0`;
    const scoped = await GET(`${base},tenant='acme-prod')`, ADMIN);
    expect(scoped.status).toBe(200);
    expect(Number(scoped.data.capturedGenAiTokens)).toBe(100);
    expect(Number(scoped.data.capacityUnits)).toBe(10);
    const all = await GET(`${base},tenant=null)`, ADMIN);
    expect(all.status).toBe(200);
    expect(Number(all.data.capturedGenAiTokens)).toBe(130);
  });
});

describe('getUsageStatistics per tenant', () => {
  const key = (d: any) => d.apiKeyUsage.find((r: any) => r.keyId === 'k-rt');
  it('filters the SAP figures and leaves the Connection figures whole', async () => {
    const all = (await GET(`${STATS})`, ADMIN)).data;
    const dev = (await GET(`${STATS},tenant='acme-dev')`, ADMIN)).data;
    const prod = (await GET(`${STATS},tenant='acme-prod')`, ADMIN)).data;
    expect(Number(key(all).totalCost)).toBe(18);
    expect(Number(key(dev).totalCost)).toBe(11);
    expect(Number(key(prod).totalCost)).toBe(7);
    expect(key(dev).totalRequests).toBe(3); // 2 acme-dev rows + the Connection row
    expect(all.awsCredentialUsage).toHaveLength(1);
    expect(dev.awsCredentialUsage).toHaveLength(0);
    expect(prod.awsCredentialUsage).toHaveLength(1);
    expect(dev.connectionUsage).toEqual(all.connectionUsage);
    expect(dev.connectionUsage).toHaveLength(1);
    expect(dev.modelUsage.find((m: any) => m.modelId === 'rt-chat').totalRequests).toBe(2);
    expect(dev.modelUsage.find((m: any) => m.modelId === 'oa-gpt').totalRequests).toBe(1);
  });
  it('a null tenant is today\'s result', async () => {
    const all = (await GET(`${STATS})`, ADMIN)).data;
    const nul = (await GET(`${STATS},tenant=null)`, ADMIN)).data;
    expect(nul).toEqual(all);
  });
});

describe('the usage views have one row per key and tenant', () => {
  it('a stored empty tenant and null rows of one key give one row', async () => {
    const { INSERT } = cds.ql;
    await cds.db.run(INSERT.into(KEYS).entries([{ ID: 'k-empty', key: 'sk-empty', name: 'empty', email: 'rt-admin@test.com', isActive: true }]));
    await cds.db.run(INSERT.into(KEY_USAGE).entries([
      { ...row(10, { apiKey_ID: 'k-empty', sapTenant: '', sapCost: 1, sapCostCurrency: 'USD' }) },
      { ...row(11, { apiKey_ID: 'k-empty', sapTenant: null, sapCost: 2, sapCostCurrency: 'USD' }) }
    ]));
    for (const view of ['ApiKeyUsageStats', 'ApiKeyUsageSapCostStats']) {
      const rows = (await GET(`/odata/v4/admin/${view}?$filter=apiKey_ID eq 'k-empty'`, ADMIN)).data.value;
      expect(rows).toHaveLength(1);
      expect(rows[0].sapTenant).toBe('');
    }
    await cds.db.run(cds.ql.DELETE.from(KEY_USAGE).where({ apiKey_ID: 'k-empty' }));
  });
});

describe('the usage views expose sapTenant', () => {
  it('ApiKeyUsageStats and ApiKeyUsageSapCostStats filter by it, TeamSapBillingStats too', async () => {
    const stats = (await GET(`/odata/v4/admin/ApiKeyUsageStats?$filter=sapTenant eq 'acme-dev'`, ADMIN)).data.value;
    expect(stats).toHaveLength(1);
    expect(Number(stats[0].totalGenAiTokens)).toBe(30);
    const cost = (await GET(`/odata/v4/admin/ApiKeyUsageSapCostStats?$filter=sapTenant eq 'acme-prod'`, ADMIN)).data.value;
    expect(cost.map((r: any) => [r.sapCostCurrency, Number(r.totalSapCost)])).toEqual([['EUR', 20]]);
    const teams = (await GET(`/odata/v4/admin/TeamSapBillingStats?$filter=sapTenant eq 'acme-prod'`, ADMIN)).data.value;
    expect(teams).toHaveLength(1);
    expect(Number(teams[0].totalCapacityUnits)).toBe(10);
    const allTeams = (await GET(`/odata/v4/admin/TeamSapBillingStats`, ADMIN)).data.value;
    expect(allTeams.reduce((s: number, r: any) => s + Number(r.totalCapacityUnits), 0)).toBe(13);
  });
});

describe('getUsageStatistics per connection', () => {
  const extra = (n: number, connection: string, listCost: number, currency: string, extraFields: Record<string, unknown> = {}) =>
    row(n, { provider: 'openai', origin: 'external', connection, model: `${connection}-gpt`, listCost, listCostCurrency: currency, pricingMissing: false, totalCost: 0, ...extraFields });
  const costOf = (d: any) => Object.fromEntries(d.connectionUsage.map((r: any) => [`${r.connection}/${r.currency}`, Number(r.totalListCost)]));

  beforeAll(async () => {
    await cds.db.run(cds.ql.INSERT.into(KEY_USAGE).entries([extra(20, 'az', 2, 'EUR'), extra(21, 'oa', 0.25, 'USD')]));
  });

  it('narrows only the Connection figures to that connection', async () => {
    const all = (await GET(`${STATS})`, ADMIN)).data;
    const oa = (await GET(`${STATS},connection='oa')`, ADMIN)).data;
    expect(costOf(all)).toEqual({ 'oa/USD': 0.75, 'az/EUR': 2 });
    expect(costOf(oa)).toEqual({ 'oa/USD': 0.75 });
    expect(oa.modelUsage.map((m: any) => m.modelId)).not.toContain('az-gpt');
    expect(oa.modelUsage.map((m: any) => m.modelId)).toContain('oa-gpt');
    expect(oa.connectionNames).toEqual(['az', 'oa']);
  });
  it('leaves the SAP figures alone', async () => {
    const all = (await GET(`${STATS})`, ADMIN)).data;
    const az = (await GET(`${STATS},connection='az')`, ADMIN)).data;
    expect(az.modelUsage.find((m: any) => m.modelId === 'rt-chat')).toEqual(all.modelUsage.find((m: any) => m.modelId === 'rt-chat'));
    expect(az.awsCredentialUsage).toEqual(all.awsCredentialUsage);
  });
  it('the tenant leaves the Connection figures unchanged, and both parameters combine independently', async () => {
    const all = (await GET(`${STATS})`, ADMIN)).data;
    const dev = (await GET(`${STATS},tenant='acme-dev')`, ADMIN)).data;
    expect(costOf(dev)).toEqual(costOf(all));
    const both = (await GET(`${STATS},tenant='acme-dev',connection='az')`, ADMIN)).data;
    expect(costOf(both)).toEqual({ 'az/EUR': 2 });
    expect(both.modelUsage.find((m: any) => m.modelId === 'rt-chat').totalRequests).toBe(2);
  });
  it('a null connection is today\'s result', async () => {
    const all = (await GET(`${STATS})`, ADMIN)).data;
    expect((await GET(`${STATS},connection=null)`, ADMIN)).data).toEqual(all);
  });
});
