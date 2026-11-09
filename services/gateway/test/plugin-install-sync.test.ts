import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipSync, strToU8 } from 'fflate';
import { syncPlugins, readInstalledManifest } from '../src/pluginInstall/sync';
import type { PackageSource, WantedPlugin } from '../src/pluginInstall/sync';
import { INSTALLED_MARKER } from '../src/pluginInstall/marker';

// Lets one test feed the sync a parse result the real parser would never give.
let mockParseHook: ((real: unknown) => unknown) | null = null;
jest.mock('@libs/plugin-package', () => {
  const actual = jest.requireActual('@libs/plugin-package');
  return {
    ...actual,
    parsePluginPackage: (bytes: Uint8Array) => {
      const real = actual.parsePluginPackage(bytes);
      return mockParseHook ? mockParseHook(real) : real;
    },
  };
});

// Lets one test make a rename fail; every other rename is the real one.
let mockRenameHook: ((from: string, to: string) => void) | null = null;
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (mockRenameHook) mockRenameHook(String(from), String(to));
      return actual.renameSync(from, to);
    },
  };
});

const manifest = (id: string, version = '1.0.0', gateway = '*') => ({
  id,
  version,
  runtime: 'node',
  gateway,
  help: { en: { summary: 'Does a thing' } },
});

const pack = (id: string, version: string, extra: Record<string, string> = {}, gateway = '*', manifestId = id) => {
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ ...manifest(id, version, gateway), id: manifestId })),
    'index.js': strToU8('module.exports = [];'),
  };
  for (const [name, text] of Object.entries(extra)) entries[name] = strToU8(text);
  return zipSync(entries);
};

const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

class FakeSource implements PackageSource {
  packages = new Map<string, { wanted: WantedPlugin; bytes: Uint8Array }>();
  listError: Error | null = null;
  fetches = 0;
  add(id: string, version: string, extra: Record<string, string> = {}, gateway = '*', manifestId = id, sha256?: string) {
    const bytes = pack(id, version, extra, gateway, manifestId);
    this.packages.set(id, { wanted: { id, version, sha256: sha256 ?? sha(bytes) }, bytes });
  }
  async list() {
    if (this.listError) throw this.listError;
    return [...this.packages.values()].map(p => p.wanted);
  }
  async fetch(p: WantedPlugin) {
    this.fetches++;
    return this.packages.get(p.id)!.bytes;
  }
}

const unlock = (target: string): void => {
  try {
    fs.chmodSync(target, 0o755);
    if (fs.statSync(target).isDirectory()) for (const n of fs.readdirSync(target)) unlock(path.join(target, n));
  } catch {
    // already gone
  }
};

describe('plugin install sync', () => {
  let dir: string;
  const opts = () => ({ pluginsDir: dir, gatewayVersion: '0.12.0', unpackAllowed: true });
  const exists = (...p: string[]) => fs.existsSync(path.join(dir, ...p));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  });
  afterEach(() => {
    unlock(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('installs a package with manifest and marker', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    const r = await syncPlugins(s, opts());
    expect(r.changed).toBe(true);
    expect(r.plugins).toEqual([{ id: 'alpha', version: '1.0.0', state: 'installed' }]);
    expect(exists('alpha', 'manifest.json')).toBe(true);
    expect(exists('alpha', 'index.js')).toBe(true);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'alpha', INSTALLED_MARKER), 'utf8'));
    expect(marker).toEqual({ version: '1.0.0', sha256: s.packages.get('alpha')!.wanted.sha256 });
    expect(readInstalledManifest(dir, 'alpha')?.version).toBe('1.0.0');
  });

  it('does nothing when the sha is unchanged', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    await syncPlugins(s, opts());
    s.fetches = 0;
    const r = await syncPlugins(s, opts());
    expect(r.changed).toBe(false);
    expect(s.fetches).toBe(0);
    expect(r.plugins[0].state).toBe('installed');
  });

  it('upgrade and downgrade replace the whole file list', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0', { 'old.js': 'x', 'lib/a.js': 'x' });
    await syncPlugins(s, opts());
    s.add('alpha', '2.0.0', { 'new.js': 'y' });
    expect((await syncPlugins(s, opts())).changed).toBe(true);
    expect(exists('alpha', 'new.js')).toBe(true);
    expect(exists('alpha', 'old.js')).toBe(false);
    expect(exists('alpha', 'lib')).toBe(false);
    s.add('alpha', '1.0.0', { 'old.js': 'x', 'lib/a.js': 'x' });
    await syncPlugins(s, opts());
    expect(exists('alpha', 'old.js')).toBe(true);
    expect(exists('alpha', 'lib', 'a.js')).toBe(true);
    expect(exists('alpha', 'new.js')).toBe(false);
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
  });

  it('removes unwanted installed folders and leaves shipped things alone', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    await syncPlugins(s, opts());
    fs.mkdirSync(path.join(dir, 'shipped'));
    fs.writeFileSync(path.join(dir, 'shipped', 'manifest.json'), '{}');
    fs.mkdirSync(path.join(dir, 'helpers'));
    fs.writeFileSync(path.join(dir, 'topLevel.js'), '');
    fs.writeFileSync(path.join(dir, 'alpha.js'), '');
    s.packages.clear();
    const r = await syncPlugins(s, opts());
    expect(r.changed).toBe(true);
    expect(exists('alpha')).toBe(false);
    expect(exists('shipped', 'manifest.json')).toBe(true);
    expect(exists('helpers')).toBe(true);
    expect(exists('topLevel.js')).toBe(true);
    expect(exists('alpha.js')).toBe(true);
  });

  it('a failed list removes nothing', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    await syncPlugins(s, opts());
    s.listError = new Error('admin down');
    const r = await syncPlugins(s, opts());
    expect(r.listFailed).toBe('admin down');
    expect(r.changed).toBe(false);
    expect(exists('alpha', 'manifest.json')).toBe(true);
  });

  it('sha mismatch or parse failure fails that plugin, keeps its previous version, installs others', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    s.add('beta', '1.0.0');
    await syncPlugins(s, opts());
    s.add('alpha', '2.0.0', {}, '*', 'alpha', 'f'.repeat(64));
    s.packages.set('beta', { wanted: { id: 'beta', version: '2.0.0', sha256: sha(strToU8('junk')) }, bytes: strToU8('junk') });
    s.add('gamma', '1.0.0');
    const r = await syncPlugins(s, opts());
    const state = Object.fromEntries(r.plugins.map(p => [p.id, p.state]));
    expect(state).toEqual({ alpha: 'failed', beta: 'failed', gamma: 'installed' });
    expect(readInstalledManifest(dir, 'alpha')?.version).toBe('1.0.0');
    expect(readInstalledManifest(dir, 'beta')?.version).toBe('1.0.0');
    expect(exists('gamma', 'index.js')).toBe(true);
  });

  it('a manifest id that differs from the wanted id fails', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0', {}, '*', 'other');
    const r = await syncPlugins(s, opts());
    expect(r.plugins[0].state).toBe('failed');
    expect(r.plugins[0].error).toMatch(/does not match/);
    expect(exists('alpha')).toBe(false);
    expect(exists('other')).toBe(false);
  });

  it('refuses a name taken by a shipped folder or file and changes nothing', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    s.add('beta', '1.0.0');
    fs.mkdirSync(path.join(dir, 'alpha'));
    fs.writeFileSync(path.join(dir, 'alpha', 'manifest.json'), '{}');
    fs.writeFileSync(path.join(dir, 'beta'), 'a file');
    const r = await syncPlugins(s, opts());
    expect(r.plugins.map(p => p.state)).toEqual(['failed', 'failed']);
    expect(r.changed).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'alpha', 'manifest.json'), 'utf8')).toBe('{}');
    expect(fs.readFileSync(path.join(dir, 'beta'), 'utf8')).toBe('a file');
    expect(s.fetches).toBe(0);
  });

  it('an invalid wanted id fails without touching paths', async () => {
    const s = new FakeSource();
    s.packages.set('x', { wanted: { id: '.tmp', version: '1.0.0', sha256: 'a' }, bytes: new Uint8Array() });
    s.packages.set('y', { wanted: { id: '../evil', version: '1.0.0', sha256: 'a' }, bytes: new Uint8Array() });
    fs.mkdirSync(path.join(dir, '.tmp'));
    const r = await syncPlugins(s, opts());
    expect(r.plugins.map(p => p.state)).toEqual(['failed', 'failed']);
    expect(s.fetches).toBe(0);
    expect(exists('..', 'evil')).toBe(false);
  });

  it('an incompatible new version keeps a working previous version', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    await syncPlugins(s, opts());
    s.add('alpha', '2.0.0', {}, '>=9.0.0');
    const r = await syncPlugins(s, opts());
    expect(r.plugins[0].state).toBe('incompatible');
    expect(r.changed).toBe(false);
    expect(readInstalledManifest(dir, 'alpha')?.version).toBe('1.0.0');
  });

  it('an incompatible new version with no previous version unpacks nothing', async () => {
    const s = new FakeSource();
    s.add('alpha', '2.0.0', {}, '>=9.0.0');
    const r = await syncPlugins(s, opts());
    expect(r.plugins[0].state).toBe('incompatible');
    expect(exists('alpha')).toBe(false);
  });

  it('an installed plugin that no longer fits the gateway is removed on the next sync', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0', {}, '>=0.12.0 <0.13.0');
    await syncPlugins(s, opts());
    const r = await syncPlugins(s, { ...opts(), gatewayVersion: '0.13.0' });
    expect(r.plugins[0].state).toBe('incompatible');
    expect(exists('alpha')).toBe(false);
  });

  it('an unreadable marker is replaced, not treated as shipped', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    fs.mkdirSync(path.join(dir, 'alpha'));
    fs.writeFileSync(path.join(dir, 'alpha', INSTALLED_MARKER), 'not json');
    fs.writeFileSync(path.join(dir, 'alpha', 'stale.js'), '');
    const r = await syncPlugins(s, opts());
    expect(r.plugins[0].state).toBe('installed');
    expect(exists('alpha', 'stale.js')).toBe(false);
    expect(exists('alpha', 'index.js')).toBe(true);
  });

  it('recovers from leftovers in .tmp and from a half-finished swap', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    fs.mkdirSync(path.join(dir, '.tmp', 'alpha-abc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tmp', 'alpha-abc', 'half.js'), '');
    fs.mkdirSync(path.join(dir, '.tmp', 'old-alpha-def'));
    fs.writeFileSync(path.join(dir, '.tmp', 'old-alpha-def', INSTALLED_MARKER), '{}');
    const r = await syncPlugins(s, opts());
    expect(r.plugins[0].state).toBe('installed');
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
    expect(exists('alpha', 'index.js')).toBe(true);
  });

  it('writes nothing when unpacking is not allowed', async () => {
    const s = new FakeSource();
    s.add('alpha', '1.0.0');
    const r = await syncPlugins(s, { ...opts(), unpackAllowed: false });
    expect(r.unpackDisabledReason).toBeTruthy();
    expect(r.changed).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(s.fetches).toBe(0);
  });

  it('an unusable .tmp is reported only when there is something to do', async () => {
    fs.writeFileSync(path.join(dir, '.tmp'), 'a file, so the folder cannot be made');
    const s = new FakeSource();
    expect((await syncPlugins(s, opts())).error).toBeUndefined();
    s.add('alpha', '1.0.0');
    const r = await syncPlugins(s, opts());
    expect(r.error).toMatch(/\.tmp is unusable/);
    expect(r.plugins[0]).toMatchObject({ id: 'alpha', state: 'failed' });
  });

  it('nothing to do drops only the unusable .tmp, not other .tmp problems', async () => {
    fs.mkdirSync(path.join(dir, '.tmp'));
    const stuck = path.join(dir, '.tmp', 'stuck');
    fs.mkdirSync(stuck);
    fs.writeFileSync(path.join(stuck, 'f'), 'x');
    fs.chmodSync(stuck, 0o555);
    const r = await syncPlugins(new FakeSource(), opts());
    fs.chmodSync(stuck, 0o755);
    expect(r.error).toMatch(/could not clear \.tmp\/stuck/);
  });

  describe('a listing with an unreadable package', () => {
    const withGap = (s: FakeSource): PackageSource => ({
      list: async () => ({ wanted: (await s.list()) as WantedPlugin[], unreadable: [{ name: 'broken.zip', error: 'damaged' }] }),
      fetch: w => s.fetch(w),
    });

    it('removes nothing on that run, installs the valid ones and shows the package', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      s.packages.delete('alpha');
      s.add('beta', '1.0.0');
      const r = await syncPlugins(withGap(s), opts());
      expect(exists('alpha', INSTALLED_MARKER)).toBe(true);
      expect(exists('beta', INSTALLED_MARKER)).toBe(true);
      expect(r.changed).toBe(true);
      expect(r.plugins).toEqual(expect.arrayContaining([
        { id: 'beta', version: '1.0.0', state: 'installed' },
        expect.objectContaining({ id: 'broken.zip', state: 'failed', error: expect.stringContaining('damaged') }),
      ]));
    });

    it('removes the plugin again once the listing is complete', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      s.packages.delete('alpha');
      await syncPlugins(withGap(s), opts());
      expect(exists('alpha')).toBe(true);
      expect((await syncPlugins(s, opts())).changed).toBe(true);
      expect(exists('alpha')).toBe(false);
    });

    it('a malformed listing is a failed list', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      const bad = { list: async () => ({ wanted: [] }), fetch: s.fetch.bind(s) } as unknown as PackageSource;
      const r = await syncPlugins(bad, opts());
      expect(r.listFailed).toBeTruthy();
      expect(exists('alpha')).toBe(true);
    });
  });

  describe('fix round 1', () => {
    const lockDir = (...p: string[]) => fs.chmodSync(path.join(dir, ...p), 0o555);
    const markerOf = (id: string) => JSON.parse(fs.readFileSync(path.join(dir, id, INSTALLED_MARKER), 'utf8'));

    it('I1: a removal whose delete partly fails leaves no half-folder behind', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0', { 'lib/deep/a.js': 'x' });
      await syncPlugins(s, opts());
      lockDir('alpha', 'lib', 'deep');
      s.packages.clear();
      const r = await syncPlugins(s, opts());
      expect(r.changed).toBe(true);
      expect(exists('alpha')).toBe(false);
      expect(r.plugins).toEqual([]);
    });

    it('I2: a same-sha folder with a missing or broken manifest or entry is reinstalled', async () => {
      for (const damage of ['manifest-gone', 'manifest-broken', 'manifest-empty-object', 'index-gone']) {
        const s = new FakeSource();
        s.add('alpha', '1.0.0');
        await syncPlugins(s, opts());
        if (damage === 'manifest-gone') fs.rmSync(path.join(dir, 'alpha', 'manifest.json'));
        if (damage === 'manifest-broken') fs.writeFileSync(path.join(dir, 'alpha', 'manifest.json'), '{nope');
        if (damage === 'manifest-empty-object') fs.writeFileSync(path.join(dir, 'alpha', 'manifest.json'), '{}');
        if (damage === 'index-gone') fs.rmSync(path.join(dir, 'alpha', 'index.js'));
        const r = await syncPlugins(s, opts());
        expect(r.plugins[0].state).toBe('installed');
        expect(r.changed).toBe(true);
        expect(exists('alpha', 'index.js')).toBe(true);
        expect(readInstalledManifest(dir, 'alpha')?.version).toBe('1.0.0');
        fs.rmSync(path.join(dir, 'alpha'), { recursive: true });
      }
    });

    it('I3: readInstalledManifest needs the marker and a valid manifest', async () => {
      fs.mkdirSync(path.join(dir, 'alpha'));
      fs.writeFileSync(path.join(dir, 'alpha', 'manifest.json'), JSON.stringify(manifest('alpha')));
      expect(readInstalledManifest(dir, 'alpha')).toBeNull();
      fs.writeFileSync(path.join(dir, 'alpha', INSTALLED_MARKER), '{}');
      expect(readInstalledManifest(dir, 'alpha')?.id).toBe('alpha');
      fs.writeFileSync(path.join(dir, 'alpha', 'manifest.json'), '{}');
      expect(readInstalledManifest(dir, 'alpha')).toBeNull();
      expect(readInstalledManifest(dir, '../x')).toBeNull();
    });

    it('I3: an installed folder with an empty manifest is not deleted as incompatible', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      fs.writeFileSync(path.join(dir, 'alpha', 'manifest.json'), '{}');
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0]).toEqual({ id: 'alpha', version: '1.0.0', state: 'installed' });
      expect(exists('alpha', 'index.js')).toBe(true);
    });

    const crashed = async (s: FakeSource) => {
      s.add('alpha', '1.0.0', { 'v1.js': 'x' });
      await syncPlugins(s, opts());
      fs.mkdirSync(path.join(dir, '.tmp', 'x'), { recursive: true });
      fs.renameSync(path.join(dir, 'alpha'), path.join(dir, '.tmp', 'old.alpha.0123456789ab'));
    };

    it('I4: crash between the renames, then a failed fetch, keeps the old copy', async () => {
      const s = new FakeSource();
      await crashed(s);
      s.add('alpha', '2.0.0', {}, '*', 'alpha', 'f'.repeat(64));
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0].state).toBe('failed');
      expect(markerOf('alpha').version).toBe('1.0.0');
      expect(exists('alpha', 'v1.js')).toBe(true);
      expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
    });

    it('I4: crash between the renames, then a failed list, restores the old copy', async () => {
      const s = new FakeSource();
      await crashed(s);
      s.listError = new Error('admin down');
      const r = await syncPlugins(s, opts());
      expect(r.listFailed).toBe('admin down');
      expect(exists('alpha', 'v1.js')).toBe(true);
      expect(exists('.tmp', 'x')).toBe(false);
    });

    it('I4: a new folder in place and an old copy in .tmp keeps the new folder', async () => {
      const s = new FakeSource();
      await crashed(s);
      s.add('alpha', '2.0.0', { 'v2.js': 'y' });
      fs.mkdirSync(path.join(dir, 'alpha'));
      fs.cpSync(path.join(dir, '.tmp', 'old.alpha.0123456789ab'), path.join(dir, 'alpha'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'alpha', 'new-marker.txt'), 'in place');
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0].state).toBe('installed');
      expect(markerOf('alpha').version).toBe('2.0.0');
      expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
    });

    it('I4: an id that starts with old- is not confused with an old copy', async () => {
      const s = new FakeSource();
      s.add('old-x', '1.0.0');
      s.add('x', '1.0.0');
      await syncPlugins(s, opts());
      fs.renameSync(path.join(dir, 'old-x'), path.join(dir, '.tmp', 'old.old-x.0123456789ab'));
      fs.rmSync(path.join(dir, 'x'), { recursive: true });
      s.packages.delete('old-x');
      s.listError = new Error('down');
      await syncPlugins(s, opts());
      expect(exists('old-x', 'index.js')).toBe(true);
      expect(exists('x')).toBe(false);
    });

    it('I5: .tmp being a file fails installs per plugin and does not reject', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      fs.writeFileSync(path.join(dir, '.tmp'), 'file');
      const r = await syncPlugins(s, opts());
      expect(r.error).toMatch(/\.tmp/);
      expect(r.plugins[0].state).toBe('failed');
      expect(exists('alpha')).toBe(false);
    });

    it('I5: an unwritable plugins folder reports per plugin, keeps the previous version', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      s.add('beta', '1.0.0');
      await syncPlugins(s, opts());
      s.add('alpha', '2.0.0');
      s.packages.delete('beta');
      fs.chmodSync(dir, 0o555);
      const r = await syncPlugins(s, opts());
      expect(r.changed).toBe(false);
      const state = Object.fromEntries(r.plugins.map(p => [p.id, p.state]));
      expect(state).toEqual({ beta: 'failed', alpha: 'failed' });
      fs.chmodSync(dir, 0o755);
      expect(markerOf('alpha').version).toBe('1.0.0');
      expect(exists('beta', 'index.js')).toBe(true);
    });

    it('I5: an unwritable .tmp fails the install, keeps the previous version', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      s.add('alpha', '2.0.0');
      lockDir('.tmp');
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0].state).toBe('failed');
      expect(markerOf('alpha').version).toBe('1.0.0');
    });

    it('I5: an undeletable .tmp leftover is reported and the sync still installs', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      fs.mkdirSync(path.join(dir, '.tmp', 'junk', 'locked'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.tmp', 'junk', 'locked', 'f'), '');
      lockDir('.tmp', 'junk', 'locked');
      const r = await syncPlugins(s, opts());
      expect(r.error).toMatch(/could not clear/);
      expect(r.plugins[0].state).toBe('installed');
    });

    it('I5: a write failure during unpack keeps the previous version and leaves no leftovers', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      // a file and a folder under one name: the second write cannot succeed
      const bytes = zipSync({
        'manifest.json': strToU8(JSON.stringify(manifest('alpha', '2.0.0'))),
        'index.js': strToU8('x'),
        'a': strToU8('file'),
        'a/b.js': strToU8('y'),
      });
      s.packages.set('alpha', { wanted: { id: 'alpha', version: '2.0.0', sha256: sha(bytes) }, bytes });
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0].state).toBe('failed');
      expect(r.changed).toBe(false);
      expect(markerOf('alpha').version).toBe('1.0.0');
      expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
    });

    it('I6: a failed delete of the old copy still counts as installed and changed', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0', { 'lib/a.js': 'x' });
      await syncPlugins(s, opts());
      lockDir('alpha', 'lib');
      s.add('alpha', '2.0.0');
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0].state).toBe('installed');
      expect(r.changed).toBe(true);
      expect(markerOf('alpha').version).toBe('2.0.0');
    });

    it('the swap rolls the old copy back when the rename into place fails', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      s.add('alpha', '2.0.0');
      mockRenameHook = (from, to) => {
        if (to === path.join(dir, 'alpha') && path.basename(from).startsWith('alpha-')) {
          throw new Error('simulated rename failure');
        }
      };
      try {
        const r = await syncPlugins(s, opts());
        expect(r.plugins[0].state).toBe('failed');
        expect(r.changed).toBe(false);
      } finally {
        mockRenameHook = null;
      }
      expect(markerOf('alpha').version).toBe('1.0.0');
      expect(exists('alpha', 'index.js')).toBe(true);
    });

    it('I7: a damaged previous version is removed when the new one is incompatible', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      fs.rmSync(path.join(dir, 'alpha', 'index.js'));
      s.add('alpha', '2.0.0', {}, '>=9.0.0');
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0].state).toBe('incompatible');
      expect(exists('alpha')).toBe(false);
    });

    it('I8: malformed list entries or answers are a list failure and remove nothing', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      for (const answer of [[{ pluginId: 'alpha' }], null, { id: 'alpha' }, [null]]) {
        const r = await syncPlugins({ list: async () => answer as never, fetch: async () => new Uint8Array() }, opts());
        expect(r.listFailed).toBeTruthy();
        expect(r.changed).toBe(false);
        expect(exists('alpha', 'index.js')).toBe(true);
      }
    });

    it('I8: an invalid gateway version is a sync error and removes nothing', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      for (const gatewayVersion of ['', 'abc']) {
        const r = await syncPlugins(s, { ...opts(), gatewayVersion });
        expect(r.error).toMatch(/gateway version/);
        expect(r.changed).toBe(false);
        expect(exists('alpha', 'index.js')).toBe(true);
      }
    });

    it('I9: a package whose ./manifest.json shadows the manifest is refused', async () => {
      const s = new FakeSource();
      const bytes = zipSync({
        'manifest.json': strToU8(JSON.stringify(manifest('alpha'))),
        './manifest.json': strToU8(JSON.stringify({ evil: true })),
        'index.js': strToU8('x'),
      });
      s.packages.set('alpha', { wanted: { id: 'alpha', version: '1.0.0', sha256: sha(bytes) }, bytes });
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0].state).toBe('failed');
      expect(exists('alpha')).toBe(false);
    });
  });

  describe('fix round 2', () => {
    it('B1: a path that escapes the temp folder is refused and nothing is written outside', async () => {
      const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-outer-'));
      const inner = path.join(outer, 'gw', 'plugins');
      fs.mkdirSync(inner, { recursive: true });
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      mockParseHook = (real: any) => ({ ...real, files: [...real.files, { path: '../../../escaped.js', data: strToU8('pwned') }] });
      try {
        const r = await syncPlugins(s, { pluginsDir: inner, gatewayVersion: '0.12.0', unpackAllowed: true });
        expect(r.plugins[0].state).toBe('failed');
        expect(r.plugins[0].error).toMatch(/unsafe path/);
        expect(fs.existsSync(path.join(outer, 'gw', 'escaped.js'))).toBe(false);
        expect(fs.existsSync(path.join(inner, 'alpha'))).toBe(false);
      } finally {
        mockParseHook = null;
        fs.rmSync(outer, { recursive: true, force: true });
      }
    });

    it('B1: a package with a patched directory count never reaches the disk', async () => {
      const s = new FakeSource();
      const b = new Uint8Array(zipSync({
        'manifest.json': strToU8(JSON.stringify(manifest('alpha'))),
        'index.js': strToU8('x'),
        '../escaped.js': strToU8('pwned'),
      }));
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      let e = b.length - 22;
      while (view.getUint32(e, true) !== 0x06054b50) e--;
      view.setUint16(e + 10, 2, true);
      s.packages.set('alpha', { wanted: { id: 'alpha', version: '1.0.0', sha256: sha(b) }, bytes: b });
      const nested = path.join(dir, 'gw', 'plugins');
      fs.mkdirSync(nested, { recursive: true });
      const r = await syncPlugins(s, { pluginsDir: nested, gatewayVersion: '0.12.0', unpackAllowed: true });
      expect(r.plugins[0].state).toBe('failed');
      expect(fs.existsSync(path.join(dir, 'gw', 'escaped.js'))).toBe(false);
    });

    it('B2: a BOM manifest is refused instead of reinstalled on every sync', async () => {
      const s = new FakeSource();
      const bytes = zipSync({
        'manifest.json': new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(JSON.stringify(manifest('alpha')))]),
        'index.js': strToU8('x'),
      });
      s.packages.set('alpha', { wanted: { id: 'alpha', version: '1.0.0', sha256: sha(bytes) }, bytes });
      const r = await syncPlugins(s, opts());
      expect(r.plugins[0].state).toBe('failed');
      expect(exists('alpha')).toBe(false);
    });

    it('B3: an old copy whose restore failed is not deleted', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      fs.renameSync(path.join(dir, 'alpha'), path.join(dir, '.tmp', 'old.alpha.0123456789ab'));
      s.listError = new Error('admin down');
      fs.chmodSync(dir, 0o555);
      const r = await syncPlugins(s, opts());
      fs.chmodSync(dir, 0o755);
      expect(r.error).toMatch(/could not restore/);
      expect(exists('.tmp', 'old.alpha.0123456789ab', 'index.js')).toBe(true);
      const again = await syncPlugins(s, opts());
      expect(again.listFailed).toBe('admin down');
      expect(exists('alpha', 'index.js')).toBe(true);
    });

    it('a duplicate id in the list is a list failure and removes nothing', async () => {
      const s = new FakeSource();
      s.add('alpha', '1.0.0');
      await syncPlugins(s, opts());
      const w = s.packages.get('alpha')!.wanted;
      const r = await syncPlugins({ list: async () => [w, { ...w }], fetch: async () => new Uint8Array() }, opts());
      expect(r.listFailed).toMatch(/duplicate/);
      expect(r.changed).toBe(false);
      expect(exists('alpha', 'index.js')).toBe(true);
    });
  });
});
