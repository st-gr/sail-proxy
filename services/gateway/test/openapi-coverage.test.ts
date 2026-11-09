import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach } from '@jest/globals';
import { compareRoutes, documentedRoutes, listExpressRoutes, loadOpenApi, type RouteKey } from '@libs/test-utils';
import { ConfigLoader } from '../../../libs/config';
import { createApp } from '../src/app';

const OPENAPI_DIR = path.resolve(__dirname, '../../../openapi');
const GATEWAY_DOC = path.join(OPENAPI_DIR, 'gateway.yaml');
const internal: { gateway: RouteKey[] } = JSON.parse(fs.readFileSync(path.join(OPENAPI_DIR, 'internal-routes.json'), 'utf8'));

// isStandaloneMode() (src/config/unifiedAuthConfig.ts) reads these on every call.
const MODE_VARS = ['GATEWAY_STANDALONE', 'UNIFIED_TOKEN_SYSTEM_ENABLED', 'VALKEY_URL', 'ADMIN_SERVICE_URL'];
const savedEnv = Object.fromEntries(MODE_VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The npm gateway's /docs page is mounted only for the local target on loopback; pin both so the route set does not depend on DEPLOY_TARGET or HOST. */
const loopbackConfig = () => ({ ...new ConfigLoader('gateway').loadConfig(), deployTarget: 'local' as const, host: '127.0.0.1' });

/** Full mode: an admin service and Valkey are configured, so deployments and grounding are mounted. */
const fullModeRoutes = (): RouteKey[] => {
  delete process.env.GATEWAY_STANDALONE;
  process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
  process.env.VALKEY_URL = 'redis://127.0.0.1:6379';
  process.env.ADMIN_SERVICE_URL = 'http://127.0.0.1:4004';
  const { app, deploymentsMounted, groundingMounted } = createApp(loopbackConfig());
  expect({ deploymentsMounted, groundingMounted }).toEqual({ deploymentsMounted: true, groundingMounted: true });
  return listExpressRoutes(app);
};

const standaloneRoutes = (): RouteKey[] => {
  process.env.GATEWAY_STANDALONE = 'true';
  const { app, deploymentsMounted, groundingMounted } = createApp(loopbackConfig());
  expect({ deploymentsMounted, groundingMounted }).toEqual({ deploymentsMounted: false, groundingMounted: false });
  return listExpressRoutes(app);
};

const keyOf = (k: RouteKey): string => `${k.method} ${k.path}`;

describe('gateway OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const doc = await loadOpenApi(GATEWAY_DOC);
    expect(doc.openapi).toBe('3.1.0');
  });

  it('every mounted gateway route is documented or listed as internal', async () => {
    const doc = await loadOpenApi(GATEWAY_DOC);
    const { undocumented, stale } = compareRoutes(fullModeRoutes(), documentedRoutes(doc), internal.gateway);
    // Lists, not counts, so a failure names the routes to add or remove.
    expect({ undocumented: undocumented.map(keyOf), stale: stale.map(keyOf) }).toEqual({ undocumented: [], stale: [] });
  });

  it('standalone mode only drops internal routes', () => {
    const full = fullModeRoutes();
    const standalone = new Set(standaloneRoutes().map(keyOf));
    const internalKeys = new Set(internal.gateway.map(keyOf));
    const dropped = full.map(keyOf).filter((k) => !standalone.has(k));
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.filter((k) => !internalKeys.has(k))).toEqual([]);
  });
});
