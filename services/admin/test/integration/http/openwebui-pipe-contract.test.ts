/**
 * The Open WebUI per-user-key pipe manages keys through the admin's OData API, authenticated with the gateway
 * service JWT (which the docker middleware turns into admin@test.com with roles admin, user, service; see
 * ../../unit/auth-middleware-service-jwt.test.ts). These tests pin the API side of that contract on cds.test(),
 * with the pipe's exact requests: createApiKey for another user with permissions and rate limits returns the full
 * key, and the pipe's name filter with its $select finds that key again, active and in full.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  // The user context the middleware builds from the pipe's service JWT.
  'admin@test.com': { id: 'admin@test.com', roles: ['admin', 'user', 'service'] },
  'someone@example.com': { id: 'someone@example.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), shutdown: jest.fn() } }));

const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));

const PIPE = { auth: { username: 'admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);

/** The pipe's lookup URL (_find_existing_key): the filter quoted with nothing safe, the $select it reads. */
const lookup = (name: string) =>
  `${S}/ApiKeys?$filter=${encodeURIComponent(`name eq '${name}'`)}&$select=ID,key,maskedKey,name,isActive`;

describe('the Open WebUI pipe\'s key management contract', () => {
  const email = 'alice@example.com';
  const name = `Open WebUI - ${email}`;
  let created: string;

  it('createApiKey for another user, with permissions and rate limits, returns the full key', async () => {
    const r = await ok(POST(`${S}/createApiKey`, {
      name, email,
      permissions: ['models:read', 'chat:create'],
      rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, requestsPerDay: 5000 }
    }, PIPE));
    expect([200, 201]).toContain(r.status);
    expect(r.data.key).toMatch(/^sk-.{8,}/);
    created = r.data.key;
  });

  it('the name filter finds that key again, active and in full', async () => {
    const r = await GET(lookup(name), PIPE);
    expect(r.status).toBe(200);
    expect(r.data.value).toHaveLength(1);
    expect(r.data.value[0]).toMatchObject({ name, isActive: true, key: created });
  });

  it('a name nobody has finds nothing (the pipe then creates a key)', async () => {
    const r = await GET(lookup('Open WebUI - nobody@example.com'), PIPE);
    expect(r.status).toBe(200);
    expect(r.data.value).toEqual([]);
  });

  it('an ordinary user cannot create keys for someone else', async () => {
    const r = await ok(POST(`${S}/createApiKey`, { name: 'x', email: 'bob@example.com' }, { auth: { username: 'someone@example.com', password: 'x' } }));
    expect(r.status).toBe(403);
  });
});
