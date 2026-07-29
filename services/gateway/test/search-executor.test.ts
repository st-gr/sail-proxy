import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: 'https://sap.example', resourceGroup: 'default' }),
    getDeploymentId: async () => 'orch-deployment',
    getAccessToken: async () => 'token',
  },
}));

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));

import { executeWebSearch } from '../src/plugins/webSearch/searchExecutor';

const noopLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } as any;

describe('searchExecutor', () => {
  beforeEach(() => { mockPost.mockReset(); });

  it('returns parsed results from a Perplexity JSON payload', async () => {
    mockPost.mockResolvedValue({
      data: {
        choices: [{ message: { content: JSON.stringify({
          summary: 'Berlin is mild today.',
          results: [{ title: 'Weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry', date: 'July 2026' }],
        }) } }],
        citations: ['https://w.example/berlin'],
      },
    });

    const results = await executeWebSearch('weather in Berlin', noopLogger);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://w.example/berlin');
    expect(results[0].title).toBe('Weather');
  });

  it('returns an empty array instead of throwing when the search fails', async () => {
    mockPost.mockRejectedValue(new Error('upstream down'));

    const results = await executeWebSearch('anything', noopLogger);

    expect(results).toEqual([]);
  });
});
