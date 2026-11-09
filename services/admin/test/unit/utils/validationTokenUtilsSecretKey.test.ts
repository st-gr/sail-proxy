/**
 * ValidationTokenUtils.getSecretKey() (private; exercised through createValidationJWT and
 * verifyValidationJWT) used to reject only the literal built-in default, and only in
 * NODE_ENV=production. It now uses the same shared rejected-secret list and the same
 * "outside development" rule as the admin's isGatewayServiceCaller
 * (services/admin/src/utils/gatewayServiceJwt.ts): unset, the default, and the .env.sample
 * placeholder are all rejected outside NODE_ENV=development.
 *
 * Note: no production code calls ValidationTokenUtils.createValidationJWT/verifyValidationJWT
 * (the unwired enhanced-validation-service.ts was removed); the admin tests use
 * createValidationJWT as the reference token producer, so this test covers the lib directly.
 *
 * @see ../../../../../libs/aws-token-validation/validation-token.ts
 */
import { ValidationTokenUtils, ValidationToken } from '@libs/aws-token-validation/validation-token';

function buildToken(): ValidationToken {
  return ValidationTokenUtils.createValidationToken('AKIDEXAMPLE', 'test-signature', {
    timestamp: Date.now(),
    clientIp: '127.0.0.1',
    endpoint: '/test',
    method: 'GET',
    headers: {}
  });
}

describe('ValidationTokenUtils secret key gate', () => {
  const originalSecret = process.env.VALIDATION_TOKEN_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.VALIDATION_TOKEN_SECRET;
    else process.env.VALIDATION_TOKEN_SECRET = originalSecret;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('refuses the .env.sample placeholder outside development', () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = 'generate-a-secure-64-character-hex-string';

    expect(() => ValidationTokenUtils.createValidationJWT(buildToken(), 'req-1')).toThrow(
      'VALIDATION_TOKEN_SECRET'
    );
  });

  it('accepts the placeholder in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.VALIDATION_TOKEN_SECRET = 'generate-a-secure-64-character-hex-string';

    expect(() => ValidationTokenUtils.createValidationJWT(buildToken(), 'req-1')).not.toThrow();
  });

  it('refuses the built-in default outside development, even when NODE_ENV is not "production"', () => {
    process.env.NODE_ENV = 'test';
    process.env.VALIDATION_TOKEN_SECRET = 'dev-secret-change-in-production';

    expect(() => ValidationTokenUtils.createValidationJWT(buildToken(), 'req-1')).toThrow(
      'VALIDATION_TOKEN_SECRET'
    );
  });

  it('refuses an unset secret outside development', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VALIDATION_TOKEN_SECRET;

    expect(() => ValidationTokenUtils.createValidationJWT(buildToken(), 'req-1')).toThrow(
      'VALIDATION_TOKEN_SECRET'
    );
  });

  it('accepts a real generated secret outside development, and verifies a token signed with it', () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = 'f'.repeat(64);

    const jwt = ValidationTokenUtils.createValidationJWT(buildToken(), 'req-1');
    const decoded = ValidationTokenUtils.verifyValidationJWT(jwt);

    expect(decoded.accessKeyId).toBe('AKIDEXAMPLE');
  });
});
