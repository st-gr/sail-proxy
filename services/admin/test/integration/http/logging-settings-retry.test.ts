/**
 * "What the gateway last got" changes only with a Valkey publish that succeeded. With Valkey
 * configured, the gateway's own HTTP fetch (getConfig) does not count: with several gateways, one
 * fetch would end the retries for the gateways that only listen to the events. cds.test on in-memory
 * SQLite; the publisher is a fake iovalkey that can be made to fail (VALKEY_URL is set only while the
 * configuration service connects).
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'lr-admin@test.com': { id: 'lr-admin@test.com', roles: ['admin', 'user'] } } };

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
import { checkLoggingSettingsExpiry } from '../../../src/services/loggingSettings';

const ADMIN = { auth: { username: 'lr-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const CONFIG_CHANGE_CHANNEL = 'sap-llm-gateway:config-changed';
let configService: any;

const lastHandedOver = (): any => {
  const events = mockValkey.published.filter((m) => m.channel === CONFIG_CHANGE_CHANNEL);
  if (events.length === 0) throw new Error('nothing was handed over');
  return JSON.parse(events[events.length - 1].message).configData;
};

/** Date only: timers stay real, so the database and the publish go on as usual. */
const atMinutesFromNow = (minutes: number) => jest.useFakeTimers({
  now: Date.now() + minutes * 60_000,
  doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
});

beforeAll(async () => {
  const config = { ...MINIMAL_DEFAULT_CONFIG, api_config: { ...MINIMAL_DEFAULT_CONFIG.api_config,
    platform: { ...(MINIMAL_DEFAULT_CONFIG.api_config as any).platform, logging: { defaultLevel: 'ERROR' } } } };
  const created = await POST(`${S}/createConfiguration`, { name: 'retry-a', configData: JSON.stringify(config), description: 'test' }, ADMIN);
  expect((await POST(`${S}/activateConfiguration`, { configId: created.data.configId }, ADMIN)).data.success).toBe(true);
  configService = require('../../../src/srv/config-service')({ on() {}, before() {}, after() {} });
  process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
  try { await configService.initializeValkey(); } finally { delete process.env.VALKEY_URL; }
  expect(configService.isValkeyAvailable).toBe(true);
});

afterEach(() => { jest.useRealTimers(); mockValkey.fail = false; });

describe('with Valkey configured', () => {
  it('a getConfig answer after a failed run-out publish does not stop the next check from trying again', async () => {
    const set = await POST(`${S}/setLoggingSettings`, { defaultLevel: 'DEBUG', defaultLevelMinutes: 60 }, ADMIN);
    expect(set.data.warning).toBeNull();
    expect(lastHandedOver().api_config.platform.logging.defaultLevel).toBe('DEBUG');

    const republish = jest.fn(() => configService.republishForLoggingSettings());
    atMinutesFromNow(61);
    mockValkey.fail = true;
    expect(await checkLoggingSettingsExpiry(republish)).toBe(false);
    expect(republish).toHaveBeenCalledTimes(1);

    // The gateway fetches over HTTP and gets the configuration without the run-out level ...
    const fetched = await GET('/odata/v4/validation/getConfig()');
    expect(fetched.data.config.api_config.platform.logging.defaultLevel).toBe('ERROR');

    // ... but the gateways that only listen to the events still have DEBUG: the next check tries again.
    mockValkey.fail = false;
    expect(await checkLoggingSettingsExpiry(republish)).toBe(true);
    expect(republish).toHaveBeenCalledTimes(2);
    expect(lastHandedOver().api_config.platform.logging.defaultLevel).toBe('ERROR');
  });
});
