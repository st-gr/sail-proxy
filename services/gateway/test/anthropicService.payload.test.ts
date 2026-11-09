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

/**
 * A tool round trip on the orchestration path. The translation used to keep only each message's
 * text: an assistant turn of tool_use blocks became an empty assistant message and the user's
 * tool_result turn an empty user message, so SAP refused the second turn ("Assistant message has
 * neither text nor tool_use blocks." / "user messages must have non-empty content"). n8n's AI Agent
 * sends exactly this. Orchestration takes the OpenAI shape: assistant `tool_calls` (content '' when
 * there is no text) and one `tool` message per result, content a plain string.
 */
describe('anthropicService.transformRequestToSAPFormat — tool round trip', () => {
  const template = async (messages: any[]) =>
    ((await transformRequestToSAPFormat({ model: 'anthropic--claude-4.5-haiku', max_tokens: 64, messages } as any)) as any)
      .config.modules.prompt_templating.prompt.template;

  it('an assistant turn of only tool_use becomes tool_calls with empty content', async () => {
    const t = await template([
      { role: 'user', content: 'compute 2*3' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Calculator', input: { input: '2*3' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[{"response":"6"}]' }] },
    ]);
    expect(t).toEqual([
      { role: 'user', content: 'compute 2*3' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Calculator', arguments: '{"input":"2*3"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: '[{"response":"6"}]' },
    ]);
  });

  it('text before the call stays on the assistant message; text after the results follows them as a user message', async () => {
    const t = await template([
      { role: 'user', content: 'weather in Paris and Rome?' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Checking both.' },
        { type: 'tool_use', id: 'a', name: 'weather', input: { city: 'Paris' } },
        { type: 'tool_use', id: 'b', name: 'weather', input: { city: 'Rome' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'sunny' }, { type: 'text', text: '21 C' }] },
        { type: 'tool_result', tool_use_id: 'b', content: 'rain', is_error: false },
        { type: 'text', text: 'Answer briefly.' },
      ] },
    ]);
    expect(t.slice(1)).toEqual([
      { role: 'assistant', content: 'Checking both.', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } },
        { id: 'b', type: 'function', function: { name: 'weather', arguments: '{"city":"Rome"}' } },
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'sunny\n21 C' },
      { role: 'tool', tool_call_id: 'b', content: 'rain' },
      { role: 'user', content: 'Answer briefly.' },
    ]);
  });

  it('a failed tool result keeps its error marker; a tool_use without input sends {}', async () => {
    const t = await template([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'ping' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'timeout', is_error: true }] },
    ]);
    expect(t[1].tool_calls[0].function.arguments).toBe('{}');
    expect(t[2]).toEqual({ role: 'tool', tool_call_id: 'x', content: 'Error: timeout' });
  });

  it('plain text conversations are unchanged', async () => {
    const t = await template([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'assistant', content: 'c' },
    ]);
    expect(t).toEqual([{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'c' }]);
  });
});

/**
 * Images on the orchestration path. The translation kept only text, so a picture never reached the
 * model, which then answered as if there were none. Orchestration takes content blocks: text as
 * {type:'text'}, images as {type:'image_url'} with a data URI (base64 sources) or the URL itself.
 */
describe('anthropicService.transformRequestToSAPFormat — images', () => {
  const template = async (messages: any[]) =>
    ((await transformRequestToSAPFormat({ model: 'anthropic--claude-4.5-haiku', max_tokens: 64, messages } as any)) as any)
      .config.modules.prompt_templating.prompt.template;

  it('a base64 image and a URL image become image_url blocks, in order with the text', async () => {
    const t = await template([{ role: 'user', content: [
      { type: 'text', text: 'What is in these?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
    ] }]);
    expect(t).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'What is in these?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
    ] }]);
  });

  it('an image next to a tool result follows the tool messages as a user message', async () => {
    const t = await template([
      { role: 'user', content: 'take a screenshot' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 's', name: 'screenshot', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 's', content: 'saved' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
      ] },
    ]);
    expect(t.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 's', content: 'saved' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,UE5H' } }] },
    ]);
  });
});
