/**
 * A call the upstream rejects, through the real `processBedrockRequest`: every caller gets the
 * same error (the upstream body's message, its status, the parsed body), whichever of the four
 * paths made the call - native or emulated, blocking or streaming.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));

const mockPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...args: any[]) => (mockPost as any)(...args) },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: jest.fn().mockResolvedValue({
      id: 'test-model',
      executableId: 'aws-bedrock',
      deploymentUrl: 'http://mock-sap/x',
      anthropic_version: 'bedrock-2023-05-31',
      subpaths_native: ['invoke', 'invoke-with-response-stream'],
    } as never),
    getAuthToken: jest.fn().mockResolvedValue('tok' as never),
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportedBetaHeaders: () => [],
    getBetaHeaderRenames: () => ({}),
    getExcludedBetaHeaders: () => [],
    getTimeout: () => 1000,
    getConfig: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap' }),
    getSupportsPromptCaching: () => undefined,
  },
}));

const savedPayloads: string[] = [];
jest.mock('../src/utils/payloadLogger', () => ({
  __esModule: true,
  savePayload: (_id: string, name: string) => { savedPayloads.push(name); },
}));

const rateLimits = { success: 0, limited: [] as any[] };
jest.mock('../src/services/rateLimitManager', () => ({
  __esModule: true,
  default: {
    checkAndApplyDelay: async () => 0,
    recordSuccess: () => { rateLimits.success += 1; },
    isRateLimitError: (error: any) => error?.response?.status === 429,
    recordRateLimit: async (_model: string, _subpath: string, error: any) => { rateLimits.limited.push(error); },
  },
}));

jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeAfterPlugins: jest.fn(async (_req: any, _res: any, data: any) => data),
  executeStreamPlugins: jest.fn(async (_req: any, _res: any, chunk: any) => chunk),
}));

import processBedrockRequestModule from '../src/services/awsBedrockService';
import { upstreamCallError } from '../src/utils/streamStart';

const { processBedrockRequest } = processBedrockRequestModule as any;

const RETIRED = 'Model has been retired. Please update your deployment with a new model.';
const retiredBody = { error: 'Gone', message: RETIRED };

/** What the HTTP client throws: its own text, the status, and the body (a stream for a streaming call). */
function clientError(status: number, data: any, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true, code: 'ERR_BAD_REQUEST', status, response: { status, headers, data },
  });
}

function mockRes() {
  const r: any = new EventEmitter();
  r.chunks = [] as string[];
  r.headersSent = false;
  r.writable = true;
  r.writableEnded = false;
  r.statusCode = 200;
  r.setHeader = () => {};
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (body: any) => { r.headersSent = true; r.body = body; r.writableEnded = true; return r; };
  r.write = (s: any) => { r.headersSent = true; r.chunks.push(s.toString()); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

function options(subpath: string, extra: Record<string, unknown> = {}) {
  return {
    modelId: 'test-model', originalModelId: 'test-model', subpath,
    requestBody: { max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    headers: {}, debugRequestId: '', req: new EventEmitter() as any, res: mockRes(), ...extra,
  };
}

beforeEach(() => {
  mockPost.mockReset();
  savedPayloads.length = 0;
  rateLimits.success = 0;
  rateLimits.limited.length = 0;
});

describe('upstreamCallError: one shape for a rejected upstream call', () => {
  it('takes the message from the body, keeps status, code, headers and the parsed body, and the client error as cause', () => {
    const original = clientError(410, retiredBody, { 'retry-after': '7' });
    const failure = upstreamCallError(original);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(RETIRED);
    expect(failure.status).toBe(410);
    expect(failure.code).toBe('ERR_BAD_REQUEST');
    expect(failure.response).toEqual({ status: 410, headers: { 'retry-after': '7' }, data: retiredBody });
    expect(failure.cause).toBe(original);
  });

  it('reads a nested error object and a body that arrived as a JSON string', () => {
    expect(upstreamCallError(clientError(400, { error: { message: 'prompt is too long' } })).message).toBe('prompt is too long');
    expect(upstreamCallError(clientError(400, null), '{"message":"prompt is too long"}').message).toBe('prompt is too long');
  });

  it('a body without a message keeps the client\'s text', () => {
    expect(upstreamCallError(clientError(502, '<html>Bad Gateway</html>')).message).toBe('Request failed with status code 502');
  });

  it('an error without an upstream answer, and one already in this shape, come back as they are', () => {
    const timeout = Object.assign(new Error('timeout of 1000ms exceeded'), { code: 'ECONNABORTED' });
    expect(upstreamCallError(timeout)).toBe(timeout);
    const failure = upstreamCallError(clientError(410, retiredBody));
    expect(upstreamCallError(failure)).toBe(failure);
  });
});

describe('a blocking call the upstream rejects', () => {
  it.each([
    ['native', 'invoke'],
    ['emulated', 'converse'],
  ])('%s: rejects with the upstream\'s message, status and parsed body', async (_kind, subpath) => {
    mockPost.mockRejectedValueOnce(clientError(410, retiredBody) as never);

    const failure: any = await processBedrockRequest(options(subpath)).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(RETIRED);
    expect(failure.status).toBe(410);
    expect(failure.response.status).toBe(410);
    expect(failure.response.data).toEqual(retiredBody);
  });

  it('a call that never got an answer rejects with the client\'s own error', async () => {
    const timeout = Object.assign(new Error('timeout of 1000ms exceeded'), { code: 'ECONNABORTED' });
    mockPost.mockRejectedValueOnce(timeout as never);

    await expect(processBedrockRequest(options('invoke'))).rejects.toBe(timeout);
  });
});

describe('a streaming call the upstream rejects before the stream starts', () => {
  const streamed = (body: unknown) => Readable.from([Buffer.from(JSON.stringify(body))]);

  it.each([
    ['native', 'invoke-with-response-stream'],
    ['emulated', 'converse-stream'],
  ])('%s, Bedrock format: the client is told the upstream\'s message, not the HTTP client\'s text', async (_kind, subpath) => {
    mockPost.mockRejectedValueOnce(clientError(410, streamed(retiredBody)) as never);
    const opts = options(subpath);

    await processBedrockRequest(opts).catch(() => undefined);

    const wire = opts.res.chunks.join('');
    expect(wire).toContain(RETIRED);
    expect(wire).not.toContain('Request failed with status code');
    expect(wire).toContain('"code":410');
  });

  it.each([
    ['native', 'invoke-with-response-stream'],
    ['emulated', 'converse-stream'],
  ])('%s, Anthropic format: HTTP 410 with the upstream\'s message', async (_kind, subpath) => {
    mockPost.mockRejectedValueOnce(clientError(410, streamed(retiredBody)) as never);
    const opts = options(subpath, { outputFormat: 'anthropic' });

    await processBedrockRequest(opts).catch(() => undefined);

    expect(opts.res.statusCode).toBe(410);
    expect(opts.res.body.error.message).toBe(RETIRED);
    expect(opts.res.chunks).toEqual([]);
  });
});

describe('a streaming call the upstream rejects is counted as the failure it is', () => {
  const streamed = (body: unknown) => Readable.from([Buffer.from(JSON.stringify(body))]);
  const paths: Array<[string, string]> = [
    ['native', 'invoke-with-response-stream'],
    ['emulated', 'converse-stream'],
  ];

  it.each(paths)('%s: the caller gets the error after the client was answered, and no success is recorded', async (_kind, subpath) => {
    mockPost.mockRejectedValueOnce(clientError(410, streamed(retiredBody)) as never);
    const opts = options(subpath);

    const failure: any = await processBedrockRequest(opts).then(() => 'resolved', (e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: RETIRED, status: 410 });
    expect(failure.response.data).toEqual(retiredBody);
    // Answered once, by the streaming handler: the caller only counts the failure.
    expect(opts.res.chunks).toHaveLength(1);
    expect(opts.res.writableEnded).toBe(true);
    expect(rateLimits.success).toBe(0);
    expect(rateLimits.limited).toEqual([]);
  });

  it.each(paths)('%s: a 429 sets the back-off', async (_kind, subpath) => {
    mockPost.mockRejectedValueOnce(clientError(429, streamed({ message: 'Too many requests' }), { 'retry-after': '7' }) as never);

    await processBedrockRequest(options(subpath)).catch(() => undefined);

    expect(rateLimits.success).toBe(0);
    expect(rateLimits.limited).toHaveLength(1);
    expect(rateLimits.limited[0].response).toMatchObject({ status: 429, headers: { 'retry-after': '7' } });
  });

  it.each(paths)('%s: a call that never got an answer is a failure for the caller too', async (_kind, subpath) => {
    const timeout = Object.assign(new Error('timeout of 1000ms exceeded'), { code: 'ECONNABORTED' });
    mockPost.mockRejectedValueOnce(timeout as never);
    const opts = options(subpath);

    await expect(processBedrockRequest(opts)).rejects.toBe(timeout);

    expect(opts.res.chunks.join('')).toContain('timeout of 1000ms exceeded');
    expect(rateLimits.success).toBe(0);
  });

  it('the failure is logged once: the streaming handler\'s payload, not the blocking path\'s as well', async () => {
    mockPost.mockRejectedValueOnce(clientError(410, streamed(retiredBody)) as never);

    await processBedrockRequest(options('invoke-with-response-stream', { debugRequestId: 'dbg-1' })).catch(() => undefined);

    const errorPayloads = savedPayloads.filter((name) => name.includes('error_from_sap'));
    expect(errorPayloads).toEqual(['03_native_streaming_error_from_sap']);
  });
});
