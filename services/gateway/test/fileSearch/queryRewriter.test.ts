/**
 * Unit tests for `rewriteSearchQuery` (axios and `configService` mocked, no
 * network) — the behaviour that matters most here is the SAME class of
 * degrade contract `reranker.ts` has: a rewrite is a best-effort
 * optimisation, so no failure mode (no deployment, a network/timeout error,
 * a malformed response body) may ever propagate out of this function. Every
 * failure branch below is a mutation-resistant test: removing the
 * surrounding try/catch, or any individual guard, makes its own named test
 * fail (verified by hand — see task-12-report.md) rather than merely being
 * "reachable".
 *
 * Also covers the model being config-driven (`hybrid`-sibling
 * `rewriteQueryModel`, mirroring `hybrid.rerank.model`) rather than a
 * hardcoded constant — `gpt-35-turbo-16k` (this codebase's usual
 * no-model-specified fallback elsewhere) was probed live against the tenant
 * and returns HTTP 400 here, which is exactly why this must never be a
 * constant again.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockLogger = {
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
};
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => mockLogger,
}));

let mockFileSearchConfig: any;
const getDeploymentIdMock = jest.fn<(...args: any[]) => Promise<string | null>>();

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    getDeploymentId: (...a: any[]) => getDeploymentIdMock(...(a as [])),
    getSAPAICoreConfig: () => ({ url: 'https://sap.example', resourceGroup: 'default' }),
    getAccessToken: async () => 'test-token',
    getFileSearchConfig: () => mockFileSearchConfig,
  },
}));

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

import { rewriteSearchQuery } from '../../src/fileSearch/queryRewriter';

const DEPLOYMENT_ID = 'd-test-deployment';
const QUERY = 'what did the EMEA report say about Q3 revenue';

function mockCompletionResponse(content: string): void {
  mockPost.mockResolvedValueOnce({
    data: { final_result: { choices: [{ message: { content } }] } },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFileSearchConfig = { rewriteQueryModel: 'gpt-4o-mini' };
  getDeploymentIdMock.mockResolvedValue(DEPLOYMENT_ID);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe('successful rewrite', () => {
  it('returns the rewritten text, trimmed', async () => {
    mockCompletionResponse('  EMEA report Q3 revenue  ');
    const result = await rewriteSearchQuery(QUERY);
    expect(result).toBe('EMEA report Q3 revenue');
  });

  it('sends the config-driven model, never a hardcoded one', async () => {
    mockFileSearchConfig = { rewriteQueryModel: 'some-other-model' };
    mockCompletionResponse('rewritten');
    await rewriteSearchQuery(QUERY);
    const payload = mockPost.mock.calls[0][1];
    expect(payload.config.modules.prompt_templating.model.name).toBe('some-other-model');
  });

  it('never sends gpt-35-turbo-16k — probed live and confirmed to 400 on this tenant', async () => {
    mockCompletionResponse('rewritten');
    await rewriteSearchQuery(QUERY);
    const payload = mockPost.mock.calls[0][1];
    expect(payload.config.modules.prompt_templating.model.name).not.toBe('gpt-35-turbo-16k');
    expect(payload.config.modules.prompt_templating.model.name).toBe('gpt-4o-mini');
  });

  it('hits the orchestration /v2/completion path for the discovered deployment', async () => {
    mockCompletionResponse('rewritten');
    await rewriteSearchQuery(QUERY);
    expect(mockPost.mock.calls[0][0]).toBe(`https://sap.example/v2/inference/deployments/${DEPLOYMENT_ID}/v2/completion`);
  });
});

// ---------------------------------------------------------------------------
// Degrade contract: NOTHING here may ever reject or throw.
// ---------------------------------------------------------------------------
describe('degrades to the original query on every failure path (never throws)', () => {
  it('no orchestration deployment discoverable', async () => {
    getDeploymentIdMock.mockResolvedValue(null);
    await expect(rewriteSearchQuery(QUERY)).resolves.toBe(QUERY);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('the completion call rejects (network error / timeout)', async () => {
    mockPost.mockRejectedValueOnce(new Error('timeout of 10000ms exceeded'));
    await expect(rewriteSearchQuery(QUERY)).resolves.toBe(QUERY);
  });

  it('the completion call rejects with an axios-style error carrying a response', async () => {
    const axiosError: any = new Error('Request failed with status code 400');
    axiosError.response = { status: 400, data: { error: 'Model name is not supported' } };
    mockPost.mockRejectedValueOnce(axiosError);
    await expect(rewriteSearchQuery(QUERY)).resolves.toBe(QUERY);
  });

  it('the response body is missing final_result entirely', async () => {
    mockPost.mockResolvedValueOnce({ data: {} });
    await expect(rewriteSearchQuery(QUERY)).resolves.toBe(QUERY);
  });

  it('the response content is an empty string', async () => {
    mockCompletionResponse('');
  await expect(rewriteSearchQuery(QUERY)).resolves.toBe(QUERY);
  });

  it('the response content is whitespace only', async () => {
    mockCompletionResponse('   \n\t  ');
    await expect(rewriteSearchQuery(QUERY)).resolves.toBe(QUERY);
  });

  it('the response content is not a string at all', async () => {
    mockPost.mockResolvedValueOnce({ data: { final_result: { choices: [{ message: { content: 12345 } }] } } });
    await expect(rewriteSearchQuery(QUERY)).resolves.toBe(QUERY);
  });

  it('getDeploymentId itself rejects', async () => {
    getDeploymentIdMock.mockRejectedValue(new Error('deployment discovery blew up'));
    await expect(rewriteSearchQuery(QUERY)).resolves.toBe(QUERY);
  });

  it('logs the failure at debug only, never info/warn/error, and never logs the query text', async () => {
    mockPost.mockRejectedValueOnce(new Error('boom'));
    await rewriteSearchQuery(QUERY);
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalled();
    for (const call of mockLogger.debug.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(QUERY);
    }
  });
});
