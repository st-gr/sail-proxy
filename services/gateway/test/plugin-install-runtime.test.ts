import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipSync, strToU8 } from 'fflate';
import { createPluginRuntime, isUnpackAllowed, resolvePluginSource, UNPACK_DISABLED_DEV } from '../src/pluginInstall/runtime';
import type { PluginRuntimeDeps } from '../src/pluginInstall/runtime';
import { adminPackageSource } from '../src/pluginInstall/adminSource';
import { withPluginLock } from '../src/pluginInstall/lock';
import { INSTALLED_MARKER } from '../src/pluginInstall/marker';
import { buildPluginStatus, clearPluginStatus, pluginStatusKey, writePluginStatus, PLUGIN_STATUS_TTL_SECONDS } from '../src/pluginInstall/statusReporter';
import { resolvePluginSettings } from '../src/pluginInstall/settings';
import type { PackageSource, SyncResult, WantedPlugin } from '../src/pluginInstall/sync';
import pluginLoader, { getLoadReport, hasLoadedPlugins } from '../src/services/pluginLoader';
import * as pluginLoaderModule from '../src/services/pluginLoader';
import { reloadPluginModules, setPluginsReloadedHandler, setPluginsChangedHandler, handleValkeyEvent } from '../src/services/configService';

jest.mock('@libs/logger', () => {
  const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
  return { getDefaultLogger: () => log, mockLog: log };
});
const { mockLog } = require('@libs/logger');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const logged = () => [...mockLog.error.mock.calls, ...mockLog.warn.mock.calls].map(c => c.join(' ')).join('\n');

const manifestJson = (id: string, version = '1.0.0', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, version, runtime: 'node', gateway: '*', help: { en: { summary: 's' } }, ...extra });
const pack = (id: string, version = '1.0.0') =>
  zipSync({ 'manifest.json': strToU8(manifestJson(id, version)), 'index.js': strToU8('module.exports = [];') });

class FakeSource implements PackageSource {
  packages = new Map<string, { wanted: WantedPlugin; bytes: Uint8Array }>();
  listError: Error | null = null;
  lists = 0;
  gate: Promise<void> | null = null;
  add(id: string, version = '1.0.0') {
    const bytes = pack(id, version);
    this.packages.set(id, { wanted: { id, version, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes });
  }
  async list() {
    this.lists++;
    if (this.gate) await this.gate;
    if (this.listError) throw this.listError;
    return [...this.packages.values()].map(p => p.wanted);
  }
  async fetch(w: WantedPlugin) { return this.packages.get(w.id)!.bytes; }
}

describe('plugin runtime', () => {
  let dir: string;
  let source: FakeSource;
  let events: string[];
  let loaded: boolean;
  let reports: (SyncResult | null)[];
  let marker: (() => void) | null;
  let reloaded: (() => void) | null;
  const runtimes: { stop(): void }[] = [];

  const make = (over: Partial<PluginRuntimeDeps> = {}) => {
    const rt = createPluginRuntime({
      source,
      watch: true,
      pluginsDir: dir,
      gatewayVersion: '1.0.0',
      unpackAllowed: true,
      bootWaitMs: 200,
      retryBaseMs: 5,
      checkIntervalMs: 60_000,
      reloadInsideLock: async () => { events.push('reload'); },
      pluginsLoaded: () => loaded,
      report: async sync => { reports.push(sync); },
      onMarker: fn => { marker = fn; },
      onReloaded: fn => { reloaded = fn; },
      ...over,
    });
    runtimes.push(rt);
    return rt;
  };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-runtime-')));
    source = new FakeSource();
    events = [];
    loaded = true;
    reports = [];
    marker = null;
    reloaded = null;
  });
  afterEach(async () => {
    runtimes.splice(0).forEach(r => r.stop());
    await tick(20);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const installed = (id: string) => fs.existsSync(path.join(dir, id, INSTALLED_MARKER));

  it('a sync that finishes after stop() reports nothing, so a cleared status is not written back', async () => {
    let release: () => void = () => undefined;
    source.gate = new Promise<void>(r => { release = r; });
    source.add('alpha');
    const rt = make();
    const running = rt.check();
    await tick();
    rt.stop();
    release();
    await running;
    expect(reports).toEqual([]);
  });

  it('the sync holds no lock while it waits for the source; the reload after it does', async () => {
    let release: () => void = () => undefined;
    source.gate = new Promise<void>(r => { release = r; });
    source.add('alpha');
    const rt = make({
      reloadInsideLock: async () => {
        expect(installed('alpha')).toBe(true);
        await tick(); // the lock registers its holder once the holder's synchronous part returns
        void withPluginLock(async () => { events.push('next holder'); });
        await tick(10);
        events.push('reload');
      },
    });
    const checking = rt.check();
    await tick();
    expect(source.lists).toBe(1);
    await withPluginLock(async () => { events.push('free during the sync'); });
    release();
    await checking;
    await tick(5);
    expect(events).toEqual(['free during the sync', 'reload', 'next holder']);
  });

  it('a marker set at boot works before startWatch', async () => {
    const rt = make();
    await rt.boot();
    expect(source.lists).toBe(1);
    source.add('alpha');
    marker!();
    for (let i = 0; i < 100 && !installed('alpha'); i++) await tick(5);
    expect(installed('alpha')).toBe(true);
    expect(reloaded).not.toBeNull();
  });

  it('a folder source sets no marker handler at boot', async () => {
    await make({ watch: false }).boot();
    expect(marker).toBeNull();
    expect(reloaded).toBeNull();
  });

  it('no change means no reload', async () => {
    source.add('alpha');
    const rt = make();
    await rt.check();
    expect(events).toEqual(['reload']);
    await rt.check();
    expect(events).toEqual(['reload']);
  });

  it('boot unpacks but does not reload while nothing has loaded yet', async () => {
    loaded = false;
    source.add('alpha');
    await make().boot();
    expect(installed('alpha')).toBe(true);
    expect(events).toEqual([]);
  });

  it('boot reloads exactly once when plugins already loaded (the standalone first load came first)', async () => {
    source.add('alpha');
    await make().boot();
    expect(installed('alpha')).toBe(true);
    expect(events).toEqual(['reload']);
  });

  it('boot with nothing changed does not reload even when plugins already loaded', async () => {
    await make().boot();
    expect(events).toEqual([]);
  });

  it('boot returns after its wait while admin is down, keeps retrying, and installs without reloading before the first load', async () => {
    loaded = false;
    source.add('alpha');
    source.listError = new Error('admin down');
    const started = Date.now();
    await make({ bootWaitMs: 40 }).boot();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(installed('alpha')).toBe(false);
    source.listError = null;
    for (let i = 0; i < 100 && !installed('alpha'); i++) await tick(10);
    expect(installed('alpha')).toBe(true);
    expect(events).toEqual([]);
  });

  it('a background retry that lands after the first load reloads', async () => {
    source.add('alpha');
    source.listError = new Error('admin down');
    await make({ bootWaitMs: 10 }).boot();
    source.listError = null;
    for (let i = 0; i < 100 && events.length === 0; i++) await tick(10);
    expect(events).toEqual(['reload']);
  });

  it('boot does not wait the full time when the sync finishes early', async () => {
    const started = Date.now();
    await make({ bootWaitMs: 5000 }).boot();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a boot wait on a hung list returns, and the sync finishes in the background', async () => {
    let release: () => void = () => undefined;
    source.gate = new Promise<void>(r => { release = r; });
    loaded = false;
    source.add('alpha');
    const started = Date.now();
    await make({ bootWaitMs: 30 }).boot();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(installed('alpha')).toBe(false);
    release();
    for (let i = 0; i < 100 && !installed('alpha'); i++) await tick(5);
    expect(installed('alpha')).toBe(true);
  });

  it('a folder source is not retried and is waited for in full, however long it takes', async () => {
    let release: () => void = () => undefined;
    source.gate = new Promise<void>(r => { release = r; });
    source.listError = new Error('unreadable folder');
    let finished = false;
    const booting = make({ watch: false, bootWaitMs: 5 }).boot().then(() => { finished = true; });
    await tick(40);
    expect(finished).toBe(false);
    release();
    await booting;
    await tick(30);
    expect(source.lists).toBe(1);
  });

  it('a marker during a running sync causes exactly one follow-up sync', async () => {
    let release: () => void = () => undefined;
    source.gate = new Promise<void>(r => { release = r; });
    const rt = make();
    rt.startWatch();
    const first = rt.check();
    await tick();
    expect(source.lists).toBe(1);
    marker!();
    marker!();
    marker!();
    source.add('alpha');
    source.gate = null;
    release();
    await first;
    expect(source.lists).toBe(2);
    expect(installed('alpha')).toBe(true);
  });

  it('a marker with nothing running syncs', async () => {
    source.add('alpha');
    make().startWatch();
    marker!();
    for (let i = 0; i < 100 && !installed('alpha'); i++) await tick(5);
    expect(installed('alpha')).toBe(true);
  });

  it('the timer checks, does not hold the process open, and stop clears it', async () => {
    const spy = jest.spyOn(global, 'setInterval');
    const rt = make({ checkIntervalMs: 15 });
    rt.startWatch();
    expect(spy).toHaveBeenCalledTimes(1);
    const timer = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    for (let i = 0; i < 100 && source.lists === 0; i++) await tick(5);
    expect(source.lists).toBeGreaterThan(0);
    rt.stop();
    await tick(10);
    const after = source.lists;
    await tick(40);
    expect(source.lists).toBe(after);
  });

  it('a failing check in the background is logged and never rejects', async () => {
    const rt = make({ report: async () => { throw new Error('status broke'); }, reloadInsideLock: async () => { throw new Error('reload broke'); } });
    source.add('alpha');
    await expect(rt.check()).resolves.toBeUndefined();
    expect(logged()).toMatch(/reload broke/);
    expect(logged()).toMatch(/status broke/);
    await expect(withPluginLock(async () => 'free')).resolves.toBe('free');
  });

  it('a list failure is logged and leaves installed plugins alone', async () => {
    source.add('alpha');
    const rt = make();
    await rt.check();
    source.listError = new Error('admin said no');
    await rt.check();
    expect(installed('alpha')).toBe(true);
    expect(logged()).toMatch(/admin said no/);
  });

  it('a failed plugin is logged with its id', async () => {
    source.add('alpha');
    source.packages.get('alpha')!.wanted.sha256 = 'f'.repeat(64);
    await make().check();
    expect(logged()).toMatch(/alpha/);
    expect(installed('alpha')).toBe(false);
  });

  it('reports after every check and on the reload signal, with the last sync result', async () => {
    source.add('alpha');
    const rt = make();
    await rt.check();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.plugins[0]).toMatchObject({ id: 'alpha', state: 'installed' });
    rt.startWatch();
    reports.length = 0;
    reloaded!();
    await tick(5);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[reports.length - 1]!.plugins[0]).toMatchObject({ id: 'alpha' });
  });

  it('startWatch does nothing for a folder source: a CLI change takes effect at the next start', async () => {
    const spy = jest.spyOn(global, 'setInterval');
    make({ watch: false, checkIntervalMs: 5 }).startWatch();
    await tick(30);
    expect(spy).not.toHaveBeenCalled();
    expect(marker).toBeNull();
    expect(source.lists).toBe(0);
  });

  it('no source at all: boot and watch do nothing and touch nothing', async () => {
    const spy = jest.spyOn(global, 'setInterval');
    const rt = make({ source: null, watch: false });
    await rt.boot();
    rt.startWatch();
    expect(spy).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('unpacking disabled: nothing is listed or written, the local-development reason reaches the report', async () => {
    source.add('alpha');
    await make({ unpackAllowed: false }).boot();
    expect(source.lists).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(reports[0]!.unpackDisabledReason).toBe(UNPACK_DISABLED_DEV);
    expect(UNPACK_DISABLED_DEV).toMatch(/local development gateway/);
  });

  it('the runtime source never names the locked reload, so it cannot deadlock on its own lock', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'pluginInstall', 'runtime.ts'), 'utf8');
    expect(text).not.toMatch(/reloadPluginModules/);
  });
});

describe('isUnpackAllowed', () => {
  const tsNodeSymbol = Symbol.for('ts-node.register.instance');
  afterEach(() => { delete (process as any)[tsNodeSymbol]; });

  it('is true on a compiled gateway', () => {
    expect(isUnpackAllowed({})).toBe(true);
  });
  it('is false with a .ts require extension registered', () => {
    expect(isUnpackAllowed({ '.ts': () => undefined })).toBe(false);
  });
  it('is false under ts-node', () => {
    (process as any)[tsNodeSymbol] = {};
    expect(isUnpackAllowed({})).toBe(false);
  });
});

describe('resolvePluginSource', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });
  const distributed = { UNIFIED_TOKEN_SYSTEM_ENABLED: 'true', VALKEY_URL: 'redis://x:1', ADMIN_SERVICE_URL: 'http://x:1', GATEWAY_STANDALONE: 'false' };
  const standalone = { GATEWAY_STANDALONE: 'true', ADMIN_SERVICE_URL: '', VALKEY_URL: '' };

  it('admin when not standalone', () => {
    process.env = { ...ORIGINAL_ENV, ...distributed, PLUGINS_SOURCE_DIR: '/ignored' };
    expect(resolvePluginSource()).toEqual({ source: adminPackageSource, watch: true });
  });
  it('the folder when standalone with PLUGINS_SOURCE_DIR, without watching', () => {
    process.env = { ...ORIGINAL_ENV, ...standalone, PLUGINS_SOURCE_DIR: '/some/dir' };
    const resolved = resolvePluginSource();
    expect(resolved.source).not.toBeNull();
    expect(resolved.source).not.toBe(adminPackageSource);
    expect(resolved.watch).toBe(false);
  });
  it('none otherwise', () => {
    process.env = { ...ORIGINAL_ENV, ...standalone };
    delete process.env.PLUGINS_SOURCE_DIR;
    expect(resolvePluginSource()).toEqual({ source: null, watch: false });
  });
});

describe('plugin status', () => {
  let dir: string;
  const write = (rel: string, content: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const moduleSrc = (...ids: string[]) =>
    `module.exports = [${ids.map(id => `{ id: ${JSON.stringify(id)}, match: [], strategy: 'before', handler: async () => ({}) }`).join(', ')}];`;
  const ORIGINAL_HOSTNAME = process.env.HOSTNAME;

  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-status-'))); });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_HOSTNAME === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = ORIGINAL_HOSTNAME;
  });

  const loadFixtures = () => {
    write('builtIn/manifest.json', manifestJson('builtIn', '2.0.0'));
    write('builtIn/index.js', moduleSrc('builtInRule'));
    write('good/manifest.json', manifestJson('good', '1.1.0'));
    write('good/index.js', moduleSrc('goodRule'));
    write(`good/${INSTALLED_MARKER}`, '{}');
    write('crashes/manifest.json', manifestJson('crashes'));
    write('crashes/index.js', 'throw new Error("load kaput");');
    write(`crashes/${INSTALLED_MARKER}`, '{}');
    write('kept/manifest.json', manifestJson('kept', '1.0.0'));
    write('kept/index.js', moduleSrc('keptRule'));
    write(`kept/${INSTALLED_MARKER}`, '{}');
    pluginLoader.loadAll(dir);
  };

  it('merges sync and load results into one row per plugin; shipped plugins keep their rule ids', () => {
    loadFixtures();
    const sync: SyncResult = {
      changed: false,
      plugins: [
        { id: 'good', version: '1.1.0', state: 'installed' },
        { id: 'crashes', version: '1.0.0', state: 'installed' },
        { id: 'kept', version: '2.0.0', state: 'failed', error: 'sha256 of the fetched package does not match' },
        { id: 'tooNew', version: '9.0.0', state: 'incompatible', error: 'requires gateway >=9' },
      ],
    };
    const status = buildPluginStatus(sync, getLoadReport(), '1.2.3', new Date('2026-11-04T10:00:00.000Z'));
    expect(status.gatewayVersion).toBe('1.2.3');
    expect(status.at).toBe('2026-11-04T10:00:00.000Z');
    expect(status.unpackDisabledReason).toBeUndefined();
    const row = (id: string) => status.plugins.find(p => p.id === id)!;
    expect(status.plugins.map(p => p.id).sort()).toEqual(['builtIn', 'crashes', 'good', 'kept', 'tooNew']);
    expect(row('builtIn')).toEqual({ id: 'builtIn', version: '2.0.0', kind: 'shipped', state: 'running', rules: [{ id: 'builtInRule', strategy: 'before' }] });
    expect(row('good')).toEqual({ id: 'good', version: '1.1.0', kind: 'installed', state: 'running', rules: [{ id: 'goodRule', strategy: 'before' }] });
    expect(row('crashes')).toMatchObject({ kind: 'installed', state: 'failed', error: 'load kaput', rules: [] });
    // Sync's error wins; the rules are what is really running: the previous version.
    expect(row('kept')).toEqual({
      id: 'kept', version: '2.0.0', kind: 'installed', state: 'failed',
      error: 'sha256 of the fetched package does not match', rules: [{ id: 'keptRule', strategy: 'before' }],
    });
    expect(row('tooNew')).toEqual({ id: 'tooNew', version: '9.0.0', kind: 'installed', state: 'incompatible', error: 'requires gateway >=9', rules: [] });
  });

  it('a shipped plugin that failed to load keeps its error in the status', () => {
    write('broken/manifest.json', manifestJson('broken', '1.0.0'));
    write('broken/index.js', 'throw new Error("shipped kaput");');
    pluginLoader.loadAll(dir);
    const status = buildPluginStatus(null, getLoadReport(), '1.0.0');
    expect(status.plugins).toEqual([{ id: 'broken', version: '1.0.0', kind: 'shipped', state: 'failed', error: 'shipped kaput', rules: [] }]);
    expect(status).not.toHaveProperty('legacy');
  });

  it("sync's error wins over the loader's on one row", () => {
    const status = buildPluginStatus(
      { changed: false, plugins: [{ id: 'x', version: '2.0.0', state: 'failed', error: 'from sync' }] },
      [{ source: 'x', id: 'x', version: '1.0.0', kind: 'installed', rules: [], error: 'from loader' }],
      '1.0.0',
    );
    expect(status.plugins).toEqual([{ id: 'x', version: '2.0.0', kind: 'installed', state: 'failed', error: 'from sync', rules: [] }]);
  });

  it('a plugin unpacked but not loaded yet says so', () => {
    const status = buildPluginStatus({ changed: true, plugins: [{ id: 'x', version: '1.0.0', state: 'installed' }] }, [], '1.0.0');
    expect(status.plugins).toEqual([{ id: 'x', version: '1.0.0', kind: 'installed', state: 'installed', rules: [] }]);
  });

  it('without a sync result the load report alone decides', () => {
    loadFixtures();
    const status = buildPluginStatus(null, getLoadReport(), '1.0.0');
    expect(status.plugins.find(p => p.id === 'good')).toMatchObject({ state: 'running' });
    expect(status.plugins.find(p => p.id === 'crashes')).toMatchObject({ state: 'failed' });
  });

  it('carries the reason unpacking is disabled', () => {
    const status = buildPluginStatus({ changed: false, plugins: [], unpackDisabledReason: UNPACK_DISABLED_DEV }, [], '1.0.0');
    expect(status.unpackDisabledReason).toBe(UNPACK_DISABLED_DEV);
  });

  it('writes the key with TTL 180 and the status as JSON', async () => {
    process.env.HOSTNAME = 'gateway-abc';
    const set = jest.fn(async () => 'OK');
    const status = buildPluginStatus(null, [], '1.0.0');
    await writePluginStatus({ set }, status);
    expect(PLUGIN_STATUS_TTL_SECONDS).toBe(180);
    expect(set).toHaveBeenCalledWith('sap-llm-gateway:plugin-status:gateway-abc', JSON.stringify(status), 'EX', 180);
  });

  it('the key falls back to local without a HOSTNAME', () => {
    delete process.env.HOSTNAME;
    expect(pluginStatusKey()).toBe('sap-llm-gateway:plugin-status:local');
  });

  it('a Valkey failure is logged and does not throw', async () => {
    const set = jest.fn(async () => { throw new Error('valkey away'); });
    await expect(writePluginStatus({ set }, buildPluginStatus(null, [], '1.0.0'))).resolves.toBeUndefined();
    expect(logged()).toMatch(/valkey away/);
  });

  it('no store means no write and no error', async () => {
    await expect(writePluginStatus(null, buildPluginStatus(null, [], '1.0.0'))).resolves.toBeUndefined();
  });

  // A stopped gateway (pod deleted, scaled down) must not stay listed as running until its key expires.
  it('clearing deletes this instance\'s key', async () => {
    process.env.HOSTNAME = 'gateway-abc';
    const del = jest.fn(async () => 1);
    await clearPluginStatus({ set: jest.fn(), del });
    expect(del).toHaveBeenCalledWith('sap-llm-gateway:plugin-status:gateway-abc');
  });

  it('clearing logs a Valkey failure and does not throw', async () => {
    const del = jest.fn(async () => { throw new Error('valkey gone'); });
    await expect(clearPluginStatus({ set: jest.fn(), del })).resolves.toBeUndefined();
    expect(logged()).toMatch(/valkey gone/);
  });

  it('clearing without a store does nothing', async () => {
    await expect(clearPluginStatus(null)).resolves.toBeUndefined();
  });
});

describe('plugin settings', () => {
  let dir: string;
  const folder = (id: string, defaults: Record<string, unknown> | null, installedPlugin: boolean) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    const extra = defaults ? { settings: { schema: { type: 'object' }, defaults } } : {};
    fs.writeFileSync(path.join(dir, id, 'manifest.json'), manifestJson(id, '1.0.0', extra));
    if (installedPlugin) fs.writeFileSync(path.join(dir, id, INSTALLED_MARKER), '{}');
  };
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-settings-')));
    pluginLoader.loadAll(dir); // clears the defaults cache
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults come from the manifest of an installed plugin', () => {
    folder('inst', { a: 1, b: 2 }, true);
    expect(resolvePluginSettings('inst', undefined, dir)).toEqual({ a: 1, b: 2 });
  });

  it('defaults come from the manifest of a shipped plugin too', () => {
    folder('ship', { a: 1 }, false);
    expect(resolvePluginSettings('ship', undefined, dir)).toEqual({ a: 1 });
  });

  it('the config value wins, shallowly', () => {
    folder('inst', { a: 1, nested: { x: 1, y: 2 } }, true);
    expect(resolvePluginSettings('inst', { nested: { x: 9 }, c: 3 }, dir)).toEqual({ a: 1, nested: { x: 9 }, c: 3 });
  });

  it('an unknown id gives {}; a config value for it still comes through', () => {
    expect(resolvePluginSettings('nobody', undefined, dir)).toEqual({});
    expect(resolvePluginSettings('nobody', { a: 1 }, dir)).toEqual({ a: 1 });
  });

  it('a bad id, a broken manifest and a non-object config value are tolerated', () => {
    expect(resolvePluginSettings('../evil', undefined, dir)).toEqual({});
    fs.mkdirSync(path.join(dir, 'broken'));
    fs.writeFileSync(path.join(dir, 'broken', 'manifest.json'), '{ nope');
    expect(resolvePluginSettings('broken', undefined, dir)).toEqual({});
    folder('inst', { a: 1 }, true);
    for (const bad of ['text', 7, ['list'], null]) expect(resolvePluginSettings('inst', bad, dir)).toEqual({ a: 1 });
  });

  it('reads the disk once per load, and again after a reload', () => {
    folder('inst', { a: 1 }, true);
    expect(resolvePluginSettings('inst', undefined, dir)).toEqual({ a: 1 });
    fs.writeFileSync(path.join(dir, 'inst', 'manifest.json'), manifestJson('inst', '1.0.0', { settings: { schema: {}, defaults: { a: 2 } } }));
    expect(resolvePluginSettings('inst', undefined, dir)).toEqual({ a: 1 });
    pluginLoader.loadAll(dir);
    expect(resolvePluginSettings('inst', undefined, dir)).toEqual({ a: 2 });
  });

  it('a caller changing a nested stored value cannot change the live configuration', () => {
    const stored = { nested: { x: 1 } };
    const copy = resolvePluginSettings('nobody', stored, dir) as any;
    copy.nested.x = 99;
    expect(stored.nested.x).toBe(1);
  });

  it('a caller changing its copy cannot change what the next caller sees', () => {
    folder('inst', { a: 1, nested: { x: 1 } }, true);
    const first = resolvePluginSettings('inst', undefined, dir) as any;
    first.a = 99;
    first.nested.x = 99;
    expect(resolvePluginSettings('inst', undefined, dir)).toEqual({ a: 1, nested: { x: 1 } });
  });

  describe('configService.getPluginSettings', () => {
    const ORIGINAL_ENV = { ...process.env };
    afterEach(() => { process.env = { ...ORIGINAL_ENV }; jest.resetModules(); });

    it('lays api_config.plugins.<id> over the manifest defaults', () => {
      folder('inst', { a: 1, b: 2 }, true);
      const configFile = path.join(dir, 'api_config.json');
      fs.writeFileSync(configFile, JSON.stringify({ api_config: { plugins: { inst: { b: 3 } } } }));
      process.env = { ...ORIGINAL_ENV, GATEWAY_STANDALONE: 'true', CONFIG_FILE_PATH: configFile };
      jest.resetModules();
      const loader = require('../src/services/pluginLoader');
      loader.default.loadAll = jest.fn(); // the real built-ins are not under test
      const config = require('../src/services/configService');
      expect(config.getPluginSettings('inst', dir)).toEqual({ a: 1, b: 3 });
      expect(config.getPluginSettings('nobody', dir)).toEqual({});
      expect(config.default.getPluginSettings).toBe(config.getPluginSettings);
    });
  });
});

describe('plugin loader failures that are not Errors', () => {
  let dir: string;
  const manifest = (id: string) => manifestJson(id);
  const write = (rel: string, content: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const row = (source: string) => getLoadReport().find(r => r.source === source)!;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-throw-')));
    write('good/manifest.json', manifest('good'));
    write('good/index.js', `module.exports = [{ id: 'goodRule', match: [], strategy: 'before', handler: async () => ({}) }];`);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const loadThrowing = (statement: string) => {
    write('bad/manifest.json', manifest('bad'));
    write('bad/index.js', statement);
    expect(() => pluginLoader.loadAll(dir)).not.toThrow();
    expect(row('good').rules).toEqual([{ id: 'goodRule', strategy: 'before' }]);
    return row('bad').error;
  };

  // Jest's own require wrapper turns a thrown null into a TypeError, so the exact text is checked in
  // a real node below; here it is about keeping the other plugins and a failed row.
  it('throw "x" reports a failed row', () => { expect(loadThrowing('throw "x";')).toBe('x'); });
  it('throw null reports a failed row and keeps the other plugins', () => { expect(loadThrowing('throw null;')).toBeTruthy(); });
  it('throw undefined reports a failed row', () => { expect(loadThrowing('throw undefined;')).toBeTruthy(); });
  it('an empty message is still a failure', () => { expect(loadThrowing('throw new Error("");')).toBeTruthy(); });
  it('an object that cannot be printed is still a failure', () => { expect(loadThrowing('throw Object.create(null);')).toBeTruthy(); });
  it('a message that throws is still a failure', () => {
    expect(loadThrowing('throw { get message() { throw new Error("nested"); } };')).toBeTruthy();
  });
});

/** Runs a script in a plain node under ts-node, as the dev gateway does; `RESULT <json>` is its answer. */
function inRealNode(script: string, dir: string, env: Record<string, string> = { GATEWAY_STANDALONE: 'true' }): any {
  const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'development', ...env, CONFIG_FILE_PATH: path.join(dir, 'api_config.json') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.split('\n').find(l => l.startsWith('RESULT '))!.slice('RESULT '.length));
}

describe('plugin loader in a real node', () => {
  it('reports null, undefined and a string thrown by .js and .ts entries, and keeps the other plugins', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-throw-node-')));
    try {
      const folder = (id: string, file: string, content: string) => {
        fs.mkdirSync(path.join(dir, id));
        fs.writeFileSync(path.join(dir, id, 'manifest.json'), manifestJson(id));
        fs.writeFileSync(path.join(dir, id, file), content);
      };
      folder('jsNull', 'index.js', 'throw null;');
      folder('jsUndefined', 'index.js', 'throw undefined;');
      folder('jsString', 'index.js', 'throw "x";');
      folder('tsNull', 'index.ts', 'throw null;');
      folder('tsString', 'index.ts', 'throw "y";');
      folder('good', 'index.js', `module.exports = [{ id: 'goodRule', match: [], strategy: 'before', handler: async () => ({}) }];`);
      const report = inRealNode(`
        const loader = require('./src/services/pluginLoader');
        loader.loadAll(${JSON.stringify(dir)});
        process.stdout.write('RESULT ' + JSON.stringify(loader.getLoadReport()) + '\\n');
        process.exit(0);`, dir);
      const errors = Object.fromEntries(report.map((r: any) => [r.source, r.error]));
      expect(errors).toEqual({ jsNull: 'null', jsUndefined: 'undefined', jsString: 'x', tsNull: 'null', tsString: 'y', good: undefined });
      expect(report.find((r: any) => r.source === 'good').rules).toEqual([{ id: 'goodRule', strategy: 'before' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('reloadPluginModules', () => {
  it('takes the plugin lock and then signals the reload', async () => {
    const reloadAll = jest.spyOn(pluginLoaderModule, 'reloadAll').mockImplementation(() => undefined);
    const signal = jest.fn();
    setPluginsReloadedHandler(signal);
    let release: () => void = () => undefined;
    const holder = withPluginLock(() => new Promise<void>(r => { release = r; }));
    const reloading = reloadPluginModules();
    await tick(10);
    expect(reloadAll).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    release();
    await holder;
    await reloading;
    expect(reloadAll).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledTimes(1);
    setPluginsReloadedHandler(() => undefined);
  });

  it('a throwing reload signal does not reject', async () => {
    jest.spyOn(pluginLoaderModule, 'reloadAll').mockImplementation(() => undefined);
    setPluginsReloadedHandler(() => { throw new Error('signal broke'); });
    await expect(reloadPluginModules()).resolves.toBeUndefined();
    setPluginsReloadedHandler(() => undefined);
  });

  // Jest replaces require.cache with a stand-in that ignores deletes, so this needs a real node.
  it('reloads a helper file inside a plugin folder fresh, in a real node', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-fresh-')));
    try {
      const plugin = path.join(dir, 'fresh');
      fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(plugin, 'manifest.json'), manifestJson('fresh'));
      fs.writeFileSync(path.join(plugin, 'index.js'),
        `module.exports = [{ id: require('./lib/helper').ruleId, match: [], strategy: 'before', handler: async () => ({}) }];`);
      fs.writeFileSync(path.join(plugin, 'lib', 'helper.js'), `exports.ruleId = 'first';`);
      const script = `
        const fs = require('fs');
        const { reloadPluginsInsideLock } = require('./src/pluginInstall/reload');
        const ids = () => Object.values(global.pluginRegistry).map(r => r.id);
        (async () => {
          const dir = ${JSON.stringify(dir)};
          await reloadPluginsInsideLock(dir);
          const before = ids();
          fs.writeFileSync(${JSON.stringify(path.join(plugin, 'lib', 'helper.js'))}, "exports.ruleId = 'second';");
          await reloadPluginsInsideLock(dir);
          process.stdout.write('RESULT ' + JSON.stringify({ before, after: ids() }) + '\\n');
          process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });`;
      expect(inRealNode(script, dir)).toEqual({ before: ['first'], after: ['second'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('a config event while a package download is blocked', () => {
  // The outage this guards against: the sync held the plugin lock across its downloads, so the
  // built-ins' first load queued behind it and the gateway served with an empty registry.
  it('registers the built-ins at once and finishes its effects, then the sync reloads once', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-blocked-')));
    try {
      const zipFile = path.join(dir, 'alpha.zip');
      fs.writeFileSync(zipFile, pack('alpha'));
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex');
      const script = `
        const fs = require('fs');
        const path = require('path');
        const loader = require('./src/services/pluginLoader');
        const config = require('./src/services/configService');
        const modelService = require('./src/services/modelService').default;
        const { reloadPluginsInsideLock } = require('./src/pluginInstall/reload');
        const { createPluginRuntime } = require('./src/pluginInstall/runtime');
        const dir = ${JSON.stringify(dir)};
        const plugins = path.join(dir, 'plugins');
        fs.mkdirSync(plugins);
        let cleared = 0;
        const clear = modelService.clearAllCaches.bind(modelService);
        modelService.clearAllCaches = () => { cleared++; return clear(); };
        let reloads = 0;
        let release;
        const gate = new Promise(r => { release = r; });
        let fetching;
        const fetchStarted = new Promise(r => { fetching = r; });
        const rt = createPluginRuntime({
          source: {
            list: async () => [{ id: 'alpha', version: '1.0.0', sha256: ${JSON.stringify(sha256)} }],
            fetch: async () => { fetching(); await gate; return fs.readFileSync(${JSON.stringify(zipFile)}); },
          },
          watch: true,
          pluginsDir: plugins,
          gatewayVersion: '1.0.0',
          unpackAllowed: true,
          bootWaitMs: 10,
          retryBaseMs: 1000,
          checkIntervalMs: 60000,
          reloadInsideLock: async () => { reloads++; await reloadPluginsInsideLock(); },
          pluginsLoaded: loader.hasLoadedPlugins,
          report: async () => undefined,
          onMarker: () => undefined,
          onReloaded: () => undefined,
        });
        (async () => {
          await rt.boot();
          await fetchStarted;
          const before = { loaded: loader.hasLoadedPlugins() };
          const event = JSON.stringify({ eventType: 'x', configData: { api_config: { hooks: {} } } });
          const handled = await Promise.race([
            config.handleValkeyEvent('sap-llm-gateway:config-changed', event).then(() => true),
            new Promise(r => setTimeout(() => r(false), 60000)),
          ]);
          const during = {
            handled,
            pseudonymization: Boolean(loader.getRule('pseudonymizationPlugin', 'before')),
            cleared: cleared > 0,
            reloads,
            unpacked: fs.existsSync(path.join(plugins, 'alpha')),
          };
          release();
          await rt.check();
          const after = { reloads, unpacked: fs.existsSync(path.join(plugins, 'alpha')) };
          process.stdout.write('RESULT ' + JSON.stringify({ before, during, after }) + '\\n');
          process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });`;
      expect(inRealNode(script, dir, {
        GATEWAY_STANDALONE: 'false',
        UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
        VALKEY_URL: 'redis://127.0.0.1:1',
        ADMIN_SERVICE_URL: 'http://127.0.0.1:1',
        VALIDATION_TOKEN_SECRET: 'f'.repeat(64),
        UNIFIED_AUTH_HEALTH_CHECK_INTERVAL_MS: '0',
        METADATA_ENCRYPTION_KEY: 'a'.repeat(64),
      })).toEqual({
        before: { loaded: false },
        during: { handled: true, pseudonymization: true, cleared: true, reloads: 0, unpacked: false },
        after: { reloads: 1, unpacked: true },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('hasLoadedPlugins', () => {
  it('is true after a load', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loaded-')));
    try {
      pluginLoader.loadAll(dir);
      expect(hasLoadedPlugins()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false in a fresh process until the first load', () => {
    jest.isolateModules(() => {
      const fresh = require('../src/services/pluginLoader');
      expect(fresh.hasLoadedPlugins()).toBe(false);
    });
  });
});

describe('the plugins change marker', () => {
  it('calls the handler, whatever the payload', async () => {
    const handler = jest.fn();
    setPluginsChangedHandler(handler);
    await handleValkeyEvent('sap-llm-gateway:plugins-changed', JSON.stringify({ version: 1 }));
    await handleValkeyEvent('sap-llm-gateway:plugins-changed', 'not json');
    expect(handler).toHaveBeenCalledTimes(2);
    setPluginsChangedHandler(() => undefined);
  });
});
