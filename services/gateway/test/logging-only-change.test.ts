/**
 * Whether two configurations differ only in what the admin's logging settings lay over the
 * active configuration: the default level, the component levels and the switch for storing the
 * gateway's log. The gateway uses it to take such a change without reloading anything else.
 */
import { describe, it, expect } from '@jest/globals';
import { differsOnlyInLoggingSettings } from '../src/services/loggingOnlyChange';

const base = (): any => ({ api_config: {
  providers: { openai: { emulate_streaming_for_models: ['m1'] } },
  platform: { logging: { defaultLevel: 'INFO', components: { ConfigService: 'WARN' } }, timeouts: { default: 30000 } },
  observability: { gateway_log: { enabled: true, retention_hours: 48 } },
} });
const edit = (change: (config: any) => void): any => { const config = base(); change(config); return config; };

describe('differsOnlyInLoggingSettings', () => {
  it('is true for a changed default level, changed components and a changed storage switch', () => {
    expect(differsOnlyInLoggingSettings(base(), edit((c) => { c.api_config.platform.logging.defaultLevel = 'DEBUG'; }))).toBe(true);
    expect(differsOnlyInLoggingSettings(base(), edit((c) => { c.api_config.platform.logging.components = { ModelService: 'TRACE' }; }))).toBe(true);
    expect(differsOnlyInLoggingSettings(base(), edit((c) => { c.api_config.observability.gateway_log.enabled = false; }))).toBe(true);
  });

  it('is true when the overlay created the objects and when a reset removed them again', () => {
    const bare = { api_config: { providers: {} } };
    const overlaid = { api_config: { providers: {}, platform: { logging: { defaultLevel: 'DEBUG' } }, observability: { gateway_log: { enabled: false } } } };
    expect(differsOnlyInLoggingSettings(bare, overlaid)).toBe(true);
    expect(differsOnlyInLoggingSettings(overlaid, bare)).toBe(true);
  });

  it('is true for a flip of payload_capture.enabled, with the object created or removed by it', () => {
    const withCapture = (capture: any): any => edit((c) => { c.api_config.observability.payload_capture = capture; });
    const full = { enabled: false, retention_hours: 48, raw: { max_stages: 40 } };
    expect(differsOnlyInLoggingSettings(withCapture(full), withCapture({ ...full, enabled: true }))).toBe(true);
    expect(differsOnlyInLoggingSettings(base(), withCapture({ enabled: true }))).toBe(true);
    expect(differsOnlyInLoggingSettings(withCapture({ enabled: true }), base())).toBe(true);
  });

  it('is true for a payload_capture.enabled flip together with a gateway_log.enabled flip in one event', () => {
    const withCapture = (capture: any, logEnabled: boolean): any => edit((c) => {
      c.api_config.observability.payload_capture = capture;
      c.api_config.observability.gateway_log.enabled = logEnabled;
    });
    const full = { enabled: false, retention_hours: 48, raw: { max_stages: 40 } };
    expect(differsOnlyInLoggingSettings(withCapture(full, true), withCapture({ ...full, enabled: true }, false))).toBe(true);
    expect(differsOnlyInLoggingSettings(withCapture({ ...full, enabled: true }, false), withCapture(full, true))).toBe(true);
    // Both objects created by the overlay at once, and removed again by a reset.
    const bare = { api_config: { providers: {} } };
    const overlaid = { api_config: { providers: {}, observability: { gateway_log: { enabled: false }, payload_capture: { enabled: true } } } };
    expect(differsOnlyInLoggingSettings(bare, overlaid)).toBe(true);
    expect(differsOnlyInLoggingSettings(overlaid, bare)).toBe(true);
  });

  it('is false when retention_hours or a raw value changes beside a payload_capture flip', () => {
    const withCapture = (capture: any): any => edit((c) => { c.api_config.observability.payload_capture = capture; });
    const full = { enabled: false, retention_hours: 48, raw: { max_stages: 40 } };
    expect(differsOnlyInLoggingSettings(withCapture(full), withCapture({ ...full, enabled: true, retention_hours: 1 }))).toBe(false);
    expect(differsOnlyInLoggingSettings(withCapture(full), withCapture({ enabled: true, retention_hours: 48, raw: { max_stages: 41 } }))).toBe(false);
    expect(differsOnlyInLoggingSettings(withCapture(full), withCapture({ ...full, retention_hours: 1 }))).toBe(false);
  });

  it('is true for two equal configurations', () => {
    expect(differsOnlyInLoggingSettings(base(), base())).toBe(true);
  });

  it('is false when anything else differs, also beside a logging change', () => {
    expect(differsOnlyInLoggingSettings(base(), edit((c) => { c.api_config.providers.openai.emulate_streaming_for_models.push('m2'); }))).toBe(false);
    expect(differsOnlyInLoggingSettings(base(), edit((c) => { c.api_config.platform.timeouts.default = 1; c.api_config.platform.logging.defaultLevel = 'DEBUG'; }))).toBe(false);
    expect(differsOnlyInLoggingSettings(base(), edit((c) => { c.api_config.observability.gateway_log.retention_hours = 1; }))).toBe(false);
    expect(differsOnlyInLoggingSettings(base(), edit((c) => { c.api_config.platform.logging.payload_logging_enabled = true; }))).toBe(false);
  });

  it('is false when a part that is empty on one side is missing on the other, outside the logging places', () => {
    // Only objects the overlay itself may have created are forgiven for being empty.
    expect(differsOnlyInLoggingSettings(base(), edit((c) => { c.api_config.hooks = {}; }))).toBe(false);
  });

  it('is false for anything that is not two objects, and never throws', () => {
    for (const value of [undefined, null, 'text', 7, []]) {
      expect(differsOnlyInLoggingSettings(value, base())).toBe(false);
      expect(differsOnlyInLoggingSettings(base(), value)).toBe(false);
    }
  });

  it('is false, without throwing, for something that cannot be copied', () => {
    const withFunction = edit((c) => { c.api_config.providers.openai.hook = () => undefined; });
    expect(differsOnlyInLoggingSettings(base(), withFunction)).toBe(false);
  });

  it('leaves its arguments as they were', () => {
    const held = base();
    const arrived = edit((c) => { c.api_config.platform.logging.defaultLevel = 'DEBUG'; });
    const before = JSON.stringify([held, arrived]);
    differsOnlyInLoggingSettings(held, arrived);
    expect(JSON.stringify([held, arrived])).toBe(before);
  });
});
