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
import { embed } from '../../src/fileSearch/embedder';

function sapResponse(data: Array<{ index: number; embedding: number[] }>, usage = { prompt_tokens: 1, total_tokens: 1 }) {
  return { data: { request_id: 'req-1', final_result: { object: 'list', data, model: 'text-embedding-3-large', usage } } };
}

describe('embed', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('does not send input_type on the wire for document embedding — the orchestration schema rejects it with HTTP 400', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'document');

    const body = mockPost.mock.calls[0][1];
    expect(body.input).toEqual({ text: ['hello'] });
    expect(JSON.stringify(body)).not.toContain('input_type');
  });

  it('does not send input_type on the wire for query embedding — the orchestration schema rejects it with HTTP 400', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'query');

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

    await embed(['alpha', 'bravo', 'charlie'], 'document');

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1].input).toEqual({ text: ['alpha', 'bravo', 'charlie'] });
  });

  it('sends the configured embedding model and dimensions so the response matches the pinned vector column', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'query');

    const body = mockPost.mock.calls[0][1];
    expect(body.config.modules.embeddings.model.name).toBe('text-embedding-3-large');
    expect(body.config.modules.embeddings.model.params.dimensions).toBe(2);
  });

  it('returns vectors in the same order as the inputs, honouring the response index rather than array position', async () => {
    mockPost.mockResolvedValue(sapResponse([
      { index: 1, embedding: [2, 2] },
      { index: 0, embedding: [1, 1] },
    ]));

    const result = await embed(['a', 'b'], 'document');

    expect(result.vectors).toEqual([[1, 1], [2, 2]]);
  });

  it('rejects a vector whose dimension contradicts the configured one', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2, 0.3] }]));

    await expect(embed(['x'], 'document')).rejects.toThrow(/dimension/);
  });

  it('surfaces prompt and total token usage from final_result.usage', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }], { prompt_tokens: 7, total_tokens: 7 }));

    const result = await embed(['hello'], 'document');

    expect(result.usage).toEqual({ promptTokens: 7, totalTokens: 7 });
  });

  it('sends Authorization and AI-Resource-Group headers, mirroring searchExecutor', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'document');

    const options = mockPost.mock.calls[0][2];
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(options.headers['AI-Resource-Group']).toBe('default');
  });

  it('hits the orchestration deployment /v2/embeddings path, not a standalone embedding-model deployment', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'document');

    const url = mockPost.mock.calls[0][0];
    expect(url).toBe('https://sap.example/v2/inference/deployments/orch-deployment/v2/embeddings');
  });

  it('returns empty vectors for an empty batch without calling the API', async () => {
    const result = await embed([], 'document');

    expect(result.vectors).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 0, totalTokens: 0 });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('throws a clear error when no orchestration deployment is available', async () => {
    const spy = jest.spyOn(configService, 'getDeploymentId').mockResolvedValueOnce(null as any);

    await expect(embed(['hello'], 'document')).rejects.toThrow(/deployment/i);
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

    await expect(embed(['a', 'b'], 'document')).rejects.toThrow(/index/i);
  });

  it('rejects a response with duplicate datum.index values even though the array length is correct', async () => {
    // Trap: length matches texts.length (2), so the length guard alone would
    // pass this fixture. Only explicit duplicate detection catches it.
    mockPost.mockResolvedValue(sapResponse([
      { index: 0, embedding: [0.1, 0.2] },
      { index: 0, embedding: [0.3, 0.4] },
    ]));

    await expect(embed(['a', 'b'], 'document')).rejects.toThrow(/duplicate/i);
  });

  it('rejects a short response rather than returning a sparse array', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await expect(embed(['a', 'b'], 'document')).rejects.toThrow();
  });

  it('passes a bounded timeout to axios so a body that never ends cannot hang the request indefinitely', async () => {
    mockPost.mockResolvedValue(sapResponse([{ index: 0, embedding: [0.1, 0.2] }]));

    await embed(['hello'], 'document');

    const options = mockPost.mock.calls[0][2];
    expect(typeof options.timeout).toBe('number');
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(60_000);
  });
});
