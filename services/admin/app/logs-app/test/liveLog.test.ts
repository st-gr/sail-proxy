import { anchoredFirstRow, compareEntries, DEFAULT_LIMIT, mergeEntries, mergeNewEntries, nextPollCursor, pollWasCut, POLL_OVERLAP_MS, type Entry } from '../webapp/model/liveLog';

const e = (ID: string, loggedAt: string, seq: number | string = 0): Entry => ({ ID, loggedAt, seq: String(seq) });
const ids = (list: Entry[]) => list.map((x) => x.ID);

describe('mergeNewEntries', () => {
  const shown = [e('a', '2026-11-11T10:00:00.000Z', 1), e('b', '2026-11-11T10:00:01.000Z', 2)];

  it('appends newer entries at the bottom for newest last', () => {
    expect(ids(mergeNewEntries(shown, [e('c', '2026-11-11T10:00:02.000Z', 3)], 'newestLast', 10))).toEqual(['a', 'b', 'c']);
  });

  it('puts newer entries on top for newest first', () => {
    const first = [...shown].reverse();
    expect(ids(mergeNewEntries(first, [e('c', '2026-11-11T10:00:02.000Z', 3)], 'newestFirst', 10))).toEqual(['c', 'b', 'a']);
  });

  it('never shows an ID twice, also when the poll overlap fetches it again', () => {
    const fetched = [e('b', '2026-11-11T10:00:01.000Z', 2), e('c', '2026-11-11T10:00:02.000Z', 3), e('c', '2026-11-11T10:00:02.000Z', 3)];
    expect(ids(mergeNewEntries(shown, fetched, 'newestLast', 10))).toEqual(['a', 'b', 'c']);
  });

  it('keeps two entries with the same time and seq from different gateway processes (the ID tells them apart)', () => {
    const fetched = [e('p2-0', '2026-11-11T10:00:01.000Z', 2)];
    expect(ids(mergeNewEntries(shown, fetched, 'newestLast', 10))).toEqual(['a', 'b', 'p2-0']);
  });

  it('places an entry that arrives late, with a time before the newest shown, at its place in time', () => {
    const now = [...shown, e('d', '2026-11-11T10:00:05.000Z', 9)];
    const late = e('late', '2026-11-11T10:00:01.500Z', 1);
    expect(ids(mergeNewEntries(now, [late], 'newestLast', 10))).toEqual(['a', 'b', 'late', 'd']);
    expect(ids(mergeNewEntries([...now].reverse(), [late], 'newestFirst', 10))).toEqual(['d', 'late', 'b', 'a']);
  });

  it('sorts by time, then seq as an integer (Edm.Int64 arrives as text), then ID', () => {
    const t = '2026-11-11T10:00:00.000Z';
    const fetched = [e('z', t, '10'), e('y', t, '9'), e('x', t, '10')];
    expect(ids(mergeNewEntries([], fetched, 'newestLast', 10))).toEqual(['y', 'x', 'z']);
    expect(compareEntries(e('a', t, '9007199254740993'), e('b', t, '9007199254740992'))).toBeGreaterThan(0);
  });

  it('keeps the newest entries when the list grows beyond the limit, dropping the oldest at the top for newest last', () => {
    const fetched = [e('c', '2026-11-11T10:00:02.000Z', 3), e('d', '2026-11-11T10:00:03.000Z', 4)];
    expect(ids(mergeNewEntries(shown, fetched, 'newestLast', 3))).toEqual(['b', 'c', 'd']);
    expect(ids(mergeNewEntries([...shown].reverse(), fetched, 'newestFirst', 3))).toEqual(['d', 'c', 'b']);
  });

  it('the default limit is 2,000 rows', () => {
    expect(DEFAULT_LIMIT).toBe(2000);
  });
});

describe('mergeEntries', () => {
  it('counts what was added and what was dropped from the view', () => {
    const shown = [e('a', '2026-11-11T10:00:00.000Z'), e('b', '2026-11-11T10:00:01.000Z')];
    const fetched = [e('b', '2026-11-11T10:00:01.000Z'), e('c', '2026-11-11T10:00:02.000Z'), e('d', '2026-11-11T10:00:03.000Z')];
    const result = mergeEntries(shown, fetched, 'newestLast', 3);
    expect(ids(result.entries)).toEqual(['b', 'c', 'd']);
    expect(result).toMatchObject({ added: 2, dropped: 1 });
  });

  it('does not count an added entry that is older than everything the limit keeps as added', () => {
    const shown = [e('b', '2026-11-11T10:00:01.000Z'), e('c', '2026-11-11T10:00:02.000Z')];
    const result = mergeEntries(shown, [e('old', '2026-11-11T09:00:00.000Z')], 'newestLast', 2);
    expect(ids(result.entries)).toEqual(['b', 'c']);
    expect(result).toMatchObject({ added: 0, dropped: 1 });
  });
});

describe('nextPollCursor', () => {
  const stored = (ID: string, loggedAt: string, storedAt: string | null): Entry => ({ ID, loggedAt, seq: '0', storedAt });

  it('is the admin\'s time of the read (the Date header) minus the overlap', () => {
    expect(POLL_OVERLAP_MS).toBe(5000);
    const read = { ok: true, serverDate: 'Wed, 11 Nov 2026 10:00:09 GMT', entries: [stored('a', '2026-11-11T09:00:00.000Z', '2026-11-11T10:00:20.000Z')] };
    expect(nextPollCursor(null, read)).toBe('2026-11-11T10:00:04.000Z');
    expect(nextPollCursor('2026-11-11T09:59:00.000Z', read)).toBe('2026-11-11T10:00:04.000Z');
  });

  it('advances also when the read found nothing', () => {
    expect(nextPollCursor('2026-11-11T09:59:00.000Z', { ok: true, serverDate: 'Wed, 11 Nov 2026 10:00:09 GMT', entries: [] })).toBe('2026-11-11T10:00:04.000Z');
  });

  it('without a Date header: the greatest storedAt of the rows read, minus the overlap', () => {
    const entries = [stored('a', '2026-11-11T10:00:30.000Z', '2026-11-11T10:00:01.000Z'), stored('b', '2026-11-11T09:00:00.000Z', '2026-11-11T10:00:07.500Z'), stored('c', '2026-11-11T10:00:00.000Z', null)];
    expect(nextPollCursor(null, { ok: true, serverDate: null, entries })).toBe('2026-11-11T10:00:02.500Z');
    expect(nextPollCursor(null, { ok: true, serverDate: 'not a date', entries })).toBe('2026-11-11T10:00:02.500Z');
  });

  it('without a Date header and without rows: keeps the previous cursor (none before the first poll)', () => {
    expect(nextPollCursor('2026-11-11T09:59:00.000Z', { ok: true, entries: [] })).toBe('2026-11-11T09:59:00.000Z');
    expect(nextPollCursor(null, { ok: true, entries: [] })).toBeNull();
  });

  it('a failed read keeps the previous cursor', () => {
    expect(nextPollCursor('2026-11-11T09:59:00.000Z', { ok: false, serverDate: 'Wed, 11 Nov 2026 10:00:09 GMT', entries: [] })).toBe('2026-11-11T09:59:00.000Z');
    expect(nextPollCursor(null, { ok: false })).toBeNull();
  });

  it('a poll fetches an entry with an old loggedAt but a new storedAt, and it lands at its place in time', () => {
    const shown = [e('a', '2026-11-11T10:00:00.000Z'), e('b', '2026-11-11T10:00:10.000Z')];
    const cursor = nextPollCursor(null, { ok: true, serverDate: 'Wed, 11 Nov 2026 10:00:11 GMT', entries: shown })!;
    // written a minute earlier by a second gateway, stored only now
    const late = stored('late', '2026-11-11T09:59:05.000Z', '2026-11-11T10:00:12.000Z');
    expect(Date.parse(late.storedAt as string)).toBeGreaterThan(Date.parse(cursor));
    expect(ids(mergeNewEntries(shown, [late], 'newestLast', 10))).toEqual(['late', 'a', 'b']);
  });
});

describe('pollWasCut', () => {
  it('is true when a poll returned as many rows as it asked for: older new entries were cut off', () => {
    expect(pollWasCut(2000, 2000)).toBe(true);
    expect(pollWasCut(1999, 2000)).toBe(false);
    expect(pollWasCut(0, 2000)).toBe(false);
  });
});

describe('merging seq beyond 2^53', () => {
  it('orders 9007199254740993 after 9007199254740992 (Int64 kept as text, compared as an integer)', () => {
    const t = '2026-11-11T10:00:00.000Z';
    expect(ids(mergeNewEntries([e('b', t, '9007199254740993')], [e('a', t, '9007199254740992')], 'newestLast', 10))).toEqual(['a', 'b']);
  });
});

describe('anchoredFirstRow', () => {
  const list = (n: number, from = 0) => Array.from({ length: n }, (_, i) => e(`id${from + i}`, new Date(Date.UTC(2026, 10, 11, 10, 0, from + i)).toISOString()));

  it('keeps the same entry at the top when the limit drops rows above it', () => {
    const before = list(10);          // id0..id9, the reader looks at id4 on top
    const after = list(10, 3);        // id3..id12: three dropped at the top, three added below
    expect(anchoredFirstRow(before, 4, after)).toBe(1);
    expect(after[1].ID).toBe('id4');
  });

  it('moves down by the rows inserted above it (a late entry, or new rows on top for newest first)', () => {
    const before = list(5);
    const after = [e('new', '2026-11-11T11:00:00.000Z'), ...before];
    expect(anchoredFirstRow(before, 2, after)).toBe(3);
  });

  it('goes to the top when the entry itself was dropped, and leaves 0 alone', () => {
    expect(anchoredFirstRow(list(10), 1, list(10, 5))).toBe(0);
    expect(anchoredFirstRow(list(3), 0, list(3))).toBe(0);
    expect(anchoredFirstRow([], 0, list(3))).toBe(0);
  });
});
