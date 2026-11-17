/**
 * An upstream's own short error message (the `message` of its error body or of an in-stream error
 * event) is stored with the status and - where the upstream gives one - its classification, cut to
 * UPSTREAM_MESSAGE_LIMIT characters. Never the rest of the body: another field of the body stays on
 * the console only. The client still receives the upstream's message unchanged.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

let nextPostRejection: any = null;
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: () => {
      const r = nextPostRejection;
      return Promise.reject(Object.assign(new Error(r.message), { response: r.response, isAxiosError: true }));
    },
  },
}));

const CATALOGUE: Record<string, any> = {
  'anthropic--claude-4.5-haiku': { id: 'anthropic--claude-4.5-haiku', owned_by: 'anthropic' },
  'gemini-3.5-flash': { id: 'gemini-3.5-flash', model: 'gemini-3.5-flash', owned_by: 'Google' },
  'gemini-3.5-flash--deployed': {
    id: 'gemini-3.5-flash--deployed', model: 'gemini-3.5-flash', provider: 'google',
    deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-flash',
    versions: [{ capabilities: ['chat', 'streaming', 'tools'] }],
  },
};
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(CATALOGUE[m] || null),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
  },
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfig: () => ({}),
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: () => undefined,
    getAnthropicBedrockVersion: () => '2023-06-01',
    shouldEmulateStreaming: () => false,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'rg-test' }),
    getTimeout: () => 1000,
  },
  getTrustForwardedFor: () => false,
}));
jest.mock('../src/services/anthropicService', () => ({
  __esModule: true,
  default: {
    transformRequestToSAPFormat: () => Promise.resolve({
      config: { modules: { prompt_templating: { prompt: { template: [] }, model: { name: 'anthropic--claude-4.5-haiku' } } } },
    }),
  },
}));
let streamImpl: (onChunk: (c: any) => any) => Promise<void> = async () => {};
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: { streamChatCompletion: (_p: any, onChunk: (c: any) => any) => streamImpl(onChunk) },
}));
jest.mock('../src/services/awsBedrockService', () => ({ __esModule: true, default: { processBedrockRequest: () => Promise.resolve(undefined) } }));
jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (_r: any, _s: any, body: any) => Promise.resolve(body),
  executeStreamPlugins: () => Promise.resolve(undefined),
}));
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: () => Promise.resolve() } }));
jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {}, isPayloadLoggingEnabled: () => false }));
jest.mock('../src/utils/imageTokenCapture', () => ({ captureImageTokensAsync: jest.fn() }));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { getDefaultLogger } from '@libs/logger';
import { handleMessages } from '../src/controllers/anthropicController';
import { handleGemini } from '../src/controllers/googleController';
import { generateImage } from '../src/controllers/imagesController';
import { upstreamCallError } from '../src/utils/streamStart';
import { loggableErrorText, markUpstreamText, shortUpstreamMessage, upstreamErrorText, UPSTREAM_MESSAGE_LIMIT } from '../src/utils/upstreamErrorLogText';
import { startLogShipper, ShippedLogEntry } from '../src/services/logShipper';

const MARKER = 'CONTENT-MARKER-of-Jane-Roe';
// A field of the body other than its message: never stored.
const OTHER = 'OTHER-FIELD-of-Jane-Roe';
const LONG_TAIL = 'TAIL-beyond-the-limit';
const long = (head: string): string => `${head} ${'y'.repeat(UPSTREAM_MESSAGE_LIMIT)} ${LONG_TAIL}`;

describe('the stored text of an upstream refusal', () => {
  it('is the status, the classification and the message cut to 300 characters with an ellipsis', () => {
    expect(UPSTREAM_MESSAGE_LIMIT).toBe(300);
    expect(upstreamErrorText(400, 'INVALID_ARGUMENT', 'Invalid value at x')).toBe('upstream error (status 400, INVALID_ARGUMENT): Invalid value at x');
    expect(upstreamErrorText(429, undefined, '  ')).toBe('upstream error (status 429)');
    expect(upstreamErrorText(undefined, undefined, { message: 'not a string' })).toBe('upstream error (no status)');
    const cut = shortUpstreamMessage('a'.repeat(299) + 'bcd') as string;
    expect(cut).toBe(`${'a'.repeat(299)}b…`);
    expect(shortUpstreamMessage('a'.repeat(300))).toBe('a'.repeat(300));
    // never half of a surrogate pair at the cut
    expect(shortUpstreamMessage(`${'a'.repeat(299)}\u{1F600}tail`)).toBe(`${'a'.repeat(299)}…`);
  });

  it('marks an error with the cut message as its logText; the message the client gets is unchanged', () => {
    const error = markUpstreamText(new Error(long('the upstream said')), 400, 'invalid_request_error');
    expect(error.message).toBe(long('the upstream said'));
    expect(loggableErrorText(error)).toBe(`upstream error (status 400, invalid_request_error): ${shortUpstreamMessage(long('the upstream said'))}`);
    expect(loggableErrorText(error)).not.toContain(LONG_TAIL);
    expect(loggableErrorText(markUpstreamText(new Error('SAP AI Core embedding error: m'), 400, undefined, 'm'))).toBe('upstream error (status 400): m');
  });
});

function mockRes(): any {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {} as Record<string, string>, wire: '',
    writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; };
  r.set = (h: Record<string, string>) => { for (const [k, v] of Object.entries(h)) r.setHeader(k, v); return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; };
  r.write = (s: string) => { r.headersSent = true; r.wire += s; return true; };
  r.end = () => { r.headersSent = true; r.writableEnded = true; };
  return r;
}
function mockReq(body: any, extra: any = {}): any {
  return Object.assign(new EventEmitter(), { body, headers: { 'anthropic-version': '2023-06-01' }, query: {}, method: 'POST', ...extra });
}

describe("an upstream's short error message is in the shipped log, cut, and nothing else of its body", () => {
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

  /**
   * The console holds the marker; the shipped entry for `message` holds it too, but nothing past the
   * limit and no other field of the body. Returns that entry.
   */
  const checked = async (message: string): Promise<ShippedLogEntry> => {
    await jest.advanceTimersByTimeAsync(1000);
    expect(consoleLines.some((l) => l.includes(message) && l.includes(MARKER))).toBe(true);
    const entry = shipped.find((e) => e.message.includes(message));
    expect(entry).toBeDefined();
    expect(entry!.message).toContain(MARKER);
    expect(JSON.stringify(shipped)).not.toContain(OTHER);
    expect(JSON.stringify(shipped)).not.toContain(LONG_TAIL);
    return entry as ShippedLogEntry;
  };

  it('Anthropic route, an in-stream error event: the client gets the text, the shipped entry the status and the message cut', async () => {
    streamImpl = async (onChunk) => {
      await onChunk({ request_id: 'r1', final_result: { id: 'c1', choices: [{ index: 0, delta: { content: '' } }] } });
      await onChunk({ error: { request_id: 'r1', code: 400, location: OTHER, message: long(`400 - LLM Module: ${MARKER}`) } });
    };
    const res = mockRes();
    await handleMessages(mockReq({ model: 'anthropic--claude-4.5-haiku', stream: true, max_tokens: 30, messages: [{ role: 'user', content: 'hi' }] }), res, jest.fn() as any);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain(MARKER);
    expect(JSON.stringify(res.body)).toContain(LONG_TAIL);
    const entry = await checked('Native Stream: upstream error');
    expect(entry.message).toContain('400');
    expect(entry.message).toContain('…');
  });

  it("Gemini native: the client gets the upstream's message, the shipped entry the status, its classification and the message", async () => {
    nextPostRejection = {
      message: 'Request failed with status code 400',
      response: { status: 400, data: { error: { code: 400, message: `Invalid value at ${MARKER}`, status: 'INVALID_ARGUMENT', details: [{ fieldViolations: OTHER }] } } },
    };
    const res = mockRes();
    await handleGemini(mockReq({ contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }] }, {
      params: { modelAndMethod: 'gemini-3.5-flash:generateContent' }, originalUrl: '/google/v1beta/models/gemini-3.5-flash:generateContent',
    }), res, jest.fn() as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain(MARKER);
    const entry = await checked('Gemini request failed');
    expect(entry.message).toContain(`upstream error (status 400, INVALID_ARGUMENT): Invalid value at ${MARKER}`);
  });

  it("images: the client gets the upstream's message, the shipped entry the status, its classification and the message", async () => {
    nextPostRejection = {
      message: 'Request failed with status code 400',
      response: { status: 400, data: { error: { code: 400, message: `The prompt ${MARKER} was refused`, status: 'FAILED_PRECONDITION', reason: OTHER } } },
    };
    const res = mockRes();
    await generateImage(mockReq({ model: 'gemini-3.5-flash', prompt: 'a cat' }), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.error.message).toContain(MARKER);
    const entry = await checked('Image generation failed');
    expect(entry.message).toContain(`upstream error (status 400, FAILED_PRECONDITION): The prompt ${MARKER} was refused`);
  });

  it('the error field: an error carrying the upstream text keeps it whole for the client and the console, the stored error and message hold it cut', async () => {
    const axiosError = Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, headers: {}, data: { message: long(`prompt mentions ${MARKER}`), type: 'ValidationException', detail: OTHER } },
    });
    const error = upstreamCallError(axiosError);
    // what the client is given stays the upstream's text, byte for byte
    expect(error.message).toBe(long(`prompt mentions ${MARKER}`));
    expect(JSON.stringify(error)).not.toContain('logText');
    expect(loggableErrorText(error)).toContain(MARKER);
    expect(loggableErrorText(error)).not.toContain(LONG_TAIL);
    expect(loggableErrorText(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe('connect ECONNREFUSED 127.0.0.1:443');

    getDefaultLogger().error('AnthropicController', `Error in non-streaming request: ${error.message}`, error);
    const entry = await checked('Error in non-streaming request');
    expect(entry.message).toContain(`upstream error (status 400, ValidationException): prompt mentions ${MARKER}`);
    expect(entry.error).toMatch(/^Error: upstream error \(status 400, ValidationException\): prompt mentions /);
    expect(entry.error).not.toContain(LONG_TAIL);
  });
});
