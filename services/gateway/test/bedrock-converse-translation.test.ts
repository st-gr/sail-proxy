/**
 * Converse ↔ Anthropic Messages, for /aws-bedrock requests on models without a deployment: the
 * gateway serves them through SAP orchestration via the /anthropic flow, so a Converse request is
 * translated to an Anthropic Messages request on the way in, and the Anthropic answer to a Converse
 * answer on the way out. Errors take Bedrock's shape ({ message } plus x-amzn-ErrorType), which the
 * AWS SDKs read; with anything else they throw an "UnknownError".
 */
import { describe, it, expect } from '@jest/globals';
import { converseToAnthropicRequest, anthropicToConverseResponse, bedrockErrorOf, anthropicMessageToStreamEvents } from '../src/utils/bedrockConverse';

describe('converseToAnthropicRequest', () => {
  it('maps system, messages, inference settings and tools', () => {
    const out = converseToAnthropicRequest({
      system: [{ text: 'Be brief.' }, { cachePoint: { type: 'default' } }, { text: 'Use tools.' }],
      messages: [
        { role: 'user', content: [{ text: 'What is in the picture, and 2*3?' }, { image: { format: 'png', source: { bytes: 'UE5H' } } }] },
        { role: 'assistant', content: [{ text: 'Computing.' }, { toolUse: { toolUseId: 't1', name: 'Calculator', input: { input: '2*3' } } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [{ text: '6' }, { json: { exact: true } }], status: 'success' } }] },
      ],
      inferenceConfig: { maxTokens: 300, temperature: 0.2, topP: 0.9, stopSequences: ['END'] },
      toolConfig: {
        tools: [{ toolSpec: { name: 'Calculator', description: 'Math', inputSchema: { json: { type: 'object', properties: { input: { type: 'string' } } } } } }],
        toolChoice: { auto: {} },
      },
    }, 'anthropic--claude-4.5-haiku', false);
    expect(out).toEqual({
      model: 'anthropic--claude-4.5-haiku',
      stream: false,
      max_tokens: 300,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ['END'],
      system: 'Be brief.\nUse tools.',
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'What is in the picture, and 2*3?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
        ] },
        { role: 'assistant', content: [
          { type: 'text', text: 'Computing.' },
          { type: 'tool_use', id: 't1', name: 'Calculator', input: { input: '2*3' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '6' }, { type: 'text', text: '{"exact":true}' }], is_error: false },
        ] },
      ],
      tools: [{ name: 'Calculator', description: 'Math', input_schema: { type: 'object', properties: { input: { type: 'string' } } } }],
      tool_choice: { type: 'auto' },
    });
  });

  it('defaults max_tokens (Anthropic requires it), maps toolChoice any/tool, marks failed tool results', () => {
    const base = { messages: [{ role: 'user', content: [{ toolResult: { toolUseId: 'x', content: [{ text: 'boom' }], status: 'error' } }] }] };
    const any = converseToAnthropicRequest({ ...base, toolConfig: { tools: [], toolChoice: { any: {} } } }, 'm', true);
    expect(any.max_tokens).toBe(4096);
    expect(any.stream).toBe(true);
    expect(any.tool_choice).toEqual({ type: 'any' });
    expect(any.messages[0].content[0].is_error).toBe(true);
    expect(converseToAnthropicRequest({ ...base, toolConfig: { tools: [], toolChoice: { tool: { name: 'f' } } } }, 'm', false).tool_choice)
      .toEqual({ type: 'tool', name: 'f' });
    expect(converseToAnthropicRequest(base, 'm', false)).not.toHaveProperty('system');
  });
});

describe('anthropicToConverseResponse', () => {
  it('maps content, stop reason and usage', () => {
    expect(anthropicToConverseResponse({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'x',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'Let me compute.' },
        { type: 'tool_use', id: 't1', name: 'Calculator', input: { input: '2*3' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
    }, 1234)).toEqual({
      output: { message: { role: 'assistant', content: [
        { reasoningContent: { reasoningText: { text: 'hmm', signature: 'sig' } } },
        { text: 'Let me compute.' },
        { toolUse: { toolUseId: 't1', name: 'Calculator', input: { input: '2*3' } } },
      ] } },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 9, totalTokens: 35, cacheReadInputTokens: 4, cacheWriteInputTokens: 2 },
      metrics: { latencyMs: 1234 },
    });
  });

  it('a missing stop reason reads end_turn; no cache fields when there is no cache', () => {
    const out = anthropicToConverseResponse({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }, 0);
    expect(out.stopReason).toBe('end_turn');
    expect(out.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  });
});

describe('bedrockErrorOf', () => {
  it.each([
    [400, 'ValidationException'], [403, 'AccessDeniedException'], [404, 'ResourceNotFoundException'],
    [408, 'ModelTimeoutException'], [429, 'ThrottlingException'], [503, 'ServiceUnavailableException'], [500, 'InternalServerException'],
  ])('status %i is %s, with the message from an Anthropic or gateway error body', (status, type) => {
    expect(bedrockErrorOf(status, { type: 'error', error: { type: 'x', message: 'nope' } })).toEqual({ type, body: { message: 'nope' } });
    expect(bedrockErrorOf(status, { error: { message: 'gateway says' } }).body).toEqual({ message: 'gateway says' });
  });
});

/**
 * A stream the /anthropic flow answered without streaming (a model with neither native nor emulated
 * streaming, such as Amazon Nova) still has to reach a stream client as stream events.
 */
describe('anthropicMessageToStreamEvents', () => {
  it('replays a message as Anthropic stream events, text and tool use', () => {
    expect(anthropicMessageToStreamEvents({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'text', text: 'Computing.' }, { type: 'tool_use', id: 't1', name: 'Calculator', input: { input: '2*3' } }],
      stop_reason: 'tool_use', usage: { input_tokens: 7, output_tokens: 3 },
    })).toEqual([
      ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Computing.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Calculator', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"input":"2*3"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  });
});
