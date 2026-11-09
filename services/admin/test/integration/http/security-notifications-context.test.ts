/**
 * An event logged through logSecurityEvent (the gateway's path) yields a MySecurityNotifications
 * row that exposes clientIP / userAgent / endpoint / requestId, filterable and searchable.
 * cds.test() in-memory, mocked users — never touches db/admin.db or :4004.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'sn-admin@test.com': { id: 'sn-admin@test.com', roles: ['admin', 'user'] },
    'sn-user@test.com': { id: 'sn-user@test.com', roles: ['user'] }
  }
};
const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'sn-admin@test.com', password: 'x' } };
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const NOTES = 'sap.llm.gateway.admin.SecurityNotifications';
const EVENTS = 'sap.llm.gateway.admin.ApiKeySecurityEvents';

beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [NOTES, EVENTS, KEYS]) await cds.db.run(DELETE.from(t));
  await cds.db.run(INSERT.into(KEYS).entries({ ID: 'k-sn-1', key: 'sk-sn-1', name: 'sn key', email: 'sn-user@test.com', isActive: true }));
});

const EVENT = {
  credentialId: 'sk-sn-1', authType: 'api_key', eventType: 'failed_auth', severity: 'high',
  description: 'bad key', clientIP: '203.0.113.7', userAgent: 'jest/1.0', endpoint: '/v1/messages',
  requestId: 'req-ctx-1', actionTaken: 'blocked'
};

describe('MySecurityNotifications request context', () => {
  it('logSecurityEvent carries the four context fields into the envelope', async () => {
    const logged = await POST('/odata/v4/admin/logSecurityEvent', EVENT, ADMIN);
    expect(logged.data.success).toBe(true);

    const list = await GET(`/odata/v4/admin/MySecurityNotifications?$filter=clientIP eq '203.0.113.7'`, ADMIN);
    expect(list.data.value).toHaveLength(1);
    expect(list.data.value[0]).toMatchObject({
      eventType: 'failed_auth', ownerEmail: 'sn-user@test.com',
      clientIP: '203.0.113.7', userAgent: 'jest/1.0', endpoint: '/v1/messages', requestId: 'req-ctx-1'
    });
  });

  it('an administrator can search for an address', async () => {
    await POST('/odata/v4/admin/logSecurityEvent', EVENT, ADMIN);
    const found = await GET(`/odata/v4/admin/MySecurityNotifications?$search="203.0.113.7"`, ADMIN);
    expect(found.data.value.map((n: any) => n.clientIP)).toEqual(['203.0.113.7']);
  });
});
