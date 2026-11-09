import { describe, it, expect } from '@jest/globals';
import { classifyFrame, rawToString, usageMetricsFromResponseDone } from '../../src/realtime/realtimeObserver';

const text = (event: any) => Buffer.from(JSON.stringify(event));

describe('classifyFrame', () => {
  it('recognises session.created with its session id', () => {
    expect(classifyFrame(text({ type: 'session.created', session: { id: 'sess_1', model: 'gpt-realtime' } }), false))
      .toEqual({ kind: 'session.created', sessionId: 'sess_1' });
  });
  it('recognises response.created with its response id', () => {
    expect(classifyFrame(text({ type: 'response.created', response: { id: 'resp_1' } }), false))
      .toEqual({ kind: 'response.created', responseId: 'resp_1' });
    expect(classifyFrame(text({ type: 'response.created' }), false)).toEqual({ kind: 'response.created', responseId: null });
  });
  it('recognises response.done and carries its usage object', () => {
    const usage = { total_tokens: 30, input_tokens: 20, output_tokens: 10, input_token_details: { cached_tokens: 5 } };
    expect(classifyFrame(text({ type: 'response.done', response: { id: 'r', usage } }), false)).toEqual({ kind: 'response.done', responseId: 'r', usage });
  });
  it('reports a response.done without usage as usage null', () => {
    expect(classifyFrame(text({ type: 'response.done', response: { id: 'r' } }), false)).toEqual({ kind: 'response.done', responseId: 'r', usage: null });
    expect(classifyFrame(text({ type: 'response.done' }), false)).toEqual({ kind: 'response.done', responseId: null, usage: null });
  });
  it('recognises the error event', () => {
    expect(classifyFrame(text({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), false))
      .toEqual({ kind: 'error', error: { type: 'invalid_request_error', message: 'bad' } });
  });
  it('treats every other event, binary frames and non-JSON as other', () => {
    expect(classifyFrame(text({ type: 'response.output_text.delta', delta: 'hi' }), false)).toEqual({ kind: 'other' });
    expect(classifyFrame(text({ type: 'response.done' }), true)).toEqual({ kind: 'other' });
    expect(classifyFrame(Buffer.from('not json'), false)).toEqual({ kind: 'other' });
    expect(classifyFrame(Buffer.from('"a string"'), false)).toEqual({ kind: 'other' });
    expect(classifyFrame('42', false)).toEqual({ kind: 'other' });
  });
  it('accepts a string, a Buffer, a Buffer[] and an ArrayBuffer', () => {
    const json = JSON.stringify({ type: 'response.created', response: { id: 'x' } });
    expect(classifyFrame(json, false).kind).toBe('response.created');
    expect(classifyFrame([Buffer.from(json.slice(0, 10)), Buffer.from(json.slice(10))], false).kind).toBe('response.created');
    const ab = new Uint8Array(Buffer.from(json)).buffer;
    expect(classifyFrame(ab, false).kind).toBe('response.created');
    expect(rawToString([Buffer.from('a'), Buffer.from('b')])).toBe('ab');
  });
});

describe('usageMetricsFromResponseDone', () => {
  it('emits the full-rate input share, cached tokens once, and the audio split of both directions', () => {
    const usage = {
      total_tokens: 130, input_tokens: 100, output_tokens: 30,
      input_token_details: { text_tokens: 40, audio_tokens: 55, image_tokens: 0, cached_tokens: 5 },
      output_token_details: { text_tokens: 10, audio_tokens: 20 },
    };
    expect(usageMetricsFromResponseDone(usage, 1234)).toEqual({
      startTime: 1234, inputTokens: 95, outputTokens: 30, cacheReadInputTokens: 5, audioInputTokens: 55, audioOutputTokens: 20,
    });
  });
  it('treats cached audio as cached, not as audio (spec decision 1)', () => {
    const usage = {
      input_tokens: 100, output_tokens: 0,
      input_token_details: { audio_tokens: 55, cached_tokens: 20, cached_tokens_details: { text_tokens: 12, audio_tokens: 8 } },
    };
    expect(usageMetricsFromResponseDone(usage, 1)).toMatchObject({ inputTokens: 80, cacheReadInputTokens: 20, audioInputTokens: 47, audioOutputTokens: 0 });
  });
  it('clamps audio figures to their totals and never goes negative', () => {
    expect(usageMetricsFromResponseDone({
      input_tokens: 10, output_tokens: 5,
      input_token_details: { audio_tokens: 50, cached_tokens: 0 }, output_token_details: { audio_tokens: 9 },
    }, 1)).toMatchObject({ inputTokens: 10, audioInputTokens: 10, audioOutputTokens: 5 });
    expect(usageMetricsFromResponseDone({ input_tokens: 3, input_token_details: { cached_tokens: 10 } }, 1))
      .toMatchObject({ inputTokens: 0, cacheReadInputTokens: 10, audioInputTokens: 0 });
  });
  it('defaults every missing or non-numeric figure to 0', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, audioInputTokens: 0, audioOutputTokens: 0 };
    expect(usageMetricsFromResponseDone({}, 7)).toEqual({ startTime: 7, ...zero });
    expect(usageMetricsFromResponseDone({ input_tokens: 'x' as any, output_tokens: NaN, input_token_details: {}, output_token_details: { audio_tokens: 'y' as any } }, 7))
      .toEqual({ startTime: 7, ...zero });
  });
});
