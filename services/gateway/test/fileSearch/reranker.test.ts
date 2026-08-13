/**
 * Unit tests for the SAP reranker client and its deployment discovery
 * (axios mocked at both the `deploymentDiscoveryService` GET and the reranker
 * POST call sites — no network).
 *
 * The degradation contract is the behaviour that matters most here:
 *  - enabled=false: never even attempts discovery.
 *  - enabled='auto' (default): degrades to null on "no deployment" AND on a
 *    hard call failure (network error / malformed body) — a transient outage
 *    must not fail the whole search.
 *  - enabled=true: both of those cases THROW instead, because an operator who
 *    explicitly demanded reranking must not silently get RRF-only results.
 * Every branch below is asserted in both the null-return and throw variants so
 * that breaking the `required` divergence (e.g. collapsing it to always
 * degrade, or always throw) fails a test.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// A single shared object (not a fresh literal per call) so the module-level
// `logger` captured inside src/fileSearch/reranker.ts at import time is the
// exact same instance this test file asserts against.
const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => mockLogger,
}));

let mockFileSearchConfig: any;

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: 'https://sap.example', resourceGroup: 'default' }),
    getAccessToken: async () => 'test-token',
    getFileSearchConfig: () => mockFileSearchConfig,
  },
}));

const mockGet = jest.fn<(...args: any[]) => Promise<any>>();
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockGet(...a), post: (...a: any[]) => mockPost(...a) },
}));

import { clearCache } from '../../src/services/deploymentDiscoveryService';
import { rerank, getRerankerDeploymentId } from '../../src/fileSearch/reranker';

const logger = mockLogger;

const RUNNING_DEPLOYMENT = {
  id: 'd905318da42e6e4d',
  status: 'RUNNING',
  scenarioId: 'foundation-models',
  configurationName: 'cohere-reranker-config',
  details: { resources: { backendDetails: { model: { name: 'cohere-reranker' } } } },
};

function mockDeploymentList(resources: any[]): void {
  mockGet.mockResolvedValue({ data: { resources } });
}

function mockRerankResponse(data: any, status = 200): void {
  mockPost.mockResolvedValue({ data, status });
}

function capturedBody(): any {
  const calls = mockPost.mock.calls;
  return calls[calls.length - 1][1];
}

function setRerankEnabled(enabled: 'auto' | boolean): void {
  mockFileSearchConfig.hybrid.rerank.enabled = enabled;
}

describe('reranker', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    Object.values(logger).forEach((fn: any) => fn.mockClear());
    clearCache();
    mockFileSearchConfig = { hybrid: { rerank: { enabled: 'auto', model: 'cohere-reranker' } } };
    // Default: a running reranker deployment exists, unless a test overrides it.
    mockDeploymentList([RUNNING_DEPLOYMENT]);
    mockRerankResponse({ id: 'r1', meta: { billed_units: { search_units: 1 } }, results: [] });
  });

  describe('getRerankerDeploymentId (discovery)', () => {
    it('finds a RUNNING foundation-models deployment by configured model name', async () => {
      mockDeploymentList([RUNNING_DEPLOYMENT]);

      expect(await getRerankerDeploymentId(true)).toBe('d905318da42e6e4d');
    });

    it('ignores a deployment that is not RUNNING', async () => {
      mockDeploymentList([{ ...RUNNING_DEPLOYMENT, id: 'x', status: 'PENDING' }]);

      expect(await getRerankerDeploymentId(true)).toBeNull();
    });

    it('ignores a RUNNING deployment whose scenario is not foundation-models', async () => {
      mockDeploymentList([{ ...RUNNING_DEPLOYMENT, id: 'x', scenarioId: 'orchestration' }]);

      expect(await getRerankerDeploymentId(true)).toBeNull();
    });

    it('ignores a RUNNING foundation-models deployment whose model name does not match', async () => {
      mockDeploymentList([{
        ...RUNNING_DEPLOYMENT,
        id: 'x',
        details: { resources: { backendDetails: { model: { name: 'sonar-pro' } } } },
      }]);

      expect(await getRerankerDeploymentId(true)).toBeNull();
    });

    it('caches a successful discovery so a second call does not re-hit the API', async () => {
      mockDeploymentList([RUNNING_DEPLOYMENT]);

      const first = await getRerankerDeploymentId(true);
      const second = await getRerankerDeploymentId(); // no forceRefresh

      expect(first).toBe('d905318da42e6e4d');
      expect(second).toBe('d905318da42e6e4d');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('forceRefresh bypasses the cache', async () => {
      mockDeploymentList([RUNNING_DEPLOYMENT]);
      await getRerankerDeploymentId(true);

      mockDeploymentList([]);
      const result = await getRerankerDeploymentId(true);

      expect(result).toBeNull();
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('negative-caches a discovery failure so a second call does not immediately retry', async () => {
      mockGet.mockRejectedValue(new Error('network down'));

      const first = await getRerankerDeploymentId(true);
      const second = await getRerankerDeploymentId(); // no forceRefresh, within the short failure-cache window

      expect(first).toBeNull();
      expect(second).toBeNull();
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('rerank', () => {
    it('maps results back by index, since the response echoes no document text', async () => {
      mockRerankResponse({
        id: 'r1',
        meta: { billed_units: { search_units: 1 } },
        results: [{ index: 3, relevance_score: 0.75 }, { index: 0, relevance_score: 0.11 }],
      });

      const result = await rerank('q', ['a', 'b', 'c', 'd'], 2);

      expect(result!.hits).toEqual([{ index: 3, relevanceScore: 0.75 }, { index: 0, relevanceScore: 0.11 }]);
    });

    it('returns the billed search_units alongside the hits', async () => {
      mockRerankResponse({
        id: 'r1',
        results: [{ index: 0, relevance_score: 0.8 }],
        meta: { billed_units: { search_units: 3 } },
      });

      const result = await rerank('q', ['a'], 1);

      expect(result!.hits).toHaveLength(1);
      expect(result!.searchUnits).toBe(3);
    });

    it('still returns null when no deployment exists, unchanged', async () => {
      mockDeploymentList([]);

      expect(await rerank('q', ['a'], 1)).toBeNull();
    });

    it('leaves searchUnits undefined, not 0, when the upstream response omits meta entirely', async () => {
      mockRerankResponse({ id: 'r1', results: [{ index: 0, relevance_score: 0.8 }] }); // no `meta` key at all

      const result = await rerank('q', ['a'], 1);

      expect(result!.searchUnits).toBeUndefined();
      // Guards against a `?? 0` coalesce: an operator reading this column to
      // compare Cohere cost against an open-weight model must not mistake
      // "the field was absent" for "this call was free."
      expect(Object.is(result!.searchUnits, 0)).toBe(false);
    });

    it('never sends the documented cohere-reranker-35 id', async () => {
      mockRerankResponse({ results: [] });

      await rerank('q', ['a'], 1);

      expect(capturedBody().model).toBe('cohere-reranker');
    });

    it('sends the reranker model from config, not a hardcoded string', async () => {
      mockFileSearchConfig.hybrid.rerank.model = 'some-other-rerank-model';
      // Discovery matches on the same configured model name, so the mocked
      // deployment's backend model must agree for it to be found.
      mockDeploymentList([{
        ...RUNNING_DEPLOYMENT,
        details: { resources: { backendDetails: { model: { name: 'some-other-rerank-model' } } } },
      }]);
      mockRerankResponse({ results: [] });

      await rerank('q', ['a'], 1);

      expect(capturedBody().model).toBe('some-other-rerank-model');
    });

    it('sends query, documents and top_n on the wire', async () => {
      mockRerankResponse({ results: [] });

      await rerank('what is x?', ['doc a', 'doc b'], 5);

      const body = capturedBody();
      expect(body.query).toBe('what is x?');
      expect(body.documents).toEqual(['doc a', 'doc b']);
      expect(body.top_n).toBe(5);
    });

    it('posts to the deployment-scoped /rerank path', async () => {
      mockRerankResponse({ results: [] });

      await rerank('q', ['a'], 1);

      const url = mockPost.mock.calls[0][0];
      expect(url).toBe('https://sap.example/v2/inference/deployments/d905318da42e6e4d/rerank');
    });

    it('sends Authorization and AI-Resource-Group headers, mirroring searchExecutor', async () => {
      mockRerankResponse({ results: [] });

      await rerank('q', ['a'], 1);

      const options = mockPost.mock.calls[0][2];
      expect(options.headers.Authorization).toBe('Bearer test-token');
      expect(options.headers['AI-Resource-Group']).toBe('default');
    });

    it('logs billed search_units at info level, and never logs query or document text', async () => {
      mockRerankResponse({
        id: 'r1',
        meta: { billed_units: { search_units: 7 } },
        results: [{ index: 0, relevance_score: 0.5 }],
      });

      await rerank('super secret query', ['super secret document text'], 1);

      const infoCalls = logger.info.mock.calls;
      const rerankLog = infoCalls.find((c: any[]) => c[0] === 'Reranker');
      expect(rerankLog).toBeDefined();
      const loggedText = JSON.stringify(rerankLog);
      expect(loggedText).toContain('7');
      expect(loggedText).not.toContain('super secret query');
      expect(loggedText).not.toContain('super secret document text');
    });

    describe('enabled=false — never called', () => {
      it('returns null without attempting deployment discovery or an HTTP call', async () => {
        setRerankEnabled(false);

        const hits = await rerank('q', ['a'], 1);

        expect(hits).toBeNull();
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockPost).not.toHaveBeenCalled();
      });
    });

    describe('enabled=auto (default) — degrade to RRF, never throw', () => {
      it('returns null when no deployment exists', async () => {
        mockDeploymentList([]);

        const hits = await rerank('q', ['a'], 1);

        expect(hits).toBeNull();
      });

      it('returns null when the rerank call fails (network error)', async () => {
        mockPost.mockRejectedValue(new Error('ECONNRESET'));

        const hits = await rerank('q', ['a'], 1);

        expect(hits).toBeNull();
      });

      it('returns null when the rerank call fails (upstream 500)', async () => {
        const error: any = new Error('Request failed with status code 500');
        error.response = { status: 500, data: { message: 'internal error' } };
        mockPost.mockRejectedValue(error);

        const hits = await rerank('q', ['a'], 1);

        expect(hits).toBeNull();
      });

      it('returns null when the response body is malformed (no results array)', async () => {
        mockRerankResponse({ id: 'r1' }); // no `results` key at all

        const hits = await rerank('q', ['a'], 1);

        expect(hits).toBeNull();
      });
    });

    describe('enabled=true — required, surface failures', () => {
      it('throws when no deployment exists', async () => {
        setRerankEnabled(true);
        mockDeploymentList([]);

        await expect(rerank('q', ['a'], 1)).rejects.toThrow(/reranker/i);
      });

      it('throws when the rerank call fails (network error)', async () => {
        setRerankEnabled(true);
        mockPost.mockRejectedValue(new Error('ECONNRESET'));

        await expect(rerank('q', ['a'], 1)).rejects.toThrow(/ECONNRESET/);
      });

      it('throws when the rerank call fails (upstream 500)', async () => {
        setRerankEnabled(true);
        const error: any = new Error('Request failed with status code 500');
        error.response = { status: 500, data: { message: 'internal error' } };
        mockPost.mockRejectedValue(error);

        await expect(rerank('q', ['a'], 1)).rejects.toThrow(/500/);
      });

      it('throws when the response body is malformed (no results array)', async () => {
        setRerankEnabled(true);
        mockRerankResponse({ id: 'r1' }); // no `results` key at all

        await expect(rerank('q', ['a'], 1)).rejects.toThrow(/results/i);
      });
    });
  });
});
