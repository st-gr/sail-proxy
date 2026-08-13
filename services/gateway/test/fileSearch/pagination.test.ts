import { describe, it, expect } from '@jest/globals';
import { parsePageParams, buildPage } from '../../src/fileSearch/pagination';

describe('parsePageParams', () => {
  it('defaults to limit 20 descending', () => {
    expect(parsePageParams({})).toEqual({ limit: 20, order: 'desc', after: null, before: null });
  });

  it('clamps limit to 1..100', () => {
    expect(parsePageParams({ limit: '0' }).limit).toBe(1);
    expect(parsePageParams({ limit: '1000' }).limit).toBe(100);
  });

  it('clamps negative limits to 1', () => {
    expect(parsePageParams({ limit: '-5' }).limit).toBe(1);
  });

  it('falls back to the default limit for non-numeric input', () => {
    expect(parsePageParams({ limit: 'not-a-number' }).limit).toBe(20);
  });

  it('accepts order=asc', () => {
    expect(parsePageParams({ order: 'asc' }).order).toBe('asc');
  });

  it('treats any order other than asc as desc', () => {
    expect(parsePageParams({ order: 'bogus' }).order).toBe('desc');
  });

  it('passes through after and before cursors', () => {
    expect(parsePageParams({ after: 'file-aaa', before: 'file-bbb' })).toEqual({
      limit: 20, order: 'desc', after: 'file-aaa', before: 'file-bbb',
    });
  });

  it('treats an empty-string cursor as absent', () => {
    expect(parsePageParams({ after: '' }).after).toBeNull();
  });

  it('takes the first element when a param is repeated (array from query string)', () => {
    expect(parsePageParams({ limit: ['5', '10'] }).limit).toBe(5);
    expect(parsePageParams({ after: ['file-a', 'file-b'] }).after).toBe('file-a');
  });
});

describe('buildPage', () => {
  it('sets has_more by over-fetching one row and trims it off', () => {
    const page = buildPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2);
    expect(page.data.map((d: { id: string }) => d.id)).toEqual(['a', 'b']);
    expect(page.has_more).toBe(true);
    expect(page.first_id).toBe('a');
    expect(page.last_id).toBe('b');
  });

  it('reports has_more false when the page is not full', () => {
    expect(buildPage([{ id: 'a' }], 2).has_more).toBe(false);
  });

  it('reports has_more false when exactly limit rows come back (no extra row to trim)', () => {
    const page = buildPage([{ id: 'a' }, { id: 'b' }], 2);
    expect(page.data.map((d: { id: string }) => d.id)).toEqual(['a', 'b']);
    expect(page.has_more).toBe(false);
  });

  it('returns null first_id/last_id for an empty page', () => {
    const page = buildPage([], 20);
    expect(page.data).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.first_id).toBeNull();
    expect(page.last_id).toBeNull();
  });
});
