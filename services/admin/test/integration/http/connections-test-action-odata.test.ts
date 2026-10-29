/**
 * testConnection / fetchModels on ProviderConnections (spec 2026-10-23 §7): the admin never calls a
 * provider; it asks the gateway, which holds the decrypted credential. The test result is kept on
 * the connection (lastTestAt, lastTestResult) as a reason code; the model list is only returned.
 * The gateway client is mocked here; its wire contract is the gateway's connection-admin-routes test.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'ct-admin@test.com': { id: 'ct-admin@test.com', roles: ['admin', 'user'] },
  'ct-user@test.com': { id: 'ct-user@test.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), publish: jest.fn(async () => false), shutdown: jest.fn() } }));
jest.mock('../../../src/services/connectionsNotifier', () => ({
  CONNECTIONS_CHANGE_CHANNEL: 'test:connections-changed', publishConnectionsChanged: jest.fn(async () => true) }));
const testConnection = jest.fn();
const listConnectionModels = jest.fn();
jest.mock('../../../src/services/gatewayConnectionsClient', () => ({
  ...jest.requireActual('../../../src/services/gatewayConnectionsClient'),
  testConnection: (...a: any[]) => testConnection(...a),
  listConnectionModels: (...a: any[]) => listConnectionModels(...a),
}));

const { POST, GET } = cds.test(path.resolve(__dirname, '../../..'));
const { GatewayConnectionsError } = require('../../../src/services/gatewayConnectionsClient');

const ADMIN = { auth: { username: 'ct-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'ct-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const conn = (id: string) => `${S}/ProviderConnections(ID=${id},IsActiveEntity=true)`;

let c: any;
beforeEach(async () => {
  await cds.run(cds.ql.DELETE.from(CONNS));
  c = (await POST(`${S}/ProviderConnections`, { name: 'oa', providerType: 'openai', IsActiveEntity: true }, ADMIN)).data;
  testConnection.mockReset();
  listConnectionModels.mockReset();
});

describe('testConnection', () => {
  it('testConnection stores lastTestAt and lastTestResult and returns the result', async () => {
    testConnection.mockResolvedValueOnce({ ok: true });
    const r = await POST(`${conn(c.ID)}/AdminService.testConnection`, {}, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true });
    expect(testConnection).toHaveBeenCalledWith(c.ID);
    const row = (await GET(conn(c.ID), ADMIN)).data;
    expect(row.lastTestResult).toBe('ok');
    expect(row.lastTestAt).toBeTruthy();

    testConnection.mockResolvedValueOnce({ ok: false, error: { reason: 'unauthorized', status: 401 } });
    const refused = await POST(`${conn(c.ID)}/AdminService.testConnection`, {}, ADMIN);
    expect(refused.data).toMatchObject({ ok: false, reason: 'unauthorized', status: 401 });
    expect((await GET(conn(c.ID), ADMIN)).data.lastTestResult).toBe('unauthorized:401');
  });

  it('an unreachable gateway is a result, not an error', async () => {
    testConnection.mockResolvedValueOnce({ ok: false, error: { reason: 'gateway_unreachable' } });
    const r = await POST(`${conn(c.ID)}/AdminService.testConnection`, {}, ADMIN);
    expect(r.data).toMatchObject({ ok: false, reason: 'gateway_unreachable' });
    expect((await GET(conn(c.ID), ADMIN)).data.lastTestResult).toBe('gateway_unreachable');
  });

  // The gateway's snapshot holds active connections only: its 404 for an inactive one is not "not found".
  it('an inactive connection is a result (inactive), stamped like any other', async () => {
    await cds.run(cds.ql.UPDATE(CONNS).set({ isActive: false }).where({ ID: c.ID }));
    testConnection.mockRejectedValueOnce(new GatewayConnectionsError(404, 'connection_not_found', `No connection ${c.ID}`));
    const r = await POST(`${conn(c.ID)}/AdminService.testConnection`, {}, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: false, reason: 'inactive' });
    const row = (await GET(conn(c.ID), ADMIN)).data;
    expect(row.lastTestResult).toBe('inactive');
    expect(row.lastTestAt).toBeTruthy();
  });

  it('a gateway 404 for an active connection stays an error', async () => {
    testConnection.mockRejectedValueOnce(new GatewayConnectionsError(404, 'connection_not_found', `No connection ${c.ID}`));
    expect((await ok(POST(`${conn(c.ID)}/AdminService.testConnection`, {}, ADMIN))).status).toBe(404);
  });

  it('only the admin role may call either action', async () => {
    expect((await ok(POST(`${conn(c.ID)}/AdminService.testConnection`, {}, USER))).status).toBe(403);
    expect((await ok(POST(`${conn(c.ID)}/AdminService.fetchModels`, {}, USER))).status).toBe(403);
    expect(testConnection).not.toHaveBeenCalled();
    expect(listConnectionModels).not.toHaveBeenCalled();
  });
});

describe('fetchModels', () => {
  it('fetchModels returns the ids and writes nothing', async () => {
    listConnectionModels.mockResolvedValueOnce(['gpt-4o-mini', 'gpt-4o']);
    const before = (await GET(conn(c.ID), ADMIN)).data;
    const r = await POST(`${conn(c.ID)}/AdminService.fetchModels`, {}, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data.value).toEqual(['gpt-4o-mini', 'gpt-4o']);
    const after = (await GET(conn(c.ID), ADMIN)).data;
    expect(after.modifiedAt).toBe(before.modifiedAt);
  });

  it('a gateway 401/403 (the admin\'s own service key refused) is a 502, never an auth failure of the cockpit user', async () => {
    listConnectionModels.mockRejectedValueOnce(new GatewayConnectionsError(401, 'unauthorized', 'Invalid service key'));
    expect((await ok(POST(`${conn(c.ID)}/AdminService.fetchModels`, {}, ADMIN))).status).toBe(502);
    testConnection.mockRejectedValueOnce(new GatewayConnectionsError(403, 'forbidden', 'Insufficient permissions'));
    expect((await ok(POST(`${conn(c.ID)}/AdminService.testConnection`, {}, ADMIN))).status).toBe(502);
  });

  it('an inactive connection is refused with 409 and a clear message', async () => {
    await cds.run(cds.ql.UPDATE(CONNS).set({ isActive: false }).where({ ID: c.ID }));
    listConnectionModels.mockRejectedValueOnce(new GatewayConnectionsError(404, 'connection_not_found', `No connection ${c.ID}`));
    const r = await ok(POST(`${conn(c.ID)}/AdminService.fetchModels`, {}, ADMIN));
    expect(r.status).toBe(409);
    expect(String(r.data.error.message)).toBe('The connection is not active; activate it to list its models.');
  });

  it('a gateway refusal keeps its status and reason', async () => {
    listConnectionModels.mockRejectedValueOnce(new GatewayConnectionsError(409, 'no_credential', 'The connection has no credential'));
    const r = await ok(POST(`${conn(c.ID)}/AdminService.fetchModels`, {}, ADMIN));
    expect(r.status).toBe(409);
    expect(String(r.data.error.message)).toContain('no_credential');
  });
});
