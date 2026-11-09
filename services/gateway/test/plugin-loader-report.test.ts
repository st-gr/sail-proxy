import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLogger }));

import pluginLoader, { getLoadReport, INSTALLED_MARKER } from '../src/services/pluginLoader';

const rule = (id: string, strategy = 'before') =>
  `{ id: ${JSON.stringify(id)}, match: [], strategy: ${JSON.stringify(strategy)}, handler: async () => ({}) }`;
const moduleSrc = (...rules: string[]) => `module.exports = [${rules.join(', ')}];\n`;

describe('plugin loader report', () => {
  let dir: string;
  const write = (rel: string, content: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const manifest = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, version: '1.0.0', runtime: 'node', gateway: '*', help: { en: { summary: 's' } }, ...extra });
  const row = (source: string) => getLoadReport().find(r => r.source === source)!;
  const ids = () => Object.values(global.pluginRegistry).map(r => `${r.id}/${r.strategy}`).sort();

  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-report-'))); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads a folder with a manifest as shipped, or installed with the marker', () => {
    write('alpha/manifest.json', manifest('alpha'));
    write('alpha/index.js', moduleSrc(rule('alpha-rule')));
    write('beta/manifest.json', manifest('beta', { version: '2.1.0' }));
    write('beta/index.js', moduleSrc(rule('beta-rule', 'after')));
    write(`beta/${INSTALLED_MARKER}`, '{}');
    pluginLoader.loadAll(dir);
    expect(ids()).toEqual(['alpha-rule/before', 'beta-rule/after']);
    expect(row('alpha')).toEqual({ source: 'alpha', id: 'alpha', version: '1.0.0', kind: 'shipped', rules: [{ id: 'alpha-rule', strategy: 'before' }] });
    expect(row('beta')).toMatchObject({ kind: 'installed', id: 'beta', version: '2.1.0' });
  });

  it('skips a folder without a manifest and never requires its files', () => {
    write('helper/index.js', 'throw new Error("must not be required");');
    write('helper/other.js', moduleSrc(rule('nope')));
    pluginLoader.loadAll(dir);
    expect(getLoadReport()).toEqual([]);
    expect(ids()).toEqual([]);
  });

  it('does not load a top-level script, and says what to do instead', () => {
    mockLogger.warn.mockClear();
    write('top.js', moduleSrc(rule('top-rule')));
    write('other.ts', 'throw new Error("must not run");');
    pluginLoader.loadAll(dir);
    expect(ids()).toEqual([]);
    expect(getLoadReport()).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith('PluginLoader', expect.stringMatching(/other\.ts.*folder.*manifest\.json/));
    expect(mockLogger.warn).toHaveBeenCalledWith('PluginLoader', expect.stringMatching(/top\.js.*folder.*manifest\.json/));
  });

  it('stays quiet about what a build or a checkout leaves beside the plugins', () => {
    mockLogger.warn.mockClear();
    write('notes.md', 'text');
    write('types.d.ts', 'export {};');
    write('top.js.map', '{}');
    pluginLoader.loadAll(dir);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('never loads .tmp', () => {
    write('.tmp/x/manifest.json', manifest('x'));
    write('.tmp/x/index.js', moduleSrc(rule('tmp-rule')));
    pluginLoader.loadAll(dir);
    expect(ids()).toEqual([]);
    expect(getLoadReport()).toEqual([]);
  });

  it('prefers index.ts over index.js in development', () => {
    write('dev/manifest.json', manifest('dev'));
    write('dev/index.js', moduleSrc(rule('from-js')));
    write('dev/index.ts', moduleSrc(rule('from-ts')));
    pluginLoader.loadAll(dir);
    expect(ids()).toEqual(['from-ts/before']);
  });

  it('gives one row per plugin and reports failures without throwing', () => {
    write('throws/manifest.json', manifest('throws'));
    write('throws/index.js', 'throw new Error("kaput");');
    write('notarray/manifest.json', manifest('notarray'));
    write('notarray/index.js', 'module.exports = { a: 1 };');
    write('noindex/manifest.json', manifest('noindex'));
    write('badmanifest/manifest.json', '{ not json');
    write('badmanifest/index.js', moduleSrc(rule('never')));
    write('good/manifest.json', manifest('good'));
    write('good/index.js', moduleSrc(rule('good-rule')));
    expect(() => pluginLoader.loadAll(dir)).not.toThrow();
    const report = getLoadReport();
    expect(report).toHaveLength(5);
    expect(row('throws').error).toMatch(/kaput/);
    expect(row('notarray').error).toBeTruthy();
    expect(row('noindex').error).toMatch(/index/);
    expect(row('badmanifest').error).toBeTruthy();
    expect(row('good').error).toBeUndefined();
    expect(ids()).toEqual(['good-rule/before']);
  });

  it('does not load a folder whose runtime is not node', () => {
    write('py/manifest.json', manifest('py', { runtime: 'python' }));
    write('py/index.js', moduleSrc(rule('py-rule')));
    pluginLoader.loadAll(dir);
    expect(row('py').error).toMatch(/runtime/);
    expect(ids()).toEqual([]);
  });

  describe('rule id conflicts', () => {
    it('drops an installed rule that duplicates a shipped id and strategy', () => {
      write('shipped/manifest.json', manifest('shipped'));
      write('shipped/index.js', moduleSrc(rule('dup')));
      write('other/manifest.json', manifest('other'));
      write('other/index.js', moduleSrc(rule('dup2', 'after')));
      write('inst/manifest.json', manifest('inst'));
      write('inst/index.js', moduleSrc(rule('dup'), rule('dup2', 'after'), rule('dup2', 'before'), rule('own')));
      write(`inst/${INSTALLED_MARKER}`, '{}');
      pluginLoader.loadAll(dir);
      expect(ids()).toEqual(['dup/before', 'dup2/after', 'dup2/before', 'own/before']);
      expect(row('inst').error).toMatch(/dup/);
      expect(row('inst').rules).toEqual([{ id: 'dup2', strategy: 'before' }, { id: 'own', strategy: 'before' }]);
      expect(row('shipped').error).toBeUndefined();
      expect(row('other').error).toBeUndefined();
    });

    it('never drops a non-installed rule, whatever the directory order', () => {
      write('a/manifest.json', manifest('a'));
      write('a/index.js', moduleSrc(rule('same')));
      write('b/manifest.json', manifest('b'));
      write('b/index.js', moduleSrc(rule('same')));
      pluginLoader.loadAll(dir);
      expect(ids()).toEqual(['same/before', 'same/before']);
      expect(getLoadReport().every(r => !r.error)).toBe(true);
    });

    it('drops the later of two installed plugins with the same rule, independent of order', () => {
      for (const name of ['zz', 'aa']) {
        write(`${name}/manifest.json`, manifest(name));
        write(`${name}/index.js`, moduleSrc(rule('clash')));
        write(`${name}/${INSTALLED_MARKER}`, '{}');
      }
      pluginLoader.loadAll(dir);
      expect(ids()).toEqual(['clash/before']);
      expect(row('aa').error).toBeUndefined();
      expect(row('zz').error).toMatch(/clash/);
    });
  });
});
