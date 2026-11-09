/**
 * Connection and connection-model validation (spec 2026-10-23 §3, §4.1): the short name that
 * becomes the model-id suffix, the per-type endpoint and auth fields, and the upstream model name.
 */
import {
  validateConnection, validateUpstreamModel, defaultFamily, modelIdFor,
} from '../../../src/services/connectionValidation';

const azure = { name: 'azure-prod', providerType: 'azure-openai', endpoint: 'https://res.openai.azure.com', apiMode: 'v1', authMode: 'api-key' };
const bedrock = { name: 'bedrock-prod', providerType: 'bedrock', region: 'us-east-1', authMode: 'access-key', accessKeyId: 'AKIAEXAMPLE' };

describe('validateConnection', () => {
  it('accepts a complete azure connection', () => {
    expect(validateConnection(azure)).toEqual([]);
  });

  it.each(['a', 'Azure', 'a--b', 'deployed', 'x'.repeat(32), '1abc', 'a_b'])('rejects the name %p', (name) => {
    const errors = validateConnection({ ...azure, name });
    expect(errors.join(' ')).toMatch(/name/);
  });

  it('accepts a 31-character name', () => {
    expect(validateConnection({ ...azure, name: 'a' + 'b'.repeat(30) })).toEqual([]);
  });

  it('rejects an unknown provider type', () => {
    expect(validateConnection({ name: 'x1', providerType: 'gemini' }).join(' ')).toMatch(/providerType/);
  });

  it('keeps name and providerType immutable', () => {
    expect(validateConnection({ name: 'other' }, azure).join(' ')).toMatch(/name/);
    expect(validateConnection({ providerType: 'openai' }, azure).join(' ')).toMatch(/providerType/);
    expect(validateConnection({ title: 'Azure' }, azure)).toEqual([]);
  });

  it('requires the azure endpoint, apiVersion in deployments mode, and tenant/client for Entra', () => {
    expect(validateConnection({ ...azure, endpoint: null }).join(' ')).toMatch(/endpoint/);
    expect(validateConnection({ ...azure, apiMode: 'deployments' }).join(' ')).toMatch(/apiVersion/);
    expect(validateConnection({ ...azure, apiMode: 'deployments', apiVersion: '2024-10-21' })).toEqual([]);
    expect(validateConnection({ ...azure, apiMode: 'legacy' }).join(' ')).toMatch(/apiMode/);
    const entra = validateConnection({ ...azure, authMode: 'entra-client-secret' }).join(' ');
    expect(entra).toMatch(/tenantId/);
    expect(entra).toMatch(/clientId/);
    expect(validateConnection({ ...azure, authMode: 'oauth' }).join(' ')).toMatch(/authMode/);
  });

  it('requires a bedrock region and, for access-key auth, the access key id', () => {
    expect(validateConnection(bedrock)).toEqual([]);
    expect(validateConnection({ ...bedrock, region: 'US-EAST-1' }).join(' ')).toMatch(/region/);
    expect(validateConnection({ ...bedrock, accessKeyId: null }).join(' ')).toMatch(/accessKeyId/);
    expect(validateConnection({ ...bedrock, authMode: 'bearer', accessKeyId: null })).toEqual([]);
    expect(validateConnection({ ...bedrock, authMode: 'iam-role' }).join(' ')).toMatch(/authMode/);
  });

  it('sap-ai-core: productive is required, the resource group follows the SAP pattern', () => {
    const sap = { name: 'sap-eu', providerType: 'sap-ai-core', productive: false, resourceGroup: 'default' };
    expect(validateConnection(sap)).toEqual([]);
    expect(validateConnection({ ...sap, productive: undefined }).join(' ')).toMatch(/productive/);
    expect(validateConnection({ ...sap, resourceGroup: 'team-a.v2_x' })).toEqual([]);
    for (const resourceGroup of ['', '-a', 'a/b', 'x'.repeat(65), null]) {
      expect(validateConnection({ ...sap, resourceGroup }).join(' ')).toMatch(/resourceGroup/);
    }
    // An update overlays the stored row: productive stays set.
    expect(validateConnection({ title: 'EU' }, sap)).toEqual([]);
  });

  it('accepts https URLs and http only on loopback', () => {
    expect(validateConnection({ name: 'oa', providerType: 'openai', baseUrl: 'https://api.openai.com/v1' })).toEqual([]);
    expect(validateConnection({ name: 'oa', providerType: 'openai', baseUrl: 'http://127.0.0.1:9100/v1' })).toEqual([]);
    expect(validateConnection({ name: 'oa', providerType: 'openai', baseUrl: 'http://localhost:9100' })).toEqual([]);
    expect(validateConnection({ name: 'oa', providerType: 'openai', baseUrl: 'http://api.openai.com/v1' }).join(' ')).toMatch(/baseUrl/);
    expect(validateConnection({ name: 'oa', providerType: 'openai', baseUrl: 'not a url' }).join(' ')).toMatch(/baseUrl/);
    expect(validateConnection({ ...bedrock, runtimeEndpoint: 'ftp://x' }).join(' ')).toMatch(/runtimeEndpoint/);
  });
});

describe('validateUpstreamModel', () => {
  it.each(['gpt-4o-mini', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'ft:gpt-4o-mini:acme::abc', 'my_deployment.v2'])('accepts %p', (v) => {
    expect(validateUpstreamModel(v)).toBeNull();
  });
  it.each(['a/b', 'a b', '', 'x'.repeat(65), '-leading', null, 7])('rejects %p', (v) => {
    expect(validateUpstreamModel(v)).toMatch(/upstreamModel/);
  });
});

describe('model ids and families', () => {
  it('suffixes the connection name', () => {
    expect(modelIdFor('gpt-4o-mini', 'azure-prod')).toBe('gpt-4o-mini--azure-prod');
  });
  it('maps provider types to their family', () => {
    expect(defaultFamily('azure-openai')).toBe('openai');
    expect(defaultFamily('openai')).toBe('openai');
    expect(defaultFamily('anthropic')).toBe('claude');
    expect(defaultFamily('bedrock')).toBe('claude');
  });
});
