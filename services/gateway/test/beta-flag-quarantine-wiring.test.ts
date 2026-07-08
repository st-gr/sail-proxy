/**
 * Integration test: beta-flag quarantine wired into awsBedrockService.
 *
 * Exercises the real `processBedrockRequest` native (invoke) path: a first
 * request that upstream rejects with a 400 "invalid beta flag" quarantines
 * the sent flags, and a second request for the same model then omits the
 * quarantined flag from the outbound payload.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));

const mockPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => (mockPost as any)(...args),
  },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: jest.fn().mockResolvedValue({
      id: 'test-model',
      executableId: 'aws-bedrock',
      deploymentUrl: 'http://mock-sap/x',
      anthropic_version: 'bedrock-2023-05-31',
      subpaths_native: ['invoke'],
    } as never),
    getAuthToken: jest.fn().mockResolvedValue('tok' as never),
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportedBetaHeaders: () => [],
    getExcludedBetaHeaders: () => [],
    getTimeout: () => 1000,
    getConfig: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap' }),
  },
}));

jest.mock('../src/services/rateLimitManager', () => ({
  __esModule: true,
  default: {
    checkAndApplyDelay: jest.fn().mockResolvedValue(0 as never),
    recordSuccess: jest.fn(),
    isRateLimitError: jest.fn(() => false),
    recordRateLimit: jest.fn().mockResolvedValue(undefined as never),
  },
}));

jest.mock('../src/utils/usageTracker', () => ({
  __esModule: true,
  emitUsageEvent: jest.fn(),
  updateTokenCounts: jest.fn(),
}));

jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeAfterPlugins: jest.fn(async (_req: any, _res: any, data: any) => data),
  executeStreamPlugins: jest.fn(async (_req: any, _res: any, chunk: any) => chunk),
}));

import processBedrockRequestModule from '../src/services/awsBedrockService';
import { getQuarantinedFlags, clearQuarantine } from '../src/services/betaFlagQuarantine';

const { processBedrockRequest } = processBedrockRequestModule as any;

function buildOptions(requestBody: any) {
  return {
    modelId: 'test-model',
    originalModelId: 'test-model',
    subpath: 'invoke',
    requestBody,
    headers: { 'anthropic-beta': 'bad-flag-2026-01-01' },
    debugRequestId: '',
    req: {} as any,
    res: {} as any,
  };
}

describe('beta flag quarantine wiring (awsBedrockService)', () => {
  beforeEach(() => {
    clearQuarantine();
    mockPost.mockReset();
  });

  it('quarantines the rejected flag after a 400, then omits it from the next request', async () => {
    mockPost.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { type: 'error', error: { type: 'invalid_request_error', message: 'invalid beta flag' } },
      },
      message: 'Request failed with status code 400',
    } as never);

    await expect(
      processBedrockRequest(buildOptions({ max_tokens: 1, messages: [] }))
    ).rejects.toMatchObject({ message: 'Request failed with status code 400' });

    expect(getQuarantinedFlags('test-model')).toEqual(['bad-flag-2026-01-01']);

    mockPost.mockResolvedValueOnce({ data: { ok: true } } as never);

    await processBedrockRequest(buildOptions({ max_tokens: 1, messages: [] }));

    expect(mockPost).toHaveBeenCalledTimes(2);
    const secondCallBody = mockPost.mock.calls[1][1] as any;
    expect(secondCallBody).not.toHaveProperty('anthropic_beta');
  });
});
