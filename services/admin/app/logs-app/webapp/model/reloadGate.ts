/**
 * Which reload of the Gateway Log owns the page. A newer reload supersedes an older one: the older
 * one's answer is dropped and only the newest reload clears the busy flag, on every way out (answer,
 * failure). Switching Live off does not touch the gate, so a reload in flight still shows its rows;
 * leaving the app invalidates it. A poll takes current() before its fetch and merges only while that
 * is still the latest. No UI5 imports.
 */

export interface ReloadGate {
  begin(): number;
  current(): number;
  isLatest(token: number): boolean;
  invalidate(): void;
}

export function createReloadGate(): ReloadGate {
  let latest = 0;
  return {
    begin: () => ++latest,
    current: () => latest,
    isLatest: (token) => token === latest,
    invalidate: () => { latest++; }
  };
}

/** Runs one reload: true when its answer was applied, false when a newer reload or an exit came first. */
export async function runReload<T>(gate: ReloadGate, fetch: () => Promise<T>, apply: (answer: T) => void, setBusy: (busy: boolean) => void): Promise<boolean> {
  const token = gate.begin();
  setBusy(true);
  try {
    const answer = await fetch();
    if (!gate.isLatest(token)) return false;
    apply(answer);
    return true;
  } finally {
    // The newest reload owns the flag: an older one ending leaves it to the one still running.
    if (gate.isLatest(token)) setBusy(false);
  }
}
