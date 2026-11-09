import { checkForUpdate, compareVersions, dismiss, StorageLike, versionUrl } from '../webapp/model/updateNotice';

const NOW = 1_800_000_000_000;
const HOUR = 3600 * 1000;

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    }
  };
}
const brokenStorage: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  }
};
const release = (tag: string, extra: any = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ tag_name: tag, html_url: `https://github.com/st-gr/sail-proxy/releases/tag/${tag}`, ...extra })
});
const base = { current: '0.11.0', installType: 'kyma' as const, enabled: true, now: NOW };

describe('compareVersions', () => {
  it('orders semver, ignores a leading v, ranks a pre-release below its release', () => {
    expect(compareVersions('v0.12.0', '0.11.9')).toBe(1);
    expect(compareVersions('0.11.0', '0.11.0')).toBe(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.12.0-rc.1', '0.12.0')).toBe(-1);
    expect(compareVersions('0.12.0', '0.12.0-rc.1')).toBe(1);
  });
});

describe('checkForUpdate', () => {
  it('a newer release gives a notice with the release and runbook links', async () => {
    const fetch = jest.fn().mockResolvedValue(release('v0.12.0'));
    const n = await checkForUpdate({ ...base, storage: memoryStorage(), fetch });
    expect(n).toEqual({
      latest: '0.12.0',
      current: '0.11.0',
      releaseUrl: 'https://github.com/st-gr/sail-proxy/releases/tag/v0.12.0',
      runbookUrl: 'https://github.com/st-gr/sail-proxy/blob/main/docs/deploy/upgrade-kyma.md'
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/st-gr/sail-proxy/releases/latest');
    expect(init).toMatchObject({ credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } });
  });
  it('docker installs get the docker runbook', async () => {
    const n = await checkForUpdate({ ...base, installType: 'docker', storage: memoryStorage(), fetch: jest.fn().mockResolvedValue(release('v0.12.0')) });
    expect(n?.runbookUrl).toBe('https://github.com/st-gr/sail-proxy/blob/main/docs/deploy/upgrade-docker.md');
  });
  it('a missing html_url falls back to the latest releases page', async () => {
    const fetch = jest.fn().mockResolvedValue(release('v0.12.0', { html_url: undefined }));
    const n = await checkForUpdate({ ...base, storage: memoryStorage(), fetch });
    expect(n?.releaseUrl).toBe('https://github.com/st-gr/sail-proxy/releases/latest');
  });
  it('the same or an older release gives no notice', async () => {
    expect(await checkForUpdate({ ...base, storage: memoryStorage(), fetch: jest.fn().mockResolvedValue(release('v0.11.0')) })).toBeNull();
    expect(await checkForUpdate({ ...base, storage: memoryStorage(), fetch: jest.fn().mockResolvedValue(release('v0.10.0')) })).toBeNull();
  });
  it('disabled or local: no notice and no fetch', async () => {
    const fetch = jest.fn();
    expect(await checkForUpdate({ ...base, enabled: false, storage: memoryStorage(), fetch })).toBeNull();
    expect(await checkForUpdate({ ...base, installType: 'local', storage: memoryStorage(), fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a check younger than 24 hours is answered from the cache', async () => {
    const storage = memoryStorage({
      'sail.cockpit.updateCheck': JSON.stringify({ checkedAt: NOW - 23 * HOUR, latest: '0.12.0', url: 'https://example.test/r' })
    });
    const fetch = jest.fn();
    const n = await checkForUpdate({ ...base, storage, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(n?.latest).toBe('0.12.0');
    expect(n?.releaseUrl).toBe('https://example.test/r');
  });
  it('an older cache is refreshed and rewritten', async () => {
    const storage = memoryStorage({ 'sail.cockpit.updateCheck': JSON.stringify({ checkedAt: NOW - 25 * HOUR, latest: '0.11.5', url: 'u' }) });
    const fetch = jest.fn().mockResolvedValue(release('v0.13.0'));
    const n = await checkForUpdate({ ...base, storage, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(n?.latest).toBe('0.13.0');
    expect(JSON.parse(storage.data['sail.cockpit.updateCheck'])).toMatchObject({ checkedAt: NOW, latest: '0.13.0' });
  });
  it.each([
    ['rejects', jest.fn().mockRejectedValue(new Error('offline'))],
    ['non-200', jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })],
    ['rate limit', jest.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'rate limit exceeded' }) })],
    ['malformed json', jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })],
    ['no tag', jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })]
  ])('%s: no notice and no throw', async (_name, fetch) => {
    await expect(checkForUpdate({ ...base, storage: memoryStorage(), fetch })).resolves.toBeNull();
  });
  it('storage that throws only loses the cache', async () => {
    const n = await checkForUpdate({ ...base, storage: brokenStorage, fetch: jest.fn().mockResolvedValue(release('v0.12.0')) });
    expect(n?.latest).toBe('0.12.0');
    expect(() => dismiss(brokenStorage, '0.12.0')).not.toThrow();
  });
  it('a dismissed version stays hidden, a newer one shows again', async () => {
    const storage = memoryStorage();
    dismiss(storage, '0.12.0');
    expect(await checkForUpdate({ ...base, storage, fetch: jest.fn().mockResolvedValue(release('v0.12.0')) })).toBeNull();
    const n = await checkForUpdate({ ...base, now: NOW + 48 * HOUR, storage, fetch: jest.fn().mockResolvedValue(release('v0.12.1')) });
    expect(n?.latest).toBe('0.12.1');
  });
});

describe('versionUrl', () => {
  it('docker (and Kyma) go through /admin/api, everything else uses /api', () => {
    expect(versionUrl('docker')).toBe('/admin/api/version');
    expect(versionUrl('development')).toBe('/api/version');
    expect(versionUrl('unknown')).toBe('/api/version');
  });
});
