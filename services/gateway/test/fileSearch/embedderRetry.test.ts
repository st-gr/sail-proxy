/**
 * The embedder's timeouts and single retry, with real axios against a local server that stalls,
 * resets or answers 5xx (test/fakeSapServer.ts). The retry must stay inside the call's budget and
 * must never re-send a request whose response already arrived: that request is billed.
 */
import { describe, it, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import { startFakeSapServer, FakeSapServer } from '../fakeSapServer';

let server: FakeSapServer;

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: server.url, resourceGroup: 'default' }),
    getDeploymentId: async () => 'orch-deployment',
    getAccessToken: async () => 'test-token',
    getFileSearchConfig: () => ({ embeddingModel: 'text-embedding-3-large', embeddingDimensions: 2 }),
  },
}));

import { embed } from '../../src/fileSearch/embedder';
import { __setSapTimingForTests, __resetSapTimingForTests } from '../../src/utils/sapRequest';

const TARGET = { model: 'text-embedding-3-large', dimensions: 2 };
const DOCUMENT_ATTEMPT_MS = 400;
const QUERY_ATTEMPT_MS = 200;

function answer(count: number, tokens = 3) {
  return {
    kind: 'json' as const,
    body: {
      request_id: 'r',
      final_result: {
        object: 'list',
        data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: [i, 1] })),
        model: 'text-embedding-3-large',
        usage: { prompt_tokens: tokens, total_tokens: tokens },
      },
    },
  };
}

beforeAll(async () => {
  server = await startFakeSapServer();
  __setSapTimingForTests({
    documentEmbeddingAttemptMs: DOCUMENT_ATTEMPT_MS,
    queryEmbeddingAttemptMs: QUERY_ATTEMPT_MS,
    retryJitterMinMs: 5,
    retryJitterMaxMs: 10,
  });
});

afterAll(async () => {
  __resetSapTimingForTests();
  await server.close();
});

afterEach(() => {
  server.requests.length = 0;
});

describe('embed: timeouts and one retry', () => {
  it('retries a stalled request once and records the usage of the one billed answer', async () => {
    server.script([{ kind: 'stall' }, answer(2, 7)]);
    const onUsage = jest.fn();

    const result = await embed(['a', 'b'], 'document', TARGET, { onUsage });

    expect(result.vectors.map((v) => Array.from(v))).toEqual([[0, 1], [1, 1]]);
    expect(result.usage).toEqual({ promptTokens: 7, totalTokens: 7 });
    expect(server.requests).toHaveLength(2);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('retries once after a reset and after a 503', async () => {
    server.script([{ kind: 'reset' }, answer(1)]);
    await expect(embed(['a'], 'query', TARGET)).resolves.toMatchObject({ vectors: [[0, 1]] });
    expect(server.requests).toHaveLength(2);

    server.requests.length = 0;
    server.script([{ kind: 'status', status: 503 }, answer(1)]);
    await expect(embed(['a'], 'query', TARGET)).resolves.toMatchObject({ vectors: [[0, 1]] });
    expect(server.requests).toHaveLength(2);
  });

  it('gives up after one retry', async () => {
    server.script([{ kind: 'stall' }]);
    const startedAt = Date.now();

    await expect(embed(['a'], 'query', TARGET)).rejects.toMatchObject({ code: 'ETIMEDOUT' });

    expect(server.requests).toHaveLength(2);
    expect(Date.now() - startedAt).toBeLessThan(2 * QUERY_ATTEMPT_MS + 1_000);
  });

  it('never re-sends a request whose response arrived and then stalled: it is billed already', async () => {
    server.script([{ kind: 'headersThenStall' }, answer(1)]);
    const onUsage = jest.fn();

    // Reported as the timeout it is (not "canceled"), and still never re-sent.
    await expect(embed(['a'], 'document', TARGET, { onUsage })).rejects.toMatchObject({
      code: 'ETIMEDOUT', message: expect.stringContaining(`time limit of ${DOCUMENT_ATTEMPT_MS} ms`),
    });

    expect(server.requests).toHaveLength(1);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('never re-sends a request whose answer arrived but was rejected', async () => {
    server.script([{ kind: 'json', body: { final_result: { data: [] } } }, answer(1)]);

    await expect(embed(['a'], 'document', TARGET)).rejects.toThrow(/returned 0 vectors/);
    expect(server.requests).toHaveLength(1);
  });

  it('starts no retry the caller\'s deadline cannot hold', async () => {
    server.script([{ kind: 'stall' }, answer(1)]);
    const startedAt = Date.now();

    await expect(embed(['a'], 'document', TARGET, { deadline: startedAt + DOCUMENT_ATTEMPT_MS + 100 }))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' });

    expect(server.requests).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(DOCUMENT_ATTEMPT_MS + 100);
  });

  it('never retries a 400', async () => {
    server.script([{ kind: 'status', status: 400 }, answer(1)]);

    await expect(embed(['a'], 'document', TARGET)).rejects.toMatchObject({ response: { status: 400 } });
    expect(server.requests).toHaveLength(1);
  });
});
