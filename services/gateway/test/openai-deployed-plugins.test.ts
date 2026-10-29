/**
 * openaiController: `--deployed` chat (and OpenRouter chat, which reaches the same handler)
 * runs the plugin chain, so pseudonymization masks the payload sent to the deployment and
 * unmasks the answer — and the request is refused when pseudonymization is forced for the
 * openai endpoint but no hook resolves for the chat subpath.
 *
 * The plugin executor, plugin loader and pseudonymization plugin are the REAL modules. Only
 * configService (serving the shipped `api_config.hooks` shape), modelService and axios are
 * mocked, so a test passes only when the controller actually runs the shipped masking.
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve({
      id: m, owned_by: 'openai', provider: 'openai',
      deploymentUrl: 'https://deployed.example.com/v1', model: 'gpt-4o',
    }),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

const shippedHooks = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8'),
).api_config.hooks;

// Replaced per test (beforeEach) with a fresh copy of the shipped hooks.
const mockConfig: any = { api_config: {} };
let mockEmulateStreaming = false;
const mockGetHookConfig = jest.fn((modelId: string, subpath: string, endpoint?: string) => {
  const override = mockConfig.api_config.models?.overrides?.[modelId]?.hooks?.[subpath];
  if (override) return override;
  return endpoint ? mockConfig.api_config.hooks?.defaults?.[endpoint]?.[subpath] || null : null;
});
jest.mock('../src/services/configService', () => {
  const svc = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: (...a: [string, string, string?]) => mockGetHookConfig(...a),
    shouldEmulateStreaming: () => mockEmulateStreaming,
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

jest.mock('../src/utils/payloadLogger', () => ({
  savePayload: () => {},
}));

const mockAxiosPost = jest.fn<(url: string, body: any, cfg: any) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (url: string, body: any, cfg: any) => mockAxiosPost(url, body, cfg) },
}));

jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({
    startTime: Date.now(), inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0,
  }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { handleChatCompletion } from '../src/controllers/openaiController';
import { handleChatCompletions as handleOpenRouterChat } from '../src/controllers/openRouterController';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');

const EMAIL = 'jane.roe@example.org';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[],
    writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => { r.writes.push(s); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = { 'content-type': 'application/json' };
  r.query = {};
  return r;
}

/** Deployment stub: echoes the first MASKED_* token it received, as a model would. */
function deploymentEchoesToken() {
  mockAxiosPost.mockImplementation((_url, body) => {
    const token = (JSON.stringify(body).match(/MASKED_[A-Z_]+_[0-9a-f]+/) || ['NO_TOKEN'])[0];
    return Promise.resolve({
      status: 200,
      data: {
        id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4o', created: 1,
        choices: [{ index: 0, message: { role: 'assistant', content: `I will write to ${token}.` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
    });
  });
}

const chatBody = (extra: Record<string, any> = {}) => ({
  model: 'gpt-4o--deployed',
  messages: [{ role: 'user', content: `Please email ${EMAIL} about the invoice.` }],
  ...extra,
});

describe('deployed chat runs the plugin chain', () => {
  beforeAll(() => {
    // Register the shipped pseudonymization plugin the way pluginLoader.loadAll does.
    (global as any).pluginRegistry = {};
    (pseudonymizationRules as any[]).forEach((rule: any, i: number) => {
      (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule;
    });
  });

  beforeEach(() => {
    mockConfig.api_config = {
      hooks: JSON.parse(JSON.stringify(shippedHooks)),
      models: { overrides: {} },
      observability: {},
    };
    (global as any).matcherCache?.clear?.();
    mockEmulateStreaming = false;
    mockAxiosPost.mockReset();
    mockGetHookConfig.mockClear();
  });

  it('the shipped config forces pseudonymization for the openai endpoint', () => {
    expect(shippedHooks.defaults.openai.pseudonymization.enabled).toBe(true);
    expect(shippedHooks.defaults.openai.pseudonymization.allow_user_bypass).toBe(false);
  });

  it('masks the payload sent to the deployment and unmasks the answer (non-streaming)', async () => {
    deploymentEchoesToken();
    const res = mockRes();
    const next = jest.fn();
    await handleChatCompletion(mockReq(chatBody()), res, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(mockAxiosPost.mock.calls[0][1]);
    expect(sent).not.toContain(EMAIL);
    expect(sent).toMatch(/MASKED_EMAIL_[0-9a-f]+/);

    expect(mockGetHookConfig).toHaveBeenCalledWith('gpt-4o--deployed', 'invoke', 'openai');
    expect(res.statusCode).toBe(200);
    expect(res.body.choices[0].message.content).toBe(`I will write to ${EMAIL}.`);
  });

  it('puts the placeholder note in a system message, never in a top-level system field', async () => {
    deploymentEchoesToken();
    await handleChatCompletion(mockReq(chatBody()), mockRes(), jest.fn() as any);

    const sent = mockAxiosPost.mock.calls[0][1];
    expect(sent).not.toHaveProperty('system');
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toContain('MASKED_<TYPE>_<id>');
    expect(sent.messages[sent.messages.length - 1].role).toBe('user');
  });

  it('appends the note to an existing leading system message', async () => {
    deploymentEchoesToken();
    const body = chatBody({
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: `Please email ${EMAIL}.` },
      ],
    });
    await handleChatCompletion(mockReq(body), mockRes(), jest.fn() as any);

    const sent = mockAxiosPost.mock.calls[0][1];
    expect(sent).not.toHaveProperty('system');
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toMatch(/^You are terse\./);
    expect(sent.messages[0].content).toContain('MASKED_<TYPE>_<id>');
  });

  it('does not forward the masking control fields to the deployment', async () => {
    deploymentEchoesToken();
    await handleChatCompletion(mockReq(chatBody({ pseudonymization_off: true })), mockRes(), jest.fn() as any);
    const sent = mockAxiosPost.mock.calls[0][1];
    expect(sent).not.toHaveProperty('pseudonymization_off');
    expect(JSON.stringify(sent)).not.toContain(EMAIL);
  });

  it('unmasks before the emulated stream is written', async () => {
    deploymentEchoesToken();
    mockEmulateStreaming = true;
    const res = mockRes();
    await handleChatCompletion(mockReq(chatBody({ stream: true })), res, jest.fn() as any);

    const sent = mockAxiosPost.mock.calls[0][1];
    expect(sent).not.toHaveProperty('stream');
    expect(JSON.stringify(sent)).not.toContain(EMAIL);
    expect(mockGetHookConfig).toHaveBeenCalledWith('gpt-4o--deployed', 'invoke-with-response-stream', 'openai');

    // The emulation writes its chunks on timers; wait for it to end the response.
    for (let i = 0; i < 200 && !res.writableEnded; i++) await new Promise((r) => setTimeout(r, 25));
    expect(res.writableEnded).toBe(true);

    const streamed = res.writes.join('');
    expect(streamed).not.toMatch(/MASKED_EMAIL/);
    const text = streamed.split('\n')
      .filter((l: string) => l.startsWith('data: {'))
      .map((l: string) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || '')
      .join('');
    expect(text).toBe(`I will write to ${EMAIL}.`);
  });

  /** Deployment stub answering n = 2 choices, each echoing the token in content or tool arguments. */
  function deploymentAnswersTwoChoices(kind: 'content' | 'tool_calls') {
    mockAxiosPost.mockImplementation((_url, body) => {
      const token = (JSON.stringify(body).match(/MASKED_[A-Z_]+_[0-9a-f]+/) || ['NO_TOKEN'])[0];
      const choice = (index: number) => ({
        index,
        finish_reason: kind === 'content' ? 'stop' : 'tool_calls',
        message: kind === 'content'
          ? { role: 'assistant', content: `Choice ${index}: write to ${token}.` }
          : {
            role: 'assistant', content: null,
            tool_calls: [{ id: `call_${index}`, type: 'function', function: { name: 'send_mail', arguments: `{"to":"${token}"}` } }],
          },
      });
      return Promise.resolve({
        status: 200,
        data: { id: 'chatcmpl-2', object: 'chat.completion', model: 'gpt-4o', created: 1, choices: [choice(0), choice(1)] },
      });
    });
  }

  it('restores every choice of an n > 1 answer', async () => {
    deploymentAnswersTwoChoices('content');
    const res = mockRes();
    await handleChatCompletion(mockReq(chatBody({ n: 2 })), res, jest.fn() as any);

    expect(JSON.stringify(mockAxiosPost.mock.calls[0][1])).not.toContain(EMAIL);
    expect(res.body.choices.map((c: any) => c.message.content)).toEqual([
      `Choice 0: write to ${EMAIL}.`,
      `Choice 1: write to ${EMAIL}.`,
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/MASKED_EMAIL/);
  });

  it('restores tool call arguments in every choice', async () => {
    deploymentAnswersTwoChoices('tool_calls');
    const res = mockRes();
    await handleChatCompletion(mockReq(chatBody({ n: 2 })), res, jest.fn() as any);

    expect(res.body.choices.map((c: any) => c.message.tool_calls[0].function.arguments)).toEqual([
      `{"to":"${EMAIL}"}`,
      `{"to":"${EMAIL}"}`,
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/MASKED_EMAIL/);
  });

  it.each(['invoke', 'invoke-with-response-stream'])(
    'refuses with 503 pseudonymization_hook_missing when forced and no %s hook resolves', async (subPath) => {
      delete mockConfig.api_config.hooks.defaults.openai[subPath];
      const res = mockRes();
      const next = jest.fn();
      await handleChatCompletion(mockReq(chatBody({ stream: subPath !== 'invoke' })), res, next as any);

      expect(mockAxiosPost).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.body.error.type).toBe('api_error');
      expect(res.body.error.code).toBe('pseudonymization_hook_missing');
    });

  it('leaves deployed chat alone when pseudonymization is not forced and no hook resolves', async () => {
    mockConfig.api_config.hooks.defaults.openai = {};
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] },
    });
    const res = mockRes();
    await handleChatCompletion(mockReq(chatBody()), res, jest.fn() as any);

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockAxiosPost.mock.calls[0][1].messages[0].content).toContain(EMAIL);
    expect(res.statusCode).toBe(200);
    expect(res.body.choices[0].message.content).toBe('ok');
  });

  it('masks OpenRouter chat to a --deployed model the same way', async () => {
    deploymentEchoesToken();
    const res = mockRes();
    const next = jest.fn();
    await handleOpenRouterChat(mockReq(chatBody({ model: 'openai/gpt-4o--deployed' })), res, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const sent = mockAxiosPost.mock.calls[0][1];
    expect(JSON.stringify(sent)).not.toContain(EMAIL);
    expect(sent).not.toHaveProperty('system');
    expect(mockGetHookConfig).toHaveBeenCalledWith('gpt-4o--deployed', 'invoke', 'openai');
    expect(res.body.choices[0].message.content).toBe(`I will write to ${EMAIL}.`);
  });

  describe('placeholder note placement in the plugin', () => {
    const beforeHandler = (pseudonymizationRules as any[]).find((r: any) => r.strategy === 'before').handler;
    const afterHandler = (pseudonymizationRules as any[]).find((r: any) => r.strategy === 'after').handler;
    const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

    it('replaces the system message instead of editing it, so an already-built payload is untouched', async () => {
      const systemMessage = { role: 'system', content: 'You are terse.' };
      const req: any = mockReq({ model: 'gpt-4o', messages: [systemMessage, { role: 'user', content: `Mail ${EMAIL}` }] });
      req.__endpoint = 'openai';
      // What the orchestration path holds by then: its own arrays over the same objects.
      const alreadyBuiltHistory = req.body.messages.slice(0, -1);

      await beforeHandler({ req, res: {}, utils });

      expect(systemMessage.content).toBe('You are terse.');
      expect(alreadyBuiltHistory[0]).toBe(systemMessage);
      expect(req.body.messages[0]).not.toBe(systemMessage);
      expect(req.body.messages[0].content).toContain('MASKED_<TYPE>_<id>');
      expect(req.body.system).toBeUndefined();
    });

    // The plugin's res.json safety net re-unmasks the serialized body at the wire, which hides
    // a miss in the after handler on the controller-level tests above. These call the after
    // handler itself, so each choice has to be restored there.
    async function maskedRequest() {
      const req: any = mockReq({ model: 'gpt-4o', messages: [{ role: 'user', content: `Mail ${EMAIL}` }] });
      req.__endpoint = 'openai';
      await beforeHandler({ req, res: {}, utils });
      const token = req.__pseudonymizationMap.forward.get(EMAIL);
      expect(token).toMatch(/^MASKED_EMAIL_/);
      return { req, token };
    }

    it('the after handler restores the content of every choice', async () => {
      const { req, token } = await maskedRequest();
      const upstreamResponse: any = {
        object: 'chat.completion',
        choices: [0, 1, 2].map((index) => ({ index, message: { role: 'assistant', content: `#${index} ${token}` } })),
      };
      const out = await afterHandler({ req, upstreamResponse, utils });
      expect(out.choices.map((c: any) => c.message.content)).toEqual([`#0 ${EMAIL}`, `#1 ${EMAIL}`, `#2 ${EMAIL}`]);
    });

    it('the after handler restores tool call arguments in every choice', async () => {
      const { req, token } = await maskedRequest();
      const upstreamResponse: any = {
        object: 'chat.completion',
        choices: [0, 1].map((index) => ({
          index,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: `c${index}`, type: 'function', function: { name: 'send_mail', arguments: `{"to":"${token}"}` } }],
          },
        })),
      };
      const out = await afterHandler({ req, upstreamResponse, utils });
      expect(out.choices.map((c: any) => c.message.tool_calls[0].function.arguments))
        .toEqual([`{"to":"${EMAIL}"}`, `{"to":"${EMAIL}"}`]);
    });

    it('keeps the top-level system field for an Anthropic Messages body', async () => {
      const req: any = mockReq({ model: 'claude', messages: [{ role: 'user', content: `Mail ${EMAIL}` }] });
      req.__endpoint = 'anthropic';
      mockConfig.api_config.hooks.defaults.anthropic = { pseudonymization: { enabled: true, method: 'pseudonymization' } };

      await beforeHandler({ req, res: {}, utils });

      expect(typeof req.body.system).toBe('string');
      expect(req.body.system).toContain('MASKED_<TYPE>_<id>');
      expect(req.body.messages).toHaveLength(1);
    });
  });
});
