/**
 * Server-side rejection of duplicate SIEM sink names.
 *
 * Draft-07 cannot express cross-item uniqueness, so the whole-document Ajv check
 * accepts two sinks called "s3". Until now only the config-app's form gate
 * rejected them, which left a JSON PUT and a raw-editor save able to store a
 * config in which two sinks share `SiemDelivery` rows and mark each other's
 * events delivered.
 */
import * as fs from 'fs';
import * as path from 'path';

// The module exports a factory that takes the CDS service; same shape as
// test/unit/services/json-schema-validation.test.ts uses.
const configurationServiceFactory = require('../../../src/srv/config-service');

const SHIPPED_CONFIG_PATH = path.resolve(__dirname, '../../../api_config.json');

function sink(name: string) {
  return {
    name,
    type: 'webhook',
    enabled: false,
    url: 'https://siem.example.invalid/ingest'
  };
}

function configWithSinks(sinks: unknown[]) {
  return {
    api_config: {
      observability: {
        siem: {
          enabled: true,
          sinks
        }
      }
    }
  };
}

describe('validateConfiguration rejects duplicate SIEM sink names', () => {
  let configService: any;

  beforeEach(() => {
    configService = configurationServiceFactory({ on: jest.fn(), after: jest.fn() });
  });

  async function validate(config: unknown) {
    return configService.validateConfiguration({ data: { configData: JSON.stringify(config) } });
  }

  it('accepts sinks with distinct names', async () => {
    const result = await validate(configWithSinks([sink('s3'), sink('datadog')]));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects two sinks sharing a name, naming both the clash and the offender', async () => {
    const result = await validate(configWithSinks([sink('s3'), sink('datadog'), sink('s3')]));

    expect(result.valid).toBe(false);
    const message = (result.errors as string[]).join('\n');
    expect(message).toContain('Duplicate sink name');
    expect(message).toContain('"s3"');
    // Reported against the later sink - the one to rename - not the first.
    expect(message).toContain('sinks/2/name');
    expect(message).toContain('sink #0');
  });

  it('compares names trimmed, because the delivery table would see one key', async () => {
    const result = await validate(configWithSinks([sink('datadog'), sink('  datadog  ')]));

    expect(result.valid).toBe(false);
    expect((result.errors as string[]).join('\n')).toContain('Duplicate sink name');
  });

  it('leaves blank and missing names to the schema rather than double-reporting them', async () => {
    // Two nameless sinks are not a duplicate-name problem; `required`/`minLength`
    // owns that case, and this rule must not add a second, confusing message.
    const result = await validate(
      configWithSinks([
        { type: 'webhook', enabled: false, url: 'https://siem.example.invalid/ingest' },
        { type: 'webhook', enabled: false, url: 'https://siem.example.invalid/ingest' }
      ])
    );

    expect((result.errors as string[]).join('\n')).not.toContain('Duplicate sink name');
  });

  it('still accepts the shipped api_config.json', async () => {
    const shipped = JSON.parse(fs.readFileSync(SHIPPED_CONFIG_PATH, 'utf8'));
    const result = await validate(shipped);

    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
