/**
 * Reading/writing maskable text in Gemini-shaped bodies.
 * Request side: `systemInstruction` + `contents` (array of turns with `parts`).
 * Response side: `candidates[].content.parts`.
 */
import { describe, it, expect } from '@jest/globals';
import {
  isGeminiBody,
  extractGeminiInputTexts,
  setGeminiInputText,
  appendGeminiInstructions,
  unmaskGeminiOutput,
} from '../src/utils/geminiBodyAdapter';

describe('isGeminiBody', () => {
  it('detects Gemini bodies and rejects chat-completions / Responses bodies', () => {
    expect(isGeminiBody({ contents: [] })).toBe(true);
    expect(isGeminiBody({ systemInstruction: { parts: [{ text: 'be terse' }] }, contents: [] })).toBe(true);
    expect(isGeminiBody({ messages: [{ role: 'user', content: 'hi' }] })).toBe(false);
    expect(isGeminiBody({ input: 'hi' })).toBe(false);
    expect(isGeminiBody({})).toBe(false);
  });
});

describe('extractGeminiInputTexts', () => {
  it('extracts a two-turn body with a system instruction', () => {
    const body = {
      systemInstruction: { parts: [{ text: 'Be terse.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'my secret is abc' }] },
        { role: 'model', parts: [{ text: 'noted' }] },
      ],
    };
    expect(extractGeminiInputTexts(body)).toEqual([
      { text: 'Be terse.', path: 'systemInstruction.parts.0.text' },
      { text: 'my secret is abc', path: 'contents.0.parts.0.text' },
      { text: 'noted', path: 'contents.1.parts.0.text' },
    ]);
  });

  it('never extracts functionResponse JSON or inlineData', () => {
    const body: any = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'see the image' },
            { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
            { functionResponse: { name: 'lookup', response: { city: 'Berlin' } } },
          ],
        },
      ],
    };
    expect(extractGeminiInputTexts(body)).toEqual([
      { text: 'see the image', path: 'contents.0.parts.0.text' },
    ]);
  });

  it('extracts the BARE-STRING systemInstruction form the SDKs accept', () => {
    // geminiParts.ts's joinPartTexts translates `systemInstruction: 'be brief'`, so it
    // reaches the model; walking only `.parts[]` left that whole prompt unmasked.
    expect(extractGeminiInputTexts({
      systemInstruction: 'Reply to john@test.com',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    })).toEqual([
      { text: 'Reply to john@test.com', path: 'systemInstruction' },
      { text: 'hi', path: 'contents.0.parts.0.text' },
    ]);
    // An empty string carries nothing to mask.
    expect(extractGeminiInputTexts({ systemInstruction: '', contents: [] })).toEqual([]);
  });

  it('returns [] for a body with nothing maskable', () => {
    expect(extractGeminiInputTexts({ contents: [] })).toEqual([]);
    expect(extractGeminiInputTexts({})).toEqual([]);
  });
});

describe('setGeminiInputText', () => {
  it('writes back to every path shape extract produces', () => {
    const body: any = {
      systemInstruction: { parts: [{ text: 'a' }] },
      contents: [{ role: 'user', parts: [{ text: 'b' }] }],
    };
    setGeminiInputText(body, 'systemInstruction.parts.0.text', 'A');
    setGeminiInputText(body, 'contents.0.parts.0.text', 'B');
    expect(body.systemInstruction.parts[0].text).toBe('A');
    expect(body.contents[0].parts[0].text).toBe('B');
  });

  it('writes back to the single-segment path of the bare-string form', () => {
    const body: any = { systemInstruction: 'Reply to john@test.com', contents: [] };
    setGeminiInputText(body, 'systemInstruction', 'Reply to MASKED_EMAIL_1');
    expect(body.systemInstruction).toBe('Reply to MASKED_EMAIL_1');
  });
});

describe('appendGeminiInstructions', () => {
  it('creates systemInstruction when absent and appends a text part when present', () => {
    const a: any = { contents: [] };
    appendGeminiInstructions(a, 'NOTE');
    expect(a.systemInstruction.parts).toEqual([{ text: 'NOTE' }]);

    const b: any = { contents: [], systemInstruction: { parts: [{ text: 'Base.' }] } };
    appendGeminiInstructions(b, 'NOTE');
    expect(b.systemInstruction.parts).toEqual([{ text: 'Base.' }, { text: 'NOTE' }]);
  });

  it('NORMALISES the bare-string form instead of deleting it', () => {
    // It used to be overwritten with `{ parts: [] }`. By this point the string holds the
    // MASKED system prompt, so that silently dropped the caller's instructions from the
    // request while their placeholders stayed in the replacement map.
    const c: any = { contents: [], systemInstruction: 'Reply to MASKED_EMAIL_1' };
    appendGeminiInstructions(c, 'NOTE');
    expect(c.systemInstruction.parts).toEqual([{ text: 'Reply to MASKED_EMAIL_1' }, { text: 'NOTE' }]);
  });

  it('does not turn an EMPTY string systemInstruction into an empty text part', () => {
    // Nothing to preserve, so the note must not arrive behind a `{ text: '' }` the model
    // would be shown. (Before the bare-string handling, '' fell through as falsy anyway.)
    const d: any = { contents: [], systemInstruction: '' };
    appendGeminiInstructions(d, 'NOTE');
    expect(d.systemInstruction.parts).toEqual([{ text: 'NOTE' }]);
  });
});

describe('unmaskGeminiOutput', () => {
  it('unmasks text parts and functionCall.args string values, leaving numbers alone', () => {
    const response: any = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'token X here' },
              { functionCall: { name: 'book', args: { city: 'X', partySize: 4 } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    };
    unmaskGeminiOutput(response, (s) => s.replace(/X/g, 'REAL'));
    expect(response.candidates[0].content.parts[0].text).toBe('token REAL here');
    expect(response.candidates[0].content.parts[1].functionCall.args.city).toBe('REAL');
    expect(response.candidates[0].content.parts[1].functionCall.args.partySize).toBe(4);
  });

  it('is a no-op when there is no candidates array', () => {
    const r: any = { promptFeedback: {} };
    expect(() => unmaskGeminiOutput(r, (s) => s)).not.toThrow();
  });
});
