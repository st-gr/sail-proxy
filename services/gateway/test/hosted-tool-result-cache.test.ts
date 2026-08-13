import {
  putToolResult, getToolResult, __resetToolResultCacheForTests, CachedToolResult,
} from '../src/plugins/hostedTool/resultCache';
import {
  resolveResultCacheTtlSeconds, resolveResultCacheMaxEntries,
  DEFAULT_RESULT_CACHE_TTL_SECONDS, DEFAULT_RESULT_CACHE_MAX_ENTRIES,
} from '../src/plugins/hostedTool/resultCacheConfig';

const entry = (over: Partial<CachedToolResult> = {}): CachedToolResult => ({
  toolType: 'web_search',
  ownerEmail: 'a@example.com',
  payload: [{ title: 'T', url: 'https://example.com', snippet: 's', content: 'c' }],
  status: 'completed',
  query: 'latest AI news today',
  ...over,
});

describe('hosted-tool result cache', () => {
  beforeEach(() => __resetToolResultCacheForTests());
  // In afterEach, not inline in the TTL test: if an assertion there threw, an inline
  // jest.useRealTimers() would never run and fake-timer state would leak into later tests.
  afterEach(() => jest.useRealTimers());

  it('returns what was stored, for the owner who stored it', () => {
    putToolResult('ws_abc1234', entry());
    expect(getToolResult('ws_abc1234', 'a@example.com')?.query).toBe('latest AI news today');
  });

  it('refuses a read by a different owner — an id collision must never cross tenants', () => {
    putToolResult('ws_abc1234', entry());
    expect(getToolResult('ws_abc1234', 'b@example.com')).toBeUndefined();
  });

  it('never stores a result whose owner could not be resolved — fail closed, not a shared bucket', () => {
    putToolResult('ws_no_owner', entry({ ownerEmail: '' }));
    expect(getToolResult('ws_no_owner', '')).toBeUndefined();
    expect(getToolResult('ws_no_owner', 'a@example.com')).toBeUndefined();
  });

  it('never serves a stored result to a reader whose own owner could not be resolved', () => {
    putToolResult('ws_abc1234', entry());
    expect(getToolResult('ws_abc1234', '')).toBeUndefined();
  });

  it('misses on an unknown id rather than throwing', () => {
    expect(getToolResult('ws_nothing', 'a@example.com')).toBeUndefined();
  });

  it('expires an entry once its TTL has passed', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T00:00:00Z'));
    putToolResult('ws_abc1234', entry());
    jest.setSystemTime(new Date('2026-08-10T02:00:01Z')); // past the 3600s default
    expect(getToolResult('ws_abc1234', 'a@example.com')).toBeUndefined();
  });

  it('evicts the oldest entries rather than growing without bound, by insertion order not LRU', () => {
    putToolResult('ws_0', entry());
    // Read ws_0 before the overflow. Insertion order never re-inserts on a read, so this
    // must NOT save it from eviction — an LRU cache would refresh it and keep it instead,
    // which is exactly the distinction this test is meant to catch.
    expect(getToolResult('ws_0', 'a@example.com')?.status).toBe('completed');
    for (let i = 1; i < 600; i++) putToolResult(`ws_${i}`, entry());
    expect(getToolResult('ws_0', 'a@example.com')).toBeUndefined();
    expect(getToolResult('ws_599', 'a@example.com')?.status).toBe('completed');
  });

  it('never throws out of the write path, whatever it is handed', () => {
    expect(() => putToolResult('', entry())).not.toThrow();
    expect(() => putToolResult('ws_x', { ...entry(), payload: undefined })).not.toThrow();
  });
});

describe('result-cache config resolvers', () => {
  it('takes a valid integer', () => {
    expect(resolveResultCacheTtlSeconds(600)).toBe(600);
    expect(resolveResultCacheMaxEntries(50)).toBe(50);
  });
  it('falls back on anything out of range, non-integer, or the wrong type', () => {
    for (const bad of [0, 59, 86401, 1.5, '600', null, undefined, NaN]) {
      expect(resolveResultCacheTtlSeconds(bad as any)).toBe(DEFAULT_RESULT_CACHE_TTL_SECONDS);
    }
    for (const bad of [0, 9, 10001, 2.5, '50', null, undefined]) {
      expect(resolveResultCacheMaxEntries(bad as any)).toBe(DEFAULT_RESULT_CACHE_MAX_ENTRIES);
    }
  });
});
