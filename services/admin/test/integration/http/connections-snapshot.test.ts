/**
 * ValidationService.getConnections() (spec 2026-10-23 §4.2): the one way connection credentials
 * leave the admin - decrypted, to the gateway only, proven by its service JWT. All connections
 * (with isActive) and published models only; `priced` says whether a list price is in force.
 */
import path from 'path';
import jwt from 'jsonwebtoken';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'cs-admin@test.com': { id: 'cs-admin@test.com', roles: ['admin', 'user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), publish: jest.fn(async () => false), shutdown: jest.fn() } }));

const { GET } = cds.test(path.resolve(__dirname, '../../..'));
import { setConnectionCredential } from '../../../src/services/connectionCredentialStore';
import { buildConnectionSnapshot } from '../../../src/services/connectionSnapshot';

const SECRET_KEY = 'f'.repeat(64);
const URL = '/odata/v4/validation/getConnections()';
const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const MODELS = 'sap.llm.gateway.admin.ConnectionModels';
const CREDS = 'sap.llm.gateway.admin.ConnectionCredentials';
const COSTS = 'sap.llm.gateway.admin.ModelCosts';
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const gateway = () => ({ headers: { Authorization: `Bearer ${jwt.sign({ service: 'gateway' }, SECRET_KEY, { algorithm: 'HS256', issuer: 'gateway-service', expiresIn: '5m' })}` } });
const ADMIN = { auth: { username: 'cs-admin@test.com', password: 'x' } };

async function connection(name: string, extra: Record<string, any> = {}): Promise<string> {
  const ID = cds.utils.uuid();
  await cds.run(cds.ql.INSERT.into(CONNS).entries({ ID, name, providerType: 'openai', baseUrl: 'https://api.openai.com/v1', isActive: true, ...extra }));
  return ID;
}
async function model(connectionId: string, upstreamModel: string, name: string, isPublished = true): Promise<string> {
  const modelId = `${upstreamModel}--${name}`;
  await cds.run(cds.ql.INSERT.into(MODELS).entries({ connection_ID: connectionId, upstreamModel, modelId, family: 'openai', capabilities: '["chat","streaming"]', isPublished }));
  return modelId;
}
async function price(modelId: string, pricingKind = 'list_price', dateTo = '9999-12-31T00:00:00.000Z'): Promise<void> {
  await cds.run(cds.ql.INSERT.into(COSTS).entries({ model: modelId, dateFrom: '2026-01-01T00:00:00.000Z', dateTo, inputCost: 1, outputCost: 2, pricingKind, currency: pricingKind === 'list_price' ? 'USD' : null }));
}

beforeEach(async () => {
  process.env.VALIDATION_TOKEN_SECRET = SECRET_KEY;
  process.env.CONNECTION_CREDENTIAL_KEY = 'k'.repeat(64);
  const { DELETE: DEL } = cds.ql;
  await cds.run([DEL.from(CREDS), DEL.from(MODELS), DEL.from(CONNS), DEL.from(COSTS)]);
});

describe('getConnections()', () => {
  it('refuses a caller without the gateway service JWT', async () => {
    expect((await ok(GET(URL))).status).toBe(403);
    expect((await ok(GET(URL, ADMIN))).status).toBe(403);
    const forged = jwt.sign({ service: 'gateway' }, 'not-the-secret', { algorithm: 'HS256', issuer: 'gateway-service' });
    expect((await ok(GET(URL, { headers: { Authorization: `Bearer ${forged}` } }))).status).toBe(403);
  });

  it('hands the gateway active connections with decrypted credentials and published models', async () => {
    const id = await connection('oa', { organization: 'org-1' });
    await setConnectionCredential(id, { secret: 'sk-test-0123456789abcdef' }, 'a');
    const modelId = await model(id, 'gpt-4o-mini', 'oa');
    await price(modelId);
    const r = await GET(URL, gateway());
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    const [c] = r.data.snapshot.connections;
    expect(c).toMatchObject({ id, name: 'oa', providerType: 'openai', credentials: { secret: 'sk-test-0123456789abcdef' } });
    expect(c.settings.baseUrl).toBe('https://api.openai.com/v1');
    expect(c.settings.organization).toBe('org-1');
    expect(c.settings.endpoint).toBeNull();
    expect(c.models).toEqual([{ modelId, upstreamModel: 'gpt-4o-mini', displayName: null, family: 'openai', capabilities: ['chat', 'streaming'], priced: true }]);
  });

  it('leaves out an unpublished model', async () => {
    const id = await connection('oa');
    await model(id, 'gpt-4o', 'oa', false);
    const { connections } = await buildConnectionSnapshot();
    expect(connections.map((c) => c.name)).toEqual(['oa']);
    expect(connections[0].models).toEqual([]);
  });

  it('lists an inactive connection with isActive false and its published models, so the gateway can answer 503', async () => {
    const off = await connection('off', { isActive: false });
    const offModel = await model(off, 'gpt-4o', 'off');
    await price(offModel);
    const on = await connection('on');
    await price(await model(on, 'gpt-4o', 'on'));
    const { connections } = await buildConnectionSnapshot();
    expect(connections.map((c) => [c.name, c.isActive])).toEqual([['off', false], ['on', true]]);
    expect(connections[0].models.map((m) => m.modelId)).toEqual([offModel]);
  });

  it('priced follows the list price in force, and an SAP-kind row does not count', async () => {
    const id = await connection('oa');
    const a = await model(id, 'gpt-4o', 'oa');
    const b = await model(id, 'gpt-4o-mini', 'oa');
    await price(a, 'list_price', '2026-12-31T00:00:00.000Z');
    await price(b, 'sap_genai');
    const now = await buildConnectionSnapshot(new Date('2026-10-24T00:00:00Z'));
    expect(Object.fromEntries(now.connections[0].models.map((m) => [m.modelId, m.priced]))).toEqual({ [a]: true, [b]: false });
    const later = await buildConnectionSnapshot(new Date('2027-01-01T00:00:00Z'));
    expect(later.connections[0].models.find((m) => m.modelId === a)!.priced).toBe(false);
  });

  it('an undecryptable credential yields credentials null, not an error', async () => {
    const id = await connection('oa');
    await setConnectionCredential(id, { secret: 'sk-test-0123456789abcdef' }, 'a');
    process.env.CONNECTION_CREDENTIAL_KEY = 'z'.repeat(64);
    const r = await GET(URL, gateway());
    expect(r.status).toBe(200);
    expect(r.data.snapshot.connections[0].credentials).toBeNull();
  });

  it('a connection without a credential is listed with credentials null', async () => {
    await connection('oa');
    expect((await buildConnectionSnapshot()).connections[0].credentials).toBeNull();
  });
});
