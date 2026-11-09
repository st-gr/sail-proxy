/**
 * Reading/writing maskable text in Responses-shaped bodies.
 * Request side: `instructions` + `input` (string OR item array).
 * Response side: `output` items.
 */
import { describe, it, expect } from '@jest/globals';
import {
  isResponsesBody,
  extractResponsesInputTexts,
  setResponsesInputText,
  appendResponsesInstructions,
  unmaskResponsesOutput,
} from '../src/utils/responsesBodyAdapter';

describe('isResponsesBody', () => {
  it('detects Responses bodies and rejects chat-completions bodies', () => {
    expect(isResponsesBody({ input: 'hi' })).toBe(true);
    expect(isResponsesBody({ instructions: 'be terse', input: [] })).toBe(true);
    expect(isResponsesBody({ messages: [{ role: 'user', content: 'hi' }] })).toBe(false);
    expect(isResponsesBody({})).toBe(false);
  });
});

describe('extractResponsesInputTexts', () => {
  it('extracts a plain string input and instructions', () => {
    const body = { instructions: 'Be terse.', input: 'my secret is abc' };
    expect(extractResponsesInputTexts(body)).toEqual([
      { text: 'Be terse.', path: 'instructions' },
      { text: 'my secret is abc', path: 'input' },
    ]);
  });

  it('extracts message items, function_call arguments and function_call_output', () => {
    const body = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call the tool' }] },
        { type: 'function_call', name: 'f', arguments: '{"city":"Berlin"}' },
        { type: 'function_call_output', output: 'result text' },
      ],
    };
    expect(extractResponsesInputTexts(body)).toEqual([
      { text: 'call the tool', path: 'input.0.content.0.text' },
      { text: '{"city":"Berlin"}', path: 'input.1.arguments' },
      { text: 'result text', path: 'input.2.output' },
    ]);
  });

  it('extracts and writes back a refusal part replayed into input', () => {
    // Codex replays the whole conversation, so an unmasked refusal would carry
    // raw PII back upstream on the next turn.
    const body: any = {
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with john@test.com' }] },
      ],
    };
    expect(extractResponsesInputTexts(body)).toEqual([
      { text: 'I cannot help with john@test.com', path: 'input.0.content.0.refusal' },
    ]);
    setResponsesInputText(body, 'input.0.content.0.refusal', 'I cannot help with MASKED_EMAIL_1');
    expect(body.input[0].content[0].refusal).toBe('I cannot help with MASKED_EMAIL_1');
  });

  it('returns [] for a body with nothing maskable', () => {
    expect(extractResponsesInputTexts({ model: 'gpt-5.4--deployed' })).toEqual([]);
  });

  it('extracts and writes back reasoning summary text replayed into input', () => {
    const body: any = {
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought about john@test.com' }] },
      ],
    };
    expect(extractResponsesInputTexts(body)).toEqual([
      { text: 'thought about john@test.com', path: 'input.0.summary.0.text' },
    ]);
    setResponsesInputText(body, 'input.0.summary.0.text', 'thought about MASKED_EMAIL_1');
    expect(body.input[0].summary[0].text).toBe('thought about MASKED_EMAIL_1');
  });
});

describe('setResponsesInputText', () => {
  it('writes back to every path shape extract produces', () => {
    const body: any = {
      instructions: 'a',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] },
        { type: 'function_call', arguments: 'c' },
      ],
    };
    setResponsesInputText(body, 'instructions', 'A');
    setResponsesInputText(body, 'input.0.content.0.text', 'B');
    setResponsesInputText(body, 'input.1.arguments', 'C');
    expect(body.instructions).toBe('A');
    expect(body.input[0].content[0].text).toBe('B');
    expect(body.input[1].arguments).toBe('C');
  });

  it('writes back to a plain string input', () => {
    const body: any = { input: 'x' };
    setResponsesInputText(body, 'input', 'y');
    expect(body.input).toBe('y');
  });
});

describe('appendResponsesInstructions', () => {
  it('creates instructions when absent and appends when present', () => {
    const a: any = { input: 'x' };
    appendResponsesInstructions(a, 'NOTE');
    expect(a.instructions).toBe('NOTE');

    const b: any = { input: 'x', instructions: 'Base.' };
    appendResponsesInstructions(b, 'NOTE');
    expect(b.instructions).toBe('Base.\n\nNOTE');
  });
});

describe('unmaskResponsesOutput', () => {
  it('unmasks message text, function_call arguments and reasoning summaries', () => {
    const response: any = {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'token X here' }] },
        { type: 'function_call', arguments: '{"v":"X"}' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought about X' }] },
      ],
    };
    unmaskResponsesOutput(response, (s) => s.replace(/X/g, 'REAL'));
    expect(response.output[0].content[0].text).toBe('token REAL here');
    expect(response.output[1].arguments).toBe('{"v":"REAL"}');
    expect(response.output[2].summary[0].text).toBe('thought about REAL');
  });

  it('unmasks refusal content parts', () => {
    // Left masked, these reach the client only via the res.json safety net and
    // fire a false "unmask miss" ERROR in the leak audit first.
    const response: any = {
      output: [
        { type: 'message', content: [{ type: 'refusal', refusal: 'cannot discuss X' }] },
      ],
    };
    unmaskResponsesOutput(response, (s) => s.replace(/X/g, 'REAL'));
    expect(response.output[0].content[0].refusal).toBe('cannot discuss REAL');
  });

  it('is a no-op when there is no output array', () => {
    const r: any = { status: 'completed' };
    expect(() => unmaskResponsesOutput(r, (s) => s)).not.toThrow();
  });
});
