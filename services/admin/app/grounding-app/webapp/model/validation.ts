/** Input rules for the Grounding dialogs. No UI5 imports: these run under jest. */

export function storeNameProblem(name: string): 'empty' | null {
  return name.trim() === '' ? 'empty' : null;
}

/** An empty value means "no expiry" (null); otherwise whole days, 1 to 365. */
export function parseExpiryDays(raw: string): { ok: true; days: number | null } | { ok: false } {
  const text = raw.trim();
  if (text === '') return { ok: true, days: null };
  if (!/^\d{1,3}$/.test(text)) return { ok: false };
  const days = Number(text);
  return days >= 1 && days <= 365 ? { ok: true, days } : { ok: false };
}
