/**
 * New AWS credentials take the region of the active SAP AI Core connection; without one, SAP_AI_REGION
 * (else us-east-1) applies as before. A credential that exists keeps the region it was stamped with.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'rg-admin@test.com': { id: 'rg-admin@test.com', roles: ['admin', 'user'] } } };

jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: {
    bulkInvalidate: jest.fn(async () => undefined),
    invalidatePattern: jest.fn(async () => 0), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn()
  },
  default: {}
}));

const { POST } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'rg-admin@test.com', password: 'x' } };
const CONNECTIONS = 'sap.llm.gateway.admin.ProviderConnections';
const CREDENTIALS = 'sap.llm.gateway.admin.AwsCredentials';
const S = '/odata/v4/admin';

const connection = (row: Record<string, unknown>) =>
  cds.run(cds.ql.INSERT.into(CONNECTIONS).entries({ ID: cds.utils.uuid(), title: 'x', ...row }));
const stored = async (accessKeyId: string) =>
  (await cds.run(cds.ql.SELECT.one.from(CREDENTIALS).columns('region', 'sapAiRegion').where({ accessKeyId }))) as { region: string; sapAiRegion: string };
const create = async (email: string) => {
  const r = await POST(`${S}/createAwsCredentials`, { userId: email, email, name: 'rg', permissions: [] }, ADMIN);
  expect(r.status).toBe(200);
  return r.data;
};

describe('new AWS credentials follow the active SAP AI Core region', () => {
  const saved = process.env.SAP_AI_REGION;
  afterAll(() => { if (saved === undefined) delete process.env.SAP_AI_REGION; else process.env.SAP_AI_REGION = saved; });

  it('without an active SAP AI Core connection the environment value applies', async () => {
    process.env.SAP_AI_REGION = 'us-west-2';
    const data = await create('rg-env@test.com');
    expect(data.region).toBe('us-west-2');
    expect(data.sapAiRegion).toBe('us-west-2');
    expect(await stored(data.accessKeyId)).toEqual({ region: 'us-west-2', sapAiRegion: 'us-west-2' });
  });

  it('an inactive SAP AI Core connection and an active connection of another type are ignored', async () => {
    process.env.SAP_AI_REGION = 'us-west-2';
    await connection({ name: 'sap-off', providerType: 'sap-ai-core', isActive: false, region: 'prod.ap-southeast-1', productive: true });
    await connection({ name: 'bed-on', providerType: 'bedrock', isActive: true, region: 'eu-west-1' });
    const data = await create('rg-ignored@test.com');
    expect(data.region).toBe('us-west-2');
    expect(data.sapAiRegion).toBe('us-west-2');
  });

  it('with an active connection in prod.eu-central-1 the credential takes its region', async () => {
    process.env.SAP_AI_REGION = 'us-west-2';
    await connection({ name: 'sap-on', providerType: 'sap-ai-core', isActive: true, region: 'prod.eu-central-1', productive: true });
    const data = await create('rg-conn@test.com');
    expect(data.region).toBe('eu-central-1');
    expect(data.sapAiRegion).toBe('prod.eu-central-1');
    expect(await stored(data.accessKeyId)).toEqual({ region: 'eu-central-1', sapAiRegion: 'prod.eu-central-1' });
  });

  it('an existing credential is not re-stamped when the active region changes', async () => {
    process.env.SAP_AI_REGION = 'us-west-2';
    await cds.run(cds.ql.UPDATE(CONNECTIONS).set({ isActive: false }).where({ providerType: 'sap-ai-core' }));
    const first = await create('rg-keep@test.com');
    expect(first.region).toBe('us-west-2');
    await cds.run(cds.ql.UPDATE(CONNECTIONS).set({ isActive: true }).where({ name: 'sap-on' }));
    const second = await create('rg-keep2@test.com');
    expect(second.region).toBe('eu-central-1');
    expect(await stored(first.accessKeyId)).toEqual({ region: 'us-west-2', sapAiRegion: 'us-west-2' });
  });

  it('a new draft is prefilled with the active region', async () => {
    const r = await POST(`${S}/AwsCredentials`, { name: 'rg-draft', userId: 'rg-draft@test.com', email: 'rg-draft@test.com' }, ADMIN);
    expect(r.status).toBe(201);
    expect(r.data.sapAiRegion).toBe('prod.eu-central-1');
    expect(r.data.region).toBe('eu-central-1');
  });
});
