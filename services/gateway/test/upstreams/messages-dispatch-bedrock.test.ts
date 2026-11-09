/**
 * /anthropic/v1/messages on a bedrock Connection model (B2b): the upstream stream is Bedrock's binary
 * event stream (base64 Anthropic events in `chunk` messages), written to the client as plain
 * `event:`/`data:` blocks with the client's model id. Usage is exclusive and emitted once; the
 * `amazon-bedrock-invocationMetrics` on message_stop never reaches the client and is only a fallback.
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
    getSupportedBetaHeaders: () => [],
    getExcludedBetaHeaders: () => [],
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

const PROFILE = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const conn = (): Connection => ({
  id: 'c-bd', name: 'bd', providerType: 'bedrock', isActive: true,
  settings: { region: 'us-east-1', runtimeEndpoint: fake.url, authMode: 'access-key', accessKeyId: 'AKIDEXAMPLE' },
  credentials: { secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
  models: [{ modelId: 'claude-sonnet-4-5--bd', upstreamModel: PROFILE, displayName: null, family: 'claude', capabilities: ['chat'], priced: true }],
});

const app = () => {
  const a = express();
  a.use(express.json());
  a.post('/v1/messages', (req: any, res, next) => {
    req.apiKeyInfo = { entitlement: { catalogId: 'c', catalogName: 'Overflow', mode: 'list', include: ['claude-sonnet-4-5--bd'] } };
    return handleMessages(req, res, next);
  });
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: { message: err.message } }));
  return a;
};

const BODY = { model: 'claude-sonnet-4-5--bd', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] };
const msg = (usage?: unknown) => ({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [], ...(usage ? { usage } : {}) } });
const START = msg({ input_tokens: 11, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 });
const TEXT_START = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const TEXT_DELTA = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } };
const TEXT_STOP = { type: 'content_block_stop', index: 0 };
const DELTA = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } };
const METRICS = { inputTokenCount: 11, outputTokenCount: 5, cacheReadInputTokenCount: 3, cacheWriteInputTokenCount: 2 };
const STOP = { type: 'message_stop', 'amazon-bedrock-invocationMetrics': METRICS };
const STREAM = [START, TEXT_START, TEXT_DELTA, TEXT_STOP, DELTA, STOP];
const events = (text: string) => text.split('\n\n').filter((b) => b.trim()).map((b) => {
  const lines = b.split('\n');
  return { event: lines.find((l) => l.startsWith('event: '))?.slice(7), data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)) };
});
const settle = () => new Promise((x) => setTimeout(x, 30));

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

describe('/anthropic/v1/messages on a bedrock connection model', () => {
  it('bedrock non-stream: model rewritten, usage exclusive', async () => {
    fake.script([{ kind: 'json', body: {
      id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    } }]);
    const r = await request(app()).post('/v1/messages').send(BODY);
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('claude-sonnet-4-5--bd');
    expect(fake.requests[0].url).toBe(`/model/${encodeURIComponent(PROFILE)}/invoke`);
    expect(fake.requests[0].headers.authorization).toContain('AWS4-HMAC-SHA256');
    expect(JSON.parse(fake.requests[0].body).model).toBeUndefined();
    expect(getModelDetails).not.toHaveBeenCalled();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ model: 'claude-sonnet-4-5--bd', status: 200, metrics: { inputTokens: 11, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 } });
  });

  it('bedrock stream decodes chunks', async () => {
    fake.script([{ kind: 'eventstream', events: STREAM }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(fake.requests[0].url).toBe(`/model/${encodeURIComponent(PROFILE)}/invoke-with-response-stream`);
    const got = events(r.text);
    expect(got.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(got[0].data.message.model).toBe('claude-sonnet-4-5--bd');
    expect(got[2].data.delta.text).toBe('Hello');
    expect(r.text).not.toContain('amazon-bedrock-invocationMetrics');
    await settle();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ status: 200, model: 'claude-sonnet-4-5--bd', metrics: { inputTokens: 11, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 } });
  });

  it('frames split across writes are decoded once', async () => {
    fake.script([{ kind: 'eventstream', events: STREAM, splitAt: [5, 20, 60] }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    const got = events(r.text);
    expect(got.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(r.text.split('event: message_delta')).toHaveLength(2);
    await settle();
    expect(usageEvents.map((e) => e.status)).toEqual([200]);
  });

  it('usage falls back to invocation metrics', async () => {
    fake.script([{ kind: 'eventstream', events: [msg(), TEXT_START, TEXT_DELTA, TEXT_STOP, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, STOP] }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(r.text).not.toContain('amazon-bedrock-invocationMetrics');
    await settle();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 11, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 });
  });

  it('throttling exception mid-stream', async () => {
    fake.script([{ kind: 'eventstream', events: [START, TEXT_START], exception: { type: 'throttlingException', message: 'secret prompt echo' } }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(r.status).toBe(200);
    const got = events(r.text);
    expect(got.at(-1)).toEqual({ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'throttlingException' } } });
    expect(got.filter((e) => e.event === 'error')).toHaveLength(1);
    expect(r.text).not.toContain('secret prompt echo');
    await settle();
    expect(usageEvents.map((e) => e.status)).toEqual([502]);
  });

  it('other exceptions map to api_error', async () => {
    fake.script([{ kind: 'eventstream', events: [START], exception: { type: 'modelStreamErrorException', message: 'x' } }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(events(r.text).at(-1)!.data.error).toEqual({ type: 'api_error', message: 'modelStreamErrorException' });
  });

  it('a clean end inside a partial frame is a broken stream', async () => {
    fake.script([{ kind: 'eventstream', events: [START, TEXT_START], partialTail: true }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    const got = events(r.text);
    expect(got.at(-1)!.data.error).toEqual({ type: 'api_error', message: 'The connection upstream stream ended unexpectedly' });
    expect(got.filter((e) => e.event === 'error')).toHaveLength(1);
    await settle();
    expect(usageEvents.map((e) => e.status)).toEqual([502]);
  });

  it('an event-stream error frame is a terminal error naming the code only', async () => {
    fake.script([{ kind: 'eventstream', events: [START, TEXT_START], errorFrame: { code: 'InternalFailure', message: 'secret prompt echo' } }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    const got = events(r.text);
    expect(got.at(-1)).toEqual({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'InternalFailure' } } });
    expect(got.filter((e) => e.event === 'error')).toHaveLength(1);
    expect(r.text).not.toContain('secret prompt echo');
    await settle();
    expect(usageEvents.map((e) => e.status)).toEqual([502]);
  });

  it('a corrupt frame ends the stream with an error event and 502', async () => {
    fake.script([{ kind: 'sse', raw: true, frames: [Buffer.alloc(40, 7)] }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    const got = events(r.text);
    expect(got.at(-1)!.data.error.type).toBe('api_error');
    await settle();
    expect(usageEvents.map((e) => e.status)).toEqual([502]);
  });

  it('upstream 429 ThrottlingException before the stream', async () => {
    fake.script([{ kind: 'status', status: 429, body: { message: 'Too many tokens per day' } }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(r.status).toBe(429);
    expect(r.body.type).toBe('error');
    expect(r.body.error.message).toBe('Too many tokens per day');
    expect(usageEvents.map((e) => e.status)).toEqual([429]);
  });

  it('stream broken mid-way', async () => {
    fake.script([{ kind: 'eventstream', events: STREAM, resetAfter: 2 }]);
    const r = await request(app()).post('/v1/messages').send({ ...BODY, stream: true });
    expect(events(r.text).at(-1)!.data.error.message).toBe('The connection upstream stream ended unexpectedly');
    await settle();
    expect(usageEvents.map((e) => e.status)).toEqual([502]);
  });

  it('client disconnect aborts upstream', async () => {
    fake.script([{ kind: 'eventstream', events: STREAM, delayMs: 100 }]);
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
    await new Promise((r) => setTimeout(r, 150));
    server.close();
    expect(fake.requests[0].closedEarly).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(499);
  });

  describe('a substituted request', () => {
    const SUBSTITUTED = { ...BODY, model: 'claude-sonnet-4-5' };
    beforeEach(() => { substitutions = { 'claude-sonnet-4-5': 'claude-sonnet-4-5--bd' }; });

    it('substituted model bills under the connection model', async () => {
      fake.script([{ kind: 'eventstream', events: STREAM }]);
      const r = await request(app()).post('/v1/messages').send({ ...SUBSTITUTED, stream: true });
      expect(events(r.text)[0].data.message.model).toBe('claude-sonnet-4-5');
      await settle();
      expect(usageEvents.map((e) => e.model)).toEqual(['claude-sonnet-4-5--bd']);
      expect(hookModels).toEqual(['claude-sonnet-4-5--bd']);
    });
  });
});
