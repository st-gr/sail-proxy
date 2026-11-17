/**
 * Looking up a model that is not in the list rebuilds the list once, in case the model was
 * deployed a moment ago. It must not do so on EVERY lookup: routes ask for a model's
 * `<model>--deployed` twin on each request, and for most models there is none. Seen live
 * 2026-11-12: every /responses request for gpt-5.5 logged "Model 'gpt-5.5--deployed' not found
 * on attempt 1. Retrying with cache refresh" and fetched SAP's model list again (about 0.6 s).
 *
 * The module reads its configuration at load time, so each case builds its own module
 * registry with jest.resetModules() + jest.doMock().
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';

export {};

const FOUNDATION_URL = '/lm/scenarios/foundation-models/models';

const model = (id: string) => ({
  model: id,
  provider: id.split('--')[0],
  executableId: 'aicore-openai',
  createdAt: '2026-01-01T00:00:00Z',
  allowedScenarios: [{ scenarioId: 'orchestration', executableId: 'orchestration' }],
  versions: [{ name: '1', isLatest: true, streamingSupported: true }],
});

function loadModelService() {
  jest.resetModules();
  process.env.AUTH_URL = 'https://auth.example/oauth/token';
  process.env.CLIENT_ID = 'id';
  process.env.CLIENT_SECRET = 'secret';
  delete process.env.SAP_MODEL_CACHE_DURATION_SECONDS;

  const foundation = [model('gpt-5.5')];
  const get = jest.fn((url: unknown) =>
    Promise.resolve(String(url).includes(FOUNDATION_URL)
      ? { data: { resources: foundation } }
      : { data: { resources: [] } }));
  const axiosMock = {
    get,
    post: jest.fn(() => Promise.resolve({ data: { access_token: 't', expires_in: 3600 } })),
  };
  const warn = jest.fn();
  jest.doMock('axios', () => ({ __esModule: true, default: axiosMock, ...axiosMock }));
  jest.doMock('@libs/logger', () => ({
    getDefaultLogger: () => ({ debug: () => undefined, info: () => undefined, warn, error: () => undefined }),
  }));
  jest.doMock('../src/services/configService', () => ({
    __esModule: true,
    default: {
      getSAPAICoreConfig: () => ({ url: 'https://ai.example' }),
      getModelListChanges: () => ({}),
    },
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const service = require('../src/services/modelService');
  /** How often SAP's model list was fetched. */
  const listFetches = () => get.mock.calls.filter(([url]) => String(url).includes(FOUNDATION_URL)).length;
  return { service, listFetches, foundation, warn };
}

describe('looking up a model that is not in the list', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('rebuilds the list once, then answers further lookups of that name from what it has', async () => {
    const { service, listFetches } = loadModelService();
    expect(await service.getModelDetails('gpt-5.5')).not.toBeNull();
    expect(listFetches()).toBe(1);

    expect(await service.getModelDetails('gpt-5.5--deployed')).toBeNull();
    expect(listFetches()).toBe(2);                       // the one rebuild

    for (let i = 0; i < 5; i++) expect(await service.getModelDetails('gpt-5.5--deployed')).toBeNull();
    expect(listFetches()).toBe(2);                       // and no more
  });

  it('warns about the missing name once, not on every lookup', async () => {
    const { service, warn } = loadModelService();
    await service.getModelDetails('gpt-5.5--deployed');
    const afterFirst = warn.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await service.getModelDetails('gpt-5.5--deployed');
    expect(warn.mock.calls.length).toBe(afterFirst);
  });

  it('looks again after a minute, and finds a model deployed meanwhile', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const { service, listFetches, foundation } = loadModelService();
    expect(await service.getModelDetails('gpt-6-new')).toBeNull();
    const fetchesBefore = listFetches();

    foundation.push(model('gpt-6-new'));
    jest.advanceTimersByTime(30_000);
    expect(await service.getModelDetails('gpt-6-new')).toBeNull();
    expect(listFetches()).toBe(fetchesBefore);

    jest.advanceTimersByTime(31_000);
    expect((await service.getModelDetails('gpt-6-new'))?.id).toBe('gpt-6-new');
    expect(listFetches()).toBe(fetchesBefore + 1);
  });

  it('keeps one missing name from holding back the lookup of another', async () => {
    const { service, listFetches } = loadModelService();
    await service.getModelDetails('first-missing');
    const before = listFetches();
    await service.getModelDetails('second-missing');
    expect(listFetches()).toBe(before + 1);
  });

  it('looks again at once after the model cache was cleared', async () => {
    const { service, listFetches, foundation } = loadModelService();
    expect(await service.getModelDetails('gpt-6-new')).toBeNull();
    foundation.push(model('gpt-6-new'));
    service.clearModelsCache();
    const before = listFetches();
    expect((await service.getModelDetails('gpt-6-new'))?.id).toBe('gpt-6-new');
    expect(listFetches()).toBe(before + 1);
  });

  it('still finds a listed model without any rebuild', async () => {
    const { service, listFetches } = loadModelService();
    await service.getModelDetails('gpt-5.5');
    await service.getModelDetails('gpt-5.5');
    expect(listFetches()).toBe(1);
  });
});
