/** Calendar UTC windows (spec §1): day, ISO week (Monday 00:00 UTC), month, and their next starts. */
export type WindowName = 'day' | 'week' | 'month';

export function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
export function isoWeekStart(now: Date): Date {
  const d = dayStart(now);
  const sinceMonday = (d.getUTCDay() + 6) % 7;      // Sunday = 6 days after Monday
  return new Date(d.getTime() - sinceMonday * 86_400_000);
}
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function windowStarts(now: Date): Record<WindowName, Date> {
  return { day: dayStart(now), week: isoWeekStart(now), month: monthStart(now) };
}
export function nextResets(now: Date): Record<WindowName, Date> {
  const s = windowStarts(now);
  return {
    day: new Date(s.day.getTime() + 86_400_000),
    week: new Date(s.week.getTime() + 7 * 86_400_000),
    month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  };
}
