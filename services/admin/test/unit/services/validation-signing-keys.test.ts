/**
 * The admin never hands the gateway an AWS secret. For an AWS credential the gateway's unified
 * validation request names the SigV4 scopes it needs (`signingScopes: [{date, region, service}]`,
 * at most 4) and the admin answers with the day-scoped signing keys for them
 * (`signingKeys: [{date, region, service, key: hex(kSigning)}]`), derived from the stored,
 * encrypted secret the AWS way: kDate = HMAC("AWS4" + secret, date), kRegion, kService,
 * kSigning = HMAC(kService, "aws4_request").
 *
 * Anchors (values this code did not produce), for AWS's documented example secret:
 * - aws-c-auth SigV4 test suite, get-vanilla
 *   (https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4/get-vanilla,
 *   the same vector as the gateway's sigv4Verifier.test.ts): the string to sign for scope
 *   20150830/us-east-1/service signs to 5fa00fa3…3fbf31.
 * - AWS's "derive a signing key" documentation example: kSigning for 20150830/us-east-1/iam is
 *   c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9.
 *
 * @see ../../../src/services/awsSigningKeys.ts
 * @see ../../../src/srv/validation-service.ts validateAwsCredentialByToken
 */
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
const cdsTest = cds.test(path.resolve(__dirname, '../../..'));

import { encryptSecret } from '../../../src/utils/awsSecretCrypto';
import { getDefaultLogger } from '@libs/logger';

const validationService = require('../../../src/srv/validation-service').instance;
const svc: any = validationService;

const AWS = 'sap.llm.gateway.admin.AwsCredentials';
// AWS's documented example credential (aws-c-auth context.json) - not a real credential.
const EXAMPLE_ACCESS_KEY_ID = 'AKIDEXAMPLE';
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

// aws-c-auth get-vanilla: the request's signing time and its string to sign (string-to-sign.txt).
const SIGNED_AT = Date.UTC(2015, 7, 30, 12, 36, 0);
const GET_VANILLA_STRING_TO_SIGN = [
  'AWS4-HMAC-SHA256',
  '20150830T123600Z',
  '20150830/us-east-1/service/aws4_request',
  'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63'
].join('\n');
const GET_VANILLA_SIGNATURE = '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31';
const IAM_K_SIGNING = 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9';

const SERVICE_SCOPE = { date: '20150830', region: 'us-east-1', service: 'service' };
const IAM_SCOPE = { date: '20150830', region: 'us-east-1', service: 'iam' };

// Keys are only issued to the gateway: a Bearer JWT, HS256 under VALIDATION_TOKEN_SECRET, issuer
// gateway-service (what adminServiceClient.createAuthToken sends).
const TEST_TOKEN_SECRET = 'signing-keys-test-validation-token-secret-0123456789';
const gatewayJwt = (secret = TEST_TOKEN_SECRET, issuer = 'gateway-service') =>
  jwt.sign({ sub: 'gateway', service: 'gateway' }, secret, { algorithm: 'HS256', issuer, expiresIn: 300 });
const asGateway = (token = gatewayJwt()) => ({ authorization: `Bearer ${token}` });

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });

const savedEnv = { secret: process.env.VALIDATION_TOKEN_SECRET, nodeEnv: process.env.NODE_ENV };
beforeEach(() => { process.env.VALIDATION_TOKEN_SECRET = TEST_TOKEN_SECRET; });
afterEach(() => {
  if (savedEnv.secret === undefined) delete process.env.VALIDATION_TOKEN_SECRET; else process.env.VALIDATION_TOKEN_SECRET = savedEnv.secret;
  process.env.NODE_ENV = savedEnv.nodeEnv;
});

async function seedCredential(secretAccessKey: string): Promise<void> {
  const { DELETE, INSERT } = cds.ql;
  await db.run(DELETE.from(AWS));
  await db.run(INSERT.into(AWS).entries({
    ID: 'c-sk', accessKeyId: EXAMPLE_ACCESS_KEY_ID, secretAccessKey, secretHash: 'h', salt: 's',
    name: 'signing-key fixture', email: 'robin.fixture@example.com', userId: 'robin.fixture@example.com',
    region: 'us-east-1', isActive: true
  }));
}

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(SIGNED_AT);
  svc.cache.awsCredentials.clear();
  await seedCredential(encryptSecret(EXAMPLE_SECRET));
});

afterEach(() => { jest.restoreAllMocks(); });

async function validate(signingScopes?: unknown, headers: Record<string, string> | undefined = asGateway()): Promise<any> {
  const { token } = await svc.createUnifiedValidationToken({ data: {
    authType: 'aws_credential', identifier: EXAMPLE_ACCESS_KEY_ID, clientIp: '127.0.0.1',
    method: 'POST', endpoint: '/model/x/invoke', signature: 'sig', signingScopes
  } });
  return svc.validateUnifiedAuthByToken({ data: { token }, headers });
}

const keyFor = (r: any, scope: { date: string; region: string; service: string }) =>
  r.data.signingKeys.find((k: any) => k.date === scope.date && k.region === scope.region && k.service === scope.service)?.key;

const sign = (hexKey: string, stringToSign: string) =>
  crypto.createHmac('sha256', Buffer.from(hexKey, 'hex')).update(stringToSign).digest('hex');

describe('validateUnifiedAuthByToken returns day-scoped signing keys, never the secret', () => {
  it("keys follow AWS's derivation: the service key signs get-vanilla to AWS's signature, the iam key is AWS's documented kSigning", async () => {
    const r = await validate([SERVICE_SCOPE, IAM_SCOPE]);
    expect(r.valid).toBe(true);
    expect(r.data.signingKeys).toHaveLength(2);
    expect(sign(keyFor(r, SERVICE_SCOPE), GET_VANILLA_STRING_TO_SIGN)).toBe(GET_VANILLA_SIGNATURE);
    expect(keyFor(r, IAM_SCOPE)).toBe(IAM_K_SIGNING);
  });

  it('never returns the secret or a secretAccessKey field', async () => {
    const r = await validate([SERVICE_SCOPE]);
    expect(r.data).not.toHaveProperty('secretAccessKey');
    expect(JSON.stringify(r)).not.toContain(EXAMPLE_SECRET);
  });

  it('decrypts a secret stored in the legacy (pre-iv) format too', async () => {
    // Node 20's crypto.createCipher('aes-256-cbc', <the fallback key>) of EXAMPLE_SECRET; Node 22 removed createCipher.
    const originalKey = process.env.AWS_SECRET_ENCRYPTION_KEY;
    process.env.AWS_SECRET_ENCRYPTION_KEY = 'default-dev-key-not-for-production-use-12345';
    try {
      await seedCredential('953eab8d6b3c93b63d3a85d05487f91bdcd7c0f1a7a8d5cab20e3a02f7e4916a3275ace3f30b3c50b1487931dca24d75');
      const r = await validate([SERVICE_SCOPE]);
      expect(sign(keyFor(r, SERVICE_SCOPE), GET_VANILLA_STRING_TO_SIGN)).toBe(GET_VANILLA_SIGNATURE);
    } finally {
      if (originalKey === undefined) delete process.env.AWS_SECRET_ENCRYPTION_KEY;
      else process.env.AWS_SECRET_ENCRYPTION_KEY = originalKey;
    }
  });

  it('without signingScopes: a valid result and no signingKeys', async () => {
    const r = await validate();
    expect(r.valid).toBe(true);
    expect(r.data).not.toHaveProperty('signingKeys');
  });

  it('a stored secret that cannot be decrypted fails the validation instead of returning no key', async () => {
    await seedCredential('00112233445566778899aabbccddeeff:0011');
    const r = await validate([SERVICE_SCOPE]);
    expect(r.valid).toBe(false);
    expect(r.error.code).toBe('SIGNING_KEY_UNAVAILABLE');
    expect(r.data).not.toHaveProperty('signingKeys');
  });

  describe('scope checks', () => {
    // Only the UTC day(s) that now +/- 15 minutes (the gateway's x-amz-date skew) falls on.
    it('at midday only today is accepted: yesterday and tomorrow are rejected', async () => {
      expect((await validate([SERVICE_SCOPE])).valid).toBe(true);
      expect((await validate([{ ...SERVICE_SCOPE, date: '20150829' }])).error.code).toBe('INVALID_SIGNING_SCOPE');
      expect((await validate([{ ...SERVICE_SCOPE, date: '20150831' }])).error.code).toBe('INVALID_SIGNING_SCOPE');
    });

    it('within 15 minutes of midnight the neighbouring day is accepted too, the other one is not', async () => {
      (Date.now as jest.Mock).mockReturnValue(Date.UTC(2015, 7, 30, 23, 50, 0));
      const late = await validate([SERVICE_SCOPE, { ...SERVICE_SCOPE, date: '20150831' }]);
      expect(late.valid).toBe(true);
      expect(late.data.signingKeys).toHaveLength(2);
      expect((await validate([{ ...SERVICE_SCOPE, date: '20150829' }])).error.code).toBe('INVALID_SIGNING_SCOPE');

      (Date.now as jest.Mock).mockReturnValue(Date.UTC(2015, 7, 30, 0, 10, 0));
      expect((await validate([{ ...SERVICE_SCOPE, date: '20150829' }])).valid).toBe(true);
      expect((await validate([{ ...SERVICE_SCOPE, date: '20150831' }])).error.code).toBe('INVALID_SIGNING_SCOPE');
    });

    it.each([
      ['a date two days old', [{ ...SERVICE_SCOPE, date: '20150828' }]],
      ['a date two days ahead', [{ ...SERVICE_SCOPE, date: '20150901' }]],
      ['a malformed date', [{ ...SERVICE_SCOPE, date: '2015-08-30' }]],
      ['an impossible calendar date', [{ ...SERVICE_SCOPE, date: '20150832' }]],
      ['an upper-case region', [{ ...SERVICE_SCOPE, region: 'US-EAST-1' }]],
      ['a service outside the pattern', [{ ...SERVICE_SCOPE, service: 'bedrock/runtime' }]],
      ['a region longer than 32 characters', [{ ...SERVICE_SCOPE, region: 'a'.repeat(33) }]],
      ['more than 4 scopes', Array(5).fill(SERVICE_SCOPE)],
      ['a non-array', 'bedrock'],
    ])('rejects %s, with no keys', async (_label, scopes) => {
      const r = await validate(scopes);
      expect(r.valid).toBe(false);
      expect(r.error.code).toBe('INVALID_SIGNING_SCOPE');
      expect(r.data).not.toHaveProperty('signingKeys');
    });
  });

  describe('the admin validation cache holds neither the secret nor keys', () => {
    it('the cached entry has no secret, no signingKeys and no key material; a cache hit derives keys afresh', async () => {
      const first = await validate([SERVICE_SCOPE, IAM_SCOPE]);
      const entries = JSON.stringify([...svc.cache.awsCredentials.values()]);
      expect(entries).not.toContain('signingKeys');
      expect(entries).not.toContain('secretAccessKey');
      expect(entries).not.toContain(EXAMPLE_SECRET);
      for (const k of first.data.signingKeys) expect(entries).not.toContain(k.key);

      const hit = await validate([SERVICE_SCOPE]);
      expect(hit.auditInfo.cacheHit).toBe(true);
      expect(sign(keyFor(hit, SERVICE_SCOPE), GET_VANILLA_STRING_TO_SIGN)).toBe(GET_VANILLA_SIGNATURE);
      expect(JSON.stringify([...svc.cache.awsCredentials.values()])).not.toContain('signingKeys');
    });

    it('a cache hit for a credential expired since returns no keys', async () => {
      await validate([SERVICE_SCOPE]);
      await db.run(cds.ql.UPDATE(AWS).set({ expiresAt: '2001-01-01T00:00:00Z', neverExpires: false }).where({ ID: 'c-sk' }));
      const hit = await validate([SERVICE_SCOPE]);
      expect(hit.valid).toBe(false);
      expect(hit.error.code).toBe('AWS_CREDENTIAL_EXPIRED');
      expect(hit.data).not.toHaveProperty('signingKeys');
    });

    it('a cache hit for a credential deactivated since returns no keys', async () => {
      await validate([SERVICE_SCOPE]);
      await db.run(cds.ql.UPDATE(AWS).set({ isActive: false }).where({ ID: 'c-sk' }));
      const hit = await validate([SERVICE_SCOPE]);
      expect(hit.valid).toBe(false);
      expect(hit.data).not.toHaveProperty('signingKeys');
    });
  });

  it('logs neither the secret nor a key', async () => {
    const logger: any = getDefaultLogger();
    const spies = ['trace', 'debug', 'info', 'warn', 'error'].map(m => jest.spyOn(logger, m));
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map(m => jest.spyOn(console as any, m).mockImplementation(() => {}));
    const r = await validate([SERVICE_SCOPE, IAM_SCOPE]);
    await validate([SERVICE_SCOPE]); // cache hit
    await seedCredential('00112233445566778899aabbccddeeff:0011'); // undecryptable
    svc.cache.awsCredentials.clear();
    await validate([SERVICE_SCOPE]);

    const calls = [...spies, ...consoleSpies].flatMap(s => s.mock.calls);
    expect(calls.length).toBeGreaterThan(0); // the spies see the validation path's logging
    const logged = JSON.stringify(calls, (_k, v) => (v instanceof Error ? v.message + v.stack : v));
    expect(logged).toContain('No signing key for AWS credential'); // the undecryptable case was logged
    expect(logged).not.toContain(EXAMPLE_SECRET);
    for (const k of r.data.signingKeys) expect(logged).not.toContain(k.key);
  });

  // The gateway reads the OData response, so pin the CDS action definitions over HTTP.
  it('over HTTP: createUnifiedValidationToken accepts signingScopes, validateUnifiedAuthByToken returns signingKeys', async () => {
    const tok = await cdsTest.POST('/odata/v4/validation/createUnifiedValidationToken', {
      authType: 'aws_credential', identifier: EXAMPLE_ACCESS_KEY_ID, clientIp: '127.0.0.1', userAgent: 'jest',
      method: 'POST', endpoint: '/model/x/invoke', signature: 'sig', signingScopes: [SERVICE_SCOPE]
    });
    const res = await cdsTest.POST('/odata/v4/validation/validateUnifiedAuthByToken', { token: tok.data.token }, { headers: asGateway() });
    expect(res.data.valid).toBe(true);
    expect(res.data.data).not.toHaveProperty('secretAccessKey');
    expect(res.data.data.signingKeys).toEqual([{ ...SERVICE_SCOPE, key: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(sign(res.data.data.signingKeys[0].key, GET_VANILLA_STRING_TO_SIGN)).toBe(GET_VANILLA_SIGNATURE);
  });
});

describe('signing keys go to the gateway only', () => {
  const expectNoKeys = (r: any) => {
    expect(r.valid).toBe(true); // the rest of the validation is unchanged
    expect(r.data).not.toHaveProperty('signingKeys');
  };

  it('no Authorization header: no keys', async () => {
    expectNoKeys(await validate([SERVICE_SCOPE], {}));
  });

  it('a Bearer JWT signed with another secret: no keys', async () => {
    expectNoKeys(await validate([SERVICE_SCOPE], asGateway(gatewayJwt('some-other-secret-of-sufficient-length-0123'))));
  });

  it('a Bearer JWT with another issuer: no keys', async () => {
    expectNoKeys(await validate([SERVICE_SCOPE], asGateway(gatewayJwt(TEST_TOKEN_SECRET, 'someone-else'))));
  });

  it('a valid gateway JWT: keys', async () => {
    expect((await validate([SERVICE_SCOPE], asGateway())).data.signingKeys).toHaveLength(1);
  });

  it('over HTTP: forged oauth2-proxy headers (X-Auth-Request-Groups: gateway) without a token get no keys', async () => {
    const tok = await cdsTest.POST('/odata/v4/validation/createUnifiedValidationToken', {
      authType: 'aws_credential', identifier: EXAMPLE_ACCESS_KEY_ID, clientIp: '127.0.0.1',
      method: 'POST', endpoint: '/model/x/invoke', signature: 'sig', signingScopes: [SERVICE_SCOPE]
    });
    const res = await cdsTest.POST('/odata/v4/validation/validateUnifiedAuthByToken', { token: tok.data.token }, {
      headers: { 'x-auth-request-groups': 'gateway', 'x-auth-request-email': 'mallory.fixture@example.com', 'x-auth-request-user': 'gateway' }
    });
    expect(res.data.valid).toBe(true);
    expect(res.data.data).not.toHaveProperty('signingKeys');
  });

  it('outside development, the default VALIDATION_TOKEN_SECRET issues no keys, and says so once', async () => {
    const logger: any = getDefaultLogger();
    const errors = jest.spyOn(logger, 'error');
    process.env.VALIDATION_TOKEN_SECRET = 'dev-secret-change-in-production';
    expectNoKeys(await validate([SERVICE_SCOPE], asGateway(gatewayJwt('dev-secret-change-in-production'))));
    expectNoKeys(await validate([SERVICE_SCOPE], asGateway(gatewayJwt('dev-secret-change-in-production'))));
    const refusals = errors.mock.calls.filter(c => String(c[1]).includes('VALIDATION_TOKEN_SECRET'));
    expect(refusals.length).toBeLessThanOrEqual(1); // once per process (an earlier test may have logged it)
  });

  it('outside development, an unset VALIDATION_TOKEN_SECRET issues no keys', async () => {
    delete process.env.VALIDATION_TOKEN_SECRET;
    expectNoKeys(await validate([SERVICE_SCOPE], asGateway(gatewayJwt('dev-secret-change-in-production'))));
  });

  it('in development, the default secret still works (local dev without a configured secret)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.VALIDATION_TOKEN_SECRET;
    expect((await validate([SERVICE_SCOPE], asGateway(gatewayJwt('dev-secret-change-in-production')))).data.signingKeys).toHaveLength(1);
  });
});

describe('the legacy validateAwsCredentials action', () => {
  it('never returns a secret (it used to return secretHash as secretKey)', async () => {
    const signature = crypto.createHmac('sha256', 'h').update('x').digest('hex'); // HMAC under the stored secretHash
    const r = await svc.validateAwsCredentials({ data: { accessKeyId: EXAMPLE_ACCESS_KEY_ID, signature, stringToSign: 'x', clientIp: '127.0.0.1' } });
    expect(r).not.toHaveProperty('secretKey');
    expect(JSON.stringify(r)).not.toContain('"h"');
    expect(r.valid).toBe(false); // it cannot check a signature without the secret, so it fails closed
    expect(JSON.stringify([...svc.cache.awsCredentials.values()])).not.toContain('secretKey');
  });
});

describe('the legacy validateAwsCredentialsByToken action', () => {
  it('does not claim a signature check it never made', async () => {
    const { token } = await svc.createValidationToken({ data: { accessKeyId: EXAMPLE_ACCESS_KEY_ID, signature: 'sig', clientIp: '127.0.0.1', method: 'POST', endpoint: '/v1/messages' } });
    const r = await svc.validateAwsCredentialsByToken({ data: { token, stringToSign: 'x', signature: 'sig' } });
    expect(r.valid).toBe(true);
    expect(r.auditInfo.signatureValid).not.toBe(true);
  });
});
