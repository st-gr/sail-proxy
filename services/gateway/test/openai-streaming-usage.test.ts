import { describe, it, expect } from '@jest/globals';
import { newCompletion, usageChunk, transformSAPResponseToOpenAI } from '../src/controllers/openaiController';

describe('streaming usage (#5)', () => {
  it('does not attach usage to a content/delta chunk', () => {
    const c = newCompletion('gpt-4o');
    const sap = { final_result: { choices: [{ index: 0, delta: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } };
    const out = transformSAPResponseToOpenAI(sap, true, c);
    expect(out.usage).toBeUndefined();       // usage no longer rides the delta chunk
    expect(out.choices[0].delta.content).toBe('x');
  });
  it('usageChunk is a final chunk with empty choices carrying usage', () => {
    const c = newCompletion('gpt-4o');
    const u = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    const chunk = usageChunk(c, u);
    expect(chunk).toMatchObject({ id: c.id, model: c.model, object: 'chat.completion.chunk', choices: [], usage: u });
  });
});
