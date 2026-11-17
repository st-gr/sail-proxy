/**
 * Every place where the admin hands the configuration to the gateway lays the logging settings over
 * it; the cockpit's read of the active configuration does not. cds.test on in-memory SQLite; the
 * publisher is a fake iovalkey whose messages are what the gateway would get (VALKEY_URL is set only
 * while the configuration service connects).
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'lh-admin@test.com': { id: 'lh-admin@test.com', roles: ['admin', 'user'] } } };

const mockValkey = { published: [] as { channel: string; message: string }[] };
jest.mock('iovalkey', () => {
  class FakeValkey {
    async ping() { return 'PONG'; }
    async get() { return null; }
    async subscribe() { return 0; }
    on() { return this; }
    async publish(channel: string, message: string) { mockValkey.published.push({ channel, message }); return 1; }
    async quit() { return 'OK'; }
    disconnect() { /* nothing open */ }
  }
  return { __esModule: true, default: FakeValkey, Redis: FakeValkey };
});

const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';
import { LOGGING_SETTINGS_ENTITY, loadLoggingSettings, loggingSettingsStore, checkLoggingSettingsExpiry, forgetLoggingSettings } from '../../../src/services/loggingSettings';

const ADMIN = { auth: { username: 'lh-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const CONFIG_CHANGE_CHANNEL = 'sap-llm-gateway:config-changed';
const OVERLAID = { defaultLevel: 'TRACE', components: { ModelService: 'WARN', ConfigService: 'DEBUG' } };
let configService: any;

/** The configuration of the last message on the configuration channel from `source`. */
const configEvents = () => mockValkey.published.filter((m) => m.channel === CONFIG_CHANGE_CHANNEL).map((m) => JSON.parse(m.message));
const handedOver = (source: string): any => {
  const events = mockValkey.published.filter((m) => m.channel === CONFIG_CHANGE_CHANNEL).map((m) => JSON.parse(m.message)).filter((e) => e.source === source);
  if (events.length === 0) throw new Error(`nothing was handed over from ${source}`);
  return events[events.length - 1].configData;
};

async function activateNew(name: string): Promise<void> {
  const config = { ...MINIMAL_DEFAULT_CONFIG, api_config: { ...MINIMAL_DEFAULT_CONFIG.api_config,
    platform: { ...(MINIMAL_DEFAULT_CONFIG.api_config as any).platform, logging: { defaultLevel: 'INFO', components: { ModelService: 'WARN' } } } } };
  const created = await POST(`${S}/createConfiguration`, { name, configData: JSON.stringify(config), description: 'test' }, ADMIN);
  const activated = await POST(`${S}/activateConfiguration`, { configId: created.data.configId }, ADMIN);
  expect(activated.data.success).toBe(true);
}

beforeAll(async () => {
  await activateNew('handover-a');
  // The settings are written straight to the table: no action, so nothing is published before the tests look.
  await cds.db.run(cds.ql.UPSERT.into(LOGGING_SETTINGS_ENTITY).entries({
    ID: 'gateway', defaultLevel: 'TRACE', componentLevels: JSON.stringify({ ConfigService: { level: 'DEBUG' } }), logStorageEnabled: true
  }));
  expect(await loadLoggingSettings()).toBe(true);
  configService = require('../../../src/srv/config-service')({ on() {}, before() {}, after() {} });
  process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
  try { await configService.initializeValkey(); } finally { delete process.env.VALKEY_URL; }
});

beforeEach(() => { mockValkey.published.length = 0; });

describe('the configuration handed to the gateway carries the logging settings', () => {
  it('in the start-up event of the admin', async () => {
    await configService.publishStartupEvent();
    const config = handedOver('admin-service-startup');
    expect(config.api_config.platform.logging).toEqual(OVERLAID);
    expect(config.api_config.observability.gateway_log.enabled).toBe(true);
  });

  it('in the answer to a starting gateway', async () => {
    await configService.handleValkeyEvent('sap-llm-gateway:service-ready',
      JSON.stringify({ eventType: 'gateway-startup-request', service: 'gateway-service', timestamp: new Date().toISOString() }));
    expect(handedOver('admin-service-republish').api_config.platform.logging).toEqual(OVERLAID);
  });

  it('in the event of an activation', async () => {
    await activateNew('handover-b');
    expect(handedOver('admin-service-activation').api_config.platform.logging).toEqual(OVERLAID);
  });

  it('in the answer to the gateway fetching it over HTTP (ValidationService.getConfig)', async () => {
    const r = await GET('/odata/v4/validation/getConfig()');
    expect(r.data.success).toBe(true);
    expect(r.data.config.api_config.platform.logging).toEqual(OVERLAID);
    expect(r.data.config.api_config.observability.gateway_log.enabled).toBe(true);
  });
});

describe('the configuration the cockpit reads does not', () => {
  it('getActiveConfiguration gives the stored configuration', async () => {
    const r = await GET(`${S}/getActiveConfiguration()`, ADMIN);
    const configData = r.data.data.configData;
    const shown = typeof configData === 'string' ? JSON.parse(configData) : configData;
    expect(shown.api_config.platform.logging).toEqual({ defaultLevel: 'INFO', components: { ModelService: 'WARN' } });
    expect(shown.api_config.observability?.gateway_log?.enabled).not.toBe(true);
  });
});

describe('the hand-overs read nothing from the database for the record', () => {
  it('an activation and the gateway\'s fetch use the record kept in memory', async () => {
    const read = jest.spyOn(loggingSettingsStore, 'readRow');
    try {
      await activateNew('handover-no-read');
      expect(handedOver('admin-service-activation').api_config.platform.logging).toEqual(OVERLAID);
      expect((await GET('/odata/v4/validation/getConfig()')).data.config.api_config.platform.logging).toEqual(OVERLAID);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});

describe('the file fallback of getConfig (no active configuration in the database)', () => {
  it('carries the overlay and leaves the cached file configuration as it was', async () => {
    const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
    const active = await cds.db.run(cds.ql.SELECT.one.from(CONFIGS).columns('ID').where({ isActive: true }));
    const fileService = require('../../../src/srv/file-config-service')({ on() {} });
    const original = fileService.getConfig.bind(fileService);
    const cached = (await original({})).config;
    const before = JSON.stringify(cached);
    const spy = jest.spyOn(fileService, 'getConfig');
    await cds.db.run(cds.ql.UPDATE(CONFIGS).set({ isActive: false }).where({ ID: active.ID }));
    try {
      const r = await GET('/odata/v4/validation/getConfig()');
      expect(spy).toHaveBeenCalled();
      expect(r.data.success).toBe(true);
      expect(r.data.config.api_config.platform.logging).toMatchObject({ defaultLevel: 'TRACE', components: expect.objectContaining({ ConfigService: 'DEBUG' }) });
      expect(r.data.config.api_config.observability.gateway_log.enabled).toBe(true);
      expect((await original({})).config).toBe(cached);
      expect(JSON.stringify(cached)).toBe(before);
    } finally {
      spy.mockRestore();
      await cds.db.run(cds.ql.UPDATE(CONFIGS).set({ isActive: true }).where({ ID: active.ID }));
    }
  });
});

describe('a record that could not be loaded at start', () => {
  it('does not stop an activation; the next check loads the record and republishes once', async () => {
    forgetLoggingSettings();
    const read = jest.spyOn(loggingSettingsStore, 'readRow').mockRejectedValueOnce(new Error('relation "sap_llm_gateway_admin_LoggingSettings" does not exist'));
    try {
      expect(await loadLoggingSettings()).toBe(false);
      await activateNew('handover-load-failed');
      const stored = await cds.db.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiConfigurations').columns('name').where({ isActive: true }));
      expect(stored.name).toBe('handover-load-failed');
      expect(handedOver('admin-service-activation').api_config.platform.logging).toEqual({ defaultLevel: 'INFO', components: { ModelService: 'WARN' } });
      mockValkey.published.length = 0;
      expect(await checkLoggingSettingsExpiry(() => configService.republishForLoggingSettings())).toBe(true);
      expect(await checkLoggingSettingsExpiry(() => configService.republishForLoggingSettings())).toBe(false);
      const events = configEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('logging-settings-changed');
      expect(events[0].configData.api_config.platform.logging).toEqual(OVERLAID);
    } finally {
      read.mockRestore();
    }
  });
});
