export interface PollOptions { wait: (ms: number) => Promise<void>; intervalSeconds: number; timeoutSeconds: number; }
export interface PollResult { status: string; elapsedSeconds: number; outcome: 'running' | 'failed' | 'timeout'; }

export const defaultWait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const DEFAULT_OPTIONS: PollOptions = { wait: defaultWait, intervalSeconds: 5, timeoutSeconds: 300 };

/**
 * Mirrors cli-tools/sail-model-deploy.js: poll every intervalSeconds, up to timeoutSeconds total,
 * stopping on RUNNING (success), DEAD/STOPPED (failure) or the timeout. A transient read error
 * (network blip, gateway hiccup) does not abort the poll — it is swallowed and retried on the
 * next tick, so the loop only ever ends on a real status or the timeout.
 */
export async function pollUntilSettled(getStatus: () => Promise<string>, opts: PollOptions = DEFAULT_OPTIONS): Promise<PollResult> {
  let elapsed = 0;
  let last = 'UNKNOWN';
  for (;;) {
    try { last = (await getStatus()) || 'UNKNOWN'; } catch { /* transient: keep polling */ }
    if (last === 'RUNNING') return { status: last, elapsedSeconds: elapsed, outcome: 'running' };
    if (last === 'DEAD' || last === 'STOPPED') return { status: last, elapsedSeconds: elapsed, outcome: 'failed' };
    if (elapsed >= opts.timeoutSeconds) return { status: last, elapsedSeconds: elapsed, outcome: 'timeout' };
    await opts.wait(opts.intervalSeconds * 1000);
    elapsed += opts.intervalSeconds;
  }
}

export function messageFor(r: PollResult): string {
  if (r.outcome === 'running') return 'Deployment is now RUNNING';
  if (r.outcome === 'failed') return `Deployment failed with status: ${r.status}`;
  return `Timeout reached after ${r.elapsedSeconds} seconds. Last known status: ${r.status}`;
}
