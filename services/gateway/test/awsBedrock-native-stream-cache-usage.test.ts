/**
 * T7 (site 1): `handleNativeStreamingRequest`'s raw usage fold for the
 * `amazon-bedrock-invocationMetrics` envelope on a `message_stop` SSE event
 * (the native/Anthropic-passthrough streaming path SAP uses for Claude Code's
 * direct Anthropic route) must fold the cache read/write split into
 * usageMetrics, not just input/output tokens.
 *
 * Field names (`cacheReadInputTokenCount` / `cacheWriteInputTokenCount`) are
 * CONFIRMED by a real capture in this repo:
 *   services/gateway/logs/payloads/
 *   2026-07-22T04-56-14-543Z_gateway-1784696170168-sxs3wi83e_03_native_streaming_response_from_sap.json
 * (message_stop event: `"amazon-bedrock-invocationMetrics":{"inputTokenCount":1,
 * "outputTokenCount":47,...,"cacheReadInputTokenCount":147942,
 * "cacheWriteInputTokenCount":953}`), and mirrored in
 * test/bedrock-stream-anthropic-passthrough.test.ts.
 *
 * `updateTokenCounts`/`emitUsageEvent` are used unmocked (real usageTracker):
 * `emitUsageEvent` no-ops because the plain `req` here carries no auth info,
 * so this test observes the real cache-token arithmetic on `usageMetrics`
 * rather than asserting on mock call args.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
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

const postBodies: any[] = [];
let upstreamStream: any;
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(async (_url: string, body: any) => {
      postBodies.push(body);
      return { status: 200, data: upstreamStream, headers: {} };
    }),
  },
}));

import { handleNativeStreamingRequest } from '../src/services/awsBedrockService';
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

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A message_stop SSE chunk carrying `amazon-bedrock-invocationMetrics`. */
function messageStopChunk(metrics: Record<string, number>): string {
  return `data: ${JSON.stringify({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': metrics })}\n\n`;
}

async function runRequest(chunk: string, usageMetrics: any) {
  const res = mockRes();
  const req: any = new EventEmitter();
  req.originalUrl = '/anthropic/v1/messages';

  upstreamStream = new EventEmitter();
  upstreamStream.destroy = () => {};

  const done = handleNativeStreamingRequest({
    targetUrl: 'https://sap.example/v2/inference/deployments/d1/invoke-with-response-stream',
    requestBody: {
      anthropic_version: 'bedrock-2023-05-31',
      messages: [{ role: 'user', content: 'hi' }],
    },
    authToken: 'tok',
    headers: {},
    debugRequestId: '',
    req,
    res,
    modelDetails: { id: 'claude-test' } as any,
    modelId: 'claude-test',
    subpath: 'invoke-with-response-stream',
    hookConfig: undefined,
    outputFormat: 'anthropic',
    usageMetrics,
  } as any);

  await new Promise((resolve) => setImmediate(resolve));

  upstreamStream.emit('data', Buffer.from(chunk));
  upstreamStream.emit('end');

  await done;
  await waitFor(() => res.writableEnded, 'the response to be ended');
  req.emit('close');
  return res;
}

describe('handleNativeStreamingRequest — amazon-bedrock-invocationMetrics cache fold (T7 site 1)', () => {
  beforeEach(() => {
    postBodies.length = 0;
    upstreamStream = undefined;
  });

  it('folds cacheReadInputTokenCount/cacheWriteInputTokenCount into usageMetrics', async () => {
    const usageMetrics = createUsageMetrics();
    await runRequest(
      messageStopChunk({
        inputTokenCount: 1,
        outputTokenCount: 47,
        invocationLatency: 3262,
        firstByteLatency: 3143,
        cacheReadInputTokenCount: 147942,
        cacheWriteInputTokenCount: 953,
      }),
      usageMetrics
    );

    expect(usageMetrics.inputTokens).toBe(1);
    expect(usageMetrics.outputTokens).toBe(47);
    expect(usageMetrics.cacheReadInputTokens).toBe(147942);
    expect(usageMetrics.cacheCreationInputTokens).toBe(953);
  });

  it("leaves today's behavior unchanged for a details-less invocationMetrics chunk (no cache fields)", async () => {
    const usageMetrics = createUsageMetrics();
    await runRequest(
      messageStopChunk({
        inputTokenCount: 10,
        outputTokenCount: 20,
        invocationLatency: 100,
        firstByteLatency: 50,
      }),
      usageMetrics
    );

    expect(usageMetrics.inputTokens).toBe(10);
    expect(usageMetrics.outputTokens).toBe(20);
    expect(usageMetrics.cacheReadInputTokens).toBe(0);
    expect(usageMetrics.cacheCreationInputTokens).toBe(0);
  });
});
