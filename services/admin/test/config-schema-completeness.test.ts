import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';

const schema = require('../src/schemas/api-config-schema.json');
const CONFIG = path.join(__dirname, '../../gateway/api_config.json');

describe('shipped api_config validates against its own schema', () => {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);

  it('has no validation errors at all', () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    validate(cfg);
    const errors = (validate.errors || []).map(
      e => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`,
    );
    expect(errors).toEqual([]);
  });

  it('still rejects an undescribed pseudonymization key', () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    cfg.api_config.observability.pseudonymization.not_a_real_key = true;
    expect(validate(cfg)).toBe(false);
  });

  it('requires org_suffixes entries to be strings', () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    cfg.api_config.observability.pseudonymization.org_suffixes = [42];
    expect(validate(cfg)).toBe(false);
  });
});

/**
 * `$defs.siemConfig.properties.sinks.items.allOf[*].then` carries a `properties` map naming every
 * field of that sink type, so the form can render a sink's own fields instead of the union of all
 * six types'. Each entry is the empty schema `{}`, which constrains nothing: the addition is
 * descriptive, and the rules the backend enforces are exactly the ones it enforced before.
 *
 * That is a claim about behaviour, so it is measured rather than asserted in a comment - once by
 * comparing the schema with a copy that has the maps stripped out, and once by naming the
 * rejections that matter and watching them still happen.
 */
describe('per-type sink properties are descriptive, not a validation change', () => {
  const ajvOptions = { allErrors: true, strict: false, validateFormats: false };
  const validate = new Ajv(ajvOptions).compile(schema);

  /** The same schema as it stood before this round: `then` with `required` alone. */
  const withoutThenProperties = (() => {
    const copy = JSON.parse(JSON.stringify(schema));
    for (const branch of copy.$defs.siemConfig.properties.sinks.items.allOf) {
      delete branch.then.properties;
    }
    return copy;
  })();
  const validateBefore = new Ajv(ajvOptions).compile(withoutThenProperties);

  const shipped = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const withSinks = (sinks: unknown[]) => {
    const cfg = shipped();
    cfg.api_config.observability.siem.sinks = sinks;
    return cfg;
  };

  const datadog = {
    name: 'datadog', type: 'datadog', enabled: false,
    site: 'datadoghq.com', api_key_env: 'SIEM_DATADOG_API_KEY'
  };
  const s3 = {
    name: 'archive', type: 's3', enabled: false,
    bucket: 'siem-archive', region: 'eu-central-1', prefix: 'siem',
    access_key_id_env: 'SIEM_S3_ACCESS_KEY_ID', secret_access_key_env: 'SIEM_S3_SECRET_ACCESS_KEY'
  };
  const webhook = {
    name: 'webhook', type: 'webhook', enabled: false,
    url: 'https://siem.example.invalid/ingest', token_env: 'SIEM_WEBHOOK_TOKEN'
  };
  const drop = (sink: Record<string, unknown>, key: string) => {
    const copy = { ...sink };
    delete copy[key];
    return copy;
  };

  /** Each case is a whole document, so the verdict is the backend's own, end to end. */
  const cases: Array<[string, unknown, boolean]> = [
    ['the shipped configuration', shipped(), true],
    ['a complete datadog sink', withSinks([datadog]), true],
    ['a complete s3 sink, prefix included', withSinks([s3]), true],
    ['a webhook sink with its optional token_env', withSinks([webhook]), true],
    ['a datadog sink missing api_key_env', withSinks([drop(datadog, 'api_key_env')]), false],
    ['an s3 sink missing bucket', withSinks([drop(s3, 'bucket')]), false],
    ['an unknown sink type', withSinks([{ ...datadog, type: 'syslog' }]), false],
    ['a lowercase credential slot name', withSinks([{ ...datadog, api_key_env: 'siem_datadog_api_key' }]), false],
    // A pasted API key of any vendor: lowercase and dashed, so the slot-name pattern rejects it.
    // The literal is a placeholder rather than a real key prefix - a repository-wide credential
    // guard blocks a commit carrying one, and being blocked is the point of that guard.
    ['a pasted secret where a slot name belongs',
      withSinks([{ ...webhook, token_env: 'xx-vendor-api03-pasted-by-mistake' }]), false],
    // The optional field a branch newly names must not have become required by naming it.
    ['an s3 sink without the optional prefix', withSinks([drop(s3, 'prefix')]), true],
    ['a webhook sink without the optional token_env', withSinks([drop(webhook, 'token_env')]), true],
    // A field belonging to another type is still rejected only by additionalProperties, which
    // `then.properties` does not touch: it is declared on the item, so it is still accepted.
    ['a datadog sink also carrying an s3 field', withSinks([{ ...datadog, bucket: 'not-mine' }]), true]
  ];

  it.each(cases)('%s', (_name, document, expected) => {
    expect(validate(JSON.parse(JSON.stringify(document)))).toBe(expected);
  });

  it.each(cases)('%s - same verdict as before the maps were added', (_name, document) => {
    const now = validate(JSON.parse(JSON.stringify(document)));
    const before = validateBefore(JSON.parse(JSON.stringify(document)));
    expect(now).toBe(before);
  });
});
