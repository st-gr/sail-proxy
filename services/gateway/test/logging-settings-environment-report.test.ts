/**
 * The admin service lays logging settings over the configuration it hands to the gateway. The gateway
 * tells it, in the start-up request it already publishes, which of them its environment fixes; and a
 * second configuration event of the same version reaches the logger like the first.
 */
type Quiet = Record<string, jest.Mock>;

const ENV_KEYS = ['VALKEY_URL', 'UNIFIED_TOKEN_SYSTEM_ENABLED', 'ADMIN_SERVICE_URL', 'GATEWAY_STANDALONE', 'PAYLOAD_LOGGING_ENABLED', 'GATEWAY_LOG_SHIPPING'] as const;

function loadConfigService(fixed: Record<string, string> = {}): { configService: any; quiet: Quiet } {
  jest.resetModules();
  const quiet: Quiet = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
    reinitialize: jest.fn(), applyLoggingConfig: jest.fn(), fixedByEnvironment: jest.fn(() => fixed),
  };
  jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quiet }));
  jest.dontMock('../src/services/configService');
  return { configService: require('../src/services/configService'), quiet };
}

describe('what the environment fixes', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('is empty when nothing is set', () => {
    const { configService } = loadConfigService();
    expect(configService.environmentFixedReport(process.env)).toEqual({});
  });

  it('names LOG_LEVEL as the logger reports it, PAYLOAD_LOGGING_ENABLED when set and GATEWAY_LOG_SHIPPING when off', () => {
    const { configService } = loadConfigService({ LOG_LEVEL: 'warn' });
    expect(configService.environmentFixedReport({ PAYLOAD_LOGGING_ENABLED: 'false', GATEWAY_LOG_SHIPPING: 'off' }))
      .toEqual({ LOG_LEVEL: 'warn', PAYLOAD_LOGGING_ENABLED: 'false', GATEWAY_LOG_SHIPPING: 'off' });
  });

  it('leaves GATEWAY_LOG_SHIPPING out when it does not switch shipping off', () => {
    const { configService } = loadConfigService();
    expect(configService.environmentFixedReport({ GATEWAY_LOG_SHIPPING: 'on' })).toEqual({});
  });

  it('is sent with the start-up request to the admin service', async () => {
    const published: { channel: string; message: string }[] = [];
    jest.resetModules();
    jest.doMock('iovalkey', () => class FakeValkey {
      on() { return this; }
      async subscribe() { return 0; }
      async publish(channel: string, message: string) { published.push({ channel, message }); return 1; }
      disconnect() { /* nothing open */ }
    });
    process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
    process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
    process.env.ADMIN_SERVICE_URL = 'http://admin.example.org';
    process.env.PAYLOAD_LOGGING_ENABLED = 'true';
    const quiet: Quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), reinitialize: jest.fn(), applyLoggingConfig: jest.fn(), fixedByEnvironment: jest.fn(() => ({ LOG_LEVEL: 'debug' })) };
    jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quiet }));
    jest.dontMock('../src/services/configService');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const configService = require('../src/services/configService');
    try {
      const waiting = configService.getConfigAsync();
      for (let i = 0; i < 50 && published.length === 0; i++) await new Promise((r) => setImmediate(r));
      const request = published.find((m) => m.channel === 'sap-llm-gateway:service-ready');
      expect(request).toBeDefined();
      expect(JSON.parse(request!.message)).toMatchObject({
        eventType: 'gateway-startup-request', fixedByEnvironment: { LOG_LEVEL: 'debug', PAYLOAD_LOGGING_ENABLED: 'true' }
      });
      // Answer it, so the wait ends.
      jest.doMock('../src/services/modelService', () => ({ default: { clearAllCaches: jest.fn() } }));
      await configService.handleValkeyEvent('sap-llm-gateway:config-changed', JSON.stringify({ eventType: 'config-activated', version: '1', configData: { api_config: {} } }));
      await waiting;
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      await configService.closeValkeyConnections();
    }
  });
});

describe('a gateway that was running before the admin service started', () => {
  // Its start-up request (which carries the report) was published while no admin service listened
  // and is gone. Seen 2026-11-12 on the dev stack: gateway up 9 s before the admin, and the Logs
  // page said no gateway had reported. The gateway answers the admin's start announcement with
  // the report alone, once per announcement; nothing on a timer.
  const SERVICE_READY = 'sap-llm-gateway:service-ready';
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let published: { channel: string; message: string }[];
  let subscribed: string[];
  let listeners: ((channel: string, message: string) => unknown)[];
  let configService: any;

  const deliver = async (channel: string, event: unknown): Promise<void> => {
    for (const listener of listeners) await listener(channel, JSON.stringify(event));
  };
  const reports = () => published.filter((m) => m.channel === SERVICE_READY).map((m) => JSON.parse(m.message));
  const adminStarted = { eventType: 'admin-service-started', service: 'admin-service', timestamp: '2026-11-12T21:53:43.000Z', hasActiveConfig: true };

  beforeEach(async () => {
    published = []; subscribed = []; listeners = [];
    jest.resetModules();
    jest.doMock('iovalkey', () => class FakeValkey {
      on(event: string, listener: any) { if (event === 'message') listeners.push(listener); return this; }
      async subscribe(...channels: string[]) { subscribed.push(...channels); return channels.length; }
      async publish(channel: string, message: string) { published.push({ channel, message }); return 1; }
      disconnect() { /* nothing open */ }
    });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
    process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
    process.env.ADMIN_SERVICE_URL = 'http://admin.example.org';
    process.env.PAYLOAD_LOGGING_ENABLED = 'true';
    const quiet: Quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), reinitialize: jest.fn(), applyLoggingConfig: jest.fn(), fixedByEnvironment: jest.fn(() => ({ LOG_LEVEL: 'debug' })) };
    jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quiet }));
    jest.doMock('../src/services/modelService', () => ({ default: { clearAllCaches: jest.fn(), getModels: async () => ({ object: 'list', data: [] }) } }));
    jest.dontMock('../src/services/configService');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    configService = require('../src/services/configService');
    // The gateway starts: it publishes its start-up request and waits for a configuration.
    const waiting = configService.getConfigAsync();
    for (let i = 0; i < 50 && published.length === 0; i++) await new Promise((r) => setImmediate(r));
    await deliver('sap-llm-gateway:config-changed', { eventType: 'config-activated', version: '1', configData: { api_config: {} } });
    await waiting;
    published.length = 0;
  });

  afterEach(async () => {
    jest.clearAllTimers();
    jest.useRealTimers();
    await configService.closeValkeyConnections();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('listens for the admin service\'s start announcement', () => {
    expect(subscribed).toContain(SERVICE_READY);
  });

  it('answers it with its report once, and asks for no configuration', async () => {
    await deliver(SERVICE_READY, adminStarted);
    expect(reports()).toEqual([{
      eventType: 'gateway-environment-report', service: 'gateway-service', timestamp: expect.any(String),
      fixedByEnvironment: { LOG_LEVEL: 'debug', PAYLOAD_LOGGING_ENABLED: 'true' },
    }]);
  });

  it('answers nothing else on that channel: its own request, another gateway\'s report, an unknown event', async () => {
    await deliver(SERVICE_READY, { eventType: 'gateway-startup-request', service: 'gateway-service', fixedByEnvironment: {} });
    await deliver(SERVICE_READY, { eventType: 'gateway-environment-report', service: 'gateway-service', fixedByEnvironment: {} });
    await deliver(SERVICE_READY, { eventType: 'something-else', service: 'admin-service' });
    await deliver(SERVICE_READY, { eventType: 'admin-service-started', service: 'gateway-service' });
    expect(reports()).toEqual([]);
  });

  it('sends nothing on its own: no report until the admin service announces itself, one per announcement', async () => {
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(reports()).toEqual([]);
    await deliver(SERVICE_READY, adminStarted);
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(reports()).toHaveLength(1);
    await deliver(SERVICE_READY, adminStarted); // the admin service started again
    expect(reports()).toHaveLength(2);
  });
});

describe('a configuration event of a version the gateway already has', () => {
  it('still reaches the logger with its levels', async () => {
    const { configService, quiet } = loadConfigService();
    const event = (defaultLevel: string) => JSON.stringify({
      eventType: 'logging-settings-changed', configId: 'c1', configName: 'n', version: '2026.11.111200', checksum: 'same',
      configData: { api_config: { platform: { logging: { defaultLevel } } } }
    });
    await configService.handleValkeyEvent('sap-llm-gateway:config-changed', event('INFO'));
    await configService.handleValkeyEvent('sap-llm-gateway:config-changed', event('DEBUG'));
    expect(quiet.applyLoggingConfig).toHaveBeenCalledTimes(2);
    expect(quiet.applyLoggingConfig).toHaveBeenLastCalledWith({ defaultLevel: 'DEBUG' });
  });
});
