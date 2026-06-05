/**
 * openaiController — V2 payload construction tests
 *
 * Verify transformRequestToSAPFormat builds a V2-shaped payload:
 *   { config: { modules: { prompt_templating: { prompt, model } }, stream? },
 *     placeholder_values: {}, messages_history: [...] }
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: () => Promise.resolve({ id: 'gpt-4o-mini', owned_by: 'openai' }),
    modelSupportsStreaming: () => true,
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    shouldEmulateStreaming: () => false,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
  },
}));

jest.mock('../src/utils/modelUtils', () => ({
  mapModelParameters: (p: Record<string, any>) => ({ ...p }),
  getDefaultParameters: () => ({}),
}));

import { transformRequestToSAPFormat } from '../src/controllers/openaiController';

describe('openaiController.transformRequestToSAPFormat — V2 wire shape', () => {
  it('produces the V2 envelope for a plain text request', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 256,
    });

    expect(payload).toHaveProperty('config.modules.prompt_templating.prompt.template');
    expect(payload).toHaveProperty('config.modules.prompt_templating.model.name', 'gpt-4o-mini');
    expect(payload).toHaveProperty('placeholder_values', {});
    expect(payload).toHaveProperty('messages_history');
    expect(payload).not.toHaveProperty('orchestration_config');
  });

  it('places tools on prompt.tools', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      tools: [{
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
      }],
    });

    expect(Array.isArray(payload.config.modules.prompt_templating.prompt.tools)).toBe(true);
  });

  it('places tool_choice on model.params.tool_choice (OpenAI-style)', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      tools: [{
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
      }],
      tool_choice: 'auto',
    });

    expect(payload.config.modules.prompt_templating.model.params).toHaveProperty('tool_choice', 'auto');
  });

  it('places response_format on prompt.response_format', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      response_format: { type: 'json_object' },
    });

    expect(payload.config.modules.prompt_templating.prompt).toHaveProperty('response_format', { type: 'json_object' });
  });

  it('sets config.stream as a structured object when stream is requested', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      stream: true,
    });

    expect(payload.config.stream).toEqual({ enabled: true, chunk_size: 200 });
  });

  it('omits config.stream when stream is not requested', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
    });

    expect(payload.config.stream).toBeUndefined();
  });

  it('sets stream_options.include_usage on model.params for OpenAI providers when streaming', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      stream: true,
    });

    expect(payload.config.modules.prompt_templating.model.params).toHaveProperty('stream_options.include_usage', true);
  });
});
