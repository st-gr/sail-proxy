/**
 * Logging switches and levels outside the configuration versions (services/loggingSettings.ts): the
 * pure overlay laid over the configuration handed to the gateway, the validation of what an
 * administrator sets, the hand-over that never fails because of the overlay, and the expiry check.
 */
import { join } from 'path';

const cds = require('@sap/cds');

import { getDefaultLogger } from '@libs/logger';
import {
  overlayLoggingSettings, settingsFromInput, LoggingSettingsError, overlayForGateway,
  checkLoggingSettingsExpiry, startLoggingSettingsExpiry, forgetLoggingSettings, storeEnvironmentReport,
  loadLoggingSettings, markHandedOver, loggingSettingsStore, LOGGING_SETTINGS_ENTITY, LoggingSettingsRow
} from '../../../src/services/loggingSettings';
import { auditDetails } from '../../../src/srv/admin-service-logging-settings';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const nothing: LoggingSettingsRow = { ID: 'gateway', logStorageEnabled: null, defaultLevel: null, defaultLevelUntil: null, componentLevels: null };
const config = () => ({
  api_config: {
    platform: { logging: { defaultLevel: 'INFO', components: { ConfigService: 'WARN', ModelService: 'ERROR' } }, timeouts: { default: 30000 } },
    observability: { gateway_log: { enabled: true, retention_hours: 48 } }
  }
});

describe('overlayLoggingSettings', () => {
  it('returns the configuration unchanged for no record and for a record of nulls', () => {
    expect(overlayLoggingSettings(config(), null, NOW)).toEqual(config());
    expect(overlayLoggingSettings(config(), nothing, NOW)).toEqual(config());
  });

  it('lays a component level over the configuration and keeps its other components', () => {
    const row = { ...nothing, componentLevels: JSON.stringify({ ConfigService: { level: 'DEBUG' } }) };
    const out = overlayLoggingSettings(config(), row, NOW);
    expect(out.api_config.platform.logging.components).toEqual({ ConfigService: 'DEBUG', ModelService: 'ERROR' });
    expect(out.api_config.platform.logging.defaultLevel).toBe('INFO');
    expect(out.api_config.platform.timeouts).toEqual({ default: 30000 });
  });

  it('ignores an entry whose time has run out', () => {
    const row = {
      ...nothing, defaultLevel: 'DEBUG', defaultLevelUntil: later(-1).toISOString(),
      componentLevels: JSON.stringify({ ConfigService: { level: 'TRACE', until: later(-5).toISOString() }, ModelService: { level: 'DEBUG', until: later(5).toISOString() } })
    };
    const out = overlayLoggingSettings(config(), row, NOW);
    expect(out.api_config.platform.logging.defaultLevel).toBe('INFO');
    expect(out.api_config.platform.logging.components).toEqual({ ConfigService: 'WARN', ModelService: 'DEBUG' });
  });

  it('does not mutate its input', () => {
    const input = config();
    const before = JSON.stringify(input);
    const row = { ...nothing, logStorageEnabled: false, defaultLevel: 'TRACE', componentLevels: JSON.stringify({ X: { level: 'DEBUG' } }) };
    const out = overlayLoggingSettings(input, row, NOW);
    expect(JSON.stringify(input)).toBe(before);
    expect(out).not.toBe(input);
    expect(out.api_config.platform.logging.defaultLevel).toBe('TRACE');
  });

  it('lets logStorageEnabled: false overrule enabled: true', () => {
    const out = overlayLoggingSettings(config(), { ...nothing, logStorageEnabled: false }, NOW);
    expect(out.api_config.observability.gateway_log).toEqual({ enabled: false, retention_hours: 48 });
  });

  it('writes observability.payload_capture.enabled from the record and keeps its other values', () => {
    const withCapture = config() as any;
    withCapture.api_config.observability.payload_capture = { enabled: false, retention_hours: 48, raw: { max_stages: 40 } };
    const out = overlayLoggingSettings(withCapture, { ...nothing, payloadCaptureEnabled: true }, NOW);
    expect(out.api_config.observability.payload_capture).toEqual({ enabled: true, retention_hours: 48, raw: { max_stages: 40 } });
    expect(withCapture.api_config.observability.payload_capture.enabled).toBe(false);
    expect(overlayLoggingSettings(withCapture, { ...nothing, payloadCaptureEnabled: false }, NOW).api_config.observability.payload_capture.enabled).toBe(false);
  });

  it('leaves payload_capture alone when payloadCaptureEnabled is null', () => {
    const input = config();
    expect(overlayLoggingSettings(input, { ...nothing, payloadCaptureEnabled: null }, NOW)).toBe(input);
    expect((overlayLoggingSettings(input, { ...nothing, defaultLevel: 'DEBUG' }, NOW) as any).api_config.observability.payload_capture).toBeUndefined();
  });

  it('takes the configuration as a JSON string and returns a string', () => {
    const out = overlayLoggingSettings(JSON.stringify(config()), { ...nothing, defaultLevel: 'WARN' }, NOW);
    expect(typeof out).toBe('string');
    expect(JSON.parse(out).api_config.platform.logging).toEqual({ defaultLevel: 'WARN', components: { ConfigService: 'WARN', ModelService: 'ERROR' } });
  });

  it('creates only what it sets in a configuration without platform.logging or observability', () => {
    const bare = { api_config: { platform: { timeouts: { default: 1 } } } };
    expect(overlayLoggingSettings(bare, { ...nothing, defaultLevel: 'DEBUG' }, NOW))
      .toEqual({ api_config: { platform: { timeouts: { default: 1 }, logging: { defaultLevel: 'DEBUG' } } } });
    expect(overlayLoggingSettings(bare, { ...nothing, componentLevels: JSON.stringify({ A: { level: 'TRACE' } }) }, NOW))
      .toEqual({ api_config: { platform: { timeouts: { default: 1 }, logging: { components: { A: 'TRACE' } } } } });
    expect(overlayLoggingSettings(bare, { ...nothing, logStorageEnabled: true }, NOW))
      .toEqual({ api_config: { platform: { timeouts: { default: 1 } }, observability: { gateway_log: { enabled: true } } } });
  });
});

describe('settingsFromInput', () => {
  const refused = (input: any, fixed: Record<string, string> = {}): LoggingSettingsError => {
    try {
      settingsFromInput(input, fixed, NOW);
    } catch (e) {
      expect(e).toBeInstanceOf(LoggingSettingsError);
      return e as LoggingSettingsError;
    }
    throw new Error('not refused');
  };

  it('stores levels upper-case and turns minutes into an absolute time', () => {
    const out = settingsFromInput({
      logStorageEnabled: true, defaultLevel: 'debug', defaultLevelMinutes: 60,
      componentLevels: JSON.stringify({ ConfigService: { level: 'Trace', minutes: 15 }, ModelService: { level: 'warn' } })
    }, {}, NOW);
    expect(out).toEqual({
      logStorageEnabled: true, payloadCaptureEnabled: null, defaultLevel: 'DEBUG', defaultLevelUntil: later(60).toISOString(),
      componentLevels: JSON.stringify({ ConfigService: { level: 'TRACE', until: later(15).toISOString() }, ModelService: { level: 'WARN' } })
    });
  });

  it('reads null or absent parameters as "as the configuration says"', () => {
    expect(settingsFromInput({}, {}, NOW)).toEqual({ logStorageEnabled: null, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelUntil: null, componentLevels: null });
    expect(settingsFromInput({ logStorageEnabled: null, defaultLevel: null, defaultLevelMinutes: null, componentLevels: null }, {}, NOW))
      .toEqual({ logStorageEnabled: null, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelUntil: null, componentLevels: null });
  });

  it('refuses a level it does not know, naming it', () => {
    expect(refused({ defaultLevel: 'loud' })).toMatchObject({ key: 'LOGGING_LEVEL_INVALID', args: ['loud'] });
    expect(refused({ componentLevels: JSON.stringify({ A: { level: 'verbose' } }) })).toMatchObject({ key: 'LOGGING_LEVEL_INVALID', args: ['verbose'] });
  });

  it('refuses minutes outside 1..1440 or not whole, naming them', () => {
    for (const m of [0, 1441, 1.5, -3]) {
      expect(refused({ defaultLevel: 'DEBUG', defaultLevelMinutes: m })).toMatchObject({ key: 'LOGGING_MINUTES_INVALID', args: [String(m)] });
    }
    expect(refused({ componentLevels: JSON.stringify({ A: { level: 'DEBUG', minutes: 2000 } }) })).toMatchObject({ key: 'LOGGING_MINUTES_INVALID', args: ['2000'] });
    expect(refused({ componentLevels: JSON.stringify({ A: { level: 'DEBUG', minutes: '5' } }) })).toMatchObject({ key: 'LOGGING_MINUTES_INVALID', args: ['5'] });
  });

  it('refuses defaultLevelMinutes without defaultLevel', () => {
    expect(refused({ defaultLevelMinutes: 30 })).toMatchObject({ key: 'LOGGING_MINUTES_WITHOUT_LEVEL', args: ['30'] });
  });

  it('refuses componentLevels that is not a JSON object', () => {
    for (const text of ['not json', '[]', '"text"', 'null', '42']) {
      expect(refused({ componentLevels: text })).toMatchObject({ key: 'LOGGING_COMPONENTS_NOT_OBJECT' });
    }
  });

  it('refuses a component name that is empty, too long or holds a control character', () => {
    expect(refused({ componentLevels: JSON.stringify({ '': { level: 'DEBUG' } }) })).toMatchObject({ key: 'LOGGING_COMPONENT_NAME_INVALID', args: ['""'] });
    const long = 'x'.repeat(81);
    expect(refused({ componentLevels: JSON.stringify({ [long]: { level: 'DEBUG' } }) })).toMatchObject({ key: 'LOGGING_COMPONENT_NAME_INVALID', args: [JSON.stringify(long)] });
    expect(refused({ componentLevels: JSON.stringify({ 'a\nb': { level: 'DEBUG' } }) })).toMatchObject({ key: 'LOGGING_COMPONENT_NAME_INVALID', args: ['"a\\nb"'] });
    expect(settingsFromInput({ componentLevels: JSON.stringify({ ['y'.repeat(80)]: { level: 'DEBUG' } }) }, {}, NOW).componentLevels).toContain('y'.repeat(80));
  });

  it('refuses a component entry that is not an object with a level', () => {
    expect(refused({ componentLevels: JSON.stringify({ A: 'DEBUG' }) })).toMatchObject({ key: 'LOGGING_COMPONENT_ENTRY_INVALID', args: ['"A"'] });
    expect(refused({ componentLevels: JSON.stringify({ A: {} }) })).toMatchObject({ key: 'LOGGING_COMPONENT_ENTRY_INVALID', args: ['"A"'] });
  });

  it('refuses more than 50 components', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`c${i}`, { level: 'DEBUG' }]));
    expect(refused({ componentLevels: JSON.stringify(many) })).toMatchObject({ key: 'LOGGING_TOO_MANY_COMPONENTS', args: ['51'] });
    delete many.c50;
    expect(settingsFromInput({ componentLevels: JSON.stringify(many) }, {}, NOW).componentLevels).toBeTruthy();
  });

  it('refuses a default level while LOG_LEVEL is fixed, and accepts a component level then', () => {
    expect(refused({ defaultLevel: 'DEBUG' }, { LOG_LEVEL: 'warn' })).toMatchObject({ key: 'LOGGING_FIXED_LOG_LEVEL', args: ['warn'] });
    expect(settingsFromInput({ componentLevels: JSON.stringify({ A: { level: 'DEBUG' } }) }, { LOG_LEVEL: 'warn' }, NOW).componentLevels)
      .toBe(JSON.stringify({ A: { level: 'DEBUG' } }));
  });

  it('refuses switching storage on while GATEWAY_LOG_SHIPPING is off, and accepts switching it off', () => {
    expect(refused({ logStorageEnabled: true }, { GATEWAY_LOG_SHIPPING: 'off' })).toMatchObject({ key: 'LOGGING_FIXED_LOG_SHIPPING', args: ['off'] });
    expect(settingsFromInput({ logStorageEnabled: false }, { GATEWAY_LOG_SHIPPING: 'off' }, NOW).logStorageEnabled).toBe(false);
  });

  it('stores payloadCaptureEnabled as given, null when absent, and refuses nothing because of the environment', () => {
    expect(settingsFromInput({ payloadCaptureEnabled: true }, { GATEWAY_LOG_SHIPPING: 'off' }, NOW).payloadCaptureEnabled).toBe(true);
    expect(settingsFromInput({ payloadCaptureEnabled: false }, {}, NOW).payloadCaptureEnabled).toBe(false);
    expect(settingsFromInput({}, {}, NOW).payloadCaptureEnabled).toBeNull();
  });

  it('refuses nothing because of PAYLOAD_LOGGING_ENABLED', () => {
    expect(settingsFromInput({ logStorageEnabled: true, defaultLevel: 'DEBUG' }, { PAYLOAD_LOGGING_ENABLED: 'true' }, NOW).defaultLevel).toBe('DEBUG');
  });
});

describe('with the database', () => {
  const put = (row: Partial<LoggingSettingsRow>) => cds.db.run(cds.ql.UPSERT.into(LOGGING_SETTINGS_ENTITY).entries({ ID: 'gateway', ...row }));
  const get = () => cds.db.run(cds.ql.SELECT.one.from(LOGGING_SETTINGS_ENTITY).where({ ID: 'gateway' }));

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../../src/db/schema')).to(db);
  });
  beforeEach(async () => {
    await cds.db.run(cds.ql.DELETE.from(LOGGING_SETTINGS_ENTITY));
    forgetLoggingSettings();
  });
  /** The record as stored now, loaded into memory and handed over as of NOW (what the gateway last got). */
  const handedOverNow = async () => {
    expect(await loadLoggingSettings()).toBe(true);
    markHandedOver(overlayForGateway(config(), NOW, true).handedOver);
  };

  describe('overlayForGateway', () => {
    it('lays the loaded record over the configuration', async () => {
      await put({ defaultLevel: 'DEBUG' });
      await loadLoggingSettings();
      expect(overlayForGateway(config()).configData.api_config.platform.logging.defaultLevel).toBe('DEBUG');
    });

    describe('a level with an end and an admin without Valkey', () => {
      // Review finding 2026-11-12: the overlay hands the gateway the level but not its end, and
      // only the expiry republish takes it back. Without Valkey there is no republish, so a
      // gateway that fetched its configuration during the window kept TRACE until its next start.
      const timed = () => put({
        defaultLevel: 'DEBUG', defaultLevelUntil: later(15).toISOString(),
        componentLevels: JSON.stringify({ ConfigService: { level: 'TRACE', until: later(15).toISOString() }, ModelService: { level: 'DEBUG' } })
      });

      it('is left out of what the gateway gets: nobody could take it back', async () => {
        await timed();
        await loadLoggingSettings();
        const overlaid = overlayForGateway(config(), NOW, false);
        const logging = overlaid.configData.api_config.platform.logging;
        expect(logging.defaultLevel).toBe('INFO');                 // the configuration's own
        expect(logging.components.ConfigService).toBe('WARN');     // the configuration's own
        expect(logging.components.ModelService).toBe('DEBUG');     // no end: handed over
        expect(overlaid.handedOver).toEqual({ components: { ModelService: { level: 'DEBUG' } } });
      });

      it('a level without an end and the storage switch are still handed over', async () => {
        await put({ defaultLevel: 'DEBUG', logStorageEnabled: false });
        await loadLoggingSettings();
        const overlaid = overlayForGateway(config(), NOW, false).configData;
        expect(overlaid.api_config.platform.logging.defaultLevel).toBe('DEBUG');
        expect(overlaid.api_config.observability.gateway_log.enabled).toBe(false);
      });

      it('the capture switch has no end and is still handed over, beside a level with an end left out', async () => {
        for (const enabled of [true, false]) {
          await put({ payloadCaptureEnabled: enabled, defaultLevel: 'DEBUG', defaultLevelUntil: later(15).toISOString() });
          await loadLoggingSettings();
          const overlaid = overlayForGateway(config(), NOW, false);
          expect(overlaid.handedOver).toEqual({ payloadCaptureEnabled: enabled, components: {} });
          expect(overlaid.configData.api_config.observability.payload_capture.enabled).toBe(enabled);
          expect(overlaid.configData.api_config.platform.logging.defaultLevel).toBe('INFO');
        }
      });

      it('with Valkey the level with an end is handed over, as the expiry republish takes it back', async () => {
        await timed();
        await loadLoggingSettings();
        const logging = overlayForGateway(config(), NOW, true).configData.api_config.platform.logging;
        expect(logging.defaultLevel).toBe('DEBUG');
        expect(logging.components.ConfigService).toBe('TRACE');
      });

      it('reads VALKEY_URL when it is not told', async () => {
        await timed();
        await loadLoggingSettings();
        const before = process.env.VALKEY_URL;
        try {
          delete process.env.VALKEY_URL;
          expect(overlayForGateway(config(), NOW).configData.api_config.platform.logging.defaultLevel).toBe('INFO');
          process.env.VALKEY_URL = 'redis://127.0.0.1:6399';
          expect(overlayForGateway(config(), NOW).configData.api_config.platform.logging.defaultLevel).toBe('DEBUG');
        } finally {
          if (before === undefined) delete process.env.VALKEY_URL; else process.env.VALKEY_URL = before;
        }
      });
    });

    it('reads nothing from the database: a record stored but not loaded does not apply', async () => {
      const read = jest.spyOn(loggingSettingsStore, 'readRow');
      try {
        await put({ defaultLevel: 'DEBUG' });
        const input = config();
        expect(overlayForGateway(input).configData).toBe(input);
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    });

    it('gives the configuration as it is when the record is corrupt, and logs the error', async () => {
      const logged = jest.spyOn(getDefaultLogger(), 'error').mockImplementation(() => undefined);
      try {
        await put({ defaultLevel: 'DEBUG', componentLevels: '{not json' });
        await loadLoggingSettings();
        const input = config();
        expect(overlayForGateway(input)).toEqual({ configData: input });
        expect(overlayForGateway(input).configData).toBe(input);
        expect(logged).toHaveBeenCalledWith('LoggingSettings', expect.stringContaining('without them'), expect.any(Error));
      } finally {
        logged.mockRestore();
      }
    });

    it('gives the configuration as it is when there is no record', async () => {
      await loadLoggingSettings();
      const input = config();
      expect(overlayForGateway(input).configData).toBe(input);
    });
  });

  describe('loadLoggingSettings', () => {
    it('keeps what it had when the read fails, and says so', async () => {
      await put({ defaultLevel: 'WARN' });
      await loadLoggingSettings();
      const warned = jest.spyOn(getDefaultLogger(), 'warn').mockImplementation(() => undefined);
      const read = jest.spyOn(loggingSettingsStore, 'readRow').mockRejectedValueOnce(new Error('relation does not exist'));
      try {
        expect(await loadLoggingSettings()).toBe(false);
        expect(overlayForGateway(config()).configData.api_config.platform.logging.defaultLevel).toBe('WARN');
        expect(warned).toHaveBeenCalledWith('LoggingSettings', expect.stringContaining('relation does not exist'));
      } finally {
        read.mockRestore();
        warned.mockRestore();
      }
    });
  });

  describe('storeEnvironmentReport', () => {
    it('keeps the settings, stores only the known variables and refreshes the loaded record', async () => {
      await put({ defaultLevel: 'WARN', logStorageEnabled: true });
      await storeEnvironmentReport({ LOG_LEVEL: 'debug', GATEWAY_LOG_SHIPPING: 'off', OTHER: 'x' }, NOW);
      const row = await get();
      expect(row.defaultLevel).toBe('WARN');
      expect(row.logStorageEnabled).toBe(true);
      expect(JSON.parse(row.environmentFixed)).toEqual({ LOG_LEVEL: 'debug', GATEWAY_LOG_SHIPPING: 'off' });
      expect(new Date(row.environmentReportedAt).toISOString()).toBe(NOW.toISOString());
      expect(overlayForGateway(config()).configData.api_config.platform.logging.defaultLevel).toBe('WARN');
    });

    it('removes control characters from the values', async () => {
      await storeEnvironmentReport({ LOG_LEVEL: 'de\nbug\u0007' }, NOW);
      expect(JSON.parse((await get()).environmentFixed)).toEqual({ LOG_LEVEL: 'debug' });
    });

    it('drops a report that would not fit the column, with one warning', async () => {
      const warned = jest.spyOn(getDefaultLogger(), 'warn').mockImplementation(() => undefined);
      try {
        const heavy = '"\\'.repeat(50); // 100 characters, each escaped to two in JSON
        await storeEnvironmentReport({ LOG_LEVEL: heavy, PAYLOAD_LOGGING_ENABLED: heavy, GATEWAY_LOG_SHIPPING: heavy }, NOW);
        expect(await get()).toBeFalsy();
        expect(warned).toHaveBeenCalledTimes(1);
        expect(warned).toHaveBeenCalledWith('LoggingSettings', expect.stringContaining('not stored'));
      } finally {
        warned.mockRestore();
      }
    });
  });

  describe('checkLoggingSettingsExpiry', () => {
    it('before any hand-over reached the gateway since the start, tries one each check until one succeeds (Valkey configured)', async () => {
      await put({ defaultLevel: 'DEBUG', defaultLevelUntil: later(60).toISOString() });
      const republish = jest.fn<Promise<boolean>, []>().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
      expect(await checkLoggingSettingsExpiry(republish, later(61), true)).toBe(false);
      expect(await checkLoggingSettingsExpiry(republish, later(62), true)).toBe(false);
      expect(await checkLoggingSettingsExpiry(republish, later(63), true)).toBe(true);
      expect(republish).toHaveBeenCalledTimes(3);
      expect(await checkLoggingSettingsExpiry(republish, later(64), true)).toBe(false);
      expect(await checkLoggingSettingsExpiry(republish, later(65), true)).toBe(false);
      expect(republish).toHaveBeenCalledTimes(3);
    });

    it('without Valkey tries no hand-over before the first one, whatever the check finds', async () => {
      await put({ defaultLevel: 'DEBUG', defaultLevelUntil: later(60).toISOString() });
      const republish = jest.fn(async () => true);
      for (let minute = 61; minute <= 63; minute++) expect(await checkLoggingSettingsExpiry(republish, later(minute), false)).toBe(false);
      expect(republish).not.toHaveBeenCalled();
    });

    it('does not republish when nothing ran out', async () => {
      await put({ defaultLevel: 'DEBUG', defaultLevelUntil: later(60).toISOString() });
      await handedOverNow();
      const republish = jest.fn(async () => true);
      expect(await checkLoggingSettingsExpiry(republish, later(30))).toBe(false);
      expect(await checkLoggingSettingsExpiry(republish, later(59))).toBe(false);
      expect(republish).not.toHaveBeenCalled();
    });

    it('republishes once when an entry ran out', async () => {
      await put({ defaultLevel: 'DEBUG', defaultLevelUntil: later(60).toISOString(), componentLevels: JSON.stringify({ A: { level: 'TRACE' } }) });
      await handedOverNow();
      const republish = jest.fn(async () => true);
      expect(await checkLoggingSettingsExpiry(republish, later(61))).toBe(true);
      expect(await checkLoggingSettingsExpiry(republish, later(62))).toBe(false);
      expect(republish).toHaveBeenCalledTimes(1);
    });

    it('tries a failed republish again on the next check, and stops once it succeeded', async () => {
      await put({ defaultLevel: 'DEBUG', defaultLevelUntil: later(60).toISOString() });
      await handedOverNow();
      const republish = jest.fn<Promise<boolean>, []>().mockResolvedValueOnce(false).mockResolvedValue(true);
      expect(await checkLoggingSettingsExpiry(republish, later(61))).toBe(false);
      expect(await checkLoggingSettingsExpiry(republish, later(62))).toBe(true);
      expect(await checkLoggingSettingsExpiry(republish, later(63))).toBe(false);
      expect(republish).toHaveBeenCalledTimes(2);
    });

    it('starts no retries when a publish failed but nothing differs from what the gateway last got', async () => {
      await put({ defaultLevel: 'DEBUG' });
      await handedOverNow();
      const republish = jest.fn(async () => false);
      for (let minute = 1; minute <= 5; minute++) expect(await checkLoggingSettingsExpiry(republish, later(minute))).toBe(false);
      expect(republish).not.toHaveBeenCalled();
    });

    it('republishes once when only the capture switch differs from what the gateway last got, and names it', async () => {
      const info = jest.spyOn(getDefaultLogger(), 'info').mockImplementation(() => undefined);
      try {
        await put({ payloadCaptureEnabled: false });
        await handedOverNow();
        const republish = jest.fn(async () => true);
        expect(await checkLoggingSettingsExpiry(republish, later(1))).toBe(false);
        await put({ payloadCaptureEnabled: true });
        expect(await checkLoggingSettingsExpiry(republish, later(2))).toBe(true);
        expect(await checkLoggingSettingsExpiry(republish, later(3))).toBe(false);
        await put({ payloadCaptureEnabled: null });
        expect(await checkLoggingSettingsExpiry(republish, later(4))).toBe(true);
        expect(republish).toHaveBeenCalledTimes(2);
        const said = info.mock.calls.map((c) => String(c[1])).filter((m) => m.includes('differ from what the gateway last got'));
        expect(said).toHaveLength(2);
        for (const m of said) expect(m).toContain('(payload capture)');
      } finally {
        info.mockRestore();
      }
    });

    it('republishes once for a record written elsewhere (another admin instance)', async () => {
      await handedOverNow();
      await put({ logStorageEnabled: true });
      const republish = jest.fn(async () => true);
      expect(await checkLoggingSettingsExpiry(republish, later(1))).toBe(true);
      expect(await checkLoggingSettingsExpiry(republish, later(2))).toBe(false);
      expect(republish).toHaveBeenCalledTimes(1);
    });
  });

  it('starts no timer in a test process unless asked to', () => {
    expect(startLoggingSettingsExpiry(async () => true)).toBeNull();
    const handle = startLoggingSettingsExpiry(async () => true, { allowInTest: true, intervalMs: 60_000 });
    expect(handle).not.toBeNull();
    handle!.stop();
  });
});

describe('auditDetails', () => {
  const none = { logStorageEnabled: null, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelUntil: null, componentLevels: null };

  it('names each changed field with its old and new value', () => {
    expect(JSON.parse(auditDetails({ ...none, defaultLevel: 'INFO' }, { ...none, defaultLevel: 'DEBUG', logStorageEnabled: true })))
      .toEqual({ changed: { defaultLevel: { old: 'INFO', new: 'DEBUG' }, logStorageEnabled: { old: null, new: true } } });
  });

  it('names a change of the capture switch', () => {
    expect(JSON.parse(auditDetails({ ...none, payloadCaptureEnabled: null }, { ...none, payloadCaptureEnabled: true })))
      .toEqual({ changed: { payloadCaptureEnabled: { old: null, new: true } } });
  });

  it('stays within the 1000 characters of AuditEvents.details for 50 long component names', () => {
    const many = JSON.stringify(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`${'c'.repeat(75)}${i}`, { level: 'DEBUG', until: NOW.toISOString() }])));
    const text = auditDetails(none, { ...none, componentLevels: many, defaultLevel: 'WARN' });
    expect(text.length).toBeLessThanOrEqual(1000);
    const parsed = JSON.parse(text);
    expect(parsed.changed.defaultLevel).toEqual({ old: null, new: 'WARN' });
    expect(parsed.componentLevelsChanged.length + parsed.more).toBe(50);
  });
});
