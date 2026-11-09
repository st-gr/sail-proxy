/** Pure logic of the "newer release available" banner; no UI5 imports. */

export type InstallType = 'kyma' | 'docker' | 'local';
export type Notice = { latest: string; current: string; releaseUrl: string; runbookUrl: string };
export type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export type FetchLike = (url: string, init: { headers: Record<string, string>; credentials: 'omit' }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export const CHECK_KEY = 'sail.cockpit.updateCheck';
export const DISMISSED_KEY = 'sail.cockpit.updateDismissed';
const RELEASES_API = 'https://api.github.com/repos/st-gr/sail-proxy/releases/latest';
const RELEASES_PAGE = 'https://github.com/st-gr/sail-proxy/releases/latest';
const RUNBOOKS = 'https://github.com/st-gr/sail-proxy/blob/main/docs/deploy/';
const DAY_MS = 24 * 60 * 60 * 1000;

function parse(v: string): { nums: number[]; pre: string } {
	const [core, ...rest] = v.trim().replace(/^v/i, '').split('-');
	const nums = core.split('.').map((p) => parseInt(p, 10) || 0);
	while (nums.length < 3) nums.push(0);
	return { nums, pre: rest.join('-') };
}

/** Semver x.y.z, a leading v is ignored, a pre-release ranks below its release. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
	}
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	return x.pre > y.pre ? 1 : -1;
}

function read(storage: StorageLike, key: string): string | null {
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

function write(storage: StorageLike, key: string, value: string): void {
	try {
		storage.setItem(key, value);
	} catch {
		/* storage unavailable: the check just is not cached */
	}
}

function cached(storage: StorageLike, now: number): { latest: string; url: string } | null {
	try {
		const c = JSON.parse(read(storage, CHECK_KEY) ?? 'null');
		if (c && typeof c.latest === 'string' && typeof c.checkedAt === 'number' && now - c.checkedAt >= 0 && now - c.checkedAt < DAY_MS) {
			return { latest: c.latest, url: typeof c.url === 'string' ? c.url : RELEASES_PAGE };
		}
	} catch {
		/* unreadable cache: fetch again */
	}
	return null;
}

async function fetchLatest(fetch: FetchLike): Promise<{ latest: string; url: string } | null> {
	try {
		const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit' });
		if (!res.ok || res.status !== 200) return null;
		const body = await res.json();
		if (!body || typeof body.tag_name !== 'string' || body.tag_name === '') return null;
		return { latest: body.tag_name.replace(/^v/i, ''), url: typeof body.html_url === 'string' && body.html_url ? body.html_url : RELEASES_PAGE };
	} catch {
		return null;
	}
}

export async function checkForUpdate(opts: {
	current: string;
	installType: InstallType;
	enabled: boolean;
	now: number;
	storage: StorageLike;
	fetch: FetchLike;
}): Promise<Notice | null> {
	if (!opts.enabled || opts.installType === 'local') return null;
	let found = cached(opts.storage, opts.now);
	if (!found) {
		found = await fetchLatest(opts.fetch);
		if (!found) return null;
		write(opts.storage, CHECK_KEY, JSON.stringify({ checkedAt: opts.now, latest: found.latest, url: found.url }));
	}
	if (compareVersions(found.latest, opts.current) <= 0) return null;
	if (read(opts.storage, DISMISSED_KEY) === found.latest) return null;
	return {
		latest: found.latest,
		current: opts.current,
		releaseUrl: found.url,
		runbookUrl: `${RUNBOOKS}${opts.installType === 'kyma' ? 'upgrade-kyma.md' : 'upgrade-docker.md'}`
	};
}

export function dismiss(storage: StorageLike, version: string): void {
	write(storage, DISMISSED_KEY, version);
}

/** Behind nginx (Docker, Kyma) the admin service's /api is served under /admin/api. */
export function versionUrl(deployTarget: string | null | undefined): string {
	return deployTarget === 'docker' ? '/admin/api/version' : '/api/version';
}
