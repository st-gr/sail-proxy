/**
 * The parts of the plugin store that need no database: the setting, the admin's own version, the
 * gateways' status reports (readGatewayStatus) and the hook scan. Database behaviour is covered by
 * test/plugins-rest-api.test.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
const scanJson = jest.fn();
jest.mock('../../../src/services/quotaStateStore', () => ({ quotaStateStore: { scanJson: (...a: any[]) => scanJson(...a), publish: jest.fn() } }));

import { isInstallEnabled } from '../../../src/services/pluginStore';
import { PLUGIN_STATUS_PREFIX, readGatewayStatus, reportedRuleIds, shippedIds } from '../../../src/services/pluginStatus';
import { readAdminVersion } from '../../../src/services/adminVersion';
import { callbackIds } from '../../../src/services/pluginConfigRefs';

describe('isInstallEnabled', () => {
  const saved = process.env.INSTALLED_PLUGINS_ENABLED;
  afterEach(() => { if (saved === undefined) delete process.env.INSTALLED_PLUGINS_ENABLED; else process.env.INSTALLED_PLUGINS_ENABLED = saved; });

  it('is on when unset, and for anything but false', () => {
    delete process.env.INSTALLED_PLUGINS_ENABLED;
    expect(isInstallEnabled()).toBe(true);
    for (const v of ['', 'true', '0', 'no', 'off']) {
      process.env.INSTALLED_PLUGINS_ENABLED = v;
      expect(isInstallEnabled()).toBe(true);
    }
  });

  it('is off for false in any case', () => {
    for (const v of ['false', 'FALSE', ' False ']) {
      process.env.INSTALLED_PLUGINS_ENABLED = v;
      expect(isInstallEnabled()).toBe(false);
    }
  });
});

describe('readAdminVersion', () => {
  it("reads the nearest package.json named admin, not npm_package_version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    process.env.npm_package_version = '9.9.9';
    expect(readAdminVersion(__dirname)).toBe(pkg.version);
    delete process.env.npm_package_version;
  });

  it('walks past a package.json with another name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-version-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'admin', version: '3.2.1' }));
    fs.mkdirSync(path.join(root, 'dist/sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }));
    expect(readAdminVersion(path.join(root, 'dist/sub'))).toBe('3.2.1');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('readGatewayStatus', () => {
  beforeEach(() => scanJson.mockReset());

  it('no key at all: available, no instances', async () => {
    scanJson.mockResolvedValue([]);
    expect(await readGatewayStatus()).toEqual({ instances: [], available: true });
    expect(scanJson).toHaveBeenCalledWith(`${PLUGIN_STATUS_PREFIX}*`);
  });

  it('no Valkey: not available', async () => {
    scanJson.mockResolvedValue(null);
    expect(await readGatewayStatus()).toEqual({ instances: [], available: false });
  });

  it('reads the gateway reporter shape, keeps an empty version, skips what is not a report', async () => {
    scanJson.mockResolvedValue([
      { key: `${PLUGIN_STATUS_PREFIX}gw-1`, value: {
        gatewayVersion: '0.11.0', at: '2026-11-04T10:00:00.000Z',
        plugins: [
          { id: 'acme', version: '1.0.0', kind: 'installed', state: 'running', rules: [{ id: 'acmeRule', strategy: 'anthropic' }] },
          { id: 'broken', version: '', kind: 'installed', state: 'failed', error: 'unreadable zip', rules: [] },
          { id: 'pseudonymizationPlugin', version: '', kind: 'shipped', state: 'running', rules: [{ id: 'pseudo', strategy: 'anthropic' }] },
        ],
      } },
      { key: `${PLUGIN_STATUS_PREFIX}gw-2`, value: 'not an object' },
      { key: `${PLUGIN_STATUS_PREFIX}gw-3`, value: { plugins: 'nope' } },
    ]);
    const { instances, available } = await readGatewayStatus();
    expect(available).toBe(true);
    expect(instances.map((i) => i.instance)).toEqual(['gw-1']);
    expect(instances[0].plugins[1]).toMatchObject({ id: 'broken', version: '', state: 'failed', error: 'unreadable zip' });
    expect([...shippedIds(instances)].sort()).toEqual(['pseudonymizationPlugin']);
    expect([...reportedRuleIds(instances, 'acme')]).toEqual(['acmeRule']);
    expect([...reportedRuleIds(instances, 'unknown')]).toEqual([]);
  });
});

describe('callbackIds', () => {
  it('finds every callback id in a configuration', () => {
    const config = { api_config: { hooks: { defaults: { anthropic: { invoke: [{ request: { callback: { id: 'a' } } }, { response: { callback: { id: 'b' } } }] } } },
      models: { m: { hooks: { invoke: [{ request: { callback: { id: 'c' } } }] } } } } };
    expect([...callbackIds(config)].sort()).toEqual(['a', 'b', 'c']);
  });
});
