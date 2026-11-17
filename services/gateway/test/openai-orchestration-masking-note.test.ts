/**
 * /openai/v1/chat/completions through SAP orchestration: the pseudonymization note (what the
 * MASKED_* tokens are, copy them exactly, never invent one) reaches the model.
 *
 * The controller builds the SAP request before the plugins run; masking reaches it because the
 * plugin changes the message objects in place. The note was a NEW system message (or a replaced
 * one), which the already-built request did not hold, so the model got tokens with no explanation
 * and declined tasks ("I can't write to masked identifiers", claude-4.5-haiku 5 of 5, 2026-11-09).
 * The shipped hooks force pseudonymization on the openai endpoint.
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));
let mockOwner = 'anthropic';
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve({ id: m, owned_by: mockOwner, provider: mockOwner }),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

const shippedHooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8')).api_config.hooks;
const mockConfig: any = { api_config: {} };
jest.mock('../src/services/configService', () => {
  const svc = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: (modelId: string, subpath: string, endpoint?: string) => {
      const override = mockConfig.api_config.models?.overrides?.[modelId]?.hooks?.[subpath];
      if (override) return override;
      return endpoint ? mockConfig.api_config.hooks?.defaults?.[endpoint]?.[subpath] || null : null;
    },
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getOpenAIDeploymentApiVersion: () => undefined,
  };
  return { __esModule: true, default: svc, ...svc };
});
jest.mock('../src/utils/modelUtils', () => ({
  mapModelParameters: (p: Record<string, any>) => ({ ...p }),
  getDefaultParameters: () => ({}),
}));
jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {} }));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0 }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

const mockSent: any[] = [];
// A model with an internal system prompt (sap-abap-1): SAP refuses any system message, HTTP 400.
const mockRefusesSystem = new Set<string>();
const hasSystem = (payload: any) => [...(payload.messages_history || []), ...payload.config.modules.prompt_templating.prompt.template].some((m: any) => m.role === 'system');
const systemRefusal = () => Object.assign(new Error('Request failed with status code 400'), {
  status: 400,
  details: { body: JSON.stringify({ error: { code: 400, message: '400 - Templating Module: An internal system prompt is configured for this model. Adding additional system messages is prohibited.' } }) },
});
const refuseIfSystem = (payload: any) => {
  if (mockRefusesSystem.has(payload.config.modules.prompt_templating.model.name) && hasSystem(payload)) throw systemRefusal();
};
const answer = () => ({
  final_result: {
    id: 'chatcmpl-n', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  },
});
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    streamChatCompletion: async (payload: any, onChunk: any) => {
      mockSent.push(JSON.parse(JSON.stringify(payload)));
      refuseIfSystem(payload);
      await onChunk({ final_result: { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }] } });
    },
    completeChat: async (payload: any) => { mockSent.push(JSON.parse(JSON.stringify(payload))); refuseIfSystem(payload); return answer(); },
  },
}));

import { handleChatCompletion } from '../src/controllers/openaiController';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');

const EMAIL = 'jane.roe@example.org';
function mockRes() {
  const r: any = Object.assign(new EventEmitter(), { statusCode: 200, body: undefined, headers: {}, writes: [] as string[], writable: true, writableEnded: false, headersSent: false });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => { r.headersSent = true; r.writes.push(String(s)); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}
async function sendRaw(body: any) {
  const req: any = new EventEmitter();
  req.body = body; req.headers = { 'content-type': 'application/json' }; req.query = {};
  const res = mockRes();
  const next = jest.fn();
  await handleChatCompletion(req, res, next as any);
  for (let i = 0; i < 400 && !res.writableEnded && next.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  return { res, next };
}
async function send(body: any) {
  await sendRaw(body);
  expect(mockSent).toHaveLength(1);
  return mockSent[0];
}
/** Every message SAP gets, in order: the history, then the prompt template. */
const messagesOf = (payload: any): any[] => [...(payload.messages_history || []), ...payload.config.modules.prompt_templating.prompt.template];
const textOf = (m: any): string => typeof m.content === 'string' ? m.content : (m.content || []).map((c: any) => c.text || '').join(' ');
const NOTE = 'copy its token EXACTLY';

describe('the pseudonymization note reaches SAP orchestration on /openai/v1/chat/completions', () => {
  beforeAll(() => {
    (global as any).pluginRegistry = {};
    (pseudonymizationRules as any[]).forEach((rule: any, i: number) => { (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule; });
  });
  beforeEach(() => {
    mockSent.length = 0;
    mockOwner = 'anthropic';
    mockConfig.api_config = { hooks: JSON.parse(JSON.stringify(shippedHooks)), models: { overrides: {} }, observability: { pseudonymization: { enabled: true } } };
    (global as any).matcherCache?.clear?.();
  });

  it('a request without a system message gets one holding the note, before the user message', async () => {
    const payload = await send({ model: 'anthropic--claude-4.5-haiku', messages: [{ role: 'user', content: `Write to ${EMAIL} confirming a meeting.` }] });
    const messages = messagesOf(payload);
    expect(JSON.stringify(payload)).not.toContain(EMAIL);            // masked
    const system = messages.filter((m) => m.role === 'system');
    expect(system).toHaveLength(1);
    expect(textOf(system[0])).toContain(NOTE);
    expect(messages[0].role).toBe('system');
    expect(messages[messages.length - 1].role).toBe('user');
  });

  it('global switch off, endpoint flag on, a masking block in the request: the note is delivered as when forced', async () => {
    mockConfig.api_config.observability.pseudonymization.enabled = false;
    expect(mockConfig.api_config.hooks.defaults.openai.pseudonymization.enabled).toBe(true);
    const payload = await send({
      model: 'anthropic--claude-4.5-haiku',
      masking: { method: 'pseudonymization', entities: [{ type: 'profile-email' }] },
      messages: [{ role: 'user', content: `Write to ${EMAIL} confirming a meeting.` }],
    });
    const messages = messagesOf(payload);
    expect(JSON.stringify(payload)).not.toContain(EMAIL);            // masked
    const system = messages.filter((m) => m.role === 'system');
    expect(system).toHaveLength(1);
    expect(textOf(system[0])).toContain(NOTE);
    expect(messages[0].role).toBe('system');
  });

  it('a request with a system message keeps its text and gains the note', async () => {
    const payload = await send({ model: 'anthropic--claude-4.5-haiku', messages: [
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user', content: `Write to ${EMAIL}.` },
    ] });
    const system = messagesOf(payload).filter((m) => m.role === 'system');
    expect(system).toHaveLength(1);
    expect(textOf(system[0])).toContain('You are a concise assistant.');
    expect(textOf(system[0])).toContain(NOTE);
  });

  it('with earlier turns: the note is the first message and the history keeps its order', async () => {
    const payload = await send({ model: 'gpt-5-mini', messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi, how can I help?' },
      { role: 'user', content: `Write to ${EMAIL}.` },
    ] });
    const messages = messagesOf(payload);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(textOf(messages[0])).toContain(NOTE);
  });

  it('a streamed request carries the note as well', async () => {
    const payload = await send({ model: 'gpt-5-mini', stream: true, messages: [{ role: 'user', content: `Write to ${EMAIL}.` }] });
    expect(messagesOf(payload).some((m) => m.role === 'system' && textOf(m).includes(NOTE))).toBe(true);
  });

  it('an Anthropic request with content blocks (the image branch) carries the note, not only the default system text', async () => {
    const payload = await send({ model: 'anthropic--claude-4.5-haiku', messages: [
      { role: 'user', content: [{ type: 'text', text: `Write to ${EMAIL}.` }] },
    ] });
    const system = messagesOf(payload).filter((m) => m.role === 'system');
    expect(system.some((m) => textOf(m).includes(NOTE))).toBe(true);
  });

  describe('a model that refuses system messages (an internal system prompt, sap-abap-1)', () => {
    const ABAP = 'sap-abap-test-1';
    beforeEach(() => { mockOwner = 'sap'; mockRefusesSystem.add(ABAP); });

    it('is asked again without the note, and the client gets the answer; afterwards the note is not sent to it at all', async () => {
      const body = () => ({ model: ABAP, messages: [{ role: 'user', content: `Write to ${EMAIL}.` }] });
      const first = await sendRaw(body());
      expect(first.next).not.toHaveBeenCalled();
      expect(first.res.statusCode).toBe(200);
      expect(first.res.body.choices[0].message.content).toBe('Done.');
      expect(mockSent.map(hasSystem)).toEqual([true, false]);
      expect(JSON.stringify(mockSent)).not.toContain(EMAIL);          // both attempts masked

      mockSent.length = 0;
      const second = await sendRaw(body());
      expect(second.res.statusCode).toBe(200);
      expect(mockSent.map(hasSystem)).toEqual([false]);               // remembered: one call, no note
    });

    it('a streamed request is asked again without the note as well', async () => {
      const STREAMED = 'sap-abap-test-2';
      mockRefusesSystem.add(STREAMED);
      const { res, next } = await sendRaw({ model: STREAMED, stream: true, messages: [{ role: 'user', content: `Write to ${EMAIL}.` }] });
      expect(next).not.toHaveBeenCalled();
      expect(mockSent.map(hasSystem)).toEqual([true, false]);
      expect(res.writes.join('')).toContain('Done.');
    });

    it('the client\'s own system message is not removed: SAP\'s refusal reaches the client', async () => {
      const OWN = 'sap-abap-test-3';
      mockRefusesSystem.add(OWN);
      const { res, next } = await sendRaw({ model: OWN, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: `Write to ${EMAIL}.` }] });
      expect(mockSent).toHaveLength(1);
      const failed = next.mock.calls.length > 0 || res.statusCode >= 400;
      expect(failed).toBe(true);
    });
  });

  it('nothing masked: no note is added', async () => {
    const payload = await send({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'What is 2 + 2?' }] });
    expect(JSON.stringify(payload)).not.toContain(NOTE);
  });
});
