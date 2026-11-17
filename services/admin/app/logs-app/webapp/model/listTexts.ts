/**
 * The count and empty-list texts of the Logs app's lists. No UI5 imports: the controllers pass the
 * bundle's translator and a number formatter.
 */
import type { Translator } from './api';

/** "1 trace shown" or "{n} traces shown": the singular key for exactly one, the formatted number first. */
export function countText(n: number, oneKey: string, manyKey: string, t: Translator, format: (n: number) => string,
  more: (string | number)[] = []): string {
  return t(n === 1 ? oneKey : manyKey, [format(n), ...more]);
}

/** An empty list: nothing in the time range, or nothing that matches the applied search or level. */
export function emptyListText(filtered: boolean, plainKey: string, filteredKey: string, t: Translator): string {
  return t(filtered ? filteredKey : plainKey);
}
