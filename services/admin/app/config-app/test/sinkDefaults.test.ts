import {
  defaultSlotName,
  defaultSlotsFor,
  envFieldsForType,
  presetSinkName
} from '../webapp/model/sinkDefaults';
import { siemSchemaDef as siemSchema } from '../webapp/model/apiConfigSchema';

/** The schema's own slot-name pattern: what keeps a pasted secret out of a public repo. */
const SLOT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

describe('sinkDefaults', () => {
  describe('envFieldsForType', () => {
    it('reads the *_env fields each sink type declares, from the schema alone', () => {
      expect(envFieldsForType(siemSchema, 'webhook')).toEqual(['token_env']);
      expect(envFieldsForType(siemSchema, 'otel')).toEqual(['headers_env']);
      expect(envFieldsForType(siemSchema, 'datadog')).toEqual(['api_key_env']);
      expect(envFieldsForType(siemSchema, 'azure_sentinel')).toEqual(['client_secret_env']);
      expect(envFieldsForType(siemSchema, 'gcs_pubsub')).toEqual(['service_account_json_env']);
      expect(envFieldsForType(siemSchema, 's3')).toEqual(['access_key_id_env', 'secret_access_key_env']);
    });

    it('returns nothing for a type the schema does not declare', () => {
      expect(envFieldsForType(siemSchema, 'nonexistent')).toEqual([]);
    });
  });

  describe('defaultSlotsFor', () => {
    // The table the fix is specified against.
    it('matches the shipped naming convention for a sink named after its type', () => {
      expect(defaultSlotsFor(siemSchema, 'webhook', 'webhook')).toEqual({ token_env: 'SIEM_WEBHOOK_TOKEN' });
      expect(defaultSlotsFor(siemSchema, 'otel', 'otel')).toEqual({ headers_env: 'SIEM_OTEL_HEADERS' });
      expect(defaultSlotsFor(siemSchema, 'datadog', 'datadog')).toEqual({ api_key_env: 'SIEM_DATADOG_API_KEY' });
      expect(defaultSlotsFor(siemSchema, 's3', 's3')).toEqual({
        access_key_id_env: 'SIEM_S3_ACCESS_KEY_ID',
        secret_access_key_env: 'SIEM_S3_SECRET_ACCESS_KEY'
      });
    });

    it('derives from a hyphenated sink name, replacing the hyphen with an underscore', () => {
      expect(defaultSlotsFor(siemSchema, 'datadog-prod', 'datadog')).toEqual({
        api_key_env: 'SIEM_DATADOG_PROD_API_KEY'
      });
    });

    it('derives from a sink name carrying a digit, keeping the digit', () => {
      expect(defaultSlotsFor(siemSchema, 'webhook2', 'webhook')).toEqual({
        token_env: 'SIEM_WEBHOOK2_TOKEN'
      });
    });

    it('derives from a sink name starting with a digit, and the result still starts with a letter', () => {
      const slots = defaultSlotsFor(siemSchema, '2nd-datadog', 'datadog');
      expect(slots).toEqual({ api_key_env: 'SIEM_2ND_DATADOG_API_KEY' });
      expect(slots.api_key_env).toMatch(SLOT_NAME_PATTERN);
    });

    it('always satisfies the schema pattern, for every shipped sink type', () => {
      const types = ['webhook', 'otel', 'datadog', 'azure_sentinel', 'gcs_pubsub', 's3'];
      for (const type of types) {
        const slots = defaultSlotsFor(siemSchema, '3-tricky.name!', type);
        for (const slotName of Object.values(slots)) {
          expect(slotName).toMatch(SLOT_NAME_PATTERN);
        }
      }
    });

    it('produces no slots for a type with no *_env field', () => {
      // Every shipped type has at least one, but the function must not assume that.
      expect(defaultSlotsFor(siemSchema, 'anything', 'nonexistent')).toEqual({});
    });
  });

  describe('presetSinkName', () => {
    // 14:15:30 UTC, from a zone-independent instant, so the assertion holds wherever this runs.
    const instant = new Date(Date.UTC(2026, 7, 22, 14, 15, 30, 123));

    it('is <type>_<YYYYMMDD>_<HHMMSS>', () => {
      expect(presetSinkName('webhook', instant)).toBe('webhook_20260822_141530');
    });

    it('uses UTC, not the local zone', () => {
      // 23:30 UTC is the next day in Berlin and the same day in Los Angeles; the preset must read
      // the same on both machines or two of them can name different instants alike.
      const lateEvening = new Date(Date.UTC(2026, 7, 22, 23, 30, 0));
      expect(presetSinkName('s3', lateEvening)).toBe('s3_20260822_233000');
    });

    it('pads every component to its width', () => {
      const earlyJanuary = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
      expect(presetSinkName('otel', earlyJanuary)).toBe('otel_20260102_030405');
    });

    it('stays inside the schema length bound for every shipped type', () => {
      const types = ['webhook', 'otel', 'datadog', 'azure_sentinel', 'gcs_pubsub', 's3'];
      for (const type of types) {
        expect(presetSinkName(type, instant).length).toBeLessThanOrEqual(40);
      }
    });

    it('derives slot names that satisfy the schema pattern, for every shipped type', () => {
      // The point of the preset: what it feeds must still be a legal slot name.
      const types = ['webhook', 'otel', 'datadog', 'azure_sentinel', 'gcs_pubsub', 's3'];
      for (const type of types) {
        const slots = defaultSlotsFor(siemSchema, presetSinkName(type, instant), type);
        expect(Object.keys(slots).length).toBeGreaterThan(0);
        for (const slotName of Object.values(slots)) {
          expect(slotName).toMatch(SLOT_NAME_PATTERN);
        }
      }
    });

    it('derives the documented slot name for a preset webhook', () => {
      expect(defaultSlotsFor(siemSchema, presetSinkName('webhook', instant), 'webhook')).toEqual({
        token_env: 'SIEM_WEBHOOK_20260822_141530_TOKEN'
      });
    });

    it('defaults to now, and two presets a second apart differ', () => {
      const first = presetSinkName('webhook', new Date(Date.UTC(2026, 7, 22, 14, 15, 30)));
      const second = presetSinkName('webhook', new Date(Date.UTC(2026, 7, 22, 14, 15, 31)));
      expect(first).not.toBe(second);
      expect(presetSinkName('webhook')).toMatch(/^webhook_\d{8}_\d{6}$/);
    });
  });

  describe('defaultSlotName', () => {
    it('drops the _env suffix and uppercases the rest', () => {
      expect(defaultSlotName('primary', 'token_env')).toBe('SIEM_PRIMARY_TOKEN');
    });

    it('replaces any character outside [A-Z0-9_] with an underscore', () => {
      expect(defaultSlotName('sink.one', 'api_key_env')).toBe('SIEM_SINK_ONE_API_KEY');
    });
  });
});
