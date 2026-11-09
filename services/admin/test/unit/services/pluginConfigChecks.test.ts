/**
 * checkPluginConfig (spec 2026-11-04 §6): plugin settings and callback ids at validate and save.
 * The store and the gateways' status are mocked; the check reads manifests of enabled plugins only.
 */
const readEnabledManifests = jest.fn();
const readGatewayStatus = jest.fn();
jest.mock('../../../src/services/pluginStore', () => ({ readEnabledManifests: (...a: any[]) => readEnabledManifests(...a) }));
jest.mock('../../../src/services/pluginStatus', () => ({ readGatewayStatus: (...a: any[]) => readGatewayStatus(...a) }));

import { checkPluginConfig } from '../../../src/services/pluginConfigChecks';

const enabled = (id: string, settings?: Record<string, unknown>) =>
  new Map([[id, { version: '1.0.0', manifest: JSON.stringify({ id, version: '1.0.0', ...(settings ? { settings } : {}) }) }]]);
const SCHEMA = { schema: { type: 'object', properties: { retries: { type: 'number' } }, additionalProperties: false } };
const hook = (id: string) => ({ request: { callback: { id }, match: ['m'] } });
const status = (rules: string[], kind: 'installed' | 'shipped' = 'installed') => ({
  available: true,
  instances: [{ instance: 'gw', gatewayVersion: '1', at: '', plugins: [{ id: 'p', version: '1', kind, state: 'running', rules: rules.map((id) => ({ id, strategy: 'before' })) }] }],
});

beforeEach(() => {
  readEnabledManifests.mockReset().mockResolvedValue(new Map());
  readGatewayStatus.mockReset().mockResolvedValue({ instances: [], available: false });
});

describe('plugin settings', () => {
  it('an enabled plugin with settings that break its schema is an error starting with the path', async () => {
    readEnabledManifests.mockResolvedValue(enabled('acme', SCHEMA));
    const result = await checkPluginConfig({ plugins: { acme: { retries: 'many' } } });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].startsWith('/api_config/plugins/acme')).toBe(true);
    expect(result.errors[0]).toContain('retries');
  });

  it('valid settings give nothing', async () => {
    readEnabledManifests.mockResolvedValue(enabled('acme', SCHEMA));
    expect(await checkPluginConfig({ plugins: { acme: { retries: 3 } } })).toEqual({ errors: [], warnings: [] });
  });

  it('settings of a plugin that is not enabled, or unknown, are a warning only', async () => {
    readEnabledManifests.mockResolvedValue(enabled('acme', SCHEMA));
    const result = await checkPluginConfig({ plugins: { ghost: { anything: true } } });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('ghost');
  });

  it('an enabled plugin without a settings schema is not checked', async () => {
    readEnabledManifests.mockResolvedValue(enabled('acme'));
    expect(await checkPluginConfig({ plugins: { acme: { whatever: 1 } } })).toEqual({ errors: [], warnings: [] });
  });

  it('a schema with an $id can be checked again and again (a fresh Ajv each time)', async () => {
    readEnabledManifests.mockResolvedValue(enabled('acme', { schema: { $id: 'https://example.com/acme.json', type: 'object', properties: { n: { type: 'number' } } } }));
    for (let i = 0; i < 3; i += 1) {
      expect((await checkPluginConfig({ plugins: { acme: { n: 'x' } } })).errors).toHaveLength(1);
    }
  });

  it('a plugins section that is not an object is left to the schema', async () => {
    expect(await checkPluginConfig({ plugins: 'nope' })).toEqual({ errors: [], warnings: [] });
    expect(await checkPluginConfig({ plugins: [1] })).toEqual({ errors: [], warnings: [] });
    expect(readEnabledManifests).not.toHaveBeenCalled();
  });

  it('reads no manifests when the configuration has no plugin settings', async () => {
    await checkPluginConfig({ platform: {} });
    expect(readEnabledManifests).not.toHaveBeenCalled();
  });

  it('a store failure is a warning, not an error', async () => {
    readEnabledManifests.mockRejectedValue(new Error('db down'));
    const result = await checkPluginConfig({ plugins: { acme: { retries: 1 } } });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/could not be checked/i);
  });

  it('an unreadable manifest of an enabled plugin is a warning', async () => {
    readEnabledManifests.mockResolvedValue(new Map([['acme', { version: '1.0.0', manifest: '{not json' }]]));
    const result = await checkPluginConfig({ plugins: { acme: { retries: 1 } } });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('callback ids', () => {
  const config = (id: string) => ({
    hooks: { defaults: { anthropic: { invoke: [hook(id)] } } },
    models: { overrides: { 'some-model': { hooks: { invoke: [hook('modelRule')] } } } },
  });

  it('warns for a callback.id no reported rule matches, in defaults and in model overrides', async () => {
    readGatewayStatus.mockResolvedValue(status(['known']));
    const result = await checkPluginConfig(config('missing'));
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('"missing"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('"modelRule"'))).toBe(true);
  });

  it('names every unreported rule in one warning, sorted, however many there are', async () => {
    readGatewayStatus.mockResolvedValue(status(['known']));
    const ids = Array.from({ length: 20 }, (_, i) => `rule${String(i).padStart(2, '0')}`).reverse();
    const result = await checkPluginConfig({ hooks: { defaults: { anthropic: { invoke: [...ids, 'known'].map(hook) } } } });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('20 rules');
    expect(result.warnings[0]).toContain([...ids].sort().map((id) => `"${id}"`).join(', '));
    expect(result.warnings[0]).not.toContain('"known"');
  });

  it('says "a rule" when only one rule is unreported', async () => {
    readGatewayStatus.mockResolvedValue(status(['known', 'modelRule']));
    const result = await checkPluginConfig(config('missing'));
    expect(result.warnings).toEqual(['A hook names the rule "missing", which no gateway reports; the hook does nothing until a plugin provides it.']);
  });

  it('does not warn for reported ids, built-ins included', async () => {
    readGatewayStatus.mockResolvedValue(status(['shippedRule', 'modelRule'], 'shipped'));
    expect(await checkPluginConfig(config('shippedRule'))).toEqual({ errors: [], warnings: [] });
  });

  it('is skipped with no status: Valkey unavailable, or no instance reporting', async () => {
    readGatewayStatus.mockResolvedValue({ instances: [], available: false });
    expect(await checkPluginConfig(config('missing'))).toEqual({ errors: [], warnings: [] });
    readGatewayStatus.mockResolvedValue({ instances: [], available: true });
    expect(await checkPluginConfig(config('missing'))).toEqual({ errors: [], warnings: [] });
  });

  it('a status failure is a warning, not an error', async () => {
    readGatewayStatus.mockRejectedValue(new Error('valkey down'));
    const result = await checkPluginConfig(config('x'));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('reads no status when no hook names a callback', async () => {
    await checkPluginConfig({ platform: {} });
    expect(readGatewayStatus).not.toHaveBeenCalled();
  });
});
