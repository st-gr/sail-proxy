/**
 * Chat Completions ⇄ Responses translation for deployed models that refuse function tools on
 * /chat/completions but take them on /responses (gpt-6.1-sol in the 0.11.0 rollout).
 */
import { describe, it, expect } from '@jest/globals';
import { chatToResponsesRequest, responsesToChatCompletion, isChatToolsRefusal, ChatBridgeUnsupported } from '../src/responses/chatBridge';

describe('chatToResponsesRequest', () => {
  it('maps messages, tool calls, tool results, tools, tool_choice and limits', () => {
    const body = {
      model: 'gpt-6.1-sol',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'Weather?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"weather"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
        { role: 'assistant', content: 'It is sunny.' },
        { role: 'user', content: 'Thanks' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } } }, strict: true } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      max_completion_tokens: 500,
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } },
      parallel_tool_calls: false,
      temperature: 1,
      user: 'u-1',
    };
    expect(chatToResponsesRequest(body)).toEqual({
      model: 'gpt-6.1-sol',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Be brief.' }] },
        { type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'Weather?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' },
        ] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"weather"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'Sunny' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It is sunny.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks' }] },
      ],
      tools: [{ type: 'function', name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } } }, strict: true }],
      tool_choice: { type: 'function', name: 'lookup' },
      max_output_tokens: 500,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } },
      parallel_tool_calls: false,
      temperature: 1,
      user: 'u-1',
      store: false,
    });
  });

  it('a function tool without strict stays non-strict (chat\'s default; Responses would make it strict)', () => {
    const out = chatToResponsesRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { a: { type: 'string' } } } } }] });
    expect(out.tools[0].strict).toBe(false);
  });

  it('takes max_tokens as well, and passes string tool_choice values through', () => {
    const out = chatToResponsesRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 7, tool_choice: 'required' });
    expect(out.max_output_tokens).toBe(7);
    expect(out.tool_choice).toBe('required');
  });

  it('refuses what Responses cannot express in this bridge (n > 1, non-function tools)', () => {
    expect(() => chatToResponsesRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], n: 2 })).toThrow(ChatBridgeUnsupported);
    expect(() => chatToResponsesRequest({ model: 'm', messages: [], tools: [{ type: 'web_search' }] })).toThrow(ChatBridgeUnsupported);
  });
});

describe('responsesToChatCompletion', () => {
  it('maps text, function calls, finish_reason and usage', () => {
    const resp = {
      id: 'resp_1', created_at: 1786000000, status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
        { type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '{"q":"x"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } },
    };
    expect(responsesToChatCompletion(resp, 'gpt-6.1-sol')).toEqual({
      id: 'resp_1', object: 'chat.completion', created: 1786000000, model: 'gpt-6.1-sol',
      choices: [{
        index: 0, finish_reason: 'tool_calls',
        message: { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } },
    });
  });

  it('an incomplete answer cut by max_output_tokens finishes with length; no output text is null content', () => {
    const out = responsesToChatCompletion({ id: 'r', created_at: 1, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'm');
    expect(out.choices[0]).toEqual({ index: 0, finish_reason: 'length', message: { role: 'assistant', content: null } });
  });
});

describe('isChatToolsRefusal', () => {
  const err = (status: number, message: string) => ({ response: { status, data: { error: { message } } } });
  it('recognises a deployment refusing function tools on chat/completions', () => {
    expect(isChatToolsRefusal(err(400, 'Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. Please use /v1/responses instead.'))).toBe(true);
  });
  it('ignores other 400s and other statuses', () => {
    expect(isChatToolsRefusal(err(400, "Invalid value for 'temperature'"))).toBe(false);
    expect(isChatToolsRefusal(err(500, 'Function tools are not supported, use /v1/responses'))).toBe(false);
  });
});
