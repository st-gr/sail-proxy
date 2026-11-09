/**
 * Unit tests for the SAP embeddings client (axios mocked — no network).
 *
 * These deliberately diverge from the task-5-brief.md examples in three places,
 * per the live probe recorded at the top of src/fileSearch/embedder.ts:
 *  - no `input_type=document` / `input_type=query` tests: SAP rejects that field
 *    with HTTP 400, so instead we assert it is absent from the wire payload.
 *  - mocked responses use the real `{ final_result: { data: [...] } }` wrapper,
 *    not the brief's flat `{ data: [...] }`.
 *  - `embed()` resolves `{ vectors, usage }`, not a bare `number[][]`, so that
 *    ingestion (Task 11) can attribute SAP embedding cost to the uploader.
 *  - Task 4 hardening: no "hangs until the 300s Node default" test exists here.
 *    The request already carries a 30s axios timeout (present before this
 *    task); proving that a real hang is bounded by it would require either a
 *    30s+ Jest test or faking the axios timeout mechanism itself (axios owns
 *    the abort, not application code), neither of which is fast or honest.
 *    Instead this file asserts the timeout option is actually passed to
 *    axios.post — cheap, and it fails the moment that option is dropped.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: 'https://sap.example', resourceGroup: 'default' }),
    getDeploymentId: async () => 'orch-deployment',
    getAccessToken: async () => 'test-token',
    getFileSearchConfig: () => ({
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 2,
    }),
  },
}));

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));

import configService from '../../src/services/configService';
import { getDefaultLogger } from '@libs/logger';
import {
  embed, configuredEmbeddingTarget, EmbeddingModelUnavailableError, EMBED_BATCH_SIZE,
  EMBED_TOTAL_TIMEOUT_MS, EmbeddingDeadlineExceededError, EMBED_REQUEST_TOKEN_BUDGET, EMBED_TOKEN_ESTIMATE_FACTOR,
} from '../../src/fileSearch/embedder';
import { estimateTokens } from '../../src/fileSearch/chunker';

// The store's model and dimension, as every caller now passes them. Deliberately the
// same as the mocked config here; the tests that care use a different model.
const TARGET = { model: 'text-embedding-3-large', dimensions: 2 };

function sapResponse(data: Array<{ index: number; embedding: number[] }>, usage = { prompt_tokens: 1, total_tokens: 1 }) {
  return { data: { request_id: 'req-1', final_result: { object: 'list', data, model: 'text-embedding-3-large', usage } } };
}

describe('embed', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('does not send input_type on the wire for document embedding — the orchestration schema rejects it with HTTP 400', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'document', TARGET);

    const body = mockPost.mock.calls[0][1];
    expect(body.input).toEqual({ text: ['hello'] });
    expect(JSON.stringify(body)).not.toContain('input_type');
  });

  it('does not send input_type on the wire for query embedding — the orchestration schema rejects it with HTTP 400', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'query', TARGET);

    const body = mockPost.mock.calls[0][1];
    expect(body.input).toEqual({ text: ['hello'] });
    expect(JSON.stringify(body)).not.toContain('input_type');
  });

  it('batches the whole array in a single request rather than fanning out', async () => {
    mockPost.mockResolvedValue(sapResponse([
      { index: 0, embedding: [1, 1] },
      { index: 1, embedding: [2, 2] },
      { index: 2, embedding: [3, 3] },
    ]));

    await embed(['alpha', 'bravo', 'charlie'], 'document', TARGET);

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1].input).toEqual({ text: ['alpha', 'bravo', 'charlie'] });
  });

  it('sends the requested model and dimensions, not the configured ones — a store is embedded with its own model', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2, 0.3] }]));

    await embed(['hello'], 'query', { model: 'text-embedding-3-small', dimensions: 3 });

    const body = mockPost.mock.calls[0][1];
    expect(body.config.modules.embeddings.model.name).toBe('text-embedding-3-small');
    expect(body.config.modules.embeddings.model.params.dimensions).toBe(3);
  });

  it('configuredEmbeddingTarget() hands config-only callers the configured model and dimensions explicitly', () => {
    expect(configuredEmbeddingTarget()).toEqual({ model: 'text-embedding-3-large', dimensions: 2 });
  });

  it('checks each vector against the REQUESTED dimension, not the configured one', async () => {
    // 2 is the configured dimension; the store asked for 3.
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await expect(embed(['x'], 'document', { model: 'm', dimensions: 3 })).rejects.toThrow(/dimension 2, expected 3/);
  });

  it('returns vectors in the same order as the inputs, honouring the response index rather than array position', async () => {
    mockPost.mockResolvedValue(sapResponse([
      { index: 1, embedding: [2, 2] },
      { index: 0, embedding: [1, 1] },
    ]));

    const result = await embed(['a', 'b'], 'document', TARGET);

    expect(result.vectors.map((v) => Array.from(v))).toEqual([[1, 1], [2, 2]]);
  });

  it('hands document vectors over as Float32Array (half the memory of a number array); query vectors stay numbers', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.25] }]));
    const doc = await embed(['a'], 'document', TARGET);
    expect(doc.vectors[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(doc.vectors[0])).toEqual([Math.fround(0.1), 0.25]);
    const query = await embed(['a'], 'query', TARGET);
    expect(Array.isArray(query.vectors[0])).toBe(true);
    expect(query.vectors[0]).toEqual([0.1, 0.25]);
  });

  it('rejects a vector whose dimension contradicts the requested one', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2, 0.3] }]));

    await expect(embed(['x'], 'document', TARGET)).rejects.toThrow(/dimension/);
  });

  it('surfaces prompt and total token usage from final_result.usage', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }], { prompt_tokens: 7, total_tokens: 7 }));

    const result = await embed(['hello'], 'document', TARGET);

    expect(result.usage).toEqual({ promptTokens: 7, totalTokens: 7 });
  });

  it('sends Authorization and AI-Resource-Group headers, mirroring searchExecutor', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'document', TARGET);

    const options = mockPost.mock.calls[0][2];
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(options.headers['AI-Resource-Group']).toBe('default');
  });

  it('hits the orchestration deployment /v2/embeddings path, not a standalone embedding-model deployment', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'document', TARGET);

    const url = mockPost.mock.calls[0][0];
    expect(url).toBe('https://sap.example/v2/inference/deployments/orch-deployment/v2/embeddings');
  });

  it('returns empty vectors for an empty batch without calling the API', async () => {
    const result = await embed([], 'document', TARGET);

    expect(result.vectors).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 0, totalTokens: 0 });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('throws a clear error when no orchestration deployment is available', async () => {
    const spy = jest.spyOn(configService, 'getDeploymentId').mockResolvedValueOnce(null as any);

    await expect(embed(['hello'], 'document', TARGET)).rejects.toThrow(/deployment/i);
    expect(mockPost).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  // --- Index-density validation ---------------------------------------
  //
  // A response can carry exactly `texts.length` data points (so the length
  // check above passes) while its `index` values are out of range or
  // duplicated. The old code built `vectors` with `vectors[idx] = ...` and
  // then validated dimensions with `vectors.forEach(...)`, but `forEach`
  // never visits holes in a sparse array — so a bad index silently left a
  // hole that both the length check AND the dimension guard missed, and
  // `embed()` returned a `number[][]` with an `undefined` slot in it.

  it('rejects a response whose datum.index is out of range', async () => {
    mockPost.mockResolvedValue(sapResponse([
      { index: 0, embedding: [0.1, 0.2] },
      { index: 7, embedding: [0.3, 0.4] }, // only 2 inputs were sent
    ]));

    await expect(embed(['a', 'b'], 'document', TARGET)).rejects.toThrow(/index/i);
  });

  it('rejects a response with duplicate datum.index values even though the array length is correct', async () => {
    // Trap: length matches texts.length (2), so the length guard alone would
    // pass this fixture. Only explicit duplicate detection catches it.
    mockPost.mockResolvedValue(sapResponse([
      { index: 0, embedding: [0.1, 0.2] },
      { index: 0, embedding: [0.3, 0.4] },
    ]));

    await expect(embed(['a', 'b'], 'document', TARGET)).rejects.toThrow(/duplicate/i);
  });

  it('rejects a short response rather than returning a sparse array', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await expect(embed(['a', 'b'], 'document', TARGET)).rejects.toThrow();
  });

  it('passes a bounded timeout to axios so a body that never ends cannot hang the request indefinitely', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'document', TARGET);

    const options = mockPost.mock.calls[0][2];
    expect(typeof options.timeout).toBe('number');
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(60_000);
  });

  // --- Sub-batching (plan Decision 8) ----------------------------------
  //
  // A large file no longer rides on one request and one 30 s timeout: inputs go out in
  // requests of at most EMBED_BATCH_SIZE, and the results come back as if it were one.

  /** Answers every request with one vector per input, the vector being [global index, 0],
   *  in REVERSED index order, and usage equal to the request's input count. */
  function answerPerRequest(offsets: number[]) {
    mockPost.mockImplementation(async (_url: unknown, body: any) => {
      const texts: string[] = body.input.text;
      const offset = offsets.shift() ?? 0;
      const data = texts.map((_, i) => ({ index: i, embedding: [offset + i, 0] })).reverse();
      return sapResponse(data, { prompt_tokens: texts.length, total_tokens: texts.length + 1 });
    });
  }

  it('sends 300 inputs as two requests of at most 256, keeps their order and sums the usage', async () => {
    expect(EMBED_BATCH_SIZE).toBe(256);
    const texts = Array.from({ length: 300 }, (_, i) => `t${i}`);
    answerPerRequest([0, 256]);

    const result = await embed(texts, 'document', TARGET);

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[0][1].input.text).toEqual(texts.slice(0, 256));
    expect(mockPost.mock.calls[1][1].input.text).toEqual(texts.slice(256));
    expect(result.vectors).toHaveLength(300);
    expect(result.vectors.map((v) => v[0])).toEqual(texts.map((_, i) => i));
    expect(result.usage).toEqual({ promptTokens: 300, totalTokens: 302 });
  });

  it('sends exactly 256 inputs as one request', async () => {
    answerPerRequest([0]);
    await embed(Array.from({ length: 256 }, (_, i) => `t${i}`), 'document', TARGET);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong-length vector in a later sub-batch', async () => {
    const texts = Array.from({ length: 300 }, (_, i) => `t${i}`);
    mockPost
      .mockImplementationOnce(async (_u: unknown, body: any) =>
        sapResponse(body.input.text.map((_: string, i: number) => ({ index: i, embedding: [1, 1] }))))
      .mockImplementationOnce(async (_u: unknown, body: any) =>
        sapResponse(body.input.text.map((_: string, i: number) => ({ index: i, embedding: i === 10 ? [1] : [1, 1] }))));

    await expect(embed(texts, 'document', TARGET)).rejects.toThrow(/index 266 has dimension 1, expected 2/);
  });

  // --- A model the orchestration does not serve ------------------------
  //
  // The shape below is the live tenant's answer to an unknown model name (probed
  // 2026-10-06 with 'no-such-embedding-model' and 'gpt-5-mini'): HTTP 400 and a message
  // naming the model. It is the only upstream failure classified as "model unavailable".

  function upstreamError(status: number, message: string) {
    const error: any = new Error(`Request failed with status code ${status}`);
    error.response = { status, data: { error: { code: status, message, location: 'Embedding Module' } } };
    return error;
  }

  it('turns the orchestration\'s "Model name ... is not supported" 400 into EmbeddingModelUnavailableError', async () => {
    mockPost.mockRejectedValue(upstreamError(400,
      "400 - Embedding Module: Model name 'text-embedding-old' is not supported. Model name must be one of: "
      + 'text-embedding-3-small, text-embedding-3-large.'));

    const failure = embed(['x'], 'query', { model: 'text-embedding-old', dimensions: 2 });

    await expect(failure).rejects.toBeInstanceOf(EmbeddingModelUnavailableError);
    await expect(failure).rejects.toMatchObject({ model: 'text-embedding-old' });
  });

  it.each([
    ['another 400 (an unsupported parameter)', upstreamError(400,
      "400 - Embedding Module: Unsupported parameters: ['dimensions'] by 'text-embedding-ada-002' model.")],
    ['a 400 naming a different model', upstreamError(400,
      "400 - Embedding Module: Model name 'other-model' is not supported.")],
    ['a 500 that mentions the phrase', upstreamError(500,
      "Model name 'text-embedding-old' is not supported")],
    ['a timeout', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })],
  ])('rethrows %s unchanged', async (_label, error) => {
    mockPost.mockRejectedValue(error);

    const failure = embed(['x'], 'query', { model: 'text-embedding-old', dimensions: 2 });

    await expect(failure).rejects.toBe(error);
  });

  it('logs an unserved model at warn, not error — it is an expected state with a known remedy', async () => {
    const warn = jest.spyOn(getDefaultLogger(), 'warn').mockImplementation(() => undefined as any);
    const error = jest.spyOn(getDefaultLogger(), 'error').mockImplementation(() => undefined as any);
    try {
      mockPost.mockRejectedValue(upstreamError(400,
        "400 - Embedding Module: Model name 'text-embedding-old' is not supported."));

      await expect(embed(['x'], 'query', { model: 'text-embedding-old', dimensions: 2 }))
        .rejects.toBeInstanceOf(EmbeddingModelUnavailableError);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  // --- The whole call is bounded (below the 15-minute ingestion lease) ---

  it('bounds the whole call: no sub-batch starts once the total budget is spent', async () => {
    expect(EMBED_TOTAL_TIMEOUT_MS).toBeLessThan(15 * 60 * 1000);
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockPost.mockImplementation(async (_u: unknown, body: any) => {
        now += EMBED_TOTAL_TIMEOUT_MS; // the first request alone spends the whole budget
        return sapResponse(body.input.text.map((_: string, i: number) => ({ index: i, embedding: [1, 1] })));
      });
      const texts = Array.from({ length: 300 }, (_, i) => `t${i}`);

      const failure = embed(texts, 'document', TARGET);

      await expect(failure).rejects.toBeInstanceOf(EmbeddingDeadlineExceededError);
      await expect(failure).rejects.toMatchObject({ completedInputs: 256, totalInputs: 300 });
      expect(mockPost).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('gives a later sub-batch only the time that is left of the total budget', async () => {
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockPost.mockImplementation(async (_u: unknown, body: any) => {
        now += EMBED_TOTAL_TIMEOUT_MS - 5_000;
        return sapResponse(body.input.text.map((_: string, i: number) => ({ index: i, embedding: [1, 1] })));
      });

      await embed(Array.from({ length: 300 }, (_, i) => `t${i}`), 'document', TARGET);

      expect(mockPost.mock.calls[0][2].timeout).toBe(30_000);
      expect(mockPost.mock.calls[1][2].timeout).toBe(5_000);
    } finally {
      clock.mockRestore();
    }
  });

  it('a caller\'s earlier deadline bounds the call instead of the total budget', async () => {
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockPost.mockImplementation(async (_u: unknown, body: any) => {
        now += 3_000;
        return sapResponse(body.input.text.map((_: string, i: number) => ({ index: i, embedding: [1, 1] })));
      });
      const texts = Array.from({ length: 600 }, (_, i) => `t${i}`);

      const failure = embed(texts, 'document', TARGET, { deadline: now + 5_000 });

      await expect(failure).rejects.toBeInstanceOf(EmbeddingDeadlineExceededError);
      await expect(failure).rejects.toMatchObject({ completedInputs: 512, totalInputs: 600 });
      expect(mockPost.mock.calls[0][2].timeout).toBe(5_000);
      expect(mockPost.mock.calls[1][2].timeout).toBe(2_000);
      expect(mockPost).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  // SAP rejects a request over 300,000 tokens (probed 2026-10-07), and estimateTokens
  // under-counts real chunks by ~1.8x, so requests also close on a scaled token budget.
  describe('token-budgeted sub-requests', () => {
    // Each vector is [position-in-whole-input, 0], so order is checkable across requests.
    function echoPositions() {
      let next = 0;
      mockPost.mockImplementation(async (_u: unknown, body: any) => {
        const data = body.input.text.map((_: string, i: number) => ({ index: i, embedding: [next++, 0] }));
        return sapResponse(data, { prompt_tokens: 10, total_tokens: 20 });
      });
    }
    const scaled = (texts: string[]) =>
      texts.reduce((sum, t) => sum + estimateTokens(t), 0) * EMBED_TOKEN_ESTIMATE_FACTOR;

    it('pins the budget and the factor', () => {
      expect(EMBED_REQUEST_TOKEN_BUDGET).toBe(250_000);
      expect(EMBED_TOKEN_ESTIMATE_FACTOR).toBe(1.8);
    });

    it('splits 300 short inputs into 256 + 44 and keeps the order', async () => {
      echoPositions();
      const texts = Array.from({ length: 300 }, (_, i) => `t${i}`);

      const result = await embed(texts, 'document', TARGET);

      expect(mockPost.mock.calls.map((c) => c[1].input.text.length)).toEqual([256, 44]);
      expect(result.vectors.map((v) => v[0])).toEqual(texts.map((_, i) => i));
    });

    it('closes a request before its scaled estimate passes the budget', async () => {
      echoPositions();
      const texts = Array.from({ length: 100 }, () => 'a '.repeat(2000).trim()); // ~4,000 characters
      expect(scaled(texts)).toBeGreaterThan(EMBED_REQUEST_TOKEN_BUDGET);

      const result = await embed(texts, 'document', TARGET);

      expect(mockPost.mock.calls.length).toBeGreaterThan(1);
      for (const call of mockPost.mock.calls) {
        expect(scaled(call[1].input.text)).toBeLessThanOrEqual(EMBED_REQUEST_TOKEN_BUDGET);
      }
      expect(mockPost.mock.calls.flatMap((c) => c[1].input.text)).toEqual(texts);
      expect(result.vectors.map((v) => v[0])).toEqual(texts.map((_, i) => i));
    });

    it('sends an input that alone exceeds the budget in a request of its own', async () => {
      echoPositions();
      const huge = 'a '.repeat(150_000).trim();
      expect(scaled([huge])).toBeGreaterThan(EMBED_REQUEST_TOKEN_BUDGET);

      const result = await embed(['small one', huge, 'small two'], 'document', TARGET);

      expect(mockPost.mock.calls.map((c) => c[1].input.text)).toEqual([['small one'], [huge], ['small two']]);
      expect(result.vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    });

    it('sums usage across the sub-requests', async () => {
      echoPositions();
      const texts = Array.from({ length: 300 }, (_, i) => `t${i}`);

      const result = await embed(texts, 'document', TARGET);

      expect(result.usage).toEqual({ promptTokens: 20, totalTokens: 40 });
    });
  });

  describe('onUsage: one call per billed sub-request', () => {
    function answer(n: number, usage: { prompt_tokens: number; total_tokens: number }) {
      return sapResponse(
        Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i, 0] })),
        usage,
      );
    }
    const texts = Array.from({ length: 600 }, (_, i) => `t${i}`); // 256 + 256 + 88

    it('reports each sub-request\'s own usage and elapsed time; the return value stays the sum', async () => {
      mockPost
        .mockResolvedValueOnce(answer(256, { prompt_tokens: 1, total_tokens: 2 }))
        .mockResolvedValueOnce(answer(256, { prompt_tokens: 3, total_tokens: 4 }))
        .mockResolvedValueOnce(answer(88, { prompt_tokens: 5, total_tokens: 6 }));
      const onUsage = jest.fn();

      const result = await embed(texts, 'document', TARGET, { onUsage });

      expect(onUsage).toHaveBeenCalledTimes(3);
      expect(onUsage.mock.calls.map((c: any[]) => [c[0].promptTokens, c[0].totalTokens]))
        .toEqual([[1, 2], [3, 4], [5, 6]]);
      for (const [u] of onUsage.mock.calls as any[]) {
        expect(Number.isFinite(u.elapsedMs)).toBe(true);
        expect(u.elapsedMs).toBeGreaterThanOrEqual(0);
      }
      expect(result.usage).toEqual({ promptTokens: 9, totalTokens: 12 });
    });

    it('records the billed first sub-request when sub-request 2 of 3 fails', async () => {
      mockPost
        .mockResolvedValueOnce(answer(256, { prompt_tokens: 7, total_tokens: 7 }))
        .mockRejectedValueOnce(Object.assign(new Error('upstream 500'), { response: { status: 500, data: {} } }));
      const onUsage = jest.fn();

      await expect(embed(texts, 'document', TARGET, { onUsage })).rejects.toThrow('upstream 500');

      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(onUsage).toHaveBeenCalledTimes(1);
      expect(onUsage.mock.calls[0][0]).toEqual(expect.objectContaining({ promptTokens: 7, totalTokens: 7 }));
    });

    it('is not called for a sub-request whose response is rejected', async () => {
      mockPost.mockResolvedValueOnce(sapResponse([{ index: 0, embedding: [1, 2, 3] }]));
      const onUsage = jest.fn();

      await expect(embed(['a'], 'document', TARGET, { onUsage })).rejects.toThrow(/dimension/);

      expect(onUsage).not.toHaveBeenCalled();
    });

    it('a throwing hook does not fail the embedding', async () => {
      mockPost
        .mockResolvedValueOnce(answer(256, { prompt_tokens: 1, total_tokens: 1 }))
        .mockResolvedValueOnce(answer(256, { prompt_tokens: 1, total_tokens: 1 }))
        .mockResolvedValueOnce(answer(88, { prompt_tokens: 1, total_tokens: 1 }));
      const onUsage = jest.fn(() => { throw new Error('sink broke'); });

      const result = await embed(texts, 'document', TARGET, { onUsage });

      expect(result.vectors).toHaveLength(600);
      expect(onUsage).toHaveBeenCalledTimes(3);
    });

    it('is not called for an empty input', async () => {
      const onUsage = jest.fn();
      await embed([], 'document', TARGET, { onUsage });
      expect(onUsage).not.toHaveBeenCalled();
    });
  });
});
