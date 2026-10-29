/**
 * /anthropic/v1/messages on the SAP orchestration path (a foundation Claude model, not a
 * --deployed one): the client-visible SSE sequence and the usage the gateway bills.
 *
 * B7: the native stream translator emitted a tool call as a lone `content_block_start` with
 * `input: {}` — the streamed `function.arguments` never reached the client, no event carried an
 * `index`, the text block was never closed, and the controller's closing `content_block_stop`
 * went out as `"index":null` (Math.max(-1, undefined) is NaN). The target is Anthropic's own
 * streaming shape: per block start{index} -> delta{index} (text_delta / input_json_delta) ->
 * stop{index}, 0-based indices in block order, then message_delta and message_stop.
 *
 * B8: SAP orchestration reports cache under `usage.prompt_tokens_details.cached_tokens` /
 * `.cache_creation_tokens` (sapOrchestrationTypes.ts), EXCLUSIVE of `prompt_tokens`; the three
 * orchestration sub-paths read Anthropic's names instead and so always reported 0.
 *
 * The controller and the real anthropicResponseService run; only SAP I/O and side channels are
 * mocked. Events are asserted at the sseWriter boundary.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
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
    getSubstitutedModel: (_p: string, m: string) => m,
    // Read by the forced-pseudonymization check: nothing forces masking here.
    getConfig: () => ({}),
    getHookConfig: () => undefined,
    getAnthropicBedrockVersion: () => '2023-06-01',
    shouldEmulateStreaming: () => emulate,
  },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: () => Promise.resolve({ id: 'anthropic--claude-4.5-sonnet', owned_by: 'anthropic' }),
    modelSupportsStreaming: () => true,
  },
}));

// The model the SAP payload names — Claude everywhere except the OpenAI-family (inclusive) cases.
let sapModelName = 'anthropic--claude-4.5-sonnet';
jest.mock('../src/services/anthropicService', () => ({
  __esModule: true,
  default: {
    transformRequestToSAPFormat: () => Promise.resolve({
      config: { modules: { prompt_templating: { prompt: { template: [] }, model: { name: sapModelName } } } },
    }),
  },
}));

let streamChunks: any[] = [];
let completeResponse: any = null;
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    completeChat: () => Promise.resolve(completeResponse),
    streamChatCompletion: async (_payload: any, onChunk: (c: any) => Promise<void>) => {
      for (const c of streamChunks) await onChunk(c);
    },
  },
}));

jest.mock('../src/services/awsBedrockService', () => ({ __esModule: true, default: {} }));
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

const written: Array<{ event: string; data: any }> = [];
jest.mock('../src/utils/sseWriter', () => ({
  writeEventStream: (_res: any, event: string, data: string) => { written.push({ event, data: JSON.parse(data) }); },
  writeDone: jest.fn(),
}));

import { handleMessages } from '../src/controllers/anthropicController';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.write = () => true;
  r.end = () => { r.writableEnded = true; };
  return r;
}

function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = {};
  r.query = {};
  return r;
}

const chunk = (delta: any, extra: { finish_reason?: string; usage?: any } = {}) => ({
  request_id: 'req-1',
  final_result: {
    id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'anthropic--claude-4.5-sonnet',
    choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  },
});

const USAGE_WITH_CACHE = {
  prompt_tokens: 14, completion_tokens: 25, total_tokens: 29543,
  prompt_tokens_details: { cached_tokens: 29004, cache_creation_tokens: 500 },
};

const body = (stream: boolean) => ({
  model: 'anthropic--claude-4.5-sonnet', stream, max_tokens: 256,
  messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
  tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object' } }],
});

beforeEach(() => {
  written.length = 0;
  usageEvents.length = 0;
  emulate = false;
  streamChunks = [];
  completeResponse = null;
  sapModelName = 'anthropic--claude-4.5-sonnet';
});

describe('orchestration Anthropic native stream: text then a streamed tool call (B7)', () => {
  it('emits the Anthropic block sequence with indices, input_json_delta and closed blocks', async () => {
    streamChunks = [
      chunk({ role: 'assistant', content: 'Let me ' }),
      chunk({ content: 'check.' }),
      chunk({ tool_calls: [{ index: 0, id: 'toolu_01', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty": "Pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ris"}' } }] }),
      chunk({}, { finish_reason: 'tool_calls', usage: USAGE_WITH_CACHE }),
    ];

    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);

    const seq = written.filter(w => w.event !== 'ping').map(w => w.data);
    expect(seq).toEqual([
      expect.objectContaining({ type: 'message_start' }),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ci' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ty": "Pa' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ris"}' } },
      { type: 'content_block_stop', index: 1 },
      expect.objectContaining({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } }),
      { type: 'message_stop' },
    ]);

    const partial = seq
      .filter(e => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
      .map(e => e.delta.partial_json).join('');
    expect(JSON.parse(partial)).toEqual({ city: 'Paris' });

    for (const e of seq) {
      if (e.type.startsWith('content_block_')) expect(typeof e.index).toBe('number');
    }
  });

  it('closes a tool block before the next one opens and never emits "index":null', async () => {
    streamChunks = [
      chunk({ tool_calls: [{ index: 0, id: 'toolu_a', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'toolu_b', function: { name: 'get_weather', arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"Rome"}' } }] }, { finish_reason: 'tool_calls' }),
    ];

    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);

    const blocks = written.map(w => w.data).filter(e => e.type.startsWith('content_block_'));
    expect(blocks.map(e => [e.type, e.index])).toEqual([
      ['content_block_start', 0],
      ['content_block_delta', 0],
      ['content_block_stop', 0],
      ['content_block_start', 1],
      ['content_block_delta', 1],
      ['content_block_delta', 1],
      ['content_block_stop', 1],
    ]);
    expect(written.some(w => JSON.stringify(w.data).includes('"index":null'))).toBe(false);
  });
});

describe('orchestration Anthropic usage carries SAP cache tokens (B8)', () => {
  it('native stream: message_delta and the billed usage carry cache read/write', async () => {
    streamChunks = [
      chunk({ content: 'Hi.' }),
      chunk({}, { finish_reason: 'stop', usage: USAGE_WITH_CACHE }),
    ];

    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);

    const delta = written.find(w => w.event === 'message_delta')!.data;
    expect(delta.usage).toEqual({
      input_tokens: 14, output_tokens: 25, cache_read_input_tokens: 29004, cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
    });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 14, outputTokens: 25, cacheReadInputTokens: 29004, cacheCreationInputTokens: 500, status: 200,
    });
  });

  it('emulated stream: message_delta and the billed usage carry cache read/write', async () => {
    emulate = true;
    completeResponse = {
      request_id: 'req-2',
      final_result: {
        id: 'chatcmpl-2', model: 'anthropic--claude-4.5-sonnet',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi.' }, finish_reason: 'stop' }],
        usage: USAGE_WITH_CACHE,
      },
    };

    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);

    const delta = written.find(w => w.event === 'message_delta')!.data;
    expect(delta.usage).toMatchObject({ cache_read_input_tokens: 29004, cache_creation_input_tokens: 500 });
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 14, outputTokens: 25, cacheReadInputTokens: 29004, cacheCreationInputTokens: 500,
    });
  });

  it('non-streaming: the response usage and the billed usage carry cache read/write', async () => {
    completeResponse = {
      request_id: 'req-3',
      final_result: {
        id: 'chatcmpl-3', model: 'anthropic--claude-4.5-sonnet',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi.' }, finish_reason: 'stop' }],
        usage: USAGE_WITH_CACHE,
      },
    };
    const res = mockRes();

    await handleMessages(mockReq(body(false)), res, jest.fn() as any);

    expect(res.body.usage).toEqual({
      input_tokens: 14, output_tokens: 25, cache_read_input_tokens: 29004, cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
    });
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 14, outputTokens: 25, cacheReadInputTokens: 29004, cacheCreationInputTokens: 500,
    });
  });
});

/**
 * Array content used to switch the answer to Bedrock's Converse shape (`output.message`, camelCase
 * usage), which no Anthropic client reads; it now answers in Anthropic's shape like string content.
 * The billing assertions of 14c stand unchanged.
 */
describe('orchestration Anthropic non-streaming, array content: Anthropic shape, real counts billed (14c)', () => {
  const sapResponse = (id: string) => ({
    request_id: id,
    final_result: {
      id: 'chatcmpl-' + id, model: 'anthropic--claude-4.5-sonnet',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi.' }, finish_reason: 'stop' }],
      usage: USAGE_WITH_CACHE,
    },
  });

  it('array content: an Anthropic message, one usage event with the real counts', async () => {
    completeResponse = sapResponse('req-4');
    const res = mockRes();
    const converseBody = { ...body(false), messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello there' }] }] };

    await handleMessages(mockReq(converseBody), res, jest.fn() as any);

    expect(res.body).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] });
    expect(res.body).not.toHaveProperty('output');
    expect(res.body.usage).toMatchObject({
      input_tokens: 14, output_tokens: 25, cache_read_input_tokens: 29004, cache_creation_input_tokens: 500,
    });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 14, outputTokens: 25, cacheReadInputTokens: 29004, cacheCreationInputTokens: 500, status: 200,
    });
  });

  it('array content, Claude with SAP\'s measured usage (exclusive of the cache): the counts pass through', async () => {
    // Measured shape (cache-probe-result.md): Claude's total_tokens is prompt + completion only
    // (14 + 4 = 18) while 29004 tokens were read from cache. totalTokens follows the usage-row
    // convention instead — input + output + cache read + cache write — so it agrees with the
    // row the admin records for this request.
    completeResponse = {
      request_id: 'req-6',
      final_result: {
        id: 'chatcmpl-req-6', model: 'anthropic--claude-4.5-sonnet',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 14, completion_tokens: 4, total_tokens: 18, prompt_tokens_details: { cached_tokens: 29004 } },
      },
    };
    const res = mockRes();
    const converseBody = { ...body(false), messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello there' }] }] };

    await handleMessages(mockReq(converseBody), res, jest.fn() as any);

    expect(res.body.usage).toMatchObject({ input_tokens: 14, output_tokens: 4, cache_read_input_tokens: 29004 });
  });

  it('string content (snake_case usage, unchanged): still exactly one usage event with the real counts', async () => {
    completeResponse = sapResponse('req-5');

    await handleMessages(mockReq(body(false)), mockRes(), jest.fn() as any);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 14, outputTokens: 25, cacheReadInputTokens: 29004, cacheCreationInputTokens: 500, status: 200,
    });
  });
});

/**
 * An OpenAI-family model behind SAP orchestration counts the cached prefix INSIDE
 * `prompt_tokens` (live probe of 2026-09-30, gpt-4.1-nano on this very route: prompt_tokens
 * 1981 on the cold and the cached call, cached_tokens 0 -> 1792). Anthropic's `input_tokens` is
 * exclusive of `cache_read_input_tokens`, so the Anthropic client must see prompt - cached, and
 * the gateway must bill that, not prompt_tokens plus the cache again.
 */
describe('orchestration Anthropic route with an OpenAI-family model: inclusive SAP usage', () => {
  const GPT_USAGE = {
    completion_tokens: 1, prompt_tokens: 1978, total_tokens: 1979,
    prompt_tokens_details: { audio_tokens: 0, cached_tokens: 1792 },
  };
  const gptBody = (stream: boolean) => ({ ...body(stream), model: 'gpt-4.1-nano' });
  const gptResponse = {
    request_id: 'req-gpt',
    final_result: {
      id: 'chatcmpl-gpt', model: 'gpt-4.1-nano-2025-04-14',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: GPT_USAGE,
    },
  };

  beforeEach(() => { sapModelName = 'gpt-4.1-nano'; });

  it('non-streaming: the client sees input_tokens net of the cache, and that is what is billed', async () => {
    completeResponse = gptResponse;
    const res = mockRes();

    await handleMessages(mockReq(gptBody(false)), res, jest.fn() as any);

    expect(res.body.usage).toEqual({
      input_tokens: 186, output_tokens: 1, cache_read_input_tokens: 1792, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 186, outputTokens: 1, cacheReadInputTokens: 1792, cacheCreationInputTokens: 0, status: 200,
    });
  });

  it('non-streaming, array content: input_tokens net of the cache', async () => {
    completeResponse = gptResponse;
    const res = mockRes();
    const converseBody = { ...gptBody(false), messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello there' }] }] };

    await handleMessages(mockReq(converseBody), res, jest.fn() as any);

    expect(res.body.usage).toMatchObject({ input_tokens: 186, output_tokens: 1, cache_read_input_tokens: 1792 });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ inputTokens: 186, cacheReadInputTokens: 1792 });
  });

  it('array content with a cache write on an inclusive source: input_tokens net of read and write', async () => {
    completeResponse = {
      ...gptResponse,
      final_result: {
        ...gptResponse.final_result,
        // total_tokens deliberately absent: the total must not depend on SAP sending one.
        usage: { completion_tokens: 1, prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 600, cache_creation_tokens: 300 } },
      },
    };
    const res = mockRes();
    const converseBody = { ...gptBody(false), messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello there' }] }] };

    await handleMessages(mockReq(converseBody), res, jest.fn() as any);

    expect(res.body.usage).toMatchObject({
      input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 600, cache_creation_input_tokens: 300,
    });
  });

  it('native stream: message_delta and the billed usage carry input_tokens net of the cache', async () => {
    streamChunks = [
      chunk({ content: 'OK' }),
      chunk({}, { finish_reason: 'stop', usage: GPT_USAGE }),
    ];

    await handleMessages(mockReq(gptBody(true)), mockRes(), jest.fn() as any);

    const delta = written.find(w => w.event === 'message_delta')!.data;
    expect(delta.usage).toEqual({ input_tokens: 186, output_tokens: 1, cache_read_input_tokens: 1792, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 186, outputTokens: 1, cacheReadInputTokens: 1792, cacheCreationInputTokens: 0, status: 200,
    });
  });

  it('emulated stream: message_delta and the billed usage carry input_tokens net of the cache', async () => {
    emulate = true;
    completeResponse = gptResponse;

    await handleMessages(mockReq(gptBody(true)), mockRes(), jest.fn() as any);

    const delta = written.find(w => w.event === 'message_delta')!.data;
    expect(delta.usage).toMatchObject({ input_tokens: 186, output_tokens: 1, cache_read_input_tokens: 1792 });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 186, outputTokens: 1, cacheReadInputTokens: 1792, cacheCreationInputTokens: 0,
    });
  });

  it('a cache write on an inclusive source is taken out of input_tokens too', async () => {
    completeResponse = {
      ...gptResponse,
      final_result: {
        ...gptResponse.final_result,
        usage: { completion_tokens: 1, prompt_tokens: 1000, total_tokens: 1001, prompt_tokens_details: { cached_tokens: 600, cache_creation_tokens: 300 } },
      },
    };
    const res = mockRes();

    await handleMessages(mockReq(gptBody(false)), res, jest.fn() as any);

    expect(res.body.usage).toEqual({
      input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 600, cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
    });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ inputTokens: 100, cacheReadInputTokens: 600, cacheCreationInputTokens: 300 });
  });
});

/**
 * G: every Anthropic usage object on the orchestration path carries both cache counts and the
 * `cache_creation` TTL split (Anthropic's own shape; Claude Desktop's gateway guide asks for all
 * three on every response). Values from test/fixtures/orchestration/cache-probe-result.md (5m) and
 * anthropic-cache-live-result.md arm C (1h).
 */
describe('orchestration Anthropic usage reports the cache_creation TTL split (G)', () => {
  const WRITE_5M = {
    completion_tokens: 4, prompt_tokens: 14, total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 32004, cache_creation_token_details: { ephemeral_5m_input_tokens: 32004, ephemeral_1h_input_tokens: 0 } },
  };
  const READ = {
    completion_tokens: 4, prompt_tokens: 14, total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 32004, cache_creation_tokens: 0, cache_creation_token_details: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
  };
  const WRITE_1H = {
    completion_tokens: 4, prompt_tokens: 13, total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 7221, cache_creation_token_details: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 7221 } },
  };
  const NO_CACHE = { completion_tokens: 4, prompt_tokens: 14, total_tokens: 18 };
  const ZERO = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
  const complete = (usage: any) => ({
    request_id: 'req-g',
    final_result: {
      id: 'chatcmpl-g', model: 'anthropic--claude-4.5-sonnet',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage,
    },
  });

  it('native stream: message_start carries zero cache counts and a zero cache_creation object', async () => {
    streamChunks = [chunk({ content: 'OK' }), chunk({}, { finish_reason: 'stop', usage: WRITE_5M })];
    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);
    const start = written.find(w => w.event === 'message_start')!.data;
    expect(start.message.usage).toEqual({
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: ZERO,
    });
  });

  it('native stream, cache write: message_delta has both counts and the 5m split', async () => {
    streamChunks = [chunk({ content: 'OK' }), chunk({}, { finish_reason: 'stop', usage: WRITE_5M })];
    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);
    expect(written.find(w => w.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 14, output_tokens: 4, cache_creation_input_tokens: 32004, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 32004, ephemeral_1h_input_tokens: 0 },
    });
  });

  it('native stream, 1h write: the split lands in ephemeral_1h_input_tokens', async () => {
    streamChunks = [chunk({ content: 'OK' }), chunk({}, { finish_reason: 'stop', usage: WRITE_1H })];
    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);
    expect(written.find(w => w.event === 'message_delta')!.data.usage.cache_creation)
      .toEqual({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 7221 });
  });

  it('native stream without any cache usage: the counts are still present as 0', async () => {
    streamChunks = [chunk({ content: 'OK' }), chunk({}, { finish_reason: 'stop', usage: NO_CACHE })];
    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);
    expect(written.find(w => w.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 14, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: ZERO,
    });
  });

  it('emulated stream, cache write: message_delta has both counts and the split', async () => {
    emulate = true;
    completeResponse = complete(WRITE_5M);
    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);
    expect(written.find(w => w.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 14, output_tokens: 4, cache_creation_input_tokens: 32004, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 32004, ephemeral_1h_input_tokens: 0 },
    });
  });

  it('emulated stream without any cache usage: the counts are still present as 0', async () => {
    emulate = true;
    completeResponse = complete(NO_CACHE);
    await handleMessages(mockReq(body(true)), mockRes(), jest.fn() as any);
    expect(written.find(w => w.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 14, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: ZERO,
    });
  });

  it('non-streaming, cache read: usage has the read, no write and a zero split; billing records the read', async () => {
    completeResponse = complete(READ);
    const res = mockRes();
    await handleMessages(mockReq(body(false)), res, jest.fn() as any);
    expect(res.body.usage).toEqual({
      input_tokens: 14, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 32004, cache_creation: ZERO,
    });
    expect(usageEvents[0]).toMatchObject({ inputTokens: 14, outputTokens: 4, cacheReadInputTokens: 32004, cacheCreationInputTokens: 0 });
  });

  it('a write without TTL details counts as 5m', async () => {
    completeResponse = complete({ completion_tokens: 1, prompt_tokens: 3, prompt_tokens_details: { cache_creation_tokens: 500 } });
    const res = mockRes();
    await handleMessages(mockReq(body(false)), res, jest.fn() as any);
    expect(res.body.usage.cache_creation).toEqual({ ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 });
  });
});
