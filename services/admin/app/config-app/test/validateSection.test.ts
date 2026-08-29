import Ajv from 'ajv';
import { validateSection, validateSinkNames, sinkNameClash, fieldErrorOf } from '../webapp/model/validateSection';
import { siemSchemaDef as siemSchema } from '../webapp/model/apiConfigSchema';

/**
 * The gate is only trustworthy if the browser's verdict matches the backend's. The backend
 * compiles with exactly these options (config-service.ts:13), so this test compiles the same
 * schema the same way and asserts both agree on every case - the parity claim is measured here,
 * not assumed in a comment.
 */
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const ajvValidate = ajv.compile(siemSchema as object);

const validSiem = {
  enabled: true,
  batch_size: 50,
  interval_ms: 15000,
  reconcile_lookback_ms: 86400000,
  categories: ['security', 'audit'],
  sinks: [
    {
      name: 'primary-webhook', type: 'webhook', enabled: false,
      include_content: false, include_credential_material: false,
      url: 'https://siem.example.com/ingest', token_env: 'SIEM_WEBHOOK_TOKEN',
      batch_size: 25, interval_ms: 15000
    },
    {
      name: 'datadog', type: 'datadog', enabled: false,
      include_content: false, include_credential_material: false,
      site: 'datadoghq.eu', api_key_env: 'SIEM_DATADOG_API_KEY'
    }
  ]
};

const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));

/** Each case is a mutation of the valid block, exercising one keyword the schema uses. */
const cases: Array<[string, unknown]> = [
  ['the valid block', validSiem],
  ['an empty object', {}],
  ['enum violation in categories', (() => { const d = clone(validSiem); d.categories = ['auth', 'config']; return d; })()],
  ['missing required url on a webhook sink', (() => { const d = clone(validSiem); delete d.sinks[0].url; return d; })()],
  ['missing required bucket and region on an s3 sink', (() => {
    const d = clone(validSiem);
    d.sinks[1] = { name: 'archive', type: 's3', enabled: false, access_key_id_env: 'A', secret_access_key_env: 'B' };
    return d;
  })()],
  ['missing required name', (() => { const d = clone(validSiem); delete d.sinks[0].name; return d; })()],
  ['wrong scalar type', (() => { const d = clone(validSiem); d.enabled = 'yes'; return d; })()],
  ['non-integer where integer required', (() => { const d = clone(validSiem); d.batch_size = 1.5; return d; })()],
  ['minimum violation on interval_ms', (() => { const d = clone(validSiem); d.interval_ms = 999; return d; })()],
  ['minimum violation on reconcile_lookback_ms', (() => { const d = clone(validSiem); d.reconcile_lookback_ms = -1; return d; })()],
  ['pattern violation on a credential slot', (() => { const d = clone(validSiem); d.sinks[0].token_env = 'sk-ant-not-a-slot-name'; return d; })()],
  ['minLength violation on site', (() => { const d = clone(validSiem); d.sinks[1].site = ''; return d; })()],
  ['maxLength violation on name', (() => { const d = clone(validSiem); d.sinks[0].name = 'x'.repeat(41); return d; })()],
  ['additionalProperties at section level', (() => { const d = clone(validSiem); d.not_a_property = 1; return d; })()],
  ['additionalProperties inside a sink', (() => { const d = clone(validSiem); d.sinks[0].not_a_property = 1; return d; })()],
  ['duplicate categories', (() => { const d = clone(validSiem); d.categories = ['audit', 'audit']; return d; })()],
  ['sinks not an array', (() => { const d = clone(validSiem); d.sinks = {}; return d; })()],
  ['a sink that is not an object', (() => { const d = clone(validSiem); d.sinks[0] = 'nope'; return d; })()],
  ['an unknown sink type', (() => { const d = clone(validSiem); d.sinks[0].type = 'syslog'; return d; })()],
  ['an azure_sentinel sink missing its required properties', (() => {
    const d = clone(validSiem);
    d.sinks[1] = { name: 'sentinel', type: 'azure_sentinel', enabled: false };
    return d;
  })()],
  ['an otel sink with everything it needs', (() => {
    const d = clone(validSiem);
    d.sinks[1] = { name: 'otel', type: 'otel', enabled: false, endpoint: 'https://otel.example.com/v1/logs' };
    return d;
  })()],
  ['a section with no sinks at all', { enabled: false }],
  ['an unparseable-looking value where an object belongs', 'not an object']
];

describe('validateSection agrees with the backend Ajv instance', () => {
  it.each(cases)('%s', (_name, data) => {
    const ajvValid = ajvValidate(clone(data));
    const ourErrors = validateSection(siemSchema, clone(data));
    expect(ourErrors.length === 0).toBe(ajvValid);
  });

  it('reports the same instance paths Ajv does, for a document with several faults', () => {
    const broken = clone(validSiem);
    broken.categories = ['auth'];
    delete broken.sinks[0].url;
    broken.sinks[1].site = '';

    ajvValidate(broken);
    const ajvPaths = (ajvValidate.errors || [])
      .map(e => e.instancePath)
      .filter(p => !!p);
    const ourPaths = validateSection(siemSchema, broken)
      .map(message => (message.match(/at '([^']*)'/) || [])[1])
      .filter(p => !!p);

    // Every path Ajv points at must also be pointed at here; the reverse is not required,
    // because Ajv also emits an umbrella "must match then schema" error for the same node.
    for (const path of ajvPaths) {
      expect(ourPaths).toContain(path);
    }
  });

  it('returns no errors for the shipped configuration s siem section, if it has one', () => {
    const shipped = require('../../../api_config.json');
    const siem = shipped?.api_config?.observability?.siem;
    if (!siem) {
      return;
    }
    expect(validateSection(siemSchema, siem).length === 0).toBe(ajvValidate(siem));
  });
});

/**
 * Sink names key the per-sink delivery rows (SiemDelivery.sinkName), so a collision is not a
 * cosmetic problem: one sink would mark the other's events delivered and they would never be
 * exported. JSON Schema cannot express the rule, which is why it is checked separately - and why
 * these tests also pin that Ajv really does miss it, so nobody folds the check back in and breaks
 * the parity the suite above measures.
 */
describe('sink name uniqueness', () => {
  const withNames = (...sinks: Array<{ name?: string; type: string }>) => ({
    enabled: true,
    sinks: sinks.map(sink => ({ ...sink, site: 'datadoghq.eu', api_key_env: 'SIEM_API_KEY' }))
  });

  it('accepts two sinks of the same type under different names', () => {
    // Two Datadog orgs, or a prod and an archive S3, are a legitimate configuration.
    const data = withNames({ name: 'datadog-prod', type: 'datadog' }, { name: 'datadog-eu', type: 'datadog' });
    expect(validateSinkNames(data, '/api_config/observability/siem')).toEqual([]);
  });

  it('rejects two sinks sharing a name, naming the sink that already holds it', () => {
    const data = withNames({ name: 'datadog', type: 'datadog' }, { name: 'datadog', type: 'datadog' });
    const errors = validateSinkNames(data, '/api_config/observability/siem');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("/api_config/observability/siem/sinks/1/name");
    expect(errors[0]).toContain('"datadog"');
    expect(errors[0]).toContain('sink #0');
  });

  it('reports a collision once, against the later sink', () => {
    const data = withNames(
      { name: 'a', type: 'datadog' }, { name: 'a', type: 'datadog' }, { name: 'a', type: 'datadog' }
    );
    const paths = validateSinkNames(data, '').map(m => (m.match(/at '([^']*)'/) || [])[1]);
    expect(paths).toEqual(['/sinks/1/name', '/sinks/2/name']);
  });

  it('treats names differing only in surrounding whitespace as the same name', () => {
    // They would be one key in the delivery table, so they must be one name here too.
    const data = withNames({ name: 'datadog', type: 'datadog' }, { name: ' datadog ', type: 'datadog' });
    expect(validateSinkNames(data, '')).toHaveLength(1);
  });

  it('leaves a missing or blank name to the schema', () => {
    const data = withNames({ type: 'datadog' }, { name: '   ', type: 'datadog' });
    expect(validateSinkNames(data, '')).toEqual([]);
  });

  it('says nothing about a section with no sinks, or one that is not a section at all', () => {
    expect(validateSinkNames({ enabled: false }, '')).toEqual([]);
    expect(validateSinkNames({ sinks: 'not-an-array' }, '')).toEqual([]);
    expect(validateSinkNames('not an object', '')).toEqual([]);
    expect(validateSinkNames(undefined, '')).toEqual([]);
  });

  it('is a rule Ajv cannot enforce, which is why it is checked separately', () => {
    // Two sinks with the same name but different sites are distinct objects, so `uniqueItems`
    // - the only uniqueness keyword JSON Schema has - is satisfied. The schema passes; the
    // configuration is still broken.
    const colliding = {
      enabled: true,
      sinks: [
        { name: 'datadog', type: 'datadog', site: 'datadoghq.com', api_key_env: 'SIEM_A' },
        { name: 'datadog', type: 'datadog', site: 'datadoghq.eu', api_key_env: 'SIEM_B' }
      ]
    };
    expect(ajvValidate(clone(colliding))).toBe(true);
    expect(validateSection(siemSchema, clone(colliding))).toEqual([]);
    expect(validateSinkNames(colliding, '')).toHaveLength(1);
  });

  it('gives the dialog and the gate the same answer', () => {
    // sinkNameClash is what the add dialog rejects a name with; validateSinkNames is what the
    // gate refuses a document with. One function, so they cannot drift apart.
    const existing = [{ name: 'datadog', type: 'datadog' }, { name: 'archive', type: 's3' }];
    expect(sinkNameClash('archive', existing)).toBe(1);
    expect(sinkNameClash(' archive ', existing)).toBe(1);
    expect(sinkNameClash('archive-2', existing)).toBe(-1);
    expect(sinkNameClash('   ', existing)).toBe(-1);
  });
});

describe('fieldErrorOf', () => {
  it('points a missing required property at the field, not at the object that lacks it', () => {
    // Ajv reports the fault against the sink; the field the user has to fill in is one segment
    // further down, and that is where the form has to put the error.
    const broken = clone(validSiem);
    delete broken.sinks[0].url;
    const messages = validateSection(siemSchema, broken, '/api_config/observability/siem');
    const missing = messages.map(fieldErrorOf).filter(f => f && f.missing);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      pointer: '/api_config/observability/siem/sinks/0/url',
      missing: true
    });
  });

  it('points every other fault at the node it was reported against', () => {
    const broken = clone(validSiem);
    broken.sinks[1].site = '';
    const field = validateSection(siemSchema, broken, '/api_config/observability/siem')
      .map(fieldErrorOf)
      .filter(f => f && f.pointer.endsWith('/site'))[0];

    expect(field).toMatchObject({ pointer: '/api_config/observability/siem/sinks/1/site', missing: false });
    expect(field!.reason).toContain('fewer than 1 characters');
  });

  it('resolves every message this module produces, so no fault is silently unattributed', () => {
    const broken = clone(validSiem);
    broken.categories = ['auth'];
    broken.batch_size = 1.5;
    delete broken.sinks[0].url;
    broken.sinks[1].api_key_env = 'not-a-slot-name';
    broken.sinks[1].name = 'primary-webhook';

    const messages = validateSection(siemSchema, broken, '/api_config/observability/siem')
      .concat(validateSinkNames(broken, '/api_config/observability/siem'));
    expect(messages.length).toBeGreaterThan(0);
    messages.forEach(message => {
      const field = fieldErrorOf(message);
      expect(field).not.toBeNull();
      expect(field!.pointer.startsWith('/api_config/observability/siem')).toBe(true);
    });
  });

  it('names the duplicated sink name field, which the schema itself cannot report', () => {
    const colliding = {
      enabled: true,
      sinks: [
        { name: 'datadog', type: 'datadog', site: 'datadoghq.com', api_key_env: 'SIEM_A' },
        { name: 'datadog', type: 'datadog', site: 'datadoghq.eu', api_key_env: 'SIEM_B' }
      ]
    };
    const field = fieldErrorOf(validateSinkNames(colliding, '/api_config/observability/siem')[0]);
    expect(field).toMatchObject({ pointer: '/api_config/observability/siem/sinks/1/name', missing: false });
  });

  it('returns null for a message it did not produce', () => {
    expect(fieldErrorOf('Cannot save active configuration.')).toBeNull();
    expect(fieldErrorOf('')).toBeNull();
  });
});
