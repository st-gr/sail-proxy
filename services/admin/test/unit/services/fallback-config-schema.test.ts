/**
 * Both services carry a hard-coded fallback api_config for the case where
 * api_config.json is missing or unreadable. Neither was ever validated against
 * the schema the same services enforce on every user-supplied config, and the
 * admin one had shipped `platform.logging.defaultLevel: "info"` against an enum
 * that only accepts uppercase levels.
 *
 * A fallback is exactly the config that gets used when nothing else works, so it
 * failing its own schema is the worst time to find out. Validate both here.
 */
import Ajv from 'ajv';
import * as configSchema from '../../../src/schemas/api-config-schema.json';
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';
import { DEFAULT_CONFIG as GATEWAY_DEFAULT_CONFIG } from '../../../../gateway/src/services/defaultConfig';

// Same construction config-service.ts uses to compile the schema.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(configSchema);

function schemaErrorsFor(config: unknown): string[] {
  const valid = validate(config);
  if (valid) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message}`
  );
}

describe('hard-coded fallback configurations satisfy the api_config schema', () => {
  it("accepts the admin service's minimal default configuration", () => {
    expect(schemaErrorsFor(MINIMAL_DEFAULT_CONFIG)).toEqual([]);
  });

  it("accepts the gateway's DEFAULT_CONFIG", () => {
    expect(schemaErrorsFor(GATEWAY_DEFAULT_CONFIG)).toEqual([]);
  });

  it('is a check that can actually fail', () => {
    // Guards the guard: if the schema were ever compiled into something
    // permissive, the two assertions above would pass vacuously. The lowercase
    // log level below is the exact defect this test was written for.
    const errors = schemaErrorsFor({
      api_config: { platform: { logging: { defaultLevel: 'info' } } }
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('defaultLevel');
  });
});
