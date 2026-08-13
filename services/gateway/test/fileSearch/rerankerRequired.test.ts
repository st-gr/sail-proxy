/**
 * `hybrid.rerank.enabled: true` means reranking was explicitly demanded. Without a
 * deployment there is nothing to demand against, and reranker.ts used to throw a bare
 * `Error` there — statusless, so it fell through to the generic 500 handler carrying a
 * raw message. This file locks down the fix: that path now throws
 * `RerankerUnavailableError` (status 503, code 'file_search_unavailable'), matching the
 * envelope the rest of file_search already uses for unavailability.
 *
 * Not default-reachable: `enabled: 'auto'` (the default) degrades to `null` instead of
 * throwing — see reranker.test.ts's full degradation-contract coverage. The second test
 * below re-asserts that specific branch here too, because it is the one a careless fix
 * (e.g. inverting the `required` check) would silently break without any other test in
 * this file catching it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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
import { rerank, RerankerUnavailableError } from '../../src/fileSearch/reranker';

/** No RUNNING deployment in the list — discovery resolves to null. */
function mockNoRerankerDeployment(): void {
  mockGet.mockResolvedValue({ data: { resources: [] } });
}

const documents = ['chunk one', 'chunk two'];

describe('reranker — required (hybrid.rerank.enabled: true)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    Object.values(mockLogger).forEach((fn: any) => fn.mockClear());
    clearCache();
    mockFileSearchConfig = { hybrid: { rerank: { enabled: true, model: 'cohere-reranker' } } };
  });

  it('throws a 503-carrying error when rerank is DEMANDED but no deployment exists', async () => {
    mockFileSearchConfig.hybrid.rerank.enabled = true;
    mockNoRerankerDeployment();

    await expect(rerank('q', documents, 2)).rejects.toMatchObject({
      status: 503,
      code: 'file_search_unavailable',
    });
    await expect(rerank('q', documents, 2)).rejects.toBeInstanceOf(RerankerUnavailableError);
  });

  it('still returns null — never throws — when rerank is auto', async () => {
    mockFileSearchConfig.hybrid.rerank.enabled = 'auto';
    mockNoRerankerDeployment();

    await expect(rerank('q', documents, 2)).resolves.toBeNull();
  });

  it('does not name the deployment id or any caller text in the message', async () => {
    mockFileSearchConfig.hybrid.rerank.enabled = true;
    mockNoRerankerDeployment();

    const err: any = await rerank('SENSITIVE QUERY', ['SENSITIVE DOCUMENT'], 2).catch((e) => e);

    expect(err).toBeInstanceOf(RerankerUnavailableError);
    expect(err.message).not.toMatch(/SENSITIVE/);
  });
});
