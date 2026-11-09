/**
 * Both Bedrock streaming handlers bill a client that hangs up mid-stream as a 499 with the
 * tokens folded so far, exactly once — the repo convention for a client hang-up (see
 * responsesController's aborted-stream path and googleDispatch). The destroyed upstream never
 * reaches 'end' or its terminal usage, so before this the request emitted no usage event at all.
 *
 * A stream that completes normally keeps its single 200 event, and the response's 'close' after
 * it ended adds nothing. The hang-up is signalled by `res` 'close' with the response unfinished
 * (see test/awsBedrock-stream-real-socket.test.ts for why `req` 'close' is not that signal).
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

const usageEvents: Array<{ metrics: any; model: string; status: number }> = [];
jest.mock('../src/utils/usageTracker', () => {
  const actual = jest.requireActual('../src/utils/usageTracker') as any;
  return {
    ...actual,
    emitUsageEvent: (_req: any, metrics: any, model: string, status: number) => {
      usageEvents.push({ metrics: { ...metrics }, model, status });
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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

type Mode = 'native' | 'emulated';

async function start(mode: Mode, usageMetrics: any) {
  const res = mockRes();
  const req: any = new EventEmitter();
  upstreamStream = new EventEmitter();
  upstreamStream.destroyed = false;
  upstreamStream.destroy = () => { upstreamStream.destroyed = true; };

  if (mode === 'native') {
    req.originalUrl = '/anthropic/v1/messages';
    await handleNativeStreamingRequest({
      targetUrl: 'https://sap.example/v2/inference/deployments/d1/invoke-with-response-stream',
      requestBody: { anthropic_version: 'bedrock-2023-05-31', messages: [{ role: 'user', content: 'hi' }] },
      authToken: 'tok', headers: {}, debugRequestId: '', req, res,
      modelDetails: { id: 'claude-test' } as any, modelId: 'claude-test',
      subpath: 'invoke-with-response-stream', hookConfig: undefined, outputFormat: 'anthropic',
      usageMetrics,
    } as any);
  } else {
    req.originalUrl = '/bedrock/model/anthropic.claude/invoke-with-response-stream';
    await handleEmulatedStreamingRequest({
      targetUrl: 'https://sap.example/v2/inference/deployments/d1/converse-stream',
      requestBody: { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
      authToken: 'tok', headers: {}, debugRequestId: '', req, res,
      modelDetails: { id: 'claude-test' } as any, modelId: 'claude-test',
      subpath: 'converse-stream', originalSubpath: 'invoke-with-response-stream', originalModelId: 'claude-test',
      hookConfig: undefined, usageMetrics,
    } as any);
  }
  return { req, res };
}

/** A partial answer, without the terminal usage event. */
const PARTIAL: Record<Mode, string> = {
  native: `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } })}\n\n`,
  emulated: `data: ${JSON.stringify({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'par' } } })}\n\n`,
};

const TERMINAL = `data: ${JSON.stringify({
  type: 'message_stop',
  'amazon-bedrock-invocationMetrics': { inputTokenCount: 9, outputTokenCount: 21, invocationLatency: 100, firstByteLatency: 50 },
})}\n\n`;

describe.each<Mode>(['native', 'emulated'])('Bedrock %s stream: client disconnect billing', (mode) => {
  beforeEach(() => {
    usageEvents.length = 0;
    upstreamStream = undefined;
  });

  it('client disconnects mid-stream: one 499 event with the tokens folded so far, upstream destroyed', async () => {
    const usageMetrics = createUsageMetrics();
    // Tokens a previous fold already put on the request (e.g. a web_search continuation round).
    usageMetrics.inputTokens = 4;
    usageMetrics.outputTokens = 2;
    const { res } = await start(mode, usageMetrics);

    upstreamStream.emit('data', Buffer.from(PARTIAL[mode]));
    await settle();
    res.emit('close');
    await settle();

    expect(upstreamStream.destroyed).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(499);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 4, outputTokens: 2 });
  });

  it('client disconnects after the terminal usage arrived: still exactly one (200) event', async () => {
    const usageMetrics = createUsageMetrics();
    const { res } = await start(mode, usageMetrics);

    upstreamStream.emit('data', Buffer.from(TERMINAL));
    await settle();
    res.emit('close');
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(200);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 9, outputTokens: 21 });
  });

  it('upstream stream error mid-stream: one 500 event with the tokens folded so far', async () => {
    const usageMetrics = createUsageMetrics();
    usageMetrics.inputTokens = 4;
    usageMetrics.outputTokens = 2;
    const { res } = await start(mode, usageMetrics);

    upstreamStream.emit('data', Buffer.from(PARTIAL[mode]));
    upstreamStream.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await settle();
    // The client eventually goes away; that must not add a 499 on top.
    res.emit('close');
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(500);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 4, outputTokens: 2 });
  });

  it('upstream stream error carrying an HTTP status: billed with that status', async () => {
    const usageMetrics = createUsageMetrics();
    const { res } = await start(mode, usageMetrics);

    upstreamStream.emit('data', Buffer.from(PARTIAL[mode]));
    upstreamStream.emit('error', Object.assign(new Error('upstream overloaded'), { status: 503 }));
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(503);
    if (mode === 'native') {
      // The /anthropic route (outputFormat 'anthropic'): one Anthropic `event: error` ends
      // the stream — not the bare `data: {"error":…}` frame an Anthropic client cannot parse.
      const last = res.chunks[res.chunks.length - 1];
      expect(last).toBe('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream overloaded"}}\n\n');
      expect(res.writableEnded).toBe(true);
    }
  });

  it('client disconnect, then the destroyed upstream errors: only the 499', async () => {
    const usageMetrics = createUsageMetrics();
    const { res } = await start(mode, usageMetrics);

    upstreamStream.emit('data', Buffer.from(PARTIAL[mode]));
    await settle();
    res.emit('close');
    upstreamStream.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(499);
  });

  it('normal stream: one 200 event, and the close after the response ended adds none', async () => {
    const usageMetrics = createUsageMetrics();
    const { res } = await start(mode, usageMetrics);

    upstreamStream.emit('data', Buffer.from(TERMINAL));
    upstreamStream.emit('end');
    await settle();
    expect(res.writableEnded).toBe(true);
    res.emit('close');
    await settle();

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(200);
    expect(usageEvents[0].metrics).toMatchObject({ inputTokens: 9, outputTokens: 21 });
  });
});
