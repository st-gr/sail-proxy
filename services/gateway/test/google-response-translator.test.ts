/**
 * Orchestration response envelope -> a Gemini `generateContent` response.
 *
 * The response half of the Gemini bridge (requestTranslator.ts is the other
 * half). `sapAIService` hands back either the plain envelope or one wrapped
 * in `final_result`, same as the Responses bridge, so both are exercised
 * here. See spec section 6 "Translation rules (bridge)" -> Response for the
 * binding rules this file pins.
 */
import { describe, it, expect } from '@jest/globals';
import {
  geminiFinishReason,
  usageMetadataFromOrchestration,
  orchestrationToGeminiResponse,
} from '../src/google/orchestrationBridge/responseTranslator';

const OPTS = { modelName: 'anthropic--claude-4.8-opus' };

describe('geminiFinishReason', () => {
  const cases: Array<{ name: string; finishReason: string | null | undefined; hasToolCalls: boolean; expected: string }> = [
    { name: 'stop -> STOP', finishReason: 'stop', hasToolCalls: false, expected: 'STOP' },
    { name: 'length -> MAX_TOKENS', finishReason: 'length', hasToolCalls: false, expected: 'MAX_TOKENS' },
    { name: 'tool_calls -> STOP', finishReason: 'tool_calls', hasToolCalls: true, expected: 'STOP' },
    { name: 'tool_calls -> STOP even without hasToolCalls set', finishReason: 'tool_calls', hasToolCalls: false, expected: 'STOP' },
    { name: 'content_filter -> SAFETY', finishReason: 'content_filter', hasToolCalls: false, expected: 'SAFETY' },
    { name: 'an unrecognized reason -> OTHER', finishReason: 'something_else', hasToolCalls: false, expected: 'OTHER' },
    { name: 'an unrecognized reason -> OTHER even with tool calls present', finishReason: 'something_else', hasToolCalls: true, expected: 'OTHER' },
    { name: 'missing, no tool calls -> OTHER (the empty-choices case)', finishReason: undefined, hasToolCalls: false, expected: 'OTHER' },
    { name: 'missing, with tool calls -> STOP (a call closed the turn even though SAP sent no reason)', finishReason: null, hasToolCalls: true, expected: 'STOP' },
  ];

  it.each(cases)('$name', ({ finishReason, hasToolCalls, expected }) => {
    expect(geminiFinishReason(finishReason, hasToolCalls)).toBe(expected);
  });
});

describe('usageMetadataFromOrchestration', () => {
  it('passes an uncached turn through unchanged — nothing to add back', () => {
    expect(usageMetadataFromOrchestration({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }))
      .toEqual({ promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 });
  });

  it('derives totalTokenCount rather than trusting SAP\'s, which is in the other regime', () => {
    expect(usageMetadataFromOrchestration({ prompt_tokens: 10, completion_tokens: 2 }))
      .toEqual({ promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 });
    // SAP's own total excludes the cache read; Gemini's includes it, so the field is
    // recomputed even when SAP sent one.
    expect(usageMetadataFromOrchestration({
      prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 5 },
    })).toEqual({
      promptTokenCount: 15, candidatesTokenCount: 2, totalTokenCount: 17, cachedContentTokenCount: 5,
    });
  });

  it('omits cachedContentTokenCount when there is no cache activity', () => {
    const out: any = usageMetadataFromOrchestration({
      prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(out).not.toHaveProperty('cachedContentTokenCount');
  });

  it('adds the cache read back into promptTokenCount — Gemini counts it INSIDE the prompt', () => {
    // SAP orchestration is exclusive (prompt_tokens holds full-rate tokens only); Google's
    // reference says promptTokenCount "is still the total effective prompt size meaning this
    // includes the number of tokens in the cached content". Without the add-back a client
    // reads a cached share larger than the prompt it is a share of.
    const out: any = usageMetadataFromOrchestration({
      prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 17692 },
    });
    expect(out.promptTokenCount).toBe(14 + 17692);
    expect(out.cachedContentTokenCount).toBe(17692);
    expect(out.totalTokenCount).toBe(14 + 17692 + 4);
    expect(out.cachedContentTokenCount).toBeLessThanOrEqual(out.promptTokenCount);
  });

  it('counts the cache-WRITE slice into promptTokenCount too — it is part of the same prompt', () => {
    // SAP reports the three as disjoint slices of one prompt (which is why foldExclusiveUsage
    // bills them as three added line items). Gemini's "total effective prompt size" is the
    // whole prompt, so omitting the write slice under-reports exactly the turn that paid to
    // populate the cache. Gemini has no field for a cache write, so it appears only here —
    // cachedContentTokenCount stays the READ count.
    const out: any = usageMetadataFromOrchestration({
      prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 5, cache_creation_tokens: 9 },
    });
    expect(out).toEqual({
      promptTokenCount: 14 + 5 + 9, candidatesTokenCount: 4, totalTokenCount: 14 + 5 + 9 + 4,
      cachedContentTokenCount: 5,
    });
  });

  it('counts a write-only turn: cache created, nothing read back yet', () => {
    const out: any = usageMetadataFromOrchestration({
      prompt_tokens: 14, completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 9 },
    });
    expect(out.promptTokenCount).toBe(23);
    // Nothing was served FROM cache, so the read field stays absent.
    expect(out).not.toHaveProperty('cachedContentTokenCount');
  });

  it('zero-fills an absent usage object rather than throwing', () => {
    expect(usageMetadataFromOrchestration(undefined))
      .toEqual({ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 });
  });
});

describe('orchestrationToGeminiResponse', () => {
  it('turns plain string content into one text part on a model-role candidate', () => {
    const out: any = orchestrationToGeminiResponse({
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }, OPTS);

    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toEqual({
      content: { role: 'model', parts: [{ text: 'hello' }] },
      finishReason: 'STOP',
      index: 0,
    });
    expect(out.modelVersion).toBe('anthropic--claude-4.8-opus');
    expect(out.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 });
  });

  it('turns a text-block array content into one part per block, in order', () => {
    const out: any = orchestrationToGeminiResponse({
      choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }],
    }, OPTS);
    expect(out.candidates[0].content.parts).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('turns tool_calls into functionCall parts with parsed args', () => {
    const out: any = orchestrationToGeminiResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }, OPTS);
    expect(out.candidates[0].content.parts).toEqual([
      { functionCall: { name: 'get_weather', args: { city: 'Berlin' } } },
    ]);
    expect(out.candidates[0].finishReason).toBe('STOP');
  });

  it('falls back to { _raw: arguments } when the arguments string does not parse', () => {
    const out: any = orchestrationToGeminiResponse({
      choices: [{
        message: {
          tool_calls: [{ id: 'c1', function: { name: 'ls', arguments: 'not json' } }],
        },
      }],
    }, OPTS);
    expect(out.candidates[0].content.parts).toEqual([
      { functionCall: { name: 'ls', args: { _raw: 'not json' } } },
    ]);
  });

  it('emits a message part and a functionCall part together when the model produced both', () => {
    const out: any = orchestrationToGeminiResponse({
      choices: [{
        message: {
          content: 'let me look',
          tool_calls: [{ function: { name: 'ls', arguments: '{}' } }],
        },
      }],
    }, OPTS);
    expect(out.candidates[0].content.parts).toEqual([
      { text: 'let me look' },
      { functionCall: { name: 'ls', args: {} } },
    ]);
  });

  const finishReasonCases: Array<{ name: string; finish_reason: string; expected: string }> = [
    { name: 'stop', finish_reason: 'stop', expected: 'STOP' },
    { name: 'length', finish_reason: 'length', expected: 'MAX_TOKENS' },
    { name: 'tool_calls', finish_reason: 'tool_calls', expected: 'STOP' },
    { name: 'content_filter', finish_reason: 'content_filter', expected: 'SAFETY' },
    { name: 'an unknown reason', finish_reason: 'weird_new_reason', expected: 'OTHER' },
  ];

  it.each(finishReasonCases)('maps finish_reason $name to $expected', ({ finish_reason, expected }) => {
    const out: any = orchestrationToGeminiResponse({
      choices: [{ message: { content: 'x' }, finish_reason }],
    }, OPTS);
    expect(out.candidates[0].finishReason).toBe(expected);
  });

  it('maps usage with cached tokens onto usageMetadata, cachedContentTokenCount present', () => {
    const out: any = orchestrationToGeminiResponse({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 17692 },
      },
    }, OPTS);
    expect(out.usageMetadata).toEqual({
      promptTokenCount: 14 + 17692, candidatesTokenCount: 4, totalTokenCount: 14 + 17692 + 4,
      cachedContentTokenCount: 17692,
    });
  });

  it('maps usage with no cache activity onto usageMetadata, cachedContentTokenCount omitted', () => {
    const out: any = orchestrationToGeminiResponse({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }, OPTS);
    expect(out.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 });
    expect(out.usageMetadata).not.toHaveProperty('cachedContentTokenCount');
  });

  it('produces one candidate with empty parts and finishReason OTHER when there are no choices', () => {
    const out: any = orchestrationToGeminiResponse({}, OPTS);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toEqual({
      content: { role: 'model', parts: [] },
      finishReason: 'OTHER',
      index: 0,
    });
    expect(out.usageMetadata).toEqual({ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 });
  });

  it('reads the same shape when the envelope arrives wrapped in final_result', () => {
    const out: any = orchestrationToGeminiResponse({
      final_result: {
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }, OPTS);
    expect(out.candidates[0].content.parts).toEqual([{ text: 'hi' }]);
    expect(out.usageMetadata.promptTokenCount).toBe(1);
  });
});
