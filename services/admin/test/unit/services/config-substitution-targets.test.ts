/**
 * Substitution may target a connection model (spec 2026-10-23 §4.3). Connections live outside
 * configuration versions, so a target on an existing connection that names none of its models is
 * a warning on validation, never an error. SAP ids carry `--` too (vendor prefixes), so only a
 * suffix naming an existing connection makes a target a connection target.
 */
import { join } from 'path';

const cds = require('@sap/cds');
const configurationServiceFactory = require('../../../src/srv/config-service');

const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const MODELS = 'sap.llm.gateway.admin.ConnectionModels';

function config(to: string) {
  return { api_config: { providers: { openai: { substitute_models: [{ from: 'gpt-4o', to }] } } } };
}

describe('substitution targets and connection models', () => {
  let configService: any;

  beforeAll(async () => {
    await cds.deploy(join(__dirname, '../../../src/db/schema')).to('sqlite::memory:');
    const ID = cds.utils.uuid();
    await cds.run(cds.ql.INSERT.into(CONNS).entries({ ID, name: 'oa', providerType: 'openai' }));
    await cds.run(cds.ql.INSERT.into(MODELS).entries({ connection_ID: ID, upstreamModel: 'gpt-4o', modelId: 'gpt-4o--oa', family: 'openai' }));
  });

  beforeEach(() => {
    configService = configurationServiceFactory({ on: jest.fn(), before: jest.fn(), after: jest.fn() });
  });

  const validate = (c: unknown) => configService.validateConfiguration({ data: { configData: JSON.stringify(c) } });

  it('warns about a target on a known connection that has no such model, and stays valid', async () => {
    const result = await validate(config('gpt-4.1--oa'));
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain("Model substitution in openai: target 'gpt-4.1--oa' is not a known connection model");
  });

  it('says nothing about an SAP vendor-prefixed id or an unknown suffix', async () => {
    for (const to of ['anthropic--claude-4.5-haiku', 'gpt-4o--nowhere']) {
      const result = await validate(config(to));
      expect((result.warnings ?? []).join(' ')).not.toContain('not a known connection model');
    }
  });

  it('says nothing about a known connection model', async () => {
    const result = await validate(config('gpt-4o--oa'));
    expect(result.valid).toBe(true);
    expect((result.warnings ?? []).join(' ')).not.toContain('not a known connection model');
  });

  it('says nothing about an SAP target', async () => {
    const result = await validate(config('gpt-4.1'));
    expect((result.warnings ?? []).join(' ')).not.toContain('not a known connection model');
  });
});
