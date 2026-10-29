/**
 * sapRequest: a per-attempt timeout on every SAP call it wraps, and one retry for calls that are
 * safe to repeat. Exercised with real axios against a local server that stalls, resets or answers
 * 5xx (test/fakeSapServer.ts), never against SAP.
 */
import { describe, it, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import axios from 'axios';
import { getDefaultLogger } from '@libs/logger';
import {
  sapRequest, markResponseArrived, isRetryableSapError, sapTiming,
  __setSapTimingForTests, __resetSapTimingForTests,
} from '../src/utils/sapRequest';
import { startFakeSapServer, FakeSapServer } from './fakeSapServer';

const ATTEMPT_MS = 300;

let server: FakeSapServer;

beforeAll(async () => {
  server = await startFakeSapServer();
  __setSapTimingForTests({ retryJitterMinMs: 5, retryJitterMaxMs: 10 });
});

afterAll(async () => {
  __resetSapTimingForTests();
  await server.close();
});

afterEach(() => {
  server.requests.length = 0;
});

function get(options: { retry: boolean; deadline?: number; attemptTimeoutMs?: number }) {
  return sapRequest(
    { kind: 'deployment list', attemptTimeoutMs: options.attemptTimeoutMs ?? ATTEMPT_MS, retry: options.retry,
      deadline: options.deadline },
    ({ timeoutMs, signal }) => axios.get(`${server.url}/v2/lm/deployments`, { timeout: timeoutMs, signal }),
  );
}

describe('sapRequest', () => {
  it('pins the production timings: 10 s per list, token and query-embedding attempt, 30 s per document batch', () => {
    __resetSapTimingForTests();
    try {
      expect(sapTiming()).toEqual({
        listAttemptMs: 10_000,
        tokenAttemptMs: 10_000,
        queryEmbeddingAttemptMs: 10_000,
        documentEmbeddingAttemptMs: 30_000,
        retryJitterMinMs: 250,
        retryJitterMaxMs: 1_000,
      });
    } finally {
      __setSapTimingForTests({ retryJitterMinMs: 5, retryJitterMaxMs: 10 });
    }
  });

  it('times out a stalled call and retries it once, then gives up', async () => {
    server.script([{ kind: 'stall' }]);
    const startedAt = Date.now();

    await expect(get({ retry: true })).rejects.toMatchObject({ code: 'ETIMEDOUT' });

    const elapsed = Date.now() - startedAt;
    expect(server.requests).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(2 * ATTEMPT_MS - 20);
    expect(elapsed).toBeLessThan(2 * ATTEMPT_MS + 1_000);
  });

  it('succeeds on the retry after a stall, and logs the retry without the payload', async () => {
    const warn = jest.spyOn(getDefaultLogger(), 'warn').mockImplementation(() => undefined as any);
    try {
      server.script([{ kind: 'stall' }, { kind: 'json', body: { resources: [{ id: 'd1' }] } }]);

      const response = await get({ retry: true });

      expect(response.data).toEqual({ resources: [{ id: 'd1' }] });
      expect(server.requests).toHaveLength(2);
      const messages = warn.mock.calls.map((call) => call.join(' '));
      expect(messages).toEqual([expect.stringContaining('deployment list: retrying once after a timeout')]);
      expect(messages.join(' ')).not.toContain('d1');
    } finally {
      warn.mockRestore();
    }
  });

  it('retries once after a connection reset', async () => {
    server.script([{ kind: 'reset' }, { kind: 'json', body: { ok: true } }]);

    await expect(get({ retry: true })).resolves.toMatchObject({ data: { ok: true } });
    expect(server.requests).toHaveLength(2);
  });

  it.each([502, 503, 504])('retries once after HTTP %i', async (status) => {
    server.script([{ kind: 'status', status }, { kind: 'json', body: { ok: true } }]);

    await expect(get({ retry: true })).resolves.toMatchObject({ data: { ok: true } });
    expect(server.requests).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 413, 422, 429, 500])('never retries HTTP %i', async (status) => {
    server.script([{ kind: 'status', status }, { kind: 'json', body: { ok: true } }]);

    await expect(get({ retry: true })).rejects.toMatchObject({ response: { status } });
    expect(server.requests).toHaveLength(1);
  });

  it('never retries a call that is not safe to repeat: it only times out', async () => {
    server.script([{ kind: 'stall' }, { kind: 'json', body: { ok: true } }]);

    await expect(get({ retry: false })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(server.requests).toHaveLength(1);
  });

  it('clips an attempt to the deadline and starts no retry the remaining budget cannot hold', async () => {
    server.script([{ kind: 'stall' }, { kind: 'json', body: { ok: true } }]);
    const startedAt = Date.now();

    // One full attempt fits, a second does not.
    await expect(get({ retry: true, attemptTimeoutMs: 400, deadline: startedAt + 600 }))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' });

    expect(server.requests).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(600);
  });

  it('gives the first attempt only the time left before the deadline', async () => {
    server.script([{ kind: 'stall' }]);
    const startedAt = Date.now();

    await expect(get({ retry: true, attemptTimeoutMs: 5_000, deadline: startedAt + 200 }))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(server.requests).toHaveLength(1);
  });

  it('never retries a failure that came after the response arrived', async () => {
    let calls = 0;
    const failure = sapRequest({ kind: 'embeddings', attemptTimeoutMs: ATTEMPT_MS, retry: true }, async () => {
      calls += 1;
      throw markResponseArrived(Object.assign(new Error('body stalled'), { code: 'ECONNRESET' }));
    });

    await expect(failure).rejects.toThrow('body stalled');
    expect(calls).toBe(1);
  });

  it('classifies errors: transport failures and 502/503/504 retry, everything else does not', () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    const status = (s: number) => Object.assign(new Error(`HTTP ${s}`), { response: { status: s } });
    expect(isRetryableSapError(coded('ECONNRESET'))).toBe(true);
    expect(isRetryableSapError(coded('ETIMEDOUT'))).toBe(true);
    expect(isRetryableSapError(coded('ECONNABORTED'))).toBe(true);
    expect(isRetryableSapError(status(503))).toBe(true);
    expect(isRetryableSapError(coded('ERR_CANCELED'))).toBe(false);
    expect(isRetryableSapError(status(429))).toBe(false);
    expect(isRetryableSapError(new Error('plain'))).toBe(false);
    expect(isRetryableSapError(markResponseArrived(coded('ECONNRESET')))).toBe(false);
  });
});
