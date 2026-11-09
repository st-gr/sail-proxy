/**
 * Strip mode tells the model what was taken away (`noteStrippedTools`).
 *
 * Until now a strip was silent: the tool was gone from the request, the model never learned why,
 * and the person at the keyboard saw an assistant that quietly did not search the web. Only the
 * administrator could tell, through the security event. The note goes into the family's own system
 * channel - Responses `instructions`, a chat `system` message, Anthropic `system`, Gemini
 * `systemInstruction` - so the model can say the tool is not permitted instead of working around it.
 *
 * Two properties matter beyond the wording. The note is IDENTICAL for the same set of tools on
 * every turn, because a client that keeps a denied tool in its list is stripped on every request
 * and a varying system prompt would defeat prompt caching. And it is never added twice, so a
 * retried or replayed body does not accumulate notes.
 */
import { anthropicAdapter } from '../src/toolGovernance/adapters/anthropic';
import { openaiChatAdapter } from '../src/toolGovernance/adapters/openaiChat';
import { responsesAdapter } from '../src/toolGovernance/adapters/responses';
import { geminiAdapter } from '../src/toolGovernance/adapters/gemini';
import { STRIP_NOTICE_MARKER, stripNotice } from '../src/toolGovernance/stripNotice';

const blocked = ['hosted:web_search', 'mcp:github/create_issue'];

describe('stripNotice', () => {
  it('names the tools in one stable line that says they may not be called', () => {
    const notice = stripNotice(blocked);
    expect(notice).toContain(STRIP_NOTICE_MARKER);
    expect(notice).toContain('hosted:web_search');
    expect(notice).toContain('mcp:github/create_issue');
    expect(notice).toMatch(/not permitted/i);
    // stable across calls and independent of the order the evaluation produced
    expect(stripNotice([...blocked].reverse())).toBe(notice);
  });
});

describe('noteStrippedTools', () => {
  it('appends to the Responses instructions, and creates them when absent', () => {
    const withInstructions = responsesAdapter.noteStrippedTools({ instructions: 'Be brief.', input: 'hi' }, blocked);
    expect(withInstructions.instructions).toBe(`Be brief.\n\n${stripNotice(blocked)}`);
    expect(withInstructions.input).toBe('hi');
    expect(responsesAdapter.noteStrippedTools({ input: 'hi' }, blocked).instructions).toBe(stripNotice(blocked));
  });

  it('merges into the first chat system message, or inserts one at the front', () => {
    const existing = openaiChatAdapter.noteStrippedTools(
      { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }] }, blocked);
    expect(existing.messages[0]).toEqual({ role: 'system', content: `Be brief.\n\n${stripNotice(blocked)}` });
    expect(existing.messages[1]).toEqual({ role: 'user', content: 'hi' });
    // No system message: one is inserted FIRST, never appended - a system message after a tool
    // message is refused by some providers behind SAP AI Core (Mistral).
    const inserted = openaiChatAdapter.noteStrippedTools(
      { messages: [{ role: 'user', content: 'hi' }, { role: 'tool', tool_call_id: 'x', content: 'done' }] }, blocked);
    expect(inserted.messages[0]).toEqual({ role: 'system', content: stripNotice(blocked) });
    expect(inserted.messages).toHaveLength(3);
  });

  it('appends to an Anthropic system prompt in either of its shapes', () => {
    expect(anthropicAdapter.noteStrippedTools({ system: 'Be brief.' }, blocked).system)
      .toBe(`Be brief.\n\n${stripNotice(blocked)}`);
    const blocks = anthropicAdapter.noteStrippedTools({ system: [{ type: 'text', text: 'Be brief.' }] }, blocked).system;
    expect(blocks).toEqual([{ type: 'text', text: 'Be brief.' }, { type: 'text', text: stripNotice(blocked) }]);
    expect(anthropicAdapter.noteStrippedTools({ messages: [] }, blocked).system).toBe(stripNotice(blocked));
  });

  it('appends a part to the Gemini system instruction', () => {
    const out = geminiAdapter.noteStrippedTools({ systemInstruction: { parts: [{ text: 'Be brief.' }] } }, blocked);
    expect(out.systemInstruction.parts).toEqual([{ text: 'Be brief.' }, { text: stripNotice(blocked) }]);
    expect(geminiAdapter.noteStrippedTools({ contents: [] }, blocked).systemInstruction)
      .toEqual({ parts: [{ text: stripNotice(blocked) }] });
  });

  it('never adds a second note to a body that already carries one', () => {
    for (const [adapter, body] of [
      [responsesAdapter, { instructions: 'Be brief.' }],
      [openaiChatAdapter, { messages: [{ role: 'system', content: 'Be brief.' }] }],
      [anthropicAdapter, { system: 'Be brief.' }],
      [geminiAdapter, { systemInstruction: { parts: [{ text: 'Be brief.' }] } }]
    ] as [any, any][]) {
      const once = adapter.noteStrippedTools(body, blocked);
      const twice = adapter.noteStrippedTools(once, blocked);
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });

  it('leaves the body alone when nothing was stripped', () => {
    const body = { instructions: 'Be brief.' };
    expect(responsesAdapter.noteStrippedTools(body, [])).toEqual(body);
  });
});
