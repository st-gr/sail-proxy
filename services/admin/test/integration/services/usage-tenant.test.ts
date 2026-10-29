/**
 * Usage rows carry the SAP tenant that served them, and each row is priced with that tenant's
 * billing terms (spec 2026-10-25 §6): its productive flag and its capacity-unit price region.
 * A tenant without settings (and every row without a tenant) keeps the installation default,
 * platform.billing.productive — set to false here. Old rows get the environment tenant once.
 *
 * cds.test() on an in-memory SQLite: the real processor, pricing, recalculation and the
 * connection PATCH hook. Invented tenants, models and keys throughout.
 */
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

process.env.CDS_TYPESCRIPT = 'true';
jest.mock('../../../src/utils/apiConfigFile', () => {
  const actual = jest.requireActual('../../../src/utils/apiConfigFile');
  return {
    ...actual,
    readApiConfigBlock: () => {
      let real: any = {};
      try { real = actual.readApiConfigBlock() ?? {}; } catch { real = {}; }
      return { ...real, platform: { ...real.platform, billing: { ...real.platform?.billing, productive: false } } };
    },
  };
});
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'ut-admin@test.com': { id: 'ut-admin@test.com', roles: ['admin', 'user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), publish: jest.fn(async () => false), shutdown: jest.fn() } }));
jest.mock('../../../src/services/connectionsNotifier', () => ({
  CONNECTIONS_CHANGE_CHANNEL: 'test:connections-changed', publishConnectionsChanged: jest.fn(async () => true) }));

const { POST, PATCH } = cds.test(path.resolve(__dirname, '../../..'));

import UsageEventProcessor, { UsageEvent } from '../../../src/services/usageEventProcessor';
import { costRecalculationService } from '../../../src/services/costRecalculationService';
import { cuFactor, isProductive } from '../../../src/services/sapCapacityService';
import { productiveFor } from '../../../src/services/sapTenants';
import { backfillEnvironmentTenantOnce, environmentTenant, __resetBackfillDoneForTests } from '../../../src/db/data/sap-tenant-backfill';

const ADMIN = { auth: { username: 'ut-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';
const PRICES = 'sap.llm.gateway.admin.SapCapacityUnitPrice';
const TENANTS = 'sap.llm.gateway.admin.SapTenants';
const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const CREDS = 'sap.llm.gateway.admin.ConnectionCredentials';
const MODEL = 'tenant-billing-test-model';
const MARKER = 'sap.llm.gateway.admin.SapTenantBackfill';

// 1,000 input tokens at a GenAI rate of 10 per 1,000 → 10 GenAI tokens.
const CU = 10 * cuFactor();
const PRICE = { nonProductive: 1, productive: 2, productiveEu: 3 };

const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  requestId: uuidv4(), timestamp: Math.floor(Date.now() / 1000), authType: 'api_key', credentialId: uuidv4(),
  provider: 'unknown', model: MODEL, inputTokens: 1000, outputTokens: 0, responseTime: 10, statusCode: 200, ...overrides,
});
const persist = (events: UsageEvent[]) => (new UsageEventProcessor({ enableCostCalculation: false }) as any).persistUsageEvents(events);
const rowOf = async (requestId: string, table = KEY_USAGE) => cds.run(cds.ql.SELECT.one.from(table).where({ requestId }));
const price = (usageType: string, pricePerCu: number, region: string | null = 'US') => ({
  ID: uuidv4(), usageType, pricePerCu, currency: 'USD', region,
  dateFrom: '2020-01-01T00:00:00.000Z', dateTo: '2099-12-31T23:59:59.999Z',
});

beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  await cds.run([DELETE.from(KEY_USAGE), DELETE.from(AWS_USAGE), DELETE.from(PRICES), DELETE.from(TENANTS), DELETE.from(MARKER), DELETE.from(MODEL_COSTS).where({ model: MODEL })]);
  __resetBackfillDoneForTests();
  await cds.run(INSERT.into(MODEL_COSTS).entries({
    ID: uuidv4(), model: MODEL, inputCost: 10, outputCost: 20, dateFrom: '2020-01-01T00:00:00.000Z', dateTo: '2099-12-31T23:59:59.999Z',
  }));
  await cds.run(INSERT.into(PRICES).entries([price('non-productive', PRICE.nonProductive), price('productive', PRICE.productive)]));
});

describe('the installation default', () => {
  it('is non-productive in this suite', () => {
    expect(isProductive()).toBe(false);
  });
});

describe('usage rows carry the SAP tenant', () => {
  it('stores the event tenant on API key and AWS rows; a Connection row has none', async () => {
    const a = event({ sapTenant: 'acme-dev' } as any);
    const b = event({ sapTenant: 'acme-dev', authType: 'aws_credential' } as any);
    const x = event({ sapTenant: null, origin: 'external', model: 'openai-main--gpt-x', connectionId: uuidv4(), upstreamModel: 'gpt-x' } as any);
    await persist([a, b, x]);
    expect((await rowOf(a.requestId)).sapTenant).toBe('acme-dev');
    expect((await rowOf(b.requestId, AWS_USAGE)).sapTenant).toBe('acme-dev');
    expect((await rowOf(x.requestId)).sapTenant).toBeNull();
  });

  it('stores an empty tenant as null', async () => {
    const a = event({ sapTenant: '' } as any);
    const b = event({ authType: 'aws_credential', sapTenant: '' } as any);
    await persist([a, b]);
    expect((await rowOf(a.requestId)).sapTenant).toBeNull();
    expect((await rowOf(b.requestId, AWS_USAGE)).sapTenant).toBeNull();
  });

  it('records a tenant seen for the first time, with no billing settings', async () => {
    await persist([event({ sapTenant: 'acme-dev' } as any)]);
    const t = await cds.run(cds.ql.SELECT.one.from(TENANTS).where({ zone: 'acme-dev' }));
    expect(t).toMatchObject({ zone: 'acme-dev', productive: null, priceRegion: null });
    expect(await productiveFor('acme-dev')).toBe(false);
    expect(await productiveFor(null)).toBe(false);
  });
});

describe('pricing per tenant', () => {
  it('without tenant settings every row is priced exactly as before (installation default)', async () => {
    const plain = event();
    const unset = event({ sapTenant: 'acme-dev' } as any);
    await cds.run(cds.ql.INSERT.into(TENANTS).entries({ zone: 'acme-dev', region: 'prod.eu-central-1' }));
    await persist([plain, unset]);
    for (const id of [plain.requestId, unset.requestId]) {
      const r = await rowOf(id);
      expect(Number(r.capacityUnits)).toBeCloseTo(CU, 4);
      expect(Number(r.sapCost)).toBeCloseTo(CU * PRICE.nonProductive, 4);
    }
  });

  it('a productive tenant is priced with the productive CU price while the installation is not', async () => {
    await cds.run(cds.ql.INSERT.into(TENANTS).entries({ zone: 'acme-prod', region: 'prod.eu-central-1', productive: true }));
    const e = event({ sapTenant: 'acme-prod' } as any);
    const env = event();
    await persist([e, env]);
    expect(Number((await rowOf(e.requestId)).sapCost)).toBeCloseTo(CU * PRICE.productive, 4);
    expect(Number((await rowOf(env.requestId)).sapCost)).toBeCloseTo(CU * PRICE.nonProductive, 4);
    expect(await productiveFor('acme-prod')).toBe(true);
  });

  it('a price region with its own price row gets that price; without one the old lookup result', async () => {
    await cds.run(cds.ql.INSERT.into(TENANTS).entries([
      { zone: 'acme-eu', region: 'prod.eu-central-1', productive: true, priceRegion: 'EU' },
      { zone: 'acme-jp', region: 'prod.ap-northeast-1', productive: true, priceRegion: 'JP' },
    ]));
    await cds.run(cds.ql.INSERT.into(PRICES).entries(price('productive', PRICE.productiveEu, 'EU')));
    const eu = event({ sapTenant: 'acme-eu' } as any);
    const jp = event({ sapTenant: 'acme-jp', authType: 'aws_credential' } as any);
    await persist([eu, jp]);
    expect(Number((await rowOf(eu.requestId)).sapCost)).toBeCloseTo(CU * PRICE.productiveEu, 4);
    expect(Number((await rowOf(jp.requestId, AWS_USAGE)).sapCost)).toBeCloseTo(CU * PRICE.productive, 4);
  });
});

describe('recalculation per tenant', () => {
  it('the nightly run reprices a drifted row with its tenant\'s productive flag and price region', async () => {
    await cds.run(cds.ql.INSERT.into(TENANTS).entries({ zone: 'acme-eu', region: 'prod.eu-central-1', productive: true, priceRegion: 'EU' }));
    await cds.run(cds.ql.INSERT.into(PRICES).entries(price('productive', PRICE.productiveEu, 'EU')));
    const t = event({ sapTenant: 'acme-eu' } as any);
    const plain = event();
    await persist([t, plain]);
    // A stale dollar price selects the rows (the drift gate); the SAP cost follows the tenant.
    await cds.run(cds.ql.UPDATE(KEY_USAGE).set({ inputCost: 999, sapCost: 0 }).where({ requestId: { in: [t.requestId, plain.requestId] } }));
    await costRecalculationService.runRecalculation();
    expect(Number((await rowOf(t.requestId)).sapCost)).toBeCloseTo(CU * PRICE.productiveEu, 4);
    expect(Number((await rowOf(plain.requestId)).sapCost)).toBeCloseTo(CU * PRICE.nonProductive, 4);
  });

  it('a PATCH of productive / priceRegion on the connection updates its tenant and reprices that tenant\'s rows', async () => {
    process.env.CONNECTION_CREDENTIAL_KEY = 'k'.repeat(64);
    await cds.run([cds.ql.DELETE.from(CREDS), cds.ql.DELETE.from(CONNS)]);
    const c = (await POST(`${S}/ProviderConnections`, { name: 'sap-acme', providerType: 'sap-ai-core', productive: false, IsActiveEntity: true }, ADMIN)).data;
    await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/AdminService.setCredential`, { secret: JSON.stringify({
      serviceurls: { AI_API_URL: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com' },
      appname: 'example-app', clientid: 'sb-example-client!b1|aicore!b540', clientsecret: 'example-secret-value',
      identityzone: 'acme-tenant', identityzoneid: '11111111-2222-3333-4444-555555555555',
      url: 'https://acme-tenant.authentication.eu10.hana.ondemand.com',
    }) }, ADMIN);
    const mine = event({ sapTenant: 'acme-tenant.eu10' } as any);
    const mineAws = event({ sapTenant: 'acme-tenant.eu10', authType: 'aws_credential' } as any);
    const other = event({ sapTenant: 'other-tenant' } as any);
    await persist([mine, mineAws, other]);
    expect(Number((await rowOf(mine.requestId)).sapCost)).toBeCloseTo(CU * PRICE.nonProductive, 4);

    const reprice = jest.spyOn(costRecalculationService, 'repriceTenant');
    try {
      const r = await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { productive: true }, ADMIN);
      expect(r.status).toBe(200);
      expect(await cds.run(cds.ql.SELECT.one.from(TENANTS).columns('productive').where({ zone: 'acme-tenant.eu10' }))).toEqual({ productive: true });
      expect(reprice).toHaveBeenCalledWith('acme-tenant.eu10');
      await reprice.mock.results[0].value;
      expect(Number((await rowOf(mine.requestId)).sapCost)).toBeCloseTo(CU * PRICE.productive, 4);
      expect(Number((await rowOf(mineAws.requestId, AWS_USAGE)).sapCost)).toBeCloseTo(CU * PRICE.productive, 4);
      expect(Number((await rowOf(other.requestId)).sapCost)).toBeCloseTo(CU * PRICE.nonProductive, 4);

      await cds.run(cds.ql.INSERT.into(PRICES).entries(price('productive', PRICE.productiveEu, 'EU')));
      await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { priceRegion: 'EU' }, ADMIN);
      expect(reprice).toHaveBeenCalledTimes(2);
      await reprice.mock.results[1].value;
      expect(Number((await rowOf(mine.requestId)).sapCost)).toBeCloseTo(CU * PRICE.productiveEu, 4);

      // Another field changes nothing on the tenant and schedules nothing.
      await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { resourceGroup: 'team-a' }, ADMIN);
      expect(reprice).toHaveBeenCalledTimes(2);
    } finally {
      reprice.mockRestore();
    }
  });
});

describe('backfill of rows that predate the tenant column', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  /** Pre-feature rows (10 days old), one row stamped 5 days ago, and a null row written after it (2 days old). */
  const insertRows = async () => {
    const { INSERT } = cds.ql;
    const row = (requestId: string, validFrom: string, extra: Record<string, any> = {}) =>
      ({ ID: uuidv4(), requestId, usageSignature: `sig-${requestId}`, validFrom, validTo: '9999-12-31T23:59:59.999Z', model: MODEL, inputTokens: 1, outputTokens: 1, origin: 'sap', ...extra });
    await cds.run(INSERT.into(KEY_USAGE).entries([
      row('old-sap', daysAgo(10)),
      row('old-null-origin', daysAgo(10), { origin: null }),
      row('old-external', daysAgo(10), { origin: 'external' }),
      row('first-stamped', daysAgo(5), { sapTenant: 'globex-conn' }),
      row('later-null', daysAgo(2)),
    ]));
    await cds.run(INSERT.into(AWS_USAGE).entries({ ID: uuidv4(), requestId: 'old-aws', origin: 'sap', usageSignature: 'sig-old-aws', modelId: MODEL, validFrom: daysAgo(10), validTo: '9999-12-31T23:59:59.999Z' }));
  };
  const tenantOf = async (id: string, table = KEY_USAGE) => (await rowOf(id, table)).sapTenant;
  const db = () => cds.connect.to('db');

  it('derives the environment tenant from AUTH_URL; none without it', () => {
    expect(environmentTenant({ AUTH_URL: 'https://Acme-Env.authentication.eu10.hana.ondemand.com/oauth/token' })?.zone ?? null).toBe('acme-env.eu10');
    expect(environmentTenant({})?.zone ?? null).toBeNull();
    expect(environmentTenant({ AUTH_URL: 'not a url' })?.zone ?? null).toBeNull();
  });

  it('runs once: old SAP rows before the first stamped row get the zone; external and later rows stay null', async () => {
    await insertRows();
    expect(await backfillEnvironmentTenantOnce(await db(), 'acme-env', new Date())).toBe(3);
    for (const [id, table] of [['old-sap', KEY_USAGE], ['old-null-origin', KEY_USAGE], ['old-aws', AWS_USAGE]]) {
      expect(await tenantOf(id, table)).toBe('acme-env');
    }
    expect(await tenantOf('old-external')).toBeNull();
    expect(await tenantOf('later-null')).toBeNull();
    expect(await tenantOf('first-stamped')).toBe('globex-conn');
    // The marker: a second run, even for another zone, does nothing.
    await cds.run(cds.ql.UPDATE(KEY_USAGE).set({ sapTenant: null }).where({ requestId: 'old-sap' }));
    expect(await backfillEnvironmentTenantOnce(await db(), 'other-env', new Date())).toBeNull();
    expect(await tenantOf('old-sap')).toBeNull();
    expect(await cds.run(cds.ql.SELECT.from(MARKER))).toEqual([expect.objectContaining({ zone: 'acme-env', rowsUpdated: 3 })]);
  });

  it('without any stamped row the bound is the given moment', async () => {
    await insertRows();
    await cds.run(cds.ql.DELETE.from(KEY_USAGE).where({ requestId: 'first-stamped' }));
    expect(await backfillEnvironmentTenantOnce(await db(), 'acme-env', new Date(daysAgo(3)))).toBe(3);
    expect(await tenantOf('later-null')).toBeNull();
  });

  it('a connection-sourced unknown zone gets its tenant row and never backfills', async () => {
    await insertRows();
    await persist([event({ sapTenant: 'globex-new', sapTenantSource: 'connection' } as any)]);
    expect(await cds.run(cds.ql.SELECT.one.from(TENANTS).columns('zone').where({ zone: 'globex-new' }))).toEqual({ zone: 'globex-new' });
    expect(await tenantOf('old-sap')).toBeNull();
    expect(await cds.run(cds.ql.SELECT.from(MARKER))).toEqual([]);
  });

  it('the first environment-sourced event backfills once (the admin has no AUTH_URL); a second environment zone later does nothing', async () => {
    await insertRows();
    await persist([event({ sapTenant: 'acme-env', sapTenantSource: 'environment' } as any)]);
    expect(await tenantOf('old-sap')).toBe('acme-env');
    expect(await tenantOf('old-aws', AWS_USAGE)).toBe('acme-env');
    expect(await tenantOf('old-external')).toBeNull();
    expect(await tenantOf('later-null')).toBeNull();
    await cds.run(cds.ql.UPDATE(KEY_USAGE).set({ sapTenant: null }).where({ requestId: 'old-sap' }));
    await persist([event({ sapTenant: 'acme-env-two', sapTenantSource: 'environment' } as any)]);
    expect(await tenantOf('old-sap')).toBeNull();
  });
});

describe('the tenant name is the auth-URL zone', () => {
  it('a key whose identityzone differs from its auth URL host keys the tenant by the host zone; the gateway\'s events hit that row', async () => {
    process.env.CONNECTION_CREDENTIAL_KEY = 'k'.repeat(64);
    await cds.run([cds.ql.DELETE.from(CREDS), cds.ql.DELETE.from(CONNS)]);
    const c = (await POST(`${S}/ProviderConnections`, { name: 'sap-hooli', providerType: 'sap-ai-core', productive: true, IsActiveEntity: true }, ADMIN)).data;
    await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/AdminService.setCredential`, { secret: JSON.stringify({
      serviceurls: { AI_API_URL: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com' },
      appname: 'example-app', clientid: 'sb-example-client!b1|aicore!b540', clientsecret: 'example-secret-value',
      identityzone: 'Hooli-Subaccount_Display', identityzoneid: '22222222-3333-4444-5555-666666666666',
      url: 'https://hooli-sub.authentication.eu10.hana.ondemand.com',
    }) }, ADMIN);
    expect((await cds.run(cds.ql.SELECT.one.from(CONNS).columns('tenantId').where({ ID: c.ID }))).tenantId).toBe('hooli-sub.eu10');
    expect(await cds.run(cds.ql.SELECT.from(TENANTS).columns('zone', 'zoneId'))).toEqual([{ zone: 'hooli-sub.eu10', zoneId: '22222222-3333-4444-5555-666666666666' }]);
    const e = event({ sapTenant: 'hooli-sub.eu10', sapTenantSource: 'connection' } as any);
    await persist([e]);
    expect(await cds.run(cds.ql.SELECT.from(TENANTS))).toHaveLength(1);
    expect(Number((await rowOf(e.requestId)).sapCost)).toBeCloseTo(CU * PRICE.productive, 4);
  });
});

describe('the nightly statement without tenant settings', () => {
  it('is the statement it was before tenants (no tenant column, no region preference)', () => {
    for (const pg of [true, false]) {
      const sql: string = (costRecalculationService as any).buildUpdateSQL(KEY_USAGE.replace(/\./g, '_'), 'u.model = mc.model', pg, new Map(), 'non-productive', []);
      expect(sql).not.toContain('sapTenant');
      expect(sql).not.toContain('p.region');
      expect(sql).toContain("p.usageType = 'non-productive'");
    }
  });
});
