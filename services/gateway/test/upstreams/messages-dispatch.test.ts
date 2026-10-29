/**
 * /anthropic/v1/messages on a Connection model (B2a): the request runs the hook plugins, goes to
 * the anthropic connection with the post-plugin body and the client's anthropic-beta, streams
 * natively as `event:`/`data:` blocks with the client's model id, and never touches SAP. Usage is
 * exclusive (cache read/creation are added, not subtracted) and emitted once.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import * as http from 'http';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: jest.fn(async () => undefined) } }));

const getModelDetails = jest.fn(async (_id: string) => { throw new Error('SAP must not be called'); });
jest.mock('../../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (id: string) => getModelDetails(id),
    getAuthToken: async () => { throw new Error('SAP must not be called'); },
    modelSupportsStreaming: () => true,
  },
}));

let hookConfig: any;
const hookModels: string[] = [];
let substitutions: Record<string, string> = {};
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getHookConfig: (model: string) => { hookModels.push(model); return hookConfig; },
    isPseudonymizationForced: () => false,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getTimeout: () => 5000,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => substitutions[m] ?? m,
    getConfig: () => ({}),
  },
}));

const before = jest.fn(async (_req: any, _res: any, _hooks: any) => ({ stop: false }));
const after = jest.fn(async (_req: any, _res: any, body: any) => body);
jest.mock('../../src/services/pluginExecutor', () => ({
  executeBeforePlugins: (req: any, res: any, hooks: any) => before(req, res, hooks),
  executeAfterPlugins: (req: any, res: any, body: any) => after(req, res, body),
}));
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: () => {}, isPayloadLoggingEnabled: () => false }));

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
import { handleMessages } from '../../src/controllers/anthropicController';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });

const conn = (): Connection => ({
  id: 'c-an', name: 'an', providerType: 'anthropic', isActive: true,
  settings: { baseUrl: fake.url }, credentials: { secret: 'sk-ant-test' },
  models: [{ modelId: 'claude-sonnet-4-5--an', upstreamModel: 'claude-sonnet-4-5', displayName: null, family: 'claude', capabilities: ['chat'], priced: true }],
});

const app = () => {
  const a = express();
  a.use(express.json());
  a.post('/v1/messages', (req: any, res, next) => {
    req.apiKeyInfo = { entitlement: { catalogId: 'c', catalogName: 'Overflow', mode: 'list', include: ['claude-sonnet-4-5--an'] } };
    return handleMessages(req, res, next);
  });
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: { message: err.message } }));
  return a;
};

const BODY = { model: 'claude-sonnet-4-5--an', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] };
const ev = (type: string, extra: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const START = ev('message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [], usage: { input_tokens: 11, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } });
const TEXT_START = ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
const TEXT_DELTA = ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } });
const TEXT_STOP = ev('content_block_stop', { index: 0 });
const DELTA = ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
const STOP = ev('message_stop');
const STREAM = [START, TEXT_START, TEXT_DELTA, TEXT_STOP, DELTA, STOP];
const events = (text: string) => text.split('\n\n').filter((b) => b.trim()).map((b) => {
  const lines = b.split('\n');
  return { event: lines.find((l) => l.startsWith('event: '))?.slice(7), data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)) };
});

beforeEach(() => {
  fake.requests.length = 0;
  usageEvents.length = 0;
  hookConfig = undefined;
  hookModels.length = 0;
  substitutions = {};
  before.mockClear(); after.mockClear(); getModelDetails.mockClear();
  connectionRegistry.setShadowed([]);
  connectionRegistry.setBackend({ fetch: async () => [conn()] });
});

describe('/anthropic/v1/messages on a connection model', () => {
  it('non-stream: model rewritten, usage exclusive', async () => {
    fake.script([{ kind: 'json', body: {
      id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    } }]);
    const r = await request(app()).post('/v1/messages').send(BODY);
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('claude-sonnet-4-5--an');
    expect(r.body.content[0].text).toBe('hi');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url).toBe('/v1/messages');
    expect(fake.requests[0].headers['x-api-key']).toBe('sk-ant-test');
    expect(JSON.parse(fake.requests[0].body).model).toBe('claude-sonnet-4-5');
    expect(getModelDetails).not.toHaveBeenCalled();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ model: 'claude-sonnet-4-5--an', status: 200, metrics: { inputTokens: 11, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 } });
    expect(usageEvents[0].req.__externalUsage).toEqual({ provider: 'anthropic', connectionId: 'c-an', upstreamModel: 'claude-sonnet-4-5' });
    expect(before.mock.calls).toHaveLength(0);
  });

  describe('a substituted request (claude-sonnet-4-5 renamed to the connection model)', () => {
    const SUBSTITUTED = { ...BODY, model: 'claude-sonnet-4-5' };
    beforeEach(() => { substitutions = { 'claude-sonnet-4-5': 'claude-sonnet-4-5--an' }; });

    it('non-stream: usage and hooks are under the connection model id, the client sees its own id', async () => {
      fake.script([{ kind: 'json', body: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 4, output_tokens: 2 } } }]);
      const r = await request(app()).post('/v1/messages').send(SUBSTITUTED);
      expect(r.status).toBe(200);
      expect(r.body.model).toBe('claude-sonnet-4-5');
      expect(usageEvents.map((e) => e.model)).toEqual(['claude-sonnet-4-5--an']);
      expect(hookModels).toEqual(['claude-sonnet-4-5--an']);
    });

    it('stream: usage is under the connection model id, message_start carries the client id', async () => {
      fake.script([{ kind: 'sse', raw: true, frames: STREAM }]);
      const r = await request(app()).post('/v1/messages').send({ ...SUBSTITUTED, stream: true });
      expect(events(r.text)[0].data.message.model).toBe('claude-sonnet-4-5');
      await new Promise((x) => setTimeout(x, 20));
      expect(usageEvents.map((e) => e.model)).toEqual(['claude-sonnet-4-5--an']);
      expect(hookModels).toEqual(['claude-sonnet-4-5--an']);
    });
  });

  it('the hook chain runs with the anthropic endpoint before the outbound body is built', async () => {
    hookConfig = { before: ['pseudonymization'] };
    before.mockImplementationOnce(async (req: any) => { req.body.messages[0].content = 'MASKED_PERSON_1'; return { stop: false }; });
    fake.script([{ kind: 'json', body: { id: 'm', type: 'message', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }]);
    await request(app()).post('/v1/messages').send({ ...BODY, messages: [{ role: 'user', content: 'Jane Doe' }] });
    expect(fake.requests[0].body).toContain('MASKED_PERSON_1');
    expect(fake.requests[0].body).not.toContain('Jane Doe');
    expect(before.mock.calls[0][0].__endpoint).toBe('anthropic');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('stream passes events through', async () => {
    fake.script([{ kind: 'sse', raw: true, frames: STREAM }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    const got = events(r.text);
    expect(got.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(got.map((e) => e.data.type)).toEqual(got.map((e) => e.event));
    expect(got[0].data.message.model).toBe('claude-sonnet-4-5--an');
    expect(got[2].data.delta.text).toBe('Hello');
    expect(fake.requests).toHaveLength(1);
    await new Promise((x) => setTimeout(x, 20));
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ status: 200, model: 'claude-sonnet-4-5--an', metrics: { inputTokens: 11, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 } });
  });

  it('an event split across chunks is written once, whole', async () => {
    const [head, tail] = [DELTA.slice(0, 40), DELTA.slice(40)];
    fake.script([{ kind: 'sse', raw: true, frames: [START, TEXT_START, TEXT_DELTA, head, tail, STOP.trimEnd()] }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    const got = events(r.text);
    expect(got.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'message_stop']);
    expect(r.text.split('event: message_delta')).toHaveLength(2);
    await new Promise((x) => setTimeout(x, 20));
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].metrics.outputTokens).toBe(5);
  });

  it('upstream 429 before the stream', async () => {
    fake.script([{ kind: 'status', status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } } }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(r.status).toBe(429);
    expect(r.body.type).toBe('error');
    expect(r.body.error).toMatchObject({ type: 'rate_limit_error', message: 'Rate limited' });
    expect(usageEvents.map((e) => e.status)).toEqual([429]);
  });

  it('client disconnect aborts upstream', async () => {
    fake.script([{ kind: 'sse', raw: true, frames: STREAM, stallAfter: 2 }]);
    const server = app().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as any).port;
    await new Promise<void>((resolve) => {
      const creq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => {
        res.once('data', () => { creq.destroy(); resolve(); });
      });
      creq.on('error', () => {});
      creq.end(JSON.stringify({ ...BODY, stream: true }));
    });
    await new Promise((r) => setTimeout(r, 100));
    server.close();
    expect(fake.requests[0].closedEarly).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(499);
  });

  it('stream broken mid-way', async () => {
    fake.script([{ kind: 'sse', raw: true, frames: STREAM, resetAfter: 2 }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(r.status).toBe(200);
    const got = events(r.text);
    expect(got.at(-1)).toEqual({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'The connection upstream stream ended unexpectedly' } } });
    await new Promise((x) => setTimeout(x, 20));
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(502);
  });

  it('an upstream error event passes through and the stream ends with 502', async () => {
    const err = ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
    fake.script([{ kind: 'sse', raw: true, frames: [START, err] }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    const got = events(r.text);
    expect(got.at(-1)).toEqual({ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    expect(got.filter((e) => e.event === 'error')).toHaveLength(1);
    await new Promise((x) => setTimeout(x, 20));
    expect(usageEvents.map((e) => e.status)).toEqual([502]);
  });

  it('web_search is refused', async () => {
    const r = await request(app()).post('/v1/messages').send({ ...BODY, tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
    expect(r.status).toBe(400);
    expect(r.body.type).toBe('error');
    expect(r.body.error.message).toContain('web_search_not_supported');
    expect(fake.requests).toHaveLength(0);
    expect(usageEvents).toHaveLength(0);
  });

  it('beta header reaches the provider', async () => {
    fake.script([{ kind: 'json', body: { id: 'm', type: 'message', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }]);
    await request(app()).post('/v1/messages').set('anthropic-beta', 'prompt-caching-2024-07-31').send(BODY);
    expect(fake.requests[0].headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });
});
