/**
 * Display formatting for the Grounding screens. No UI5 imports: these run under jest. The
 * controllers pass the cockpit language as `locale`; jest passes none and gets 'en-US'.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** toFixed's digits with the locale's decimal sign, so English stays byte-identical to toFixed. */
export function fixed(value: number, digits: number, locale: string): string {
  const sign = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.';
  return value.toFixed(digits).replace('.', sign);
}

export function formatBytes(bytes: number | string | null | undefined, locale = 'en-US'): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const unit = Math.min(UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / Math.pow(1024, unit);
  return `${unit === 0 ? scaled.toFixed(0) : fixed(scaled, 1, locale)} ${UNITS[unit]}`;
}

/** A Unix timestamp in seconds as a short date and time. UTC, so every viewer reads the same text. */
export function formatUnixSeconds(seconds: number | null | undefined, locale = 'en-US'): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Date(value * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
}
