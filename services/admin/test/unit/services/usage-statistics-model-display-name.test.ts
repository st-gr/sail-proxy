/**
 * getUsageStatistics names each model for the Usage app: the Model Library's display name when
 * there is no current pricing row (deployment-served twins such as `<model>--deployed` have
 * none), the pricing row's name where one exists, and the raw id only when neither knows the
 * model. A model and its twin then share one name, so each row also says how it is reached:
 * accessType 'foundation' or 'deployment', from the library, else from the id suffix.
 * Boots the real AdminService via cds.test() on in-memory SQLite with mocked users; runs
 * bare — never touches db/admin.db or :4004.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'dn-admin@test.com': { id: 'dn-admin@test.com', roles: ['admin', 'user'] }
  }
};

const { GET } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'dn-admin@test.com', password: 'x' } };
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const LIBRARY = 'sap.llm.gateway.admin.LibraryModels';
const COSTS = 'sap.llm.gateway.admin.ModelCosts';

const DEPLOYED = 'anthropic--claude-4.8-opus--deployed';
const BARE = 'anthropic--claude-4.8-opus';
const PRICED = 'gemini-2.5-flash';
const UNLISTED = 'unlisted-model';
const UNLISTED_DEPLOYED = 'retired-model--deployed';
const VALID_FROM = '2026-09-15T10:00:00.000Z';
const CURRENT = '9999-12-31T00:00:00.000Z';

const keyRow = (model: string, n: number) => ({
  apiKey_ID: 'k-dn', email: 'dn-admin@test.com', validFrom: VALID_FROM, validTo: '9999-12-31T23:59:59.999Z',
  provider: 'anthropic', model, statusCode: 200, inputTokens: 10, outputTokens: 5, totalTokens: 15,
  responseTime: 100, usageSignature: `dn-${model}-${n}`
});

const seed = async () => {
  const db = cds.db;
  const { INSERT } = cds.ql;
  await db.run(INSERT.into(KEYS).entries({ ID: 'k-dn', key: 'sk-dn', name: 'k', email: 'dn-admin@test.com', isActive: true }));
  await db.run(INSERT.into(AWS).entries({ ID: 'c-dn', accessKeyId: 'AKIADN', secretHash: 'h', salt: 's', name: 'c', email: 'dn-admin@test.com', userId: 'dn-user', isActive: true }));
  await db.run(INSERT.into(LIBRARY).entries([
    { modelId: BARE, displayName: 'Claude 4.8 Opus', provider: 'anthropic', accessType: 'foundation' },
    { modelId: DEPLOYED, displayName: 'Claude 4.8 Opus', provider: 'anthropic', accessType: 'deployment' },
    { modelId: PRICED, displayName: 'Gemini 2.5 Flash (library)', provider: 'google', accessType: 'foundation' }
  ]));
  // The only pricing row: the library knows PRICED under another name, the pricing name must win.
  await db.run(INSERT.into(COSTS).entries({
    model: PRICED, displayName: 'Gemini 2.5 Flash', provider: 'google',
    dateFrom: '2020-01-01T00:00:00.000Z', dateTo: CURRENT, inputCost: 0.001, outputCost: 0.002
  }));
  await db.run(INSERT.into(KEY_USAGE).entries([
    keyRow(DEPLOYED, 1), keyRow(DEPLOYED, 2), keyRow(DEPLOYED, 3), keyRow(BARE, 1), keyRow(PRICED, 1), keyRow(UNLISTED, 1), keyRow(UNLISTED_DEPLOYED, 1)
  ]));
  await db.run(INSERT.into(AWS_USAGE).entries({
    credential_ID: 'c-dn', userId: 'dn-user', validFrom: VALID_FROM, validTo: '9999-12-31T23:59:59.999Z',
    provider: 'aws-bedrock', modelId: DEPLOYED, statusCode: 200, inputTokens: 10, outputTokens: 5,
    responseTime: 100, usageSignature: 'dn-aws-1'
  }));
};

let byModel: Map<string, any>;

describe('getUsageStatistics modelUsage.displayName', () => {
  beforeAll(async () => {
    await seed();
    const { status, data } = await GET("/odata/v4/admin/getUsageStatistics(startDate=2026-09-01,endDate=2026-09-30,granularity='day')", ADMIN);
    expect(status).toBe(200);
    byModel = new Map(data.modelUsage.map((m: any) => [`${m.modelId}|${m.provider}`, m]));
  });

  it('a deployment-served twin without a pricing row is named by the Model Library (API-key traffic)', () => {
    const model = byModel.get(`${DEPLOYED}|anthropic`);
    expect(model).toBeDefined();
    expect(model.displayName).toBe('Claude 4.8 Opus');
    expect(model.totalRequests).toBe(3);
  });

  it('the same for AWS-credential traffic', () => {
    expect(byModel.get(`${DEPLOYED}|aws-bedrock`)?.displayName).toBe('Claude 4.8 Opus');
  });

  it('the bare id resolves through the library as well', () => {
    expect(byModel.get(`${BARE}|anthropic`)?.displayName).toBe('Claude 4.8 Opus');
  });

  it('a current pricing row still names the model ahead of the library', () => {
    expect(byModel.get(`${PRICED}|anthropic`)?.displayName).toBe('Gemini 2.5 Flash');
  });

  it('a model neither source knows keeps its raw id', () => {
    expect(byModel.get(`${UNLISTED}|anthropic`)?.displayName).toBe(UNLISTED);
  });
});

// Reads the response the block above fetched: the seed must run once, after the service boot.
describe('getUsageStatistics modelUsage.accessType', () => {
  it('a deployment-served twin is marked deployment, for API-key and AWS-credential traffic', () => {
    expect(byModel.get(`${DEPLOYED}|anthropic`)?.accessType).toBe('deployment');
    expect(byModel.get(`${DEPLOYED}|aws-bedrock`)?.accessType).toBe('deployment');
  });

  it('its bare twin is marked foundation, so the two rows with one name can be told apart', () => {
    const bare = byModel.get(`${BARE}|anthropic`);
    const deployed = byModel.get(`${DEPLOYED}|anthropic`);
    expect(bare?.displayName).toBe(deployed?.displayName);
    expect(bare?.accessType).toBe('foundation');
  });

  it('a priced library model keeps the library access type', () => {
    expect(byModel.get(`${PRICED}|anthropic`)?.accessType).toBe('foundation');
  });

  it('a model the library does not know is decided by the --deployed suffix', () => {
    expect(byModel.get(`${UNLISTED_DEPLOYED}|anthropic`)?.accessType).toBe('deployment');
  });

  it('an unknown bare id stays undecided', () => {
    expect(byModel.get(`${UNLISTED}|anthropic`)?.accessType).toBeNull();
  });

  it('the extra library column does not split a model into several rows', () => {
    expect(byModel.get(`${DEPLOYED}|anthropic`)?.totalRequests).toBe(3);
    expect(byModel.size).toBe(6);
  });
});
