/**
 * The admin -> gateway deployment client (spec section 5). The admin never holds AI Core
 * credentials, so every call here must carry the ADMIN_TO_GATEWAY service key and turn a
 * gateway error body into a GatewayDeploymentError that keeps the HTTP status and the code.
 * axios is mocked - no test may reach a live gateway.
 */
export {};
jest.mock('axios');
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../../src/services/modelCostService', () => ({ __esModule: true, modelCostService: { getGatewayServiceKey: jest.fn().mockResolvedValue('sk-service') }, default: { getGatewayServiceKey: jest.fn().mockResolvedValue('sk-service') } }));

import axios from 'axios';
import { listDeployments, createDeployment, deploymentStatus, GatewayDeploymentError } from '../../../src/services/gatewayDeploymentClient';

const get = axios.get as jest.Mock; const post = axios.post as jest.Mock;
beforeEach(() => { get.mockReset(); post.mockReset(); process.env.GATEWAY_URL = 'http://gw:3000'; });

describe('gatewayDeploymentClient', () => {
  it('lists with the service key header', async () => {
    get.mockResolvedValue({ data: { model: 'm', deployments: [{ id: 'd1' }] } });
    expect(await listDeployments('m')).toEqual([{ id: 'd1' }]);
    expect(get).toHaveBeenCalledWith('http://gw:3000/api/admin/deployments', expect.objectContaining({ params: { model: 'm' }, headers: expect.objectContaining({ 'X-API-Key': 'sk-service' }) }));
  });
  it('creates and maps gateway errors to GatewayDeploymentError with the status', async () => {
    post.mockResolvedValueOnce({ data: { deploymentId: 'd9', status: 'PENDING', configurationId: 'c', reusedConfiguration: false } });
    expect(await createDeployment('m')).toEqual({ deploymentId: 'd9', status: 'PENDING', configurationId: 'c', reusedConfiguration: false });
    post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'deployment_exists', message: 'exists', deploymentId: 'd1' } } });
    await expect(createDeployment('m')).rejects.toMatchObject({ status: 409, code: 'deployment_exists' });
    expect((await createDeployment('m').catch(e => e)) instanceof GatewayDeploymentError).toBe(true);
  });
  it('status', async () => {
    get.mockResolvedValue({ data: { id: 'd1', status: 'RUNNING', deploymentUrl: 'u' } });
    expect(await deploymentStatus('d1')).toEqual({ status: 'RUNNING', deploymentUrl: 'u' });
  });
});
