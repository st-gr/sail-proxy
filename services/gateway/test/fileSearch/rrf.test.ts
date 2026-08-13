import { fuseRrf } from '../../src/fileSearch/rrf';

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
