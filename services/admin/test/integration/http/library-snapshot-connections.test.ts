/**
 * The Library snapshot adds the published models of active Connections from the admin's own tables:
 * the admin's service key gets the default catalog block, which the gateway never lists a
 * Connection model to (opt-in, spec 2026-10-23 §4.3), so the gateway's list cannot carry them.
 */
import path from 'path';

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

cds.test(path.resolve(__dirname, '../../..'));
import { modelCostService } from '../../../src/services/modelCostService';

const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const MODELS = 'sap.llm.gateway.admin.ConnectionModels';
const LIB = 'sap.llm.gateway.admin.LibraryModels';
const T1 = new Date('2026-10-24T10:00:00Z');
const T2 = new Date('2026-10-24T11:00:00Z');

const sapModel = (id: string) => ({ id, owned_by: 'OpenAI', accessType: 'foundation', versions: [] }) as any;

async function connection(name: string, extra: Record<string, any> = {}): Promise<string> {
  const ID = cds.utils.uuid();
  await cds.run(cds.ql.INSERT.into(CONNS).entries({ ID, name, providerType: 'openai', baseUrl: 'https://api.openai.com/v1', isActive: true, ...extra }));
  return ID;
}
async function model(connectionId: string, upstreamModel: string, name: string, isPublished = true): Promise<string> {
  const modelId = `${upstreamModel}--${name}`;
  await cds.run(cds.ql.INSERT.into(MODELS).entries({ connection_ID: connectionId, upstreamModel, modelId, family: 'openai', displayName: 'Mini', capabilities: '["chat","streaming","vision"]', isPublished }));
  return modelId;
}
const row = (modelId: string) => cds.run(cds.ql.SELECT.one.from(LIB).where({ modelId }));

beforeEach(async () => {
  const { DELETE: DEL } = cds.ql;
  await cds.run([DEL.from(LIB), DEL.from(MODELS), DEL.from(CONNS)]);
});

describe('upsertLibrarySnapshot and Connection models', () => {
  it('adds a published model of an active connection that the gateway list lacks', async () => {
    const id = await connection('oa');
    const modelId = await model(id, 'gpt-4o-mini', 'oa');
    await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o')], T1);
    expect(await row(modelId)).toMatchObject({
      origin: 'external', connection: 'oa', absent: false, accessType: 'external', baseModel: 'gpt-4o-mini',
      displayName: 'Mini', provider: 'openai', capImageRecognition: true, capText: true,
    });
    expect(await row('gpt-4o')).toMatchObject({ origin: 'sap', absent: false });
  });

  it('leaves out an unpublished model and a published model of an inactive connection', async () => {
    const active = await connection('oa');
    const inactive = await connection('off', { isActive: false });
    const draft = await model(active, 'gpt-4o-mini', 'oa', false);
    const orphan = await model(inactive, 'gpt-4o-mini', 'off');
    await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o')], T1);
    expect(await row(draft)).toBeUndefined();
    expect(await row(orphan)).toBeUndefined();
  });

  it('a SAP model with the same id wins and the Connection entry is not duplicated', async () => {
    const id = await connection('oa');
    const modelId = await model(id, 'gpt-4o-mini', 'oa');
    await modelCostService.upsertLibrarySnapshot([sapModel(modelId)], T1);
    expect(await row(modelId)).toMatchObject({ origin: 'sap', connection: null });
    const rows = await cds.run(cds.ql.SELECT.from(LIB).where({ modelId }));
    expect(rows).toHaveLength(1);
  });

  it('an external entry the gateway did send is not duplicated', async () => {
    const id = await connection('oa');
    const modelId = await model(id, 'gpt-4o-mini', 'oa');
    const sent = { id: modelId, accessType: 'external', providerType: 'openai', upstreamModel: 'gpt-4o-mini', capabilities: ['chat'], versions: [] } as any;
    const r = await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o'), sent], T1);
    expect(r.upserted).toBe(2);
    expect(await cds.run(cds.ql.SELECT.from(LIB).where({ modelId }))).toHaveLength(1);
  });

  it('an empty gateway payload still upserts the Connection rows and sweeps no SAP row', async () => {
    const id = await connection('oa');
    const modelId = await model(id, 'gpt-4o-mini', 'oa');
    await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o')], T1);
    const r = await modelCostService.upsertLibrarySnapshot([], T2);
    expect(r).toMatchObject({ upserted: 1, absent: 0 });
    expect(await row(modelId)).toMatchObject({ origin: 'external', absent: false });
    expect(await row('gpt-4o')).toMatchObject({ absent: false });
  });

  it('an empty payload with no published Connection model stays a no-op', async () => {
    expect(await modelCostService.upsertLibrarySnapshot([], T1)).toEqual({ upserted: 0, absent: 0, deployments: 0 });
  });

  it('after unpublishing, the next snapshot with SAP rows marks the Connection row absent', async () => {
    const id = await connection('oa');
    const modelId = await model(id, 'gpt-4o-mini', 'oa');
    await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o')], T1);
    expect((await row(modelId)).absent).toBe(false);
    await cds.run(cds.ql.UPDATE(MODELS).set({ isPublished: false }).where({ modelId }));
    await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o')], T2);
    expect((await row(modelId)).absent).toBe(true);
    expect((await row('gpt-4o')).absent).toBe(false);
  });

  it('a failed Connections read leaves the existing Connection rows alone while SAP rows are still swept', async () => {
    const id = await connection('oa');
    const modelId = await model(id, 'gpt-4o-mini', 'oa');
    await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o'), sapModel('gpt-4o-old')], T1);
    const spy = jest.spyOn(modelCostService as any, 'publishedConnectionModels').mockResolvedValue(null);
    try {
      await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o')], T2);
    } finally { spy.mockRestore(); }
    expect(await row(modelId)).toMatchObject({ origin: 'external', absent: false });
    expect(await row('gpt-4o-old')).toMatchObject({ absent: true });
    expect(await row('gpt-4o')).toMatchObject({ absent: false });
  });

  it('a real read failure is logged and does not stop the SAP snapshot', async () => {
    const db = await cds.connect.to('db');
    const spy = jest.spyOn(db, 'run').mockRejectedValueOnce(new Error('locked'));
    let r;
    try { r = await modelCostService.upsertLibrarySnapshot([sapModel('gpt-4o')], T1); } finally { spy.mockRestore(); }
    expect(r.upserted).toBe(1);
  });
});
