/**
 * A rate-limited Bedrock call logs a WARN that interpolates the upstream error's message without
 * passing the error. The stored entry names the status and the upstream's message cut to 300
 * characters, and no other field of the body; the console line keeps the whole text (metadata); the
 * caller still gets the upstream's message.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

const mockPost: jest.Mock<any> = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: () => Promise.resolve({
      id: 'test-model', executableId: 'aws-bedrock', deploymentUrl: 'http://mock-sap/x',
      anthropic_version: 'bedrock-2023-05-31', subpaths_native: ['invoke', 'invoke-with-response-stream'],
    }),
    getAuthToken: () => Promise.resolve('tok'),
  },
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportedBetaHeaders: () => [], getBetaHeaderRenames: () => ({}), getExcludedBetaHeaders: () => [],
    getTimeout: () => 1000, getConfig: () => ({}), getSAPAICoreConfig: () => ({ url: 'http://mock-sap' }),
    getSupportsPromptCaching: () => undefined,
  },
}));
jest.mock('../src/utils/payloadLogger', () => ({ __esModule: true, savePayload: () => {} }));
jest.mock('../src/services/rateLimitManager', () => ({
  __esModule: true,
  default: {
    checkAndApplyDelay: async () => 0,
    recordSuccess: () => {},
    isRateLimitError: (error: any) => error?.status === 429 || error?.response?.status === 429,
    recordRateLimit: async () => {},
  },
}));
jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeAfterPlugins: async (_r: any, _s: any, d: any) => d,
  executeStreamPlugins: async (_r: any, _s: any, c: any) => c,
}));

import bedrock from '../src/services/awsBedrockService';
import { startLogShipper, ShippedLogEntry } from '../src/services/logShipper';

const MARKER = 'CONTENT-MARKER-of-Jane-Roe';

describe('a rate-limited Bedrock call', () => {
  let consoleLines: string[];
  let shipped: ShippedLogEntry[];
  let stop: () => void;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    consoleLines = [];
    shipped = [];
    for (const m of ['info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, m).mockImplementation((l: unknown) => { consoleLines.push(String(l)); });
    }
    stop = startLogShipper({ publish: async (b) => { shipped.push(...b); }, settings: () => ({ enabled: true, minLevel: 'INFO' }), warn: () => undefined });
  });
  afterEach(() => { stop(); jest.useRealTimers(); jest.restoreAllMocks(); });

  it("keeps the upstream's words on the console and for the caller, and its short message in the stored WARN", async () => {
    const tail = 'TAIL-beyond-the-limit';
    const message = `Too many tokens from ${MARKER} ${'y'.repeat(300)} ${tail}`;
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 429'), {
      isAxiosError: true, status: 429, response: { status: 429, headers: {}, data: { message, reason: 'OTHER-FIELD-of-Jane-Roe' } },
    }));
    const res: any = Object.assign(new EventEmitter(), { headersSent: false, writable: true, writableEnded: false, setHeader: () => {}, status: () => res, json: () => res, write: () => true, end: () => {} });
    const error = await (bedrock as any).processBedrockRequest({
      modelId: 'test-model', originalModelId: 'test-model', subpath: 'invoke',
      requestBody: { max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, headers: {}, debugRequestId: '', req: new EventEmitter(), res,
    }).then(() => null, (e: any) => e);
    expect(error.message).toBe(message);
    await jest.advanceTimersByTimeAsync(1000);
    expect(consoleLines.some((l) => l.includes('Rate limit detected') && l.includes(tail))).toBe(true);
    const entry = shipped.find((e) => e.message.includes('Rate limit detected'));
    expect(entry?.message).toContain(`upstream error (status 429): Too many tokens from ${MARKER} `);
    expect(entry?.message).toContain('…');
    expect(JSON.stringify(shipped)).not.toContain(tail);
    expect(JSON.stringify(shipped)).not.toContain('OTHER-FIELD');
  });
});
