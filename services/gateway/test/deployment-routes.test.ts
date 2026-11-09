/**
 * The deployment routes sit behind the service-key middleware and map service errors to HTTP.
 * The middleware is replaced by a pass-through here; permission enforcement itself is the lib's
 * concern and is covered by the ENDPOINT_AUTH_RULES assertions at the bottom.
 */
import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../src/middlewares/gatewayServiceAuth', () => ({ gatewayStandaloneOrServiceKeyAuth: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: { getSAPAICoreConfig: () => ({ url: 'https://ai.example', resourceGroup: 'default' }) }, getTrustForwardedFor: () => false, getSAPAICoreConfig: () => ({ url: 'https://ai.example', resourceGroup: 'default' }) }));
const emitDeploymentCreated = jest.fn<any>().mockResolvedValue(undefined);
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitDeploymentCreated: (...a: any[]) => emitDeploymentCreated(...a) } }));
const svc = { listDeploymentsForModel: jest.fn<any>(), createDeployment: jest.fn<any>(), getDeploymentStatus: jest.fn<any>() };
jest.mock('../src/services/deploymentManagementService', () => {
  class DeploymentError extends Error { status: number; code: string; details?: any; constructor(s: number, c: string, m: string, d?: any) { super(m); this.status = s; this.code = c; this.details = d; } }
  return { __esModule: true, ...svc, DeploymentError, default: { ...svc, DeploymentError } };
});

import deploymentRoutes from '../src/routes/deploymentRoutes';
import { DeploymentError } from '../src/services/deploymentManagementService';
import { SERVICE_KEYS, ENDPOINT_AUTH_RULES, isServiceKeyAuthorizedForEndpoint, validateServiceKeyPermissions } from '@libs/service-auth';

const app = express(); app.use(express.json()); app.use('/api/admin/deployments', deploymentRoutes);

describe('/api/admin/deployments', () => {
  it('GET requires model', async () => { expect((await request(app).get('/api/admin/deployments')).status).toBe(400); });
  it('GET lists', async () => {
    svc.listDeploymentsForModel.mockResolvedValue([{ id: 'd1' }]);
    const r = await request(app).get('/api/admin/deployments?model=gpt-5.4');
    expect(r.status).toBe(200); expect(r.body).toEqual({ model: 'gpt-5.4', deployments: [{ id: 'd1' }] });
  });
  it('POST 201 and emits deployment_created', async () => {
    svc.createDeployment.mockResolvedValue({ deploymentId: 'd9', status: 'PENDING', configurationId: 'c1', reusedConfiguration: true, model: 'gpt-5.4' });
    const r = await request(app).post('/api/admin/deployments').send({ model: 'gpt-5.4' });
    expect(r.status).toBe(201); expect(r.body.deploymentId).toBe('d9');
    expect(emitDeploymentCreated).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4', deploymentId: 'd9' }));
  });
  it('POST maps 409 and 404', async () => {
    svc.createDeployment.mockRejectedValueOnce(new DeploymentError(409, 'deployment_exists', 'exists', { deploymentId: 'd1', status: 'RUNNING' }));
    const r = await request(app).post('/api/admin/deployments').send({ model: 'gpt-5.4' });
    expect(r.status).toBe(409); expect(r.body).toEqual({ error: 'deployment_exists', message: 'exists', deploymentId: 'd1', status: 'RUNNING' });
    svc.createDeployment.mockRejectedValueOnce(new DeploymentError(404, 'model_not_found', 'nope'));
    const r404 = await request(app).post('/api/admin/deployments').send({ model: 'x' });
    expect(r404.status).toBe(404); expect(r404.body).toEqual({ error: 'model_not_found', message: 'nope' });
  });
  it('GET /:id', async () => {
    svc.getDeploymentStatus.mockResolvedValue({ id: 'd1', status: 'RUNNING' });
    expect((await request(app).get('/api/admin/deployments/d1')).body).toEqual({ id: 'd1', status: 'RUNNING' });
  });
});

describe('service-key registry', () => {
  it('ADMIN_TO_GATEWAY may call the deployment endpoints with deployments:read/write', () => {
    expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS).toEqual(expect.arrayContaining(['deployments:read', 'deployments:write']));
    expect(isServiceKeyAuthorizedForEndpoint('ADMIN_TO_GATEWAY', '/api/admin/deployments')).toBe(true);
    expect(isServiceKeyAuthorizedForEndpoint('ADMIN_TO_GATEWAY', '/api/admin/deployments/d1')).toBe(true);
    expect(ENDPOINT_AUTH_RULES['/api/admin/deployments'].mode).toBe('STANDALONE_OR_SERVICE_KEY');
    expect(validateServiceKeyPermissions('ADMIN_TO_GATEWAY', '/api/admin/deployments/d1')).toBe(true);
  });
});
