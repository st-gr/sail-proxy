/**
 * The inventory's lastSeen is an untyped max() aggregate: SQLite hands back the stored ISO string,
 * PostgreSQL a zone-less timestamp ('2026-09-17T16:08:48' or '2026-09-17 16:08:48.123') that a browser
 * would read as local time. CAP stores timestamps in UTC, so a value without an offset is UTC.
 */
import { asUtcIso } from '../../../src/srv/admin-service-tool-policies';

describe('asUtcIso', () => {
  it('marks a zone-less PostgreSQL timestamp as UTC', () => {
    expect(asUtcIso('2026-09-17T16:08:48')).toBe('2026-09-17T16:08:48.000Z');
    expect(asUtcIso('2026-09-17 16:08:48.123')).toBe('2026-09-17T16:08:48.123Z');
  });
  it('keeps a value that already carries a zone, normalised to UTC', () => {
    expect(asUtcIso('2026-09-17T16:08:48.000Z')).toBe('2026-09-17T16:08:48.000Z');
    expect(asUtcIso('2026-09-17T18:08:48+02:00')).toBe('2026-09-17T16:08:48.000Z');
  });
  it('accepts a Date and passes empty or unparsable values through', () => {
    expect(asUtcIso(new Date('2026-09-17T16:08:48Z'))).toBe('2026-09-17T16:08:48.000Z');
    expect(asUtcIso(null)).toBeNull();
    expect(asUtcIso(undefined)).toBeNull();
    expect(asUtcIso('not a date')).toBe('not a date');
  });
});
