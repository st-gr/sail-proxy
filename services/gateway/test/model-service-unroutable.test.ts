/**
 * M: SAP AI Core publishes foundation models this gateway cannot route - those with no
 * `orchestration` scenario, such as the GPT realtime models. getModels drops them from the list
 * clients get and keeps them, marked `routable: false`, only for callers that ask
 * (`includeUnroutable`), which is how the admin's Model Library lists what SAP AI Core offers.
 *
 * The module reads its configuration and SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES at load time, so
 * each case builds its own module registry with jest.resetModules() + jest.doMock().
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

export {};

const FOUNDATION_URL = '/lm/scenarios/foundation-models/models';

const model = (id: string, scenarios: string[], extra: Record<string, unknown> = {}) => ({
  model: id,
  provider: id.split('--')[0],
  executableId: 'aicore-openai',
  createdAt: '2026-01-01T00:00:00Z',
  allowedScenarios: scenarios.map(scenarioId => ({ scenarioId, executableId: scenarioId })),
  versions: [{ name: '1', isLatest: true, streamingSupported: true }],
  ...extra
});

const FOUNDATION_MODELS = [
  model('anthropic--claude-4.5-haiku', ['foundation-models', 'orchestration']),
  // no orchestration scenario: SAP publishes it, this gateway cannot route it
  model('openai--gpt-4o-realtime', ['foundation-models']),
  // deprecated and unroutable: dropped from both lists
  model('openai--gpt-4-retired', ['foundation-models'], { deprecated: true })
];

/** Loads modelService with axios and configService mocked; returns it plus the axios double. */
function loadModelService(extendedAttributes: boolean) {
  jest.resetModules();
  process.env.AUTH_URL = 'https://auth.example/oauth/token';
  process.env.CLIENT_ID = 'id';
  process.env.CLIENT_SECRET = 'secret';
  process.env.SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES = extendedAttributes ? 'true' : 'false';

  const get = jest.fn((url: unknown) =>
    Promise.resolve(String(url).includes(FOUNDATION_URL)
      ? { data: { resources: FOUNDATION_MODELS } }
      : { data: { resources: [] } }));
  const axiosMock = {
    get,
    post: jest.fn(() => Promise.resolve({ data: { access_token: 't', expires_in: 3600 } }))
  };
  jest.doMock('axios', () => ({ __esModule: true, default: axiosMock, ...axiosMock }));
  jest.doMock('@libs/logger', () => ({
    getDefaultLogger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined })
  }));
  jest.doMock('../src/services/configService', () => ({
    __esModule: true,
    default: {
      getSAPAICoreConfig: () => ({ url: 'https://ai.example' }),
      getModelListChanges: () => ({})
    }
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return { service: require('../src/services/modelService'), get };
}

const ids = (list: { data: Array<{ id: string }> }) => list.data.map(m => m.id).sort();

describe('getModels and the models this gateway cannot route', () => {
  beforeEach(() => {
    delete process.env.SAP_MODEL_CACHE_DURATION_SECONDS;
  });

  it('leaves the default list exactly the routable one', async () => {
    const { service } = loadModelService(true);
    const list = await service.getModels();
    expect(ids(list)).toEqual(['anthropic--claude-4.5-haiku']);
    expect(list.data[0].routable).toBe(true);
  });

  it('adds the unroutable models, marked routable:false, only when asked', async () => {
    const { service } = loadModelService(true);
    const list = await service.getModels(false, { includeUnroutable: true });
    expect(ids(list)).toEqual(['anthropic--claude-4.5-haiku', 'openai--gpt-4o-realtime']);
    const realtime = list.data.find((m: any) => m.id === 'openai--gpt-4o-realtime');
    expect(realtime.routable).toBe(false);
    expect(realtime.accessType).toBe('foundation');
  });

  it('never lists a deprecated model, with or without the flag', async () => {
    const { service } = loadModelService(true);
    expect(ids(await service.getModels(false, { includeUnroutable: true }))).not.toContain('openai--gpt-4-retired');
    expect(ids(await service.getModels())).not.toContain('openai--gpt-4-retired');
  });

  it('serves both variants from one fetch, and the flag never changes the default list', async () => {
    const { service, get } = loadModelService(true);
    const withUnroutable = await service.getModels(false, { includeUnroutable: true });
    const routableAfter = await service.getModels();
    expect(ids(routableAfter)).toEqual(['anthropic--claude-4.5-haiku']);
    expect(withUnroutable.data).toHaveLength(2);
    // foundation models + deployments, once - the second call came out of the cache
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('keeps the unroutable models out of the default list even with extended attributes off', async () => {
    // Without extended attributes `routable` never reaches the OpenAI item, so a list filtered
    // after the transform would leak them; the split happens before it.
    const { service } = loadModelService(false);
    const list = await service.getModels();
    expect(ids(list)).toEqual(['anthropic--claude-4.5-haiku']);
    expect(list.data[0].routable).toBeUndefined();
    expect(ids(await service.getModels(false, { includeUnroutable: true })))
      .toEqual(['anthropic--claude-4.5-haiku', 'openai--gpt-4o-realtime']);
  });

  it('clearModelsCache drops both variants', async () => {
    const { service, get } = loadModelService(true);
    await service.getModels(false, { includeUnroutable: true });
    service.clearModelsCache();
    await service.getModels(false, { includeUnroutable: true });
    expect(get).toHaveBeenCalledTimes(4);
  });
});
