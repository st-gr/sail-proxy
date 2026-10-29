/**
 * Connections through the Fiori Elements draft (spec 2026-10-23 §7): ProviderConnections is
 * draft-enabled and activation runs the connection rules of sub-project A (validation, defaults,
 * name clash, audit, change marker). Models stay outside the draft: they are an association of the
 * projection, written through ConnectionModels only. ConnectionProviderTypes is the type value list.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'cd-admin@test.com': { id: 'cd-admin@test.com', roles: ['admin', 'user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), publish: jest.fn(async () => false), shutdown: jest.fn() } }));
jest.mock('../../../src/services/connectionsNotifier', () => ({
  CONNECTIONS_CHANGE_CHANNEL: 'test:connections-changed', publishConnectionsChanged: jest.fn(async () => true) }));
jest.mock('../../../src/services/auditEventService', () => ({
  ...jest.requireActual('../../../src/services/auditEventService'),
  recordAuditEvent: jest.fn(async () => undefined) }));
jest.mock('../../../src/services/userQuotaService', () => ({
  ...jest.requireActual('../../../src/services/userQuotaService'),
  quotaCurrency: jest.fn(async () => 'USD') }));

const { GET, POST, PATCH, DELETE } = cds.test(path.resolve(__dirname, '../../..'));
const { publishConnectionsChanged } = require('../../../src/services/connectionsNotifier');
const { recordAuditEvent } = require('../../../src/services/auditEventService');
const { quotaCurrency } = require('../../../src/services/userQuotaService');

const ADMIN = { auth: { username: 'cd-admin@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const MODELS = 'sap.llm.gateway.admin.ConnectionModels';
const CREDS = 'sap.llm.gateway.admin.ConnectionCredentials';
const COSTS = 'sap.llm.gateway.admin.ModelCosts';
const DRAFTS = 'AdminService.ProviderConnections.drafts';
const conn = (id: string, active = true) => `${S}/ProviderConnections(ID=${id},IsActiveEntity=${active})`;
const message = (r: any): string => String(r?.data?.error?.message ?? r?.data?.message ?? '');
const audited = (action: string): any[] => (recordAuditEvent as jest.Mock).mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.action === action);

/** The Fiori create flow: POST makes a draft, draftActivate makes it the active connection. */
async function createThroughDraft(data: Record<string, any>): Promise<{ draft: any; activated: any }> {
  const draft = await POST(`${S}/ProviderConnections`, data, ADMIN);
  const activated = await ok(POST(`${conn(draft.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN));
  return { draft, activated };
}

beforeEach(async () => {
  process.env.CONNECTION_CREDENTIAL_KEY = 'k'.repeat(64);
  const { DELETE: DEL } = cds.ql;
  await cds.run([DEL.from(CREDS), DEL.from(MODELS), DEL.from(COSTS), DEL.from(CONNS), DEL.from(DRAFTS)]);
  (publishConnectionsChanged as jest.Mock).mockClear();
  (recordAuditEvent as jest.Mock).mockClear();
  (quotaCurrency as jest.Mock).mockResolvedValue('USD');
});

describe('draft-enabled ProviderConnections', () => {
  it('a connection created through a draft is validated, audited and announced on activation', async () => {
    const draft = await POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai' }, ADMIN);
    expect(draft.status).toBe(201);
    expect(draft.data.IsActiveEntity).toBe(false);
    const activated = await POST(`${conn(draft.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN);
    expect([200, 201]).toContain(activated.status);
    const row = await cds.run(cds.ql.SELECT.one.from(CONNS).where({ ID: draft.data.ID }));
    expect(row).toMatchObject({ name: 'oa', providerType: 'openai', baseUrl: 'https://api.openai.com/v1' });
    expect(audited('connection.create')).toHaveLength(1);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(1);
  });

  it('an invalid draft is refused at activation and stays a draft', async () => {
    const { draft, activated } = await createThroughDraft({ name: 'az', providerType: 'azure-openai', endpoint: 'ftp://x' });
    expect(activated.status).toBe(400);
    expect(message(activated)).toContain('endpoint must be an https URL');
    expect(await cds.run(cds.ql.SELECT.one.from(DRAFTS).where({ ID: draft.data.ID }))).toBeTruthy();
    expect(await cds.run(cds.ql.SELECT.from(CONNS))).toHaveLength(0);
    expect(recordAuditEvent).not.toHaveBeenCalled();
    expect(publishConnectionsChanged).not.toHaveBeenCalled();
  });

  it('a second connection with the same name is refused at activation', async () => {
    expect([200, 201]).toContain((await createThroughDraft({ name: 'oa', providerType: 'openai' })).activated.status);
    const { activated } = await createThroughDraft({ name: 'oa', providerType: 'anthropic' });
    expect(activated.status).toBe(409);
    expect(await cds.run(cds.ql.SELECT.from(CONNS))).toHaveLength(1);
  });

  it('name and providerType cannot change on an existing connection', async () => {
    const { draft } = await createThroughDraft({ name: 'oa', providerType: 'openai' });
    const id = draft.data.ID;
    expect((await POST(`${conn(id)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN)).status).toBe(201);
    // Core.Immutable: cds drops both fields from a draft PATCH without an error (Fiori Elements asks
    // for them in its create dialog and sends them with the POST, never in a PATCH).
    await ok(PATCH(conn(id, false), { name: 'other' }, ADMIN));
    await ok(PATCH(conn(id, false), { providerType: 'anthropic' }, ADMIN));
    expect(await cds.run(cds.ql.SELECT.one.from(DRAFTS).columns('name', 'providerType').where({ ID: id }))).toEqual({ name: 'oa', providerType: 'openai' });
    expect((await PATCH(conn(id, false), { title: 'OpenAI retail' }, ADMIN)).status).toBe(200);
    (recordAuditEvent as jest.Mock).mockClear();
    expect((await POST(`${conn(id, false)}/AdminService.draftActivate`, {}, ADMIN)).status).toBe(200);
    const row = await cds.run(cds.ql.SELECT.one.from(CONNS).where({ ID: id }));
    expect(row).toMatchObject({ name: 'oa', providerType: 'openai', title: 'OpenAI retail' });
    // The draft hands the whole row to activation; the audit names the fields that changed only.
    const update = audited('connection.update');
    expect(update).toHaveLength(1);
    expect(JSON.parse(update[0].details).fields).toEqual(['title']);
  });

  it('models are not part of the draft', async () => {
    const md = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    const modelsType = /<EntityType Name="ConnectionModels">[\s\S]*?<\/EntityType>/.exec(md)?.[0] ?? '';
    expect(modelsType).not.toBe('');
    expect(modelsType).not.toContain('IsActiveEntity');
    expect(md).not.toMatch(/EntitySet Name="ConnectionModels"[^>]*>[\s\S]{0,400}?draftActivate/);
    const connType = /<EntityType Name="ProviderConnections">[\s\S]*?<\/EntityType>/.exec(md)?.[0] ?? '';
    expect(connType).toContain('IsActiveEntity');
    const nav = /<NavigationProperty Name="models"[^>]*\/?>/.exec(connType)?.[0] ?? '';
    expect(nav).toContain('Type="Collection(AdminService.ConnectionModels)"');
    expect(nav).not.toContain('ContainsTarget');

    const { draft } = await createThroughDraft({ name: 'oa', providerType: 'openai' });
    const id = draft.data.ID;
    const m = await POST(`${S}/ConnectionModels`, { connection_ID: id, upstreamModel: 'gpt-4o-mini' }, ADMIN);
    expect(m.status).toBe(201);
    const before = await cds.run(cds.ql.SELECT.one.from(MODELS).where({ ID: m.data.ID }));
    await POST(`${conn(id)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    await PATCH(conn(id, false), { title: 'x' }, ADMIN);
    expect((await POST(`${conn(id, false)}/AdminService.draftActivate`, {}, ADMIN)).status).toBe(200);
    expect(await cds.run(cds.ql.SELECT.one.from(MODELS).where({ ID: m.data.ID }))).toEqual(before);
    const read = await GET(`${conn(id)}?$expand=models`, ADMIN);
    expect(read.data.models.map((x: any) => x.modelId)).toEqual(['gpt-4o-mini--oa']);
  });

  it('connection actions refuse a draft', async () => {
    const fresh = await POST(`${S}/ProviderConnections`, { name: 'nd', providerType: 'openai' }, ADMIN);
    const onNew = await ok(POST(`${conn(fresh.data.ID, false)}/AdminService.setCredential`, { secret: 'sk-test-0123456789abcdef' }, ADMIN));
    expect(onNew.status).toBe(400);

    const { draft } = await createThroughDraft({ name: 'oa', providerType: 'openai' });
    const id = draft.data.ID;
    await POST(`${conn(id)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    const onEdit = await ok(POST(`${conn(id, false)}/AdminService.setCredential`, { secret: 'sk-test-0123456789abcdef' }, ADMIN));
    expect(onEdit.status).toBe(400);
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(0);

    expect((await POST(`${conn(id)}/AdminService.setCredential`, { secret: 'sk-test-0123456789abcdef' }, ADMIN)).status).toBe(200);
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(1);
  });

  it.each([
    ['setCredential', { secret: 'sk-test-0123456789abcdef' }],
    ['clearCredential', {}],
    ['testConnection', {}],
    ['fetchModels', {}],
    ['addModel', { upstreamModel: 'gpt-4o' }],
  ])('%s on a draft key answers 400 and changes nothing', async (action, body) => {
    const draft = await POST(`${S}/ProviderConnections`, { name: 'dk', providerType: 'openai' }, ADMIN);
    const r = await ok(POST(`${conn(draft.data.ID, false)}/AdminService.${action}`, body, ADMIN));
    expect(r.status).toBe(400);
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(0);
    expect(await cds.run(cds.ql.SELECT.from(MODELS))).toHaveLength(0);
  });

  it('a key without IsActiveEntity is refused', async () => {
    const { draft } = await createThroughDraft({ name: 'bk', providerType: 'openai' });
    const bare = `${S}/ProviderConnections(${draft.data.ID})`;
    expect((await ok(GET(bare, ADMIN))).status).toBe(400);
    expect((await ok(PATCH(bare, { title: 'x' }, ADMIN))).status).toBe(400);
  });

  it('connection actions are offered on the active entity only', async () => {
    const md = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    for (const action of ['setCredential', 'clearCredential', 'testConnection', 'fetchModels']) {
      const block = new RegExp(`<Annotations Target="AdminService\\.${action}\\(AdminService\\.ProviderConnections\\)">[\\s\\S]*?</Annotations>`).exec(md)?.[0] ?? '';
      expect(block).toContain('Term="Core.OperationAvailable"');
      expect(block).toContain('<Path>in/IsActiveEntity</Path>');
    }
  });

  it('ConnectionProviderTypes lists the five types', async () => {
    const r = await GET(`${S}/ConnectionProviderTypes`, ADMIN);
    expect(r.data.value.map((t: any) => t.code).sort()).toEqual(['anthropic', 'azure-openai', 'bedrock', 'openai', 'sap-ai-core']);
    for (const t of r.data.value) expect(String(t.text || '').length).toBeGreaterThan(0);
    const md = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    const vl = /<Annotations Target="AdminService\.ProviderConnections\/providerType">[\s\S]*?<\/Annotations>/.exec(md)?.[0] ?? '';
    expect(vl).toContain('ConnectionProviderTypes');
    expect(vl).toContain('Common.ValueListWithFixedValues');
  });

  it('apiMode and authMode have fixed value lists; authMode follows the provider type', async () => {
    expect((await GET(`${S}/ConnectionApiModes`, ADMIN)).data.value.map((t: any) => t.code).sort()).toEqual(['deployments', 'v1']);
    const all = (await GET(`${S}/ConnectionAuthModes`, ADMIN)).data.value;
    expect(all.map((t: any) => t.code).sort()).toEqual(['access-key', 'api-key', 'bearer', 'entra-client-secret']);
    for (const t of all) expect(String(t.text || '').length).toBeGreaterThan(0);
    const azure = (await GET(`${S}/ConnectionAuthModes?$filter=providerType eq 'azure-openai'`, ADMIN)).data.value;
    expect(azure.map((t: any) => t.code).sort()).toEqual(['api-key', 'entra-client-secret']);
    const md = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    for (const [field, list] of [['apiMode', 'ConnectionApiModes'], ['authMode', 'ConnectionAuthModes']]) {
      const vl = new RegExp(`<Annotations Target="AdminService\\.ProviderConnections/${field}">[\\s\\S]*?</Annotations>`).exec(md)?.[0] ?? '';
      expect(vl).toContain(list);
      expect(vl).toContain('Common.ValueListWithFixedValues');
    }
  });

  it('a connection and its draft show the provider type\'s text; activation ignores the virtuals', async () => {
    const { draft } = await createThroughDraft({ name: 'br', providerType: 'bedrock', region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE' });
    expect((await GET(conn(draft.data.ID), ADMIN)).data.providerTypeText).toBe('Amazon Bedrock');
    // The object page header may ask for the text alone.
    expect((await GET(`${conn(draft.data.ID)}?$select=providerTypeText`, ADMIN)).data.providerTypeText).toBe('Amazon Bedrock');
    await POST(`${conn(draft.data.ID)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    expect((await GET(conn(draft.data.ID, false), ADMIN)).data).toMatchObject({ providerTypeText: 'Amazon Bedrock', publishedModels: 0 });
    expect((await POST(`${conn(draft.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN)).status).toBe(200);
  });

  it('direct POST on the active entity still works', async () => {
    // A plain POST is the Fiori create: lean draft turns it into a new draft (IsActiveEntity false).
    const plain = await POST(`${S}/ProviderConnections`, { name: 'pl', providerType: 'openai' }, ADMIN);
    expect(plain.data.IsActiveEntity).toBe(false);
    expect(await cds.run(cds.ql.SELECT.from(CONNS))).toHaveLength(0);
    // A script states IsActiveEntity true and writes the active row directly, through the same rules.
    const direct = await POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai', IsActiveEntity: true }, ADMIN);
    expect(direct.status).toBe(201);
    expect(direct.data).toMatchObject({ IsActiveEntity: true, baseUrl: 'https://api.openai.com/v1' });
    expect(audited('connection.create')).toHaveLength(1);
    const patched = await PATCH(conn(direct.data.ID), { title: 'Direct' }, ADMIN);
    expect(patched.data.title).toBe('Direct');
    expect(audited('connection.update')).toHaveLength(1);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(2);
    // A direct PATCH of an immutable field is still refused with A's message, not silently dropped.
    const renamed = await ok(PATCH(conn(direct.data.ID), { name: 'other' }, ADMIN));
    expect(renamed.status).toBe(400);
    expect(message(renamed)).toContain('name cannot be changed after creation');
    expect((await ok(PATCH(conn(direct.data.ID), { providerType: 'anthropic' }, ADMIN))).status).toBe(400);
    expect((await ok(POST(`${S}/ProviderConnections`, { name: 'BAD', providerType: 'openai', IsActiveEntity: true }, ADMIN))).status).toBe(400);
  });
});

describe('model actions, prices on the model, delete cleanup', () => {
  const openPrices = (modelId: string) => cds.run(cds.ql.SELECT.from(COSTS).where({ model: modelId }).and({ pricingKind: 'list_price' }).and({ dateTo: { '>': new Date().toISOString() } }));
  const modelUrl = (id: string) => `${S}/ConnectionModels(${id})`;
  async function connection(name = 'oa', providerType = 'openai'): Promise<string> {
    return (await createThroughDraft({ name, providerType })).draft.data.ID;
  }

  it('addModel creates a model through A\'s rules', async () => {
    const id = await connection();
    const r = await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini', displayName: 'Mini' }, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ modelId: 'gpt-4o-mini--oa', family: 'openai', displayName: 'Mini', isPublished: false });
    expect(audited('connection.model.create')).toHaveLength(1);
    const dup = await ok(POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN));
    expect(dup.status).toBe(409);
    await POST(`${conn(id)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    const onDraft = await ok(POST(`${conn(id, false)}/AdminService.addModel`, { upstreamModel: 'gpt-4o' }, ADMIN));
    expect(onDraft.status).toBeGreaterThanOrEqual(400);
    expect(onDraft.status).toBeLessThan(500);
    expect(await cds.run(cds.ql.SELECT.from(MODELS))).toHaveLength(1);
  });

  it('addModel is offered on the active entity only', async () => {
    const md = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    const block = /<Annotations Target="AdminService\.addModel\(AdminService\.ProviderConnections\)">[\s\S]*?<\/Annotations>/.exec(md)?.[0] ?? '';
    expect(block).toContain('<Path>in/IsActiveEntity</Path>');
  });

  it('a model shows its price and its suggestion', async () => {
    const id = await connection();
    const m = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    const before = (await GET(modelUrl(m.ID), ADMIN)).data;
    expect(before).toMatchObject({ isPriced: false, inputCost: null, priceCurrency: null, suggestedInputCost: 0.00015, suggestedOutputCost: 0.0006, suggestedCacheReadCost: 0.000075, suggestedCacheCreationCost: null });
    const priced = await POST(`${modelUrl(m.ID)}/AdminService.setListPrice`, { inputCost: 0.2, outputCost: 0.8 }, ADMIN);
    expect(priced.status).toBe(200);
    expect(priced.data).toMatchObject({ isPriced: true, inputCost: 0.2, priceCurrency: 'USD', suggestedInputCost: 0.2 });
    const list = (await GET(`${conn(id)}/models`, ADMIN)).data.value;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ isPriced: true, inputCost: 0.2, outputCost: 0.8, suggestedInputCost: 0.2, suggestedOutputCost: 0.8, priceCurrency: 'USD' });
  });

  it('an expanded models carries the same price fields as a direct read', async () => {
    const id = await connection();
    const a = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o' }, ADMIN);
    await POST(`${modelUrl(a.ID)}/AdminService.setListPrice`, { inputCost: 0.2, outputCost: 0.8 }, ADMIN);
    const expanded = (await GET(`${conn(id)}?$expand=models`, ADMIN)).data.models;
    const direct = (await GET(`${S}/ConnectionModels`, ADMIN)).data.value;
    expect(expanded).toHaveLength(2);
    for (const e of expanded) expect(e).toEqual(direct.find((d: any) => d.ID === e.ID));
    const byModel = (id2: string) => expanded.find((e: any) => e.modelId === id2);
    expect(byModel('gpt-4o-mini--oa')).toMatchObject({ isPriced: true, inputCost: 0.2, suggestedInputCost: 0.2 });
    expect(byModel('gpt-4o--oa')).toMatchObject({ isPriced: false, inputCost: null });
    expect(byModel('gpt-4o--oa').suggestedInputCost).toBeGreaterThan(0);
    const list = (await GET(`${S}/ProviderConnections?$expand=models`, ADMIN)).data.value;
    expect(list.flatMap((c: any) => c.models)).toHaveLength(2);
  });

  it('a connection counts its published models, in the list and on the object', async () => {
    const id = await connection();
    const other = await connection('az', 'anthropic');
    const a = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    const b = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o' }, ADMIN)).data;
    await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4.1' }, ADMIN);
    for (const m of [a, b]) {
      await POST(`${modelUrl(m.ID)}/AdminService.setListPrice`, { inputCost: 0.2, outputCost: 0.8 }, ADMIN);
      await POST(`${modelUrl(m.ID)}/AdminService.publish`, {}, ADMIN);
    }
    const list = (await GET(`${S}/ProviderConnections?$select=ID,name,publishedModels`, ADMIN)).data.value;
    expect(list.find((c: any) => c.ID === id).publishedModels).toBe(2);
    expect(list.find((c: any) => c.ID === other).publishedModels).toBe(0);
    expect((await GET(conn(id), ADMIN)).data.publishedModels).toBe(2);
    await POST(`${conn(id)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    expect((await GET(conn(id, false), ADMIN)).data.publishedModels).toBe(2);
    const md = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    expect(md).toMatch(/<Property Name="publishedModels" Type="Edm.Int32"\/>/);
  });

  it('no suggestion in a non-USD installation', async () => {
    (quotaCurrency as jest.Mock).mockResolvedValue('EUR');
    const id = await connection();
    const m = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    expect((await GET(modelUrl(m.ID), ADMIN)).data).toMatchObject({ isPriced: false, suggestedInputCost: null, suggestedOutputCost: null });
  });

  it('the price actions follow the price and publication state', async () => {
    const md = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    const block = (a: string) => new RegExp(`<Annotations Target="AdminService\\.${a}\\(AdminService\\.ConnectionModels\\)">[\\s\\S]*?</Annotations>`).exec(md)?.[0] ?? '';
    expect(block('publish')).toContain('in/isPriced');
    expect(block('publish')).toContain('in/isPublished');
    expect(block('unpublish')).toContain('in/isPublished');
    expect(md).toContain('in/suggestedInputCost');
  });

  it('remove deletes the model and closes its price', async () => {
    const id = await connection();
    const m = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    await POST(`${modelUrl(m.ID)}/AdminService.setListPrice`, { inputCost: 0.2, outputCost: 0.8 }, ADMIN);
    expect(await openPrices('gpt-4o-mini--oa')).toHaveLength(1);
    (recordAuditEvent as jest.Mock).mockClear();
    const r = await POST(`${modelUrl(m.ID)}/AdminService.remove`, {}, ADMIN);
    expect(r.status).toBe(204);
    expect(await cds.run(cds.ql.SELECT.from(MODELS))).toHaveLength(0);
    expect(await openPrices('gpt-4o-mini--oa')).toHaveLength(0);
    expect(await cds.run(cds.ql.SELECT.from(COSTS).where({ model: 'gpt-4o-mini--oa' }))).toHaveLength(1);
    expect(audited('connection.model.delete')).toHaveLength(1);
    expect(audited('connection.model.delete')[0].resourceId).toBe(m.ID);
  });

  it('deleting a connection removes its models, their open prices and its credential', async () => {
    const id = await connection();
    await POST(`${conn(id)}/AdminService.setCredential`, { secret: 'sk-test-0123456789abcdef' }, ADMIN);
    const a = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o' }, ADMIN);
    await POST(`${modelUrl(a.ID)}/AdminService.setListPrice`, { inputCost: 0.2, outputCost: 0.8 }, ADMIN);
    (recordAuditEvent as jest.Mock).mockClear();
    expect((await DELETE(conn(id), ADMIN)).status).toBe(204);
    expect(await cds.run(cds.ql.SELECT.from(CONNS))).toHaveLength(0);
    expect(await cds.run(cds.ql.SELECT.from(MODELS))).toHaveLength(0);
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(0);
    expect(await openPrices('gpt-4o-mini--oa')).toHaveLength(0);
    expect(await cds.run(cds.ql.SELECT.from(COSTS))).toHaveLength(1);
    expect(audited('connection.model.delete')).toHaveLength(2);
    expect(audited('connection.delete')).toHaveLength(1);
  });
});

describe('deferred minors (sub-project D)', () => {
  const modelUrl = (id: string) => `${S}/ConnectionModels(${id})`;
  async function connection(name = 'oa', providerType = 'openai'): Promise<string> {
    return (await createThroughDraft({ name, providerType })).draft.data.ID;
  }
  const asAdmin = async (fn: (srv: any) => Promise<any>) => {
    const srv = await cds.connect.to('AdminService');
    return srv.tx({ user: new cds.User({ id: 'cd-admin@test.com', roles: ['admin', 'user'] }) }, fn);
  };

  it('a draft read with $expand=models carries the price fields', async () => {
    const id = await connection();
    const a = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    await POST(`${modelUrl(a.ID)}/AdminService.setListPrice`, { inputCost: 0.2, outputCost: 0.8 }, ADMIN);
    await POST(`${conn(id)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    const expanded = (await GET(`${conn(id, false)}?$expand=models`, ADMIN)).data.models;
    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({ isPriced: true, inputCost: 0.2, outputCost: 0.8, priceCurrency: 'USD', suggestedInputCost: 0.2 });
  });

  it('an inactive connection counts no published models', async () => {
    const id = await connection();
    const a = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    await POST(`${modelUrl(a.ID)}/AdminService.setListPrice`, { inputCost: 0.2, outputCost: 0.8 }, ADMIN);
    await POST(`${modelUrl(a.ID)}/AdminService.publish`, {}, ADMIN);
    expect((await GET(conn(id), ADMIN)).data.publishedModels).toBe(1);
    await cds.run(cds.ql.UPDATE(CONNS).set({ isActive: false }).where({ ID: id }));
    expect((await GET(conn(id), ADMIN)).data.publishedModels).toBe(0);
    const list = (await GET(`${S}/ProviderConnections?$select=ID,publishedModels`, ADMIN)).data.value;
    expect(list.find((c: any) => c.ID === id).publishedModels).toBe(0);
    await POST(`${conn(id)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    expect((await GET(conn(id, false), ADMIN)).data.publishedModels).toBe(0);
  });

  it('a connection action with a key that is not a recognisable active key is refused', async () => {
    const id = await connection();
    const bare = await asAdmin((srv) => srv.send({ event: 'addModel', entity: 'AdminService.ProviderConnections', params: [id], data: { upstreamModel: 'gpt-4o' } })).catch((e: any) => e);
    expect(bare?.code ?? bare?.status ?? bare?.statusCode).toBe(400);
    const noFlag = await asAdmin((srv) => srv.send({ event: 'addModel', entity: 'AdminService.ProviderConnections', params: [{ ID: id }], data: { upstreamModel: 'gpt-4o' } })).catch((e: any) => e);
    expect(noFlag?.code ?? noFlag?.status ?? noFlag?.statusCode).toBe(400);
    expect(await cds.run(cds.ql.SELECT.from(MODELS))).toHaveLength(0);
  });

  it('name and providerType cannot change through a $batch PATCH either', async () => {
    const direct = await POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai', IsActiveEntity: true }, ADMIN);
    const id = direct.data.ID;
    for (const body of [{ name: 'other' }, { providerType: 'anthropic' }]) {
      const r = await ok(POST(`${S}/$batch`, { requests: [{ id: '1', method: 'PATCH', url: `ProviderConnections(ID=${id},IsActiveEntity=true)`,
        headers: { 'content-type': 'application/json' }, body }] }, ADMIN));
      expect(r.data.responses[0].status).toBe(400);
    }
    expect(await cds.run(cds.ql.SELECT.one.from(CONNS).columns('name', 'providerType').where({ ID: id }))).toEqual({ name: 'oa', providerType: 'openai' });
    const fine = await ok(POST(`${S}/$batch`, { requests: [{ id: '1', method: 'PATCH', url: `ProviderConnections(ID=${id},IsActiveEntity=true)`,
      headers: { 'content-type': 'application/json' }, body: { title: 'Batched' } }] }, ADMIN));
    expect(fine.data.responses[0].status).toBe(200);
    // Fiori Elements sends a multipart $batch with a change set.
    const multipart = (body: Record<string, any>) => [
      '--batch_1', 'Content-Type: multipart/mixed; boundary=changeset_1', '',
      '--changeset_1', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 1', '',
      `PATCH ProviderConnections(ID=${id},IsActiveEntity=true) HTTP/1.1`, 'Content-Type: application/json', '',
      JSON.stringify(body), '--changeset_1--', '--batch_1--', ''].join('\r\n');
    // cds answers a multipart batch in JSON when the client accepts it (axios does); either form is read.
    const batchStatus = (r: any): number => Number(typeof r.data === 'string' ? /HTTP\/1\.1 (\d{3})/.exec(r.data)?.[1] : r.data?.responses?.[0]?.status);
    const headers = { ...ADMIN, headers: { 'content-type': 'multipart/mixed; boundary=batch_1' } };
    for (const body of [{ name: 'other' }, { providerType: 'anthropic' }]) {
      const r = await ok(POST(`${S}/$batch`, multipart(body), headers));
      expect(batchStatus(r)).toBe(400);
    }
    expect(await cds.run(cds.ql.SELECT.one.from(CONNS).columns('name', 'providerType').where({ ID: id }))).toEqual({ name: 'oa', providerType: 'openai' });
    const fineMultipart = await ok(POST(`${S}/$batch`, multipart({ title: 'Multipart' }), headers));
    expect(batchStatus(fineMultipart)).toBe(200);
  });

  it('deleting a connection announces the change once', async () => {
    const id = await connection();
    await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN);
    await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o' }, ADMIN);
    (publishConnectionsChanged as jest.Mock).mockClear();
    expect((await DELETE(conn(id), ADMIN)).status).toBe(204);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(1);
    expect(audited('connection.model.delete')).toHaveLength(2);
  });

  it('removing a single model still announces the change', async () => {
    const id = await connection();
    const m = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    (publishConnectionsChanged as jest.Mock).mockClear();
    expect((await POST(`${modelUrl(m.ID)}/AdminService.remove`, {}, ADMIN)).status).toBe(204);
    expect(publishConnectionsChanged).toHaveBeenCalledTimes(1);
  });

  it('a failure in the middle of a connection delete rolls the whole delete back', async () => {
    const id = await connection();
    await POST(`${conn(id)}/AdminService.setCredential`, { secret: 'sk-test-0123456789abcdef' }, ADMIN);
    const a = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o-mini' }, ADMIN)).data;
    const b = (await POST(`${conn(id)}/AdminService.addModel`, { upstreamModel: 'gpt-4o' }, ADMIN)).data;
    for (const m of [a, b]) await POST(`${modelUrl(m.ID)}/AdminService.setListPrice`, { inputCost: 0.2, outputCost: 0.8 }, ADMIN);
    const prices = require('../../../src/services/connectionModelPrices');
    const real = prices.closeListPrices;
    let calls = 0;
    const spy = jest.spyOn(prices, 'closeListPrices').mockImplementation(async (...args: any[]) => {
      if (++calls === 2) throw new Error('close failed');
      return real(...args);
    });
    (publishConnectionsChanged as jest.Mock).mockClear();
    try {
      const r = await ok(DELETE(conn(id), ADMIN));
      expect(r.status).toBeGreaterThanOrEqual(500);
    } finally { spy.mockRestore(); }
    expect(calls).toBe(2);
    expect(await cds.run(cds.ql.SELECT.from(CONNS))).toHaveLength(1);
    expect(await cds.run(cds.ql.SELECT.from(MODELS))).toHaveLength(2);
    expect(await cds.run(cds.ql.SELECT.from(CREDS))).toHaveLength(1);
    const open = await cds.run(cds.ql.SELECT.from(COSTS).where({ pricingKind: 'list_price' }).and({ dateTo: { '>': new Date().toISOString() } }));
    expect(open).toHaveLength(2);
    expect(publishConnectionsChanged).not.toHaveBeenCalled();
  });
});
