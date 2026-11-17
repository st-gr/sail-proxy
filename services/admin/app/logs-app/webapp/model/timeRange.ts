/**
 * Local date and time in a named IANA time zone, to and from UTC instants. No UI5 imports: the
 * controller passes the cockpit's time zone (sap/base/i18n/Localization.getTimezone(), the browser's
 * unless the URL sets sap-timezone), and jest passes fixed zones.
 *
 * A local time is text like "2026-11-11 11:30", "2026-11-11 11:30:15" or "2026-11-11T11:30:15".
 */

export type QuickRangeKind = 'last15' | 'lastHour' | 'today';
export interface UtcRange { from: string; to: string }
export interface QuickRange extends UtcRange { fromLocal: string; toLocal: string }

const DAY_MS = 86_400_000;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The local wall clock of an instant, as if it were UTC (milliseconds kept). */
function wallOf(utcMs: number, timeZone: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(whole))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) + (utcMs - whole);
}

const offsetAt = (utcMs: number, timeZone: string): number => wallOf(utcMs, timeZone) - utcMs;

function parseLocal(text: string): number {
  const m = LOCAL.exec(String(text ?? '').trim());
  if (!m) throw new RangeError(`Not a local date and time: ${text}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(wall);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) throw new RangeError(`Not a local date and time: ${text}`);
  return wall;
}

/**
 * The UTC instant of a local time. Twice a year a local time is not one instant:
 * - In the hour the clocks go back (Berlin, last Sunday of October, 02:00 to 02:59 happens twice) a
 *   local time names two instants; `prefer` picks the first pass ('earlier', summer time) or the
 *   second ('later', winter time).
 * - In the hour the clocks skip (Berlin, last Sunday of March, 02:00 to 02:59 does not exist) it names
 *   none; it is read with the offset in force before the change, so 02:30 becomes 03:30 summer time.
 */
export function localToUtc(local: string, timeZone: string, prefer: 'earlier' | 'later'): number {
  const wall = parseLocal(local);
  const offsets = new Set([offsetAt(wall - DAY_MS, timeZone), offsetAt(wall, timeZone), offsetAt(wall + DAY_MS, timeZone)]);
  const instants = [...offsets].map((o) => wall - o).filter((t) => wallOf(t, timeZone) === wall).sort((a, b) => a - b);
  if (instants.length === 0) return wall - offsetAt(wall - DAY_MS, timeZone);
  return prefer === 'earlier' ? instants[0] : instants[instants.length - 1];
}

/**
 * The time filter for "from … to …" in local time, as UTC ISO strings, both included. In the autumn
 * hour that happens twice, "from" means its first pass and "to" its second, so a range such as
 * 02:30 to 02:45 on that night covers both passes: a log search would rather show too much than miss
 * the entry that was looked for. An empty text leaves that end open (''). Throws a RangeError for
 * other text that is not a local date and time.
 */
export function rangeFilter(fromLocal: string, toLocal: string, timeZone: string): UtcRange {
  const end = (text: string, prefer: 'earlier' | 'later') =>
    String(text ?? '').trim() ? new Date(localToUtc(text, timeZone, prefer)).toISOString() : '';
  return { from: end(fromLocal, 'earlier'), to: end(toLocal, 'later') };
}

export type PickerRange = { kind: 'none' } | { kind: 'error'; key: 'rangeInvalid' | 'rangeOrder' } | { kind: 'range'; range: UtcRange };

/** The page's from and to pickers: no range when both are empty, else a range or the text key of what is wrong. */
export function rangeFromPickers(fromLocal: string, toLocal: string, timeZone: string): PickerRange {
  if (!String(fromLocal ?? '').trim() && !String(toLocal ?? '').trim()) return { kind: 'none' };
  let range: UtcRange;
  try {
    range = rangeFilter(fromLocal, toLocal, timeZone);
  } catch (error) {
    return { kind: 'error', key: 'rangeInvalid' };
  }
  if (range.from && range.to && range.from > range.to) return { kind: 'error', key: 'rangeOrder' };
  return { kind: 'range', range };
}

const two = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:mm:ss" in the zone: the value format of the page's date-time pickers. */
export function wallClockText(utcMs: number, timeZone: string): string {
  const w = new Date(wallOf(utcMs, timeZone));
  return `${w.getUTCFullYear()}-${two(w.getUTCMonth() + 1)}-${two(w.getUTCDate())} ${two(w.getUTCHours())}:${two(w.getUTCMinutes())}:${two(w.getUTCSeconds())}`;
}

/** The quick buttons: the last 15 minutes, the last hour, or today from local midnight; all end now. */
export function quickRange(kind: QuickRangeKind, now: Date, timeZone: string): QuickRange {
  const end = now.getTime();
  let start: number;
  if (kind === 'last15') start = end - 15 * 60_000;
  else if (kind === 'lastHour') start = end - 60 * 60_000;
  else start = localToUtc(`${wallClockText(end, timeZone).slice(0, 10)} 00:00:00`, timeZone, 'earlier');
  return {
    from: new Date(start).toISOString(), to: new Date(end).toISOString(),
    fromLocal: wallClockText(start, timeZone), toLocal: wallClockText(end, timeZone)
  };
}
