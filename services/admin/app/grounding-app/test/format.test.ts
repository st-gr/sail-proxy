import { formatBytes, formatUnixSeconds } from '../webapp/model/format';

describe('formatBytes', () => {
  it('uses the largest unit that keeps the number at one or more', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(33554432)).toBe('32.0 MB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
  it('reads nothing, a negative number and a non-number as zero', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes('abc' as any)).toBe('0 B');
  });
  it('accepts the numeric strings a Postgres bigint arrives as', () => {
    expect(formatBytes('2048' as any)).toBe('2.0 KB');
  });
});

describe('formatUnixSeconds', () => {
  it('formats a Unix timestamp in seconds, in UTC so the text does not depend on the machine', () => {
    expect(formatUnixSeconds(1767225600).replace(/\s/g, ' ')).toBe('Jan 1, 2026, 12:00 AM');
  });
  it('is empty for nothing and for zero', () => {
    expect(formatUnixSeconds(null)).toBe('');
    expect(formatUnixSeconds(undefined)).toBe('');
    expect(formatUnixSeconds(0)).toBe('');
  });
});

describe('the cockpit language', () => {
  it('formats sizes and dates in the locale the controller passes, still in UTC', () => {
    expect(formatBytes(1536, 'de')).toBe('1,5 KB');
    expect(formatBytes(512, 'de')).toBe('512 B');
    expect(formatUnixSeconds(1767225600, 'de').replace(/\s/g, ' ')).toBe('01.01.2026, 00:00');
  });
  it('keeps English byte-identical for the UI5 tag "en"', () => {
    expect(formatBytes(1536, 'en')).toBe(formatBytes(1536));
    expect(formatUnixSeconds(1767225600, 'en')).toBe(formatUnixSeconds(1767225600));
  });
});
