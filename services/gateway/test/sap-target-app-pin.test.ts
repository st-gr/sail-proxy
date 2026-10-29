/**
 * The SAP target pin through the real middleware chain (createApp): the JSON body parser runs, then
 * sapTenantMiddleware pins the target current at that moment. A target installed after that, before
 * the route dispatches, changes neither the target the route sees nor the tenant its usage event
 * books. The chat route is replaced by a probe; everything in front of it is the gateway's own.
 */
import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const ENV_KEYS = ['AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'SAP_AI_CORE_URL', 'SAP_AI_REGION', 'SAP_AI_RESOURCE_GROUP'];
const saved: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const emitted: any[] = [];
let gate: Promise<void> = Promise.resolve();
let entered: () => void = () => undefined;

jest.mock('../src/services/usageEventEmitter', () => ({ __esModule: true, default: { emit: jest.fn(async (e: any) => { emitted.push(e); }) } }));
jest.mock('../src/services/siemUsageEvent', () => ({ emitSiemUsageEvent: jest.fn() }));
jest.mock('../src/toolGovernance/record', () => ({ toolsForEvent: () => undefined }));
// Standalone mode emits no usage events: this gateway has an admin.
jest.mock('../src/config/unifiedAuthConfig', () => ({ ...(jest.requireActual('../src/config/unifiedAuthConfig') as object), isStandaloneMode: () => false }));
jest.mock('../src/routes/chatRoutes', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Router } = require('express');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { currentSapTarget } = require('../src/sap/sapTarget');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const usageTracker = require('../src/utils/usageTracker');
  const router = Router();
  router.post('/', async (req: any, res: any) => {
    entered();
    await gate;
    req.unifiedAuth = { valid: true, authType: 'api_key', data: { keyId: 'k1' } }; // what the route's auth would set
    await usageTracker.emitUsageEvent(req, usageTracker.createUsageMetrics(), 'gpt-4o', 200);
    await new Promise((r) => setImmediate(r));
    res.json({ tenant: currentSapTarget().tenant, body: req.body });
  });
  return { __esModule: true, default: router };
});

// createApp loads the validation cache, which needs a 32-character key at import; without a .env none is set.
process.env.METADATA_ENCRYPTION_KEY = process.env.METADATA_ENCRYPTION_KEY || 'test-encryption-key-32-chars-minimum-length-required-for-validation';

/* eslint-disable import/first */
import { ConfigLoader } from '../../../libs/config';
import { createApp } from '../src/app';
import { installSapTarget, latestSapTarget, sapTargetFingerprint } from '../src/sap/sapTarget';
/* eslint-enable import/first */

beforeAll(() => {
  // The imports above ran dotenv.config(): drop whatever a services/gateway/.env put there.
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    AUTH_URL: 'https://initech-dev.authentication.eu10.hana.ondemand.com/oauth/token',
    CLIENT_ID: 'sb-initech-client', CLIENT_SECRET: 'initech-very-secret-value',
    SAP_AI_CORE_URL: 'https://api.ai.initech.example.invalid',
  });
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the SAP target pin in createApp', () => {
  it('a target installed after the request passed the body parser and the middleware is not the one it uses or books', async () => {
    const { app } = createApp(new ConfigLoader('gateway').loadConfig()) as { app: express.Express };
    expect(latestSapTarget()).toMatchObject({ source: 'environment', tenant: 'initech-dev.eu10' });

    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const inRoute = new Promise<void>((r) => { entered = r; });
    const pending = request(app).post('/openai/v1/chat/completions').send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    const response = pending.then((r) => r);

    await inRoute;
    const inputs = {
      aiCoreUrl: 'https://api.ai.umbrella.example.invalid',
      authUrl: 'https://umbrella-prod.authentication.us10.hana.ondemand.com/oauth/token',
      clientId: 'sb-umbrella-client', clientSecret: 'umbrella-very-secret-value', region: 'prod.us10',
      resourceGroup: 'default', tenant: 'umbrella-prod.us10', source: 'connection' as const, connectionId: 'c-umbrella',
    };
    installSapTarget({ ...inputs, fingerprint: sapTargetFingerprint(inputs), version: 0 });
    release();

    const r = await response;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ tenant: 'initech-dev.eu10', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ sapTenant: 'initech-dev.eu10', sapTenantSource: 'environment' });

    // The next request starts on the new target.
    gate = Promise.resolve();
    const next = await request(app).post('/openai/v1/chat/completions').send({ model: 'gpt-4o', messages: [] });
    expect(next.body.tenant).toBe('umbrella-prod.us10');
    expect(emitted[1]).toMatchObject({ sapTenant: 'umbrella-prod.us10', sapTenantSource: 'connection' });
  });
});
