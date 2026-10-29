/**
 * The SAP list calls (orchestration, Perplexity and reranker deployment discovery, the
 * foundation-model catalogue and deployments) and the OAuth token fetch time out and retry once,
 * with real axios against a local server that stalls (test/fakeSapServer.ts). Before, a stalled
 * list waited until the socket died. Each case loads fresh modules: both services read their
 * configuration and keep their caches at module level.
 */
import { describe, it, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import { startFakeSapServer, FakeSapServer, FakeSapBehaviour } from './fakeSapServer';

const ATTEMPT_MS = 250;
const BOUND_MS = 2 * ATTEMPT_MS + 1_000;

let server: FakeSapServer;

beforeAll(async () => {
  server = await startFakeSapServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  server.requests.length = 0;
});

const TOKEN: FakeSapBehaviour = { kind: 'json', body: { access_token: 'tok', expires_in: 3600 } };
const quietLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function shortTimings() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../src/utils/sapRequest').__setSapTimingForTests({
    listAttemptMs: ATTEMPT_MS, tokenAttemptMs: ATTEMPT_MS, retryJitterMinMs: 5, retryJitterMaxMs: 10,
  });
}

function loadDiscovery() {
  jest.resetModules();
  jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quietLogger }));
  jest.doMock('../src/services/configService', () => ({
    __esModule: true,
    default: {
      getSAPAICoreConfig: () => ({ url: server.url, resourceGroup: 'default' }),
      getAccessToken: async () => 'tok',
      getFileSearchConfig: () => ({ hybrid: { rerank: { model: 'cohere-reranker' } } }),
    },
  }));
  shortTimings();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/services/deploymentDiscoveryService');
}

function loadModelService() {
  jest.resetModules();
  process.env.AUTH_URL = `${server.url}/oauth/token`;
  process.env.CLIENT_ID = 'id';
  process.env.CLIENT_SECRET = 'secret';
  delete process.env.SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES;
  jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quietLogger }));
  jest.doMock('../src/services/configService', () => ({
    __esModule: true,
    default: {
      getSAPAICoreConfig: () => ({ url: server.url }),
      getModelListChanges: () => ({}),
    },
  }));
  shortTimings();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/services/modelService');
}

async function timed(work: () => Promise<any>): Promise<{ value: any; elapsed: number }> {
  const startedAt = Date.now();
  const value = await work();
  return { value, elapsed: Date.now() - startedAt };
}

const RUNNING_ORCHESTRATION = {
  id: 'orch-1', status: 'RUNNING', scenarioId: 'orchestration', createdAt: '2026-01-01T00:00:00Z',
  configurationName: 'orchestration',
};

describe('deployment discovery list calls', () => {
  it('a stalled orchestration list yields no deployment within the bound, after one retry', async () => {
    const discovery = loadDiscovery();
    server.script([{ kind: 'stall' }]);

    const { value, elapsed } = await timed(() => discovery.getPreferredOrchestrationDeploymentId());

    expect(value).toBeNull();
    expect(server.requests).toHaveLength(2);
    expect(elapsed).toBeLessThan(BOUND_MS);
  });

  it('a stall followed by an answer is served by the retry', async () => {
    const discovery = loadDiscovery();
    server.script([{ kind: 'stall' }, { kind: 'json', body: { resources: [RUNNING_ORCHESTRATION] } }]);

    await expect(discovery.getPreferredOrchestrationDeploymentId()).resolves.toBe('orch-1');
    expect(server.requests).toHaveLength(2);
  });

  it('a refresh that stalls returns the stale cache', async () => {
    const discovery = loadDiscovery();
    server.script([{ kind: 'json', body: { resources: [RUNNING_ORCHESTRATION] } }, { kind: 'stall' }]);
    await discovery.getOrchestrationDeployments();

    const { value, elapsed } = await timed(() => discovery.getOrchestrationDeployments(true));

    expect(value.map((d: { id: string }) => d.id)).toEqual(['orch-1']);
    expect(server.requests).toHaveLength(3);
    expect(elapsed).toBeLessThan(BOUND_MS);
  });

  it.each(['getPerplexityDeploymentId', 'getRerankerDeploymentId'])(
    '%s yields null within the bound when the list stalls', async (fn) => {
      const discovery = loadDiscovery();
      server.script([{ kind: 'stall' }]);

      const { value, elapsed } = await timed(() => discovery[fn]());

      expect(value).toBeNull();
      expect(server.requests).toHaveLength(2);
      expect(elapsed).toBeLessThan(BOUND_MS);
    });
});

describe('model service: token and catalogue', () => {
  it('a stalled token fetch fails within the bound after one retry', async () => {
    const modelService = loadModelService();
    server.script([{ kind: 'stall' }]);

    const startedAt = Date.now();
    await expect(modelService.getAuthToken()).rejects.toThrow('Failed to authenticate with SAP AI Core');

    expect(server.requests).toHaveLength(2);
    expect(server.requests.every((r) => r.url === '/oauth/token')).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(BOUND_MS);
  });

  it('a stalled token fetch is served by the retry', async () => {
    const modelService = loadModelService();
    server.script([{ kind: 'stall' }, TOKEN]);

    await expect(modelService.getAuthToken()).resolves.toBe('tok');
    expect(server.requests).toHaveLength(2);
  });

  it('a rejected token request (401) is not retried', async () => {
    const modelService = loadModelService();
    server.script([{ kind: 'status', status: 401 }, TOKEN]);

    await expect(modelService.getAuthToken()).rejects.toThrow('Failed to authenticate with SAP AI Core');
    expect(server.requests).toHaveLength(1);
  });

  it('a stalled foundation-model list fails getModels within the bound after one retry', async () => {
    const modelService = loadModelService();
    server.script([TOKEN, { kind: 'stall' }]);

    const startedAt = Date.now();
    await expect(modelService.getModels(true)).rejects.toThrow();

    expect(server.requests.map((r) => r.url)).toEqual([
      '/oauth/token', '/v2/lm/scenarios/foundation-models/models', '/v2/lm/scenarios/foundation-models/models',
    ]);
    expect(Date.now() - startedAt).toBeLessThan(BOUND_MS);
  });

  it('stalls on both lists are each served by one retry', async () => {
    const modelService = loadModelService();
    const foundation = {
      model: 'openai--gpt-4o', provider: 'openai', executableId: 'aicore-openai', createdAt: '2026-01-01T00:00:00Z',
      allowedScenarios: [{ scenarioId: 'orchestration', executableId: 'orchestration' }],
      versions: [{ name: '1', isLatest: true, streamingSupported: true }],
    };
    server.script([
      TOKEN,
      { kind: 'stall' }, { kind: 'json', body: { resources: [foundation] } },
      { kind: 'stall' }, { kind: 'json', body: { resources: [] } },
    ]);

    const models = await modelService.getModels(true);

    expect(models.data.map((m: { id: string }) => m.id)).toContain('openai--gpt-4o');
    expect(server.requests.map((r) => r.url)).toEqual([
      '/oauth/token',
      '/v2/lm/scenarios/foundation-models/models', '/v2/lm/scenarios/foundation-models/models',
      '/v2/lm/deployments', '/v2/lm/deployments',
    ]);
  });
});
