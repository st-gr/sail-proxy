import {
  evaluateOutcomes, hitNeedsFragment, hitRank, matchQuote, matchResults, ndcgAt, percentile, QuestionKind,
  QuestionOutcome, summarise,
} from '../../src/fileSearch/eval/metrics';

// The evaluation's one normaliser (ci/file-search-eval/normalise.js): the runner and the question
// generator both use it, so the relevance tests do too.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalise } = require('../../../../ci/file-search-eval/normalise');

function outcome(kind: QuestionKind, quoteCount: number, matches: Array<[number, number[], number[]?]>, latencyMs = 10): QuestionOutcome {
  return {
    id: `q-${kind}-${Math.random()}`, kind, quoteCount, returned: 20, latencyMs,
    matches: matches.map(([rank, exact, fragment]) => ({ rank, exact, fragment: fragment ?? [] })),
  };
}

describe('file_search eval: relevance', () => {
  const quote = normalise('The reranker falls back to the RRF order when no deployment is running.');

  it('matches a chunk that contains the whole quote, after normalising both sides', () => {
    const chunk = normalise('Intro.\n\nThe  reranker falls back to the RRF order\nwhen no deployment is running. More text.');
    expect(matchQuote(chunk, quote)).toBe('exact');
  });

  it('folds typographic quotes and dashes through the shared normaliser', () => {
    const q = normalise('Set it to "auto" - the default');
    expect(matchQuote(normalise('You can set it to “auto” – the default.'), q)).toBe('exact');
  });

  it('matches a fragment of at least 60% of the quote (a quote cut by a chunk boundary)', () => {
    const cut = quote.slice(0, Math.ceil(quote.length * 0.6));
    expect(matchQuote(`end of the previous chunk ${cut}`, quote)).toBe('fragment');
    const tail = quote.slice(quote.length - Math.ceil(quote.length * 0.6));
    expect(matchQuote(`${tail} start of the next section`, quote)).toBe('fragment');
  });

  it('does not match a fragment shorter than 60% of the quote', () => {
    const short = quote.slice(0, Math.ceil(quote.length * 0.6) - 1);
    expect(matchQuote(`text ${short} text`, quote)).toBeNull();
    expect(matchQuote('nothing related at all', quote)).toBeNull();
    expect(matchQuote('anything', '')).toBeNull();
  });

  it('records per rank which quotes match and how; a null chunk (another file) never matches', () => {
    const q1 = normalise('alpha beta gamma delta');
    const q2 = normalise('one two three four five');
    const matches = matchResults([q1, null, 'x one two three four y', 'nothing', `${q1} ${q2}`], [q1, q2]);
    expect(matches).toEqual([
      { rank: 1, exact: [0], fragment: [] },
      { rank: 3, exact: [], fragment: [1] },
      { rank: 5, exact: [0, 1], fragment: [] },
    ]);
  });
});

describe('file_search eval: hit rules', () => {
  it('a single-quote question is a hit at the first rank covering its quote', () => {
    const o = outcome('markdown', 1, [[4, [0]], [9, [0]]]);
    expect(hitRank(o)).toBe(4);
  });

  it('a multihop question needs every quote ("all"), and reports the "any" rank too', () => {
    const o = outcome('multihop', 2, [[2, [1]], [7, [0]]]);
    expect(hitRank(o, 'all')).toBe(7);
    expect(hitRank(o, 'any')).toBe(2);
    expect(hitRank(o)).toBe(7);
    const half = outcome('multihop', 2, [[1, [0]]]);
    expect(hitRank(half, 'all')).toBeNull();
    expect(hitRank(half, 'any')).toBe(1);
  });

  it('counts a hit that exists, or ranks earlier, only through the fragment rule', () => {
    expect(hitNeedsFragment(outcome('pdf', 1, [[3, [], [0]]]))).toBe(true);
    expect(hitNeedsFragment(outcome('pdf', 1, [[3, [], [0]], [8, [0]]]))).toBe(true);
    expect(hitNeedsFragment(outcome('pdf', 1, [[3, [0], [0]]]))).toBe(false);
    expect(hitNeedsFragment(outcome('pdf', 1, []))).toBe(false);
    expect(hitNeedsFragment(outcome('multihop', 2, [[1, [0]], [2, [], [1]]]))).toBe(true);
  });
});

describe('file_search eval: metrics', () => {
  it('computes recall@5/10/20 and MRR over the hit ranks', () => {
    const outcomes = [
      outcome('markdown', 1, [[1, [0]]]),
      outcome('markdown', 1, [[6, [0]]]),
      outcome('markdown', 1, [[15, [0]]]),
      outcome('markdown', 1, []),
    ];
    const s = summarise(outcomes);
    expect(s.questions).toBe(4);
    expect(s.recall).toEqual({ 5: 0.25, 10: 0.5, 20: 0.75 });
    expect(s.mrr).toBeCloseTo((1 + 1 / 6 + 1 / 15 + 0) / 4, 10);
  });

  it('nDCG@10 is 1 for a top hit, 1/log2(r+1) for a single quote at rank r, 0 beyond 10', () => {
    expect(ndcgAt(outcome('markdown', 1, [[1, [0]]]))).toBe(1);
    expect(ndcgAt(outcome('markdown', 1, [[3, [0]]]))).toBeCloseTo(1 / Math.log2(4), 10);
    expect(ndcgAt(outcome('markdown', 1, [[11, [0]]]))).toBe(0);
  });

  it('nDCG@10 scores each quote at its first covering rank, so overlapping chunks cannot pass 1', () => {
    const repeated = outcome('markdown', 1, [[1, [0]], [2, [0]], [3, [0]]]);
    expect(ndcgAt(repeated)).toBe(1);
    // Both quotes of a multihop question in the rank-1 chunk is the ideal answer.
    expect(ndcgAt(outcome('multihop', 2, [[1, [0, 1]]]))).toBe(1);
    expect(ndcgAt(outcome('multihop', 2, [[1, [0]], [3, [1]]]))).toBeCloseTo((1 + 0.5) / 2, 10);
    expect(ndcgAt(outcome('multihop', 2, [[1, [0]], [2, [0]], [4, [], [1]]]))).toBeCloseTo((1 + 1 / Math.log2(5)) / 2, 10);
    expect(ndcgAt(outcome('multihop', 2, [[2, [0]], [12, [1]]]))).toBeCloseTo((1 / Math.log2(3)) / 2, 10);
  });

  it('breaks down per kind, adds the multihop any-quote line and the fragment-rule count', () => {
    const outcomes = [
      outcome('markdown', 1, [[1, [0]]], 100),
      outcome('pdf', 1, [[2, [], [0]]], 200),
      outcome('scanned', 1, [], 300),
      outcome('multihop', 2, [[1, [0]]], 400),
    ];
    const m = evaluateOutcomes(outcomes);
    expect(Object.keys(m.byKind).sort()).toEqual(['markdown', 'multihop', 'pdf', 'scanned']);
    expect(m.byKind.markdown!.recall['5']).toBe(1);
    expect(m.byKind.scanned!.recall['20']).toBe(0);
    expect(m.byKind.multihop!.recall['20']).toBe(0);
    expect(m.multihopAnyQuote!.recall['5']).toBe(1);
    expect(m.overall.recall['5']).toBe(0.5);
    expect(m.fragmentRuleHits).toBe(1);
    expect(m.latencyMs).toEqual({ p50: 200, p95: 400 });
  });

  it('has no multihop line without multihop questions, and nearest-rank percentiles', () => {
    expect(evaluateOutcomes([outcome('markdown', 1, [])]).multihopAnyQuote).toBeNull();
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
  });
});
