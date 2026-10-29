import { buildSearchRequest, canSearch, isLongPassage, pagesText, toSearchRows, MAX_QUERY_LENGTH } from '../webapp/model/search';

const form = (over: any = {}) => ({ query: 'how do refunds work', maxResults: 10, threshold: '', rewrite: false, ...over });

describe('canSearch', () => {
  it('needs a query with something in it', () => {
    expect(canSearch('refunds')).toBe(true);
    expect(canSearch('')).toBe(false);
    expect(canSearch('   \n')).toBe(false);
  });
});

describe('buildSearchRequest', () => {
  it('sends the trimmed query and the result count', () => {
    expect(buildSearchRequest(form({ query: '  refunds \n' }))).toEqual({ ok: true, body: { query: 'refunds', max_num_results: 10 } });
  });
  it('adds a threshold and the rewrite flag only when set', () => {
    expect(buildSearchRequest(form({ threshold: '0.25', rewrite: true }))).toEqual({
      ok: true, body: { query: 'how do refunds work', max_num_results: 10, ranking_options: { score_threshold: 0.25 }, rewrite_query: true }
    });
    expect(buildSearchRequest(form({ threshold: '0' }))).toMatchObject({ ok: true, body: { ranking_options: { score_threshold: 0 } } });
    expect(buildSearchRequest(form({ threshold: ' 1 ' }))).toMatchObject({ ok: true, body: { ranking_options: { score_threshold: 1 } } });
  });
  it('refuses an empty query', () => {
    expect(buildSearchRequest(form({ query: '  ' }))).toEqual({ ok: false, problem: 'query_empty' });
  });
  it('accepts a query of exactly the maximum length and refuses one more', () => {
    expect(MAX_QUERY_LENGTH).toBe(8192);
    expect(buildSearchRequest(form({ query: 'a'.repeat(8192) })).ok).toBe(true);
    expect(buildSearchRequest(form({ query: 'a'.repeat(8193) }))).toEqual({ ok: false, problem: 'query_too_long' });
  });
  it('takes 1 to 50 results, as a number or a numeric string', () => {
    expect(buildSearchRequest(form({ maxResults: 1 })).ok).toBe(true);
    expect(buildSearchRequest(form({ maxResults: '50' }))).toMatchObject({ ok: true, body: { max_num_results: 50 } });
    for (const bad of [0, 51, 2.5, '', 'ten', NaN, -1]) expect(buildSearchRequest(form({ maxResults: bad }))).toEqual({ ok: false, problem: 'results_invalid' });
  });
  it('takes a threshold from 0 to 1 or none', () => {
    expect(buildSearchRequest(form({ threshold: '.5' }))).toMatchObject({ ok: true, body: { ranking_options: { score_threshold: 0.5 } } });
    for (const bad of ['1.01', '-0.1', 'abc', '2', '0.5.1', '1e-1']) expect(buildSearchRequest(form({ threshold: bad }))).toEqual({ ok: false, problem: 'threshold_invalid' });
  });
});

describe('toSearchRows', () => {
  it('numbers the hits, rounds the score to three decimals and joins the text passages', () => {
    const rows = toSearchRows({
      search_query: ['refunds'],
      data: [
        { file_id: 'file-1', filename: 'policy.pdf', score: 0.87345, attributes: {}, content: [{ type: 'text', text: 'Refunds take 5 days.' }, { type: 'text', text: 'Ask support.' }] },
        { file_id: 'file-2', filename: 'faq.md', score: 0.5, content: [{ type: 'text', text: 'FAQ' }] }
      ]
    });
    expect(rows).toEqual([
      { rank: 1, fileId: 'file-1', filename: 'policy.pdf', pages: '', score: '0.873', text: 'Refunds take 5 days.\n\nAsk support.' },
      { rank: 2, fileId: 'file-2', filename: 'faq.md', pages: '', score: '0.500', text: 'FAQ' }
    ]);
  });
  it('shows the pages a hit spans when the gateway sends them', () => {
    const rows = toSearchRows({
      data: [
        { file_id: 'f1', filename: 'policy.pdf', score: 0.9, pages: { first: 4, last: 5 }, content: [{ type: 'text', text: 'a' }] },
        { file_id: 'f2', filename: 'policy.pdf', score: 0.8, pages: { first: 7, last: 7 }, content: [{ type: 'text', text: 'b' }] },
        { file_id: 'f3', filename: 'faq.md', score: 0.7, content: [{ type: 'text', text: 'c' }] }
      ]
    });
    expect(rows.map((r) => r.pages)).toEqual(['4–5', '7', '']);
  });
  it('ignores a malformed pages value', () => {
    for (const odd of [null, {}, { first: 0, last: 1 }, { first: 3, last: 2 }, { first: '4', last: '5' }, { first: 1.5, last: 2 }]) {
      expect(pagesText(odd)).toBe('');
    }
  });
  it('gives no rows for no results, a missing body or odd content', () => {
    expect(toSearchRows({ data: [] })).toEqual([]);
    expect(toSearchRows(null)).toEqual([]);
    expect(toSearchRows({ data: [{ file_id: 'f', filename: 'a', score: 'x', content: [{ type: 'image' }, null] }] })).toEqual([
      { rank: 1, fileId: 'f', filename: 'a', pages: '', score: '', text: '' }
    ]);
  });
});

describe('isLongPassage', () => {
  it('offers "More" only for a passage that six lines may cut', () => {
    expect(isLongPassage('A short answer.')).toBe(false);
    expect(isLongPassage('')).toBe(false);
    expect(isLongPassage('word '.repeat(80))).toBe(false);
    expect(isLongPassage('word '.repeat(200))).toBe(true);
    expect(isLongPassage('1\n2\n3\n4\n5\n6')).toBe(false);
    expect(isLongPassage('1\n2\n3\n4\n5\n6\n7')).toBe(true);
  });
});

describe('toSearchRows in the cockpit language', () => {
  it('keeps three decimals with the locale\'s decimal sign', () => {
    const body = { data: [{ file_id: 'f', filename: 'a', score: 0.87345, content: [] }] };
    expect(toSearchRows(body, 'de')[0].score).toBe('0,873');
    expect(toSearchRows(body, 'en')[0].score).toBe(toSearchRows(body)[0].score);
  });
});
