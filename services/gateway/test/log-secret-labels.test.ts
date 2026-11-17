/**
 * A key or token is never written to the log, not even its first characters (a prefix is still
 * key material) and not at TRACE or DEBUG: the admin service client and the cross-validation of the
 * unified validation cache log a non-reversible label (secretLabel) instead.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// unifiedValidationCache -> libs/aws-token-validation needs a >=32-char secret at import time.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

const loggerCalls = { trace: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() };
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => loggerCalls.error(...args),
    warn: (...args: any[]) => loggerCalls.warn(...args),
    info: (...args: any[]) => loggerCalls.info(...args),
    debug: (...args: any[]) => loggerCalls.debug(...args),
    trace: (...args: any[]) => loggerCalls.trace(...args),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AdminServiceClient } = require('../src/clients/adminServiceClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UnifiedValidationCache } = require('../src/services/unifiedValidationCache');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { secretLabel } = require('../src/utils/secretLabel');

// Invented: shaped like a gateway key, but not one.
const FAKE_KEY = 'sail-FAKE-KEY-for-log-tests-0123456789abcdef';
const FAKE_TOKEN = 'eyFAKE.unified-validation-token-for-log-tests.0123456789';

const logged = (): string => JSON.stringify(Object.values(loggerCalls).flatMap((m) => m.mock.calls));

describe('keys and tokens reach the log only as a label', () => {
  beforeEach(() => { Object.values(loggerCalls).forEach((m) => m.mockClear()); });

  it('the admin service client: creating and validating a unified token', async () => {
    const client = new AdminServiceClient();
    (client as any).makeRequest = jest.fn(async () => ({ token: FAKE_TOKEN, expiresAt: Date.now() + 60_000, requestId: 'r1', valid: true, authType: 'api_key', data: {}, auditInfo: { cacheHit: false, requestId: 'r1' } }));
    await client.createUnifiedValidationToken({ authType: 'api_key', identifier: FAKE_KEY, clientIp: '127.0.0.1', method: 'POST', endpoint: '/v1/chat/completions' });
    await client.validateUnifiedAuthByToken({ token: FAKE_TOKEN });
    expect(loggerCalls.trace).toHaveBeenCalled();
    const text = logged();
    expect(text).not.toContain(FAKE_KEY.slice(0, 10));
    expect(text).not.toContain(FAKE_TOKEN.slice(0, 10));
    expect(text).toContain(secretLabel(FAKE_KEY));
    expect(text).toContain(secretLabel(FAKE_TOKEN));
  });

  it('the unified validation cache: cross-validation', async () => {
    const cache = new UnifiedValidationCache({ enableCrossValidation: true, enableDistributed: false });
    try {
      await cache.crossValidate(FAKE_KEY, 'api_key', { valid: true, authType: 'api_key', data: {} }, { valid: true });
      expect(loggerCalls.debug).toHaveBeenCalledWith('UnifiedValidationCache', 'Cross-validation completed', expect.anything());
      const text = logged();
      expect(text).not.toContain(FAKE_KEY.slice(0, 10));
      expect(text).toContain(secretLabel(FAKE_KEY));
    } finally {
      await cache.destroy();
    }
  });
});
