/**
 * Responses streaming frames are bare `data: {json}` with the type inside the
 * JSON (no `event:` lines, no [DONE]). Placeholders can split across deltas —
 * tool-argument deltas arrive as JSON fragments.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockConfig: any = { api_config: { defaultHooks: {}, model_list_changes: {} } };
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

async function setup(inputText: string) {
  const written: string[] = [];
  const res: any = {
    write: (c: any) => { written.push(String(c)); return true; },
    end: (c?: any) => { if (typeof c === 'string') written.push(c); },
  };
  const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: inputText, masking } };
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
});
