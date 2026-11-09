import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { compareVersions } from './version';
import { getConfigDir } from './paths';

const NAME = '@st-gr/sail-proxy';
const DAY_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 3000;

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface UpdateHintOptions {
  current: string;
  now?: number | Date;
  configDir?: string;
  fetch?: FetchLike;
}

const defaultFetch: FetchLike = (url) =>
  (globalThis as any).fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });

const FAIL_RETRY_MS = 6 * 3600 * 1000;

/** undefined = ask the registry; null = a recent attempt failed; string = cached latest version. */
function readCache(file: string, now: number): string | null | undefined {
  try {
    const c = JSON.parse(readFileSync(file, 'utf-8'));
    if (typeof c.checkedAt !== 'number') return undefined;
    const age = now - c.checkedAt;
    if (typeof c.latest === 'string' && age >= 0 && age < DAY_MS) return c.latest;
    if (c.latest === undefined && c.failed === true && age >= 0 && age < FAIL_RETRY_MS) return null;
  } catch { /* no or broken cache: look again */ }
  return undefined;
}

function writeCache(configDir: string, file: string, data: object): void {
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  } catch { /* cache is optional */ }
}

/**
 * One line telling that a newer version exists, or null. Asks the npm registry at most once a day
 * (cached in <configDir>/update-check.json), gives up after 3 s, and never throws: offline, a 404
 * or an unwritable folder all just mean "no hint". SAIL_PROXY_UPDATE_CHECK=false switches it off.
 */
export async function updateHint(opts: UpdateHintOptions): Promise<string | null> {
  try {
    if (process.env.SAIL_PROXY_UPDATE_CHECK === 'false') return null;
    const now = opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now());
    const configDir = opts.configDir ?? getConfigDir();
    const file = join(configDir, 'update-check.json');

    let latest = readCache(file, now);
    if (latest === null) return null;
    if (latest === undefined) {
      try {
        const res = await (opts.fetch ?? defaultFetch)(`https://registry.npmjs.org/${NAME}/latest`);
        const body = res.ok ? await res.json() : null;
        if (!body || typeof body.version !== 'string') throw new Error('no version');
        latest = body.version as string;
        writeCache(configDir, file, { checkedAt: now, latest });
      } catch {
        // Remember the failure so an offline machine pays the timeout once per 6 h, not per command.
        writeCache(configDir, file, { checkedAt: now, failed: true });
        return null;
      }
    }
    if (compareVersions(latest, opts.current) <= 0) return null;
    return `Update available: ${opts.current} -> ${latest}. Run "sail-proxy update" to install it.`;
  } catch {
    return null;
  }
}

/** The hint for the installed version, read from this package's package.json. */
export function checkUpdateHint(extra: Partial<UpdateHintOptions> = {}): Promise<string | null> {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return updateHint({ current: pkg.version, ...extra });
  } catch {
    return Promise.resolve(null);
  }
}

/** The hint if it resolves within graceMs, else null: startup output never waits for the registry. */
export function hintWithGrace(hint: Promise<string | null>, graceMs = 200): Promise<string | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), graceMs);
    hint.then((h) => { clearTimeout(t); resolve(h); }, () => { clearTimeout(t); resolve(null); });
  });
}
