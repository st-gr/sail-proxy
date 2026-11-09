/**
 * VALIDATION_TOKEN_SECRET gates AWS signing-key requests (isGatewayServiceCaller). Outside
 * NODE_ENV=development it must refuse not only the built-in default but also the placeholder
 * both .env.sample files carry for VALIDATION_TOKEN_SECRET — an unedited copy would otherwise
 * work with a publicly known secret.
 *
 * @see ../../../src/utils/gatewayServiceJwt.ts
 */
import jwt from 'jsonwebtoken';
import {
  isGatewayServiceCaller,
  verifyGatewayServiceJwt,
  DEFAULT_VALIDATION_TOKEN_SECRET,
  PLACEHOLDER_VALIDATION_TOKEN_SECRET,
  REJECTED_VALIDATION_TOKEN_SECRETS
} from '../../../src/utils/gatewayServiceJwt';
import {
  REJECTED_VALIDATION_TOKEN_SECRETS as SHARED_REJECTED_VALIDATION_TOKEN_SECRETS,
  isPubliclyKnownValidationTokenSecret
} from '@libs/aws-token-validation/validation-token-secrets';

function signWith(secret: string): string {
  return jwt.sign({ service: 'gateway' }, secret, {
    algorithm: 'HS256',
    issuer: 'gateway-service',
    expiresIn: '5m'
  });
}

describe('isGatewayServiceCaller secret gate', () => {
  const originalSecret = process.env.VALIDATION_TOKEN_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.VALIDATION_TOKEN_SECRET;
    else process.env.VALIDATION_TOKEN_SECRET = originalSecret;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('refuses the .env.sample placeholder outside development', () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = PLACEHOLDER_VALIDATION_TOKEN_SECRET;
    const token = signWith(PLACEHOLDER_VALIDATION_TOKEN_SECRET);

    expect(isGatewayServiceCaller(`Bearer ${token}`)).toBe(false);
  });

  it('refuses the built-in default outside development', () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = DEFAULT_VALIDATION_TOKEN_SECRET;
    const token = signWith(DEFAULT_VALIDATION_TOKEN_SECRET);

    expect(isGatewayServiceCaller(`Bearer ${token}`)).toBe(false);
  });

  it('accepts the placeholder in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.VALIDATION_TOKEN_SECRET = PLACEHOLDER_VALIDATION_TOKEN_SECRET;
    const token = signWith(PLACEHOLDER_VALIDATION_TOKEN_SECRET);

    expect(isGatewayServiceCaller(`Bearer ${token}`)).toBe(true);
  });

  it('accepts a real generated secret outside development', () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = 'f'.repeat(64);
    const token = signWith('f'.repeat(64));

    expect(isGatewayServiceCaller(`Bearer ${token}`)).toBe(true);
  });

  it('uses the same rejected-secret list the gateway imports (libs/aws-token-validation/validation-token-secrets)', () => {
    expect(REJECTED_VALIDATION_TOKEN_SECRETS).toBe(SHARED_REJECTED_VALIDATION_TOKEN_SECRETS);
  });
});

describe('verifyGatewayServiceJwt secret gate (authMiddleware and processUsageEvents verify through it)', () => {
  const originalSecret = process.env.VALIDATION_TOKEN_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.VALIDATION_TOKEN_SECRET;
    else process.env.VALIDATION_TOKEN_SECRET = originalSecret;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it.each(REJECTED_VALIDATION_TOKEN_SECRETS.map(s => [s]))('refuses a token signed with %s outside development', (secret) => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = secret;
    expect(() => verifyGatewayServiceJwt(signWith(secret))).toThrow(/VALIDATION_TOKEN_SECRET/);
  });

  it('refuses a default-signed token outside development when the secret is unset', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VALIDATION_TOKEN_SECRET;
    expect(() => verifyGatewayServiceJwt(signWith(DEFAULT_VALIDATION_TOKEN_SECRET))).toThrow(/VALIDATION_TOKEN_SECRET/);
  });

  it('accepts the placeholder in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.VALIDATION_TOKEN_SECRET = PLACEHOLDER_VALIDATION_TOKEN_SECRET;
    expect(verifyGatewayServiceJwt(signWith(PLACEHOLDER_VALIDATION_TOKEN_SECRET))).toMatchObject({ service: 'gateway' });
  });

  it('accepts a real generated secret outside development', () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = 'f'.repeat(64);
    expect(verifyGatewayServiceJwt(signWith('f'.repeat(64)))).toMatchObject({ service: 'gateway' });
  });
});

describe('isPubliclyKnownValidationTokenSecret', () => {
  it('is true for unset, empty, the default and the placeholder; false for a generated secret', () => {
    expect(isPubliclyKnownValidationTokenSecret(undefined)).toBe(true);
    expect(isPubliclyKnownValidationTokenSecret('')).toBe(true);
    expect(isPubliclyKnownValidationTokenSecret(DEFAULT_VALIDATION_TOKEN_SECRET)).toBe(true);
    expect(isPubliclyKnownValidationTokenSecret(PLACEHOLDER_VALIDATION_TOKEN_SECRET)).toBe(true);
    expect(isPubliclyKnownValidationTokenSecret('f'.repeat(64))).toBe(false);
  });
});
