/**
 * Without Valkey (VALKEY_URL unset, local development) there is nobody to publish to: the run-out
 * check does not try to republish and does not warn every minute. The gateway gets the overlay with
 * its next fetch. cds.test on in-memory SQLite.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
// Empty, not deleted: the service reads services/admin/.env while it boots, and that file names
// a Valkey wherever a setup has run (the CI pipeline writes one, with a Valkey that answers).
// A variable that is already set, even to nothing, is left alone by that read, so the service of
// this suite really starts without Valkey. Put back after the suite (the worker runs others).
const valkeyUrlBefore = process.env.VALKEY_URL;
process.env.VALKEY_URL = '';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'lnv-admin@test.com': { id: 'lnv-admin@test.com', roles: ['admin', 'user'] } } };

const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));
import { getDefaultLogger } from '@libs/logger';
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';
import { checkLoggingSettingsExpiry } from '../../../src/services/loggingSettings';

const ADMIN = { auth: { username: 'lnv-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';

const atMinutesFromNow = (minutes: number) => jest.useFakeTimers({
  now: Date.now() + minutes * 60_000,
  doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
});

beforeAll(() => {
  // The premise of every test below; a boot that had taken the file's value would fail here.
  expect(process.env.VALKEY_URL).toBe('');
});
afterAll(() => {
  if (valkeyUrlBefore === undefined) delete process.env.VALKEY_URL; else process.env.VALKEY_URL = valkeyUrlBefore;
});

afterEach(() => jest.useRealTimers());

it('five checks after a run-out make no republish attempt and log no warning', async () => {
  const created = await POST(`${S}/createConfiguration`, { name: 'no-valkey-a', configData: JSON.stringify(MINIMAL_DEFAULT_CONFIG), description: 'test' }, ADMIN);
  expect((await POST(`${S}/activateConfiguration`, { configId: created.data.configId }, ADMIN)).data.success).toBe(true);
  const configService = require('../../../src/srv/config-service')({ on() {}, before() {}, after() {} });
  expect(configService.isValkeyAvailable).toBe(false);

  // A level with an end is saved but not handed to the gateway: without Valkey nobody could take
  // it back, and a gateway that fetched it would keep it until its next start. The answer says so.
  const ownLevel = (await GET('/odata/v4/validation/getConfig()')).data.config.api_config.platform.logging.defaultLevel;
  const timed = await POST(`${S}/setLoggingSettings`, { defaultLevel: 'DEBUG', defaultLevelMinutes: 60 }, ADMIN);
  expect(timed.status).toBe(200);
  expect(timed.data.warning).toMatch(/Valkey/);
  expect(timed.data.warning).toMatch(/end/);
  const fetched = await GET('/odata/v4/validation/getConfig()');
  expect(fetched.data.config.api_config.platform.logging.defaultLevel).toBe(ownLevel);
  expect(ownLevel).not.toBe('DEBUG');

  const republish = jest.fn(() => configService.republishForLoggingSettings());
  const warn = jest.spyOn(getDefaultLogger(), 'warn');
  try {
    for (let minute = 61; minute <= 65; minute++) {
      atMinutesFromNow(minute);
      expect(await checkLoggingSettingsExpiry(republish)).toBe(false);
      jest.useRealTimers();
    }
    expect(republish).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

it('a level without an end reaches the gateway with its next fetch, and the answer says it could not be told now', async () => {
  const saved = await POST(`${S}/setLoggingSettings`, { defaultLevel: 'DEBUG' }, ADMIN);
  expect(saved.status).toBe(200);
  expect(saved.data.warning).toMatch(/saved/);
  expect(saved.data.warning).not.toMatch(/Valkey/);
  const fetched = await GET('/odata/v4/validation/getConfig()');
  expect(fetched.data.config.api_config.platform.logging.defaultLevel).toBe('DEBUG');
  expect((await POST(`${S}/resetLoggingSettings`, {}, ADMIN)).status).toBe(200);
});
