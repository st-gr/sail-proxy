export {};
import { dayStart, isoWeekStart, monthStart, nextResets } from '../../../src/services/quotaWindows';

const at = (s: string) => new Date(s);

describe('calendar UTC windows', () => {
  it('day and month start at 00:00 UTC', () => {
    expect(dayStart(at('2026-09-07T23:59:59Z')).toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(monthStart(at('2026-09-07T10:00:00Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
  it('the ISO week starts on Monday 00:00 UTC, also across a month boundary and on a Sunday', () => {
    expect(isoWeekStart(at('2026-09-07T10:00:00Z')).toISOString()).toBe('2026-09-07T00:00:00.000Z');   // a Monday
    expect(isoWeekStart(at('2026-09-06T10:00:00Z')).toISOString()).toBe('2026-08-31T00:00:00.000Z');   // a Sunday
    expect(isoWeekStart(at('2026-09-02T00:00:00Z')).toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });
  it('next resets are the following window starts', () => {
    expect(nextResets(at('2026-12-31T12:00:00Z'))).toEqual({ day: at('2027-01-01T00:00:00Z'), week: at('2027-01-04T00:00:00Z'), month: at('2027-01-01T00:00:00Z') });
  });
});
