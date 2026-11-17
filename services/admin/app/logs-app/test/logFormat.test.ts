import { decorate, formatLoggedAt, formatToMinute, isAtBottom, levelState } from '../webapp/model/logFormat';

describe('formatLoggedAt', () => {
  const at = '2026-11-11T22:05:01.007Z';

  it('shows the date and the time with seconds and milliseconds, in the given zone', () => {
    expect(formatLoggedAt(at, 'de-DE', 'Europe/Berlin')).toBe('11.11.2026, 23:05:01,007');
    expect(formatLoggedAt(at, 'en-US', 'America/New_York')).toBe('11/11/2026, 17:05:01.007');
  });

  it('shows the date of the zone, which can be the next day', () => {
    expect(formatLoggedAt(at, 'en-GB', 'Asia/Tokyo')).toBe('12/11/2026, 07:05:01.007');
  });

  it('shows text it cannot read as it came', () => {
    expect(formatLoggedAt('not a time', 'en-US', 'Europe/Berlin')).toBe('not a time');
  });

  it('falls back to English for a language tag Intl does not know', () => {
    expect(formatLoggedAt(at, 'xx-invalid-!!', 'UTC')).toBe('11/11/2026, 22:05:01.007');
  });
});

describe('levelState', () => {
  it('gives the level a semantic state, never a colour', () => {
    expect(levelState('ERROR')).toBe('Error');
    expect(levelState('WARN')).toBe('Warning');
    expect(levelState('INFO')).toBe('Information');
    expect(levelState('DEBUG')).toBe('None');
    expect(levelState('TRACE')).toBe('None');
    expect(levelState(undefined)).toBe('None');
  });
});

describe('decorate', () => {
  it('adds what a row shows: the time text, the level state and the message with its error', () => {
    const row = decorate({ ID: 'x-0', loggedAt: '2026-11-11T10:00:00.000Z', seq: '1', level: 'ERROR', component: 'ConfigService', requestId: 'req-1', message: 'Reload failed', error: 'ENOENT' }, 'en-GB', 'UTC');
    expect(row).toMatchObject({ ID: 'x-0', timeText: '11/11/2026, 10:00:00.000', levelState: 'Error', messageText: 'Reload failed - ENOENT', requestId: 'req-1' });
  });

  it('a row without an error or request id shows the message alone and an empty request id', () => {
    const row = decorate({ ID: 'x-1', loggedAt: '2026-11-11T10:00:00.000Z', seq: '2', level: 'INFO', component: 'Server', requestId: null, message: 'Started', error: null }, 'en-GB', 'UTC');
    expect(row.messageText).toBe('Started');
    expect(row.requestId).toBe('');
  });
});

describe('isAtBottom', () => {
  it('is true while the last row is visible', () => {
    expect(isAtBottom(80, 20, 100)).toBe(true);
    expect(isAtBottom(81, 20, 100)).toBe(true);
    expect(isAtBottom(0, 20, 10)).toBe(true);
    expect(isAtBottom(0, 20, 0)).toBe(true);
  });

  it('is false once the person has scrolled up', () => {
    expect(isAtBottom(79, 20, 100)).toBe(false);
    expect(isAtBottom(0, 20, 100)).toBe(false);
  });
});

describe('formatToMinute', () => {
  it('shows a date and hours and minutes, without seconds, in the zone', () => {
    expect(formatToMinute('2026-11-11T22:05:59.999Z', 'de-DE', 'Europe/Berlin')).toBe('11.11.2026, 23:05');
    expect(formatToMinute('2026-11-11T22:05:01.007Z', 'en-GB', 'Asia/Tokyo')).toBe('12/11/2026, 07:05');
    expect(formatToMinute('later', 'en-GB', 'UTC')).toBe('later');
  });
});
