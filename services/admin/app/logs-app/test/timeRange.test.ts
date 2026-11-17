import { localToUtc, quickRange, rangeFilter, rangeFromPickers, wallClockText } from '../webapp/model/timeRange';

const HOUR = 3_600_000;
const span = (r: { from: string; to: string }) => Date.parse(r.to) - Date.parse(r.from);

describe('rangeFilter', () => {
  it('spans one hour, not two, across the spring change (02:00 to 03:00 does not exist in Berlin)', () => {
    const r = rangeFilter('2026-03-29 01:30', '2026-03-29 03:30', 'Europe/Berlin');
    expect(r).toEqual({ from: '2026-03-29T00:30:00.000Z', to: '2026-03-29T01:30:00.000Z' });
    expect(span(r)).toBe(HOUR);
  });

  it('takes "from 11:30 to 12:30" in the given zone, in winter and in summer', () => {
    expect(rangeFilter('2026-11-11 11:30', '2026-11-11 12:30', 'Europe/Berlin'))
      .toEqual({ from: '2026-11-11T10:30:00.000Z', to: '2026-11-11T11:30:00.000Z' });
    expect(rangeFilter('2026-07-01 11:30', '2026-07-01 12:30', 'Europe/Berlin'))
      .toEqual({ from: '2026-07-01T09:30:00.000Z', to: '2026-07-01T10:30:00.000Z' });
    expect(rangeFilter('2026-07-01 11:30:15', '2026-07-01T12:30:45', 'America/New_York'))
      .toEqual({ from: '2026-07-01T15:30:15.000Z', to: '2026-07-01T16:30:45.000Z' });
  });

  it('in the autumn hour that happens twice, "from" is its first pass and "to" its second, so the range covers both', () => {
    // 2026-10-25 in Berlin: 02:00-02:59 CEST (00:00Z-00:59Z), then again 02:00-02:59 CET (01:00Z-01:59Z).
    const r = rangeFilter('2026-10-25 02:30', '2026-10-25 02:45', 'Europe/Berlin');
    expect(r).toEqual({ from: '2026-10-25T00:30:00.000Z', to: '2026-10-25T01:45:00.000Z' });
    expect(span(rangeFilter('2026-10-25 01:30', '2026-10-25 03:30', 'Europe/Berlin'))).toBe(3 * HOUR);
  });

  it('leaves an end open when its text is empty', () => {
    expect(rangeFilter('2026-11-11 11:30', '', 'Europe/Berlin')).toEqual({ from: '2026-11-11T10:30:00.000Z', to: '' });
    expect(rangeFilter(' ', '2026-11-11 12:30', 'Europe/Berlin')).toEqual({ from: '', to: '2026-11-11T11:30:00.000Z' });
  });

  it('refuses text that is not a date and time', () => {
    expect(() => rangeFilter('yesterday', '2026-11-11 12:00', 'Europe/Berlin')).toThrow(RangeError);
    expect(() => rangeFilter('2026-11-11 12:00', '2026-13-01 12:00', 'Europe/Berlin')).toThrow(RangeError);
  });
});

describe('localToUtc', () => {
  it('names both instants of an hour that happens twice', () => {
    expect(new Date(localToUtc('2026-10-25 02:30', 'Europe/Berlin', 'earlier')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(new Date(localToUtc('2026-10-25 02:30', 'Europe/Berlin', 'later')).toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });

  it('reads a time in the skipped spring hour with the offset before the change (02:30 is 03:30 summer time)', () => {
    expect(new Date(localToUtc('2026-03-29 02:30', 'Europe/Berlin', 'earlier')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('quickRange', () => {
  const now = new Date('2026-11-11T11:47:12.345Z');

  it('"today" starts at local midnight and ends now', () => {
    expect(quickRange('today', now, 'Europe/Berlin')).toEqual({
      from: '2026-11-10T23:00:00.000Z', to: '2026-11-11T11:47:12.345Z',
      fromLocal: '2026-11-11 00:00:00', toLocal: '2026-11-11 12:47:12'
    });
    // In Tokyo it is already 20:47 on the 11th; in Los Angeles it is 03:47 on the 11th.
    expect(quickRange('today', now, 'Asia/Tokyo').from).toBe('2026-11-10T15:00:00.000Z');
    expect(quickRange('today', now, 'America/Los_Angeles').from).toBe('2026-11-11T08:00:00.000Z');
  });

  it('"today" on the day of the spring change starts at that day\'s midnight (still winter time)', () => {
    expect(quickRange('today', new Date('2026-03-29T10:00:00.000Z'), 'Europe/Berlin').from).toBe('2026-03-28T23:00:00.000Z');
  });

  it('the last 15 minutes and the last hour end now', () => {
    expect(quickRange('last15', now, 'Europe/Berlin')).toEqual({
      from: '2026-11-11T11:32:12.345Z', to: '2026-11-11T11:47:12.345Z',
      fromLocal: '2026-11-11 12:32:12', toLocal: '2026-11-11 12:47:12'
    });
    expect(span(quickRange('lastHour', now, 'Europe/Berlin'))).toBe(HOUR);
  });
});

describe('wallClockText', () => {
  it('is the local date and time the pickers show', () => {
    expect(wallClockText(Date.parse('2026-07-01T09:30:05.900Z'), 'Europe/Berlin')).toBe('2026-07-01 11:30:05');
  });
});

describe('rangeFromPickers', () => {
  it('two empty pickers mean no range (back to Live)', () => {
    expect(rangeFromPickers('', ' ', 'Europe/Berlin')).toEqual({ kind: 'none' });
  });

  it('a range with one end open is a range', () => {
    expect(rangeFromPickers('2026-11-11 11:30:00', '', 'Europe/Berlin')).toEqual({ kind: 'range', range: { from: '2026-11-11T10:30:00.000Z', to: '' } });
  });

  it('text that is not a date and time, or a start after the end, is an error with its text key', () => {
    expect(rangeFromPickers('noon', '', 'Europe/Berlin')).toEqual({ kind: 'error', key: 'rangeInvalid' });
    expect(rangeFromPickers('2026-11-11 12:30:00', '2026-11-11 11:30:00', 'Europe/Berlin')).toEqual({ kind: 'error', key: 'rangeOrder' });
  });
});
