import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { payloadCaptureSettings, payloadCaptureAllowed } from '../src/services/configService';

const DEFAULTS = {
  enabled: false,
  retentionHours: 48,
  raw: { maxDurationMinutes: 240, retentionHours: 24, stageMaxBytes: 262144, maxStages: 40, requestMaxBytes: 2097152 },
};
const withBlock = (block: unknown): any => ({ api_config: { observability: { payload_capture: block } } });

describe('payloadCaptureSettings', () => {
  it('gives the defaults for no configuration, no observability and no block', () => {
    expect(payloadCaptureSettings(undefined)).toEqual(DEFAULTS);
    expect(payloadCaptureSettings({})).toEqual(DEFAULTS);
    expect(payloadCaptureSettings({ api_config: { observability: {} } })).toEqual(DEFAULTS);
    expect(payloadCaptureSettings(withBlock('on'))).toEqual(DEFAULTS);
  });

  it('reads every value of the block', () => {
    const config = withBlock({ enabled: true, retention_hours: 5, raw: { max_duration_minutes: 10, retention_hours: 2, stage_max_bytes: 1000, max_stages: 7, request_max_bytes: 5000 } });
    expect(payloadCaptureSettings(config)).toEqual({
      enabled: true,
      retentionHours: 5,
      raw: { maxDurationMinutes: 10, retentionHours: 2, stageMaxBytes: 1000, maxStages: 7, requestMaxBytes: 5000 },
    });
  });

  it('gives the default for a value of the wrong type', () => {
    const config = withBlock({ enabled: 'yes', retention_hours: '5', raw: { max_duration_minutes: -1, retention_hours: NaN, stage_max_bytes: null, max_stages: {}, request_max_bytes: 'x' } });
    expect(payloadCaptureSettings(config)).toEqual(DEFAULTS);
    expect(payloadCaptureSettings(withBlock({ raw: 'none' }))).toEqual(DEFAULTS);
  });

  it('gives the default for a limit that is 0, negative or not a whole number', () => {
    for (const bad of [0, -5, 1.5, 0.25, Infinity]) {
      const config = withBlock({ raw: { max_duration_minutes: bad, stage_max_bytes: bad, max_stages: bad, request_max_bytes: bad } });
      expect(payloadCaptureSettings(config).raw).toEqual(DEFAULTS.raw);
    }
    const ones = withBlock({ raw: { max_duration_minutes: 1, stage_max_bytes: 1, max_stages: 1, request_max_bytes: 1 } });
    expect(payloadCaptureSettings(ones).raw).toEqual({ maxDurationMinutes: 1, retentionHours: 24, stageMaxBytes: 1, maxStages: 1, requestMaxBytes: 1 });
  });

  it('keeps 0 hours', () => {
    const settings = payloadCaptureSettings(withBlock({ retention_hours: 0, raw: { retention_hours: 0 } }));
    expect(settings.retentionHours).toBe(0);
    expect(settings.raw.retentionHours).toBe(0);
  });

  it('reads the shipped configuration as the defaults', () => {
    const shipped = JSON.parse(readFileSync(join(__dirname, '..', 'api_config.json'), 'utf8'));
    expect(shipped.api_config.observability.payload_capture).toEqual({
      enabled: false,
      retention_hours: 48,
      raw: { max_duration_minutes: 240, retention_hours: 24, stage_max_bytes: 262144, max_stages: 40, request_max_bytes: 2097152 },
    });
    expect(payloadCaptureSettings(shipped)).toEqual(DEFAULTS);
  });
});

describe('payloadCaptureAllowed', () => {
  it('is true only with VALKEY_URL and not standalone', () => {
    expect(payloadCaptureAllowed({ VALKEY_URL: 'redis://valkey:6379' }, false)).toBe(true);
    expect(payloadCaptureAllowed({ VALKEY_URL: 'redis://valkey:6379' }, true)).toBe(false);
    expect(payloadCaptureAllowed({}, false)).toBe(false);
    expect(payloadCaptureAllowed({ VALKEY_URL: '  ' }, false)).toBe(false);
  });
});
