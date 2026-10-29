/**
 * Published Connection models join the gateway's model list (spec 2026-10-23 §4.3): appended to
 * the SAP list in both variants, present without extended attributes, and still served while the
 * SAP list fetch fails - the budget-overflow case may coincide with SAP trouble. Without external
 * models a failed SAP fetch fails exactly as before. An external id equal to an SAP id loses.
 */
import { describe, it, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import { startFakeSapServer, FakeSapServer, FakeSapBehaviour } from './fakeSapServer';

let server: FakeSapServer;
beforeAll(async () => { server = await startFakeSapServer(); });
afterAll(async () => { await server.close(); });
afterEach(() => { server.requests.length = 0; });
afterAll(() => { delete process.env.SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES; });

const TOKEN: FakeSapBehaviour = { kind: 'json', body: { access_token: 'tok', expires_in: 3600 } };
const quietLogger = { debug: () => undefined, info: () => undefined, warn: jest.fn(), error: () => undefined, trace: () => undefined };
const foundation = (model: string) => ({
  model, provider: 'openai', executableId: 'azure-openai', createdAt: '2026-01-01T00:00:00Z',
  allowedScenarios: [{ scenarioId: 'orchestration', executableId: 'orchestration' }],
  versions: [{ name: '1', isLatest: true, streamingSupported: true }],
});
const SAP_OK: FakeSapBehaviour[] = [TOKEN, { kind: 'json', body: { resources: [foundation('gpt-4o')] } }, { kind: 'json', body: { resources: [] } }];

const connection = (models: string[]) => ({
  id: 'c-oa', name: 'oa', providerType: 'openai', settings: {}, credentials: { secret: 'sk-secret' },
  models: models.map((id) => ({ modelId: id, upstreamModel: id.split('--')[0], displayName: null, family: id.startsWith('claude') ? 'claude' : 'openai', capabilities: ['chat', 'streaming'], priced: true })),
});

function load(externalIds: string[]) {
  jest.resetModules();
  process.env.AUTH_URL = `${server.url}/oauth/token`;
  process.env.CLIENT_ID = 'id';
  process.env.CLIENT_SECRET = 'secret';
  // Set, not deleted: modelService loads the gateway .env, and dotenv only fills unset variables
  // (CI's .env turns extended attributes on).
  process.env.SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES = 'false';
  jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quietLogger }));
  jest.doMock('../src/services/configService', () => ({
    __esModule: true,
    default: { getSAPAICoreConfig: () => ({ url: server.url }), getModelListChanges: () => ({}) },
  }));
  const c = connection(externalIds);
  const registry = {
    ensureFresh: jest.fn(async () => undefined),
    refreshInBackground: jest.fn(async () => undefined),
    publishedModels: jest.fn(() => c.models.map((model) => ({ connection: c, model }))),
    setShadowed: jest.fn(),
  };
  jest.doMock('../src/connections/connectionRegistry', () => ({ connectionRegistry: registry }));
  require('../src/utils/sapRequest').__setSapTimingForTests({ listAttemptMs: 250, tokenAttemptMs: 250, retryJitterMinMs: 5, retryJitterMaxMs: 10 });
  const modelService = require('../src/services/modelService');
  return { modelService, registry };
}

describe('getModels with connection models', () => {
  it('appends the external entry, accessType external, with extended attributes off', async () => {
    const { modelService } = load(['gpt-4o-mini--oa']);
    server.script(SAP_OK);
    const list = await modelService.getModels(true);
    expect(list.data.map((m: any) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini--oa']);
    expect(list.data[1]).toMatchObject({
      id: 'gpt-4o-mini--oa', object: 'model', owned_by: 'openai', accessType: 'external', connectionId: 'c-oa',
      providerType: 'openai', family: 'openai', upstreamModel: 'gpt-4o-mini', streamingSupported: true, routable: true, priced: true,
    });
    expect(list.data[0].accessType).toBeUndefined();
  });

  it('carries it in the includeUnroutable variant too', async () => {
    const { modelService } = load(['gpt-4o-mini--oa']);
    server.script(SAP_OK);
    const list = await modelService.getModels(true, { includeUnroutable: true });
    expect(list.data.map((m: any) => m.id)).toContain('gpt-4o-mini--oa');
  });

  it('reflects a registry change without waiting for the SAP cache to expire', async () => {
    const { modelService, registry } = load(['gpt-4o-mini--oa']);
    server.script(SAP_OK);
    await modelService.getModels(true);
    registry.publishedModels.mockReturnValue([]);
    const list = await modelService.getModels(false);
    expect(list.data.map((m: any) => m.id)).toEqual(['gpt-4o']);
  });

  it('serves the external entries alone while the SAP list fails', async () => {
    const { modelService } = load(['gpt-4o-mini--oa']);
    server.script([TOKEN, { kind: 'status', status: 500, body: { error: 'down' } }]);
    const list = await modelService.getModels(true);
    expect(list.data.map((m: any) => m.id)).toEqual(['gpt-4o-mini--oa']);
  });

  it('without external models fails as before', async () => {
    const { modelService } = load([]);
    server.script([TOKEN, { kind: 'status', status: 500, body: { error: 'down' } }]);
    await expect(modelService.getModels(true)).rejects.toMatchObject({ status: 500 });
  });

  it('drops an external id equal to an SAP id and reports it shadowed', async () => {
    const { modelService, registry } = load(['gpt-4o', 'gpt-4o-mini--oa']);
    server.script(SAP_OK);
    const list = await modelService.getModels(true);
    expect(list.data.filter((m: any) => m.id === 'gpt-4o')).toHaveLength(1);
    expect(list.data.find((m: any) => m.id === 'gpt-4o').accessType).not.toBe('external');
    expect(registry.setShadowed).toHaveBeenLastCalledWith(['gpt-4o']);
    expect(quietLogger.warn).toHaveBeenCalled();
  });
});

describe('isPublishableModelList', () => {
  it('needs at least one SAP model: a list built on a failed SAP fetch is not published', () => {
    const { isPublishableModelList } = require('../src/connections/mergeExternalModels');
    expect(isPublishableModelList([{ id: 'gpt-4o-mini--oa', accessType: 'external' }])).toBe(false);
    expect(isPublishableModelList([])).toBe(false);
    expect(isPublishableModelList([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini--oa', accessType: 'external' }])).toBe(true);
  });
});

describe('the Anthropic models list and connection models', () => {
  it('lists an external claude-family model and not an openai-family one named like claude', async () => {
    jest.resetModules();
    jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quietLogger }));
    jest.doMock('../src/services/modelService', () => ({
      getModels: async () => ({ object: 'list', data: [
        { id: 'claude-sonnet-4-5--an', owned_by: 'anthropic', accessType: 'external', family: 'claude', created: 0 },
        { id: 'claude-lookalike--az', owned_by: 'azure-openai', accessType: 'external', family: 'openai', created: 0 },
        { id: 'anthropic--claude-4.5-sonnet', owned_by: 'anthropic', created: 0 },
      ] }),
      getModelById: jest.fn(), clearModelsCache: jest.fn(),
    }));
    const { getAnthropicModels } = require('../src/controllers/modelController');
    let body: any;
    await getAnthropicModels({ headers: {} } as any, { json: (b: any) => { body = b; } } as any, jest.fn() as any);
    expect(body.data.map((m: any) => m.id)).toEqual(['claude-sonnet-4-5--an', 'anthropic--claude-4.5-sonnet']);
  });
});

describe('the connections change channel', () => {
  it('calls the registered handler on a message', async () => {
    jest.resetModules();
    jest.dontMock('../src/services/configService');
    process.env.CONNECTIONS_CHANGE_CHANNEL = 'test:connections-changed';
    const configService = require('../src/services/configService');
    const handler = jest.fn();
    configService.setConnectionsChangedHandler(handler);
    await configService.handleValkeyEvent('test:connections-changed', JSON.stringify({ version: 1 }));
    expect(handler).toHaveBeenCalledTimes(1);
    await configService.handleValkeyEvent('sap-llm-gateway:other', JSON.stringify({}));
    expect(handler).toHaveBeenCalledTimes(1);
    delete process.env.CONNECTIONS_CHANGE_CHANNEL;
  });
});
