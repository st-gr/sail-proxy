/**
 * sapAIService endpoint + wire-shape tests
 *
 * Verify that the orchestration calls hit the V2 endpoint and emit a V2 wire
 * payload (config.modules.prompt_templating, no orchestration_config). These
 * tests exist specifically because the migration from V1 to V2 was a wire
 * change with very few existing assertions on the wire shape.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
  createSafePreview: (v: any) => JSON.stringify(v).slice(0, 200),
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: 'https://mock-sap.example.com', resourceGroup: 'default' }),
    getDeploymentId: () => Promise.resolve('mock-deployment-id'),
    getAccessToken: () => Promise.resolve('mock-token'),
    getTimeout: () => 30000,
  },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: { markModelAsNonStreaming: jest.fn() },
}));

const mockAxiosPost = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => (mockAxiosPost as any)(...args),
    isCancel: () => false,
  },
}));

import sapAIService from '../src/services/sapAIService';
import type { SapV2CompletionRequest } from '../src/services/sapOrchestrationTypes';

function v2Payload(overrides: Partial<SapV2CompletionRequest> = {}): SapV2CompletionRequest {
  return {
    config: {
      modules: {
        prompt_templating: {
          prompt: { template: [{ role: 'user', content: 'hi' }] },
          model: { name: 'gpt-4o-mini', version: 'latest', params: {} },
        },
      },
    },
    placeholder_values: {},
    messages_history: [],
    ...overrides,
  };
}

describe('sapAIService — V2 endpoint and wire shape', () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  it('completeChat POSTs to /v2/inference/deployments/{id}/v2/completion', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { request_id: 'r', final_result: { choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }] } },
    } as never);

    await sapAIService.completeChat(v2Payload());

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url] = (mockAxiosPost.mock.calls[0] as any[]) as [string, any, any];
    expect(url).toBe('https://mock-sap.example.com/v2/inference/deployments/mock-deployment-id/v2/completion');
  });

  it('completeChat sends a V2 wire body and never an orchestration_config envelope', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { request_id: 'r', final_result: { choices: [] } },
    } as never);

    await sapAIService.completeChat(v2Payload());

    const [, body] = (mockAxiosPost.mock.calls[0] as any[]) as [string, any, any];
    expect(body).toHaveProperty('config.modules.prompt_templating');
    expect(body.config.modules.prompt_templating).toHaveProperty('prompt.template');
    expect(body.config.modules.prompt_templating).toHaveProperty('model.name', 'gpt-4o-mini');
    expect(body).not.toHaveProperty('orchestration_config');
  });

  it('completeChat strips internal debugRequestId from the wire payload', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { request_id: 'r', final_result: { choices: [] } },
    } as never);

    const payload = v2Payload({ debugRequestId: 'should-not-leak' });
    await sapAIService.completeChat(payload);

    const [, body] = (mockAxiosPost.mock.calls[0] as any[]) as [string, any, any];
    expect(body).not.toHaveProperty('debugRequestId');
  });

  it('completeChat returns the V2 response data verbatim', async () => {
    const v2Response = {
      request_id: 'req-xyz',
      final_result: {
        id: 'chatcmpl-1',
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { content: 'hello world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      },
      intermediate_results: { templating: [] },
    };
    mockAxiosPost.mockResolvedValueOnce({ data: v2Response } as never);

    const result = await sapAIService.completeChat(v2Payload());

    expect(result).toEqual(v2Response);
  });

  it('callSAPAIOrchestration POSTs to /v2/inference/deployments/{id}/v2/completion', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { request_id: 'r', final_result: { choices: [] } },
    } as never);

    await sapAIService.callSAPAIOrchestration(v2Payload());

    const [url, body] = (mockAxiosPost.mock.calls[0] as any[]) as [string, any, any];
    expect(url).toBe('https://mock-sap.example.com/v2/inference/deployments/mock-deployment-id/v2/completion');
    expect(body).toHaveProperty('config.modules.prompt_templating');
    expect(body).not.toHaveProperty('orchestration_config');
  });
});
