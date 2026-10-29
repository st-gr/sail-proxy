/**
 * When validateUnifiedAuthByToken refuses a credential that exists but is inactive or expired,
 * the invalid result names the row in `error.credentialId`, so the gateway's failed-auth event
 * links to the credential and its owner is notified. An unknown key or access key id gets no id,
 * and neither does a caller without the gateway's service JWT.
 *
 * @see ../../../src/srv/validation-service.ts validateApiKeyByToken / validateAwsCredentialByToken
 */
import path from 'path';
import jwt from 'jsonwebtoken';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
const cdsTest = cds.test(path.resolve(__dirname, '../../..'));

const validationService = require('../../../src/srv/validation-service').instance;
const svc: any = validationService;

const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS_ID = '0b7f6c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
const KEY_ID = '1c8a7d2f-3e4b-4c6d-9e0f-1a2b3c4d5e6f';
const ACCESS_KEY_ID = 'AKIDREFUSEDFIXTURE01';
const API_KEY = 'sk-refused-fixture-0123456789abcdef';

const TEST_TOKEN_SECRET = 'refused-id-test-validation-token-secret-0123456789';
const gatewayJwt = () =>
  jwt.sign({ sub: 'gateway', service: 'gateway' }, TEST_TOKEN_SECRET, { algorithm: 'HS256', issuer: 'gateway-service', expiresIn: 300 });
const asGateway = () => ({ authorization: `Bearer ${gatewayJwt()}` });

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });

const savedSecret = process.env.VALIDATION_TOKEN_SECRET;
beforeEach(async () => {
  process.env.VALIDATION_TOKEN_SECRET = TEST_TOKEN_SECRET;
  svc.cache.awsCredentials.clear();
  svc.cache.apiKeys.clear();
  const { DELETE, INSERT } = cds.ql;
  await db.run(DELETE.from(AWS));
  await db.run(DELETE.from(KEYS));
  await db.run(INSERT.into(AWS).entries({
    ID: AWS_ID, accessKeyId: ACCESS_KEY_ID, secretHash: 'h', salt: 's', name: 'refused fixture',
    email: 'robin.fixture@example.com', userId: 'robin.fixture@example.com', region: 'us-east-1', isActive: true
  }));
  await db.run(INSERT.into(KEYS).entries({
    ID: KEY_ID, key: API_KEY, name: 'refused fixture', email: 'robin.fixture@example.com', isActive: true
  }));
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.VALIDATION_TOKEN_SECRET; else process.env.VALIDATION_TOKEN_SECRET = savedSecret;
});

const EXPIRED = { expiresAt: '2001-01-01T00:00:00Z', neverExpires: false };

async function validate(authType: 'aws_credential' | 'api_key', identifier: string, headers: Record<string, string> = asGateway(), signingScopes?: unknown): Promise<any> {
  const { token } = await svc.createUnifiedValidationToken({ data: {
    authType, identifier, clientIp: '127.0.0.1', method: 'POST', endpoint: '/x', signature: 'sig', signingScopes
  } });
  return svc.validateUnifiedAuthByToken({ data: { token }, headers });
}

describe('AWS: a refused credential that exists is named in error.credentialId', () => {
  it('inactive -> the row ID', async () => {
    await db.run(cds.ql.UPDATE(AWS).set({ isActive: false }).where({ ID: AWS_ID }));
    const r = await validate('aws_credential', ACCESS_KEY_ID);
    expect(r.valid).toBe(false);
    expect(r.error).toMatchObject({ code: 'AWS_CREDENTIAL_NOT_FOUND', credentialId: AWS_ID });
  });

  it('expired -> the row ID, and the credential is locked', async () => {
    await db.run(cds.ql.UPDATE(AWS).set(EXPIRED).where({ ID: AWS_ID }));
    const r = await validate('aws_credential', ACCESS_KEY_ID);
    expect(r.error).toMatchObject({ code: 'AWS_CREDENTIAL_EXPIRED', credentialId: AWS_ID });
    expect((await db.run(cds.ql.SELECT.one.from(AWS).columns('isActive').where({ ID: AWS_ID }))).isActive).toBeFalsy();
  });

  // A cache hit re-reads the row only when the gateway asks for signing keys, as it does on every request.
  it('a cache hit for a credential deactivated or expired since -> the row ID', async () => {
    const d = new Date();
    const today = [{ date: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`, region: 'us-east-1', service: 'bedrock' }];
    expect((await validate('aws_credential', ACCESS_KEY_ID)).valid).toBe(true);
    await db.run(cds.ql.UPDATE(AWS).set({ isActive: false }).where({ ID: AWS_ID }));
    const deactivated = await validate('aws_credential', ACCESS_KEY_ID, asGateway(), today);
    expect(deactivated.error).toMatchObject({ code: 'AWS_CREDENTIAL_NOT_FOUND', credentialId: AWS_ID });

    svc.cache.awsCredentials.clear();
    await db.run(cds.ql.UPDATE(AWS).set({ isActive: true }).where({ ID: AWS_ID }));
    expect((await validate('aws_credential', ACCESS_KEY_ID)).valid).toBe(true);
    await db.run(cds.ql.UPDATE(AWS).set(EXPIRED).where({ ID: AWS_ID }));
    const expired = await validate('aws_credential', ACCESS_KEY_ID, asGateway(), today);
    expect(expired.error).toMatchObject({ code: 'AWS_CREDENTIAL_EXPIRED', credentialId: AWS_ID });
  });

  it('unknown access key id -> no id', async () => {
    const r = await validate('aws_credential', 'AKIDUNKNOWNFIXTURE01');
    expect(r.valid).toBe(false);
    expect(r.error).not.toHaveProperty('credentialId');
  });

  it('a caller without the gateway service JWT gets no id', async () => {
    await db.run(cds.ql.UPDATE(AWS).set({ isActive: false }).where({ ID: AWS_ID }));
    const r = await validate('aws_credential', ACCESS_KEY_ID, {});
    expect(r.valid).toBe(false);
    expect(r.error).not.toHaveProperty('credentialId');
  });
});

describe('API key: a refused key that exists is named in error.credentialId', () => {
  it('inactive -> the row ID', async () => {
    await db.run(cds.ql.UPDATE(KEYS).set({ isActive: false }).where({ ID: KEY_ID }));
    const r = await validate('api_key', API_KEY);
    expect(r.valid).toBe(false);
    expect(r.error).toMatchObject({ code: 'API_KEY_NOT_FOUND', credentialId: KEY_ID });
  });

  it('expired -> the row ID', async () => {
    await db.run(cds.ql.UPDATE(KEYS).set(EXPIRED).where({ ID: KEY_ID }));
    const r = await validate('api_key', API_KEY);
    expect(r.error).toMatchObject({ code: 'API_KEY_EXPIRED', credentialId: KEY_ID });
  });

  it('unknown key -> no id', async () => {
    const r = await validate('api_key', 'sk-unknown-fixture-0123456789abcdef');
    expect(r.valid).toBe(false);
    expect(r.error).not.toHaveProperty('credentialId');
  });

  it('a caller without the gateway service JWT gets no id', async () => {
    await db.run(cds.ql.UPDATE(KEYS).set({ isActive: false }).where({ ID: KEY_ID }));
    const r = await validate('api_key', API_KEY, {});
    expect(r.error).not.toHaveProperty('credentialId');
  });
});

// The gateway reads the OData response, so pin the CDS action definition over HTTP.
it('over HTTP: error.credentialId reaches the gateway', async () => {
  await db.run(cds.ql.UPDATE(KEYS).set({ isActive: false }).where({ ID: KEY_ID }));
  const tok = await cdsTest.POST('/odata/v4/validation/createUnifiedValidationToken', {
    authType: 'api_key', identifier: API_KEY, clientIp: '127.0.0.1', method: 'POST', endpoint: '/x'
  });
  const res = await cdsTest.POST('/odata/v4/validation/validateUnifiedAuthByToken', { token: tok.data.token }, { headers: asGateway() });
  expect(res.data.valid).toBe(false);
  expect(res.data.error).toMatchObject({ code: 'API_KEY_NOT_FOUND', credentialId: KEY_ID });
});
