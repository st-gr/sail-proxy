/**
 * anthropicService — V2 payload construction tests
 *
 * Verifies that transformRequestToSAPFormat emits a V2-shaped payload:
 *   { config: { modules: { prompt_templating: { prompt, model } }, stream? },
 *     placeholder_values: {}, messages_history: [] }
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

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_provider: string, model: string) => model,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
  },
  getConfig: () => ({}),
  getConfigAsync: () => Promise.resolve({ api_config: { default_models: { anthropic: 'claude-3-5-haiku-20241022' } } }),
  getSubstitutedModel: (_provider: string, model: string) => model,
  getHookConfig: () => undefined,
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: () => Promise.resolve({ owned_by: 'anthropic' }),
  },
  getModelDetails: () => Promise.resolve({ owned_by: 'anthropic' }),
}));

import { transformRequestToSAPFormat } from '../src/services/anthropicService';

describe('anthropicService.transformRequestToSAPFormat — V2 wire shape', () => {
  it('produces the V2 envelope for a plain text request', async () => {
    const payload = await transformRequestToSAPFormat({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 256,
    });

    expect(payload).toHaveProperty('config.modules.prompt_templating.prompt.template');
    expect(payload).toHaveProperty('config.modules.prompt_templating.model.name', 'claude-3-5-haiku-20241022');
    expect(payload).toHaveProperty('placeholder_values', {});
    expect(payload).toHaveProperty('messages_history', []);
    expect(payload).not.toHaveProperty('orchestration_config');
    expect(payload).not.toHaveProperty('input_params');
  });

  it('places tools on prompt.tools (not on model.params.tools)', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    });

    const promptTemplating = payload.config.modules.prompt_templating;
    expect(Array.isArray(promptTemplating.prompt.tools)).toBe(true);
    expect(promptTemplating.prompt.tools.length).toBeGreaterThan(0);
    // tools should NOT also live in model.params
    expect(promptTemplating.model.params).not.toHaveProperty('tools');
  });

  it('places tool_choice on model.params.tool_choice (OpenAI-style)', async () => {
    // Use a string 'auto' which transformToolChoiceToSAPFormat maps to 'auto'
    const payload: any = await transformRequestToSAPFormat({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: {} },
      }],
      tool_choice: 'auto',
    });

    const params = payload.config.modules.prompt_templating.model.params;
    expect(params).toHaveProperty('tool_choice', 'auto');
  });

  it('sets config.stream.enabled = true when stream is requested', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      stream: true,
    });

    expect(payload.config.stream).toEqual({ enabled: true });
  });

  it('omits config.stream when stream is not requested', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
    });

    expect(payload.config.stream).toBeUndefined();
  });
});
