/**
 * ValidationService.processUsageEvents is not protected by CAP auth: it accepts the gateway's
 * service JWT (adminServiceClient.createAuthToken: HS256 under VALIDATION_TOKEN_SECRET, issuer
 * gateway-service) and nothing else. Outside NODE_ENV=development a token signed with a publicly
 * known secret — the built-in default or the .env.sample placeholder — must not be accepted:
 * anyone could mint it and write usage rows. The same gate covers the JWT branch of
 * validateAwsCredentialsByToken (decodeSecureToken), which verifies with the same secret.
 *
 * @see ../../../src/utils/gatewayServiceJwt.ts
 * @see ../../../src/srv/validation-service.ts processUsageEvents, verifyJwtToken
 */
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import {
  DEFAULT_VALIDATION_TOKEN_SECRET,
  PLACEHOLDER_VALIDATION_TOKEN_SECRET
} from '@libs/aws-token-validation/validation-token-secrets';
import { ValidationTokenUtils } from '@libs/aws-token-validation/validation-token';

const svc: any = require('../../../src/srv/validation-service').instance;

const REAL_SECRET = 'usage-events-test-validation-token-secret-0123456789';

/** What adminServiceClient.createAuthToken sends. */
const gatewayJwt = (secret: string) =>
  jwt.sign({ sub: 'gateway', service: 'gateway', roles: ['admin', 'user', 'gateway'] }, secret, {
    algorithm: 'HS256', issuer: 'gateway-service', expiresIn: 300
  });

const postUsage = (secret: string) =>
  svc.processUsageEvents({ headers: { authorization: `Bearer ${gatewayJwt(secret)}` }, data: { events: [] } });

/** A validation JWT in the shape ValidationTokenUtils.createValidationJWT signs (no issuer, exp set). */
function validationJwt(secret: string, claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    accessKeyId: 'AKIDEXAMPLE', expiresAt: Date.now() + 60000, exp: Math.floor(Date.now() / 1000) + 60, ...claims
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const savedEnv = { secret: process.env.VALIDATION_TOKEN_SECRET, nodeEnv: process.env.NODE_ENV };
afterEach(() => {
  if (savedEnv.secret === undefined) delete process.env.VALIDATION_TOKEN_SECRET; else process.env.VALIDATION_TOKEN_SECRET = savedEnv.secret;
  process.env.NODE_ENV = savedEnv.nodeEnv;
});

describe('processUsageEvents refuses a gateway JWT signed with a publicly known secret outside development', () => {
  it.each([
    ['the .env.sample placeholder', PLACEHOLDER_VALIDATION_TOKEN_SECRET],
    ['the built-in default', DEFAULT_VALIDATION_TOKEN_SECRET]
  ])('production + %s: rejected', async (_name, secret) => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = secret;
    await expect(postUsage(secret)).rejects.toThrow(/VALIDATION_TOKEN_SECRET/);
  });

  it('production + unset secret: a default-signed token is rejected', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VALIDATION_TOKEN_SECRET;
    await expect(postUsage(DEFAULT_VALIDATION_TOKEN_SECRET)).rejects.toThrow(/VALIDATION_TOKEN_SECRET/);
  });

  it('development + the placeholder: accepted', async () => {
    process.env.NODE_ENV = 'development';
    process.env.VALIDATION_TOKEN_SECRET = PLACEHOLDER_VALIDATION_TOKEN_SECRET;
    await expect(postUsage(PLACEHOLDER_VALIDATION_TOKEN_SECRET)).resolves.toEqual({ processed: 0, status: 'success' });
  });

  it('production + a real generated secret: accepted', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = REAL_SECRET;
    await expect(postUsage(REAL_SECRET)).resolves.toEqual({ processed: 0, status: 'success' });
  });

  it('production + a real secret: a token signed with another secret is still rejected', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = REAL_SECRET;
    await expect(postUsage(PLACEHOLDER_VALIDATION_TOKEN_SECRET)).rejects.toThrow();
  });
});

describe('verifyJwtToken (validateAwsCredentialsByToken JWT branch) applies the same secret gate', () => {
  it('production + the placeholder: a placeholder-signed validation JWT is refused', () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = PLACEHOLDER_VALIDATION_TOKEN_SECRET;
    expect(() => svc.verifyJwtToken(validationJwt(PLACEHOLDER_VALIDATION_TOKEN_SECRET))).toThrow(/VALIDATION_TOKEN_SECRET/);
  });

  it('development + the placeholder: still verified', () => {
    process.env.NODE_ENV = 'development';
    process.env.VALIDATION_TOKEN_SECRET = PLACEHOLDER_VALIDATION_TOKEN_SECRET;
    expect(svc.verifyJwtToken(validationJwt(PLACEHOLDER_VALIDATION_TOKEN_SECRET))).toMatchObject({ accessKeyId: 'AKIDEXAMPLE' });
  });

  it('production + a real secret: verified', () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = REAL_SECRET;
    expect(svc.verifyJwtToken(validationJwt(REAL_SECRET))).toMatchObject({ accessKeyId: 'AKIDEXAMPLE' });
  });
});

describe('verifyJwtToken checks expiry and compares the signature in constant time', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = REAL_SECRET;
  });

  it('an expired token is rejected', () => {
    const expired = validationJwt(REAL_SECRET, { exp: Math.floor(Date.now() / 1000) - 10 });
    expect(() => svc.verifyJwtToken(expired)).toThrow(/expired/);
  });

  it('a token without exp is rejected (its producer, ValidationTokenUtils.createValidationJWT, always sets it)', () => {
    expect(() => svc.verifyJwtToken(validationJwt(REAL_SECRET, { exp: undefined }))).toThrow(/exp/);
  });

  it('a tampered signature (same length) is rejected', () => {
    const token = validationJwt(REAL_SECRET);
    const sig = token.split('.')[2];
    const tampered = `${token.slice(0, -sig.length)}${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    expect(() => svc.verifyJwtToken(tampered)).toThrow(/Invalid JWT signature/);
  });

  it('the signature is compared with crypto.timingSafeEqual', () => {
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    svc.verifyJwtToken(validationJwt(REAL_SECRET));
    expect(compare).toHaveBeenCalled();
  });

  it('a signature of a different length is rejected, not thrown on by the comparison', () => {
    expect(() => svc.verifyJwtToken(`${validationJwt(REAL_SECRET)}xx`)).toThrow(/Invalid JWT signature/);
  });

  it('a token from the real producer (ValidationTokenUtils.createValidationJWT) verifies', () => {
    const vt = ValidationTokenUtils.createValidationToken('AKIDEXAMPLE', 'sig', {
      timestamp: Date.now(), clientIp: '127.0.0.1', endpoint: '/x', method: 'POST', headers: {}
    });
    const token = ValidationTokenUtils.createValidationJWT(vt, 'req-1');
    expect(svc.verifyJwtToken(token)).toMatchObject({ accessKeyId: 'AKIDEXAMPLE', requestId: 'req-1' });
  });
});
