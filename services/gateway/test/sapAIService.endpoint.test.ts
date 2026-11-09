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

describe('sapAIService.streamChatCompletion — which 400 means "streaming not supported"', () => {
  const modelService = require('../src/services/modelService').default;
  const reject400 = (body: unknown) => {
    const error: any = new Error('Request failed with status code 400');
    error.response = { status: 400, statusText: 'Bad Request', data: JSON.stringify(body) };
    mockAxiosPost.mockRejectedValueOnce(error as never);
  };
  const streamPayload = () => {
    const p: any = v2Payload();
    p.config.stream = { enabled: true };
    return p;
  };

  beforeEach(() => {
    mockAxiosPost.mockReset();
    (modelService.markModelAsNonStreaming as jest.Mock).mockClear();
  });

  it('orchestration refusing the model ("Model name … is not supported") is not read as no streaming, even with "streaming" in the body', async () => {
    // 2026-10-29: gpt-6.1-sol was refused by orchestration; "streaming" appeared elsewhere in the
    // body, so the model was marked non-streaming and the client saw "Error in non-streaming retry".
    reject400({
      error: {
        code: 400,
        message: "400 - Request Body: Model name 'gpt-6.1-sol' is not supported. Model name must be one of: gpt-5, gpt-5-mini.",
        intermediate_results: { templating: [{ role: 'user', content: 'is streaming not supported for you?' }] },
      },
    });
    const error: any = await sapAIService.streamChatCompletion(streamPayload(), () => {}).catch((e: any) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.streamingNotSupported).toBeUndefined();
    expect(error.status).toBe(400);
    expect(modelService.markModelAsNonStreaming).not.toHaveBeenCalled();
  });

  it('SAP\'s own "Streaming is not supported for this model" is still recognised, and the model is marked', async () => {
    // Marked here (review S2): /anthropic, /responses and /google read modelSupportsStreaming but do
    // not retry themselves, so only this mark turns their next request non-streaming.
    reject400({ error: { code: 400, message: '400 - Request Body: Streaming is not supported for this model.' } });
    const error: any = await sapAIService.streamChatCompletion(streamPayload(), () => {}).catch((e: any) => e);
    expect(error.streamingNotSupported).toBe(true);
    expect(modelService.markModelAsNonStreaming).toHaveBeenCalledWith('gpt-4o-mini');
  });
});
