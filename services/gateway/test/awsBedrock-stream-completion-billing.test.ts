/**
 * Every Bedrock stream that completes bills exactly one 200 usage event with the tokens the
 * stream reported:
 *
 *  - native direct-passthrough mode (a streaming subpath other than invoke-with-response-stream,
 *    e.g. converse-stream) writes the upstream bytes through unparsed, and used to emit no usage
 *    event at all. It now reads the usage off the same Converse events the emulated handler parses
 *    (`metadata.usage`, or a `message_stop` carrying `amazon-bedrock-invocationMetrics`).
 *  - a parsed (native or emulated) stream that ends without any usage event still bills its 200.
 *
 * Existing terminal-usage emits keep the single event (eventEmitted guard).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

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
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(async () => ({ status: 200, data: upstreamStream, headers: {} })),
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

function mockRes() {
  const r: any = new EventEmitter();
  r.chunks = [] as string[];
  r.headersSent = false;
  r.writable = true;
  r.writableEnded = false;
  r.statusCode = 200;
  r.setHeader = () => {};
  // Like Node: the first write sends the headers.
  r.write = (s: any) => { r.headersSent = true; r.chunks.push(s.toString()); return true; };
  r.end = () => { r.headersSent = true; r.writableEnded = true; };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; };
  return r;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

type Mode = 'passthrough' | 'parsed-native' | 'emulated';

async function start(mode: Mode, usageMetrics: any, requestBody: any = { messages: [{ role: 'user', content: [{ text: 'hi' }] }] }) {
  const res = mockRes();
  const req: any = new EventEmitter();
  upstreamStream = new EventEmitter();
  upstreamStream.destroy = () => {};
  const common = {
    requestBody,
    authToken: 'tok', headers: {}, debugRequestId: '', req, res,
    modelDetails: { id: 'claude-test' } as any, modelId: 'claude-test', hookConfig: undefined, usageMetrics,
  };
  if (mode === 'emulated') {
    await handleEmulatedStreamingRequest({
      ...common,
      targetUrl: 'https://sap.example/v2/inference/deployments/d1/converse-stream',
      subpath: 'converse-stream', originalSubpath: 'invoke-with-response-stream', originalModelId: 'claude-test',
    } as any);
  } else {
    const subpath = mode === 'passthrough' ? 'converse-stream' : 'invoke-with-response-stream';
    await handleNativeStreamingRequest({
      ...common,
      targetUrl: `https://sap.example/v2/inference/deployments/d1/${subpath}`,
      subpath, outputFormat: 'anthropic',
    } as any);
  }
  return { req, res };
}

const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
const TEXT_DELTA = sse({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hello' } } });
const METADATA = sse({ metadata: { usage: { inputTokens: 12, outputTokens: 34, cacheReadInputTokens: 5 } } });
const MESSAGE_STOP = sse({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 12, outputTokenCount: 34 } });

describe('Bedrock native passthrough stream: a completed request bills one 200 with the reported usage', () => {
  beforeEach(() => { usageEvents.length = 0; });

  it('Converse metadata.usage: one 200 with the folded tokens, bytes still passed through', async () => {
    const usageMetrics = createUsageMetrics();
    const { res, req } = await start('passthrough', usageMetrics);
    // The usage event split across two network chunks.
    upstreamStream.emit('data', Buffer.from(TEXT_DELTA + METADATA.slice(0, 20)));
    upstreamStream.emit('data', Buffer.from(METADATA.slice(20)));
    upstreamStream.emit('end');
    await settle();
    req.emit('close');
    await settle();

    expect(res.chunks.join('')).toBe(TEXT_DELTA + METADATA);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(200);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 12, outputTokens: 34, cacheReadInputTokens: 5 });
  });

  it('usage in both metadata and message_stop: folded once', async () => {
    const usageMetrics = createUsageMetrics();
    await start('passthrough', usageMetrics);
    upstreamStream.emit('data', Buffer.from(TEXT_DELTA + METADATA + MESSAGE_STOP));
    upstreamStream.emit('end');
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 12, outputTokens: 34 });
  });

  it('a stream without any usage event: still one 200 (zero tokens)', async () => {
    const usageMetrics = createUsageMetrics();
    await start('passthrough', usageMetrics);
    upstreamStream.emit('data', Buffer.from(TEXT_DELTA));
    upstreamStream.emit('end');
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(200);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe.each<Mode>(['parsed-native', 'emulated'])('Bedrock %s stream that ends without a usage event', (mode) => {
  beforeEach(() => { usageEvents.length = 0; });

  it('bills one 200 on end', async () => {
    const usageMetrics = createUsageMetrics();
    await start(mode, usageMetrics);
    const partial = mode === 'emulated'
      ? TEXT_DELTA
      : `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}`;
    upstreamStream.emit('data', Buffer.from(partial));
    upstreamStream.emit('end');
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(200);
  });

  it('a terminal usage event already emitted: still exactly one', async () => {
    const usageMetrics = createUsageMetrics();
    await start(mode, usageMetrics);
    upstreamStream.emit('data', Buffer.from(MESSAGE_STOP));
    upstreamStream.emit('end');
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(200);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 12, outputTokens: 34 });
  });
});

describe.each<Mode>(['passthrough', 'parsed-native', 'emulated'])('Bedrock %s stream that ends with no data at all', (mode) => {
  beforeEach(() => { usageEvents.length = 0; });

  // In the client's protocol. The Anthropic route (outputFormat 'anthropic'): the status and
  // Anthropic's error body while nothing was sent (passthrough), or one `event: error` when the
  // stream had already started with pings (parsed-native). The Bedrock route keeps its frame.
  it('answers with an error in the client\'s protocol, never invented assistant text or token counts, and bills one 502', async () => {
    const usageMetrics = createUsageMetrics();
    const { res } = await start(mode, usageMetrics);
    upstreamStream.emit('end');
    await settle();

    const body = res.chunks.join('');
    expect(body).not.toMatch(/AI assistant|How can I help/);
    expect(body).not.toContain('inputTokenCount');
    const anthropicError = { type: 'error', error: { type: 'api_error', message: 'The upstream stream ended without any data' } };
    if (mode === 'passthrough') {
      expect(res.statusCode).toBe(502);
      expect(res.body).toEqual(anthropicError);
    } else if (mode === 'parsed-native') {
      expect(res.chunks[res.chunks.length - 1]).toBe(`event: error\ndata: ${JSON.stringify(anthropicError)}\n\n`);
    } else {
      const errorBlock = body.split('\n\n').find((b: string) => b.startsWith('data: {"error"'));
      expect(JSON.parse(errorBlock!.slice('data: '.length)).error.code).toBe(502);
    }
    expect(res.writableEnded).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(502);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('Bedrock native stream with web_search interception that ends with no data at all', () => {
  beforeEach(() => { usageEvents.length = 0; });

  it('bills the same 502 the client is told about, once', async () => {
    const usageMetrics = createUsageMetrics();
    const { res } = await start('parsed-native', usageMetrics, {
      anthropic_version: 'bedrock-2023-05-31',
      messages: [{ role: 'user', content: 'what is new in zig?' }],
      tools: [{ name: 'web_search', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
    });
    upstreamStream.emit('end');
    await settle();

    expect(res.chunks[res.chunks.length - 1]).toMatch(/^event: error\ndata: \{"type":"error","error":\{"type":"api_error"/);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(502);
  });
});
