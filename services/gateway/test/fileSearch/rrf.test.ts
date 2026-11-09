import { fuseRrf, parseHybridSearch } from '../../src/fileSearch/rrf';

describe('fuseRrf', () => {
  it('ranks a document appearing in both lists above one appearing in either alone', () => {
    const fused = fuseRrf([['a', 'b', 'c'], ['c', 'a', 'd']], 60);
    expect(fused[0].id).toBe('a');
  });

  it('scores by 1/(k+rank) summed across lists, rank starting at 1', () => {
    const [top] = fuseRrf([['a'], ['a']], 60);
    expect(top.score).toBeCloseTo(2 / 61, 10);
  });

  it('handles one empty ranking without dropping the other', () => {
    expect(fuseRrf([[], ['x', 'y']], 60).map((r) => r.id)).toEqual(['x', 'y']);
  });

  it('is deterministic for tied scores', () => {
    expect(fuseRrf([['a', 'b']], 60)).toEqual(fuseRrf([['a', 'b']], 60));
  });

  it('scores a single ranking as exactly 1/(k+rank), preserving its original order', () => {
    // hybrid.lexicalEnabled=false runs fuseRrf with a single (vector) ranking.
    // RRF over one list must be order-preserving, not just "roughly ordered",
    // since this is the whole scoring path in that mode.
    const fused = fuseRrf([['first', 'second', 'third']], 60);
    expect(fused.map((r) => r.id)).toEqual(['first', 'second', 'third']);
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 62, 10);
    expect(fused[2].score).toBeCloseTo(1 / 63, 10);
  });

  it('returns an empty array for no rankings at all', () => {
    expect(fuseRrf([], 60)).toEqual([]);
  });

  it('breaks a genuine cross-list tie deterministically by first-seen order, not id string order', () => {
    // 'b' and 'a' tie in total score (each appears once, in symmetric ranks
    // across the two lists) but 'b' is seen first overall, so it must sort
    // first — this pins first-seen-order tie-breaking rather than relying on
    // (or coincidentally matching) lexical id order.
    const fused = fuseRrf([['b'], ['a']], 60);
    expect(fused.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('does not mutate its input arrays', () => {
    const list1 = ['a', 'b'];
    const list2 = ['b', 'a'];
    fuseRrf([list1, list2], 60);
    expect(list1).toEqual(['a', 'b']);
    expect(list2).toEqual(['b', 'a']);
  });
});

describe('fuseRrf weights', () => {
  const lists = [['a', 'b', 'c'], ['c', 'a', 'd']];

  it('default weights reproduce the unweighted output exactly', () => {
    expect(fuseRrf(lists, 60, [1, 1])).toEqual(fuseRrf(lists, 60));
    expect(fuseRrf(lists, 60, undefined)).toEqual(fuseRrf(lists, 60));
  });

  it('a 0 weight removes that list entirely: its ids neither score nor appear', () => {
    const fused = fuseRrf(lists, 60, [1, 0]);
    expect(fused.find((r) => r.id === 'c')!.score).toBeCloseTo(1 / 63, 10);
    expect(fused.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('a 0-weighted list does not decide tie-breaks among the others', () => {
    // 'd' and 'a' tie in the weighted list; 'a' would be first seen via the 0-weighted list.
    expect(fuseRrf([['a'], ['d'], ['a']], 60, [0, 1, 1]).map((r) => r.id)).toEqual(['d', 'a']);
  });

  it('shifting weight reorders the fused ranking', () => {
    expect(fuseRrf(lists, 60, [10, 1])[0].id).toBe('a');
    expect(fuseRrf(lists, 60, [1, 10])[0].id).toBe('c');
  });
});

describe('parseHybridSearch', () => {
  it('returns no weights when absent', () => {
    expect(parseHybridSearch(undefined)).toEqual({ ok: true });
  });
  it('defaults a missing field to 1', () => {
    expect(parseHybridSearch({ text_weight: 3 })).toEqual({ ok: true, weights: { embedding: 1, text: 3 } });
  });
  it('accepts a single 0 weight', () => {
    expect(parseHybridSearch({ embedding_weight: 0 })).toEqual({ ok: true, weights: { embedding: 0, text: 1 } });
  });
  it.each([
    [{ embedding_weight: -1 }],
    [{ text_weight: 'x' }],
    [{ text_weight: Infinity }],
    [{ embedding_weight: NaN }],
    [{ embedding_weight: 0, text_weight: 0 }],
    ['nope'],
    [[1]],
  ])('rejects %j', (raw) => {
    expect(parseHybridSearch(raw).ok).toBe(false);
  });
});

describe('parseHybridSearch — the retrieval guide\'s rrf_* spellings', () => {
  it('accepts rrf_embedding_weight and rrf_text_weight as the same weights', () => {
    expect(parseHybridSearch({ rrf_embedding_weight: 0.7, rrf_text_weight: 0.3 }))
      .toEqual({ ok: true, weights: { embedding: 0.7, text: 0.3 } });
  });
  it('mixes the two spellings across the two weights', () => {
    expect(parseHybridSearch({ embedding_weight: 2, rrf_text_weight: 0.5 }))
      .toEqual({ ok: true, weights: { embedding: 2, text: 0.5 } });
  });
  it('validates an alias like the documented field, naming the field the caller sent', () => {
    const parsed = parseHybridSearch({ rrf_text_weight: -1 });
    expect(parsed).toEqual({
      ok: false, message: 'ranking_options.hybrid_search.rrf_text_weight must be a number greater than or equal to 0',
    });
    expect(parseHybridSearch({ rrf_embedding_weight: 0, rrf_text_weight: 0 }).ok).toBe(false);
  });
  it.each([
    [{ embedding_weight: 1, rrf_embedding_weight: 1 }, 'embedding_weight'],
    [{ text_weight: 1, rrf_text_weight: 2 }, 'text_weight'],
  ])('rejects both spellings of one weight together (%j): ambiguous, never silently picked', (raw, field) => {
    expect(parseHybridSearch(raw)).toEqual({
      ok: false,
      message: `ranking_options.hybrid_search: give one of ${field} and rrf_${field}, not both`,
    });
  });
});
