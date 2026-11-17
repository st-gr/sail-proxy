/**
 * Streaming emulation on the Responses bridge: a whole, non-streamed orchestration
 * answer turned into what the stream translator reads, so a model listed in
 * `emulate_streaming_for_models` is called without streaming and still answered as a stream.
 */
import { describe, it, expect } from '@jest/globals';
import { envelopeToStreamChunk, envelopeAsSseStream } from '../src/responses/orchestrationBridge/streamEmulation';
import { createResponsesStreamTranslator, createOrchestrationBlockTranslator } from '../src/responses/orchestrationBridge/streamTranslator';
import { translateOrchestrationResponse } from '../src/responses/orchestrationBridge/responseTranslator';

const OPTS = { model: 'gemini-3.5-flash', sapModel: 'gemini-3.5-flash', responseId: 'resp_test' };

// What orchestration answers WITHOUT streaming for "text, then two calls in one step"
// (shape measured live 2026-11-12 on gemini-3.5-flash; ids shortened, values invented).
const ENVELOPE = {
  request_id: 'req-1',
  final_result: {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'I will look up both cities.',
        tool_calls: [
          { id: 'vertex_tool_a__sig_s1', type: 'function', function: { name: 'get_temperature', arguments: '{"city": "Oslo"}' } },
          { id: 'vertex_tool_b', type: 'function', function: { name: 'get_temperature', arguments: '{"city": "Lima"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  },
};

const frames = (blocks: string[]) => blocks.map((b) => JSON.parse(b.replace(/^data: /, '').trim()));
const withoutIds = (output: any[]) => output.map(({ id: _id, ...rest }) => rest);

describe('envelopeToStreamChunk', () => {
  it('gives every tool call its own index, so the calls stay apart', () => {
    const chunk = envelopeToStreamChunk(ENVELOPE);
    expect(chunk.final_result.choices[0].delta.tool_calls.map((c: any) => [c.index, c.id, c.function.arguments])).toEqual([
      [0, 'vertex_tool_a__sig_s1', '{"city": "Oslo"}'],
      [1, 'vertex_tool_b', '{"city": "Lima"}'],
    ]);
  });

  it('carries the text, the finish reason and the usage', () => {
    const chunk = envelopeToStreamChunk(ENVELOPE);
    expect(chunk.final_result.choices[0].delta.content).toBe('I will look up both cities.');
    expect(chunk.final_result.choices[0].finish_reason).toBe('tool_calls');
    expect(chunk.final_result.usage).toEqual(ENVELOPE.final_result.usage);
    expect(chunk.request_id).toBe('req-1');
  });

  it('streams to the SAME output the non-streaming translator builds from the envelope', () => {
    const translator = createResponsesStreamTranslator(OPTS);
    const all = frames([...translator.onChunk(envelopeToStreamChunk(ENVELOPE)), ...translator.finish()]);
    const terminal = all[all.length - 1];
    expect(terminal.type).toBe('response.completed');

    const whole = translateOrchestrationResponse(ENVELOPE, OPTS);
    expect(withoutIds(terminal.response.output)).toEqual(withoutIds(whole.output));
    expect(terminal.response.usage).toEqual(whole.usage);
  });

  it('carries reasoning, which both translators read in the same shape', () => {
    const envelope = { final_result: { choices: [{ message: {
      reasoning_content: [{ content: 'thinking it over', signature: 'sig' }], content: 'Done.',
    }, finish_reason: 'stop' }] } };
    const translator = createResponsesStreamTranslator(OPTS);
    const all = frames([...translator.onChunk(envelopeToStreamChunk(envelope)), ...translator.finish()]);
    const output = all[all.length - 1].response.output;
    expect(output.map((o: any) => o.type)).toEqual(['reasoning', 'message']);
    expect(withoutIds(output)).toEqual(withoutIds(translateOrchestrationResponse(envelope, OPTS).output));
  });

  it('accepts an envelope without the final_result wrapper and an answer without content', () => {
    const chunk = envelopeToStreamChunk({ choices: [{ message: { content: null }, finish_reason: 'stop' }] });
    expect(chunk.final_result.choices[0].delta).toEqual({});
    expect(chunk.final_result.choices[0].finish_reason).toBe('stop');
  });

  it('does not throw on an empty answer', () => {
    expect(envelopeToStreamChunk(undefined).final_result.choices[0].delta).toEqual({});
  });
});

describe('envelopeAsSseStream', () => {
  it('is orchestration\'s wire format: the block translator reads it like a real stream', async () => {
    let text = '';
    for await (const piece of envelopeAsSseStream(ENVELOPE)) text += piece.toString();
    const blocks = text.split('\n\n').filter(Boolean).map((b) => `${b}\n\n`);
    expect(blocks[blocks.length - 1].trim()).toBe('data: [DONE]');

    const translator = createOrchestrationBlockTranslator(OPTS);
    const all = frames([...blocks.flatMap((b) => translator.onBlock(b)), ...translator.finish()]);
    const calls = all[all.length - 1].response.output.filter((o: any) => o.type === 'function_call');
    expect(calls.map((c: any) => c.arguments)).toEqual(['{"city": "Oslo"}', '{"city": "Lima"}']);
  });
});
