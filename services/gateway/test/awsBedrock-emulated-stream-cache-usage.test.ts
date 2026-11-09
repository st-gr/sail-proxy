/**
 * T7 (sites 2 & 3): `handleEmulatedStreamingRequest`'s two raw usage-fold sites
 * — the Converse `metadata.usage` event (site 2) and the `message_stop` +
 * `amazon-bedrock-invocationMetrics` fallback (site 3, "current format") —
 * must both fold the cache read/write split into usageMetrics.
 *
 * Site 3's field names (`cacheReadInputTokenCount` / `cacheWriteInputTokenCount`)
 * are the same `amazon-bedrock-invocationMetrics` envelope CONFIRMED by a real
 * capture — see test/awsBedrock-native-stream-cache-usage.test.ts and the
 * task-T6 report for the capture citation.
 *
 * Site 2's field names (`cacheReadInputTokens` / `cacheWriteInputTokens` on
 * Converse `metadata.usage`) are per AWS docs, unconfirmed by any capture in
 * this repo — see task-T6 report. No local capture exercises the raw Converse
 * streaming metadata event; local traffic exclusively hits the SAP native
 * Anthropic passthrough route (handled by handleNativeStreamingRequest, not
 * this function).
 *
 * `updateTokenCounts`/`emitUsageEvent` are used unmocked (real usageTracker):
 * `emitUsageEvent` no-ops because the plain `req` here carries no auth info,
 * so this test observes the real cache-token arithmetic on `usageMetrics`.
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

import { handleEmulatedStreamingRequest } from '../src/services/awsBedrockService';
import { createUsageMetrics, updateTokenCounts } from '../src/utils/usageTracker';

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

/** Poll until the real (unmocked) `updateTokenCounts` fold has actually run. */
async function waitForFold(usageMetrics: any, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (usageMetrics.inputTokens === 0 && usageMetrics.outputTokens === 0) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the usage fold to run');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // Give any remaining microtasks (e.g. emitUsageEvent's fire-and-forget) a turn.
  await new Promise((resolve) => setImmediate(resolve));
}

async function runRequest(chunk: string, usageMetrics: any) {
  const res = mockRes();
  const req: any = new EventEmitter();
  req.originalUrl = '/bedrock/model/anthropic.claude/invoke-with-response-stream';

  upstreamStream = new EventEmitter();
  upstreamStream.destroy = () => {};

  const done = handleEmulatedStreamingRequest({
    targetUrl: 'https://sap.example/v2/inference/deployments/d1/converse-stream',
    requestBody: { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
    authToken: 'tok',
    headers: {},
    debugRequestId: '',
    req,
    res,
    modelDetails: { id: 'claude-test' } as any,
    modelId: 'claude-test',
    subpath: 'converse-stream',
    originalSubpath: 'invoke-with-response-stream',
    originalModelId: 'claude-test',
    hookConfig: undefined,
    usageMetrics,
  } as any);

  await new Promise((resolve) => setImmediate(resolve));
  upstreamStream.emit('data', Buffer.from(chunk));
  await waitForFold(usageMetrics);
  upstreamStream.emit('end');
  await done;
  req.emit('close');
  return res;
}

describe('handleEmulatedStreamingRequest — raw usage-fold cache split (T7 sites 2 & 3)', () => {
  beforeEach(() => {
    upstreamStream = undefined;
  });

  describe('site 2: Converse metadata.usage event', () => {
    it('folds cacheReadInputTokens/cacheWriteInputTokens into usageMetrics', async () => {
      const usageMetrics = createUsageMetrics();
      const chunk = `data: ${JSON.stringify({
        metadata: {
          usage: {
            inputTokens: 15,
            outputTokens: 60,
            cacheReadInputTokens: 20000,
            cacheWriteInputTokens: 500,
          },
          metrics: { latencyMs: 900, firstByteLatency: 120 },
        },
      })}\n\n`;

      await runRequest(chunk, usageMetrics);

      expect(usageMetrics.inputTokens).toBe(15);
      expect(usageMetrics.outputTokens).toBe(60);
      expect(usageMetrics.cacheReadInputTokens).toBe(20000);
      expect(usageMetrics.cacheCreationInputTokens).toBe(500);
    });

    it("leaves today's behavior unchanged for a details-less metadata.usage chunk (no cache fields)", async () => {
      const usageMetrics = createUsageMetrics();
      const chunk = `data: ${JSON.stringify({
        metadata: { usage: { inputTokens: 8, outputTokens: 4 } },
      })}\n\n`;

      await runRequest(chunk, usageMetrics);

      expect(usageMetrics.inputTokens).toBe(8);
      expect(usageMetrics.outputTokens).toBe(4);
      expect(usageMetrics.cacheReadInputTokens).toBe(0);
      expect(usageMetrics.cacheCreationInputTokens).toBe(0);
    });
  });

  describe('site 3: message_stop + amazon-bedrock-invocationMetrics (current format)', () => {
    it('folds cacheReadInputTokenCount/cacheWriteInputTokenCount into usageMetrics', async () => {
      const usageMetrics = createUsageMetrics();
      const chunk = `data: ${JSON.stringify({
        type: 'message_stop',
        'amazon-bedrock-invocationMetrics': {
          inputTokenCount: 3,
          outputTokenCount: 114,
          invocationLatency: 6326,
          firstByteLatency: 6152,
          cacheReadInputTokenCount: 0,
          cacheWriteInputTokenCount: 161525,
        },
      })}\n\n`;

      await runRequest(chunk, usageMetrics);

      expect(usageMetrics.inputTokens).toBe(3);
      expect(usageMetrics.outputTokens).toBe(114);
      expect(usageMetrics.cacheReadInputTokens).toBe(0);
      expect(usageMetrics.cacheCreationInputTokens).toBe(161525);
    });

    it("leaves today's behavior unchanged for a details-less invocationMetrics chunk (no cache fields)", async () => {
      const usageMetrics = createUsageMetrics();
      const chunk = `data: ${JSON.stringify({
        type: 'message_stop',
        'amazon-bedrock-invocationMetrics': {
          inputTokenCount: 9,
          outputTokenCount: 21,
          invocationLatency: 100,
          firstByteLatency: 50,
        },
      })}\n\n`;

      await runRequest(chunk, usageMetrics);

      expect(usageMetrics.inputTokens).toBe(9);
      expect(usageMetrics.outputTokens).toBe(21);
      expect(usageMetrics.cacheReadInputTokens).toBe(0);
      expect(usageMetrics.cacheCreationInputTokens).toBe(0);
    });
  });

  it('sanity: real updateTokenCounts is in play (not a mock)', () => {
    expect((updateTokenCounts as any)._isMockFunction).toBeUndefined();
  });
});
