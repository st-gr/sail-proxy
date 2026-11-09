import {
  COMMON_LEXEMES_SQL, COMMON_LEXEMES_TTL_MS, COMMON_LEXEME_SHARE, OR_ARM_RANKED_SET_CEILING, SEARCHED_CHUNKS_TTL_MS,
  TABLE_ROWS_SQL, TABLE_ROWS_TTL_MS, commonLexemes, lexicalBound, __resetLexicalBoundForTests,
  SEARCHED_CHUNKS_CACHE_MAX, searchedChunksCount, tableRowsEstimate,
} from '../../src/fileSearch/lexicalBound';

describe('commonLexemes: table statistics of tsv and context_tsv', () => {
  const tsv = { attname: 'tsv', null_frac: 0, elems: ['lx1', 'lx2', 'lx3'], freqs: [0.6, 0.06, 0.01, 0.01, 0.6, 0] };

  it('keeps the lexemes in more than `share` of the rows', () => {
    expect(commonLexemes([tsv], 0.05)).toEqual(['lx1', 'lx2']);
    expect(commonLexemes([tsv], 0.5)).toEqual(['lx1']);
    expect(commonLexemes([tsv], 0.6)).toEqual([]);
  });

  it('reads context_tsv frequencies as a share of all rows, not of its non-null ones', () => {
    // 10 % of chunks have a context; 'intro' is in every one of them: 10 % of the table.
    const ctx = { attname: 'context_tsv', null_frac: 0.9, elems: ['intro', 'guide'], freqs: [1, 0.4, 0.4, 1, 0] };
    expect(commonLexemes([ctx], 0.05)).toEqual(['intro']);
    expect(commonLexemes([tsv, ctx], 0.05)).toEqual(['intro', 'lx1', 'lx2']);
    expect(commonLexemes([tsv, { ...ctx, elems: ['lx1'], freqs: [1, 1, 1, 0] }], 0.05)).toEqual(['lx1', 'lx2']);
  });

  it('has nothing to drop without statistics (never analysed, or no lexeme above the cutoff)', () => {
    expect(commonLexemes([], 0.05)).toEqual([]);
    expect(commonLexemes([{ attname: 'tsv', null_frac: 0, elems: null, freqs: null }], 0.05)).toEqual([]);
  });

  it('refuses frequencies that do not line up with the lexemes', () => {
    expect(() => commonLexemes([{ attname: 'tsv', null_frac: 0, elems: ['a', 'b'], freqs: [0.5] }], 0.05)).toThrow();
  });

  it('ships 5 % and a 5,000-chunk ceiling', () => {
    expect(COMMON_LEXEME_SHARE).toBe(0.05);
    expect(OR_ARM_RANKED_SET_CEILING).toBe(5000);
  });
});

describe('lexicalBound: only above exact_max_chunks searched chunks', () => {
  let tableRows: number;
  let stats: any[];
  let failStats: boolean;
  const sent: string[] = [];
  const client = {
    query: async (sql: string) => {
      sent.push(sql);
      if (sql === TABLE_ROWS_SQL) return { rows: tableRows === undefined ? [] : [{ n: tableRows }] };
      if (sql === COMMON_LEXEMES_SQL) {
        if (failStats) throw Object.assign(new Error('x'), { code: '42501' });
        return { rows: stats };
      }
      throw new Error(`unexpected ${sql}`);
    },
  };
  let searched: number;
  const counts: number[] = [];
  const count = async (cap: number) => { counts.push(cap); return Math.min(searched, cap); };
  const STATS = [{ attname: 'tsv', null_frac: 0, elems: ['lx1', 'lx9'], freqs: [0.5, 0.01, 0.01, 0.5, 0] }];

  beforeEach(() => {
    __resetLexicalBoundForTests();
    tableRows = 1_000_000;
    searched = 500_000;
    stats = STATS;
    failStats = false;
    sent.length = 0;
    counts.length = 0;
  });

  it('nothing can be large in a table of at most exact_max_chunks rows: no count, no statistics', async () => {
    tableRows = 20000;
    expect(await lexicalBound(client, 20000, 'k', count, 0)).toBeNull();
    expect(sent).toEqual([TABLE_ROWS_SQL]);
    expect(counts).toEqual([]);
  });

  it('a table of unknown size (never vacuumed or analysed) is not bounded', async () => {
    for (const n of [-1, 0, Number.NaN]) {
      __resetLexicalBoundForTests();
      tableRows = n;
      // eslint-disable-next-line no-await-in-loop
      expect(await lexicalBound(client, 20000, 'k', count, 0)).toBeNull();
    }
    expect(counts).toEqual([]);
  });

  it('a search over at most exact_max_chunks chunks of a large table is not bounded', async () => {
    searched = 20000;
    expect(await lexicalBound(client, 20000, 'k', count, 0)).toBeNull();
    expect(counts).toEqual([20001]);
    expect(sent).not.toContain(COMMON_LEXEMES_SQL);
  });

  it('a larger search drops the common lexemes and ranks at most the ceiling', async () => {
    searched = 20001;
    expect(await lexicalBound(client, 20000, 'k', count, 0)).toEqual({ commonLexemes: ['lx1'], ceiling: 5000 });
  });

  it('without statistics nothing is dropped, the ceiling stays', async () => {
    stats = [];
    expect(await lexicalBound(client, 20000, 'k', count, 0)).toEqual({ commonLexemes: [], ceiling: 5000 });
  });

  it('remembers the table size, each store set\'s count and the statistics for their TTLs', async () => {
    await lexicalBound(client, 20000, 'k', count, 0);
    await lexicalBound(client, 20000, 'k', count, 1000);
    expect(sent.filter((s) => s === TABLE_ROWS_SQL)).toHaveLength(1);
    expect(sent.filter((s) => s === COMMON_LEXEMES_SQL)).toHaveLength(1);
    expect(counts).toHaveLength(1);
    await lexicalBound(client, 20000, 'other', count, 1000);
    expect(counts).toHaveLength(2);
    await lexicalBound(client, 20000, 'k', count, Math.max(TABLE_ROWS_TTL_MS, SEARCHED_CHUNKS_TTL_MS));
    expect(sent.filter((s) => s === TABLE_ROWS_SQL)).toHaveLength(2);
    expect(counts).toHaveLength(3);
    expect(sent.filter((s) => s === COMMON_LEXEMES_SQL)).toHaveLength(1);
    await lexicalBound(client, 20000, 'k', count, COMMON_LEXEMES_TTL_MS);
    expect(sent.filter((s) => s === COMMON_LEXEMES_SQL)).toHaveLength(2);
  });

  it('a changed exact_max_chunks is not answered from a count capped for another one', async () => {
    searched = 30000;
    expect(await lexicalBound(client, 20000, 'k', count, 0)).not.toBeNull();
    expect(await lexicalBound(client, 40000, 'k', count, 1)).toBeNull();
    expect(counts).toEqual([20001, 40001]);
  });

  it('a failed read throws and is not remembered', async () => {
    failStats = true;
    await expect(lexicalBound(client, 20000, 'k', count, 0)).rejects.toMatchObject({ code: '42501' });
    failStats = false;
    expect(await lexicalBound(client, 20000, 'k', count, 1)).toEqual({ commonLexemes: ['lx1'], ceiling: 5000 });
    expect(sent.filter((s) => s === COMMON_LEXEMES_SQL)).toHaveLength(2);
  });
});

// One cache for both checks of a large search: the full-text bound (above) and the approximate-search check
// (recallAnn.ts annCandidateArms, keyed by annPath.ts annSearchedChunksKey).
describe('the shared table-size and searched-chunks caches', () => {
  let reads = 0;
  let failRead = false;
  const client = {
    query: async (sql: string) => {
      if (sql !== TABLE_ROWS_SQL) throw new Error(`unexpected ${sql}`);
      reads += 1;
      if (failRead) throw Object.assign(new Error('x'), { code: '57014' });
      return { rows: [{ n: 1_000_000 }] };
    },
  };
  beforeEach(() => {
    __resetLexicalBoundForTests();
    reads = 0;
    failRead = false;
  });

  it('reads the table size once per TABLE_ROWS_TTL_MS, for the full-text bound and the approximate-search check alike', async () => {
    expect(await tableRowsEstimate(client, 0)).toBe(1_000_000);
    expect(await tableRowsEstimate(client, TABLE_ROWS_TTL_MS - 1)).toBe(1_000_000);
    expect(reads).toBe(1);
    await lexicalBound(client, 2_000_000, 'k', async () => 0, TABLE_ROWS_TTL_MS - 1);
    expect(reads).toBe(1);
    expect(await tableRowsEstimate(client, TABLE_ROWS_TTL_MS)).toBe(1_000_000);
    expect(reads).toBe(2);
  });

  it('a failed table-size read throws and is not remembered', async () => {
    failRead = true;
    await expect(tableRowsEstimate(client, 0)).rejects.toMatchObject({ code: '57014' });
    failRead = false;
    expect(await tableRowsEstimate(client, 1)).toBe(1_000_000);
    expect(reads).toBe(2);
  });

  it('remembers each key\'s count for SEARCHED_CHUNKS_TTL_MS; a failed count is not remembered', async () => {
    const counted: string[] = [];
    const count = (key: string, n: number) => async () => { counted.push(key); return n; };
    expect(await searchedChunksCount('a', count('a', 5), 0)).toBe(5);
    expect(await searchedChunksCount('a', count('a', 6), SEARCHED_CHUNKS_TTL_MS - 1)).toBe(5);
    expect(await searchedChunksCount('b', count('b', 7), 1)).toBe(7);
    expect(await searchedChunksCount('a', count('a', 8), SEARCHED_CHUNKS_TTL_MS)).toBe(8);
    expect(counted).toEqual(['a', 'b', 'a']);
    await expect(searchedChunksCount('c', async () => { throw new Error('boom'); }, 2)).rejects.toThrow('boom');
    expect(await searchedChunksCount('c', count('c', 9), 3)).toBe(9);
  });

  it('holds at most SEARCHED_CHUNKS_CACHE_MAX keys', async () => {
    let counts = 0;
    const count = async () => { counts += 1; return 1; };
    for (let i = 0; i < SEARCHED_CHUNKS_CACHE_MAX; i += 1) await searchedChunksCount(`k${i}`, count, 0); // eslint-disable-line no-await-in-loop
    await searchedChunksCount('k0', count, 0);
    expect(counts).toBe(SEARCHED_CHUNKS_CACHE_MAX); // all remembered
    await searchedChunksCount('one more', count, 0); // the map is full: cleared, then this one kept
    await searchedChunksCount('k0', count, 0);
    expect(counts).toBe(SEARCHED_CHUNKS_CACHE_MAX + 2);
  });
});
