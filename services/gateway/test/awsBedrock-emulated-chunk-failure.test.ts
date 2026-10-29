/**
 * Emulated Bedrock stream: when processing a chunk fails (e.g. a stream plugin throws), the client
 * gets an error frame and sseWriter.writeError ends the response, so the stream is over for the
 * client. The request must be billed as that failure exactly once — not as a 200 when the
 * upstream later ends — and the upstream, which nobody reads any more, is destroyed.
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
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap' }),
  },
}));

jest.mock('../src/utils/payloadLogger', () => ({
  __esModule: true,
  savePayload: jest.fn(),
}));

let pluginThrows = false;
jest.mock('../src/services/pluginExecutor', () => ({
  executeStreamPlugins: async (_req: any, _res: any, chunk: any) => {
    if (pluginThrows) throw new Error('stream plugin exploded');
    return chunk;
  },
  executeAfterPlugins: async (_req: any, _res: any, body: any) => body,
}));

let upstreamStream: any;
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(async () => ({ status: 200, data: upstreamStream, headers: {} })),
  },
}));

const usageEvents: Array<{ status: number }> = [];
jest.mock('../src/utils/usageTracker', () => {
  const actual = jest.requireActual('../src/utils/usageTracker') as any;
  return {
    ...actual,
    emitUsageEvent: (_req: any, _metrics: any, _model: string, status: number) => { usageEvents.push({ status }); },
  };
});

import { handleEmulatedStreamingRequest } from '../src/services/awsBedrockService';
import { createUsageMetrics } from '../src/utils/usageTracker';

function mockRes() {
  const r: any = new EventEmitter();
  r.chunks = [] as string[];
  r.headersSent = false;
  r.writable = true;
  r.writableEnded = false;
  r.setHeader = () => {};
  r.write = (s: any) => { r.chunks.push(s.toString()); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;

async function start() {
  const res = mockRes();
  const req: any = new EventEmitter();
  upstreamStream = new EventEmitter();
  upstreamStream.destroyed = false;
  upstreamStream.destroy = () => { upstreamStream.destroyed = true; };
  await handleEmulatedStreamingRequest({
    targetUrl: 'https://sap.example/v2/inference/deployments/d1/converse-stream',
    requestBody: { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
    authToken: 'tok', headers: {}, debugRequestId: '', req, res,
    modelDetails: { id: 'claude-test' } as any, modelId: 'claude-test',
    subpath: 'converse-stream', originalSubpath: 'invoke-with-response-stream', originalModelId: 'claude-test',
    hookConfig: { rules: [] }, usageMetrics: createUsageMetrics(),
  } as any);
  return res;
}

describe('emulated Bedrock stream: a chunk that fails to process', () => {
  beforeEach(() => { usageEvents.length = 0; pluginThrows = false; });

  it('error frame, response ended, upstream destroyed, and one error event even when the upstream later ends', async () => {
    const res = await start();
    upstreamStream.emit('data', Buffer.from(sse({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'ok' } } })));
    await settle();
    pluginThrows = true;
    upstreamStream.emit('data', Buffer.from(sse({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'boom' } } })));
    await settle();
    // Upstream keeps going (only a destroyed stream stops); its usage and end must not rebill.
    upstreamStream.emit('data', Buffer.from(sse({ metadata: { usage: { inputTokens: 3, outputTokens: 4 } } })));
    upstreamStream.emit('end');
    await settle();

    expect(res.chunks.join('')).toContain('stream plugin exploded');
    expect(res.writableEnded).toBe(true);
    expect(upstreamStream.destroyed).toBe(true);
    expect(usageEvents).toEqual([{ status: 500 }]);
  });

  it('no failure: unchanged, one 200', async () => {
    await start();
    upstreamStream.emit('data', Buffer.from(sse({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'ok' } } })));
    upstreamStream.emit('data', Buffer.from(sse({ metadata: { usage: { inputTokens: 3, outputTokens: 4 } } })));
    upstreamStream.emit('end');
    await settle();

    expect(upstreamStream.destroyed).toBe(false);
    expect(usageEvents).toEqual([{ status: 200 }]);
  });
});
