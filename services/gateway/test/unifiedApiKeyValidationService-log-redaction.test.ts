/**
 * unifiedApiKeyValidationService must never write a raw API key or a
 * "first 10 chars" prefix of one to the logger. `validateApiKey()` logs a
 * trace line unconditionally before any branching, so that's the site this
 * test drives directly.
 *
 * @see ../src/services/unifiedApiKeyValidationService.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// unifiedApiKeyValidationService -> unifiedValidationCache -> libs/aws-token-validation
// constructs a SecureMetadataExchange singleton at *import* time, which throws
// unless a >=32-char key is already in the environment. test/setupTests.ts
// normally supplies VALIDATION_TOKEN_SECRET, but that runs as a Jest `beforeAll`
// hook, which fires only after this file's own top-level imports have already
// been evaluated — too late. Set it here first.
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

jest.mock('../src/services/apiKeyService', () => ({
  __esModule: true,
  default: { validateApiKey: (jest.fn() as any).mockResolvedValue(null) },
}));

// require(), not import: a static import is hoisted above the process.env
// assignment above, defeating the point of setting it first.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { unifiedApiKeyValidationService } = require('../src/services/unifiedApiKeyValidationService');

const FAKE_KEY = 'sk-test-FAKE-UNIFIED-VALIDATION-KEY-abcdef1234567890';

function loggedValues(): any[] {
  return [
    ...loggerCalls.trace.mock.calls,
    ...loggerCalls.debug.mock.calls,
    ...loggerCalls.error.mock.calls,
    ...loggerCalls.warn.mock.calls,
    ...loggerCalls.info.mock.calls,
  ].flat();
}

function loggedStrings(): string[] {
  return loggedValues().flatMap((v) => (typeof v === 'string' ? [v] : typeof v === 'object' && v ? [JSON.stringify(v)] : []));
}

describe('unifiedApiKeyValidationService never logs the raw or partial API key', () => {
  beforeEach(() => {
    loggerCalls.trace.mockClear();
    loggerCalls.debug.mockClear();
    loggerCalls.error.mockClear();
    loggerCalls.warn.mockClear();
    loggerCalls.info.mockClear();
  });

  it('never leaks the key (whole or any 8+ char substring) while validating', async () => {
    await unifiedApiKeyValidationService.validateApiKey({
      apiKey: FAKE_KEY,
      clientIp: '127.0.0.1',
      method: 'POST',
      endpoint: '/v1/chat/completions',
    });

    const strings = loggedStrings();
    for (let start = 0; start + 8 <= FAKE_KEY.length; start++) {
      const chunk = FAKE_KEY.slice(start, start + 8);
      expect(strings.some((s) => s.includes(chunk))).toBe(false);
    }
    expect(strings.some((s) => /keyLabel["\s:]*[0-9a-f]{8}/.test(s))).toBe(true);
  });
});
