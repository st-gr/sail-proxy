/**
 * /anthropic/v1/messages on the SAP orchestration path: the client's own `cache_control`
 * breakpoints must reach orchestration (they used to be flattened away with the text, so nothing
 * was ever cached — docs/superpowers/specs/2026-10-23-orchestration-cache-control-brief.md).
 *
 * The shape is the one test/fixtures/orchestration/cache-probe-result.md proves orchestration
 * honours: a message whose content is an array of `{type:'text', text, cache_control}` blocks.
 * A request that marks nothing must produce exactly the payload it produced before
 * (fixtures/anthropic/unmarked-payload.json, captured from the code before this change).
 */
import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

let cachingFlags: { model?: boolean; provider?: boolean } = {};
let ownedBy = 'anthropic';

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_provider: string, model: string) => model,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
  },
  getConfig: () => ({}),
  getConfigAsync: () => Promise.resolve({}),
  getSubstitutedModel: (_provider: string, model: string) => model,
  getHookConfig: () => undefined,
  getSupportsPromptCaching: (provider?: string, model?: string) => (model ? cachingFlags.model : provider ? cachingFlags.provider : undefined),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: { getModelDetails: () => Promise.resolve({ owned_by: ownedBy }) },
  getModelDetails: () => Promise.resolve({ owned_by: ownedBy }),
}));

import { beforeEach } from '@jest/globals';
import { transformRequestToSAPFormat } from '../src/services/anthropicService';

beforeEach(() => { cachingFlags = {}; ownedBy = 'anthropic'; });

const MODEL = 'anthropic--claude-4.5-sonnet';
const EPHEMERAL = { type: 'ephemeral' };
const GOLDEN = path.join(__dirname, 'fixtures/anthropic/unmarked-payload.json');

async function template(req: Record<string, any>): Promise<any[]> {
  const payload: any = await transformRequestToSAPFormat({ model: MODEL, max_tokens: 64, ...req } as any);
  return payload.config.modules.prompt_templating.prompt.template;
}

/** A request touching every message shape the builder handles, with no cache_control anywhere. */
const UNMARKED = {
  model: MODEL,
  max_tokens: 64,
  system: [{ type: 'text', text: 'S1' }, { type: 'text', text: 'S2' }],
  tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: 'X' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'sunny' }, { type: 'text', text: 'thanks' }] },
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'text', text: 'look' }] },
    { role: 'user', content: 'plain' },
  ],
};

describe('anthropic → orchestration: client cache_control breakpoints', () => {
  it('unmarked request: payload identical to the pre-change payload', async () => {
    const payload = await transformRequestToSAPFormat(JSON.parse(JSON.stringify(UNMARKED)) as any);
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(payload, null, 2) + '\n');
    expect(JSON.stringify(payload)).toBe(JSON.stringify(JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))));
  });

  it('never invents a breakpoint', async () => {
    const payload = await transformRequestToSAPFormat(JSON.parse(JSON.stringify(UNMARKED)) as any);
    expect(JSON.stringify(payload)).not.toContain('cache_control');
  });

  it('marked system array: template[0] keeps the blocks with cache_control on the marked one', async () => {
    const t = await template({
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B', cache_control: EPHEMERAL }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(t[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B', cache_control: EPHEMERAL }] });
  });

  it('keeps a breakpoint on the second of two user text blocks', async () => {
    const t = await template({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y', cache_control: EPHEMERAL }] }],
    });
    expect(t[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y', cache_control: EPHEMERAL }] });
  });

  it('assistant text block breakpoint survives', async () => {
    const t = await template({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'answer', cache_control: EPHEMERAL }] },
        { role: 'user', content: 'next' },
      ],
    });
    expect(t[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'answer', cache_control: EPHEMERAL }] });
  });

  it('image turn keeps the marked text block', async () => {
    const t = await template({
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
        { type: 'text', text: 't', cache_control: EPHEMERAL },
      ] }],
    });
    expect(t[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      { type: 'text', text: 't', cache_control: EPHEMERAL },
    ]);
  });

  it('drops scope', async () => {
    const t = await template({
      system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral', scope: 'global' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(t[0].content[0].cache_control).toEqual(EPHEMERAL);
  });

  it('caps at four, keeping the last four', async () => {
    const marked = (text: string) => ({ type: 'text', text, cache_control: EPHEMERAL });
    const t = await template({
      system: [marked('s1'), marked('s2')],
      messages: [
        { role: 'user', content: [marked('u1')] },
        { role: 'assistant', content: [marked('a1')] },
        { role: 'user', content: [marked('u2'), marked('u3')] },
      ],
    });
    const markedTexts = t.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.cache_control).map((b: any) => b.text);
    expect(markedTexts).toEqual(['u1', 'a1', 'u2', 'u3']);
  });

  it('tools are never marked', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } }, cache_control: EPHEMERAL }],
    } as any);
    expect(JSON.stringify(payload.config.modules.prompt_templating.prompt.tools)).not.toContain('cache_control');
  });
});

// Orchestration refuses array content on a `tool` message (fixtures/orchestration/
// anthropic-cache-live-result.md, arms B/B2), so a breakpoint on a tool_result moves to the nearest
// earlier message holding non-empty text; assistant turns with tool_calls qualify (arm E).
describe('anthropic → orchestration: breakpoints on tool results and ttl', () => {
  const toolTurn = (resultBlock: Record<string, any>, assistantText = 'calling') => [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [
      ...(assistantText ? [{ type: 'text', text: assistantText }] : []),
      { type: 'tool_use', id: 'tu1', name: 'read_log', input: {} },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'sunny', ...resultBlock }] },
  ];

  it('marked tool_result: tool message stays a string, the breakpoint moves to the assistant text', async () => {
    const t = await template({ messages: toolTurn({ cache_control: EPHEMERAL }) });
    expect(t[2]).toEqual({ role: 'tool', tool_call_id: 'tu1', content: 'sunny' });
    expect(t[1].content).toEqual([{ type: 'text', text: 'calling', cache_control: EPHEMERAL }]);
    expect(t[1].tool_calls).toHaveLength(1);
  });

  it('marked tool_result after a text-less assistant turn: the breakpoint moves to the user text', async () => {
    const t = await template({ messages: toolTurn({ cache_control: EPHEMERAL }, '') });
    expect(t[1].content).toBe('');
    expect(t[0].content).toEqual([{ type: 'text', text: 'q', cache_control: EPHEMERAL }]);
  });

  it('a marked text block inside the tool_result content counts as a marked tool_result', async () => {
    const t = await template({ messages: toolTurn({ content: [{ type: 'text', text: 'sunny', cache_control: EPHEMERAL }] }) });
    expect(t[2].content).toBe('sunny');
    expect(t[1].content).toEqual([{ type: 'text', text: 'calling', cache_control: EPHEMERAL }]);
  });

  it('unmarked tool_result stays a string and nothing is marked', async () => {
    const t = await template({ messages: toolTurn({}) });
    expect(t[2].content).toBe('sunny');
    expect(JSON.stringify(t)).not.toContain('cache_control');
  });

  it('marked tool_result with no earlier text: the breakpoint is dropped', async () => {
    const t = await template({ messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'read_log', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'sunny', cache_control: EPHEMERAL }] },
    ] });
    expect(JSON.stringify(t)).not.toContain('cache_control');
  });

  // ttl is dropped: the cost path books every cache write at one rate, so a 1h write (billed higher
  // by Anthropic) would be under-reported. Forward it once billing distinguishes the two.
  it.each([['1h', { type: 'ephemeral' }], ['5m', { type: 'ephemeral' }], ['bogus', { type: 'ephemeral' }]])(
    'ttl %s on a system breakpoint', async (ttl, expected) => {
      const t = await template({
        system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral', ttl } }],
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(t[0].content[0].cache_control).toEqual(expected);
    });
});

// Breakpoints are forwarded only where prompt caching is enabled for the target model, by the
// same rule as the Responses bridge (resolvePromptCachingSupport): Anthropic models by default, a
// `supports_prompt_caching` override either way. Otherwise the request is built exactly as before.
describe('anthropic → orchestration: caching gate', () => {
  const marked = {
    system: [{ type: 'text', text: 'S', cache_control: EPHEMERAL }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b', cache_control: EPHEMERAL }] }],
  };
  const unmarked = {
    system: [{ type: 'text', text: 'S' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  };

  it('a non-Anthropic target gets the payload of the unmarked request', async () => {
    ownedBy = 'openai';
    expect(await template(marked)).toEqual(await template(unmarked));
  });

  it('supports_prompt_caching false on the model turns forwarding off for Claude', async () => {
    cachingFlags = { model: false };
    expect(await template(marked)).toEqual(await template(unmarked));
  });

  it('supports_prompt_caching true on the provider turns it on for another family', async () => {
    ownedBy = 'amazon';
    cachingFlags = { provider: true };
    expect((await template(marked))[0].content).toEqual([{ type: 'text', text: 'S', cache_control: EPHEMERAL }]);
  });
});

// Anthropic refuses empty text blocks; a marked turn must not send one where the flattened string
// used to hide it.
describe('anthropic → orchestration: empty text blocks in marked turns', () => {
  it('an empty unmarked block beside a marked one is dropped', async () => {
    const t = await template({ messages: [{ role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'q', cache_control: EPHEMERAL }] }] });
    expect(t[0].content).toEqual([{ type: 'text', text: 'q', cache_control: EPHEMERAL }]);
  });

  it('an empty marked block passes its breakpoint to the previous text block', async () => {
    const t = await template({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: '', cache_control: EPHEMERAL }] }] });
    expect(t[0].content).toEqual([{ type: 'text', text: 'a', cache_control: EPHEMERAL }]);
  });

  it('an empty marked image turn keeps the image and drops the empty text', async () => {
    const t = await template({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      { type: 'text', text: '', cache_control: EPHEMERAL },
    ] }] });
    expect(t[0].content).toEqual([
      { type: 'text', text: 'see', cache_control: EPHEMERAL },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ]);
  });

  it('a system prompt of one empty marked block sends no system message, as before', async () => {
    const t = await template({ system: [{ type: 'text', text: '', cache_control: EPHEMERAL }], messages: [{ role: 'user', content: 'hi' }] });
    expect(t.map((m: any) => m.role)).toEqual(['user']);
  });
});
