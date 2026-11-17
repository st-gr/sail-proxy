/**
 * What a row of the Gateway Log shows. No UI5 imports, so it runs under jest.
 */
import type { Entry } from './liveLog';

export type ValueState = 'Error' | 'Warning' | 'Information' | 'None';

export interface Row extends Entry {
  timeText: string;
  levelState: ValueState;
  messageText: string;
  requestId: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
// fractionalSecondDigits is ES2021; the app's tsconfig types stop at ES2020, the browsers have it.
const OPTIONS: Intl.DateTimeFormatOptions & { fractionalSecondDigits?: 1 | 2 | 3 } = {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  fractionalSecondDigits: 3, hourCycle: 'h23'
};

function formatter(locale: string, timeZone: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...OPTIONS, timeZone });
    } catch (error) {
      f = new Intl.DateTimeFormat('en-US', { ...OPTIONS, timeZone });
    }
    formatters.set(key, f);
  }
  return f;
}

/** The date and the time with seconds and milliseconds, in the zone, in the locale's date format. */
export function formatLoggedAt(loggedAt: string, locale: string, timeZone: string): string {
  const at = Date.parse(loggedAt);
  return Number.isNaN(at) ? String(loggedAt) : formatter(locale, timeZone).format(new Date(at));
}

const minuteFormatters = new Map<string, Intl.DateTimeFormat>();

/** A date and hours:minutes in the zone, for when a time limit ends (seconds would be noise there). */
export function formatToMinute(iso: string, locale: string, timeZone: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return String(iso);
  const key = `${locale}|${timeZone}`;
  let f = minuteFormatters.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone };
    try { f = new Intl.DateTimeFormat(locale, options); } catch (error) { f = new Intl.DateTimeFormat('en-US', options); }
    minuteFormatters.set(key, f);
  }
  return f.format(new Date(at));
}

/** A semantic state for the level, so the theme picks a colour that reads in light and dark. */
export function levelState(level: unknown): ValueState {
  switch (String(level ?? '').toUpperCase()) {
    case 'ERROR': return 'Error';
    case 'WARN': return 'Warning';
    case 'INFO': return 'Information';
    default: return 'None';
  }
}

export function decorate(entry: Entry, locale: string, timeZone: string): Row {
  const message = String(entry.message ?? '');
  const error = entry.error ? String(entry.error) : '';
  return {
    ...entry,
    timeText: formatLoggedAt(entry.loggedAt, locale, timeZone),
    levelState: levelState(entry.level),
    messageText: error ? `${message} - ${error}` : message,
    requestId: entry.requestId ? String(entry.requestId) : ''
  };
}

/** Whether the last row is in view: following goes on while it is, and pauses once the person scrolls up. */
export function isAtBottom(firstVisibleRow: number, visibleRows: number, length: number): boolean {
  return firstVisibleRow + visibleRows >= length;
}
