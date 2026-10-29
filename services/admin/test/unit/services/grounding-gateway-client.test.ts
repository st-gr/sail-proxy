export {};
jest.mock('axios');
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../../src/services/modelCostService', () => ({
  __esModule: true,
  modelCostService: { getGatewayServiceKey: jest.fn().mockResolvedValue('sk-service') },
  default: { getGatewayServiceKey: jest.fn().mockResolvedValue('sk-service') }
}));

import axios from 'axios';
import { callGateway, gatewayHeaders } from '../../../src/services/groundingGatewayClient';

const request = axios.request as unknown as jest.Mock;
const actor = { email: 'user@test.com', role: 'user' as const };

beforeEach(() => { request.mockReset(); process.env.GATEWAY_URL = 'http://gw:3000'; });

describe('callGateway', () => {
  it('sends the service key and the acting user, and returns the gateway\'s status and body as they are', async () => {
    request.mockResolvedValue({ status: 404, headers: { 'content-type': 'application/json' }, data: { error: { code: 'not_found', message: 'No such file.' } } });
    const reply = await callGateway(actor, 'get', '/files/file-a');
    expect(reply).toEqual({ status: 404, headers: { 'content-type': 'application/json' }, data: { error: { code: 'not_found', message: 'No such file.' } } });
    const config = request.mock.calls[0][0];
    expect(config.method).toBe('get');
    expect(config.url).toBe('http://gw:3000/api/admin/grounding/files/file-a');
    expect(config.headers).toEqual(expect.objectContaining({
      'X-API-Key': 'sk-service', 'X-Grounding-Acting-Email': 'user@test.com', 'X-Grounding-Acting-Role': 'user'
    }));
    expect(config.validateStatus(500)).toBe(true);
  });

  it('appends the query and sends a JSON body with its content type', async () => {
    request.mockResolvedValue({ status: 200, headers: {}, data: { id: 'vs_1' } });
    await callGateway({ email: 'admin@test.com', role: 'admin' }, 'post', '/stores', { query: new URLSearchParams({ limit: '5' }), body: { name: 'Docs' } });
    const config = request.mock.calls[0][0];
    expect(config.url).toBe('http://gw:3000/api/admin/grounding/stores?limit=5');
    expect(config.data).toEqual({ name: 'Docs' });
    expect(config.headers['Content-Type']).toBe('application/json');
    expect(config.headers['X-Grounding-Acting-Role']).toBe('admin');
  });

  it('answers 502 gateway_unreachable instead of throwing when the gateway is down', async () => {
    request.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const reply = await callGateway(actor, 'get', '/status');
    expect(reply.status).toBe(502);
    expect(reply.data).toEqual({ error: 'gateway_unreachable', message: 'The gateway could not be reached.' });
  });
});

describe('gatewayHeaders teams', () => {
  it('sends the acting teams and admin teams as comma-separated ids; an older caller without them sends none', async () => {
    const h = await gatewayHeaders({ email: 'u@test.com', role: 'user', teamIds: ['a', 'b'], adminTeamIds: ['a'] });
    expect(h).toMatchObject({ 'X-Grounding-Acting-Teams': 'a,b', 'X-Grounding-Acting-Admin-Teams': 'a' });
    const plain = await gatewayHeaders({ email: 'u@test.com', role: 'user' });
    expect(plain).not.toHaveProperty('X-Grounding-Acting-Teams');
  });
});
