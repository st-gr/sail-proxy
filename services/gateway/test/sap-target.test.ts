/**
 * The SAP AI Core target (plan "SAP AI Core as a Connection", Task 2): one module holds the URL,
 * credentials, resource group and tenant every SAP call uses, read at call time. Built from the
 * environment exactly as modelService built its constants before; installing a new target bumps
 * the version and tells the listeners, so the token and model caches drop what the old target
 * served. Each case loads a fresh module registry because the environment target is derived from
 * process.env.
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import { createHash } from 'crypto';

export {};

const ENV_KEYS = ['AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'SAP_AI_REGION', 'SAP_AI_CORE_URL', 'SAP_AI_RESOURCE_GROUP', 'SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES'];
const saved: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ACME_AUTH = 'https://acme-dev.authentication.eu10.hana.ondemand.com/oauth/token';
const GLOBEX_AUTH = 'https://globex-prod.authentication.us10.hana.ondemand.com/oauth/token';
const FOUNDATION_URL = '/lm/scenarios/foundation-models/models';

function setEnv(values: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
}

function loadSapTarget() {
  jest.resetModules();
  jest.doMock('@libs/logger', () => ({
    getDefaultLogger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined })
  }));
  // modelService and sapAIService call dotenv.config() on import, which would put the keys setEnv
  // deleted back from a services/gateway/.env (CI writes one): the environment target is read lazily.
  jest.doMock('dotenv', () => ({ __esModule: true, config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/sap/sapTarget');
}

/** modelService with axios mocked and the real configService; returns both modules and the axios double. */
function loadModelService() {
  const sapTarget = loadSapTarget();
  const post = jest.fn((url: unknown, _params?: unknown) =>
    Promise.resolve({ data: { access_token: `token-for-${String(url)}`, expires_in: 3600 } }));
  const get = jest.fn((url: unknown) =>
    Promise.resolve(String(url).includes(FOUNDATION_URL)
      ? { data: { resources: [{
        model: 'anthropic--claude-4.5-haiku',
        provider: 'anthropic',
        executableId: 'aicore-anthropic',
        createdAt: '2026-01-01T00:00:00Z',
        allowedScenarios: [{ scenarioId: 'orchestration', executableId: 'orchestration' }],
        versions: [{ name: '1', isLatest: true, streamingSupported: true }]
      }] } }
      : { data: { resources: [] } }));
  // create: the admin client builds its axios instance on import when the environment names an admin; never called here.
  const create = () => ({ interceptors: { request: { use: () => 0 }, response: { use: () => 0 } }, defaults: { headers: {} } });
  const axiosMock = { get, post, create };
  jest.doMock('axios', () => ({ __esModule: true, default: axiosMock, ...axiosMock }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const modelService = require('../src/services/modelService');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const configService = require('../src/services/configService').default;
  return { sapTarget, modelService, configService, post, get };
}

const globexTarget = (sapTarget: any) => {
  const inputs = {
    aiCoreUrl: 'https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com',
    authUrl: GLOBEX_AUTH,
    clientId: 'globex-client',
    clientSecret: 'globex-secret',
    region: 'prod.us-east-1',
    resourceGroup: 'globex-rg',
    tenant: 'globex-prod',
    source: 'connection' as const,
    connectionId: 'c-sap-globex'
  };
  return { ...inputs, fingerprint: sapTarget.sapTargetFingerprint(inputs), version: 0 };
};

describe('the environment SAP target', () => {
  beforeEach(() => setEnv({
    AUTH_URL: ACME_AUTH,
    CLIENT_ID: 'acme-client',
    CLIENT_SECRET: 'acme-secret',
    SAP_AI_REGION: 'eu-central-1',
    SAP_AI_RESOURCE_GROUP: 'acme-rg'
  }));

  it('carries the values modelService used before, the tenant from the auth URL (subdomain and landscape)', () => {
    const { currentSapTarget } = loadSapTarget();
    const t = currentSapTarget();
    expect(t).toMatchObject({
      aiCoreUrl: 'https://api.ai.eu-central-1.aws.ml.hana.ondemand.com',
      authUrl: ACME_AUTH,
      clientId: 'acme-client',
      clientSecret: 'acme-secret',
      region: 'eu-central-1',
      resourceGroup: 'acme-rg',
      tenant: 'acme-dev.eu10',
      source: 'environment',
      connectionId: null
    });
    expect(t.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the defaults: region us-east-1, resource group default, SAP_AI_CORE_URL wins over the region URL', () => {
    setEnv({ AUTH_URL: ACME_AUTH, CLIENT_ID: 'acme-client', CLIENT_SECRET: 'acme-secret' });
    let t = loadSapTarget().currentSapTarget();
    expect(t.region).toBe('us-east-1');
    expect(t.resourceGroup).toBe('default');
    expect(t.aiCoreUrl).toBe('https://api.ai.us-east-1.aws.ml.hana.ondemand.com');

    process.env.SAP_AI_CORE_URL = 'https://ai.example.test';
    t = loadSapTarget().currentSapTarget();
    expect(t.aiCoreUrl).toBe('https://ai.example.test');
  });

  it('serves on with tenant unknown when AUTH_URL is missing or unparseable', () => {
    setEnv({ CLIENT_ID: 'acme-client' });
    expect(loadSapTarget().currentSapTarget().tenant).toBe('unknown');
    setEnv({ AUTH_URL: 'not a url' });
    expect(loadSapTarget().currentSapTarget().tenant).toBe('unknown');
  });

  it('configService.getSAPAICoreConfig reports the same URL and resource group', () => {
    const { configService } = loadModelService();
    expect(configService.getSAPAICoreConfig()).toMatchObject({
      url: 'https://api.ai.eu-central-1.aws.ml.hana.ondemand.com',
      resourceGroup: 'acme-rg'
    });
  });
});

describe('sapTargetFingerprint', () => {
  it('is sha256 of url|auth|client|group|tenant|sha256(secret), never the secret itself', () => {
    const { sapTargetFingerprint } = loadSapTarget();
    const inputs = {
      aiCoreUrl: 'https://ai.example.test', authUrl: ACME_AUTH, clientId: 'acme-client', clientSecret: 'acme-secret',
      region: 'eu-central-1', resourceGroup: 'acme-rg', tenant: 'acme-dev', source: 'environment' as const, connectionId: null
    };
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const expected = sha(`https://ai.example.test|${ACME_AUTH}|acme-client|acme-rg|acme-dev|${sha('acme-secret')}`);
    expect(sapTargetFingerprint(inputs)).toBe(expected);
    expect(sapTargetFingerprint({ ...inputs, clientSecret: 'other' })).not.toBe(expected);
  });
});

describe('installSapTarget', () => {
  beforeEach(() => setEnv({ AUTH_URL: ACME_AUTH, CLIENT_ID: 'acme-client', CLIENT_SECRET: 'acme-secret' }));

  it('bumps the version and calls every listener with the new target', () => {
    const sapTarget = loadSapTarget();
    const before = sapTarget.currentSapTarget().version;
    const seen: any[] = [];
    sapTarget.onSapTargetChange((t: any) => seen.push(['a', t.tenant, t.version]));
    sapTarget.onSapTargetChange((t: any) => seen.push(['b', t.tenant, t.version]));
    sapTarget.installSapTarget(globexTarget(sapTarget));
    const now = sapTarget.currentSapTarget();
    expect(now.version).toBe(before + 1);
    expect(now).toMatchObject({ tenant: 'globex-prod', source: 'connection', connectionId: 'c-sap-globex' });
    expect(seen).toEqual([['a', 'globex-prod', before + 1], ['b', 'globex-prod', before + 1]]);
  });

  it('modelService.getAuthToken fetches from the new authUrl instead of returning the cached token', async () => {
    const { sapTarget, modelService, post } = loadModelService();
    expect(await modelService.getAuthToken()).toBe(`token-for-${ACME_AUTH}`);
    expect(await modelService.getAuthToken()).toBe(`token-for-${ACME_AUTH}`);
    expect(post).toHaveBeenCalledTimes(1);

    sapTarget.installSapTarget(globexTarget(sapTarget));
    expect(await modelService.getAuthToken()).toBe(`token-for-${GLOBEX_AUTH}`);
    expect(post).toHaveBeenCalledTimes(2);
    const params = post.mock.calls[1][1] as unknown as URLSearchParams;
    expect(params.get('client_id')).toBe('globex-client');
    expect(params.get('client_secret')).toBe('globex-secret');
  });

  it('empties the model cache, and the next list is read from the new target', async () => {
    const { sapTarget, modelService, configService, get } = loadModelService();
    await modelService.getModels();
    await modelService.getModels();
    const callsBefore = get.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    sapTarget.installSapTarget(globexTarget(sapTarget));
    expect(configService.getSAPAICoreConfig()).toMatchObject({
      url: 'https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com',
      resourceGroup: 'globex-rg'
    });
    await modelService.getModels();
    const after = get.mock.calls.slice(callsBefore);
    expect(after.length).toBeGreaterThan(0);
    for (const [url, options] of after as any[]) {
      expect(String(url).startsWith('https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com/v2/')).toBe(true);
      expect(options.headers['AI-Resource-Group']).toBe('globex-rg');
    }
  });
});
