/**
 * Client hang-ups on the Bedrock streaming handlers, driven through a REAL http server and client.
 *
 * On Node 20 an IncomingMessage emits 'close' once its body has been consumed — which the body
 * parser has always done before a route handler runs — so a `req.on('close')` registered by the
 * handler never fires for a real hang-up (see onClientClose in controllers/googleWire.ts). The
 * server below consumes the body first, exactly like express.json(), and the tests assert that
 * precondition. Only `res` 'close' (with `writableEnded` still false) signals a real hang-up: the
 * upstream must be destroyed, the native ping interval cleared, and the request billed as one 499.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter, once } from 'events';
import * as http from 'http';
import type { AddressInfo } from 'net';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getTimeout: () => 5000,
    getWebSearchMaxSearches: () => 4,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap' }),
  },
}));

jest.mock('../src/utils/payloadLogger', () => ({
  __esModule: true,
  savePayload: jest.fn(),
}));

let upstreamStream: any;
let upstreamRequested = false;
// Non-null: the upstream call stays pending until the test calls it.
let releasePost: (() => void) | null = null;
let holdPost = false;
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(async () => {
      upstreamRequested = true;
      if (holdPost) await new Promise<void>((resolve) => { releasePost = resolve; });
      return { status: 200, data: upstreamStream, headers: {} };
    }),
  },
}));

const usageEvents: Array<{ metrics: any; status: number }> = [];
jest.mock('../src/utils/usageTracker', () => {
  const actual = jest.requireActual('../src/utils/usageTracker') as any;
  return {
    ...actual,
    emitUsageEvent: (_req: any, metrics: any, _model: string, status: number) => {
      usageEvents.push({ metrics: { ...metrics }, status });
    },
  };
});

import { handleNativeStreamingRequest, handleEmulatedStreamingRequest } from '../src/services/awsBedrockService';
import { createUsageMetrics } from '../src/utils/usageTracker';

type Mode = 'native' | 'emulated';

const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
const PARTIAL: Record<Mode, string> = {
  native: `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } })}`,
  emulated: sse({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'par' } } }),
};

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let server: http.Server;
let reqClosedBeforeHandler: boolean | undefined;
let serverRes: http.ServerResponse | undefined;

function startServer(mode: Mode, usageMetrics: any): Promise<number> {
  server = http.createServer(async (req, res) => {
    // What express.json() does before any route runs: consume the body. On Node 20 the request
    // then emits 'close' on its own, long before the response is finished.
    let reqClosed = false;
    req.on('close', () => { reqClosed = true; });
    req.resume();
    await once(req, 'end');
    await new Promise((r) => setImmediate(r));
    reqClosedBeforeHandler = reqClosed;
    serverRes = res;
    const common = {
      requestBody: { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
      authToken: 'tok', headers: {}, debugRequestId: '', req, res,
      modelDetails: { id: 'claude-test' } as any, modelId: 'claude-test', hookConfig: undefined, usageMetrics,
    };
    if (mode === 'native') {
      await handleNativeStreamingRequest({
        ...common, targetUrl: 'https://sap.example/v2/inference/deployments/d1/invoke-with-response-stream',
        subpath: 'invoke-with-response-stream', outputFormat: 'anthropic',
      } as any);
    } else {
      await handleEmulatedStreamingRequest({
        ...common, targetUrl: 'https://sap.example/v2/inference/deployments/d1/converse-stream',
        subpath: 'converse-stream', originalSubpath: 'invoke-with-response-stream', originalModelId: 'claude-test',
      } as any);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

beforeEach(() => {
  usageEvents.length = 0;
  upstreamRequested = false;
  holdPost = false;
  releasePost = null;
  reqClosedBeforeHandler = undefined;
  serverRes = undefined;
  upstreamStream = new EventEmitter();
  upstreamStream.destroyed = false;
  upstreamStream.destroy = () => { upstreamStream.destroyed = true; };
});

afterEach(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
});

describe.each<Mode>(['native', 'emulated'])('Bedrock %s stream over a real socket', (mode) => {
  it('a client that hangs up mid-stream: upstream destroyed, one 499 with the tokens so far', async () => {
    const usageMetrics = createUsageMetrics();
    usageMetrics.inputTokens = 4;
    const intervals: any[] = [];
    const cleared: any[] = [];
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => {
      const id = realSetInterval(fn, ms);
      intervals.push(id);
      return id;
    }) as any);
    jest.spyOn(global, 'clearInterval').mockImplementation(((id: any) => {
      cleared.push(id);
      return realClearInterval(id);
    }) as any);

    const port = await startServer(mode, usageMetrics);
    const received: string[] = [];
    const client = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/', headers: { 'content-type': 'application/json' } });
    client.on('error', () => { /* our own destroy */ });
    client.on('response', (incoming) => incoming.on('data', (d) => received.push(d.toString())));
    client.end(JSON.stringify({ messages: [] }));

    await waitFor(() => upstreamRequested, 'the upstream call');
    await new Promise((r) => setTimeout(r, 20));
    upstreamStream.emit('data', Buffer.from(PARTIAL[mode]));
    await waitFor(() => received.join('').includes('par'), 'the partial answer at the client');

    client.destroy();
    await waitFor(() => usageEvents.length > 0, 'a usage event').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(reqClosedBeforeHandler).toBe(true);
    expect(serverRes?.writableEnded).toBe(false);
    expect(upstreamStream.destroyed).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(499);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 4 });
    // Every interval the handler started (the native ping) is cleared on the hang-up.
    for (const id of intervals) expect(cleared).toContain(id);
  });

  it('a client that hangs up while the upstream call is still pending: upstream destroyed, one 499', async () => {
    holdPost = true;
    const usageMetrics = createUsageMetrics();
    const intervals: any[] = [];
    const cleared: any[] = [];
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => {
      const id = realSetInterval(fn, ms);
      intervals.push(id);
      return id;
    }) as any);
    jest.spyOn(global, 'clearInterval').mockImplementation(((id: any) => {
      cleared.push(id);
      return realClearInterval(id);
    }) as any);

    const port = await startServer(mode, usageMetrics);
    const client = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/' });
    client.on('error', () => { /* our own destroy */ });
    client.end('{}');
    await waitFor(() => upstreamRequested && releasePost !== null, 'the pending upstream call');

    client.destroy();
    await waitFor(() => serverRes?.destroyed === true, 'the server response to close');
    await new Promise((r) => setTimeout(r, 20));
    releasePost!();
    await new Promise((r) => setTimeout(r, 50));
    // Had the upstream not been destroyed, it would now deliver a complete answer.
    upstreamStream.emit('data', Buffer.from(PARTIAL[mode] + sse({
      type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 9, outputTokenCount: 21 },
    })));
    upstreamStream.emit('end');
    await new Promise((r) => setTimeout(r, 50));

    expect(upstreamStream.destroyed).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(499);
    for (const id of intervals) expect(cleared).toContain(id);
  });

  it('an upstream stream error: the client gets the error frame and the response ends', async () => {
    const usageMetrics = createUsageMetrics();
    const port = await startServer(mode, usageMetrics);
    let ended = false;
    let body = '';
    const client = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/' }, (incoming) => {
      incoming.on('data', (d) => { body += d.toString(); });
      incoming.on('end', () => { ended = true; });
    });
    client.on('error', () => { /* not expected */ });
    client.end('{}');
    await waitFor(() => upstreamRequested, 'the upstream call');
    await new Promise((r) => setTimeout(r, 20));
    upstreamStream.emit('data', Buffer.from(PARTIAL[mode]));
    upstreamStream.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await waitFor(() => ended, 'the response to end', 2000);
    expect(body).toContain('"error"');
    expect(serverRes?.writableEnded).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(500);
  });

  it('a stream that completes normally: one 200, upstream not destroyed', async () => {
    const usageMetrics = createUsageMetrics();
    const port = await startServer(mode, usageMetrics);
    const done = new Promise<string>((resolve) => {
      const client = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/' }, (incoming) => {
        let body = '';
        incoming.on('data', (d) => { body += d.toString(); });
        incoming.on('end', () => resolve(body));
      });
      client.end('{}');
    });
    await waitFor(() => upstreamRequested, 'the upstream call');
    await new Promise((r) => setTimeout(r, 20));
    upstreamStream.emit('data', Buffer.from(PARTIAL[mode] + sse({
      type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 9, outputTokenCount: 21 },
    })));
    upstreamStream.emit('end');
    await done;
    await new Promise((r) => setTimeout(r, 50));

    expect(upstreamStream.destroyed).toBe(false);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(200);
  });
});
