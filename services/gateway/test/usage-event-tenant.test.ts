/**
 * Usage events name the SAP AI Core tenant that served the request (plan "SAP AI Core as a
 * Connection", Task 2): a middleware stamps every request with the current target's tenant before
 * the routes run, and emitUsageEvent carries it as sapTenant. Connection traffic never reached SAP,
 * so its sapTenant is null.
 */
import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
const emitted: any[] = [];
jest.mock('../src/services/usageEventEmitter', () => ({ __esModule: true, default: { emit: jest.fn(async (e: any) => { emitted.push(e); }) } }));
jest.mock('../src/services/siemUsageEvent', () => ({ emitSiemUsageEvent: jest.fn() }));
jest.mock('../src/config/unifiedAuthConfig', () => ({ isStandaloneMode: () => false }));
jest.mock('../src/toolGovernance/record', () => ({ toolsForEvent: () => undefined }));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
import { emitUsageEvent, createUsageMetrics } from '../src/utils/usageTracker';
import { sapTenantMiddleware } from '../src/sap/sapTarget';

const savedAuthUrl = process.env.AUTH_URL;
beforeAll(() => { process.env.AUTH_URL = 'https://acme-dev.authentication.eu10.hana.ondemand.com/oauth/token'; });
afterAll(() => {
  if (savedAuthUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = savedAuthUrl;
});

const base = () => ({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k1' } }, originalUrl: '/openai/v1/chat/completions', get: () => 'jest' } as any);

/** Runs the middleware the way app.ts mounts it, then emits the request's usage event. */
async function eventFor(req: any) {
  emitted.length = 0;
  const next = jest.fn();
  sapTenantMiddleware(req, {} as any, next);
  expect(next).toHaveBeenCalledTimes(1);
  await emitUsageEvent(req, createUsageMetrics(), 'gpt-4o', 200);
  await new Promise((r) => setImmediate(r));
  return emitted[0];
}

describe('usage events and the SAP tenant', () => {
  it('a SAP request carries the serving tenant', async () => {
    expect(await eventFor(base())).toMatchObject({ sapTenant: 'acme-dev.eu10', sapTenantSource: 'environment', provider: 'unknown' });
  });

  it('a Connection request carries null', async () => {
    const req = { ...base(), __externalUsage: { provider: 'azure-openai', connectionId: 'c-az', upstreamModel: 'my-deployment' } };
    const event = await eventFor(req);
    expect(event.sapTenant).toBeNull();
    expect(event.sapTenantSource).toBeNull();
    expect(event).toMatchObject({ origin: 'external', connectionId: 'c-az' });
  });

  it('a request that never passed the middleware carries null', async () => {
    emitted.length = 0;
    await emitUsageEvent(base(), createUsageMetrics(), 'gpt-4o', 200);
    await new Promise((r) => setImmediate(r));
    expect(emitted[0].sapTenant).toBeNull();
    expect(emitted[0].sapTenantSource).toBeNull();
  });
});
