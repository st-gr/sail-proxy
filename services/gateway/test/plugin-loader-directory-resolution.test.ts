/**
 * The plugins directory must be found from the module's own location, never
 * from `process.cwd()`.
 *
 * Regression for a deployment-parity defect: the npm-dist standalone CLI spawns
 * the bundled gateway with `cwd = bundled/gateway`, while the compiled plugins
 * land in `bundled/gateway/services/gateway/src/plugins`. With the old
 * cwd-relative `loadAll('./src/plugins')` the loader looked in
 * `bundled/gateway/src/plugins`, created that empty, and registered 0 rules — so
 * pseudonymization and every other hook plugin never ran in that deployment.
 * Docker papered over the same bug with a symlink (docker/gateway.Dockerfile);
 * only local dev, which happens to start in `services/gateway`, ever worked by
 * accident.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import pluginLoader, { DEFAULT_PLUGINS_DIR } from '../src/services/pluginLoader';

const SRC_PLUGINS = path.resolve(__dirname, '..', 'src', 'plugins');

describe('plugin directory resolution', () => {
  const originalCwd = process.cwd();
  let elsewhere: string;

  beforeAll(() => {
    // realpath: macOS hands out /var/folders/… which is a symlink to /private/var,
    // and process.cwd() reports the resolved form.
    elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cwd-')));
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('anchors the default plugins directory on the module, not the cwd', () => {
    expect(DEFAULT_PLUGINS_DIR).toBe(SRC_PLUGINS);

    // The invariant that makes this correct in the compiled layouts too: the
    // loader lives in `<gateway-src>/services/`, so its sibling is the plugins
    // directory whether `<gateway-src>` is `services/gateway/src` (dev),
    // `.../dist/services/gateway/src` (docker) or
    // `bundled/gateway/services/gateway/src` (npm-dist CLI).
    const loaderDir = path.dirname(require.resolve('../src/services/pluginLoader'));
    expect(path.basename(loaderDir)).toBe('services');
    expect(DEFAULT_PLUGINS_DIR).toBe(path.resolve(loaderDir, '..', 'plugins'));
  });

  it('resolves a relative directory against the module, not the cwd', () => {
    process.chdir(elsewhere);

    // '../plugins' from `<gateway-src>/services/` — the same place, spelled
    // relatively. Under the old cwd-based rule this would have pointed at the
    // temp directory's parent.
    const registry = pluginLoader.loadAll('../plugins');

    expect(Object.keys(registry).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(elsewhere, 'plugins'))).toBe(false);
    expect(fs.existsSync(path.join(elsewhere, 'src'))).toBe(false);
  });

  it('loads the shipped rules from an unrelated cwd', () => {
    process.chdir(elsewhere);

    const registry = pluginLoader.loadAll();

    expect(Object.keys(registry).length).toBeGreaterThan(0);
    expect(pluginLoader.getRule('pseudonymizationPlugin', 'before')).not.toBeNull();

    // The old failure mode was silent: a missing directory got created empty and
    // the count came back 0. Nothing may be created next to the cwd.
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});
