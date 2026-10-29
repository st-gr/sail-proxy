/**
 * An e-mail ending in ".service.key" identifies the admin's own gateway key, which the gateway
 * trusts with the Grounding acting headers. The cockpit must never mint a credential for it.
 * (modelCostService inserts the real service key straight into the database table and so never
 * runs through these handlers.)
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'sk-admin@test.com': { id: 'sk-admin@test.com', roles: ['admin', 'user'] } } };

jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: {
    bulkInvalidate: jest.fn(async () => undefined),
    invalidatePattern: jest.fn(async () => 0), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn()
  },
  default: {}
}));

const { POST, PATCH } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'sk-admin@test.com', password: 'x' } };
const RESERVED = 'admin2gateway.service.key';
const MESSAGE = 'This e-mail is reserved for platform service keys.';

const attempt = (p: Promise<any>) => p.catch((e: any) => e.response);

describe('platform service-key e-mails are refused on cockpit-created credentials', () => {
  it('createApiKey with a service-key e-mail answers 400', async () => {
    const r = await attempt(POST('/odata/v4/admin/createApiKey', { name: 'x', email: RESERVED }, ADMIN));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.data)).toContain(MESSAGE);
  });

  it('createApiKey with a normal e-mail still works', async () => {
    const r = await attempt(POST('/odata/v4/admin/createApiKey', { name: 'x', email: 'sk-user@test.com' }, ADMIN));
    expect(r.status).toBe(200);
  });

  it('a new ApiKeys draft with a service-key e-mail answers 400, a normal one is created', async () => {
    const bad = await attempt(POST('/odata/v4/admin/ApiKeys', { name: 'x', email: RESERVED }, ADMIN));
    expect(bad.status).toBe(400);
    const ok = await attempt(POST('/odata/v4/admin/ApiKeys', { name: 'x', email: 'sk-user@test.com' }, ADMIN));
    expect(ok.status).toBe(201);
  });

  it('changing a draft key e-mail to a service-key address answers 400', async () => {
    const draft = await POST('/odata/v4/admin/ApiKeys', { name: 'x', email: 'sk-user@test.com' }, ADMIN);
    const r = await attempt(PATCH(`/odata/v4/admin/ApiKeys(ID=${draft.data.ID},IsActiveEntity=false)`, { email: RESERVED }, ADMIN));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.data)).toContain(MESSAGE);
  });

  it('changing an existing active key e-mail to a service-key address answers 400', async () => {
    const created = await POST('/odata/v4/admin/createApiKey', { name: 'y', email: 'sk-user2@test.com' }, ADMIN);
    const srv = await cds.connect.to('AdminService');
    const update = cds.ql.UPDATE('AdminService.ApiKeys').set({ email: RESERVED }).where({ ID: created.data.id });
    const asAdmin = new cds.User({ id: 'sk-admin@test.com', roles: ['admin', 'user'] });
    await expect(srv.tx({ user: asAdmin }, () => srv.run(update))).rejects.toMatchObject({ code: 400, message: MESSAGE });
  });

  it('changing an existing active AWS credential e-mail to a service-key address answers 400', async () => {
    const created = await POST('/odata/v4/admin/createAwsCredentials', { userId: 'sk-user3@test.com', email: 'sk-user3@test.com', name: 'z', permissions: [] }, ADMIN);
    const srv = await cds.connect.to('AdminService');
    const rows = await cds.run(cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials').columns('ID').where({ email: 'sk-user3@test.com' }));
    expect(created.status).toBe(200);
    const update = cds.ql.UPDATE('AdminService.AwsCredentials').set({ email: RESERVED }).where({ ID: rows[0].ID });
    const asAdmin = new cds.User({ id: 'sk-admin@test.com', roles: ['admin', 'user'] });
    await expect(srv.tx({ user: asAdmin }, () => srv.run(update))).rejects.toMatchObject({ code: 400, message: MESSAGE });
  });

  it('createAwsCredentials with a service-key e-mail answers 400, a normal one works', async () => {
    const bad = await attempt(POST('/odata/v4/admin/createAwsCredentials', { userId: 'sk-user@test.com', email: RESERVED, name: 'x', permissions: [] }, ADMIN));
    expect(bad.status).toBe(400);
    const ok = await attempt(POST('/odata/v4/admin/createAwsCredentials', { userId: 'sk-user@test.com', email: 'sk-user@test.com', name: 'x', permissions: [] }, ADMIN));
    expect(ok.status).toBe(200);
  });

  it('a new AwsCredentials draft with a service-key e-mail answers 400, and a draft e-mail change too', async () => {
    const bad = await attempt(POST('/odata/v4/admin/AwsCredentials', { name: 'x', userId: 'sk-user@test.com', email: RESERVED }, ADMIN));
    expect(bad.status).toBe(400);
    const draft = await POST('/odata/v4/admin/AwsCredentials', { name: 'x', userId: 'sk-user@test.com', email: 'sk-user@test.com' }, ADMIN);
    const r = await attempt(PATCH(`/odata/v4/admin/AwsCredentials(ID=${draft.data.ID},IsActiveEntity=false)`, { email: RESERVED }, ADMIN));
    expect(r.status).toBe(400);
  });
});
