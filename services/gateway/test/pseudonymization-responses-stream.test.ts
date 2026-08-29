/**
 * Responses streaming frames are bare `data: {json}` with the type inside the
 * JSON (no `event:` lines, no [DONE]). Placeholders can split across deltas —
 * tool-argument deltas arrive as JSON fragments.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockConfig: any = { api_config: { hooks: { defaults: {} }, models: { overrides: {} }, observability: {} } };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => mockConfig, getSubstitutedModel: (_p: string, m: string) => m },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_p: string, m: string) => m,
}));

import pluginRules = require('../src/plugins/pseudonymization/index');
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;

const masking = { method: 'pseudonymization', entities: [{ type: 'profile-email' }] };
const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;

async function setup(inputText: string, entityTypes?: string[]) {
  const written: string[] = [];
  const res: any = {
    write: (c: any) => { written.push(String(c)); return true; },
    end: (c?: any) => { if (typeof c === 'string') written.push(c); },
  };
  const req: any = {
    body: {
      model: 'gpt-5.3-codex--deployed',
      input: inputText,
      masking: entityTypes
        ? { method: 'pseudonymization', entities: entityTypes.map((type) => ({ type })) }
        : masking,
    },
  };
  await beforeHandler({ req, res, utils: { logger: mockLogger } });
  return { req, res, written, map: req.__pseudonymizationMap };
}

describe('Responses streaming unmask', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('unmasks response.output_text.delta split across frames', async () => {
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    res.write(frame({ type: 'response.created', response: { status: 'in_progress' } }));
    res.write(frame({ type: 'response.output_text.delta', delta: `mail ${token.slice(0, 6)}` }));
    res.write(frame({ type: 'response.output_text.delta', delta: token.slice(6) }));
    res.write(frame({ type: 'response.output_text.done' }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).toContain('john@test.com');
    expect(all).not.toContain('MASKED_EMAIL');
  });

  it('unmasks response.function_call_arguments.delta JSON fragments', async () => {
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    res.write(frame({ type: 'response.output_item.added', item: { type: 'function_call' } }));
    res.write(frame({ type: 'response.function_call_arguments.delta', delta: '{"to":"' }));
    res.write(frame({ type: 'response.function_call_arguments.delta', delta: `${token}"}` }));
    res.write(frame({ type: 'response.function_call_arguments.done' }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).toContain('john@test.com');
    expect(all).not.toContain('MASKED_EMAIL');
  });

  it('unmasks response.custom_tool_call_input.delta split across frames and flushes the retained tail on .done', async () => {
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    res.write(frame({ type: 'response.output_item.added', item: { type: 'custom_tool_call' }, output_index: 0 }));
    res.write(frame({ type: 'response.custom_tool_call_input.delta', output_index: 0, delta: `mail ${token.slice(0, 6)}` }));
    // "MASK" trailing the completed token could be the start of ANOTHER
    // placeholder (e.g. MASKED_PERSON_2), so the buffer retains it rather than
    // emitting it — only an end-of-item flush releases it. This is what makes
    // the test depend on the .done handler's flush key actually matching the
    // delta handler's buffer key: unlike a token that completes with nothing
    // ambiguous trailing (which the buffer would release on append() alone,
    // making a key mismatch invisible), this fragment is genuinely stuck until
    // flushed under the SAME key it was buffered under.
    res.write(frame({ type: 'response.custom_tool_call_input.delta', output_index: 0, delta: `${token.slice(6)}MASK` }));

    const afterDeltas = written.join('');
    expect(afterDeltas).toContain('john@test.com');
    expect(afterDeltas).not.toContain('MASK'); // still retained, not yet flushed

    res.write(frame({ type: 'response.custom_tool_call_input.done', output_index: 0 }));

    // Assert BEFORE response.completed's catch-all sweep. That sweep flushes
    // every buffer keyed `responses_*` regardless of which literal the .done
    // handler used, so it would hide a key mismatch — checking here, where
    // only the .done handler's own flush call could have released "MASK",
    // is what makes the assertion meaningful.
    const beforeCompleted = written.join('');
    expect(beforeCompleted).toContain('MASK');

    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).toContain('john@test.com');
    expect(all).not.toContain('MASKED_EMAIL');
  });

  it('unmasks response.reasoning_summary_text.delta split across frames', async () => {
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    // Unbuffered, the half-token in the first frame would reach Codex's reasoning
    // pane as a visible masked fragment.
    res.write(frame({ type: 'response.output_item.added', item: { type: 'reasoning' }, output_index: 0 }));
    res.write(frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: `checking ${token.slice(0, 6)}` }));
    res.write(frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: token.slice(6) }));
    res.write(frame({ type: 'response.reasoning_summary_text.done', output_index: 0 }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).toContain('john@test.com');
    expect(all).not.toContain('MASKED_EMAIL');
  });

  it('unmasks response.refusal.delta split across frames', async () => {
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    res.write(frame({ type: 'response.refusal.delta', output_index: 0, delta: `cannot mail ${token.slice(0, 6)}` }));
    res.write(frame({ type: 'response.refusal.delta', output_index: 0, delta: token.slice(6) }));
    res.write(frame({ type: 'response.refusal.done', output_index: 0 }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).toContain('john@test.com');
    expect(all).not.toContain('MASKED_EMAIL');
  });

  it('does not flush an unrelated in-flight item when a sibling output_item finishes (interleaved items)', async () => {
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    // Item 0 (text) opens and receives only the FIRST HALF of the placeholder —
    // its buffer must retain the fragment since it could still be a partial token.
    res.write(frame({ type: 'response.output_item.added', item: { type: 'message' }, output_index: 0 }));
    res.write(frame({ type: 'response.output_text.delta', output_index: 0, delta: `mail ${token.slice(0, 6)}` }));

    // Item 1 (function_call) opens concurrently, gets an unrelated complete value,
    // and finishes. Its own output_item.done must NOT sweep item 0's buffer.
    res.write(frame({ type: 'response.output_item.added', item: { type: 'function_call' }, output_index: 1 }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' }));
    res.write(frame({ type: 'response.output_item.done', output_index: 1 }));

    const beforeItem0Finishes = written.join('');
    // Item 0's fragment ("mail MASKED...") must still be retained, not leaked as a
    // partial/unresolved placeholder by item 1's done event.
    expect(beforeItem0Finishes).not.toContain('MASKED');

    // Now item 0 completes normally — its retained fragment plus the rest of the
    // token must unmask correctly.
    res.write(frame({ type: 'response.output_text.delta', output_index: 0, delta: token.slice(6) }));
    res.write(frame({ type: 'response.output_text.done', output_index: 0 }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).toContain('john@test.com');
    expect(all).not.toContain('MASKED_EMAIL');
  });

  // ── Terminal SNAPSHOT frames ────────────────────────────────────────────
  // A Codex custom-tool turn ends with three frames that each repeat the item's
  // WHOLE input text: `response.custom_tool_call_input.done` (`input`),
  // `response.output_item.done` (`item.input`) and `response.completed`
  // (`response.output[].input`). None of the per-delta handlers touches those —
  // they were unmasked only by the byte-level safety net, which rewrites the
  // ALREADY-SERIALISED SSE bytes. Shapes below are the real ones observed on
  // this route (custom_tool_call item, `name: 'exec'`, ctc_/call_ ids).

  it('keeps a snapshot frame valid JSON when the unmasked value needs escaping', async () => {
    // A credential is the everyday value that carries a backslash. Substituting it
    // into serialized JSON without re-escaping yields `"...C:\Users..."` — an invalid
    // escape, so the client cannot parse the frame that carries the tool arguments.
    const secret = 'C:\\Users\\svc\\p4ssw0rd';
    const { res, written, map } = await setup(
      `login with password=${secret} please`, ['profile-username-password'],
    );
    const token = map.forward.get(secret);
    expect(token).toBeTruthy();

    const input = `const r = await tools.exec_command({cmd:"echo ${token}"})`;
    res.write(frame({
      type: 'response.custom_tool_call_input.done', input, item_id: 'ctc_1', output_index: 2,
    }));
    res.write(frame({
      type: 'response.output_item.done',
      item: { id: 'ctc_1', type: 'custom_tool_call', status: 'completed', call_id: 'call_1', input, name: 'exec' },
      output_index: 2,
    }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).not.toContain('MASKED_USER_PASSWORD');

    for (const block of all.split('\n\n')) {
      if (!block.startsWith('data: ')) continue;
      const event = JSON.parse(block.slice('data: '.length));
      if (event.type === 'response.custom_tool_call_input.done') expect(event.input).toContain(secret);
      if (event.type === 'response.output_item.done') expect(event.item.input).toContain(secret);
    }
  });

  it('flushes the custom-tool input buffer when its output_item.done arrives', async () => {
    // The four sibling keys are flushed here; `responses_custom_input` was added
    // with the custom-tool delta handling but never added to this list. Without it
    // a retained tail is withheld from the item the client finalises on this frame.
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    res.write(frame({
      type: 'response.custom_tool_call_input.delta',
      delta: `mail ${token}MASK`, item_id: 'ctc_1', output_index: 2,
    }));
    // "MASK" could still be the start of another placeholder, so the buffer holds it.
    expect(written.join('')).not.toContain('MASK');

    // No `custom_tool_call_input.done` — this turn's item terminates on output_item.done.
    // `item.input` deliberately omitted: with it present the snapshot's own text would
    // satisfy the assertion below and hide whether the buffer was flushed at all.
    res.write(frame({
      type: 'response.output_item.done',
      item: { id: 'ctc_1', type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'exec' },
      output_index: 2,
    }));

    // Assert BEFORE response.completed, whose catch-all sweep would hide the gap, and
    // over the DELTA stream only — that is what a client accumulating deltas receives.
    const deltas = written.join('').split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice('data: '.length)))
      .filter((e) => e.type === 'response.custom_tool_call_input.delta')
      .map((e) => e.delta)
      .join('');
    expect(deltas).toBe('mail john@test.comMASK');
  });
});
