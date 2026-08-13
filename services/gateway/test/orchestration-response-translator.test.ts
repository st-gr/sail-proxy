/**
 * Orchestration response envelope -> a Responses API response object.
 *
 * The envelope carries `choices[0].message` non-streaming, and the same shape
 * under `final_result` when a stream is collapsed. Both are accepted, because
 * sapAIService hands back whichever the call produced.
 */
import { describe, it, expect } from '@jest/globals';
import { translateOrchestrationResponse } from '../src/responses/orchestrationBridge/responseTranslator';

const OPTS = { model: 'anthropic--claude-4.8-opus', responseId: 'resp_test' };

describe('translateOrchestrationResponse', () => {
  it('turns assistant text into a Responses message item', () => {
    const out: any = translateOrchestrationResponse({
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }, OPTS);

    expect(out.object).toBe('response');
    expect(out.id).toBe('resp_test');
    expect(out.model).toBe('anthropic--claude-4.8-opus');
    expect(out.status).toBe('completed');
    expect(out.output).toHaveLength(1);
    expect(out.output[0]).toEqual({
      type: 'message', id: expect.any(String), role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hello', annotations: [] }],
    });
  });

  it('maps usage onto the Responses names', () => {
    const out: any = translateOrchestrationResponse({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }, OPTS);
    // Nothing cached: inclusive and exclusive coincide, so input_tokens is just
    // prompt_tokens and the recomputed total agrees with SAP's own (10 + 2 = 12).
    expect(out.usage.input_tokens).toBe(10);
    expect(out.usage.output_tokens).toBe(2);
    expect(out.usage.total_tokens).toBe(12);
    // No prompt_tokens_details on this envelope -> zero-filled, not absent,
    // so a client can always read usage.input_tokens_details.cached_tokens.
    expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 0 });
  });

  it('normalizes an EXCLUSIVE cache-READ turn to OpenAI-INCLUSIVE client usage — agreeing with streamTranslator.ts', () => {
    // Arm A2 run 2 of test/fixtures/orchestration/bridge-cache-probe-result.md,
    // the exact fixture orchestration-stream-translator.test.ts asserts against:
    // SAP reports prompt_tokens 14 with cached_tokens 17692 ALONGSIDE it, not
    // inside it. The Responses `usage` shape means the opposite to a client —
    // input_tokens is the whole input, input_tokens_details.cached_tokens a
    // SUBSET of it — so the regime is converted here, where it is known.
    // Passing prompt_tokens straight through would tell codex this turn read 14
    // input tokens when it read 17706.
    const out: any = translateOrchestrationResponse({
      choices: [{ message: { content: 'x' } }],
      usage: {
        prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 17692, cache_creation_tokens: 0 },
      },
    }, OPTS);
    expect(out.usage.input_tokens).toBe(17706);                       // 14 + 17692
    expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 17692, cache_write_tokens: 0 });
    expect(out.usage.output_tokens).toBe(4);
    // Recomputed, NOT SAP's own total_tokens of 18 — that 18 is the exclusive
    // total (14 + 4) and would contradict an inclusive input_tokens of 17706.
    expect(out.usage.total_tokens).toBe(17710);
  });

  it('normalizes an EXCLUSIVE cache-WRITE turn the same way, reporting cache_write_tokens', () => {
    // Arm A2 run 1: the same prefix, written rather than read. SAP's own field is
    // prompt_tokens_details.cache_creation_tokens (unchanged, a different envelope); the
    // client-visible output names it cache_write_tokens, matching the real Responses API,
    // and is an ADDITION to the details object — native OpenAI has no separate cache-write
    // counter and never sends it, so readers already treat details fields as optional.
    const out: any = translateOrchestrationResponse({
      choices: [{ message: { content: 'x' } }],
      usage: {
        prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 17692 },
      },
    }, OPTS);
    expect(out.usage.input_tokens).toBe(17706);
    expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 17692 });
    expect(out.usage.total_tokens).toBe(17710);
  });

  it('turns tool_calls into function_call items', () => {
    const out: any = translateOrchestrationResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }, OPTS);

    expect(out.output).toHaveLength(1);
    expect(out.output[0]).toEqual({
      type: 'function_call', id: expect.any(String), call_id: 'c1', name: 'ls', arguments: '{}', status: 'completed',
    });
  });

  it('emits both a message and a function_call when the model produced both', () => {
    const out: any = translateOrchestrationResponse({
      choices: [{
        message: {
          content: 'let me look',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
        },
      }],
    }, OPTS);
    expect(out.output.map((i: any) => i.type)).toEqual(['message', 'function_call']);
  });

  it('reads the same shape when it arrives under final_result', () => {
    const out: any = translateOrchestrationResponse({
      final_result: { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    }, OPTS);
    expect(out.output[0].content[0].text).toBe('hi');
    expect(out.usage.input_tokens).toBe(1);
  });

  it('reports incomplete when the model hit its length limit', () => {
    const out: any = translateOrchestrationResponse({
      choices: [{ message: { content: 'trunc' }, finish_reason: 'length' }],
    }, OPTS);
    expect(out.status).toBe('incomplete');
    expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('reports incomplete when the response was filtered, not a successful blank answer', () => {
    // content_filter arrives with EMPTY content and a populated usage object —
    // observed twice in the live capture at
    // test/fixtures/orchestration/cache-probe-result.md, where completion_tokens
    // were non-zero, i.e. the model generated and the filter ran afterwards.
    // Reporting `completed` therefore hands the client a successful blank turn,
    // indistinguishable from the model having nothing to say. `content_filter`
    // is one of the two reasons real OpenAI puts in incomplete_details.
    const out: any = translateOrchestrationResponse({
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 14, completion_tokens: 32 },
    }, OPTS);
    expect(out.status).toBe('incomplete');
    expect(out.incomplete_details).toEqual({ reason: 'content_filter' });
  });

  it('produces a well-formed empty response when the envelope has no choices', () => {
    const out: any = translateOrchestrationResponse({}, OPTS);
    expect(out.object).toBe('response');
    expect(out.output).toEqual([]);
    expect(out.status).toBe('completed');
  });
});

describe('reasoning output item (non-streaming)', () => {
  /** The exact shape SAP returns — measured, see reasoning-probe-results.md. */
  const withReasoning = (blocks: any) => ({
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'Berlin needs the warmer coat.',
        reasoning_content: blocks,
      },
    }],
  });

  it('emits the reasoning item FIRST, ahead of the message', () => {
    // The deployed route puts its reasoning item at output_index 0, ahead of
    // the message; a client reading both routes sees the same order.
    const r = translateOrchestrationResponse(withReasoning([
      { content: 'Paris is 18C, Berlin is 3C, so Berlin.', signature: 'EroCCnEIEBABGAIqQJz6' },
    ]), OPTS);
    expect(r.output.map((i: any) => i.type)).toEqual(['reasoning', 'message']);
  });

  it('carries the plaintext in summary_text and never the signature', () => {
    const r = translateOrchestrationResponse(withReasoning([
      { content: 'Paris is 18C, Berlin is 3C, so Berlin.', signature: 'EroCCnEIEBABGAIqQJz6' },
    ]), OPTS);
    const item = r.output[0];
    expect(item.type).toBe('reasoning');
    expect(item.id).toMatch(/^rs_/);
    expect(item.summary).toEqual([
      { type: 'summary_text', text: 'Paris is 18C, Berlin is 3C, so Berlin.' },
    ]);
    expect(item.content).toEqual([]);
    // The signature is Anthropic's replay token, not OpenAI's opaque blob.
    // Putting it in encrypted_content would misrepresent the field.
    expect(item).not.toHaveProperty('encrypted_content');
    expect(JSON.stringify(item)).not.toContain('EroCCnEIEBABGAIqQJz6');
  });

  it('joins every block, so a multi-block response loses no reasoning', () => {
    // Every capture so far holds exactly one block; taking [0] would be
    // indistinguishable from correct until the day it is not.
    const r = translateOrchestrationResponse(withReasoning([
      { content: 'First part. ', signature: '' },
      { content: 'Second part.', signature: 'sig' },
    ]), OPTS);
    expect(r.output[0].summary[0].text).toBe('First part. Second part.');
  });

  it('emits NO reasoning item when the model did not think', () => {
    // The normal case on the adaptive shape: measured, a trivial question comes
    // back with no reasoning_content even at effort xhigh.
    const r = translateOrchestrationResponse({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi.' } }],
    }, OPTS);
    expect(r.output.map((i: any) => i.type)).toEqual(['message']);
  });

  it('emits no reasoning item for an empty, blank, or non-array reasoning_content', () => {
    for (const blocks of [[], [{ content: '   ', signature: 's' }], 'not-an-array', null]) {
      const r = translateOrchestrationResponse(withReasoning(blocks as any), OPTS);
      expect(r.output.map((i: any) => i.type)).toEqual(['message']);
    }
  });

  it('places reasoning ahead of a tool call too', () => {
    const r = translateOrchestrationResponse({
      choices: [{
        index: 0, finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: '',
          reasoning_content: [{ content: 'I should call the tool.', signature: 's' }],
          tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{}' } }],
        },
      }],
    }, OPTS);
    expect(r.output.map((i: any) => i.type)).toEqual(['reasoning', 'function_call']);
  });
});
