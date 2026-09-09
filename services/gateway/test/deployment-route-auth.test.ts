/**
 * Two things the mocked-middleware suite in deployment-routes.test.ts cannot show, because it
 * replaces gatewayStandaloneOrServiceKeyAuth with a pass-through:
 *
 *  (a) The route must not be mounted at all in standalone mode. There the middleware grants '*'
 *      to every request without a credential, so a mounted POST /api/admin/deployments would let
 *      anyone who can reach the process create a billed SAP AI Core deployment.
 *  (b) With the REAL middleware and a key that is not the admin service key, POST is refused.
 *
 * The permission model behind (b) is worth stating, because it is not what it looks like: the
 * library checks the permissions declared for the service-key TYPE in SERVICE_KEYS (the registry),
 * not the permission list on the presented key. The per-request discriminator is therefore the
 * key's e-mail. A key that is not a service key at all - a normal user key, whatever permissions
 * it carries - never resolves to a service-key type, so it can never reach deployments:write.
 *
 * This suite lives in its own file because jest.mock is module-scoped: deployment-routes.test.ts
 * mocks the auth middleware for its whole file, and the real one is what is under test here.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

let mockStandalone = false;
jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: () => mockStandalone,
  shouldEnableDistributedCaching: () => false,
  getCachedUnifiedAuthConfig: () => ({})
}));

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

// The validator the gateway middleware injects into the library factory. Stubbed so no test
// reaches the admin service; the shape mirrors what unifiedApiKeyValidationService returns.
const validateApiKey = jest.fn<any>();
jest.mock('../src/services/unifiedApiKeyValidationService', () => ({
  __esModule: true,
  unifiedApiKeyValidationService: { validateApiKey: (...a: any[]) => validateApiKey(...a) }
}));

jest.mock('../src/services/configService', () => ({ __esModule: true, default: { getSAPAICoreConfig: () => ({ url: 'https://ai.example', resourceGroup: 'default' }) }, getTrustForwardedFor: () => false, getSAPAICoreConfig: () => ({ url: 'https://ai.example', resourceGroup: 'default' }) }));
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitDeploymentCreated: jest.fn<any>().mockResolvedValue(undefined) } }));
const createDeployment = jest.fn<any>();
jest.mock('../src/services/deploymentManagementService', () => {
  class DeploymentError extends Error { status: number; code: string; details?: any; constructor(s: number, c: string, m: string, d?: any) { super(m); this.status = s; this.code = c; this.details = d; } }
  return {
    __esModule: true,
    listDeploymentsForModel: jest.fn<any>(),
    createDeployment: (...a: any[]) => createDeployment(...a),
    getDeploymentStatus: jest.fn<any>(),
    DeploymentError
  };
});

import { mountDeploymentRoutes, DEPLOYMENTS_PATH } from '../src/routes/deploymentRoutes';
import { SERVICE_KEYS } from '@libs/service-auth';

const SERVICE_KEY = 'sk-' + 'a1'.repeat(24);   // 48 hex chars, the format the registry expects
const USER_KEY = 'sk-' + 'b2'.repeat(24);

function appWith(): express.Application {
  const app = express();
  app.use(express.json());
  mountDeploymentRoutes(app);
  return app;
}

describe('the deployment route is not mounted in standalone mode', () => {
  beforeEach(() => { validateApiKey.mockReset(); createDeployment.mockReset(); });

  it('mountDeploymentRoutes reports false and the endpoint 404s', async () => {
    mockStandalone = true;
    const app = appWith();
    // The mount itself is the assertion: a standalone gateway grants '*' to an unauthenticated
    // request, so a mounted route would answer 201 here instead of 404.
    const r = await request(app).post(DEPLOYMENTS_PATH).send({ model: 'gpt-5.4' });
    expect(r.status).toBe(404);
    expect(createDeployment).not.toHaveBeenCalled();
    expect((await request(app).get(DEPLOYMENTS_PATH + '?model=gpt-5.4')).status).toBe(404);
  });

  it('mountDeploymentRoutes reports the decision to its caller', () => {
    mockStandalone = true;
    expect(mountDeploymentRoutes(express())).toBe(false);
    mockStandalone = false;
    expect(mountDeploymentRoutes(express())).toBe(true);
  });
});

describe('with the real service-key middleware, a non-service key cannot deploy', () => {
  beforeEach(() => {
    mockStandalone = false;
    validateApiKey.mockReset();
    createDeployment.mockReset();
    createDeployment.mockResolvedValue({ deploymentId: 'd1', status: 'PENDING', configurationId: 'c1', reusedConfiguration: false, model: 'gpt-5.4' });
  });

  it('403s a valid ordinary API key whose permissions do not include deployments:write', async () => {
    validateApiKey.mockResolvedValue({
      valid: true,
      data: { keyId: 'k-user', name: 'someone', email: 'user@test.com', permissions: ['models:read'] }
    });

    const r = await request(appWith()).post(DEPLOYMENTS_PATH).set('X-API-Key', USER_KEY).send({ model: 'gpt-5.4' });

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('invalid_service_key');
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it('401s a request with no key at all', async () => {
    const r = await request(appWith()).post(DEPLOYMENTS_PATH).send({ model: 'gpt-5.4' });
    expect(r.status).toBe(401);
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it('403s a key the admin service rejects', async () => {
    validateApiKey.mockResolvedValue({ valid: false, data: null });
    const r = await request(appWith()).post(DEPLOYMENTS_PATH).set('X-API-Key', USER_KEY).send({ model: 'gpt-5.4' });
    expect(r.status).toBe(403);
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it('lets the ADMIN_TO_GATEWAY service key through - so the 403s above are the rule, not a broken route', async () => {
    validateApiKey.mockResolvedValue({
      valid: true,
      data: { keyId: 'k-svc', name: SERVICE_KEYS.ADMIN_TO_GATEWAY.NAME, email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL, permissions: [...SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS] }
    });

    const r = await request(appWith()).post(DEPLOYMENTS_PATH).set('X-API-Key', SERVICE_KEY).send({ model: 'gpt-5.4' });

    expect(r.status).toBe(201);
    expect(createDeployment).toHaveBeenCalledWith('gpt-5.4');
  });
});
