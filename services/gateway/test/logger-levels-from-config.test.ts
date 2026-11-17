type LoggerLib = typeof import('../../../libs/logger');

describe('the logger takes the levels of a configuration it is handed', () => {
  const savedLevel = process.env.LOG_LEVEL;
  let log: import('../../../libs/logger').Logger;

  beforeAll(() => {
    delete process.env.LOG_LEVEL;
    let lib!: LoggerLib;
    jest.isolateModules(() => {
      lib = require('../../../libs/logger');
    });
    log = lib.createLogger({ configFilePath: '/nonexistent/api_config.json', enableFileLogging: false });
  });

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    log.applyLoggingConfig(undefined);
  });

  afterEach(() => {
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  });

  it('applies the default level and the component levels', () => {
    log.applyLoggingConfig({ defaultLevel: 'WARN', components: { imagesController: 'DEBUG' } });
    expect(log.isLevelEnabled('x', 'info')).toBe(false);
    expect(log.isLevelEnabled('x', 'warn')).toBe(true);
    expect(log.isLevelEnabled('imagesController', 'debug')).toBe(true);
  });

  it('replaces the component levels on the next call and restores the constructed level on undefined', () => {
    log.applyLoggingConfig({ defaultLevel: 'WARN', components: { imagesController: 'DEBUG' } });
    log.applyLoggingConfig({ defaultLevel: 'WARN' });
    expect(log.isLevelEnabled('imagesController', 'debug')).toBe(false);
    log.applyLoggingConfig(undefined);
    expect(log.isLevelEnabled('x', 'info')).toBe(true);
    expect(log.isLevelEnabled('x', 'debug')).toBe(false);
  });

  it('keeps a valid LOG_LEVEL as the default level while the component levels still apply', () => {
    process.env.LOG_LEVEL = 'ERROR';
    log.applyLoggingConfig({ defaultLevel: 'DEBUG', components: { imagesController: 'DEBUG' } });
    expect(log.isLevelEnabled('x', 'warn')).toBe(false);
    expect(log.isLevelEnabled('imagesController', 'debug')).toBe(true);
  });

  it('ignores a level name it does not know', () => {
    log.applyLoggingConfig({ defaultLevel: 'loud', components: { imagesController: 'loud' } });
    expect(log.isLevelEnabled('x', 'info')).toBe(true);
    expect(log.isLevelEnabled('x', 'debug')).toBe(false);
    expect(log.isLevelEnabled('imagesController', 'debug')).toBe(false);
  });

  it('ignores a default level that is not text (a file-fallback configuration never checked by the schema), without throwing', () => {
    log.applyLoggingConfig({ defaultLevel: 'WARN' });
    for (const level of [3, true, {}, ['debug'], null]) {
      expect(() => log.applyLoggingConfig({ defaultLevel: level as any, components: { imagesController: 'DEBUG' } })).not.toThrow();
      expect(log.isLevelEnabled('x', 'info')).toBe(true);
      expect(log.isLevelEnabled('x', 'debug')).toBe(false);
      expect(log.isLevelEnabled('imagesController', 'debug')).toBe(true);
    }
  });

  it('reports LOG_LEVEL as fixed by the environment only when it holds a known level', () => {
    expect(log.fixedByEnvironment()).toEqual({});
    process.env.LOG_LEVEL = 'loud';
    expect(log.fixedByEnvironment()).toEqual({});
    process.env.LOG_LEVEL = 'Warn';
    expect(log.fixedByEnvironment()).toEqual({ LOG_LEVEL: 'Warn' });
  });
});

describe('the gateway hands the logging section of a received configuration to the logger', () => {
  it('does so when a configuration change event arrives', async () => {
    jest.resetModules();
    const applyLoggingConfig = jest.fn();
    const quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), reinitialize: jest.fn(), applyLoggingConfig };
    jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quiet }));
    jest.dontMock('../src/services/configService');
    const configService = require('../src/services/configService');
    const logging = { defaultLevel: 'WARN', components: { imagesController: 'DEBUG' } };
    const event = { eventType: 'config-activated', configId: 'c1', configName: 'n', version: 1, configData: { api_config: { platform: { logging } } } };
    await configService.handleValkeyEvent('sap-llm-gateway:config-changed', JSON.stringify(event));
    expect(applyLoggingConfig).toHaveBeenCalledWith(logging);
  });
});

describe('the gateway hands the logging section to the logger when getConfig fetches it from the admin service', () => {
  const saved = { v: process.env.VALKEY_URL, u: process.env.UNIFIED_TOKEN_SYSTEM_ENABLED, a: process.env.ADMIN_SERVICE_URL, s: process.env.GATEWAY_STANDALONE };
  afterEach(() => {
    for (const [k, v] of [['VALKEY_URL', saved.v], ['UNIFIED_TOKEN_SYSTEM_ENABLED', saved.u], ['ADMIN_SERVICE_URL', saved.a], ['GATEWAY_STANDALONE', saved.s]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('does so for the configuration of the HTTP fetch that getConfig starts without Valkey', async () => {
    jest.resetModules();
    const applyLoggingConfig = jest.fn();
    const quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), reinitialize: jest.fn(), applyLoggingConfig };
    const logging = { defaultLevel: 'WARN', components: { imagesController: 'DEBUG' } };
    jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quiet }));
    jest.doMock('../src/clients/adminServiceClient', () => ({
      adminServiceClient: { getActiveConfiguration: async () => ({ success: true, version: 1, config: { api_config: { platform: { logging } } } }) },
    }));
    jest.dontMock('../src/services/configService');
    // The module reads VALKEY_URL once at load (unset here); the standalone check reads the environment at call time.
    delete process.env.VALKEY_URL;
    delete process.env.GATEWAY_STANDALONE;
    const configService = require('../src/services/configService');
    process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
    process.env.ADMIN_SERVICE_URL = 'http://admin.example.org';
    process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
    configService.getConfig(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(applyLoggingConfig).toHaveBeenCalledWith(logging);
  });
});
