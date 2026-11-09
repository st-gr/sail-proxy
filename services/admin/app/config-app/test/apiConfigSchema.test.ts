import apiConfigSchema, { siemSchemaDef } from '../webapp/model/apiConfigSchema';

const schema = require('../../../src/schemas/api-config-schema.json');

/**
 * The browser cannot read `src/schemas/api-config-schema.json` - nothing serves it - so the form
 * and the gate are generated from a copy shipped inside the app. This pins the copy: if the
 * backend schema changes and the copy is not updated, the form and the gate would be built from a
 * contract the backend no longer validates against, and this test fails first.
 */
describe('apiConfigSchema (shipped copy)', () => {
  it('is identical to the backend schema', () => {
    expect(apiConfigSchema).toEqual(schema);
  });

  it('is identical byte for byte, not merely deep-equal', () => {
    expect(JSON.stringify(apiConfigSchema)).toBe(JSON.stringify(schema));
  });

  it('is identical the other direction too - nothing in the copy that is not in the source', () => {
    expect(JSON.stringify(schema)).toBe(JSON.stringify(apiConfigSchema));
  });
});

describe('siemSchemaDef (the siem subtree, pulled out for the siem-only form and tests)', () => {
  it('is identical to $defs.siemConfig in the backend schema', () => {
    expect(siemSchemaDef).toEqual(schema.$defs.siemConfig);
  });

  it('is identical byte for byte, not merely deep-equal', () => {
    expect(JSON.stringify(siemSchemaDef)).toBe(JSON.stringify(schema.$defs.siemConfig));
  });

  it('is the schema module s own $defs.siemConfig, not a second copy', () => {
    expect(siemSchemaDef).toBe(apiConfigSchema.$defs.siemConfig);
  });

  it('carries no $ref, so it is self-contained as a schema root', () => {
    expect(JSON.stringify(siemSchemaDef)).not.toContain('$ref');
  });
});
