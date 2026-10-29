/**
 * /anthropic/v1/messages streaming: what a client receives when the upstream fails, is slow,
 * or the client leaves — at the byte level, through the real sseWriter.
 *
 * Measured against SAP on 2026-10-13: an oversized prompt is answered with HTTP 200, a
 * templating chunk with an empty delta, then `{error:{code:400, message:"400 - LLM Module:
 * prompt is too long: 600024 tokens > 200000 maximum"}}`, and the stream promise RESOLVES.
 * The gateway used to have sent `200` + message_start already, wrote the error as an event
 * whose `error.type` was the number 400, then appended message_delta(end_turn) +
 * message_stop — an empty "successful" turn. Claude Code then reported "Streaming response
 * ended before any complete data was received" instead of auto-compacting.
 *
 * Anthropic's contract: a failure before the stream starts is the HTTP status with
 * `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: …"}}`;
 * a failure after it is ONE `event: error` with that body, then the end of the stream.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

let emulate = false;
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    // Read by the forced-pseudonymization check: nothing forces masking here.
    getConfig: () => ({}),
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: () => undefined,
    getAnthropicBedrockVersion: () => '2023-06-01',
    shouldEmulateStreaming: () => emulate,
  },
}));

let modelDetails: any = { id: 'anthropic--claude-4.5-haiku', owned_by: 'anthropic' };
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: () => Promise.resolve(modelDetails),
    modelSupportsStreaming: () => true,
  },
}));

jest.mock('../src/services/anthropicService', () => ({
  __esModule: true,
  default: {
    transformRequestToSAPFormat: () => Promise.resolve({
      config: { modules: { prompt_templating: { prompt: { template: [] }, model: { name: 'anthropic--claude-4.5-haiku' } } } },
    }),
  },
}));

// The fake upstream: each test installs the stream body it needs.
type StreamImpl = (onChunk: (c: any) => any, signal: AbortSignal) => Promise<void>;
let streamImpl: StreamImpl = async () => {};
let completeImpl: () => Promise<any> = () => Promise.resolve(null);
let seenSignal: AbortSignal | undefined;
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    completeChat: () => completeImpl(),
    streamChatCompletion: (_payload: any, onChunk: (c: any) => any, signal: AbortSignal) => {
      seenSignal = signal;
      return streamImpl(onChunk, signal);
    },
  },
}));

let bedrockImpl: () => Promise<any> = () => Promise.resolve(undefined);
jest.mock('../src/services/awsBedrockService', () => ({
  __esModule: true,
  default: { processBedrockRequest: () => bedrockImpl() },
}));
jest.mock('../src/services/pluginExecutor', () => ({ executeBeforePlugins: () => Promise.resolve({ stop: false }) }));
jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {}, isPayloadLoggingEnabled: () => false }));
jest.mock('../src/utils/modelEntitlement', () => ({ enforceEntitlement: () => true }));
jest.mock('../src/utils/imageTokenCapture', () => ({ captureImageTokensAsync: jest.fn() }));

const usageEvents: any[] = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: (_req: any, m: any, model: string, status: number) => { usageEvents.push({ ...m, model, status }); },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0;
    m.cacheReadInputTokens += cacheRead || 0;
  },
}));

import { handleMessages } from '../src/controllers/anthropicController';
import { anthropicErrorType, anthropicErrorMessage } from '../src/utils/anthropicErrors';
import { failureFromError, failureFromChunk, httpStatusOr } from '../src/utils/streamStart';

/** An Express-like response that records the wire: status, headers, raw bytes, JSON body. */
function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {} as Record<string, string>, wire: '',
    writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = (k: string, v: string) => {
    if (r.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
    r.headers[k.toLowerCase()] = v;
  };
  r.set = (h: Record<string, string>) => { for (const [k, v] of Object.entries(h)) r.setHeader(k, v); return r; };
  r.json = (b: any) => {
    if (!r.headers['content-type']) r.headers['content-type'] = 'application/json';
    r.body = b; r.headersSent = true; r.writableEnded = true; return r;
  };
  r.write = (s: string) => { if (r.writableEnded) throw new Error('write after end'); r.headersSent = true; r.wire += s; return true; };
  r.end = () => { r.headersSent = true; r.writableEnded = true; };
  return r;
}

function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = { 'anthropic-version': '2023-06-01' };
  r.query = {};
  return r;
}

const body = (stream = true) => ({
  model: 'anthropic--claude-4.5-haiku', stream, max_tokens: 30,
  messages: [{ role: 'user', content: 'Say hi in three words.' }],
});

/** SAP's first chunk: the templating result, with an empty delta. */
const templatingChunk = {
  request_id: 'r1',
  intermediate_results: { templating: [{ role: 'user', content: 'Say hi in three words.' }] },
  final_result: { id: 'c1', object: 'chat.completion.chunk', model: 'claude', choices: [{ index: 0, delta: { content: '' } }] },
};
const textChunk = (content: string, extra: { finish_reason?: string; usage?: any } = {}) => ({
  request_id: 'r1',
  final_result: {
    id: 'c1', object: 'chat.completion.chunk', model: 'claude',
    choices: [{ index: 0, delta: { content }, finish_reason: extra.finish_reason ?? null }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  },
});
const TOO_LONG = {
  error: {
    request_id: 'r1', code: 400, location: 'LLM Module',
    message: '400 - LLM Module: prompt is too long: 600024 tokens > 200000 maximum',
    intermediate_results: { templating: [{ role: 'user', content: 'SECRET PROMPT TEXT' }] },
  },
};

/** The SSE events on the wire, in order. */
function events(wire: string): Array<{ event: string; data: any }> {
  return wire.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return { event, data: data && data !== '[DONE]' ? JSON.parse(data) : data };
  });
}

/** Let queued microtasks and the controller's chunk chain run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  usageEvents.length = 0;
  emulate = false;
  modelDetails = { id: 'anthropic--claude-4.5-haiku', owned_by: 'anthropic' };
  streamImpl = async () => {};
  completeImpl = () => Promise.resolve(null);
  bedrockImpl = () => Promise.resolve(undefined);
  seenSignal = undefined;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a failure before the stream started is an HTTP error in Anthropic\'s shape', () => {
  it('SAP\'s in-stream "prompt is too long" after the templating chunk -> HTTP 400 invalid_request_error, nothing streamed', async () => {
    streamImpl = async (onChunk) => { await onChunk(templatingChunk); await onChunk(TOO_LONG); };
    const res = mockRes();

    await handleMessages(mockReq(body()), res, jest.fn() as any);

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.wire).toBe('');
    expect(res.body).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 600024 tokens > 200000 maximum' },
    });
    expect(JSON.stringify(res.body)).not.toContain('SECRET PROMPT TEXT');
    expect(res.writableEnded).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(400);
  });

  it('a thrown upstream error (SAP HTTP 404 with a JSON body) -> HTTP 404 not_found_error with SAP\'s message', async () => {
    streamImpl = async () => {
      const err: any = new Error('SAP AI Core streaming failed: Request failed with status code 404');
      err.status = 404;
      err.details = { status: 404, body: JSON.stringify({ error: { code: 404, message: 'Model no-such-model not found', intermediate_results: { x: 'SECRET' } } }) };
      throw err;
    };
    const res = mockRes();

    await handleMessages(mockReq(body()), res, jest.fn() as any);

    expect(res.statusCode).toBe(404);
    expect(res.wire).toBe('');
    expect(res.body).toEqual({ type: 'error', error: { type: 'not_found_error', message: 'Model no-such-model not found' } });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(404);
  });

  it('a SAP 429 chunk -> HTTP 429 rate_limit_error', async () => {
    streamImpl = async (onChunk) => { await onChunk({ error: { code: 429, message: 'Too many requests' } }); };
    const res = mockRes();

    await handleMessages(mockReq(body()), res, jest.fn() as any);

    expect(res.statusCode).toBe(429);
    expect(res.body.error).toEqual({ type: 'rate_limit_error', message: 'Too many requests' });
  });

  it('emulated streaming: a rejected blocking call -> its HTTP status and Anthropic\'s body', async () => {
    emulate = true;
    completeImpl = () => {
      const err: any = new Error('Request failed with status code 400');
      err.status = 400;
      err.details = { error: { code: 400, message: '400 - LLM Module: prompt is too long: 300001 tokens > 200000 maximum' } };
      return Promise.reject(err);
    };
    const res = mockRes();

    await handleMessages(mockReq(body()), res, jest.fn() as any);

    expect(res.statusCode).toBe(400);
    expect(res.wire).toBe('');
    expect(res.body).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 300001 tokens > 200000 maximum' },
    });
    expect(usageEvents[0].status).toBe(400);
  });

  it('a deployed model whose stream failed before any byte -> HTTP status + Anthropic body, no [DONE]', async () => {
    modelDetails = { id: 'anthropic--claude-x--deployed', accessType: 'deployment' };
    bedrockImpl = () => Promise.reject(Object.assign(new Error('Bedrock said no'), { status: 403 }));
    const res = mockRes();
    // awsBedrockService sets (but does not send) the SSE Content-Type before it fails.
    res.setHeader('Content-Type', 'text/event-stream');

    await handleMessages(mockReq({ ...body(), model: 'anthropic--claude-x--deployed' }), res, jest.fn() as any);

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.wire).toBe('');
    expect(res.body).toEqual({ type: 'error', error: { type: 'permission_error', message: 'Bedrock said no' } });
  });
});

describe('a failure after the stream started is one error event and nothing after it', () => {
  it('content, then SAP\'s error chunk -> event: error with the string type; no message_delta/message_stop', async () => {
    streamImpl = async (onChunk) => {
      await onChunk(templatingChunk);
      await onChunk(textChunk('Hello'));
      await onChunk({ error: { code: 503, message: '503 - LLM Module: upstream overloaded' } });
    };
    const res = mockRes();

    await handleMessages(mockReq(body()), res, jest.fn() as any);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const seq = events(res.wire);
    expect(seq.map(e => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'error']);
    expect(seq[3].data).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'upstream overloaded' } });
    expect(res.writableEnded).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe(503);
  });

  it('a transport error chunk after content -> api_error event, and chunks after it are not written', async () => {
    streamImpl = async (onChunk) => {
      await onChunk(textChunk('Hel'));
      await onChunk({ error: true, message: 'Stream error: socket hang up' });
      await onChunk(textChunk('lo', { finish_reason: 'stop' }));
    };
    const res = mockRes();

    await handleMessages(mockReq(body()), res, jest.fn() as any);

    const seq = events(res.wire);
    expect(seq[seq.length - 1]).toEqual({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'Stream error: socket hang up' } } });
    expect(seq.filter(e => e.event === 'error')).toHaveLength(1);
    expect(res.wire).not.toContain('"lo"');
    expect(usageEvents[0].status).toBe(500);
  });

  it('a stream that throws after content -> one error event, the response ends, no [DONE]', async () => {
    streamImpl = async (onChunk) => {
      await onChunk(textChunk('Hi'));
      throw Object.assign(new Error('SAP AI Core streaming failed: socket hang up'), { status: 502 });
    };
    const res = mockRes();

    await handleMessages(mockReq(body()), res, jest.fn() as any);

    const seq = events(res.wire);
    expect(seq[seq.length - 1].data).toEqual({ type: 'error', error: { type: 'api_error', message: 'SAP AI Core streaming failed: socket hang up' } });
    expect(res.wire).not.toContain('[DONE]');
    expect(res.wire).not.toContain('message_stop');
    expect(usageEvents[0].status).toBe(502);
  });
});

describe('a slow first chunk starts the stream with pings at the deadline', () => {
  it('nothing for 10 s, then 200 + message_start + ping, pings every 5 s, then the content', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamImpl = async (onChunk) => {
      await onChunk(templatingChunk);
      await gate;
      await onChunk(textChunk('Hi there friend', { finish_reason: 'stop', usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    };
    const res = mockRes();

    const done = handleMessages(mockReq(body()), res, jest.fn() as any);
    await settle();
    jest.advanceTimersByTime(9_999);
    expect(res.wire).toBe('');
    expect(res.headersSent).toBe(false);

    jest.advanceTimersByTime(1);
    expect(events(res.wire).map(e => e.event)).toEqual(['message_start', 'ping']);

    jest.advanceTimersByTime(5_000);
    expect(events(res.wire).map(e => e.event)).toEqual(['message_start', 'ping', 'ping']);

    release();
    await done;
    const seq = events(res.wire);
    expect(seq.map(e => e.event)).toEqual([
      'message_start', 'ping', 'ping',
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    expect(seq[4].data.delta.text).toBe('Hi there friend');
    expect(usageEvents[0]).toMatchObject({ status: 200, inputTokens: 12, outputTokens: 4 });

    // Finished: no timer writes after the end.
    jest.advanceTimersByTime(60_000);
    expect(events(res.wire)).toHaveLength(seq.length);
  });

  it('a failure after the deadline-started stream is an in-stream error event', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamImpl = async (onChunk) => { await gate; await onChunk(TOO_LONG); };
    const res = mockRes();

    const done = handleMessages(mockReq(body()), res, jest.fn() as any);
    await settle();
    jest.advanceTimersByTime(10_000);
    release();
    await done;

    expect(res.statusCode).toBe(200);
    expect(events(res.wire)).toEqual([
      expect.objectContaining({ event: 'message_start' }),
      { event: 'ping', data: { type: 'ping' } },
      { event: 'error', data: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 600024 tokens > 200000 maximum' } } },
    ]);
    expect(res.writableEnded).toBe(true);
  });
});

describe('a normal stream is unchanged on the wire', () => {
  it('exact bytes: message_start, the blocks, message_delta, message_stop', async () => {
    streamImpl = async (onChunk) => {
      await onChunk(templatingChunk);
      await onChunk(textChunk('Hi'));
      await onChunk(textChunk(' there', { finish_reason: 'stop', usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    };
    const res = mockRes();

    await handleMessages(mockReq(body()), res, jest.fn() as any);

    const wire = res.wire.replace(/"id":"msg_[a-z0-9]+_[a-z0-9]+"/, '"id":"msg_X"');
    expect(wire).toBe(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_X","type":"message","role":"assistant","model":"anthropic--claude-4.5-haiku","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n\n'
      + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n'
      + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
      + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3,"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}\n\n'
      + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(usageEvents).toEqual([expect.objectContaining({ status: 200, inputTokens: 12, outputTokens: 3 })]);
  });
});

describe('client disconnect', () => {
  it('a client that leaves before the first chunk aborts the upstream call; nothing is written later', async () => {
    jest.useFakeTimers();
    streamImpl = (_onChunk, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('canceled')));
    });
    const res = mockRes();

    const done = handleMessages(mockReq(body()), res, jest.fn() as any);
    await settle();
    res.emit('close');
    await done;

    expect(seenSignal?.aborted).toBe(true);
    jest.advanceTimersByTime(60_000);
    expect(res.wire).toBe('');
    expect(res.body).toBeUndefined();
  });
});

describe('Anthropic error vocabulary', () => {
  it.each([
    [400, 'invalid_request_error'], [401, 'authentication_error'], [402, 'billing_error'],
    [403, 'permission_error'], [404, 'not_found_error'], [413, 'request_too_large'],
    [422, 'invalid_request_error'], [429, 'rate_limit_error'], [500, 'api_error'],
    [502, 'api_error'], [503, 'overloaded_error'], [504, 'timeout_error'], [529, 'overloaded_error'],
  ])('status %i -> %s', (status, type) => {
    expect(anthropicErrorType(status)).toBe(type);
  });

  it('drops SAP\'s "NNN - X Module: " prefix and keeps the rest verbatim', () => {
    expect(anthropicErrorMessage('400 - LLM Module: prompt is too long: 600024 tokens > 200000 maximum'))
      .toBe('prompt is too long: 600024 tokens > 200000 maximum');
    expect(anthropicErrorMessage('400 - Input Filtering Module: blocked')).toBe('blocked');
    expect(anthropicErrorMessage('Model not found')).toBe('Model not found');
    expect(anthropicErrorMessage('400 - LLM Module: ')).toBe('400 - LLM Module: ');
  });
});

describe('non-streaming and pre-routing errors are Anthropic errors too', () => {
  // Claude Code retries a failed stream WITHOUT streaming: that answer must carry the same
  // status and Anthropic shape, or "prompt is too long" is lost again.
  it('non-streaming "prompt is too long" -> HTTP 400 invalid_request_error with the message, prefix dropped', async () => {
    completeImpl = () => {
      const err: any = new Error('Request failed with status code 400');
      err.status = 400;
      err.details = { error: { code: 400, message: '400 - LLM Module: prompt is too long: 600024 tokens > 200000 maximum', intermediate_results: { templating: 'SECRET' } } };
      return Promise.reject(err);
    };
    const res = mockRes();
    const next = jest.fn();

    await handleMessages(mockReq(body(false)), res, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 600024 tokens > 200000 maximum' },
    });
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(usageEvents[0].status).toBe(400);
  });

  it.each([true, false])('unknown model (stream=%s) -> HTTP 404 not_found_error', async (stream) => {
    modelDetails = null;
    const res = mockRes();

    await handleMessages(mockReq({ ...body(stream), model: 'no-such-model-xyz' }), res, jest.fn() as any);

    expect(res.statusCode).toBe(404);
    expect(res.wire).toBe('');
    expect(res.body).toEqual({ type: 'error', error: { type: 'not_found_error', message: 'model: no-such-model-xyz' } });
  });

  it('a deployed-model failure with a bogus status -> 500 api_error, never a thrown invalid status code', async () => {
    modelDetails = { id: 'anthropic--claude-x--deployed', accessType: 'deployment' };
    bedrockImpl = () => Promise.reject(Object.assign(new Error('strange'), { status: 'teapot' }));
    const res = mockRes();

    await handleMessages(mockReq({ ...body(false), model: 'anthropic--claude-x--deployed' }), res, jest.fn() as any);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ type: 'error', error: { type: 'api_error', message: 'strange' } });
  });
});

describe('upstream failure helpers', () => {
  it('only 400-599 pass as a status; anything else falls back (and the fallback is checked too)', () => {
    expect(httpStatusOr(429)).toBe(429);
    expect(httpStatusOr('503')).toBe(503);
    for (const bogus of [200, 302, 600, 9999, -1, 'teapot', NaN, undefined, null, {}]) {
      expect(httpStatusOr(bogus)).toBe(500);
    }
    expect(httpStatusOr('x', 502)).toBe(502);
    expect(httpStatusOr('x', 42)).toBe(500);
    expect(failureFromError({ status: 9999, message: 'm' }).status).toBe(500);
    expect(failureFromChunk({ error: { code: 700, message: 'm' }, status: 'nope' }).status).toBe(500);
  });

  it('caps an upstream message at 2000 characters, as normalizeUpstreamError does', () => {
    const long = 'x'.repeat(5000);
    const fromBody = failureFromError({ status: 400, details: { body: JSON.stringify({ error: { message: long } }) } });
    expect(fromBody.message).toBe('x'.repeat(2000) + '…');
    expect(failureFromError({ status: 400, message: long }).message).toHaveLength(2001);
    expect(failureFromChunk({ error: { code: 400, message: long } }).message).toHaveLength(2001);
    expect(failureFromError({ status: 400, message: 'short' }).message).toBe('short');
  });
});
