/**
 * UI.CriticalityType for a quota window, from the same thresholds the shell's quota card uses
 * (app/shell/webapp/model/quotaDisplay.ts): positive below 75 %, critical from 75 %, negative
 * from 90 %; neutral when there is no limit. Both modules pin the constants in their unit tests.
 */
export const WARN_PERCENT = 75;
export const ERROR_PERCENT = 90;

export function criticality(used: number | null | undefined, limit: number | null | undefined): 0 | 1 | 2 | 3 {
  if (limit === null || limit === undefined) return 0;
  const u = Number(used) || 0;
  const pct = limit <= 0 ? 100 : (u / limit) * 100;
  return pct >= ERROR_PERCENT ? 1 : pct >= WARN_PERCENT ? 2 : 3;
}
