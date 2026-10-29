/**
 * embeddingController: an array `input` embeds every element (OpenAI shape: data[i].index is the
 * position in the input array, usage is the SAP total for the whole request).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const mockCreateEmbedding: jest.Mock<any> = jest.fn();
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: { createEmbedding: (...a: any[]) => mockCreateEmbedding(...a) },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelById: () => Promise.resolve({ versions: [{ capabilities: ['embedding'] }] }),
  },
}));

const mockUpdateTokenCounts: jest.Mock<any> = jest.fn();
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({}),
  emitUsageEvent: jest.fn(),
  updateTokenCounts: (...a: any[]) => mockUpdateTokenCounts(...a),
}));

jest.mock('../src/utils/modelEntitlement', () => ({
  enforceEntitlement: () => true,
}));

import { handleEmbedding } from '../src/controllers/embeddingController';

function run(body: any) {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
  const next = jest.fn();
  return handleEmbedding({ body } as any, res, next as any).then(() => ({ res, next }));
}

const sapReply = (n: number) => ({
  request_id: 'r',
  final_result: {
    object: 'list',
    // returned out of order on purpose: the response must keep SAP's index tags
    data: Array.from({ length: n }, (_, i) => ({ object: 'embedding', embedding: [i, i + 0.5], index: i })).reverse(),
    model: 'm',
    usage: { prompt_tokens: 7, total_tokens: 7 },
  },
});

describe('embeddingController array input', () => {
  beforeEach(() => {
    mockCreateEmbedding.mockReset();
    mockUpdateTokenCounts.mockReset();
  });

  it('sends every element to SAP and returns one embedding per element with its index', async () => {
    mockCreateEmbedding.mockResolvedValue(sapReply(2));
    const { res } = await run({ model: 'text-embedding-3-small', input: ['a', 'b'] });

    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);
    expect((mockCreateEmbedding.mock.calls[0][0] as any).input.text).toEqual(['a', 'b']);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((d: any) => d.index).sort()).toEqual([0, 1]);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 });
    expect(mockUpdateTokenCounts.mock.calls[0][1]).toBe(7);
  });

  it('keeps a string input a string', async () => {
    mockCreateEmbedding.mockResolvedValue(sapReply(1));
    await run({ model: 'text-embedding-3-small', input: 'hello' });
    expect((mockCreateEmbedding.mock.calls[0][0] as any).input.text).toBe('hello');
  });

  it.each([
    ['an empty array', []],
    ['a token array', [1, 2, 3]],
    ['an array of token arrays', [[1, 2], [3]]],
    ['a mixed array', ['a', 2]],
  ])('refuses %s with 400 invalid_request_error', async (_n, input) => {
    const { res } = await run({ model: 'text-embedding-3-small', input });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(mockCreateEmbedding).not.toHaveBeenCalled();
  });

  it('refuses more than 256 inputs with 400 invalid_input without calling SAP', async () => {
    const { res } = await run({ model: 'text-embedding-3-small', input: Array.from({ length: 257 }, () => 'x') });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(res.body.error.code).toBe('invalid_input');
    expect(mockCreateEmbedding).not.toHaveBeenCalled();
  });

  it('accepts exactly 256 inputs', async () => {
    mockCreateEmbedding.mockResolvedValue(sapReply(256));
    const { res } = await run({ model: 'text-embedding-3-small', input: Array.from({ length: 256 }, () => 'x') });
    expect(res.statusCode).toBe(200);
  });

  it('answers an upstream 4xx with that status and SAP\'s message', async () => {
    const msg = 'SAP AI Core embedding error: maximum request size is 300000 tokens';
    mockCreateEmbedding.mockRejectedValue(Object.assign(new Error(msg), { status: 400 }));
    const { res } = await run({ model: 'text-embedding-3-small', input: ['a'] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(res.body.error.message).toContain('maximum request size is 300000 tokens');
  });

  it.each([
    ['a network failure', new Error('socket hang up')],
    ['an upstream 5xx', Object.assign(new Error('boom'), { status: 502 })],
  ])('keeps %s a 500 api_error', async (_n, err) => {
    mockCreateEmbedding.mockRejectedValue(err);
    const { res } = await run({ model: 'text-embedding-3-small', input: ['a'] });
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('embedding_generation_failed');
  });
});
