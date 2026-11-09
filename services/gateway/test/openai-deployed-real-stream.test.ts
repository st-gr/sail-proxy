/**
 * Real streaming for `--deployed` chat models on /openai/v1/chat/completions: the deployment is
 * asked to stream (stream:true, include_usage), its SSE is relayed chunk by chunk with the shipped
 * pseudonymization plugin unmasking each chunk, usage is billed once from the deployment's usage
 * frame. Fallbacks: a deployment that answers JSON anyway is replayed; one that refuses function
 * tools on chat goes through /responses (replayed). The mocked deployment answers in the shape the
 * real gpt-5.4 deployment streams (captured 2026-11-08): placeholders split almost per character,
 * a prompt-filter frame first, the finish reason in its own chunk, a usage frame last.
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve({ id: m, owned_by: 'openai', provider: 'openai', deploymentUrl: 'https://deployed.example.com/v1', model: 'gpt-5.4' }),
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
    getOpenAIDeploymentApiVersion: () => '2024-10-01-preview',
  };
  return { __esModule: true, default: svc, ...svc };
});

jest.mock('../src/utils/modelUtils', () => ({
  mapModelParameters: (p: Record<string, any>) => ({ ...p }),
  getDefaultParameters: () => ({}),
}));
jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {} }));

const mockAxiosPost = jest.fn<(url: string, body: any, cfg: any) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (url: string, body: any, cfg: any) => mockAxiosPost(url, body, cfg) },
}));

const usageEvents: any[] = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0 }),
  emitUsageEvent: (...args: any[]) => { usageEvents.push({ model: args[2], status: args[3], input: args[1].inputTokens, output: args[1].outputTokens }); },
  updateTokenCounts: (m: any, input: number, output: number) => { m.inputTokens += input || 0; m.outputTokens += output || 0; },
}));

import { handleChatCompletion } from '../src/controllers/openaiController';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');

const EMAIL = 'jane.roe@example.org';
const MODEL = 'gpt-5.4--deployed';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[], writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => { r.headersSent = true; r.writes.push(String(s)); return true; };
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

const base = { id: 'chatcmpl-d', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.4-2026-03-05' };
const sse = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
const splitLikeDeployment = (token: string) => {
  const m = /^MASK(ED)(_[A-Z]+)(_)(.+)$/.exec(token);
  return m ? ['MASK', m[1], m[2], m[3], ...m[4].split('')] : token.split('');
};
/** The SSE body a deployment streams for the given text pieces (and tool-call argument pieces). */
function deploymentSse(pieces: string[], opts: { tool?: string[]; finish?: string } = {}): string {
  let out = sse({ ...base, choices: [], prompt_filter_results: [{ prompt_index: 0, content_filter_results: {} }] });
  out += sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '', refusal: null }, finish_reason: null }] });
  for (const p of pieces) out += sse({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null, content_filter_results: {} }] });
  if (opts.tool) {
    out += sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '' } }] }, finish_reason: null }] });
    for (const a of opts.tool) out += sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a } }] }, finish_reason: null }] });
  }
  out += sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: opts.finish || 'stop', content_filter_results: {} }] });
  out += sse({ ...base, choices: [], usage: { prompt_tokens: 39, completion_tokens: 30, total_tokens: 69 } });
  return `${out}data: [DONE]\n\n`;
}
/** A readable that delivers `text` in small pieces over several ticks. */
function streamOf(text: string, size = 23): PassThrough {
  const s = new PassThrough();
  (async () => {
    for (let i = 0; i < text.length; i += size) { s.write(text.slice(i, i + size)); await new Promise((r) => setImmediate(r)); }
    s.end();
  })();
  return s;
}
const tokenIn = (body: any) => (JSON.stringify(body).match(/MASKED_[A-Z_]+_[0-9a-f]+/) || ['NO_TOKEN'])[0];
const streamedAnswer = (data: PassThrough) => ({ status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, data });

const frames = (res: any) => res.writes.join('').split('\n\n').filter((b: string) => b.startsWith('data: ')).map((b: string) => b.slice(6));
const chunks = (res: any) => frames(res).filter((f: string) => f !== '[DONE]').map((f: string) => JSON.parse(f));
const textOf = (res: any) => chunks(res).map((c: any) => c.choices?.[0]?.delta?.content ?? '').join('');
async function waitEnd(res: any, next?: any) {
  for (let i = 0; i < 400 && !res.writableEnded && !(next && next.mock.calls.length); i++) await new Promise((r) => setTimeout(r, 5));
}
const userAsks = (extra: Record<string, any> = {}) => ({ model: MODEL, messages: [{ role: 'user', content: `Please email ${EMAIL} about the invoice.` }], ...extra });

describe('deployed chat streams from the deployment', () => {
  beforeAll(() => {
    (global as any).pluginRegistry = {};
    (pseudonymizationRules as any[]).forEach((rule: any, i: number) => { (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule; });
  });
  beforeEach(() => {
    mockConfig.api_config = { hooks: JSON.parse(JSON.stringify(shippedHooks)), models: { overrides: {} }, observability: {} };
    (global as any).matcherCache?.clear?.();
    mockAxiosPost.mockReset();
    usageEvents.length = 0;
  });

  it('asks the deployment to stream, with usage, and relays the unmasked text — also when it ends with a placeholder', async () => {
    mockAxiosPost.mockImplementation((_url, body) => Promise.resolve(streamedAnswer(streamOf(deploymentSse(['I will write to ', ...splitLikeDeployment(tokenIn(body))])))));
    const res = mockRes();
    await handleChatCompletion(mockReq(userAsks({ stream: true })), res, jest.fn() as any);
    await waitEnd(res);

    const [url, body, cfg] = mockAxiosPost.mock.calls[0];
    expect(url).toBe('https://deployed.example.com/v1/chat/completions?api-version=2024-10-01-preview');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(cfg.responseType).toBe('stream');
    expect(JSON.stringify(body)).not.toContain(EMAIL);

    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(textOf(res)).toBe(`I will write to ${EMAIL}`);
    expect(res.writes.join('')).not.toMatch(/MASKED_/);
    expect(frames(res).at(-1)).toBe('[DONE]');
  });

  it('bills once, from the deployment\'s usage frame; the client gets that frame only when it asked for usage', async () => {
    for (const wantsUsage of [false, true]) {
      usageEvents.length = 0;
      mockAxiosPost.mockImplementation(() => Promise.resolve(streamedAnswer(streamOf(deploymentSse(['Hello.'])))));
      const res = mockRes();
      await handleChatCompletion(mockReq(userAsks({ stream: true, ...(wantsUsage ? { stream_options: { include_usage: true } } : {}) })), res, jest.fn() as any);
      await waitEnd(res);
      for (let i = 0; i < 50 && usageEvents.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(usageEvents).toEqual([{ model: MODEL, status: 200, input: 39, output: 30 }]);
      expect(chunks(res).filter((c: any) => c.usage).length).toBe(wantsUsage ? 1 : 0);
    }
  });

  it('relays tool-call deltas with the arguments unmasked', async () => {
    mockAxiosPost.mockImplementation((_url, body) => {
      const token = tokenIn(body);
      return Promise.resolve(streamedAnswer(streamOf(deploymentSse([], { tool: ['{"', 'to', '":"', ...splitLikeDeployment(token), '"}'], finish: 'tool_calls' }))));
    });
    const res = mockRes();
    await handleChatCompletion(mockReq(userAsks({ stream: true, tools: [{ type: 'function', function: { name: 'send_email', parameters: { type: 'object' } } }] })), res, jest.fn() as any);
    await waitEnd(res);
    const args = chunks(res).flatMap((c: any) => c.choices?.[0]?.delta?.tool_calls ?? []).map((t: any) => t.function?.arguments ?? '').join('');
    expect(JSON.parse(args)).toEqual({ to: EMAIL });
    expect(chunks(res).at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it('is real streaming: the first text reaches the client while the deployment is still sending', async () => {
    const upstream = new PassThrough();
    mockAxiosPost.mockImplementation(() => Promise.resolve(streamedAnswer(upstream)));
    const res = mockRes();
    const handled = handleChatCompletion(mockReq(userAsks({ stream: true })), res, jest.fn() as any);
    for (let i = 0; i < 100 && mockAxiosPost.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    upstream.write(sse({ ...base, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }));
    for (let i = 0; i < 100 && !textOf(res); i++) await new Promise((r) => setTimeout(r, 5));
    expect(textOf(res)).toBe('Hello');
    expect(res.writableEnded).toBe(false);
    upstream.end(sse({ ...base, choices: [{ index: 0, delta: { content: ' there.' }, finish_reason: null }] }) + sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    await handled;
    await waitEnd(res);
    expect(textOf(res)).toBe('Hello there.');
  });

  it('a deployment that answers JSON although asked to stream is replayed as SSE', async () => {
    mockAxiosPost.mockImplementation((_url, body) => Promise.resolve({
      status: 200, headers: { 'content-type': 'application/json' },
      data: streamOf(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-5.4', choices: [{ index: 0, message: { role: 'assistant', content: `Writing to ${tokenIn(body)}.` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } })),
    }));
    const res = mockRes();
    await handleChatCompletion(mockReq(userAsks({ stream: true })), res, jest.fn() as any);
    await waitEnd(res);
    expect(textOf(res)).toBe(`Writing to ${EMAIL}.`);
    expect(frames(res).at(-1)).toBe('[DONE]');
  });

  it('a deployment that refuses function tools on chat (streamed 400 body) is asked through /responses, replayed as SSE', async () => {
    const refusalBody = JSON.stringify({ error: { code: null, message: "Function tools with reasoning_effort are not supported for gpt-6.1-sol-2026-09-29-dz-std in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", param: 'reasoning_effort', type: 'invalid_request_error' } });
    mockAxiosPost.mockImplementation((url, body) => {
      if (url.includes('/chat/completions')) {
        return Promise.reject(Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, headers: { 'content-type': 'application/json' }, data: streamOf(refusalBody) } }));
      }
      return Promise.resolve({ status: 200, data: { id: 'resp_1', created_at: 1, status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'send_email', arguments: JSON.stringify({ to: tokenIn(body) }) }], usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } });
    });
    const res = mockRes();
    const next = jest.fn();
    await handleChatCompletion(mockReq(userAsks({ stream: true, tools: [{ type: 'function', function: { name: 'send_email', parameters: { type: 'object' } } }] })), res, next as any);
    await waitEnd(res, next);
    expect(next).not.toHaveBeenCalled();
    expect(mockAxiosPost.mock.calls[1][0]).toBe('https://deployed.example.com/v1/responses');
    const args = chunks(res).flatMap((c: any) => c.choices?.[0]?.delta?.tool_calls ?? []).map((t: any) => t.function?.arguments ?? '').join('');
    expect(JSON.parse(args)).toEqual({ to: EMAIL });
  });

  it('a deployment error before the stream starts reaches the client with the deployment\'s message and status', async () => {
    mockAxiosPost.mockImplementation(() => Promise.reject(Object.assign(new Error('Request failed with status code 429'), {
      response: { status: 429, headers: { 'content-type': 'application/json' }, data: streamOf(JSON.stringify({ error: { message: 'Rate limit reached for gpt-5.4', type: 'rate_limit' } })) },
    })));
    const res = mockRes();
    const next = jest.fn();
    await handleChatCompletion(mockReq(userAsks({ stream: true })), res, next as any);
    await waitEnd(res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const passed: any = next.mock.calls[0][0];
    expect(passed.status).toBe(429);
    expect(passed.details).toEqual({ error: { message: 'Rate limit reached for gpt-5.4', type: 'rate_limit' } });
  });

  it('a client that hangs up mid-stream stops the deployment call', async () => {
    const upstream = new PassThrough();
    let signal: AbortSignal | undefined;
    mockAxiosPost.mockImplementation((_u, _b, cfg) => { signal = cfg.signal; return Promise.resolve(streamedAnswer(upstream)); });
    const req = mockReq(userAsks({ stream: true }));
    const res = mockRes();
    const handled = handleChatCompletion(req, res, jest.fn() as any);
    for (let i = 0; i < 100 && !signal; i++) await new Promise((r) => setTimeout(r, 5));
    upstream.write(sse({ ...base, choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] }));
    await new Promise((r) => setTimeout(r, 20));
    res.emit('close');
    for (let i = 0; i < 100 && !signal?.aborted; i++) await new Promise((r) => setTimeout(r, 5));
    expect(signal?.aborted).toBe(true);
    upstream.destroy();
    await handled;
  });

  it('a request without stream stays a plain JSON call', async () => {
    mockAxiosPost.mockImplementation((_url, body) => Promise.resolve({ status: 200, data: { id: 'c', object: 'chat.completion', created: 1, model: 'gpt-5.4', choices: [{ index: 0, message: { role: 'assistant', content: `To ${tokenIn(body)}.` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } }));
    const res = mockRes();
    await handleChatCompletion(mockReq(userAsks()), res, jest.fn() as any);
    const [, body, cfg] = mockAxiosPost.mock.calls[0];
    expect(body.stream).toBeUndefined();
    expect(cfg.responseType).toBeUndefined();
    expect(res.body.choices[0].message.content).toBe(`To ${EMAIL}.`);
  });

  it('n > 1 is not streamed from the deployment (one unmask buffer per stream): the JSON answer is replayed', async () => {
    // Review S1: Azure streams each choice in its own chunk, so per-chunk unmasking would mix the choices.
    mockAxiosPost.mockImplementation((_url, body) => Promise.resolve({ status: 200, data: { id: 'c', object: 'chat.completion', created: 1, model: 'gpt-5.4', choices: [{ index: 0, message: { role: 'assistant', content: `To ${tokenIn(body)}.` }, finish_reason: 'stop' }, { index: 1, message: { role: 'assistant', content: 'Other.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } }));
    const res = mockRes();
    await handleChatCompletion(mockReq(userAsks({ stream: true, n: 2 })), res, jest.fn() as any);
    await waitEnd(res);
    const [, body, cfg] = mockAxiosPost.mock.calls[0];
    expect(body.stream).toBeUndefined();
    expect(cfg.responseType).toBeUndefined();
    expect(textOf(res)).toBe(`To ${EMAIL}.`);
    expect(res.writes.join('')).not.toMatch(/MASKED_/);
  });

  it('a client that hangs up before the deployment\'s first byte is billed 499, and no error is sent to the closed connection', async () => {
    // Review S5: the aborted axios call has no response; it was billed 500 and handed to next().
    mockAxiosPost.mockImplementation((_u, _b, cfg) => new Promise((_resolve, reject) => {
      cfg.signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', name: 'CanceledError' })));
    }));
    const res = mockRes();
    const next = jest.fn();
    const handled = handleChatCompletion(mockReq(userAsks({ stream: true })), res, next as any);
    for (let i = 0; i < 100 && mockAxiosPost.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    res.emit('close');
    await handled;
    for (let i = 0; i < 50 && usageEvents.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(next).not.toHaveBeenCalled();
    expect(usageEvents).toEqual([{ model: MODEL, status: 499, input: 0, output: 0 }]);
  });
});
