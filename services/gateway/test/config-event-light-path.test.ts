/**
 * A change of the logging settings reaches the gateway as a configuration event that carries the
 * whole configuration. When nothing but the logging settings differs from what the gateway holds,
 * it takes the levels and reloads nothing; every other event reloads as before.
 *
 * Why the comparison and not the event's type: a gateway that missed an activation gets the new
 * configuration for the first time with such an event.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

export {};

const CHANNEL = 'sap-llm-gateway:config-changed';
const LIGHT_LINE = 'Logging settings applied without a reload';

const applyLoggingConfig = jest.fn();
const reinitialize = jest.fn();
const info = jest.fn();
const clearAllCaches = jest.fn();
const pluginsReloaded = jest.fn();
const readyHandler = jest.fn();
const getModels = jest.fn(async () => ({ object: 'list', data: [] as unknown[] }));
/** What the admin service answers to an HTTP fetch of the configuration; null = no admin client. */
let adminClient: { getActiveConfiguration: () => Promise<unknown> } | null = null;
let configService: any;

const clearSpies = (): void => {
  for (const spy of [applyLoggingConfig, reinitialize, info, clearAllCaches, pluginsReloaded, readyHandler, getModels]) spy.mockClear();
};

const config = (level: string, other: unknown = 1): any => ({
  api_config: { providers: { p: other }, platform: { logging: { defaultLevel: level, components: { A: 'WARN' } } } },
});
const activated = (configData: any) => ({ eventType: 'config-activated', configId: 'c1', configName: 'n', version: '1', checksum: 'x', configData });
const logging = (configData: any) => ({ eventType: 'logging-settings-changed', configId: 'c1', configName: 'n', version: '1', checksum: 'x', configData });
const send = (event: unknown): Promise<void> => configService.handleValkeyEvent(CHANNEL, JSON.stringify(event));
const saidLight = (): boolean => info.mock.calls.some((call) => call[1] === LIGHT_LINE);

beforeEach(() => {
  jest.resetModules();
  clearSpies();
  const quiet = { info, warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), reinitialize, applyLoggingConfig };
  jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quiet }));
  jest.doMock('../src/services/modelService', () => ({
    __esModule: true,
    default: { clearAllCaches, getModels },
  }));
  adminClient = null;
  jest.doMock('../src/clients/adminServiceClient', () => ({ get adminServiceClient() { return adminClient; } }));
  jest.dontMock('../src/services/configService');
  configService = require('../src/services/configService');
  configService.setPluginsReloadedHandler(pluginsReloaded);
  configService.onConfigurationReady(readyHandler);
});

// The gateway asks the admin service over HTTP only when it does not count as standalone, which
// it reads from the environment at the time of the call.
const ENV = ['UNIFIED_TOKEN_SYSTEM_ENABLED', 'ADMIN_SERVICE_URL', 'VALKEY_URL', 'GATEWAY_STANDALONE'] as const;
const savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
  }
});
const withAnAdminService = (): void => {
  delete process.env.GATEWAY_STANDALONE;
  process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
  process.env.ADMIN_SERVICE_URL = 'http://admin.example.org';
  process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
};

describe('a configuration event that changes only the logging settings', () => {
  it('takes the levels and reloads nothing', async () => {
    await send(activated(config('INFO')));
    clearSpies();
    await send(logging(config('DEBUG')));

    expect(applyLoggingConfig).toHaveBeenCalledTimes(1);
    expect(applyLoggingConfig).toHaveBeenCalledWith({ defaultLevel: 'DEBUG', components: { A: 'WARN' } });
    expect(reinitialize).not.toHaveBeenCalled();
    expect(pluginsReloaded).not.toHaveBeenCalled();
    expect(clearAllCaches).not.toHaveBeenCalled();
    expect(readyHandler).not.toHaveBeenCalled();
    expect(configService.getCachedConfig().api_config.platform.logging.defaultLevel).toBe('DEBUG');
    expect(saidLight()).toBe(true);
  });

  it('hands the logger the configuration\'s own levels after a reset, without the removed component', async () => {
    await send(activated(config('INFO')));
    const withComponent = config('DEBUG');
    withComponent.api_config.platform.logging.components.B = 'TRACE';
    await send(logging(withComponent));
    clearSpies();
    await send(logging(config('INFO')));

    expect(applyLoggingConfig).toHaveBeenCalledWith({ defaultLevel: 'INFO', components: { A: 'WARN' } });
    expect(pluginsReloaded).not.toHaveBeenCalled();
  });

  it('still tries to publish a model list that was not published yet, as every configuration event does', async () => {
    // The list of the first event was not publishable (no SAP models in it), so the gateway owes
    // the admin service one; the next configuration event is the retry, whatever its kind.
    await send(activated(config('INFO')));
    expect(getModels).toHaveBeenCalledTimes(1);
    clearSpies();
    await send(logging(config('DEBUG')));

    expect(getModels).toHaveBeenCalledTimes(1);
    expect(pluginsReloaded).not.toHaveBeenCalled();
    expect(saidLight()).toBe(true);
  });

  it('takes the storage switch too: the configuration read once a second holds it', async () => {
    await send(activated(config('INFO')));
    clearSpies();
    const off = config('INFO');
    off.api_config.observability = { gateway_log: { enabled: false } };
    await send(logging(off));

    expect(pluginsReloaded).not.toHaveBeenCalled();
    expect(configService.logShipperSettings().enabled).toBe(false);
  });
});

describe('a configuration event that flips only the payload capture switch', () => {
  const withCapture = (enabled: boolean | undefined): any => {
    const c = config('INFO');
    c.api_config.observability = enabled === undefined ? {} : { payload_capture: { enabled } };
    return c;
  };

  it('takes the light path: no plugin reload, no cache clear, repeated flips included', async () => {
    await send(activated(withCapture(undefined)));
    clearSpies();
    for (const enabled of [true, false, true]) await send(logging(withCapture(enabled)));

    expect(pluginsReloaded).not.toHaveBeenCalled();
    expect(clearAllCaches).not.toHaveBeenCalled();
    expect(reinitialize).not.toHaveBeenCalled();
    expect(readyHandler).not.toHaveBeenCalled();
    expect(saidLight()).toBe(true);
    expect(configService.getCachedConfig().api_config.observability.payload_capture.enabled).toBe(true);
  });

  it('takes the light path for a capture flip and a log storage flip in one event', async () => {
    const both = (capture: boolean, log: boolean): any => {
      const c = config('INFO');
      c.api_config.observability = { gateway_log: { enabled: log }, payload_capture: { enabled: capture } };
      return c;
    };
    await send(activated(both(false, true)));
    clearSpies();
    await send(logging(both(true, false)));

    expect(pluginsReloaded).not.toHaveBeenCalled();
    expect(clearAllCaches).not.toHaveBeenCalled();
    expect(saidLight()).toBe(true);
    expect(configService.logShipperSettings().enabled).toBe(false);
    expect(configService.getCachedConfig().api_config.observability.payload_capture.enabled).toBe(true);
  });

  it('still reloads when another payload_capture value changes with it', async () => {
    await send(activated(withCapture(false)));
    clearSpies();
    const changed = withCapture(true);
    changed.api_config.observability.payload_capture.retention_hours = 1;
    await send(logging(changed));

    expect(pluginsReloaded).toHaveBeenCalledTimes(1);
    expect(saidLight()).toBe(false);
  });
});

describe('every other configuration event reloads as before', () => {
  it('another change rides on a logging event (a missed activation)', async () => {
    await send(activated(config('INFO')));
    clearSpies();
    await send(logging(config('DEBUG', 2)));

    expect(pluginsReloaded).toHaveBeenCalledTimes(1);
    expect(clearAllCaches).toHaveBeenCalledTimes(1);
    expect(reinitialize).toHaveBeenCalledTimes(1);
    expect(readyHandler).toHaveBeenCalledTimes(1);
    expect(applyLoggingConfig).toHaveBeenCalledWith({ defaultLevel: 'DEBUG', components: { A: 'WARN' } });
    expect(saidLight()).toBe(false);
  });

  it('the first event a gateway receives is a logging event', async () => {
    await send(logging(config('DEBUG')));

    expect(pluginsReloaded).toHaveBeenCalledTimes(1);
    expect(clearAllCaches).toHaveBeenCalledTimes(1);
    expect(saidLight()).toBe(false);
  });

  it('an activation, also when only a level differs', async () => {
    await send(activated(config('INFO')));
    clearSpies();
    await send(activated(config('DEBUG')));

    expect(pluginsReloaded).toHaveBeenCalledTimes(1);
    expect(clearAllCaches).toHaveBeenCalledTimes(1);
    expect(saidLight()).toBe(false);
  });

  it('a logging event without a configuration: the gateway fetches it and reloads, also when only a level differs', async () => {
    await send(activated(config('INFO')));
    clearSpies();
    withAnAdminService();
    adminClient = { getActiveConfiguration: async () => ({ success: true, version: '1', config: config('DEBUG') }) };
    await send({ eventType: 'logging-settings-changed', configId: 'c1', configName: 'n', version: '1' });

    expect(configService.getCachedConfig().api_config.platform.logging.defaultLevel).toBe('DEBUG');
    expect(pluginsReloaded).toHaveBeenCalledTimes(1);
    expect(clearAllCaches).toHaveBeenCalledTimes(1);
    expect(saidLight()).toBe(false);
  });

  it('a configuration the gateway only read from its own file is not one it has taken: the first event reloads', async () => {
    // Before the admin service's first configuration, getConfig may have cached the local file,
    // which on a fresh installation equals the admin's default configuration. Nothing has been
    // reloaded for it and the configuration-ready handlers have not run.
    configService.getConfig();
    const fromFile = configService.getCachedConfig();
    expect(fromFile?.api_config).toBeDefined();
    const sameButForALevel = structuredClone(fromFile);
    sameButForALevel.api_config.platform = { ...(sameButForALevel.api_config.platform || {}) };
    sameButForALevel.api_config.platform.logging = { ...(sameButForALevel.api_config.platform.logging || {}), defaultLevel: 'TRACE' };
    clearSpies();
    await send(logging(sameButForALevel));

    expect(pluginsReloaded).toHaveBeenCalledTimes(1);
    expect(readyHandler).toHaveBeenCalledTimes(1);
    expect(saidLight()).toBe(false);
  });
});
