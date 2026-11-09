/**
 * Connections over OData (spec 2026-10-23 §4.1) end to end on cds.test(): admin-only CRUD of
 * ProviderConnections and their ConnectionModels, the name and type rules, the computed model id,
 * the SAP-id collision guard, no credential material on any read, an audit row per write, and the
 * Valkey change marker the gateway refetches on.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'cx-admin@test.com': { id: 'cx-admin@test.com', roles: ['admin', 'user'] },
  'cx-user@test.com': { id: 'cx-user@test.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), publish: jest.fn(async () => false), shutdown: jest.fn() } }));
jest.mock('../../../src/services/connectionsNotifier', () => ({
  CONNECTIONS_CHANGE_CHANNEL: 'test:connections-changed', publishConnectionsChanged: jest.fn(async () => true) }));

const { GET, POST, PATCH, DELETE } = cds.test(path.resolve(__dirname, '../../..'));
const { publishConnectionsChanged } = require('../../../src/services/connectionsNotifier');
import { setConnectionCredential } from '../../../src/services/connectionCredentialStore';

const ADMIN = { auth: { username: 'cx-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'cx-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const MODELS = 'sap.llm.gateway.admin.ConnectionModels';
const CREDS = 'sap.llm.gateway.admin.ConnectionCredentials';
const LIB = 'sap.llm.gateway.admin.LibraryModels';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const message = (r: any): string => String(r?.data?.error?.message ?? r?.data?.message ?? '');

async function createOpenAI(name = 'oa'): Promise<any> {
  const r = await POST(`${S}/ProviderConnections`, { name, providerType: 'openai', IsActiveEntity: true }, ADMIN);
  return r.data;
}

beforeEach(async () => {
  process.env.CONNECTION_CREDENTIAL_KEY = 'k'.repeat(64);
  const { DELETE: DEL } = cds.ql;
  await cds.run([DEL.from(CREDS), DEL.from(MODELS), DEL.from(CONNS), DEL.from(LIB), DEL.from(AUDIT)]);
  (publishConnectionsChanged as jest.Mock).mockClear();
});

describe('ProviderConnections', () => {
  it('admin creates an openai connection with defaults', async () => {
    const r = await POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai', IsActiveEntity: true }, ADMIN);
    expect(r.status).toBe(201);
    expect(r.data.baseUrl).toBe('https://api.openai.com/v1');
    expect(r.data.isActive).toBe(true);
  });

  it('anthropic gets its base URL and version defaults', async () => {
    const r = await POST(`${S}/ProviderConnections`, { name: 'an', providerType: 'anthropic', IsActiveEntity: true }, ADMIN);
    expect(r.data.baseUrl).toBe('https://api.anthropic.com');
    expect(r.data.anthropicVersion).toBe('2023-06-01');
  });

  it('user gets 403', async () => {
    expect((await ok(POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai', IsActiveEntity: true }, USER))).status).toBe(403);
    expect((await ok(GET(`${S}/ProviderConnections`, USER))).status).toBe(403);
  });

  it('invalid name → 400 naming the field', async () => {
    const r = await ok(POST(`${S}/ProviderConnections`, { name: 'Bad--Name', providerType: 'openai', IsActiveEntity: true }, ADMIN));
    expect(r.status).toBe(400);
    expect(message(r)).toMatch(/name/);
  });

  it('duplicate name → 409', async () => {
    await createOpenAI('oa');
    const r = await ok(POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'anthropic', IsActiveEntity: true }, ADMIN));
    expect(r.status).toBe(409);
  });

  it('name and providerType are immutable', async () => {
    const c = await createOpenAI();
    expect((await ok(PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { name: 'other' }, ADMIN))).status).toBe(400);
    expect((await ok(PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { providerType: 'anthropic' }, ADMIN))).status).toBe(400);
    expect((await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { title: 'OpenAI retail' }, ADMIN)).data.title).toBe('OpenAI retail');
  });

  it('an update is validated against the stored row', async () => {
    const r = await POST(`${S}/ProviderConnections`, { name: 'az', providerType: 'azure-openai', IsActiveEntity: true, endpoint: 'https://res.openai.azure.com' }, ADMIN);
    expect(r.data.apiMode).toBe('v1');
    expect(r.data.authMode).toBe('api-key');
    const bad = await ok(PATCH(`${S}/ProviderConnections(ID=${r.data.ID},IsActiveEntity=true)`, { apiMode: 'deployments' }, ADMIN));
    expect(bad.status).toBe(400);
    expect(message(bad)).toMatch(/apiVersion/);
  });

  it('the read-only status fields cannot be written', async () => {
    const c = await createOpenAI();
    await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { credentialHint: 'fake…hint', lastTestResult: 'ok' }, ADMIN);
    const row = await cds.run(cds.ql.SELECT.one.from(CONNS).where({ ID: c.ID }));
    expect(row.credentialHint).toBeNull();
    expect(row.lastTestResult).toBeNull();
  });
});

describe('ConnectionModels', () => {
  it('adds a model with the computed id and the type family', async () => {
    const c = await createOpenAI();
    const r = await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o-mini' }, ADMIN);
    expect(r.status).toBe(201);
    expect(r.data.modelId).toBe('gpt-4o-mini--oa');
    expect(r.data.family).toBe('openai');
    expect(r.data.isPublished).toBe(false);
  });

  it('ignores a client-sent modelId or isPublished', async () => {
    const c = await createOpenAI();
    const r = await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o', modelId: 'evil', isPublished: true }, ADMIN);
    expect(r.data.modelId).toBe('gpt-4o--oa');
    expect(r.data.isPublished).toBe(false);
    const p = await PATCH(`${S}/ConnectionModels(${r.data.ID})`, { isPublished: true, displayName: 'GPT-4o' }, ADMIN);
    expect(p.data.isPublished).toBe(false);
    expect(p.data.displayName).toBe('GPT-4o');
  });

  it('rejects an invalid upstream model and a changed one', async () => {
    const c = await createOpenAI();
    expect((await ok(POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'a/b' }, ADMIN))).status).toBe(400);
    const r = await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o' }, ADMIN);
    expect((await ok(PATCH(`${S}/ConnectionModels(${r.data.ID})`, { upstreamModel: 'gpt-4.1' }, ADMIN))).status).toBe(400);
  });

  it('rejects an unknown family', async () => {
    const c = await createOpenAI();
    expect((await ok(POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o', family: 'gemini' }, ADMIN))).status).toBe(400);
  });

  it('a model id colliding with an SAP Library row → 409', async () => {
    const c = await createOpenAI();
    await cds.run(cds.ql.INSERT.into(LIB).entries({ modelId: 'x--oa', origin: 'sap' }));
    expect((await ok(POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'x' }, ADMIN))).status).toBe(409);
  });

  it('a duplicate model id → 409', async () => {
    const c = await createOpenAI();
    await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o' }, ADMIN);
    expect((await ok(POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o' }, ADMIN))).status).toBe(409);
  });
});

describe('models are written through their own entity only', () => {
  it('a deep PATCH of a connection with models → 400, the model unchanged', async () => {
    const c = await createOpenAI();
    const m = (await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    const r = await ok(PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { models: [{ ID: m.ID, upstreamModel: 'other', family: 'zzz' }] }, ADMIN));
    expect(r.status).toBe(400);
    expect(message(r)).toMatch(/models/);
    const row = await cds.run(cds.ql.SELECT.one.from(MODELS).where({ ID: m.ID }));
    expect(row).toMatchObject({ upstreamModel: 'gpt-4o-mini', family: 'openai', modelId: 'gpt-4o-mini--oa' });
  });

  it('a deep POST of a connection with models → 400, nothing created', async () => {
    const r = await ok(POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai', IsActiveEntity: true, models: [{ upstreamModel: 'gpt-4o' }] }, ADMIN));
    expect(r.status).toBe(400);
    expect(await cds.run(cds.ql.SELECT.from(CONNS))).toHaveLength(0);
  });
});

describe('no credential material on reads', () => {
  it('neither $select=* nor $expand returns ciphertext', async () => {
    const c = await createOpenAI();
    await setConnectionCredential(c.ID, { secret: 'sk-test-0123456789abcdef' }, 'cx-admin@test.com');
    await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o' }, ADMIN);
    const r = await GET(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)?$select=*&$expand=models`, ADMIN);
    const body = JSON.stringify(r.data);
    for (const k of ['ciphertext', '"iv"', '"salt"', 'authTag', '"credential"', 'sk-test-0123456789abcdef']) expect(body).not.toContain(k);
    expect(r.data.credentialHint).toBe('sk-t…cdef');
    expect((await ok(GET(`${S}/ConnectionCredentials`, ADMIN))).status).toBe(404);
  });
});

describe('side effects of writes', () => {
  it('every write publishes the change marker', async () => {
    const c = await createOpenAI();
    const m = await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o' }, ADMIN);
    await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { title: 'x' }, ADMIN);
    await PATCH(`${S}/ConnectionModels(${m.data.ID})`, { displayName: 'y' }, ADMIN);
    await DELETE(`${S}/ConnectionModels(${m.data.ID})`, ADMIN);
    await DELETE(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, ADMIN);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(6);
  });

  it('a refused write publishes nothing', async () => {
    await ok(POST(`${S}/ProviderConnections`, { name: 'BAD', providerType: 'openai', IsActiveEntity: true }, ADMIN));
    expect(publishConnectionsChanged).not.toHaveBeenCalled();
  });

  it('every write is audited, with field names only', async () => {
    const c = await createOpenAI();
    await PATCH(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, { title: 'Secret-looking title' }, ADMIN);
    await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o' }, ADMIN);
    const rows = await cds.run(cds.ql.SELECT.from(AUDIT).columns('action', 'resourceType', 'details'));
    expect(rows.map((r: any) => r.action).sort()).toEqual(['connection.create', 'connection.model.create', 'connection.update']);
    expect(rows.every((r: any) => r.resourceType === 'ProviderConnection')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('Secret-looking title');
  });

  it('deleting a connection deletes its models and credential row', async () => {
    const c = await createOpenAI();
    await setConnectionCredential(c.ID, { secret: 'sk-test-0123456789abcdef' }, 'a');
    await POST(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)/models`, { upstreamModel: 'gpt-4o' }, ADMIN);
    await DELETE(`${S}/ProviderConnections(ID=${c.ID},IsActiveEntity=true)`, ADMIN);
    expect(await cds.run(cds.ql.SELECT.from(MODELS))).toHaveLength(0);
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(0);
  });
});
