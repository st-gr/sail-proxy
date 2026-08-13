import { chunkText, resolveChunkingStrategy, estimateTokens, slidingWordWindows } from '../../src/fileSearch/chunker';

describe('resolveChunkingStrategy', () => {
  it('defaults to auto at 800/400', () => {
    expect(resolveChunkingStrategy(undefined))
      .toEqual({ type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } });
  });
  it('rejects a chunk size outside 100..4096', () => {
    expect(() => resolveChunkingStrategy({ type: 'static', static: { max_chunk_size_tokens: 99, chunk_overlap_tokens: 10 } }))
      .toThrow(/max_chunk_size_tokens/);
    expect(() => resolveChunkingStrategy({ type: 'static', static: { max_chunk_size_tokens: 4097, chunk_overlap_tokens: 10 } }))
      .toThrow(/max_chunk_size_tokens/);
  });
  it('rejects an overlap greater than half the chunk size', () => {
    expect(() => resolveChunkingStrategy({ type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 401 } }))
      .toThrow(/chunk_overlap_tokens/);
  });
  it('accepts an overlap of exactly half', () => {
    expect(() => resolveChunkingStrategy({ type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } }))
      .not.toThrow();
  });
});

describe('chunkText', () => {
  const strategy = { type: 'static' as const, static: { max_chunk_size_tokens: 100, chunk_overlap_tokens: 20 } };

  it('returns one chunk for short text', () => {
    const c = chunkText('a short document', strategy);
    expect(c).toHaveLength(1);
    expect(c[0].ord).toBe(0);
    expect(c[0].text).toBe('a short document');
  });

  it('numbers chunks contiguously from zero', () => {
    const c = chunkText('word '.repeat(2000), strategy);
    expect(c.length).toBeGreaterThan(1);
    expect(c.map((x) => x.ord)).toEqual(c.map((_, i) => i));
  });

  it('overlaps consecutive chunks so a boundary sentence is not lost', () => {
    const c = chunkText('word '.repeat(2000), strategy);
    const tailOfFirst = c[0].text.trim().split(/\s+/).slice(-5).join(' ');
    expect(c[1].text).toContain(tailOfFirst);
  });

  it('always makes progress, even when overlap approaches the chunk size', () => {
    // Words must vary by position: a text made of one repeated token (e.g.
    // 'word '.repeat(n)) makes any two same-length windows byte-identical
    // regardless of their start offset, which defeats the not-toBe check below
    // for reasons unrelated to whether the loop actually advanced. Numbering
    // the words keeps the same word count and chunking math while letting
    // adjacent, differently-positioned windows be textually distinguishable.
    const words = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ');
    const c = chunkText(words,
      { type: 'static', static: { max_chunk_size_tokens: 100, chunk_overlap_tokens: 50 } });
    expect(c.length).toBeLessThan(5000);   // a non-advancing loop would hang or explode
    for (let i = 1; i < c.length; i++) expect(c[i].text).not.toBe(c[i - 1].text);
  });

  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkText('', strategy)).toEqual([]);
    expect(chunkText('   \n\t ', strategy)).toEqual([]);
  });
});

// chunkText can never actually drive overlapWords >= wordsPerChunk through
// slidingWordWindows: resolveChunkingStrategy rejects overlap > size/2 before
// chunkText computes a step, so a test that only calls chunkText cannot
// distinguish a real internal clamp from a deleted one. These tests call the
// generator directly with ratios chunkText's public API can never produce.
// Only a couple of .next() calls are pulled, so even a fully unclamped
// zero/negative step (which never terminates on its own) cannot hang the test.
describe('slidingWordWindows (internal non-advancing-window guard)', () => {
  it('still advances the cursor when overlap equals the chunk size (raw step would be zero)', () => {
    const gen = slidingWordWindows(1000, 50, 50);
    const first = gen.next().value!;
    const second = gen.next().value!;
    const third = gen.next().value!;
    expect(second.start).toBeGreaterThan(first.start);
    expect(third.start).toBeGreaterThan(second.start);
  });

  it('still advances the cursor when overlap exceeds the chunk size (raw step would be negative)', () => {
    const gen = slidingWordWindows(1000, 50, 80);
    const first = gen.next().value!;
    const second = gen.next().value!;
    expect(second.start).toBeGreaterThan(first.start);
  });
});
