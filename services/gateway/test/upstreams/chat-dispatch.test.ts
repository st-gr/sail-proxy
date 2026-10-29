/**
 * /openai/v1/chat/completions on a Connection model (spec 2026-10-23 §5.1, §5.3): the request runs
 * the hook plugins, goes to the connection with the post-plugin body, streams natively (the
 * upstream frames pass through res.write, where the masking plugin unmasks them), and never
 * touches SAP. The gateway always asks the upstream for usage; the usage-only chunk reaches the
 * client only when it asked for it.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: jest.fn(async () => undefined) } }));

const getModelDetails = jest.fn(async (_id: string) => ({ id: 'gpt-4o', owned_by: 'openai' }));
jest.mock('../../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (id: string) => getModelDetails(id),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('sap-token'),
    markModelAsNonStreaming: () => {},
  },
}));

let hookConfig: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getHookConfig: () => hookConfig,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getOpenAIDeploymentApiVersion: () => undefined,
    getTimeout: () => 5000,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
    getConfig: () => ({}),
  },
}));
jest.mock('../../src/utils/modelUtils', () => ({ mapModelParameters: (p: Record<string, any>) => ({ ...p }), getDefaultParameters: () => ({}) }));

const before = jest.fn(async (_req: any, _res: any, _hooks: any) => ({ stop: false }));
const after = jest.fn(async (_req: any, _res: any, body: any) => body);
jest.mock('../../src/services/pluginExecutor', () => ({
  executeBeforePlugins: (req: any, res: any, hooks: any) => before(req, res, hooks),
  executeAfterPlugins: (req: any, res: any, body: any) => after(req, res, body),
}));
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: () => {} }));

const completeChat = jest.fn(async () => { throw new Error('SAP must not be called'); });
const streamChatCompletion = jest.fn(async () => { throw new Error('SAP must not be called'); });
jest.mock('../../src/services/sapAIService', () => ({ __esModule: true, default: { completeChat: () => completeChat(), streamChatCompletion: () => streamChatCompletion() } }));

const usageEvents: Array<{ req: any; metrics: any; model: string; status: number }> = [];
jest.mock('../../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: (req: any, metrics: any, model: string, status: number) => { usageEvents.push({ req, metrics: { ...metrics }, model, status }); },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0; m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0; m.cacheReadInputTokens += cacheRead || 0;
  },
}));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { connectionRegistry } from '../../src/connections/connectionRegistry';
import type { Connection } from '../../src/connections/types';
import { handleChatCompletion } from '../../src/controllers/openaiController';
import { handleChatCompletions as handleOpenRouterChat } from '../../src/controllers/openRouterController';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });

const conn = (): Connection => ({
  id: 'c-oa', name: 'oa', providerType: 'openai', isActive: true,
  settings: { baseUrl: `${fake.url}/v1` }, credentials: { secret: 'sk-test' },
  models: [{ modelId: 'gpt-4o-mini--oa', upstreamModel: 'gpt-4o-mini', displayName: null, family: 'openai', capabilities: ['chat'], priced: true }],
});

const app = () => {
  const a = express();
  a.use(express.json());
  a.post('/v1/chat/completions', (req: any, res, next) => {
    req.apiKeyInfo = { entitlement: { catalogId: 'c', catalogName: 'Overflow', mode: 'list', include: ['gpt-4o-mini--oa', 'gpt-4o'] } };
    return handleChatCompletion(req, res, next);
  });
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: { message: err.message } }));
  return a;
};

const frame = (o: unknown) => JSON.stringify(o);
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  frame({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const USAGE = { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 40 } };
const STREAM = [chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }),
  frame({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini-2024-07-18', choices: [], usage: USAGE }), '[DONE]'];
const dataLines = (text: string) => text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));

beforeEach(() => {
  fake.requests.length = 0;
  usageEvents.length = 0;
  hookConfig = undefined;
  before.mockClear(); after.mockClear(); getModelDetails.mockClear(); completeChat.mockClear(); streamChatCompletion.mockClear();
  connectionRegistry.setShadowed([]);
  connectionRegistry.setBackend({ fetch: async () => [conn()] });
});

describe('chat completions on a connection model', () => {
  it('non-streaming: served by the connection, SAP untouched', async () => {
    fake.script([{ kind: 'json', body: { id: 'x', object: 'chat.completion', model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: USAGE } }]);
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', messages: [{ role: 'user', content: 'hello' }] });
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('gpt-4o-mini--oa');
    expect(r.body.choices[0].message.content).toBe('hi');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url).toBe('/v1/chat/completions');
    expect(fake.requests[0].headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(fake.requests[0].body).model).toBe('gpt-4o-mini');
    expect(completeChat).not.toHaveBeenCalled();
    expect(streamChatCompletion).not.toHaveBeenCalled();
    expect(getModelDetails).not.toHaveBeenCalled();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ model: 'gpt-4o-mini--oa', status: 200, metrics: { inputTokens: 60, outputTokens: 7, cacheReadInputTokens: 40 } });
    expect(usageEvents[0].req.__externalUsage).toEqual({ provider: 'openai', connectionId: 'c-oa', upstreamModel: 'gpt-4o-mini' });
  });

  it('the upstream receives the post-plugin body and the after-plugins see the response', async () => {
    hookConfig = { before: ['pseudonymization'] };
    before.mockImplementationOnce(async (req: any) => { req.body.messages[0].content = 'MASKED_PERSON_1'; return { stop: false }; });
    fake.script([{ kind: 'json', body: { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'MASKED_PERSON_1' } }], usage: USAGE } }]);
    after.mockImplementationOnce(async (_req: any, _res: any, body: any) => ({ ...body, choices: [{ index: 0, message: { role: 'assistant', content: 'Jane Doe' } }] }));
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', messages: [{ role: 'user', content: 'Jane Doe' }] });
    expect(fake.requests[0].body).toContain('MASKED_PERSON_1');
    expect(fake.requests[0].body).not.toContain('Jane Doe');
    expect(r.body.choices[0].message.content).toBe('Jane Doe');
    expect(before.mock.calls[0][0].__endpoint).toBe('openai');
  });

  it('a before-plugin that stops the request sends nothing upstream', async () => {
    hookConfig = { before: ['cache'] };
    before.mockImplementationOnce(async (_req: any, res: any) => { res.json({ cached: true }); return { stop: true }; });
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.body).toEqual({ cached: true });
    expect(fake.requests).toHaveLength(0);
  });

  it('streaming: a multi-byte character cut between two network writes comes out whole', async () => {
    const text = 'Grüße 😀';
    const bytes = Buffer.from(`data: ${chunk({ content: text })}\n\ndata: [DONE]\n\n`, 'utf8');
    const cutUe = bytes.indexOf(Buffer.from('ü')) + 1;
    const cutEmoji = bytes.indexOf(Buffer.from('😀')) + 2;
    // Three separate writes 25 ms apart: the fake server flushes each as its own TCP segment.
    fake.script([{ kind: 'sse', raw: true, delayMs: 25, frames: [bytes.subarray(0, cutUe), bytes.subarray(cutUe, cutEmoji), bytes.subarray(cutEmoji)] }]);
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', stream: true, messages: [{ role: 'user', content: 'hello' }] });
    const frames = dataLines(r.text).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
    expect(frames).toHaveLength(1);
    expect(frames[0].choices[0].delta.content).toBe(text);
    expect(r.text).not.toContain('\uFFFD');
  });

  it('streaming: frames in order with the client model id; usage chunk withheld when not asked', async () => {
    fake.script([{ kind: 'sse', frames: STREAM }]);
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    const lines = dataLines(r.text);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('[DONE]');
    const frames = lines.slice(0, 3).map((l) => JSON.parse(l));
    expect(frames.map((f) => f.choices[0].delta.content)).toEqual(['', 'Hel', 'lo']);
    expect(frames.every((f) => f.model === 'gpt-4o-mini--oa')).toBe(true);
    expect(r.text).not.toContain('"usage"');
    const sent = JSON.parse(fake.requests[0].body);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.model).toBe('gpt-4o-mini');
  });

  it('streaming: the usage: null OpenAI adds to every chunk once usage is asked for is removed when the client did not ask', async () => {
    const withNull = STREAM.map((f) => (f.startsWith('{') && !f.includes('"usage"') ? JSON.stringify({ ...JSON.parse(f), usage: null }) : f));
    fake.script([{ kind: 'sse', frames: withNull }]);
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(dataLines(r.text)).toHaveLength(4);
    expect(r.text).not.toContain('"usage"');
    fake.script([{ kind: 'sse', frames: withNull }]);
    const asked = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] });
    expect(JSON.parse(dataLines(asked.text)[1])).toHaveProperty('usage', null);
  });

  it('streaming: usage chunk forwarded when the client asked', async () => {
    fake.script([{ kind: 'sse', frames: STREAM }]);
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] });
    const lines = dataLines(r.text);
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[3]).usage.prompt_tokens).toBe(100);
    expect(JSON.parse(lines[3]).model).toBe('gpt-4o-mini--oa');
  });

  it('streaming usage: one event, inclusive fold', async () => {
    fake.script([{ kind: 'sse', frames: STREAM }]);
    await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ status: 200, metrics: { inputTokens: 60, cacheReadInputTokens: 40, outputTokens: 7 } });
    expect(usageEvents[0].req.__externalUsage.provider).toBe('openai');
  });

  it('client disconnect aborts the upstream and emits 499 once', async () => {
    fake.script([{ kind: 'sse', frames: STREAM, stallAfter: 2 }]);
    const server = app().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as any).port;
    const http = await import('http');
    await new Promise<void>((resolve) => {
      const creq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, (res) => {
        res.once('data', () => { creq.destroy(); resolve(); });
      });
      creq.on('error', () => {});
      creq.end(JSON.stringify({ model: 'gpt-4o-mini--oa', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });
    await new Promise((r) => setTimeout(r, 100));
    server.close();
    expect(fake.requests[0].closedEarly).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(499);
  });

  it('upstream 429 is passed through in the OpenAI shape', async () => {
    fake.script([{ kind: 'status', status: 429, body: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } } }]);
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ message: 'Rate limit reached', code: 'rate_limit_exceeded' });
    expect(usageEvents.map((e) => e.status)).toEqual([429]);
  });

  it('an upstream error after the stream started ends it with an error frame and [DONE]', async () => {
    fake.script([{ kind: 'sse', frames: STREAM, resetAfter: 2 }]);
    const r = await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o-mini--oa', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    const lines = dataLines(r.text);
    expect(lines.at(-1)).toBe('[DONE]');
    expect(JSON.parse(lines.at(-2)!).error).toBeDefined();
    expect(usageEvents).toHaveLength(1);
  });

  it('the OpenRouter facade serves an entitled connection model', async () => {
    fake.script([{ kind: 'json', body: { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'via facade' } }], usage: USAGE } }]);
    const a = express();
    a.use(express.json());
    a.post('/api/v1/chat/completions', (req: any, res, next) => {
      req.apiKeyInfo = { entitlement: { catalogId: 'c', catalogName: 'Overflow', mode: 'list', include: ['gpt-4o-mini--oa'] } };
      return handleOpenRouterChat(req, res, next);
    });
    const r = await request(a).post('/api/v1/chat/completions').send({ model: 'openai/gpt-4o-mini--oa', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toBe('via facade');
    expect(JSON.parse(fake.requests[0].body).model).toBe('gpt-4o-mini');
    expect(completeChat).not.toHaveBeenCalled();
  });

  it('a non-external model still reaches the SAP path', async () => {
    connectionRegistry.setBackend({ fetch: async () => [] });
    await request(app()).post('/v1/chat/completions').send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
    expect(getModelDetails).toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });
});
