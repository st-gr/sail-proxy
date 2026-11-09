/**
 * adminServiceClient.createAuthToken falls back to a publicly known VALIDATION_TOKEN_SECRET.
 * The admin already refuses a service JWT signed with it outside development (see
 * services/admin/src/utils/gatewayServiceJwt.ts), so this only needs one clear startup log —
 * it must never throw, since API-key traffic does not depend on this token.
 *
 * @see ../../src/clients/adminServiceClient.ts
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { REJECTED_VALIDATION_TOKEN_SECRETS } from '../../../../libs/aws-token-validation/validation-token-secrets';

const loggerCalls = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => loggerCalls.error(...args),
    warn: (...args: any[]) => loggerCalls.warn(...args),
    info: (...args: any[]) => loggerCalls.info(...args),
    debug: (...args: any[]) => loggerCalls.debug(...args),
    trace: (...args: any[]) => loggerCalls.trace(...args),
  }),
}));

const ORIGINAL_ENV = { ...process.env };

describe('AdminServiceClient weak VALIDATION_TOKEN_SECRET startup check', () => {
  beforeEach(() => {
    jest.resetModules();
    loggerCalls.error.mockClear();
    process.env = { ...ORIGINAL_ENV };
    process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
    process.env.VALKEY_URL = 'redis://localhost:6379';
    process.env.ADMIN_SERVICE_URL = 'http://localhost:4004';
    process.env.UNIFIED_AUTH_HEALTH_CHECK_INTERVAL_MS = '0';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // Every entry the admin's isGatewayServiceCaller rejects (services/admin/src/utils/gatewayServiceJwt.ts),
  // imported from the same shared lib — proof the gateway warns for the admin's whole rejected list,
  // not just two hardcoded literals that happen to match today.
  it.each(REJECTED_VALIDATION_TOKEN_SECRETS)('logs one error at startup when the secret is %j outside development', async (rejected) => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = rejected;

    const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
    expect(() => new AdminServiceClient()).not.toThrow();

    expect(loggerCalls.error).toHaveBeenCalledTimes(1);
    expect(loggerCalls.error.mock.calls[0][0]).toBe('AdminServiceClient');
  });

  it('imports the same rejected-secret list the admin uses (libs/aws-token-validation/validation-token-secrets)', () => {
    expect(REJECTED_VALIDATION_TOKEN_SECRETS).toEqual(['dev-secret-change-in-production', 'generate-a-secure-64-character-hex-string']);
  });

  it('logs when the secret is unset outside development', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VALIDATION_TOKEN_SECRET;

    const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
    new AdminServiceClient();

    expect(loggerCalls.error).toHaveBeenCalledTimes(1);
  });

  it('does not log when a real generated secret is set outside development', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VALIDATION_TOKEN_SECRET = 'f'.repeat(64);

    const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
    new AdminServiceClient();

    expect(loggerCalls.error).not.toHaveBeenCalled();
  });

  it('does not log in development even with the default secret', async () => {
    process.env.NODE_ENV = 'development';
    process.env.VALIDATION_TOKEN_SECRET = 'dev-secret-change-in-production';

    const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
    new AdminServiceClient();

    expect(loggerCalls.error).not.toHaveBeenCalled();
  });
});
