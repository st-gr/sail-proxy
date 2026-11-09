/**
 * Connection actions (spec 2026-10-23 §4.1, §6.1) on cds.test(): the write-only credential, the
 * list price in the installation currency (a temporal ModelCosts row of pricingKind list_price),
 * and publishing, which needs an active list price ("no price, no inference").
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'ca-admin@test.com': { id: 'ca-admin@test.com', roles: ['admin', 'user'] },
  'ca-user@test.com': { id: 'ca-user@test.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), publish: jest.fn(async () => false), shutdown: jest.fn() } }));
jest.mock('../../../src/services/connectionsNotifier', () => ({
  CONNECTIONS_CHANGE_CHANNEL: 'test:connections-changed', publishConnectionsChanged: jest.fn(async () => true) }));
jest.mock('../../../src/services/userQuotaService', () => ({
  ...jest.requireActual('../../../src/services/userQuotaService'),
  quotaCurrency: jest.fn(async () => 'EUR') }));

const { POST } = cds.test(path.resolve(__dirname, '../../..'));
const { publishConnectionsChanged } = require('../../../src/services/connectionsNotifier');
import { getConnectionCredential } from '../../../src/services/connectionCredentialStore';

const ADMIN = { auth: { username: 'ca-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'ca-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const MODELS = 'sap.llm.gateway.admin.ConnectionModels';
const CREDS = 'sap.llm.gateway.admin.ConnectionCredentials';
const COSTS = 'sap.llm.gateway.admin.ModelCosts';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const SECRET = 'sk-test-0123456789abcdef';
const message = (r: any): string => String(r?.data?.error?.message ?? r?.data?.message ?? '');
const conn = (id: string) => `${S}/ProviderConnections(ID=${id},IsActiveEntity=true)`;
const model = (id: string) => `${S}/ConnectionModels(${id})`;

let c: any;
let m: any;

beforeEach(async () => {
  process.env.CONNECTION_CREDENTIAL_KEY = 'k'.repeat(64);
  const { DELETE: DEL } = cds.ql;
  await cds.run([DEL.from(CREDS), DEL.from(MODELS), DEL.from(CONNS), DEL.from(COSTS), DEL.from(AUDIT)]);
  c = (await POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai', IsActiveEntity: true }, ADMIN)).data;
  m = (await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
  (publishConnectionsChanged as jest.Mock).mockClear();
});

const activeRows = async () => cds.run(cds.ql.SELECT.from(COSTS).where({ model: 'gpt-4o-mini--oa' }).and({ dateTo: { '>': new Date().toISOString() } }));

describe('setCredential / clearCredential', () => {
  it('stores the secret and answers with the hint, never the value', async () => {
    const r = await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: SECRET }, ADMIN);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toContain(SECRET);
    expect(r.data.credentialHint).toBe('sk-t…cdef');
    expect(await getConnectionCredential(c.ID)).toEqual({ secret: SECRET });
  });

  it('without the key: 503 naming CONNECTION_CREDENTIAL_KEY, nothing stored', async () => {
    delete process.env.CONNECTION_CREDENTIAL_KEY;
    const r = await ok(POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: SECRET }, ADMIN));
    expect(r.status).toBe(503);
    expect(message(r)).toContain('CONNECTION_CREDENTIAL_KEY');
    // The cockpit maps the code to its own text.
    expect(r.data.error.code).toBe('credential_key_missing');
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(0);
  });

  it('an empty secret → 400', async () => {
    const r = await ok(POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: '  ' }, ADMIN));
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('secret_required');
  });

  it('a session token on an openai connection → 400', async () => {
    const r = await ok(POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: SECRET, sessionToken: 't' }, ADMIN));
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('session_token_not_applicable');
  });

  it('an unknown connection → 404 connection_not_found', async () => {
    const r = await ok(POST(`${conn(cds.utils.uuid())}/AdminService.setCredential`, { secret: SECRET }, ADMIN));
    expect(r.status).toBe(404);
    expect(r.data.error.code).toBe('connection_not_found');
  });

  it('a session token on a bedrock access-key connection is kept', async () => {
    const b = (await POST(`${S}/ProviderConnections`, { name: 'br', providerType: 'bedrock', IsActiveEntity: true, region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE' }, ADMIN)).data;
    await POST(`${conn(b.ID)}/AdminService.setCredential`, { secret: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', sessionToken: 'tok' }, ADMIN);
    expect(await getConnectionCredential(b.ID)).toEqual({ secret: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', sessionToken: 'tok' });
  });

  it('the audit row names the connection only', async () => {
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: SECRET }, ADMIN);
    const rows = await cds.run(cds.ql.SELECT.from(AUDIT).where({ action: 'connection.credential.set' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('high');
    expect(JSON.parse(rows[0].details)).toEqual({ connection: 'oa' });
  });

  it('clearCredential removes it', async () => {
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: SECRET }, ADMIN);
    const r = await POST(`${conn(c.ID)}/AdminService.clearCredential`, {}, ADMIN);
    expect(r.data.credentialHint).toBeNull();
    expect(await getConnectionCredential(c.ID)).toBeNull();
  });
});

describe('setListPrice', () => {
  it('writes one active list_price row in the installation currency', async () => {
    const r = await POST(`${model(m.ID)}/AdminService.setListPrice`, { inputCost: 0.00015, outputCost: 0.0006 }, ADMIN);
    expect(r.status).toBe(200);
    const rows = await activeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pricingKind: 'list_price', currency: 'EUR', source: 'manual', provider: 'openai' });
    expect(Number(rows[0].inputCost)).toBeCloseTo(0.00015);
    expect(Number(rows[0].outputCost)).toBeCloseTo(0.0006);
  });

  it('keeps an explicit currency and the cache costs', async () => {
    await POST(`${model(m.ID)}/AdminService.setListPrice`, { inputCost: 1, outputCost: 2, cacheReadCost: 0.1, cacheCreationCost: 1.25, currency: 'USD' }, ADMIN);
    const [row] = await activeRows();
    expect(row.currency).toBe('USD');
    expect(Number(row.cacheReadInputCost)).toBeCloseTo(0.1);
    expect(Number(row.cacheCreationInputCost)).toBeCloseTo(1.25);
  });

  it('a second price closes the first', async () => {
    await POST(`${model(m.ID)}/AdminService.setListPrice`, { inputCost: 1, outputCost: 2 }, ADMIN);
    await POST(`${model(m.ID)}/AdminService.setListPrice`, { inputCost: 3, outputCost: 4 }, ADMIN);
    const rows = await activeRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].inputCost)).toBe(3);
    expect(await cds.run(cds.ql.SELECT.from(COSTS).where({ model: 'gpt-4o-mini--oa' }))).toHaveLength(2);
  });

  it.each([
    [{ inputCost: -1, outputCost: 1 }],
    [{ outputCost: 1 }],
    [{ inputCost: 1, outputCost: 1, cacheReadCost: -0.1 }],
    [{ inputCost: 1, outputCost: 1, currency: 'eur' }],
  ])('rejects %p with 400', async (body) => {
    expect((await ok(POST(`${model(m.ID)}/AdminService.setListPrice`, body, ADMIN))).status).toBe(400);
  });
});

describe('publish / unpublish', () => {
  it('publish without a price → 409 model_unpriced', async () => {
    const r = await ok(POST(`${model(m.ID)}/AdminService.publish`, {}, ADMIN));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.data)).toContain('model_unpriced');
  });

  it('an SAP-kind price row does not count', async () => {
    await cds.run(cds.ql.INSERT.into(COSTS).entries({ model: 'gpt-4o-mini--oa', dateFrom: '2026-01-01T00:00:00Z', dateTo: '9999-12-31T00:00:00Z', inputCost: 1, outputCost: 1, pricingKind: 'sap_genai' }));
    expect((await ok(POST(`${model(m.ID)}/AdminService.publish`, {}, ADMIN))).status).toBe(409);
  });

  it('publish after setListPrice, then unpublish', async () => {
    await POST(`${model(m.ID)}/AdminService.setListPrice`, { inputCost: 1, outputCost: 2 }, ADMIN);
    expect((await POST(`${model(m.ID)}/AdminService.publish`, {}, ADMIN)).data.isPublished).toBe(true);
    expect((await POST(`${model(m.ID)}/AdminService.unpublish`, {}, ADMIN)).data.isPublished).toBe(false);
  });
});

describe('authorization and the change marker', () => {
  it.each([
    ['ProviderConnections', 'setCredential', { secret: SECRET }],
    ['ProviderConnections', 'clearCredential', {}],
    ['ConnectionModels', 'setListPrice', { inputCost: 1, outputCost: 1 }],
    ['ConnectionModels', 'publish', {}],
    ['ConnectionModels', 'unpublish', {}],
  ])('a user calling %s/%s → 403', async (entity, action, body) => {
    const key = entity === 'ProviderConnections' ? `ID=${c.ID},IsActiveEntity=true` : m.ID;
    expect((await ok(POST(`${S}/${entity}(${key})/AdminService.${action}`, body, USER))).status).toBe(403);
  });

  it('each action publishes the change marker', async () => {
    await POST(`${conn(c.ID)}/AdminService.setCredential`, { secret: SECRET }, ADMIN);
    await POST(`${conn(c.ID)}/AdminService.clearCredential`, {}, ADMIN);
    await POST(`${model(m.ID)}/AdminService.setListPrice`, { inputCost: 1, outputCost: 2 }, ADMIN);
    await POST(`${model(m.ID)}/AdminService.publish`, {}, ADMIN);
    await POST(`${model(m.ID)}/AdminService.unpublish`, {}, ADMIN);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(5);
  });
});
