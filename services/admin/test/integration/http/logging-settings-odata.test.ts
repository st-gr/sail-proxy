/**
 * Logging switches and levels outside the configuration versions, over OData (cds.test, in-memory
 * SQLite, mocked users; runs bare). The publisher is a fake iovalkey whose published messages the
 * tests read: what the gateway would get. VALKEY_URL is set only while the configuration service
 * connects, so no other service of the admin opens a client.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'ls-admin@test.com': { id: 'ls-admin@test.com', roles: ['admin', 'user'] },
  'ls-user@test.com': { id: 'ls-user@test.com', roles: ['user'] } } };

const mockValkey = { published: [] as { channel: string; message: string }[], fail: false };
jest.mock('iovalkey', () => {
  class FakeValkey {
    async ping() { return 'PONG'; }
    async get() { return null; }
    async subscribe() { return 0; }
    on() { return this; }
    async publish(channel: string, message: string) {
      if (mockValkey.fail) throw new Error('Connection is closed.');
      mockValkey.published.push({ channel, message });
      return 1;
    }
    async quit() { return 'OK'; }
    disconnect() { /* nothing open */ }
  }
  return { __esModule: true, default: FakeValkey, Redis: FakeValkey };
});

const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';
import { sealKeyStatus } from '@libs/trace-seal';
import { startLoggingSettingsExpiry, loadLoggingSettings, LOGGING_SETTINGS_ENTITY } from '../../../src/services/loggingSettings';

const ADMIN = { auth: { username: 'ls-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'ls-user@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const CONFIG_CHANGE_CHANNEL = 'sap-llm-gateway:config-changed';
let configService: any;

/** The configuration of the last message on the configuration channel: what the gateway got. */
const lastHandedOver = (): any => {
  const events = mockValkey.published.filter((m) => m.channel === CONFIG_CHANGE_CHANNEL);
  if (events.length === 0) throw new Error('nothing was handed over');
  return JSON.parse(events[events.length - 1].message).configData;
};
const handedOverCount = () => mockValkey.published.filter((m) => m.channel === CONFIG_CHANGE_CHANNEL).length;
const auditRows = async () => cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'logging.settings.change' }));
const set = (body: any, who: any = ADMIN) => POST(`${S}/setLoggingSettings`, body, who);

async function activateNew(name: string, logging: any): Promise<void> {
  const config = { ...MINIMAL_DEFAULT_CONFIG, api_config: { ...MINIMAL_DEFAULT_CONFIG.api_config,
    platform: { ...(MINIMAL_DEFAULT_CONFIG.api_config as any).platform, logging } } };
  const created = await POST(`${S}/createConfiguration`, { name, configData: JSON.stringify(config), description: 'test' }, ADMIN);
  expect(created.data.success).toBe(true);
  const activated = await POST(`${S}/activateConfiguration`, { configId: created.data.configId }, ADMIN);
  expect(activated.data.success).toBe(true);
}

beforeAll(async () => {
  await activateNew('logging-settings-a', { defaultLevel: 'INFO', components: { ModelService: 'WARN' } });
  configService = require('../../../src/srv/config-service')({ on() {}, before() {}, after() {} });
  process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
  try { await configService.initializeValkey(); } finally { delete process.env.VALKEY_URL; }
  expect(configService.isValkeyAvailable).toBe(true);
});

beforeEach(async () => {
  mockValkey.published.length = 0;
  mockValkey.fail = false;
  await cds.db.run(cds.ql.DELETE.from(LOGGING_SETTINGS_ENTITY));
  await loadLoggingSettings();
  await cds.db.run(cds.ql.DELETE.from(AUDIT));
});

describe('who may use the logging settings', () => {
  it('refuses a user with 403 on all three actions', async () => {
    expect((await ok(GET(`${S}/getLoggingSettings()`, USER))).status).toBe(403);
    expect((await ok(set({ defaultLevel: 'DEBUG' }, USER))).status).toBe(403);
    expect((await ok(POST(`${S}/resetLoggingSettings`, {}, USER))).status).toBe(403);
  });
});

describe('setLoggingSettings and resetLoggingSettings', () => {
  it('hands the level to the gateway while the cockpit read of the active configuration stays without it', async () => {
    const r = await set({ defaultLevel: 'debug', componentLevels: JSON.stringify({ ConfigService: { level: 'TRACE' } }) });
    expect(r.status).toBe(200);
    expect(r.data.warning).toBeNull();
    expect(lastHandedOver().api_config.platform.logging).toEqual({ defaultLevel: 'DEBUG', components: { ModelService: 'WARN', ConfigService: 'TRACE' } });

    const cockpit = await GET(`${S}/getActiveConfiguration()`, ADMIN);
    const configData = cockpit.data.data.configData;
    const shown = typeof configData === 'string' ? JSON.parse(configData) : configData;
    expect(shown.api_config.platform.logging).toEqual({ defaultLevel: 'INFO', components: { ModelService: 'WARN' } });
    const stored = await cds.db.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiConfigurations').where({ isActive: true }));
    expect(JSON.parse(stored.configData).api_config.platform.logging.defaultLevel).toBe('INFO');
  });

  it('creates no configuration version', async () => {
    const before = await cds.db.run(cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations').columns('ID', 'version', 'isActive', 'modifiedAt'));
    await set({ defaultLevel: 'WARN' });
    await POST(`${S}/resetLoggingSettings`, {}, ADMIN);
    expect(await cds.db.run(cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations').columns('ID', 'version', 'isActive', 'modifiedAt'))).toEqual(before);
  });

  it('still hands the level over after another configuration is activated', async () => {
    await set({ defaultLevel: 'TRACE' });
    await activateNew('logging-settings-b', { defaultLevel: 'ERROR' });
    expect(lastHandedOver().api_config.platform.logging.defaultLevel).toBe('TRACE');
  });

  it('removes the settings with resetLoggingSettings', async () => {
    await set({ defaultLevel: 'TRACE', logStorageEnabled: true });
    const r = await POST(`${S}/resetLoggingSettings`, {}, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ defaultLevel: null, logStorageEnabled: null, componentLevels: [] });
    const handed = lastHandedOver();
    expect(handed.api_config.platform.logging.defaultLevel).not.toBe('TRACE');
    expect(handed.api_config.observability?.gateway_log?.enabled).not.toBe(true);
  });

  it('records one audit event per change with the actor and the changed fields', async () => {
    await set({ defaultLevel: 'DEBUG' });
    let rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe('ls-admin@test.com');
    expect(JSON.parse(rows[0].details).changed).toEqual({ defaultLevel: { old: null, new: 'DEBUG' } });
    await POST(`${S}/resetLoggingSettings`, {}, ADMIN);
    rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => JSON.parse(r.details).changed)).toContainEqual({ defaultLevel: { old: 'DEBUG', new: null } });
  });

  it('returns the record, the configuration\'s own values and that no gateway has reported yet', async () => {
    const r = await set({ logStorageEnabled: false, defaultLevel: 'WARN', defaultLevelMinutes: 30, componentLevels: JSON.stringify({ A: { level: 'DEBUG', minutes: 5 } }) });
    expect(r.data).toMatchObject({
      logStorageEnabled: false, defaultLevel: 'WARN', configurationDefaultLevel: 'ERROR', configurationLogStorageEnabled: true,
      configurationStoredLevel: 'INFO', environmentReported: false, environmentReportedAt: null, environmentFixed: [], warning: null
    });
    expect(new Date(r.data.defaultLevelUntil).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(r.data.componentLevels).toEqual([{ component: 'A', level: 'DEBUG', until: expect.any(String) }]);
    const read = await GET(`${S}/getLoggingSettings()`, ADMIN);
    expect(read.data).toMatchObject({ defaultLevel: 'WARN', componentLevels: [{ component: 'A', level: 'DEBUG' }] });
  });

  describe('the payload capture switch', () => {
    it('is laid over the configuration handed to the gateway, and the active configuration read stays as it was', async () => {
      const r = await set({ payloadCaptureEnabled: true });
      expect(r.data).toMatchObject({ payloadCaptureEnabled: true, configurationPayloadCaptureEnabled: false, traceKeyStatus: sealKeyStatus(process.env) });
      expect(lastHandedOver().api_config.observability.payload_capture.enabled).toBe(true);
      const active = await GET(`${S}/getActiveConfiguration()`, ADMIN);
      const configData = active.data.data.configData;
      const shown = typeof configData === 'string' ? JSON.parse(configData) : configData;
      expect(shown.api_config).toBeDefined();
      expect(shown.api_config.observability?.payload_capture?.enabled).not.toBe(true);
      const stored = await cds.db.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiConfigurations').columns('configData').where({ isActive: true }));
      expect(JSON.parse(stored.configData).api_config.observability?.payload_capture?.enabled).not.toBe(true);
    });

    it('is left alone when null, and reset takes it back', async () => {
      await set({ payloadCaptureEnabled: true });
      expect((await set({ defaultLevel: 'WARN' })).data.payloadCaptureEnabled).toBeNull();
      expect(lastHandedOver().api_config.observability?.payload_capture?.enabled).not.toBe(true);
      await set({ payloadCaptureEnabled: true });
      const reset = await POST(`${S}/resetLoggingSettings`, {}, ADMIN);
      expect(reset.data.payloadCaptureEnabled).toBeNull();
      expect(lastHandedOver().api_config.observability?.payload_capture?.enabled).not.toBe(true);
    });

    it('is named in the audit details', async () => {
      const before = (await auditRows()).length;
      await set({ payloadCaptureEnabled: true });
      const rows = await auditRows();
      expect(rows).toHaveLength(before + 1);
      expect(rows.map((x: any) => JSON.parse(x.details).changed)).toContainEqual({ payloadCaptureEnabled: { old: null, new: true } });
    });

    it.each([
      ['missing', undefined],
      ['too-short', 'short'],
      ['publicly-known', 'dev-key-change-in-production'],
      ['strong', 'x'.repeat(48)]
    ])('getLoggingSettings reports traceKeyStatus %s for that METADATA_ENCRYPTION_KEY', async (status, value) => {
      const saved = process.env.METADATA_ENCRYPTION_KEY;
      try {
        if (value === undefined) delete process.env.METADATA_ENCRYPTION_KEY; else process.env.METADATA_ENCRYPTION_KEY = value;
        expect((await GET(`${S}/getLoggingSettings()`, ADMIN)).data.traceKeyStatus).toBe(status);
      } finally {
        if (saved === undefined) delete process.env.METADATA_ENCRYPTION_KEY; else process.env.METADATA_ENCRYPTION_KEY = saved;
      }
    });

    it('is reported by getLoggingSettings with the key status', async () => {
      await set({ payloadCaptureEnabled: false });
      const read = await GET(`${S}/getLoggingSettings()`, ADMIN);
      expect(read.data).toMatchObject({ payloadCaptureEnabled: false, configurationPayloadCaptureEnabled: false, traceKeyStatus: sealKeyStatus(process.env) });
    });
  });

  it('refreshes the record in memory, so the very next hand-over carries the new value', async () => {
    await set({ defaultLevel: 'WARN' });
    mockValkey.fail = true; // no publish: the next hand-over is the gateway's own fetch
    await set({ defaultLevel: 'TRACE' });
    const fetched = await GET('/odata/v4/validation/getConfig()');
    expect(fetched.data.config.api_config.platform.logging.defaultLevel).toBe('TRACE');
    expect((await GET(`${S}/getLoggingSettings()`, ADMIN)).data.defaultLevel).toBe('TRACE');
  });

  it('keeps the record written and answers with a warning when the publish fails', async () => {
    mockValkey.fail = true;
    const r = await set({ defaultLevel: 'DEBUG' });
    expect(r.status).toBe(200);
    expect(r.data.warning).toMatch(/saved/);
    const row = await cds.db.run(cds.ql.SELECT.one.from(LOGGING_SETTINGS_ENTITY).where({ ID: 'gateway' }));
    expect(row.defaultLevel).toBe('DEBUG');
    const de = await set({ defaultLevel: 'DEBUG' }, { ...ADMIN, headers: { 'Accept-Language': 'de' } });
    expect(de.data.warning).toMatch(/gespeichert/);
  });

  it('republishes once without the level when defaultLevelMinutes has run out', async () => {
    await set({ defaultLevel: 'DEBUG', defaultLevelMinutes: 60 });
    expect(lastHandedOver().api_config.platform.logging.defaultLevel).toBe('DEBUG');
    const count = handedOverCount();
    const handle = startLoggingSettingsExpiry(() => configService.republishForLoggingSettings(), { allowInTest: true, intervalMs: 25 });
    jest.useFakeTimers({ now: Date.now() + 61 * 60_000, doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      const deadline = performance.now() + 3000;
      while (handedOverCount() === count && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      handle!.stop();
      jest.useRealTimers();
    }
    expect(handedOverCount()).toBe(count + 1);
    expect(lastHandedOver().api_config.platform.logging.defaultLevel).toBe('ERROR');
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('validation over OData', () => {
  const refused = async (body: any, headers: any = {}) => {
    const r = await ok(set(body, { ...ADMIN, headers }));
    expect(r.status).toBe(400);
    return r.data.error.message as string;
  };

  it('answers 400 with a message that names the offending value', async () => {
    expect(await refused({ defaultLevel: 'loud' })).toContain('loud');
    expect(await refused({ defaultLevel: 'DEBUG', defaultLevelMinutes: 1441 })).toContain('1441');
    expect(await refused({ defaultLevelMinutes: 5 })).toMatch(/default level/i);
    expect(await refused({ componentLevels: '[1]' })).toMatch(/JSON object/);
    expect(await refused({ componentLevels: JSON.stringify({ 'bad\u0007name': { level: 'DEBUG' } }) })).toContain('bad\\u0007name');
    expect(await refused({ componentLevels: JSON.stringify({ A: 'DEBUG' }) })).toContain('"A"');
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`c${i}`, { level: 'DEBUG' }]));
    expect(await refused({ componentLevels: JSON.stringify(many) })).toContain('51');
    expect(await auditRows()).toHaveLength(0);
    expect(handedOverCount()).toBe(0);
  });

  it('answers in the user\'s language', async () => {
    expect(await refused({ defaultLevel: 'loud' }, { 'Accept-Language': 'de' })).toMatch(/Protokollstufe.*loud/);
  });
});

describe('gatewayLogComponents', () => {
  const LOG = 'sap.llm.gateway.admin.GatewayLogEntries';
  const entry = (i: number, component: string | null) => ({
    ID: `glc-${i}`, loggedAt: new Date(Date.now() - i * 1000).toISOString(), seq: i, level: 'INFO', component, requestId: null, message: `m${i}`
  });
  beforeEach(async () => {
    await cds.db.run(cds.ql.DELETE.from(LOG));
    await cds.db.run(cds.ql.INSERT.into(LOG).entries([
      entry(1, 'openaiController'), entry(2, 'ConfigService'), entry(3, 'openaiController'), entry(4, null), entry(5, ''), entry(6, 'PayloadLogger')]));
  });
  afterAll(async () => { await cds.db.run(cds.ql.DELETE.from(LOG)); });

  it('names each component of the stored log once, sorted, without empty names', async () => {
    const r = await GET(`${S}/gatewayLogComponents()`, ADMIN);
    expect(r.data.value).toEqual(['ConfigService', 'openaiController', 'PayloadLogger']);
  });

  it('is empty when nothing is stored', async () => {
    await cds.db.run(cds.ql.DELETE.from(LOG));
    expect((await GET(`${S}/gatewayLogComponents()`, ADMIN)).data.value).toEqual([]);
  });

  it('refuses a user', async () => {
    expect((await ok(GET(`${S}/gatewayLogComponents()`, USER))).status).toBe(403);
  });
});

describe('what the environment fixes', () => {
  const report = (fixedByEnvironment: any) => configService.handleValkeyEvent('sap-llm-gateway:service-ready',
    JSON.stringify({ eventType: 'gateway-startup-request', service: 'gateway-service', timestamp: new Date().toISOString(), fixedByEnvironment }));

  it('stores the report without an audit event and without a republish of its own', async () => {
    await report({ LOG_LEVEL: 'warn', PAYLOAD_LOGGING_ENABLED: 'true' });
    expect(await auditRows()).toHaveLength(0);
    expect(handedOverCount()).toBe(1); // the configuration the starting gateway asked for, nothing more
    const r = await GET(`${S}/getLoggingSettings()`, ADMIN);
    expect(r.data.environmentReported).toBe(true);
    expect(r.data.environmentReportedAt).toBeTruthy();
    expect(r.data.environmentFixed).toEqual(expect.arrayContaining([{ variable: 'LOG_LEVEL', value: 'warn' }, { variable: 'PAYLOAD_LOGGING_ENABLED', value: 'true' }]));
  });

  describe('the file payload logger (PAYLOAD_LOGGING_ENABLED, payload_logging_enabled)', () => {
    const fileLogging = async () => (await GET(`${S}/getLoggingSettings()`, ADMIN)).data.payloadFileLoggingEnabled;

    it('is off when neither the variable nor the configuration switches it on', async () => {
      await report({});
      expect(await fileLogging()).toBe(false);
    });

    it('is on when the gateway reports PAYLOAD_LOGGING_ENABLED=true', async () => {
      await report({ PAYLOAD_LOGGING_ENABLED: 'true' });
      expect(await fileLogging()).toBe(true);
    });

    it('follows the configuration key when the variable is not set, and the variable overrules it', async () => {
      await activateNew('logging-file-on', { defaultLevel: 'INFO', payload_logging_enabled: true });
      await report({});
      expect(await fileLogging()).toBe(true);
      await report({ PAYLOAD_LOGGING_ENABLED: 'false' });
      expect(await fileLogging()).toBe(false);
    });
  });

  it('refuses a default level while LOG_LEVEL is fixed, naming the variable, and accepts a component level', async () => {
    await report({ LOG_LEVEL: 'warn' });
    const r = await ok(set({ defaultLevel: 'DEBUG' }));
    expect(r.status).toBe(400);
    expect(r.data.error.message).toContain('LOG_LEVEL');
    expect((await set({ componentLevels: JSON.stringify({ ConfigService: { level: 'DEBUG' } }) })).status).toBe(200);
  });

  it('refuses switching storage on while GATEWAY_LOG_SHIPPING is off, naming the variable', async () => {
    await report({ GATEWAY_LOG_SHIPPING: 'off' });
    const r = await ok(set({ logStorageEnabled: true }));
    expect(r.status).toBe(400);
    expect(r.data.error.message).toContain('GATEWAY_LOG_SHIPPING');
    expect((await set({ logStorageEnabled: false })).status).toBe(200);
  });

  describe('from a gateway that was running before the admin service started', () => {
    // Its start-up request was published while no admin service listened, and is gone. It
    // answers the admin service's start announcement with the report alone.
    const lateReport = (event: any) => configService.handleValkeyEvent('sap-llm-gateway:service-ready', JSON.stringify(event));

    it('stores the report, and republishes nothing: the gateway has its configuration already', async () => {
      await lateReport({ eventType: 'gateway-environment-report', service: 'gateway-service', timestamp: new Date().toISOString(), fixedByEnvironment: { LOG_LEVEL: 'debug' } });
      expect(handedOverCount()).toBe(0);
      expect(await auditRows()).toHaveLength(0);
      const r = await GET(`${S}/getLoggingSettings()`, ADMIN);
      expect(r.data.environmentReported).toBe(true);
      expect(r.data.environmentFixed).toEqual([{ variable: 'LOG_LEVEL', value: 'debug' }]);
      expect((await ok(set({ defaultLevel: 'TRACE' }))).status).toBe(400);
    });

    it('takes a report only from a gateway', async () => {
      await lateReport({ eventType: 'gateway-environment-report', service: 'admin-service', fixedByEnvironment: { LOG_LEVEL: 'debug' } });
      await lateReport({ eventType: 'gateway-environment-report', fixedByEnvironment: { LOG_LEVEL: 'debug' } });
      const r = await GET(`${S}/getLoggingSettings()`, ADMIN);
      expect(r.data.environmentReported).toBe(false);
      expect(handedOverCount()).toBe(0);
    });
  });
});
