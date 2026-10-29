/**
 * The gateway follows the admin's active SAP AI Core connection without a restart (plan "SAP AI
 * Core as a Connection", Task 4; spec 2026-10-25 §5). A new target is installed only after it
 * obtained an OAuth token; a failing one leaves the previous target serving. Every installed
 * connection target is also kept, encrypted, as the shared last-known target in Valkey, which a
 * gateway booting while the admin is down installs instead of the (possibly moved) environment
 * key. A request keeps the target it started with: its URL, token, resource group and the tenant
 * its usage event names.
 *
 * SAP is an axios double routed by host (tenants under invented names); Valkey is an in-memory
 * fake. Each case loads a fresh module registry, because the target lives in module state.
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';

export {};

const ENV_KEYS = ['AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'SAP_AI_REGION', 'SAP_AI_CORE_URL', 'SAP_AI_RESOURCE_GROUP',
  'SAP_AI_DEPLOYMENT_ID', 'SAP_AI_AUTO_DISCOVER_DEPLOYMENT', 'VALIDATION_TOKEN_SECRET'];
const saved: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

interface Tenant { zone: string; key: string; authUrl: string; aiCoreUrl: string; clientId: string; clientSecret: string; resourceGroup: string }
const tenant = (zone: string, landscape: string): Tenant => ({
  zone,
  key: `${zone}.${landscape}`, // the tenant key: subdomain and landscape
  authUrl: `https://${zone}.authentication.${landscape}.hana.ondemand.com/oauth/token`,
  aiCoreUrl: `https://api.ai.${zone}.example.invalid`,
  clientId: `sb-${zone}-client`,
  clientSecret: `${zone}-very-secret-value`,
  resourceGroup: `rg-${zone}`,
});
const OLDCO = tenant('oldco-dev', 'eu10');
const ACME = tenant('acme-dev', 'eu10');
const GLOBEX = tenant('globex-prod', 'us10');
const TENANTS = [OLDCO, ACME, GLOBEX];

/** The admin's snapshot entry: the target is the credential JSON; the columns carry stale values on purpose. */
const sapConn = (t: Tenant, over: Record<string, unknown> = {}): any => ({
  id: `c-${t.zone}`, name: `SAP ${t.zone}`, providerType: 'sap-ai-core', isActive: true,
  settings: { resourceGroup: t.resourceGroup, endpoint: 'https://patched.example.invalid', clientId: 'patched-client', region: 'patched-region', tenantId: t.key },
  credentials: { secret: JSON.stringify({ aiCoreUrl: t.aiCoreUrl, authUrl: t.authUrl, clientId: t.clientId, clientSecret: t.clientSecret, region: 'prod.eu10' }) },
  models: [],
  ...over,
});

// ---- SAP double ---------------------------------------------------------------------------
interface Call { method: string; url: string; data?: any; config?: any }
const calls: Call[] = [];
const tokenStatus = new Map<string, number>();
/** Per URL substring: a promise the matching request waits on before it answers. */
const holds = new Map<string, Promise<void>>();
const deployments = new Map<string, string>();
const foundationModels = [{
  model: 'anthropic--claude-4.5-haiku', provider: 'anthropic', executableId: 'aicore-anthropic', createdAt: '2026-01-01T00:00:00Z',
  allowedScenarios: [{ scenarioId: 'orchestration', executableId: 'orchestration' }],
  versions: [{ name: '1', isLatest: true, streamingSupported: true }],
}];

function hold(fragment: string): () => void {
  let release!: () => void;
  holds.set(fragment, new Promise<void>((r) => { release = r; }));
  return () => { holds.delete(fragment); release(); };
}

async function route(call: Call): Promise<any> {
  calls.push(call);
  const waiting = [...holds.entries()].find(([fragment]) => call.url.includes(fragment));
  if (waiting) await waiting[1];
  const t = TENANTS.find((x) => call.url.startsWith(x.authUrl) || call.url.startsWith(x.aiCoreUrl));
  let status = 404;
  let data: any = { error: { message: 'no such route' } };
  if (t && call.url === t.authUrl) {
    status = tokenStatus.get(t.zone) ?? 200;
    data = status === 200 ? { access_token: `token-${t.zone}`, expires_in: 3600 } : { error: 'unauthorized', error_description: `Bad credentials for ${t.clientId}` };
  } else if (t && call.url.endsWith('/v2/lm/scenarios/foundation-models/models')) {
    status = 200; data = { resources: foundationModels };
  } else if (t && call.url.endsWith('/v2/lm/deployments')) {
    status = 200;
    data = { resources: [{ id: deployments.get(t.zone) ?? `dep-${t.zone}`, status: 'RUNNING', scenarioId: 'orchestration', createdAt: '2026-01-01T00:00:00Z', configurationName: 'orch' }] };
  } else if (t && call.url.includes('/v2/inference/deployments/')) {
    status = 200; data = { final_result: { id: `answer-from-${t.zone}`, choices: [] } };
  }
  // A fresh copy, as a real HTTP response is: modelService mutates the model objects it caches.
  const response = { status, data: structuredClone(data), headers: {}, config: call.config };
  const accept = call.config?.validateStatus ? call.config.validateStatus(status) : status < 400;
  if (!accept) {
    const error: any = new Error(`Request failed with status code ${status}`);
    error.response = response;
    throw error;
  }
  return response;
}

// ---- Valkey fake -------------------------------------------------------------------------
const valkey = new Map<string, string>();
let dels = 0;
let gets = 0;
const fakeStore = {
  get: async (k: string) => { gets += 1; return valkey.get(k) ?? null; },
  set: async (k: string, v: string) => { valkey.set(k, v); return 'OK'; },
  del: async (k: string) => { dels += 1; return valkey.delete(k) ? 1 : 0; },
};

const logged: string[] = [];
const errors: string[] = [];
const emitted: any[] = [];

function setEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    AUTH_URL: OLDCO.authUrl, CLIENT_ID: OLDCO.clientId, CLIENT_SECRET: OLDCO.clientSecret,
    SAP_AI_CORE_URL: OLDCO.aiCoreUrl, SAP_AI_DEPLOYMENT_ID: 'dep-1',
    VALIDATION_TOKEN_SECRET: '4f1c2e7a9b3d5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8',
  });
}

/** A fresh module registry: the SAP target, sync, last-known store and the services that use them. */
function load() {
  jest.resetModules();
  const record = (...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  jest.doMock('@libs/logger', () => ({
    getDefaultLogger: () => ({ debug: record, info: record, warn: record, error: (...a: unknown[]) => { record(...a); errors.push(String(a[1] ?? '')); }, trace: record, setRequestContext: () => undefined }),
    createSafePreview: () => '',
  }));
  const axiosMock = {
    post: jest.fn((url: string, data?: any, config?: any) => route({ method: 'POST', url, data, config })),
    get: jest.fn((url: string, config?: any) => route({ method: 'GET', url, config })),
    // The admin client axios instance: never called here (nothing talks to an admin).
    create: () => ({ interceptors: { request: { use: () => 0 }, response: { use: () => 0 } }, defaults: { headers: {} } }),
  };
  jest.doMock('axios', () => ({ __esModule: true, default: axiosMock, ...axiosMock }));
  // modelService and sapAIService call dotenv.config() on import: a services/gateway/.env (CI writes one)
  // would add the keys setEnv deleted, and the environment target is read lazily from process.env.
  jest.doMock('dotenv', () => ({ __esModule: true, config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
  jest.doMock('../src/services/usageEventEmitter', () => ({ __esModule: true, default: { emit: jest.fn(async (e: any) => { emitted.push(e); }) } }));
  jest.doMock('../src/services/siemUsageEvent', () => ({ emitSiemUsageEvent: jest.fn() }));
  jest.doMock('../src/toolGovernance/record', () => ({ toolsForEvent: () => undefined }));
  jest.doMock('../src/config/unifiedAuthConfig', () => ({ ...(jest.requireActual('../src/config/unifiedAuthConfig') as object), isStandaloneMode: () => false }));
  /* eslint-disable @typescript-eslint/no-var-requires */
  const sapTarget = require('../src/sap/sapTarget');
  const sync = require('../src/sap/sapTargetSync');
  const lastKnown = require('../src/sap/lastKnownTarget');
  const { ConnectionRegistry } = require('../src/connections/connectionRegistry');
  /* eslint-enable @typescript-eslint/no-var-requires */
  lastKnown.setLastKnownStore(fakeStore);
  return { sapTarget, sync, lastKnown, ConnectionRegistry, axiosMock };
}

const services = () => ({
  /* eslint-disable @typescript-eslint/no-var-requires */
  modelService: require('../src/services/modelService'),
  configService: require('../src/services/configService'),
  discovery: require('../src/services/deploymentDiscoveryService'),
  sapAIService: require('../src/services/sapAIService'),
  usageTracker: require('../src/utils/usageTracker'),
  /* eslint-enable @typescript-eslint/no-var-requires */
});

const tokenPosts = (t: Tenant) => calls.filter((c) => c.method === 'POST' && c.url === t.authUrl);
const tick = () => new Promise((r) => setImmediate(r));
async function until(condition: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5)); // eslint-disable-line no-await-in-loop
  expect(condition()).toBe(true);
}

beforeEach(() => {
  setEnv();
  calls.length = 0;
  tokenStatus.clear();
  holds.clear();
  deployments.clear();
  valkey.clear();
  dels = 0;
  gets = 0;
  logged.length = 0;
  errors.length = 0;
  emitted.length = 0;
});

describe('syncSapTarget', () => {
  it('installs the active sap-ai-core connection and writes the last-known copy', async () => {
    const { sapTarget, sync, lastKnown } = load();
    expect(sapTarget.currentSapTarget()).toMatchObject({ source: 'environment', tenant: OLDCO.key });

    expect(await sync.syncSapTarget([sapConn(ACME)])).toBe('installed');
    // Built from the credential JSON and the resource group, never from the PATCH-able columns.
    expect(sapTarget.currentSapTarget()).toMatchObject({
      aiCoreUrl: ACME.aiCoreUrl, authUrl: ACME.authUrl, clientId: ACME.clientId, clientSecret: ACME.clientSecret,
      region: 'prod.eu10', resourceGroup: 'rg-acme-dev', tenant: ACME.key, source: 'connection', connectionId: 'c-acme-dev',
    });
    expect(tokenPosts(ACME)).toHaveLength(1);
    const copy = await lastKnown.loadLastKnown();
    expect(copy).toMatchObject({ tenant: ACME.key, connectionId: 'c-acme-dev', fingerprint: sapTarget.currentSapTarget().fingerprint });

    // The same target again (the TTL safety net): nothing is fetched or installed.
    const version = sapTarget.currentSapTarget().version;
    expect(await sync.syncSapTarget([sapConn(ACME)])).toBe('unchanged');
    expect(sapTarget.currentSapTarget().version).toBe(version);
    expect(tokenPosts(ACME)).toHaveLength(1);
  });

  it('install refuses a target whose token fetch fails and keeps the previous one', async () => {
    const { sapTarget, sync, lastKnown } = load();
    await sync.syncSapTarget([sapConn(ACME)]);
    tokenStatus.set('globex-prod', 401);

    expect(await sync.syncSapTarget([sapConn(GLOBEX)])).toBe('kept-previous');
    expect(sapTarget.currentSapTarget()).toMatchObject({ tenant: ACME.key, connectionId: 'c-acme-dev' });
    expect((await lastKnown.loadLastKnown()).tenant).toBe(ACME.key);
    const line = logged.find((l) => l.includes('globex-prod') && l.includes('kept'));
    expect(line).toBeDefined();
    expect(line).toContain('unauthorized');
    expect(logged.join('\n')).not.toContain(GLOBEX.clientSecret);
    expect(logged.join('\n')).not.toContain(ACME.clientSecret);

    // An unusable credential is refused the same way, without a token request.
    const before = calls.length;
    expect(await sync.syncSapTarget([sapConn(GLOBEX, { credentials: { secret: '{not json' } })])).toBe('kept-previous');
    expect(calls.length).toBe(before);
    expect(sapTarget.currentSapTarget().tenant).toBe(ACME.key);
  });

  it('no active sap-ai-core connection reinstalls the environment target and clears the last-known copy', async () => {
    const { sapTarget, sync, lastKnown } = load();
    await sync.syncSapTarget([sapConn(ACME)]);
    expect(valkey.size).toBe(1);

    expect(await sync.syncSapTarget([sapConn(ACME, { isActive: false })])).toBe('environment');
    expect(sapTarget.currentSapTarget()).toMatchObject({ source: 'environment', tenant: OLDCO.key, connectionId: null });
    expect(await lastKnown.loadLastKnown()).toBeNull();
    expect(valkey.size).toBe(0);

    // Already on the environment: nothing to install.
    const version = sapTarget.currentSapTarget().version;
    expect(await sync.syncSapTarget([])).toBe('unchanged');
    expect(sapTarget.currentSapTarget().version).toBe(version);
  });

  it('boot without an admin answer installs the last-known target', async () => {
    // A gateway installed ACME earlier and wrote the shared copy.
    await load().sync.syncSapTarget([sapConn(ACME)]);
    expect(valkey.size).toBe(1);

    // A new gateway boots; the admin does not answer.
    const { sapTarget, sync, ConnectionRegistry } = load();
    let answer!: (c: any[]) => void;
    const registry = new ConnectionRegistry({ fetch: () => new Promise((r) => { answer = r; }) });
    await sync.startSapTargetSync(registry, { bootWaitMs: 30 });
    expect(sapTarget.currentSapTarget()).toMatchObject({ source: 'connection', tenant: ACME.key, clientSecret: ACME.clientSecret });

    // The admin answers later, with the connection deactivated: the environment target comes back.
    answer([sapConn(ACME, { isActive: false })]);
    await until(() => sapTarget.currentSapTarget().source === 'environment');
    expect(valkey.size).toBe(0);
  });

  it('boot with a prompt admin answer installs that answer, not the last-known copy', async () => {
    await load().sync.syncSapTarget([sapConn(ACME)]);
    const { sapTarget, sync, ConnectionRegistry } = load();
    const registry = new ConnectionRegistry({ fetch: async () => [sapConn(GLOBEX)] });
    await sync.startSapTargetSync(registry, { bootWaitMs: 500 });
    expect(sapTarget.currentSapTarget()).toMatchObject({ tenant: GLOBEX.key });
  });

  it('boot: the admin names a target whose token fails and the last-known copy is that target: the copy is installed', async () => {
    await load().sync.syncSapTarget([sapConn(GLOBEX)]);
    tokenStatus.set('globex-prod', 401);
    const { sapTarget, sync, ConnectionRegistry } = load();
    const registry = new ConnectionRegistry({ fetch: async () => [sapConn(GLOBEX)] });
    await sync.startSapTargetSync(registry, { bootWaitMs: 500 });
    expect(sapTarget.currentSapTarget()).toMatchObject({ source: 'connection', tenant: GLOBEX.key, connectionId: 'c-globex-prod' });
    expect(logged.some((l) => l.includes('globex-prod') && l.includes('last-known'))).toBe(true);
  });

  it('boot: the admin names a target whose token fails and there is no last-known copy: the admin target is installed, never the environment', async () => {
    tokenStatus.set('globex-prod', 401);
    const { sapTarget, sync, ConnectionRegistry } = load();
    const registry = new ConnectionRegistry({ fetch: async () => [sapConn(GLOBEX)] });
    await sync.startSapTargetSync(registry, { bootWaitMs: 500 });
    expect(sapTarget.currentSapTarget()).toMatchObject({ source: 'connection', tenant: GLOBEX.key });
    const line = logged.find((l) => l.includes('globex-prod') && l.includes('unauthorized'));
    expect(line).toBeDefined();
    expect(logged.join('\n')).not.toContain(GLOBEX.clientSecret);
  });

  it('an installation without SAP AI Core connections never touches the Valkey copy', async () => {
    const { sync, ConnectionRegistry } = load();
    const registry = new ConnectionRegistry({ fetch: async () => [] });
    await sync.startSapTargetSync(registry, { bootWaitMs: 500 });
    await sync.syncSapTarget([]);
    await sync.syncSapTarget([]);
    expect(dels).toBe(0);
    expect(gets).toBeLessThanOrEqual(1);
  });

  it('a prompt admin answer without SAP AI Core connections clears a copy left from a removed connection, once', async () => {
    await load().sync.syncSapTarget([sapConn(ACME)]);
    expect(valkey.size).toBe(1);
    const { sapTarget, sync, ConnectionRegistry } = load();
    const registry = new ConnectionRegistry({ fetch: async () => [] });
    await sync.startSapTargetSync(registry, { bootWaitMs: 500 });
    expect(valkey.size).toBe(0);
    expect(dels).toBe(1);
    expect(sapTarget.currentSapTarget().source).toBe('environment');
    const calls = gets + dels;
    await sync.syncSapTarget([]);
    expect(gets + dels).toBe(calls);
  });

  it('an unusable credential while the environment target serves is logged as an error', async () => {
    const { sync } = load();
    expect(await sync.syncSapTarget([sapConn(ACME, { credentials: { secret: '{not json' } })])).toBe('kept-previous');
    expect(errors.some((l) => l.includes('SAP acme-dev') && l.includes('environment'))).toBe(true);
    expect(errors.join('\n')).not.toContain('{not json');
  });

  it('an unusable credential while the environment target serves installs the matching last-known copy', async () => {
    await load().sync.syncSapTarget([sapConn(ACME)]);
    const { sapTarget, sync } = load();
    const before = calls.length;
    expect(await sync.syncSapTarget([sapConn(ACME, { credentials: { secret: '{not json' } })])).toBe('installed');
    expect(sapTarget.currentSapTarget()).toMatchObject({ source: 'connection', tenant: ACME.key, connectionId: 'c-acme-dev' });
    expect(calls.length).toBe(before);
    expect(logged.some((l) => l.includes('SAP acme-dev') && l.includes('last-known'))).toBe(true);
  });

  it('an unusable credential with a last-known copy of another connection keeps the environment target', async () => {
    await load().sync.syncSapTarget([sapConn(GLOBEX)]);
    const { sapTarget, sync } = load();
    expect(await sync.syncSapTarget([sapConn(ACME, { credentials: { secret: '{not json' } })])).toBe('kept-previous');
    expect(sapTarget.currentSapTarget()).toMatchObject({ source: 'environment', tenant: OLDCO.key });
  });

  it('refreshes with an inactive sap-ai-core connection clear the copy once, again only after a new copy', async () => {
    const { sync } = load();
    for (let i = 0; i < 3; i += 1) await sync.syncSapTarget([sapConn(ACME, { isActive: false })]); // eslint-disable-line no-await-in-loop
    expect(dels).toBeLessThanOrEqual(1);
    await sync.syncSapTarget([sapConn(ACME)]);
    expect(valkey.size).toBe(1);
    const cleared = dels;
    for (let i = 0; i < 3; i += 1) await sync.syncSapTarget([sapConn(ACME, { isActive: false })]); // eslint-disable-line no-await-in-loop
    expect(dels).toBe(cleared + 1);
    expect(valkey.size).toBe(0);
  });

  it('the last-known value in Valkey is not plaintext', async () => {
    const { sync, lastKnown } = load();
    await sync.syncSapTarget([sapConn(ACME)]);
    expect([...valkey.keys()]).toEqual(['sail-proxy:sap-target:last-known']);
    const raw = valkey.get('sail-proxy:sap-target:last-known')!;
    for (const plain of [ACME.clientSecret, ACME.clientId, ACME.authUrl, ACME.aiCoreUrl, 'acme-dev']) expect(raw).not.toContain(plain);

    // Another secret cannot read it.
    process.env.VALIDATION_TOKEN_SECRET = '0'.repeat(64);
    expect(await lastKnown.loadLastKnown()).toBeNull();
  });

  it('a publicly known VALIDATION_TOKEN_SECRET keeps the copy out of Valkey', async () => {
    process.env.VALIDATION_TOKEN_SECRET = 'dev-secret-change-in-production';
    const { sync } = load();
    expect(await sync.syncSapTarget([sapConn(ACME)])).toBe('installed');
    expect(valkey.size).toBe(0);
  });
});

describe('a request in flight when the target switches', () => {
  const PAYLOAD: any = { config: { modules: { prompt_templating: { prompt: { template: [{ role: 'user', content: 'hi' }] }, model: { name: 'gpt-4o' } } } } };
  const req = () => ({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k1' } }, originalUrl: '/openai/v1/chat/completions', get: () => 'jest', headers: {} } as any);

  /** sapTenantMiddleware as app.ts mounts it, then the SAP call and the usage event of the route. */
  function serve(s: ReturnType<typeof services>, sapTarget: any, beforeDispatch?: Promise<void>) {
    return new Promise<any>((resolve, reject) => {
      const r = req();
      sapTarget.sapTenantMiddleware(r, {} as any, () => {
        (async () => {
          if (beforeDispatch) await beforeDispatch;
          const answer = await s.sapAIService.completeChat({ ...PAYLOAD });
          await s.usageTracker.emitUsageEvent(r, s.usageTracker.createUsageMetrics(), 'gpt-4o', 200);
          await tick();
          return { answer, event: emitted[emitted.length - 1] };
        })().then(resolve, reject);
      });
    });
  }
  const completions = () => calls.filter((c) => c.url.includes('/v2/inference/deployments/'));

  it('a request in flight when the target switches keeps its target and tenant', async () => {
    const { sapTarget, sync } = load();
    const s = services();
    await sync.syncSapTarget([sapConn(ACME)]);
    const release = hold(`${ACME.aiCoreUrl}/v2/inference/`);

    const first = serve(s, sapTarget);
    await until(() => completions().length === 1);
    expect(await sync.syncSapTarget([sapConn(GLOBEX)])).toBe('installed');
    release();
    const done = await first;
    expect(done.answer.final_result.id).toBe('answer-from-acme-dev');
    expect(done.event.sapTenant).toBe(ACME.key);
    expect(done.event.sapTenantSource).toBe('connection');
    expect(completions()[0].config.headers).toMatchObject({ Authorization: 'Bearer token-acme-dev', 'AI-Resource-Group': 'rg-acme-dev' });

    const second = await serve(s, sapTarget);
    expect(second.answer.final_result.id).toBe('answer-from-globex-prod');
    expect(second.event.sapTenant).toBe(GLOBEX.key);
    expect(completions()[1].url.startsWith(GLOBEX.aiCoreUrl)).toBe(true);
    expect(completions()[1].config.headers).toMatchObject({ Authorization: 'Bearer token-globex-prod', 'AI-Resource-Group': 'rg-globex-prod' });
  });

  it('a request that passed the middleware before the switch dispatches to its own target', async () => {
    const { sapTarget, sync } = load();
    const s = services();
    await sync.syncSapTarget([sapConn(ACME)]);
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });

    const first = serve(s, sapTarget, gate);
    await tick();
    await sync.syncSapTarget([sapConn(GLOBEX)]);
    go();
    const done = await first;
    expect(done.event.sapTenant).toBe(ACME.key);
    expect(done.answer.final_result.id).toBe('answer-from-acme-dev');
    expect(completions()[0].url.startsWith(ACME.aiCoreUrl)).toBe(true);
    expect(completions()[0].config.headers).toMatchObject({ Authorization: 'Bearer token-acme-dev', 'AI-Resource-Group': 'rg-acme-dev' });
  });
});

describe('caches a target change must not carry over', () => {
  it('a token fetch that started before an install does not refill the token cache', async () => {
    const { sapTarget, sync } = load();
    const { modelService } = services();
    await sync.syncSapTarget([sapConn(ACME)]);
    modelService.clearAllCaches();
    const release = hold(ACME.authUrl);
    const early = modelService.getAuthToken();
    await until(() => tokenPosts(ACME).length === 2);
    sapTarget.installSapTarget(sync.targetFromConnection(sapConn(GLOBEX)));
    release();
    expect(await early).toBe('token-acme-dev');
    expect(await modelService.getAuthToken()).toBe('token-globex-prod');
  });

  it('a model list that started before an install does not refill the model cache', async () => {
    const { sapTarget, sync } = load();
    const { modelService } = services();
    await sync.syncSapTarget([sapConn(ACME)]);
    const release = hold(`${ACME.aiCoreUrl}/v2/lm/scenarios/foundation-models/models`);
    const early = modelService.getModels();
    await until(() => calls.some((c) => c.url.startsWith(`${ACME.aiCoreUrl}/v2/lm/scenarios`)));
    sapTarget.installSapTarget(sync.targetFromConnection(sapConn(GLOBEX)));
    release();
    expect((await early).data.length).toBeGreaterThan(0);
    await modelService.getModels();
    expect(calls.some((c) => c.url.startsWith(`${GLOBEX.aiCoreUrl}/v2/lm/scenarios/foundation-models/models`))).toBe(true);
  });

  // SAP_AI_DEPLOYMENT_ID names a deployment of the environment's tenant: under a connection it is ignored.
  it('the environment deployment id serves the environment target only; a connection target discovers its own', async () => {
    process.env.SAP_AI_DEPLOYMENT_ID = 'dep-env-only';
    const { sapTarget, sync } = load();
    const { configService } = services();
    expect(await configService.getDeploymentId()).toBe('dep-env-only');
    expect(logged.some((l) => l.includes('SAP_AI_DEPLOYMENT_ID'))).toBe(false);
    await sync.syncSapTarget([sapConn(ACME)]);
    expect(sapTarget.currentSapTarget().source).toBe('connection');
    expect(configService.getSAPAICoreConfig()).toMatchObject({ deploymentId: undefined, autoDiscoverDeployment: true });
    expect(await configService.getDeploymentId()).toBe('dep-acme-dev');
    expect(logged.filter((l) => l.includes('SAP_AI_DEPLOYMENT_ID') && l.includes('ignored'))).toHaveLength(1);
    expect(await sync.syncSapTarget([sapConn(ACME, { isActive: false })])).toBe('environment');
    expect(await configService.getDeploymentId()).toBe('dep-env-only');
  });

  it('the deployment ids discovered for the old tenant are dropped', async () => {
    delete process.env.SAP_AI_DEPLOYMENT_ID;
    process.env.SAP_AI_AUTO_DISCOVER_DEPLOYMENT = 'true';
    const { sapTarget, sync } = load();
    const { configService, discovery } = services();
    await sync.syncSapTarget([sapConn(ACME)]);
    expect(await configService.getDeploymentId()).toBe('dep-acme-dev');
    expect(await discovery.getPerplexityDeploymentId()).toBeNull();
    sapTarget.installSapTarget(sync.targetFromConnection(sapConn(GLOBEX)));
    expect(await configService.getDeploymentId()).toBe('dep-globex-prod');
    expect(discovery.getCacheStatus().deploymentCount).toBe(1);
    const globexLists = calls.filter((c) => c.url === `${GLOBEX.aiCoreUrl}/v2/lm/deployments`).length;
    await discovery.getPerplexityDeploymentId();
    expect(calls.filter((c) => c.url === `${GLOBEX.aiCoreUrl}/v2/lm/deployments`).length).toBe(globexLists + 1);
  });

  it('streaming support learnt from the old tenant is dropped', async () => {
    const { sapTarget, sync } = load();
    const { modelService } = services();
    await sync.syncSapTarget([sapConn(ACME)]);
    const id = (await modelService.getModels()).data[0].id;
    modelService.markModelAsNonStreaming(id);
    expect(modelService.modelSupportsStreaming(id)).toBe(false);
    sapTarget.installSapTarget(sync.targetFromConnection(sapConn(GLOBEX)));
    await modelService.getModels();
    expect(modelService.modelSupportsStreaming(id)).toBe(true);
  });
});
