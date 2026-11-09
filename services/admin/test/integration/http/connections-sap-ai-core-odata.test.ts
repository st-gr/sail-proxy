/**
 * SAP AI Core connections (spec 2026-10-25 §4, §5, §6) on cds.test(): the service key as the
 * write-only credential (parsed, stored as the gateway's target JSON, never read back), the SAP
 * tenant it belongs to, and the exclusive activate/deactivate actions that pick the one SAP
 * target of the installation. The change marker goes out once per activation and once at boot.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'sc-admin@test.com': { id: 'sc-admin@test.com', roles: ['admin', 'user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), publish: jest.fn(async () => false), shutdown: jest.fn() } }));
// The installation's billing classification (api_config platform.billing.productive) prefills a new SAP draft.
jest.mock('../../../src/services/sapCapacityService', () => {
  const actual = jest.requireActual('../../../src/services/sapCapacityService');
  return { ...actual, isProductive: jest.fn(actual.isProductive) };
});
jest.mock('../../../src/services/connectionsNotifier', () => ({
  CONNECTIONS_CHANGE_CHANNEL: 'test:connections-changed', publishConnectionsChanged: jest.fn(async () => true) }));

const { GET, POST, PATCH, DELETE } = cds.test(path.resolve(__dirname, '../../..'));
const { publishConnectionsChanged } = require('../../../src/services/connectionsNotifier');
const { isProductive } = require('../../../src/services/sapCapacityService');
import { getConnectionCredential } from '../../../src/services/connectionCredentialStore';
import { buildConnectionSnapshot } from '../../../src/services/connectionSnapshot';
import { tenantSettings } from '../../../src/services/sapTenants';

const ADMIN = { auth: { username: 'sc-admin@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const CREDS = 'sap.llm.gateway.admin.ConnectionCredentials';
const TENANTS = 'sap.llm.gateway.admin.SapTenants';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const conn = (id: string) => `${S}/ProviderConnections(ID=${id},IsActiveEntity=true)`;
const code = (r: any): string => String(r?.data?.error?.code ?? '');

// Invented values throughout: no real tenant, client or secret.
const CLIENT_ID = 'sb-11111111-2222-3333-4444-555555555555!b12345|aicore!b540';
const CLIENT_SECRET = 'aaaa1111-bbbb-2222-cccc-3333dddd4444$EXAMPLEsecretVALUE=';
const serviceKey = (overrides: Record<string, any> = {}) => JSON.stringify({
  serviceurls: { AI_API_URL: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com' },
  appname: 'example-app', clientid: CLIENT_ID, clientsecret: CLIENT_SECRET,
  identityzone: 'example-tenant', identityzoneid: '99999999-8888-7777-6666-555555555555',
  url: 'https://example-tenant.authentication.eu10.hana.ondemand.com', 'credential-type': 'binding-secret',
  ...overrides,
});

let bootCalls = 0;
beforeAll(() => { bootCalls = (publishConnectionsChanged as jest.Mock).mock.calls.length; });

async function createSap(name: string, extra: Record<string, any> = {}): Promise<any> {
  return (await POST(`${S}/ProviderConnections`, { name, providerType: 'sap-ai-core', productive: true, IsActiveEntity: true, ...extra }, ADMIN)).data;
}
const markTested = (id: string) => cds.run(cds.ql.UPDATE(CONNS).set({ lastTestResult: 'ok', lastTestAt: new Date().toISOString() }).where({ ID: id }));
const activeNames = async () => (await cds.run(cds.ql.SELECT.from(CONNS).columns('name').where({ providerType: 'sap-ai-core' }).and({ isActive: true }))).map((r: any) => r.name);

describe('admin boot', () => {
  it('publishes the change marker once', () => {
    expect(bootCalls).toBe(1);
  });
});

describe('SAP AI Core connections', () => {
  beforeEach(async () => {
    process.env.CONNECTION_CREDENTIAL_KEY = 'k'.repeat(64);
    const { DELETE: DEL } = cds.ql;
    await cds.run([DEL.from(CREDS), DEL.from(CONNS), DEL.from(TENANTS), DEL.from(AUDIT)]);
    (publishConnectionsChanged as jest.Mock).mockClear();
  });

  it('is created inactive, with the default resource group', async () => {
    const c = await createSap('sap-eu', { isActive: true });
    const row = await cds.run(cds.ql.SELECT.one.from(CONNS).where({ ID: c.ID }));
    expect(row.isActive).toBe(false);
    expect(row.resourceGroup).toBe('default');
    expect(row.productive).toBe(true);
  });

  it('requires productive at creation and a valid resource group', async () => {
    const r = await ok(POST(`${S}/ProviderConnections`, { name: 'sap-eu', providerType: 'sap-ai-core', IsActiveEntity: true }, ADMIN));
    expect(r.status).toBe(400);
    expect(r.data.error.message).toMatch(/productive/);
    const g = await ok(POST(`${S}/ProviderConnections`, { name: 'sap-eu', providerType: 'sap-ai-core', productive: false, resourceGroup: '-bad/group', IsActiveEntity: true }, ADMIN));
    expect(g.status).toBe(400);
    expect(g.data.error.message).toMatch(/resourceGroup/);
  });

  it('a PATCH of isActive is refused (the actions set it)', async () => {
    const c = await createSap('sap-eu');
    const r = await ok(PATCH(conn(c.ID), { isActive: true }, ADMIN));
    expect(r.status).toBe(400);
    expect(code(r)).toBe('use_activate_action');
    expect(await activeNames()).toEqual([]);
  });

  it('setCredential parses the service key: hint, endpoint, region, tenant, and a tenant row', async () => {
    const c = await createSap('sap-eu');
    const r = await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toContain(CLIENT_SECRET);
    expect(r.data.credentialHint).toBe('sb-1…b540');
    expect(r.data).toMatchObject({
      endpoint: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com', region: 'prod.eu-central-1',
      clientId: CLIENT_ID, tenantId: 'example-tenant.eu10',
    });
    const tenants = await cds.run(cds.ql.SELECT.from(TENANTS));
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({ zone: 'example-tenant.eu10', zoneId: '99999999-8888-7777-6666-555555555555', region: 'prod.eu-central-1', productive: true });
    expect(await tenantSettings('example-tenant.eu10')).toEqual({ productive: true, priceRegion: null });
    expect(await tenantSettings('no-such-tenant')).toBeNull();
    const stored = await getConnectionCredential(c.ID);
    expect(JSON.parse(stored!.secret)).toEqual({
      aiCoreUrl: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com',
      authUrl: 'https://example-tenant.authentication.eu10.hana.ondemand.com/oauth/token',
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, region: 'prod.eu-central-1',
    });
  });

  it('a GET never returns the secret', async () => {
    const c = await createSap('sap-eu');
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    const one = JSON.stringify((await GET(`${conn(c.ID)}?$select=*`, ADMIN)).data);
    const list = JSON.stringify((await GET(`${S}/ProviderConnections?$filter=IsActiveEntity eq true`, ADMIN)).data);
    const tenants = JSON.stringify((await GET(`${S}/SapTenants`, ADMIN)).data);
    for (const body of [one, list, tenants]) expect(body).not.toContain(CLIENT_SECRET);
  });

  it('a malformed or incomplete service key → 400 service_key_invalid, nothing stored', async () => {
    const c = await createSap('sap-eu');
    const bad = await ok(POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: '{not json' }, ADMIN));
    expect(bad.status).toBe(400);
    expect(code(bad)).toBe('service_key_invalid');
    expect(bad.data.error.message).toMatch(/Invalid JSON format/);
    const noZone = await ok(POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey({ identityzone: undefined }) }, ADMIN));
    expect(noZone.status).toBe(400);
    expect(noZone.data.error.message).toMatch(/identityzone/);
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(0);
    expect(await cds.run(cds.ql.SELECT.from(TENANTS))).toHaveLength(0);
  });

  it('a session token is refused', async () => {
    const c = await createSap('sap-eu');
    const r = await ok(POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey(), sessionToken: 't' }, ADMIN));
    expect(r.status).toBe(400);
    expect(code(r)).toBe('session_token_not_applicable');
  });

  it('rotating the key reuses the tenant row', async () => {
    const c = await createSap('sap-eu');
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey({ clientid: 'sb-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee!b999|aicore!b540', identityzone: ' Example-Tenant ' }) }, ADMIN);
    expect(await cds.run(cds.ql.SELECT.from(TENANTS))).toHaveLength(1);
  });

  it('activate needs a credential and a passing test', async () => {
    const c = await createSap('sap-eu');
    const noCred = await ok(POST(`${conn(c.ID)}/AdminService.activate`, {}, ADMIN));
    expect(noCred.status).toBe(409);
    expect(code(noCred)).toBe('no_credential');
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    const untested = await ok(POST(`${conn(c.ID)}/AdminService.activate`, {}, ADMIN));
    expect(untested.status).toBe(409);
    expect(code(untested)).toBe('test_required');
    expect(await activeNames()).toEqual([]);
  });

  it('activate is exclusive; deactivate leaves none active; one marker each', async () => {
    const a = await createSap('sap-eu');
    const b = await createSap('sap-us');
    for (const c of [a, b]) {
      await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
      await markTested(c.ID);
    }
    (publishConnectionsChanged as jest.Mock).mockClear();
    const r = await POST(`${conn(a.ID)}/AdminService.activate`, {}, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data.isActive).toBe(true);
    expect(await activeNames()).toEqual(['sap-eu']);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(1);
    await POST(`${conn(b.ID)}/AdminService.activate`, {}, ADMIN);
    expect(await activeNames()).toEqual(['sap-us']);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(2);
    await POST(`${conn(b.ID)}/AdminService.deactivate`, {}, ADMIN);
    expect(await activeNames()).toEqual([]);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(3);
    const audit = await cds.run(cds.ql.SELECT.from(AUDIT).where({ action: { in: ['connection.sap.activate', 'connection.sap.deactivate'] } }));
    expect(audit.map((e: any) => e.action).sort()).toEqual(['connection.sap.activate', 'connection.sap.activate', 'connection.sap.deactivate']);
    for (const e of audit) {
      expect(e.details).not.toContain(CLIENT_SECRET);
      expect(e.details).not.toContain(CLIENT_ID);
      expect(JSON.parse(e.details).tenant).toBe('example-tenant.eu10');
    }
  });

  it('activate and deactivate are for sap-ai-core connections only', async () => {
    const o = (await POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai', IsActiveEntity: true }, ADMIN)).data;
    const r = await ok(POST(`${conn(o.ID)}/AdminService.activate`, {}, ADMIN));
    expect(r.status).toBe(400);
    const d = await ok(POST(`${conn(o.ID)}/AdminService.deactivate`, {}, ADMIN));
    expect(d.status).toBe(400);
  });

  it('deleting the active connection → 409 connection_active; inactive deletes', async () => {
    const c = await createSap('sap-eu');
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    await markTested(c.ID);
    await POST(`${conn(c.ID)}/AdminService.activate`, {}, ADMIN);
    const r = await ok(DELETE(conn(c.ID), ADMIN));
    expect(r.status).toBe(409);
    expect(code(r)).toBe('connection_active');
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(1);
    await POST(`${conn(c.ID)}/AdminService.deactivate`, {}, ADMIN);
    expect((await DELETE(conn(c.ID), ADMIN)).status).toBe(204);
  });

  it('clearCredential on the active connection → 409 connection_active; an inactive one clears', async () => {
    const c = await createSap('sap-eu');
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    await markTested(c.ID);
    await POST(`${conn(c.ID)}/AdminService.activate`, {}, ADMIN);
    const r = await ok(POST(`${conn(c.ID)}/AdminService.clearCredential`, {}, ADMIN));
    expect(r.status).toBe(409);
    expect(code(r)).toBe('connection_active');
    expect(await getConnectionCredential(c.ID)).not.toBeNull();
    await POST(`${conn(c.ID)}/AdminService.deactivate`, {}, ADMIN);
    const cleared = await POST(`${conn(c.ID)}/AdminService.clearCredential`, {}, ADMIN);
    expect(cleared.status).toBe(200);
    expect(await getConnectionCredential(c.ID)).toBeNull();
  });

  it('a long SAP client id is stored (clientId holds 255 characters)', async () => {
    expect(cds.model.definitions[CONNS].elements.clientId.length).toBeGreaterThanOrEqual(255);
    const longId = `sb-${'a'.repeat(98)}!b12345|aicore!b540`;
    expect(longId.length).toBe(120);
    const c = await createSap('sap-eu');
    const r = await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey({ clientid: longId }) }, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data.clientId).toBe(longId);
    expect(JSON.parse((await getConnectionCredential(c.ID))!.secret).clientId).toBe(longId);
  });

  it('the SAP AI Core tenant key holds 100 characters (tenantId)', () => {
    expect(cds.model.definitions[CONNS].elements.tenantId.length).toBeGreaterThanOrEqual(100);
  });

  it('a rotated key needs its own passing test before activate', async () => {
    const c = await createSap('sap-eu');
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    await markTested(c.ID);
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey({ clientid: 'sb-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee!b999|aicore!b540' }) }, ADMIN);
    const row = await cds.run(cds.ql.SELECT.one.from(CONNS).columns('lastTestResult', 'lastTestAt').where({ ID: c.ID }));
    expect(row).toEqual({ lastTestResult: null, lastTestAt: null });
    const r = await ok(POST(`${conn(c.ID)}/AdminService.activate`, {}, ADMIN));
    expect(r.status).toBe(409);
    expect(code(r)).toBe('test_required');
  });

  // The test gate covers the target as it serves: what a test proved must not change under the active connection.
  const activeSap = async (name = 'sap-eu', extra: Record<string, any> = {}): Promise<any> => {
    const c = await createSap(name, extra);
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    await markTested(c.ID);
    await POST(`${conn(c.ID)}/AdminService.activate`, {}, ADMIN);
    return c;
  };
  const OTHER_CLIENT = 'sb-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee!b999|aicore!b540';
  const testState = (id: string) => cds.run(cds.ql.SELECT.one.from(CONNS).columns('lastTestResult', 'isActive', 'resourceGroup').where({ ID: id }));

  it('a PATCH of resourceGroup on the active connection → 409 connection_active, unchanged', async () => {
    const c = await activeSap();
    const r = await ok(PATCH(conn(c.ID), { resourceGroup: 'team-b' }, ADMIN));
    expect(r.status).toBe(409);
    expect(code(r)).toBe('connection_active');
    expect(r.data.error.message).toMatch(/Deactivate the connection first/);
    expect(await testState(c.ID)).toEqual({ lastTestResult: 'ok', isActive: true, resourceGroup: 'default' });
    // The same value, and the billing fields, still save.
    expect((await PATCH(conn(c.ID), { resourceGroup: 'default', priceRegion: 'EU' }, ADMIN)).status).toBe(200);
    expect(await testState(c.ID)).toEqual({ lastTestResult: 'ok', isActive: true, resourceGroup: 'default' });
  });

  it('a draft that changes the active connection\'s resourceGroup is not activated', async () => {
    const c = await activeSap();
    expect((await POST(`${conn(c.ID)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN)).status).toBe(201);
    await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=false)`, { resourceGroup: 'team-b' }, ADMIN);
    const r = await ok(POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN));
    expect(r.status).toBe(409);
    expect(code(r)).toBe('connection_active');
    expect(await testState(c.ID)).toEqual({ lastTestResult: 'ok', isActive: true, resourceGroup: 'default' });
  });

  it('a PATCH of resourceGroup on an inactive connection saves and resets the test result', async () => {
    const c = await createSap('sap-eu');
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    await markTested(c.ID);
    expect((await PATCH(conn(c.ID), { resourceGroup: 'team-b' }, ADMIN)).status).toBe(200);
    const row = await cds.run(cds.ql.SELECT.one.from(CONNS).columns('resourceGroup', 'lastTestResult', 'lastTestAt').where({ ID: c.ID }));
    expect(row).toEqual({ resourceGroup: 'team-b', lastTestResult: null, lastTestAt: null });
    expect(code(await ok(POST(`${conn(c.ID)}/AdminService.activate`, {}, ADMIN)))).toBe('test_required');
    // The same through the cockpit's draft.
    await markTested(c.ID);
    expect((await POST(`${conn(c.ID)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN)).status).toBe(201);
    await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=false)`, { resourceGroup: 'team-c' }, ADMIN);
    expect((await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN)).status).toBe(200);
    expect(await testState(c.ID)).toEqual({ lastTestResult: null, isActive: false, resourceGroup: 'team-c' });
  });

  it('setCredential on the active connection: a rotated key of the same tenant is taken, untested, still active', async () => {
    const c = await activeSap();
    const r = await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey({ clientid: OTHER_CLIENT }) }, ADMIN);
    expect(r.status).toBe(200);
    expect(await testState(c.ID)).toEqual({ lastTestResult: null, isActive: true, resourceGroup: 'default' });
    expect(JSON.parse((await getConnectionCredential(c.ID))!.secret).clientId).toBe(OTHER_CLIENT);
  });

  it('setCredential on the active connection: a key of another tenant → 409 tenant_mismatch, nothing changed', async () => {
    const c = await activeSap();
    for (const url of ['https://other-tenant.authentication.eu10.hana.ondemand.com', 'https://example-tenant.authentication.us10.hana.ondemand.com']) {
      const r = await ok(POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey({ clientid: OTHER_CLIENT, url }) }, ADMIN));
      expect(r.status).toBe(409);
      expect(code(r)).toBe('tenant_mismatch');
    }
    expect(await testState(c.ID)).toEqual({ lastTestResult: 'ok', isActive: true, resourceGroup: 'default' });
    expect(JSON.parse((await getConnectionCredential(c.ID))!.secret).clientId).toBe(CLIENT_ID);
    expect((await cds.run(cds.ql.SELECT.one.from(CONNS).columns('tenantId').where({ ID: c.ID }))).tenantId).toBe('example-tenant.eu10');
    expect(await cds.run(cds.ql.SELECT.from(TENANTS))).toHaveLength(1);
  });

  it('setCredential on an inactive connection takes a key of another tenant', async () => {
    const c = await createSap('sap-eu');
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    const r = await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey({ url: 'https://other-tenant.authentication.eu10.hana.ondemand.com' }) }, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data.tenantId).toBe('other-tenant.eu10');
  });

  it('endpoint, region, clientId and tenantId are server-owned: a create or PATCH does not set them', async () => {
    const owned = { endpoint: 'https://elsewhere.example.invalid', region: 'prod.ap-south-1', clientId: 'sb-forged', tenantId: 'forged.eu10' };
    const c = await createSap('sap-eu', owned);
    expect(await cds.run(cds.ql.SELECT.one.from(CONNS).columns('endpoint', 'region', 'clientId', 'tenantId').where({ ID: c.ID })))
      .toEqual({ endpoint: null, region: null, clientId: null, tenantId: null });
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    expect((await PATCH(conn(c.ID), { ...owned, title: 'EU tenant' }, ADMIN)).status).toBe(200);
    expect(await cds.run(cds.ql.SELECT.one.from(CONNS).columns('endpoint', 'region', 'clientId', 'tenantId', 'title').where({ ID: c.ID }))).toEqual({
      endpoint: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com', region: 'prod.eu-central-1', clientId: CLIENT_ID,
      tenantId: 'example-tenant.eu10', title: 'EU tenant',
    });
  });

  it('a direct POST /ConnectionModels for an sap-ai-core connection → 400 models_not_supported', async () => {
    const c = await createSap('sap-eu');
    const r = await ok(POST(`${S}/ConnectionModels`, { connection_ID: c.ID, upstreamModel: 'gpt-4o' }, ADMIN));
    expect(r.status).toBe(400);
    expect(code(r)).toBe('models_not_supported');
  });

  it('addModel → 400 models_not_supported', async () => {
    const c = await createSap('sap-eu');
    const r = await ok(POST(`${conn(c.ID)}/AdminService.addModel`, { upstreamModel: 'gpt-4o' }, ADMIN));
    expect(r.status).toBe(400);
    expect(code(r)).toBe('models_not_supported');
    const nav = await ok(POST(`${conn(c.ID)}/models`, { upstreamModel: 'gpt-4o' }, ADMIN));
    expect(nav.status).toBe(400);
  });

  it('the snapshot carries the resource group and the decrypted target JSON', async () => {
    const c = await createSap('sap-eu', { resourceGroup: 'team-a' });
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: serviceKey() }, ADMIN);
    const { connections } = await buildConnectionSnapshot();
    const s = connections.find((x) => x.id === c.ID)!;
    expect(s).toMatchObject({ name: 'sap-eu', providerType: 'sap-ai-core', isActive: false, models: [] });
    expect(s.settings).toMatchObject({ resourceGroup: 'team-a', endpoint: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com', region: 'prod.eu-central-1', tenantId: 'example-tenant.eu10' });
    expect(JSON.parse(s.credentials!.secret)).toMatchObject({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it('the price region has a value list of the distinct regions of the SAP CU prices (free entry stays)', async () => {
    const PRICES = 'sap.llm.gateway.admin.SapCapacityUnitPrice';
    await cds.run(cds.ql.DELETE.from(PRICES));
    const row = (region: string | null, usageType: string) => ({ dateFrom: '2026-01-01T00:00:00Z', dateTo: '9999-12-31T00:00:00Z', pricePerCu: 1, usageType, region });
    await cds.run(cds.ql.INSERT.into(PRICES).entries([row('EU', 'productive'), row('EU', 'non-productive'), row('JP', 'productive'), row(null, 'productive')]));
    const r = await GET(`${S}/ConnectionPriceRegions`, ADMIN);
    expect(r.data.value).toEqual([{ region: 'EU' }, { region: 'JP' }]);
    const md = String((await GET(`${S}/$metadata`, ADMIN)).data);
    const target = md.match(/<Annotations Target="AdminService\.ProviderConnections\/priceRegion">[\s\S]*?<\/Annotations>/)?.[0] ?? '';
    expect(target).toContain('Common.ValueList');
    expect(target).toContain('ConnectionPriceRegions');
    expect(target).not.toContain('ValueListWithFixedValues');
  });

  it('the provider type value list names SAP AI Core', async () => {
    const r = await GET(`${S}/ConnectionProviderTypes`, ADMIN);
    expect(r.data.value).toEqual(expect.arrayContaining([{ code: 'sap-ai-core', text: 'SAP AI Core' }]));
  });

  // A checkbox shows "not chosen" (null) exactly like "non-productive": the cockpit's draft starts at the
  // installation's classification (platform.billing.productive), so the usual case is one click; a direct create
  // still has to name it.
  it('a new SAP AI Core draft starts at the installation classification; other types and direct creates are untouched', async () => {
    (isProductive as jest.Mock).mockReturnValue(true);
    const prod = (await POST(`${S}/ProviderConnections`, { name: 'sap-draft-p', providerType: 'sap-ai-core' }, ADMIN)).data;
    expect([prod.IsActiveEntity, prod.productive]).toEqual([false, true]);
    (isProductive as jest.Mock).mockReturnValue(false);
    const nonProd = (await POST(`${S}/ProviderConnections`, { name: 'sap-draft-n', providerType: 'sap-ai-core' }, ADMIN)).data;
    expect(nonProd.productive).toBe(false);
    const chosen = (await POST(`${S}/ProviderConnections`, { name: 'sap-draft-c', providerType: 'sap-ai-core', productive: true }, ADMIN)).data;
    expect(chosen.productive).toBe(true);
    const other = (await POST(`${S}/ProviderConnections`, { name: 'oa-draft', providerType: 'openai' }, ADMIN)).data;
    expect(other.productive).toBeNull();
    const direct = await ok(POST(`${S}/ProviderConnections`, { name: 'sap-direct', providerType: 'sap-ai-core', IsActiveEntity: true }, ADMIN));
    expect(direct.status).toBe(400);
  });
});
