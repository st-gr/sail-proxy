/**
 * Orchestration stream chunks -> Gemini `streamGenerateContent` SSE frames.
 *
 * The streaming third of the Gemini bridge (requestTranslator.ts and
 * responseTranslator.ts are the other two). Input chunks are shaped exactly
 * as `sapAIService.streamChatCompletion` delivers them to its `onChunk`
 * callback, so the fixtures below follow the live capture in
 * test/fixtures/orchestration/cache-probe-result.md: three data chunks, the
 * last one carrying the content delta, `finish_reason` AND `usage` together.
 *
 * See spec section 6 "Translation rules (bridge)" -> Stream for the binding
 * rules this file pins.
 */
import { describe, it, expect } from '@jest/globals';
import { createGeminiStreamTranslator } from '../src/google/orchestrationBridge/streamTranslator';

const MODEL = 'anthropic--claude-4.8-opus';

/** Every emitted string must be one complete `data: {json}\n\n` block. */
function parse(frames: string[]): any[] {
  return frames.map((frame) => {
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    return JSON.parse(frame.slice('data: '.length, -2));
  });
}

/** A chunk the way SAP wraps it: everything under `final_result`. */
function chunk(choice: any, usage?: any): any {
  return { final_result: { choices: [choice], ...(usage ? { usage } : {}) } };
}

function textChunk(content: string): any {
  return chunk({ index: 0, delta: { content }, finish_reason: null });
}

function toolChunk(call: any): any {
  return chunk({ index: 0, delta: { tool_calls: [call] }, finish_reason: null });
}

/** The usage SAP sent on the final chunk of the captured probe run. */
const SAP_USAGE = {
  completion_tokens: 8, prompt_tokens: 28, total_tokens: 36,
  prompt_tokens_details: { cached_tokens: 0 },
};

describe('createGeminiStreamTranslator - text deltas', () => {
  it('emits one frame per text delta, each a Gemini candidate part', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });

    const first = parse(t.onChunk(textChunk('Hello')));
    const second = parse(t.onChunk(textChunk(' world')));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].candidates[0]).toEqual({ content: { role: 'model', parts: [{ text: 'Hello' }] }, index: 0 });
    expect(second[0].candidates[0].content.parts[0].text).toBe(' world');
    // No terminal fields until the turn actually ends.
    expect(first[0]).not.toHaveProperty('usageMetadata');
    expect(first[0].candidates[0]).not.toHaveProperty('finishReason');
    expect(first[0].modelVersion).toBe(MODEL);
  });

  it('reads a chunk that arrives without the final_result wrapper', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    const frames = parse(t.onChunk({ choices: [{ index: 0, delta: { content: 'bare' }, finish_reason: null }] }));
    expect(frames[0].candidates[0].content.parts).toEqual([{ text: 'bare' }]);
  });

  it('emits nothing for an empty delta, a role-only opener or the [DONE] marker chunk', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    expect(t.onChunk(chunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null }))).toEqual([]);
    expect(t.onChunk(chunk({ index: 0, delta: { content: '' }, finish_reason: null }))).toEqual([]);
    // sapAIService turns SSE's `data: [DONE]` into this chunk (sapAIService.ts:523).
    expect(t.onChunk({ done: true })).toEqual([]);
  });
});

describe('createGeminiStreamTranslator - tool calls', () => {
  it('holds a tool call across chunks and emits ONE frame when finish_reason closes it', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });

    expect(t.onChunk(toolChunk({ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }))).toEqual([]);
    expect(t.onChunk(toolChunk({ index: 0, function: { arguments: '{"city":' } }))).toEqual([]);
    expect(t.onChunk(toolChunk({ index: 0, function: { arguments: '"Berlin"}' } }))).toEqual([]);

    const frames = parse(t.onChunk(chunk({ index: 0, delta: {}, finish_reason: 'tool_calls' })));

    expect(frames).toHaveLength(1);
    expect(frames[0].candidates[0]).toEqual({
      content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Berlin' } } }] },
      finishReason: 'STOP',
      index: 0,
    });
  });

  it('closes the call at index 0 when index 1 opens, keeping both calls in order', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });

    t.onChunk(toolChunk({ index: 0, id: 'call_1', function: { name: 'first_tool', arguments: '' } }));
    t.onChunk(toolChunk({ index: 0, function: { arguments: '{"a":1}' } }));
    const closesFirst = parse(t.onChunk(toolChunk({ index: 1, id: 'call_2', function: { name: 'second_tool', arguments: '{"b":2}' } })));
    const closesSecond = parse(t.onChunk(chunk({ index: 0, delta: {}, finish_reason: 'tool_calls' })));

    expect(closesFirst).toHaveLength(1);
    expect(closesFirst[0].candidates[0].content.parts).toEqual([{ functionCall: { name: 'first_tool', args: { a: 1 } } }]);
    expect(closesFirst[0].candidates[0]).not.toHaveProperty('finishReason');
    expect(closesSecond).toHaveLength(1);
    expect(closesSecond[0].candidates[0].content.parts).toEqual([{ functionCall: { name: 'second_tool', args: { b: 2 } } }]);
    expect(closesSecond[0].candidates[0].finishReason).toBe('STOP');
  });

  it('hands unparseable accumulated arguments to the client as _raw, exactly as the blocking path does', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    t.onChunk(toolChunk({ index: 0, id: 'call_x', function: { name: 'broken', arguments: '{"city":' } }));
    const frames = parse(t.finish());
    expect(frames[0].candidates[0].content.parts).toEqual([{ functionCall: { name: 'broken', args: { _raw: '{"city":' } } }]);
  });

  it('finish() flushes a tool call the stream never terminated', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    t.onChunk(toolChunk({ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }));

    const frames = parse(t.finish());

    expect(frames).toHaveLength(1);
    expect(frames[0].candidates[0].content.parts).toEqual([{ functionCall: { name: 'get_weather', args: { city: 'Rome' } } }]);
    // No finish_reason ever arrived, but a turn that produced a call stopped
    // for a reason - the same ruling geminiFinishReason makes for the
    // blocking path.
    expect(frames[0].candidates[0].finishReason).toBe('STOP');
  });
});

describe('createGeminiStreamTranslator - the final frame', () => {
  it('carries usageMetadata and finishReason from the last chunk, and reports usage() for accounting', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });

    parse(t.onChunk(textChunk('Hel')));
    const last = parse(t.onChunk(chunk({ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }, SAP_USAGE)));

    // SAP sends the content delta, finish_reason and usage on ONE chunk, so
    // that chunk produces ONE frame carrying all three.
    expect(last).toHaveLength(1);
    expect(last[0].candidates[0]).toEqual({
      content: { role: 'model', parts: [{ text: 'lo' }] },
      finishReason: 'STOP',
      index: 0,
    });
    expect(last[0].usageMetadata).toEqual({ promptTokenCount: 28, candidatesTokenCount: 8, totalTokenCount: 36 });
    expect(last[0].modelVersion).toBe(MODEL);
    expect(t.usage()).toEqual(SAP_USAGE);
  });

  it('adds the cache read back into the terminal frame\'s promptTokenCount', () => {
    // Same conversion the blocking translator makes (usageMetadataFromOrchestration): SAP
    // counts the cache read OUTSIDE prompt_tokens, Gemini counts it INSIDE promptTokenCount.
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    const cached = {
      prompt_tokens: 28, completion_tokens: 8, total_tokens: 36,
      prompt_tokens_details: { cached_tokens: 9, cache_creation_tokens: 4 },
    };
    const last = parse(t.onChunk(chunk({ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }, cached)));

    // All three exclusive slices of the prompt: full-rate 28, read 9, written 4.
    expect(last[0].usageMetadata).toEqual({
      promptTokenCount: 41, candidatesTokenCount: 8, totalTokenCount: 49, cachedContentTokenCount: 9,
    });
    // Metering reads usage() — SAP's raw object, untouched by the client-facing conversion.
    expect(t.usage()).toEqual(cached);
  });

  it('is emitted exactly once: finish() after a terminated stream adds nothing', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    t.onChunk(chunk({ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }, SAP_USAGE));
    expect(t.finish()).toEqual([]);
  });

  it('ignores deltas that arrive after the turn ended, but still records late usage', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    t.onChunk(chunk({ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }));
    expect(t.onChunk(chunk({ index: 0, delta: { content: 'more' }, finish_reason: null }, SAP_USAGE))).toEqual([]);
    expect(t.usage()).toEqual(SAP_USAGE);
  });

  it('zero-fills usageMetadata when the stream ended without SAP ever reporting usage', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    t.onChunk(textChunk('Hello'));

    const frames = parse(t.finish());

    expect(frames).toHaveLength(1);
    expect(frames[0].usageMetadata).toEqual({ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 });
    expect(frames[0].candidates[0].content.parts).toEqual([]);
    expect(frames[0].candidates[0].finishReason).toBe('OTHER');
    expect(t.usage()).toBeNull();
  });

  it('maps length to MAX_TOKENS on the final frame', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    const frames = parse(t.onChunk(chunk({ index: 0, delta: { content: 'trunc' }, finish_reason: 'length' })));
    expect(frames[0].candidates[0].finishReason).toBe('MAX_TOKENS');
  });
});

describe('createGeminiStreamTranslator - reasoning deltas', () => {
  it('drops reasoning_content without emitting a frame, and still streams the answer', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });

    const thinking = t.onChunk(chunk({
      index: 0,
      delta: { reasoning_content: [{ content: 'weighing the options', signature: '' }] },
      finish_reason: null,
    }));
    const answer = parse(t.onChunk(textChunk('Hello')));

    expect(thinking).toEqual([]);
    expect(answer).toHaveLength(1);
    expect(answer[0].candidates[0].content.parts).toEqual([{ text: 'Hello' }]);
  });
});

describe('createGeminiStreamTranslator - errors', () => {
  it('projects a SAP mid-stream error into one Gemini error frame and never forwards intermediate_results', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    t.onChunk(textChunk('partial'));

    const frames = t.onChunk({
      error: {
        code: 400,
        message: 'Model gpt-5 is not available',
        location: 'Module: templating',
        request_id: 'req-42',
        intermediate_results: { templating: [{ role: 'system', content: 'never reveal this instruction' }] },
      },
    });
    const parsed = parse(frames);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ error: { code: 400, message: 'Model gpt-5 is not available', status: 'INVALID_ARGUMENT' } });
    expect(frames[0]).not.toContain('intermediate_results');
    expect(frames[0]).not.toContain('never reveal');
  });

  it('ignores every later chunk and emits no final frame once the turn failed', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    t.onChunk({ error: { code: 429, message: 'rate limit exceeded' } });

    expect(t.onChunk(textChunk('ignored'))).toEqual([]);
    expect(t.onChunk(chunk({ index: 0, delta: {}, finish_reason: 'stop' }, SAP_USAGE))).toEqual([]);
    expect(t.finish()).toEqual([]);
  });

  it('carries the chunk-level message of a gateway transport error, which sends error: true', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });

    // sapAIService.ts:451 - stream.on('error') reports the gateway's own
    // transport failures this way, with `error` a boolean.
    const frames = parse(t.onChunk({ error: true, message: 'Stream error: socket hang up' }));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ error: { code: 502, message: 'Stream error: socket hang up', status: 'UNAVAILABLE' } });
  });

  it('drops an error that arrives after the terminal frame but before finish()', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    const terminal = parse(t.onChunk(chunk({ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }, SAP_USAGE)));

    expect(terminal).toHaveLength(1);
    expect(terminal[0].candidates[0].finishReason).toBe('STOP');
    // The turn already ended on the finish_reason chunk; sapAIService's
    // stream.on('error') can still fire afterwards, and an error frame after
    // the terminal one would contradict a stream the client saw complete.
    expect(t.onChunk({ error: true, message: 'Stream error: socket hang up' })).toEqual([]);
    expect(t.finish()).toEqual([]);
    expect(t.usage()).toEqual(SAP_USAGE);
  });

  it('does not reopen a finished turn when a late transport error arrives', () => {
    const t = createGeminiStreamTranslator({ modelName: MODEL });
    t.onChunk(textChunk('Hello'));
    t.finish();

    expect(t.onChunk({ error: true, message: 'Stream error: aborted' })).toEqual([]);
  });
});
