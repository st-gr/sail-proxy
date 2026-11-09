/**
 * Unmasking an OpenAI-format stream the way an Azure OpenAI deployment sends it (captured live from
 * gpt-5.4 and gpt-6.1-sol deployments on 2026-11-08): placeholders split almost per character
 * ("MASK", "ED", "_EMAIL", "_", "3", "f", …), the finish reason in its own chunk with an EMPTY delta,
 * and chunks without choices (prompt_filter_results first, usage last). The restored text must be
 * complete even when the answer ends with a placeholder.
 */
import { describe, it, expect, jest } from '@jest/globals';

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

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;
const afterHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'after').handler;

const VALUE = 'CASE-7B42';
const masking = { method: 'pseudonymization', entities: [{ type: 'profile-email' }], custom_entities: [{ pattern: 'CASE-[0-9A-Z]+' }] };

async function setup() {
  const req: any = { body: { model: 'gpt-5.4', messages: [{ role: 'user', content: `Open ${VALUE} please` }], masking } };
  const res: any = { write: () => true, end: () => {}, json: () => res };
  await beforeHandler({ req, res, utils: { logger } });
  const token: string = req.__pseudonymizationMap.forward.get(VALUE);
  expect(token).toMatch(/^MASKED_/);
  return { req, token };
}

/** How the deployment split a placeholder: "MASK", "ED", "_<TYPE>", "_", then one character at a time. */
function splitLikeDeployment(token: string): string[] {
  const m = /^MASK(ED)(_[A-Z]+)(_)(.+)$/.exec(token);
  if (!m) return token.split('');
  return ['MASK', m[1], m[2], m[3], ...m[4].split('')];
}

const base = { id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.4-2026-03-05' };
const filterFrame = { ...base, choices: [], prompt_filter_results: [{ prompt_index: 0, content_filter_results: {} }] };
const textFrame = (content: string) => ({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null, content_filter_results: {} }] });
const toolFrame = (args: string, name?: string) => ({
  ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...(name ? { id: 'call_1', type: 'function' } : {}), function: { ...(name ? { name } : {}), arguments: args } }] }, finish_reason: null }],
});
const finishFrame = (reason: string) => ({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason, content_filter_results: {} }] });
const usageFrame = { ...base, choices: [], usage: { prompt_tokens: 39, completion_tokens: 30, total_tokens: 69 } };

async function run(req: any, frames: any[]) {
  const out: any[] = [];
  for (const frame of frames) out.push(await afterHandler({ req, upstreamResponse: JSON.parse(JSON.stringify(frame)), utils: { logger } }));
  return out;
}
const textOf = (out: any[]) => out.map((f) => f?.choices?.[0]?.delta?.content ?? '').join('');
const argsOf = (out: any[]) => out.flatMap((f) => f?.choices?.[0]?.delta?.tool_calls ?? []).map((c: any) => c.function?.arguments ?? '').join('');

describe('pseudonymization: OpenAI-format stream as a deployment sends it', () => {
  it('restores a placeholder split per character in the middle of the text', async () => {
    const { req, token } = await setup();
    const out = await run(req, [filterFrame, textFrame(''), textFrame('Open'), textFrame(' '), ...splitLikeDeployment(token).map(textFrame), textFrame(' today.'), finishFrame('stop'), usageFrame]);
    expect(textOf(out)).toBe(`Open ${VALUE} today.`);
    expect(JSON.stringify(out)).not.toMatch(/MASKED_/);
  });

  it('an answer that ENDS with a placeholder keeps its tail: the empty finish chunk flushes it', async () => {
    const { req, token } = await setup();
    const out = await run(req, [filterFrame, textFrame('The case is '), ...splitLikeDeployment(token).map(textFrame), finishFrame('stop'), usageFrame]);
    expect(textOf(out)).toBe(`The case is ${VALUE}`);
    expect(JSON.stringify(out)).not.toMatch(/MASKED_/);
  });

  it('an answer that ends with the START of a placeholder-like text keeps it too', async () => {
    const { req } = await setup();
    const out = await run(req, [textFrame('Ends with MASK'), finishFrame('stop')]);
    expect(textOf(out)).toBe('Ends with MASK');
  });

  it('an ordinary ending that starts like a placeholder ("… at 10 AM", "M", "MA") is not lost', async () => {
    const { req } = await setup();
    for (const ending of ['See you at 10 AM', 'Version M', 'Meeting with MA']) {
      req.__streamBuffer = undefined;
      const out = await run(req, [textFrame(ending.slice(0, -2)), textFrame(ending.slice(-2)), finishFrame('stop'), usageFrame]);
      expect(textOf(out)).toBe(ending);
    }
  });

  it('restores tool-call arguments split per character, with the finish reason in its own chunk', async () => {
    const { req, token } = await setup();
    const out = await run(req, [filterFrame, toolFrame('', 'send'), toolFrame('{"'), toolFrame('ref'), toolFrame('":"'),
      ...splitLikeDeployment(token).map((p) => toolFrame(p)), toolFrame('"}'), finishFrame('tool_calls'), usageFrame]);
    expect(JSON.parse(argsOf(out))).toEqual({ ref: VALUE });
  });

  it('a finish chunk that itself carries one tool call also releases the other calls\' tails and the text', async () => {
    const { req } = await setup();
    const call = (index: number, args: string, finish: string | null = null) => ({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] }, finish_reason: finish }] });
    const out = await run(req, [textFrame('Note MA'), call(1, '{"a":"MASK'), call(0, '{}', 'tool_calls')]);
    const byIndex: Record<number, string> = {};
    for (const f of out) for (const c of f?.choices?.[0]?.delta?.tool_calls ?? []) byIndex[c.index] = (byIndex[c.index] ?? '') + (c.function?.arguments ?? '');
    expect(byIndex).toEqual({ 0: '{}', 1: '{"a":"MASK' });
    expect(textOf(out)).toBe('Note MA');
  });

  it('frames without choices (prompt filter results, usage) pass through unchanged', async () => {
    const { req } = await setup();
    const out = await run(req, [filterFrame, usageFrame]);
    expect(out[0]).toEqual(filterFrame);
    expect(out[1]).toEqual(usageFrame);
  });
});
