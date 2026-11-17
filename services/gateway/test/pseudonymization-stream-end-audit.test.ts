/**
 * At the end of a native stream the after-plugins get `{ events: [...] }`: the upstream's events,
 * still masked by design (the wire interceptor restores what the client reads, and the response
 * cache stores the masked form). The residue audit must not read that wrapper as the client's
 * answer. 2026-11-17: every placeholder whole in one upstream delta logged
 * "Unmask miss on response: … reached the client masked" although the client had the real value,
 * and one split across two deltas logged its first half as an unresolvable token.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }),
  createSafePreview: () => '',
  createHeadersPreview: () => '',
}));

const mockConfig: any = { api_config: {} };
jest.mock('../src/services/configService', () => {
  const svc: Record<string, any> = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
  };
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

import pseudonymizationRules = require('../src/plugins/pseudonymization/index');
import { EMAIL, TEXT, configFor, mockRes } from './forcedRouteHarness';

const PLACEHOLDER = /MASKED_EMAIL_[0-9a-f]+/;
const AUDIT_LINE = /Unmask miss|Unresolvable masked|residue_unresolved/;
const handler = (strategy: string) => (pseudonymizationRules as any[]).find((r) => r.strategy === strategy).handler;

/** A masked request on the deployed Bedrock route, its response double and what the plugin logged. */
async function maskedRequest() {
  const lines: string[] = [];
  const record = (level: string) => (message: string, meta?: unknown) => { lines.push(`${level} ${message} ${meta === undefined ? '' : JSON.stringify(meta)}`); };
  const logger = { error: record('error'), warn: record('warn'), info: () => {}, debug: () => {}, trace: () => {} };
  const req: any = {
    __endpoint: 'aws-bedrock', debugRequestId: 'gateway-test', headers: {},
    body: { anthropic_version: 'bedrock-2023-05-31', max_tokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: TEXT }] }] },
  };
  const res: any = mockRes();
  expect(await handler('before')({ req, res, utils: { logger } })).toEqual({ stop: false });
  const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
  lines.length = 0;
  const after = (upstreamResponse: any) => handler('after')({ req, res, upstreamResponse, utils: { logger } });
  return { req, res, placeholder, lines, after };
}

const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

beforeEach(() => {
  mockConfig.api_config = configFor(['aws-bedrock']);
});

describe('the residue audit at the end of a native stream', () => {
  it('a placeholder whole in one upstream delta: the client reads the value and nothing is reported', async () => {
    const { res, placeholder, lines, after } = await maskedRequest();
    const events: any[] = [textDelta(`Sent to ${placeholder}.`), { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }];
    for (const event of events) res.write(frame(event));
    expect(res.writes.join('')).toContain(`Sent to ${EMAIL}.`);
    expect(res.writes.join('')).not.toMatch(PLACEHOLDER);

    const wrapper = { events };
    expect(await after(wrapper)).toBe(wrapper);
    // Still masked: this is what the response cache stores.
    expect(events[0].delta.text).toBe(`Sent to ${placeholder}.`);
    expect(lines.filter((line) => AUDIT_LINE.test(line))).toEqual([]);
  });

  it('a placeholder split across two upstream deltas: its first half is not reported as an unknown token', async () => {
    const { res, placeholder, lines, after } = await maskedRequest();
    const cut = placeholder.length - 3;
    const events = [textDelta(`Sent to ${placeholder.slice(0, cut)}`), textDelta(`${placeholder.slice(cut)}.`), { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }];
    for (const event of events) res.write(frame(event));
    const sent = res.writes.join('').split('\n\n').filter(Boolean).map((b: string) => JSON.parse(b.slice('data: '.length)));
    expect(sent.map((e: any) => e.delta?.text ?? '').join('')).toBe(`Sent to ${EMAIL}.`);

    await after({ events });
    expect(lines.filter((line) => AUDIT_LINE.test(line))).toEqual([]);
  });

  it('the wrapper of a stream without captured events passes through', async () => {
    const { lines, after } = await maskedRequest();
    const wrapper = { message: 'Stream completed without captured events' };
    expect(await after(wrapper)).toBe(wrapper);
    expect(lines).toEqual([]);
  });

  it('a non-streaming answer is still audited: a placeholder left in an object key is reported', async () => {
    const { placeholder, lines, after } = await maskedRequest();
    await after({ type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send', input: { [placeholder]: 1 } }] });
    expect(lines.filter((line) => /Unmask miss on response/.test(line))).toHaveLength(1);
  });
});
