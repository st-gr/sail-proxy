import {
  annEfSearch, annIndexReady, annSearchedChunksKey, annSessionSettings, forgetAnnIndexCheck, INDEX_CHECK_TTL_MS,
  searchedChunksAllowAnn, searchedChunksCap,
} from '../../src/fileSearch/annPath';

const ON = { enabled: true, exactMaxChunks: 20000, minFraction: 0.05 };

describe('annEfSearch', () => {
  it('is 4 x limit, at least 200 and at most 1000', () => {
    expect(annEfSearch(1)).toBe(200);
    expect(annEfSearch(50)).toBe(200);
    expect(annEfSearch(51)).toBe(204);
    expect(annEfSearch(250)).toBe(1000);
    expect(annEfSearch(400)).toBe(1000);
  });
});

describe('annSessionSettings', () => {
  it('forces the index and an iterative scan in relaxed order', () => {
    expect(annSessionSettings(50)).toBe('SET LOCAL enable_sort = off; SET LOCAL enable_seqscan = off; '
      + "SET LOCAL enable_bitmapscan = off; SET LOCAL hnsw.ef_search = 200; SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
  });
});

describe('searchedChunksAllowAnn: the thresholds', () => {
  const table = 1_000_000;
  it('stays exact up to exact_max_chunks searched chunks, inclusive', () => {
    expect(searchedChunksAllowAnn(ON, 20000, table)).toBe(false);
    expect(searchedChunksAllowAnn(ON, 20001, 100000)).toBe(true);
  });

  it('stays exact below min_fraction of the table, and goes approximate at it', () => {
    expect(searchedChunksAllowAnn(ON, 49999, table)).toBe(false);
    expect(searchedChunksAllowAnn(ON, 50000, table)).toBe(true);
  });

  it('needs both: a store above exact_max_chunks but under the fraction stays exact', () => {
    expect(searchedChunksAllowAnn(ON, 30000, table)).toBe(false);
    expect(searchedChunksAllowAnn({ ...ON, minFraction: 0 }, 30000, table)).toBe(true);
    expect(searchedChunksAllowAnn({ ...ON, exactMaxChunks: 0 }, 1, 100)).toBe(false);
    expect(searchedChunksAllowAnn({ ...ON, exactMaxChunks: 0, minFraction: 0 }, 1, 10)).toBe(true);
    expect(searchedChunksAllowAnn({ ...ON, exactMaxChunks: 0, minFraction: 0 }, 0, 10)).toBe(false);
  });

  it('stays exact while the table size is unknown (never analyzed)', () => {
    expect(searchedChunksAllowAnn(ON, 500000, -1)).toBe(false);
    expect(searchedChunksAllowAnn(ON, 500000, 0)).toBe(false);
    expect(searchedChunksAllowAnn(ON, 500000, Number.NaN)).toBe(false);
  });

  it('a stale, too small table estimate does not block it', () => {
    expect(searchedChunksAllowAnn(ON, 50000, 30000)).toBe(true);
  });
});

describe('searchedChunksCap', () => {
  it('counts just far enough to know both thresholds are passed', () => {
    expect(searchedChunksCap(ON, 100000)).toBe(20001);
    expect(searchedChunksCap(ON, 1_000_000)).toBe(50000);
    expect(searchedChunksCap(ON, 1_000_001)).toBe(50001);
    expect(searchedChunksCap({ ...ON, exactMaxChunks: 0, minFraction: 0 }, 10)).toBe(1);
    expect(searchedChunksCap(ON, -1)).toBeNull();
    expect(searchedChunksCap(ON, 0)).toBeNull();
  });

  it('a count that reaches the cap passes both thresholds', () => {
    for (const table of [10, 1000, 100000, 1_000_000, 7_777_777]) {
      for (const settings of [ON, { ...ON, minFraction: 0.3 }, { ...ON, exactMaxChunks: 0 }, { ...ON, minFraction: 1 }]) {
        const cap = searchedChunksCap(settings, table)!;
        expect({ table, settings, ann: searchedChunksAllowAnn(settings, cap, table) }).toEqual({ table, settings, ann: true });
        expect({ table, settings, ann: searchedChunksAllowAnn(settings, cap - 1, table) }).toEqual({ table, settings, ann: false });
      }
    }
  });
});

describe('annIndexReady', () => {
  const NEW = 'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw (((embedding)::halfvec(1536)) '
    + "halfvec_cosine_ops) WITH (m='16', ef_construction='200')";
  const OLD = 'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw (embedding vector_cosine_ops)';
  const client = (rows: any[]) => ({ query: jest.fn().mockResolvedValue({ rows }) });
  const index = (definition: string, valid = true) => [{ definition, valid, size: '8192' }];

  beforeEach(() => forgetAnnIndexCheck());

  it('is ready only for a valid halfvec index of the column width', async () => {
    expect(await annIndexReady(client(index(NEW)), 1536)).toBe(true);
    forgetAnnIndexCheck();
    expect(await annIndexReady(client(index(NEW)), 3072)).toBe(false);
    forgetAnnIndexCheck();
    expect(await annIndexReady(client(index(NEW, false)), 1536)).toBe(false);
    forgetAnnIndexCheck();
    expect(await annIndexReady(client(index(OLD)), 1536)).toBe(false);
    forgetAnnIndexCheck();
    expect(await annIndexReady(client([]), 1536)).toBe(false);
  });

  it('reads the catalog again once the check is older than its TTL, or for another width', async () => {
    const c = client(index(NEW));
    expect(await annIndexReady(c, 1536, 1000)).toBe(true);
    expect(await annIndexReady(c, 1536, 1000 + INDEX_CHECK_TTL_MS - 1)).toBe(true);
    expect(c.query).toHaveBeenCalledTimes(1);
    c.query.mockResolvedValue({ rows: index(OLD) });
    expect(await annIndexReady(c, 1536, 1000 + INDEX_CHECK_TTL_MS)).toBe(false);
    expect(c.query).toHaveBeenCalledTimes(2);
    expect(await annIndexReady(c, 768, 1000 + INDEX_CHECK_TTL_MS)).toBe(false);
    expect(c.query).toHaveBeenCalledTimes(3);
  });

  it('does not remember a failed read', async () => {
    const c = { query: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ rows: index(NEW) }) };
    await expect(annIndexReady(c, 1536)).rejects.toThrow('boom');
    expect(await annIndexReady(c, 1536)).toBe(true);
  });
});

describe('annSearchedChunksKey: what a cached arm count is remembered under', () => {
  const key = (over: Partial<{ cap: number; owner: string; teamIds: string[]; storeIds: string[]; model: string | undefined }> = {}) => {
    const k = { cap: 50000, owner: 'a@example.invalid', teamIds: [] as string[], storeIds: ['vs_2', 'vs_1'], model: 'm1' as string | undefined, ...over };
    return annSearchedChunksKey(k.cap, k.owner, k.teamIds, k.storeIds, k.model);
  };

  it('is the same for the same arm, whatever the order of its stores', () => {
    expect(key()).toBe(key({ storeIds: ['vs_1', 'vs_2'] }));
  });

  it('differs by owner, teams, model, stores and cap: no count is shared across tenants or settings', () => {
    const keys = [key(), key({ owner: 'b@example.invalid' }), key({ teamIds: ['t1'] }), key({ teamIds: ['t1', 't2'] }),
      key({ model: 'm2' }), key({ model: undefined }),
      key({ storeIds: ['vs_1'] }), key({ storeIds: ['vs_1', 'vs_3'] }), key({ cap: 50001 })];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cannot collide with the full-text bound\'s keys (cap first, then owner and stores)', () => {
    expect(key()).toMatch(/^ann\n/);
    expect(key({ model: undefined })).not.toBe(`50000\na@example.invalid\nvs_1\nvs_2`);
  });
});
